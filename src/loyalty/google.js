// Google Wallet: "Save to Google Wallet" links (signed JWT) and object updates
// with card messages. Activates when these exist (see docs/WALLET-SETUP.md):
//   DATA_DIR/wallet/google-service-account.json
//   env GOOGLE_WALLET_ISSUER_ID
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('../db');

const SA_FILE = path.join(DATA_DIR, 'wallet', 'google-service-account.json');
const API = 'https://walletobjects.googleapis.com/walletobjects/v1';
const CLASS_SUFFIX = 'aldia_loyalty';

const googleReady = () => !!(process.env.GOOGLE_WALLET_ISSUER_ID && fs.existsSync(SA_FILE));
const sa = () => JSON.parse(fs.readFileSync(SA_FILE, 'utf8'));
const classId = () => `${process.env.GOOGLE_WALLET_ISSUER_ID}.${CLASS_SUFFIX}`;
const objectId = code => `${process.env.GOOGLE_WALLET_ISSUER_ID}.${CLASS_SUFFIX}_${code}`;

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

function loyaltyObject(customer, state) {
  const rewardReady = state.rewardsAvailable > 0;
  return {
    id: objectId(customer.code),
    classId: classId(),
    state: 'ACTIVE',
    accountId: customer.code,
    accountName: state.name,
    barcode: { type: 'QR_CODE', value: customer.code, alternateText: customer.code },
    loyaltyPoints: { label: 'Sellos', balance: { string: `${state.stamps}/${state.stampsNeeded}` } },
    textModulesData: [{
      id: 'status',
      header: rewardReady ? 'Recompensa lista' : 'Próxima recompensa',
      body: rewardReady
        ? `🎁 ${state.rewardText} — ¡canjéala en tu próxima visita!`
        : `${state.toNext} visita${state.toNext === 1 ? '' : 's'} para: ${state.rewardText}`
    }]
  };
}

let classEnsured = false;
async function ensureClass(state) {
  if (classEnsured) return;
  const token = await accessToken();
  const res = await gapi('GET', `/loyaltyClass/${classId()}`, null, token);
  if (res.status === 404) {
    await gapi('POST', '/loyaltyClass', {
      id: classId(), issuerName: state.programName, programName: state.programName,
      programLogo: { sourceUri: { uri: 'https://al-dia-production.up.railway.app/icon-192.png' } },
      reviewStatus: 'UNDER_REVIEW',
      hexBackgroundColor: '#1a7f5a',
      countryCode: 'MX'
    }, token);
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

module.exports = { googleReady, saveLink, pushUpdate };
