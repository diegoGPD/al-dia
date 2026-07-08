// Session auth: HMAC-signed tokens in an httpOnly cookie. No extra dependencies.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('./db');

// Secret from env, or generated once and kept next to the database.
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, '.session-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
const SECRET = loadSecret();
const COOKIE = 'aldia_session';
const MAX_AGE_DAYS = 30;

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.uid || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function setSession(res, userId) {
  const token = sign({ uid: userId, exp: Date.now() + MAX_AGE_DAYS * 864e5 });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_DAYS * 86400}${secure}`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// Middleware: attach req.user (with allowed location ids) or 401.
function requireAuth(req, res, next) {
  const payload = verify(parseCookies(req)[COOKIE]);
  if (!payload) return res.status(401).json({ error: 'Not signed in' });
  const user = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(payload.uid);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  if (user.role === 'owner') {
    user.locationIds = db.prepare('SELECT id FROM locations WHERE active = 1').all().map(r => r.id);
  } else {
    user.locationIds = db.prepare(
      `SELECT l.id FROM locations l JOIN user_locations ul ON ul.location_id = l.id
       WHERE ul.user_id = ? AND l.active = 1`).all(user.id).map(r => r.id);
  }
  req.user = user;
  next();
}

function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  next();
}

// Validates the :location the request is acting on.
function checkLocation(req, res, next) {
  const id = Number(req.query.location || req.body.location_id);
  if (!id || !req.user.locationIds.includes(id)) {
    return res.status(403).json({ error: 'No access to this location' });
  }
  req.locationId = id;
  next();
}

module.exports = { setSession, clearSession, requireAuth, requireOwner, checkLocation };
