// Channel payout reconciliation — enter what a delivery app actually paid,
// overriding the commission estimate for that window. Gated by its own PIN
// (hashed, changeable in-app) that unlocks for 30 minutes at a time.
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireOwner, checkLocation } = require('../auth');
const { num } = require('../lib/parse');
const { badDate, todayStr } = require('../lib/dates');
const calc = require('../calc');

const PIN_KEY = 'recon_pin_hash';
const UNLOCK_MINUTES = 30;
const unlocked = new Map(); // userId -> expiry ms (cleared on restart)

function pinHash() {
  let row = db.prepare('SELECT token FROM app_tokens WHERE name = ?').get(PIN_KEY);
  if (!row) {
    // First run: seed with the owner's chosen PIN, stored hashed.
    const hash = bcrypt.hashSync(process.env.RECON_PIN || '2374', 10);
    db.prepare('INSERT INTO app_tokens (name, token) VALUES (?,?)').run(PIN_KEY, hash);
    return hash;
  }
  return row.token;
}

const isUnlocked = userId => (unlocked.get(userId) || 0) > Date.now();

function requirePin(req, res, next) {
  if (!isUnlocked(req.user.id)) {
    return res.status(423).json({ error: 'PIN required', locked: true });
  }
  next();
}

module.exports = (r) => {
  r.get('/reconcile/status', requireOwner, (req, res) => {
    const exp = unlocked.get(req.user.id) || 0;
    res.json({ unlocked: exp > Date.now(), expiresInSec: Math.max(0, Math.round((exp - Date.now()) / 1000)) });
  });

  r.post('/reconcile/unlock', requireOwner, (req, res) => {
    if (!bcrypt.compareSync(String(req.body.pin || ''), pinHash())) {
      return res.status(403).json({ error: 'Wrong PIN' });
    }
    unlocked.set(req.user.id, Date.now() + UNLOCK_MINUTES * 60000);
    res.json({ ok: true, minutes: UNLOCK_MINUTES });
  });

  r.post('/reconcile/lock', requireOwner, (req, res) => {
    unlocked.delete(req.user.id);
    res.json({ ok: true });
  });

  r.post('/reconcile/change-pin', requireOwner, (req, res) => {
    const { current_pin, new_pin } = req.body;
    if (!bcrypt.compareSync(String(current_pin || ''), pinHash()))
      return res.status(403).json({ error: 'Current PIN is wrong' });
    if (!/^\d{4,8}$/.test(String(new_pin || '')))
      return res.status(400).json({ error: 'New PIN must be 4–8 digits' });
    db.prepare(`INSERT INTO app_tokens (name, token) VALUES (?,?)
      ON CONFLICT (name) DO UPDATE SET token = excluded.token`)
      .run(PIN_KEY, bcrypt.hashSync(String(new_pin), 10));
    unlocked.delete(req.user.id);
    res.json({ ok: true });
  });

  // What the estimate says for a channel + window (the "before" figure).
  r.get('/reconcile/preview', requireOwner, checkLocation, (req, res) => {
    const { start, end, category_id } = req.query;
    if (badDate(start) || badDate(end)) return res.status(400).json({ error: 'Invalid range' });
    const cat = db.prepare('SELECT id, name, commission_percent FROM revenue_categories WHERE id = ? AND location_id = ?')
      .get(Number(category_id), req.locationId);
    if (!cat) return res.status(404).json({ error: 'Channel not found' });
    const row = db.prepare(
      `SELECT COALESCE(SUM(ri.amount),0) gross, COALESCE(SUM(ri.commission_amount),0) commission
       FROM revenue_items ri JOIN revenue_entries re ON re.id = ri.entry_id
       WHERE re.location_id = ? AND ri.category_id = ? AND re.date BETWEEN ? AND ?`)
      .get(req.locationId, cat.id, start, end);
    const existing = db.prepare(
      `SELECT id, start_date, end_date FROM channel_reconciliations
       WHERE location_id = ? AND category_id = ? AND start_date <= ? AND end_date >= ?`)
      .all(req.locationId, cat.id, end, start);
    res.json({
      channel: cat.name, category_id: cat.id, start, end,
      gross: row.gross, commission: row.commission,
      estimated_net: row.gross - row.commission,
      overlapping: existing
    });
  });

  r.get('/reconcile/history', requireOwner, checkLocation, (req, res) => {
    res.json(db.prepare(
      `SELECT r.*, c.name channel FROM channel_reconciliations r
       JOIN revenue_categories c ON c.id = r.category_id
       WHERE r.location_id = ? ORDER BY r.start_date DESC, r.id DESC LIMIT 100`)
      .all(req.locationId)
      .map(x => ({ ...x, variance: x.actual_net - x.estimated_net,
        variance_pct: x.estimated_net > 0 ? (x.actual_net - x.estimated_net) / x.estimated_net : null })));
  });

  r.post('/reconcile', requireOwner, checkLocation, requirePin, (req, res) => {
    const { category_id, start, end, actual_net, note } = req.body;
    if (badDate(start) || badDate(end) || start > end)
      return res.status(400).json({ error: 'Invalid date range' });
    const cat = db.prepare('SELECT id, name FROM revenue_categories WHERE id = ? AND location_id = ?')
      .get(Number(category_id), req.locationId);
    if (!cat) return res.status(404).json({ error: 'Channel not found' });
    // No overlapping windows per channel — a day can only be corrected once.
    const clash = db.prepare(
      `SELECT start_date, end_date FROM channel_reconciliations
       WHERE location_id = ? AND category_id = ? AND start_date <= ? AND end_date >= ?`)
      .get(req.locationId, cat.id, end, start);
    if (clash) return res.status(400).json({
      error: `${cat.name} already has a correction covering ${clash.start_date} → ${clash.end_date}. Delete it first.` });

    const row = db.prepare(
      `SELECT COALESCE(SUM(ri.amount),0) gross, COALESCE(SUM(ri.commission_amount),0) commission
       FROM revenue_items ri JOIN revenue_entries re ON re.id = ri.entry_id
       WHERE re.location_id = ? AND ri.category_id = ? AND re.date BETWEEN ? AND ?`)
      .get(req.locationId, cat.id, start, end);
    if (row.gross <= 0) return res.status(400).json({ error: 'No sales for that channel in this period' });
    const estimated = row.gross - row.commission;
    const actual = num(actual_net);
    if (actual < 0) return res.status(400).json({ error: 'Actual amount cannot be negative' });

    const { lastInsertRowid } = db.prepare(
      `INSERT INTO channel_reconciliations
       (location_id, category_id, start_date, end_date, gross, estimated_net, actual_net, note)
       VALUES (?,?,?,?,?,?,?,?)`)
      .run(req.locationId, cat.id, start, end, row.gross, estimated, actual,
        (note || '').trim().slice(0, 200) || null);
    res.json({
      id: Number(lastInsertRowid), channel: cat.name,
      gross: row.gross, estimated_net: estimated, actual_net: actual,
      variance: actual - estimated
    });
  });

  r.delete('/reconcile/:id', requireOwner, checkLocation, requirePin, (req, res) => {
    db.prepare('DELETE FROM channel_reconciliations WHERE id = ? AND location_id = ?')
      .run(Number(req.params.id), req.locationId);
    res.json({ ok: true });
  });
};
