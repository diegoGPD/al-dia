// Apple Wallet: builds and signs .pkpass files (storeCard) and pushes updates
// through APNs so cards refresh on customers' phones automatically.
//
// Activates when these exist (see docs/WALLET-SETUP.md):
//   DATA_DIR/wallet/pass_cert.pem   — Pass Type ID certificate (PEM)
//   DATA_DIR/wallet/pass_key.pem    — its private key (PEM, no passphrase)
//   DATA_DIR/wallet/wwdr.pem        — Apple WWDR G4 intermediate (PEM)
//   env PASS_TYPE_ID                — e.g. pass.com.aldia.loyalty
//   env APPLE_TEAM_ID               — 10-char team id
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http2 = require('node:http2');
const { DATA_DIR, db } = require('../db');
const { zip } = require('../lib/zip');
const { solidPng } = require('../lib/png');

const WALLET_DIR = path.join(DATA_DIR, 'wallet');
const IMG_DIR = path.join(WALLET_DIR, 'images');
const file = n => path.join(WALLET_DIR, n);

// IDs can come from env vars or from Settings (stored in loyalty_config).
function getIds() {
  const row = db.prepare('SELECT pass_type_id, apple_team_id FROM loyalty_config WHERE id = 1').get() || {};
  return {
    passTypeId: process.env.PASS_TYPE_ID || row.pass_type_id || null,
    teamId: process.env.APPLE_TEAM_ID || row.apple_team_id || null
  };
}

function appleReady() {
  const { passTypeId, teamId } = getIds();
  return !!(passTypeId && teamId &&
    fs.existsSync(file('pass_cert.pem')) && fs.existsSync(file('pass_key.pem')) &&
    fs.existsSync(file('wwdr.pem')));
}

// Apple's WWDR G4 intermediate is public — fetch and cache it automatically
// so the owner has one less file to deal with.
async function ensureWwdr() {
  if (fs.existsSync(file('wwdr.pem'))) return true;
  try {
    const res = await fetch('https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer');
    if (!res.ok) return false;
    const der = Buffer.from(await res.arrayBuffer());
    const pem = '-----BEGIN CERTIFICATE-----\n' +
      der.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
    fs.mkdirSync(WALLET_DIR, { recursive: true });
    fs.writeFileSync(file('wwdr.pem'), pem);
    return true;
  } catch (e) { console.error('WWDR fetch:', e.message); return false; }
}
setTimeout(() => { ensureWwdr(); }, 5000); // warm the cache after boot

// Accepts the .p12 exported straight from Keychain Access and extracts the
// certificate + key, so the owner never touches openssl.
function importP12(p12Base64, password) {
  const forge = require('node-forge');
  const asn1 = forge.asn1.fromDer(forge.util.decode64(p12Base64));
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password || '');
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [])
  ];
  if (!certBags.length || !keyBags.length)
    throw new Error('That .p12 has no certificate + key pair inside');
  // Pick the leaf cert (the one matching the private key), not any included CA.
  const key = keyBags[0].key;
  const keyPem = forge.pki.privateKeyToPem(key);
  const pubFromKey = forge.pki.rsa.setPublicKey(key.n, key.e);
  const match = certBags.find(b => {
    try { return forge.pki.publicKeyToPem(b.cert.publicKey) === forge.pki.publicKeyToPem(pubFromKey); }
    catch { return false; }
  }) || certBags[0];
  fs.mkdirSync(WALLET_DIR, { recursive: true });
  fs.writeFileSync(file('pass_cert.pem'), forge.pki.certificateToPem(match.cert));
  fs.writeFileSync(file('pass_key.pem'), keyPem, { mode: 0o600 });
  return certInfo();
}

const GREEN = [26, 127, 90];
function image(name, w, h) {
  const custom = path.join(IMG_DIR, name);
  if (fs.existsSync(custom)) return fs.readFileSync(custom);
  return solidPng(w, h, GREEN);
}

function passJson(customer, state, baseUrl) {
  const rewardReady = state.rewardsAvailable > 0;
  const { passTypeId, teamId } = getIds();
  return {
    formatVersion: 1,
    passTypeIdentifier: passTypeId,
    teamIdentifier: teamId,
    serialNumber: customer.code,
    organizationName: state.programName,
    description: `${state.programName} — tarjeta de lealtad`,
    logoText: state.programName,
    foregroundColor: 'rgb(255,255,255)',
    backgroundColor: 'rgb(26,127,90)',
    labelColor: 'rgb(220,240,232)',
    webServiceURL: `${baseUrl}/api/passes`,
    authenticationToken: customer.auth_token,
    barcodes: [{
      format: 'PKBarcodeFormatQR',
      message: customer.code,
      messageEncoding: 'iso-8859-1',
      altText: customer.code
    }],
    storeCard: {
      headerFields: [{
        key: 'stamps', label: 'SELLOS',
        value: `${state.stamps}/${state.stampsNeeded}`,
        changeMessage: 'Sellos: %@'
      }],
      primaryFields: [{
        key: 'status',
        label: rewardReady ? 'RECOMPENSA LISTA' : 'PRÓXIMA RECOMPENSA',
        value: rewardReady
          ? `🎁 ${state.rewardText} — ¡canjéala!`
          : `${state.toNext} visita${state.toNext === 1 ? '' : 's'} para: ${state.rewardText}`,
        changeMessage: '%@'
      }],
      secondaryFields: [
        { key: 'name', label: 'CLIENTE', value: state.name },
        { key: 'visits', label: 'VISITAS', value: String(state.visits) }
      ],
      backFields: [
        { key: 'how', label: 'Cómo funciona',
          value: `Muestra este código en caja en cada visita. Cada ${state.stampsNeeded} sellos: ${state.rewardText}.` },
        { key: 'privacy', label: 'Tus datos',
          value: `Solo guardamos tu nombre y contacto para el programa. Puedes borrar tus datos cuando quieras en ${baseUrl}/card/${customer.code}` }
      ]
    }
  };
}

// PKCS#7 detached signature over the manifest, per the Wallet Passes spec.
function signManifest(manifestBuf) {
  const forge = require('node-forge');
  const cert = forge.pki.certificateFromPem(fs.readFileSync(file('pass_cert.pem'), 'utf8'));
  const key = forge.pki.privateKeyFromPem(fs.readFileSync(file('pass_key.pem'), 'utf8'));
  const wwdr = forge.pki.certificateFromPem(fs.readFileSync(file('wwdr.pem'), 'utf8'));
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifestBuf.toString('binary'));
  p7.addCertificate(wwdr);
  p7.addCertificate(cert);
  p7.addSigner({
    key, certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() }
    ]
  });
  p7.sign({ detached: true });
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

function buildPkpass(customer, state, baseUrl) {
  const files = {
    'pass.json': Buffer.from(JSON.stringify(passJson(customer, state, baseUrl))),
    'icon.png': image('icon.png', 29, 29),
    'icon@2x.png': image('icon@2x.png', 58, 58),
    'icon@3x.png': image('icon@3x.png', 87, 87),
    'logo.png': image('logo.png', 160, 50),
    'logo@2x.png': image('logo@2x.png', 320, 100)
  };
  const manifest = {};
  for (const [name, buf] of Object.entries(files)) {
    manifest[name] = crypto.createHash('sha1').update(buf).digest('hex');
  }
  const manifestBuf = Buffer.from(JSON.stringify(manifest));
  const entries = [
    ...Object.entries(files).map(([name, data]) => ({ name, data })),
    { name: 'manifest.json', data: manifestBuf },
    { name: 'signature', data: signManifest(manifestBuf) }
  ];
  return zip(entries);
}

// Push an empty APNs notification to every device holding this pass —
// Wallet then fetches the updated pass and shows the changeMessage.
function pushUpdate(serial) {
  if (!appleReady()) return;
  const regs = db.prepare('SELECT * FROM wallet_registrations WHERE serial = ?').all(serial);
  if (!regs.length) return;
  const client = http2.connect('https://api.push.apple.com', {
    cert: fs.readFileSync(file('pass_cert.pem')),
    key: fs.readFileSync(file('pass_key.pem'))
  });
  client.on('error', err => console.error('APNs connect:', err.message));
  let pending = regs.length;
  for (const reg of regs) {
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${reg.push_token}`,
      'apns-topic': getIds().passTypeId,
      'apns-push-type': 'background'
    });
    req.setEncoding('utf8');
    req.on('response', headers => {
      if (headers[':status'] === 410) {
        db.prepare('DELETE FROM wallet_registrations WHERE device_id = ? AND serial = ?')
          .run(reg.device_id, reg.serial);
      }
    });
    req.on('error', err => console.error('APNs push:', err.message));
    req.on('close', () => { if (--pending === 0) client.close(); });
    req.end('{}');
  }
}

// Certificate expiry, for the Settings reminder — passes can't be issued or
// updated once the Pass Type ID certificate lapses.
function certInfo() {
  if (!fs.existsSync(file('pass_cert.pem'))) return null;
  try {
    const forge = require('node-forge');
    const cert = forge.pki.certificateFromPem(fs.readFileSync(file('pass_cert.pem'), 'utf8'));
    const expires = cert.validity.notAfter;
    const daysLeft = Math.floor((expires.getTime() - Date.now()) / 864e5);
    return { expires: expires.toISOString().slice(0, 10), daysLeft };
  } catch { return null; }
}

module.exports = { appleReady, buildPkpass, pushUpdate, certInfo, importP12, ensureWwdr, WALLET_DIR };
