// Google Wallet: "Save to Google Wallet" links (signed JWT) and object updates
// with card messages. Activates when these exist (see docs/WALLET-SETUP.md):
//   DATA_DIR/wallet/google-service-account.json
//   env GOOGLE_WALLET_ISSUER_ID
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('../db');
const SA_DIR = path.join(DATA_DIR, 'wallet');

const { db } = require('../db');

const SA_FILE = path.join(DATA_DIR, 'wallet', 'google-service-account.json');
const API = 'https://walletobjects.googleapis.com/walletobjects/v1';
const CLASS_SUFFIX = 'aldia_loyalty';

const issuerId = () => process.env.GOOGLE_WALLET_ISSUER_ID ||
  (db.prepare('SELECT google_issuer_id FROM loyalty_config WHERE id = 1').get() || {}).google_issuer_id || null;
const googleReady = () => !!(issuerId() && fs.existsSync(SA_FILE));
const sa = () => JSON.parse(fs.readFileSync(SA_FILE, 'utf8'));
const classId = () => `${issuerId()}.${CLASS_SUFFIX}`;
const objectId = code => `${issuerId()}.${CLASS_SUFFIX}_${code}`;

const b64url = buf => Buffer.from(buf).toString('base64url');
function signJwt(payload, account) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), account.private_key);
  return `${header}.${body}.${b64url(sig)}`;
}

async function accessToken() {
  const account = sa();
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt({
    iss: account.client_email, scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }, account);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${assertion}`
  });
  if (!res.ok) throw new Error(`Google token: ${res.status}`);
  return (await res.json()).access_token;
}

async function gapi(method, pathName, body, token) {
  const res = await fetch(`${API}${pathName}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return res;
}

const BASE = () => process.env.BASE_URL || 'https://al-dia-production.up.railway.app';

function loyaltyObject(customer, state) {
  const owed = (state.pending || []);
  const hint = owed.length
    ? `🎁 ya ganaste tu ${owed.map(p => p.name).join(' y ')}`
    : state.nextReward
      ? `faltan ${state.toNext} para tu ${state.nextReward.name}`
      : 'tarjeta completa';
  // Same pre-rendered grid Apple uses, at Google's 3:1 ratio. The ?v= is the
  // stamp count: Google caches hero images hard, so a changing URL is the only
  // reliable way to make the card actually redraw after a visit.
  const hero = `${BASE()}/card/hero-${Math.max(0, Math.min(10, state.stamps || 0))}.png?v=${state.stamps}`;
  return {
    id: objectId(customer.code),
    classId: classId(),
    state: 'ACTIVE',
    accountId: customer.code,
    accountName: state.name,
    barcode: { type: 'QR_CODE', value: customer.code, alternateText: customer.code },
    loyaltyPoints: { label: 'visitas', balance: { string: String(state.stamps).padStart(2, '0') } },
    heroImage: { sourceUri: { uri: hero } },
    hexBackgroundColor: '#EC562B',
    textModulesData: [
      { id: 'status', header: 'un bugo?', body: hint },
      { id: 'tagline', header: 'bugo bogo', body: 'mejor 2' }
    ]
  };
}

// The class is the template every card points at. Google refuses to save a
// card whose class doesn't exist, so this must actually succeed — and it is
// only remembered when it did. Caching a failure here used to make the app
// stop retrying for the life of the process, which hid the real error.
let classEnsured = false;
const LOGO_URL = () => `${process.env.BASE_URL || 'https://al-dia-production.up.railway.app'}/icon-192.png`;

async function ensureClass(state) {
  if (classEnsured) return;
  const token = await accessToken();
  const res = await gapi('GET', `/loyaltyClass/${classId()}`, null, token);
  if (res.ok) { classEnsured = true; return; }
  if (res.status !== 404) {
    throw new Error(`Google Wallet class lookup failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const body = {
    id: classId(),
    issuerName: state.programName,
    programName: state.programName,
    programLogo: { sourceUri: { uri: LOGO_URL() } },
    reviewStatus: 'UNDER_REVIEW',
    hexBackgroundColor: '#EC562B',
    countryCode: 'MX'
  };
  let created = await gapi('POST', '/loyaltyClass', body, token);
  if (!created.ok) {
    // A logo Google can't fetch is the usual reason an insert is rejected;
    // the card works without one, so rather than fail outright, try again
    // plain and report what Google said if that fails too.
    const first = (await created.text()).slice(0, 300);
    delete body.programLogo;
    created = await gapi('POST', '/loyaltyClass', body, token);
    if (!created.ok) {
      throw new Error(`Google Wallet class creation failed (${created.status}): ${first} | without logo: ${(await created.text()).slice(0, 300)}`);
    }
    console.warn('Google Wallet: class created without a logo —', first);
  }
  classEnsured = true;
}

// "Save to Google Wallet" URL — the object rides inside the signed JWT.
async function saveLink(customer, state) {
  await ensureClass(state);
  const account = sa();
  const jwt = signJwt({
    iss: account.client_email, aud: 'google', typ: 'savetowallet',
    payload: { loyaltyObjects: [loyaltyObject(customer, state)] }
  }, account);
  return `https://pay.google.com/gp/v/save/${jwt}`;
}

// Update the stored object after a visit/redemption, with a card message.
async function pushUpdate(customer, state, message) {
  if (!googleReady()) return;
  try {
    const token = await accessToken();
    const id = objectId(customer.code);
    const res = await gapi('PUT', `/loyaltyObject/${id}`, loyaltyObject(customer, state), token);
    if (res.ok && message) {
      await gapi('POST', `/loyaltyObject/${id}/addMessage`, {
        message: { header: state.programName, body: message, messageType: 'TEXT' }
      }, token);
    }
  } catch (e) { console.error('Google Wallet update:', e.message); }
}

// Stores the service-account key uploaded through Settings.
function saveServiceAccount(jsonText) {
  const parsed = JSON.parse(jsonText); // throws on bad JSON
  if (!parsed.client_email || !parsed.private_key)
    throw new Error('That JSON is not a service-account key (missing client_email/private_key)');
  fs.mkdirSync(SA_DIR, { recursive: true });
  fs.writeFileSync(SA_FILE, jsonText, { mode: 0o600 });
  return parsed.client_email;
}

module.exports = { googleReady, saveLink, pushUpdate, saveServiceAccount };
