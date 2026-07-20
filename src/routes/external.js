// Read-only external feed for the kitchen's local server.
// Cursor-polled (~every 5s): GET /api/external/new-orders?since=<cursor>
// with header X-Feed-Token. Returns completed Uber Eats / Rappi / Didi Food
// orders with food-prep info only — never customer or payment data.
const crypto = require('node:crypto');
const { db } = require('../db');
const { requireOwner } = require('../auth');

const TOKEN_NAME = 'kitchen_feed';

function getToken(create) {
  let row = db.prepare('SELECT token FROM app_tokens WHERE name = ?').get(TOKEN_NAME);
  if (!row && create) {
    const token = crypto.randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO app_tokens (name, token) VALUES (?,?)').run(TOKEN_NAME, token);
    return token;
  }
  return row ? row.token : null;
}

function tokenOk(req) {
  const sent = req.get('X-Feed-Token') || '';
  const real = getToken(false);
  if (!real || sent.length !== real.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(real));
}

// Public (token-guarded) — mounted before the session-auth wall.
function publicRoutes(r) {
  r.get('/external/new-orders', (req, res) => {
    if (!tokenOk(req)) return res.status(401).json({ error: 'Bad or missing X-Feed-Token' });

    // since=latest -> skip history, start from "now"
    if (req.query.since === 'latest') {
      const max = db.prepare('SELECT COALESCE(MAX(id), 0) m FROM external_feed').get().m;
      return res.json({ cursor: max, orders: [] });
    }
    const since = Math.max(0, Number(req.query.since) || 0);
    // Indexed integer-PK range scan — safe to hit every 5 seconds.
    const rows = db.prepare(
      `SELECT id, order_id, location_id, channel, received_at, note, items_json
       FROM external_feed WHERE id > ? ORDER BY id ASC LIMIT 200`).all(since);
    res.json({
      cursor: rows.length ? rows[rows.length - 1].id : since,
      orders: rows.map(x => ({
        orderId: x.order_id,
        channel: x.channel,
        locationId: x.location_id,
        receivedAt: x.received_at,
        ...(x.note ? { note: x.note } : {}),
        items: JSON.parse(x.items_json)
      }))
    });
  });
}

// Owner management (behind the normal auth wall).
function staffRoutes(r) {
  r.get('/external/feed-token', requireOwner, (req, res) => {
    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const token = getToken(true);
    res.json({
      token,
      url: `${base}/api/external/new-orders`,
      pending: db.prepare('SELECT COUNT(*) c FROM external_feed').get().c
    });
  });

  r.post('/external/feed-token/regenerate', requireOwner, (req, res) => {
    const token = crypto.randomBytes(24).toString('base64url');
    db.prepare(`INSERT INTO app_tokens (name, token) VALUES (?,?)
      ON CONFLICT (name) DO UPDATE SET token = excluded.token`).run(TOKEN_NAME, token);
    res.json({ token });
  });
}

module.exports = { publicRoutes, staffRoutes };
