// Money accounts: the per-account view, transfers, and PIN-protected corrections.
const { db } = require('../db');
const { checkLocation } = require('../auth');
const { num } = require('../lib/parse');
const { badDate, todayStr, periodBounds } = require('../lib/dates');
const calc = require('../calc');

const BALANCE_PIN = process.env.BALANCE_PIN || '2374';

module.exports = (r) => {
  r.get('/accounts-view', checkLocation, (req, res) => {
    const granularity = ['day', 'week', 'month'].includes(req.query.granularity) ? req.query.granularity : 'day';
    const anchor = !badDate(req.query.date) ? req.query.date : todayStr();
    const bounds = periodBounds(granularity, anchor);
    const end = bounds.end > anchor && bounds.start <= anchor ? anchor : bounds.end;
    const view = calc.accountsView(req.locationId, bounds.start, end);
    view.granularity = granularity; view.anchor = anchor;
    view.start = bounds.start; view.end = end; view.periodEnd = bounds.end;
    view.transfers = db.prepare(
      `SELECT t.*, fa.name from_name, ta.name to_name FROM transfers t
       JOIN accounts fa ON fa.id = t.from_account_id
       JOIN accounts ta ON ta.id = t.to_account_id
       WHERE t.location_id = ? AND t.date BETWEEN ? AND ? ORDER BY t.date DESC, t.id DESC`)
      .all(req.locationId, bounds.start, end);
    res.json(view);
  });

  // Manual balance correction: sets the balance to the value given by
  // recording the signed difference, PIN-checked server-side.
  r.post('/accounts/adjust', checkLocation, (req, res) => {
    const { account_id, new_balance, pin, note } = req.body;
    if (String(pin) !== BALANCE_PIN) return res.status(403).json({ error: 'Wrong PIN' });
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ? AND location_id = ? AND active = 1')
      .get(Number(account_id), req.locationId);
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    const target = num(new_balance);
    const today = todayStr();
    const view = calc.accountsView(req.locationId, today, today);
    const current = view.accounts.find(a => a.id === acc.id).balance;
    const delta = target - current;
    if (Math.abs(delta) < 0.005) return res.json({ ok: true, adjusted: 0, balance: current });
    db.prepare(
      'INSERT INTO account_adjustments (location_id, account_id, date, amount, note) VALUES (?,?,?,?,?)')
      .run(req.locationId, acc.id, today, delta, (note || '').trim() || 'Manual balance correction');
    res.json({ ok: true, adjusted: delta, balance: target });
  });

  // ---- transfers between accounts ----
  r.post('/transfers', checkLocation, (req, res) => {
    const { date, from_account_id, to_account_id, amount, note } = req.body;
    if (badDate(date) || num(amount) <= 0) return res.status(400).json({ error: 'Date and amount are required' });
    const from = Number(from_account_id), to = Number(to_account_id);
    if (!from || !to || from === to) return res.status(400).json({ error: 'Pick two different accounts' });
    const valid = new Set(db.prepare('SELECT id FROM accounts WHERE location_id = ?').all(req.locationId).map(a => a.id));
    if (!valid.has(from) || !valid.has(to)) return res.status(404).json({ error: 'Account not found' });
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO transfers (location_id, date, from_account_id, to_account_id, amount, note) VALUES (?,?,?,?,?,?)')
      .run(req.locationId, date, from, to, num(amount), (note || '').trim() || null);
    res.json({ id: Number(lastInsertRowid) });
  });

  r.put('/transfers/:id', checkLocation, (req, res) => {
    const it = db.prepare('SELECT * FROM transfers WHERE id = ? AND location_id = ?')
      .get(Number(req.params.id), req.locationId);
    if (!it) return res.status(404).json({ error: 'Not found' });
    const b = req.body;
    const from = b.from_account_id !== undefined ? Number(b.from_account_id) : it.from_account_id;
    const to = b.to_account_id !== undefined ? Number(b.to_account_id) : it.to_account_id;
    if (from === to) return res.status(400).json({ error: 'Pick two different accounts' });
    db.prepare('UPDATE transfers SET date=?, from_account_id=?, to_account_id=?, amount=?, note=? WHERE id=?')
      .run(!badDate(b.date) ? b.date : it.date, from, to,
        b.amount !== undefined ? num(b.amount) : it.amount,
        b.note !== undefined ? ((b.note || '').trim() || null) : it.note,
        it.id);
    res.json({ ok: true });
  });

  r.delete('/transfers/:id', checkLocation, (req, res) => {
    db.prepare('DELETE FROM transfers WHERE id = ? AND location_id = ?')
      .run(Number(req.params.id), req.locationId);
    res.json({ ok: true });
  });
};
