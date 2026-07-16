// Inbound POS webhook. Each location has a secret URL; whatever the POS
// posts there is stored, and payloads matching the documented format are
// auto-logged as that day's revenue (with channel breakdown + commissions).
//
// Documented format (send what you have — total alone is fine):
//   POST /api/webhooks/pos/<token>
//   { "date": "2026-07-15",            // or "fecha"; defaults to today
//     "total": 12345.67,               // or "amount" / "venta" / "total_sales"
//     "channels": [                    // optional; names matched to your
//       {"name": "Órdenes de Uber Eats", "amount": 2100.50},   // sales channels
//       {"name": "Efectivo en tienda",  "amount": 810.00} ] }
const crypto = require('node:crypto');
const { db } = require('../db');
const { requireOwner, checkLocation } = require('../auth');
const { num } = require('../lib/parse');
const { badDate, todayStr } = require('../lib/dates');
const { upsertDayRevenue } = require('../lib/revenue');
const pd = require('../integrations/pidedirecto');

function tokenFor(locationId) {
  let row = db.prepare('SELECT webhook_token FROM locations WHERE id = ?').get(locationId);
  if (!row.webhook_token) {
    const t = crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE locations SET webhook_token = ? WHERE id = ?').run(t, locationId);
    return t;
  }
  return row.webhook_token;
}

// Best-effort extraction from arbitrary POS payloads.
function interpret(p, locationId) {
  const date = [p.date, p.fecha, p.business_date, p.dia].find(d => !badDate(d)) || todayStr();
  const total = [p.total, p.amount, p.venta, p.total_sales, p.net_sales]
    .map(num).find(v => v > 0) || 0;
  const rawChannels = Array.isArray(p.channels) ? p.channels
    : Array.isArray(p.by_channel) ? p.by_channel : [];
  if (!total && !rawChannels.length) return null;

  const cats = db.prepare(
    'SELECT id, name FROM revenue_categories WHERE location_id = ? AND active = 1').all(locationId);
  const byName = Object.fromEntries(cats.map(c => [c.name.toLowerCase().trim(), c.id]));
  const items = [];
  const unmatched = [];
  for (const ch of rawChannels) {
    const name = String(ch.name || ch.channel || '').toLowerCase().trim();
    const amount = num(ch.amount ?? ch.total ?? ch.venta);
    if (!name || amount === 0) continue;
    if (byName[name]) items.push({ category_id: byName[name], amount });
    else unmatched.push(ch.name || ch.channel);
  }
  return { date, total, items, unmatched };
}

function publicRoutes(r) {
  r.post('/webhooks/pos/:token', (req, res) => {
    const loc = db.prepare('SELECT id FROM locations WHERE webhook_token = ? AND active = 1')
      .get(req.params.token);
    if (!loc) return res.status(404).json({ error: 'Unknown webhook' });
    const payload = JSON.stringify(req.body ?? {}).slice(0, 20000);
    const evt = db.prepare(
      'INSERT INTO pos_events (location_id, payload) VALUES (?,?)').run(loc.id, payload);
    // keep only the last 200 events per location
    db.prepare(`DELETE FROM pos_events WHERE location_id = ? AND id NOT IN
      (SELECT id FROM pos_events WHERE location_id = ? ORDER BY id DESC LIMIT 200)`)
      .run(loc.id, loc.id);

    let status = 'stored', note = 'Stored — format not recognized for auto-logging';
    try {
      // PideDirecto order events take priority on this same URL.
      if (pd.looksLikePideDirecto(req.body)) {
        const r = pd.processWebhook(loc.id, req.body);
        db.prepare('UPDATE pos_events SET status = ?, note = ? WHERE id = ?')
          .run(r.status, r.note, Number(evt.lastInsertRowid));
        return res.json({ ok: true, ...r });
      }
      const data = interpret(req.body || {}, loc.id);
      if (data) {
        const result = upsertDayRevenue(loc.id, data.date, {
          total: data.total, items: data.items, note: 'POS webhook'
        });
        status = 'processed';
        note = `Logged ${data.date}: total ${result.total.toFixed(2)}` +
          (data.items.length ? `, ${data.items.length} channels` : '') +
          (data.unmatched.length ? `; unmatched channels: ${data.unmatched.join(', ')}` : '');
        // The logged total comes from the matched channel breakdown — if the
        // POS declared a different total, someone should look at it.
        if (data.items.length && data.total > 0 && Math.abs(data.total - result.total) > 1) {
          note += ` ⚠ POS declared total ${data.total.toFixed(2)} but matched channels sum to ${result.total.toFixed(2)} — add the missing channel names in Settings so nothing is dropped.`;
        }
      }
    } catch (e) { status = 'error'; note = e.message; }
    db.prepare('UPDATE pos_events SET status = ?, note = ? WHERE id = ?')
      .run(status, note, Number(evt.lastInsertRowid));
    res.json({ ok: true, status, note });
  });
}

function staffRoutes(r) {
  r.get('/webhooks/pos-info', requireOwner, checkLocation, (req, res) => {
    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({
      url: `${base}/api/webhooks/pos/${tokenFor(req.locationId)}`,
      events: db.prepare(
        `SELECT id, received_at, status, note, substr(payload, 1, 400) payload
         FROM pos_events WHERE location_id = ? ORDER BY id DESC LIMIT 15`).all(req.locationId)
    });
  });

  // PideDirecto per-location config + manual reconciliation
  r.get('/webhooks/pd-status', requireOwner, checkLocation, (req, res) => {
    res.json(pd.statusFor(req.locationId));
  });

  r.post('/webhooks/pd-config', requireOwner, checkLocation, (req, res) => {
    const id = (req.body.pd_store_id || '').trim() || null;
    db.prepare('UPDATE locations SET pd_store_id = ? WHERE id = ?').run(id, req.locationId);
    res.json({ ok: true, ...pd.statusFor(req.locationId) });
  });

  r.post('/webhooks/pd-reconcile', requireOwner, checkLocation, async (req, res) => {
    try { res.json(await pd.reconcileLocation(req.locationId, Number(req.body.days) || 3)); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });

  r.post('/webhooks/pos-regenerate', requireOwner, checkLocation, (req, res) => {
    const t = crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE locations SET webhook_token = ? WHERE id = ?').run(t, req.locationId);
    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ url: `${base}/api/webhooks/pos/${t}` });
  });
}

module.exports = { publicRoutes, staffRoutes };
