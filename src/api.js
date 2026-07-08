// REST API routes.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, createLocation } = require('./db');
const { setSession, clearSession, requireAuth, requireOwner, checkLocation } = require('./auth');
const calc = require('./calc');

const r = express.Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const bool01 = v => (v === true || v === 1 || v === '1' || v === 'true' || v === 'yes' || v === 'si' || v === 'sí') ? 1 : 0;
const badDate = d => !d || !DATE_RE.test(d);

// ============ auth & setup ============
r.get('/status', (req, res) => {
  const hasUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c > 0;
  res.json({ needsSetup: !hasUsers });
});

// First run: create the owner account and first location.
r.post('/setup', (req, res) => {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0)
    return res.status(400).json({ error: 'Already set up' });
  const { email, name, password, locationName } = req.body;
  if (!email || !password || password.length < 8)
    return res.status(400).json({ error: 'Email and a password of at least 8 characters are required' });
  const hash = bcrypt.hashSync(password, 10);
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)')
    .run(email.trim().toLowerCase(), name || 'Owner', hash, 'owner');
  createLocation((locationName || 'My restaurant').trim());
  setSession(res, Number(lastInsertRowid));
  res.json({ ok: true });
});

r.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash))
    return res.status(401).json({ error: 'Wrong email or password' });
  setSession(res, user.id);
  res.json({ ok: true });
});

r.post('/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

r.use(requireAuth); // everything below needs a session

r.get('/me', (req, res) => {
  const locations = db.prepare(
    `SELECT id, name FROM locations WHERE active = 1 AND id IN (${req.user.locationIds.map(() => '?').join(',') || 'NULL'}) ORDER BY name`)
    .all(...req.user.locationIds);
  res.json({ user: { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role }, locations });
});

// ============ locations (owner) ============
r.post('/locations', requireOwner, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  res.json({ id: createLocation(name) });
});

r.put('/locations/:id', requireOwner, (req, res) => {
  db.prepare('UPDATE locations SET name = ? WHERE id = ?').run((req.body.name || '').trim(), Number(req.params.id));
  res.json({ ok: true });
});

r.delete('/locations/:id', requireOwner, (req, res) => {
  const count = db.prepare('SELECT COUNT(*) c FROM locations WHERE active = 1').get().c;
  if (count <= 1) return res.status(400).json({ error: 'You need at least one location' });
  db.prepare('UPDATE locations SET active = 0 WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ============ users (owner) ============
r.get('/users', requireOwner, (req, res) => {
  const users = db.prepare('SELECT id, email, name, role FROM users ORDER BY role, name').all();
  for (const u of users) {
    u.locationIds = u.role === 'owner' ? null :
      db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(u.id).map(x => x.location_id);
  }
  res.json(users);
});

r.post('/users', requireOwner, (req, res) => {
  const { email, name, password, locationIds } = req.body;
  if (!email || !password || password.length < 8)
    return res.status(400).json({ error: 'Email and a password of at least 8 characters are required' });
  if (!Array.isArray(locationIds) || locationIds.length === 0)
    return res.status(400).json({ error: 'Assign at least one location' });
  try {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)')
      .run(email.trim().toLowerCase(), name || 'Manager', bcrypt.hashSync(password, 10), 'manager');
    const ins = db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?,?)');
    locationIds.forEach(id => ins.run(Number(lastInsertRowid), Number(id)));
    res.json({ id: Number(lastInsertRowid) });
  } catch (e) {
    res.status(400).json({ error: 'That email is already in use' });
  }
});

r.put('/users/:id', requireOwner, (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  const { name, password, locationIds } = req.body;
  if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), id);
  }
  if (Array.isArray(locationIds) && target.role === 'manager') {
    db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(id);
    const ins = db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?,?)');
    locationIds.forEach(lid => ins.run(id, Number(lid)));
  }
  res.json({ ok: true });
});

r.delete('/users/:id', requireOwner, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ============ categories ============
const CAT_TABLES = {
  revenue: 'revenue_categories',
  variable: 'variable_cost_categories',
  recurring: 'recurring_cost_categories',
  accounts: 'accounts'
};

r.get('/categories', checkLocation, (req, res) => {
  const out = {};
  for (const [group, table] of Object.entries(CAT_TABLES)) {
    out[group] = db.prepare(
      `SELECT * FROM ${table} WHERE location_id = ? AND active = 1 ORDER BY position, id`)
      .all(req.locationId);
  }
  res.json(out);
});

r.post('/categories/:group', requireOwner, checkLocation, (req, res) => {
  const table = CAT_TABLES[req.params.group];
  if (!table) return res.status(400).json({ error: 'Unknown group' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const pos = db.prepare(`SELECT COALESCE(MAX(position),0)+1 p FROM ${table} WHERE location_id = ?`).get(req.locationId).p;
  let result;
  if (req.params.group === 'variable') {
    const mode = req.body.entry_mode === 'percent' ? 'percent' : 'fixed';
    result = db.prepare(
      `INSERT INTO variable_cost_categories (location_id, name, entry_mode, default_percent, default_invoiced, benchmark_tag, position)
       VALUES (?,?,?,?,?,?,?)`)
      .run(req.locationId, name, mode,
        mode === 'percent' ? num(req.body.default_percent) : null,
        bool01(req.body.default_invoiced),
        ['food', 'labor'].includes(req.body.benchmark_tag) ? req.body.benchmark_tag : null, pos);
  } else if (req.params.group === 'recurring') {
    result = db.prepare(
      `INSERT INTO recurring_cost_categories (location_id, name, benchmark_tag, position) VALUES (?,?,?,?)`)
      .run(req.locationId, name,
        ['labor', 'occupancy'].includes(req.body.benchmark_tag) ? req.body.benchmark_tag : null, pos);
  } else if (req.params.group === 'accounts') {
    result = db.prepare(
      `INSERT INTO accounts (location_id, name, opening_balance, position) VALUES (?,?,?,?)`)
      .run(req.locationId, name, num(req.body.opening_balance), pos);
  } else {
    result = db.prepare(
      `INSERT INTO revenue_categories (location_id, name, commission_percent, commission_invoiced, position) VALUES (?,?,?,?,?)`)
      .run(req.locationId, name, num(req.body.commission_percent),
        req.body.commission_invoiced !== undefined ? bool01(req.body.commission_invoiced) : 1, pos);
  }
  res.json({ id: Number(result.lastInsertRowid) });
});

r.put('/categories/:group/:id', requireOwner, checkLocation, (req, res) => {
  const table = CAT_TABLES[req.params.group];
  if (!table) return res.status(400).json({ error: 'Unknown group' });
  const id = Number(req.params.id);
  const cat = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND location_id = ?`).get(id, req.locationId);
  if (!cat) return res.status(404).json({ error: 'Not found' });
  const name = req.body.name !== undefined ? (req.body.name || '').trim() : cat.name;
  if (req.params.group === 'variable') {
    const mode = req.body.entry_mode !== undefined
      ? (req.body.entry_mode === 'percent' ? 'percent' : 'fixed') : cat.entry_mode;
    db.prepare(
      `UPDATE variable_cost_categories SET name=?, entry_mode=?, default_percent=?, default_invoiced=?, benchmark_tag=? WHERE id=?`)
      .run(name, mode,
        mode === 'percent'
          ? (req.body.default_percent !== undefined ? num(req.body.default_percent) : cat.default_percent)
          : null,
        req.body.default_invoiced !== undefined ? bool01(req.body.default_invoiced) : cat.default_invoiced,
        req.body.benchmark_tag !== undefined
          ? (['food', 'labor'].includes(req.body.benchmark_tag) ? req.body.benchmark_tag : null)
          : cat.benchmark_tag,
        id);
  } else if (req.params.group === 'recurring') {
    db.prepare(`UPDATE recurring_cost_categories SET name=?, benchmark_tag=? WHERE id=?`)
      .run(name,
        req.body.benchmark_tag !== undefined
          ? (['labor', 'occupancy'].includes(req.body.benchmark_tag) ? req.body.benchmark_tag : null)
          : cat.benchmark_tag,
        id);
  } else if (req.params.group === 'accounts') {
    db.prepare(`UPDATE accounts SET name=?, opening_balance=? WHERE id=?`)
      .run(name,
        req.body.opening_balance !== undefined ? num(req.body.opening_balance) : cat.opening_balance,
        id);
  } else {
    db.prepare(`UPDATE revenue_categories SET name=?, commission_percent=?, commission_invoiced=? WHERE id=?`)
      .run(name,
        req.body.commission_percent !== undefined ? num(req.body.commission_percent) : cat.commission_percent,
        req.body.commission_invoiced !== undefined ? bool01(req.body.commission_invoiced) : cat.commission_invoiced,
        id);
  }
  res.json({ ok: true });
});

r.delete('/categories/:group/:id', requireOwner, checkLocation, (req, res) => {
  const table = CAT_TABLES[req.params.group];
  if (!table) return res.status(400).json({ error: 'Unknown group' });
  const id = Number(req.params.id);
  const refs = {
    revenue: 'SELECT COUNT(*) c FROM revenue_items WHERE category_id = ?',
    variable: 'SELECT COUNT(*) c FROM variable_costs WHERE category_id = ?',
    recurring: 'SELECT COUNT(*) c FROM recurring_costs WHERE category_id = ?',
    accounts: `SELECT (SELECT COUNT(*) FROM revenue_account_items WHERE account_id = ?1) +
      (SELECT COUNT(*) FROM variable_costs WHERE account_id = ?1) +
      (SELECT COUNT(*) FROM oneoff_costs WHERE account_id = ?1) +
      (SELECT COUNT(*) FROM recurring_costs WHERE account_id = ?1) +
      (SELECT COUNT(*) FROM transfers WHERE from_account_id = ?1 OR to_account_id = ?1) c`
  };
  const used = db.prepare(refs[req.params.group]).get(id).c > 0;
  if (used) db.prepare(`UPDATE ${table} SET active = 0 WHERE id = ? AND location_id = ?`).run(id, req.locationId);
  else db.prepare(`DELETE FROM ${table} WHERE id = ? AND location_id = ?`).run(id, req.locationId);
  res.json({ ok: true, archived: used });
});

// ============ revenue ============
r.get('/revenue', checkLocation, (req, res) => {
  const { date } = req.query;
  if (badDate(date)) return res.status(400).json({ error: 'Invalid date' });
  const entry = db.prepare('SELECT * FROM revenue_entries WHERE location_id = ? AND date = ?').get(req.locationId, date);
  const items = entry
    ? db.prepare('SELECT category_id, amount, commission_amount, commission_invoiced FROM revenue_items WHERE entry_id = ?').all(entry.id) : [];
  const accountItems = entry
    ? db.prepare('SELECT account_id, amount FROM revenue_account_items WHERE entry_id = ?').all(entry.id) : [];
  res.json({ entry: entry || null, items, accountItems });
});

// Upsert a day's revenue (with optional category breakdown).
r.put('/revenue', checkLocation, (req, res) => {
  const { date, total, items, note, accounts } = req.body;
  if (badDate(date)) return res.status(400).json({ error: 'Invalid date' });
  const breakdown = Array.isArray(items) ? items.filter(i => num(i.amount) !== 0) : [];
  const finalTotal = breakdown.length ? breakdown.reduce((s, i) => s + num(i.amount), 0) : num(total);
  if (finalTotal < 0) return res.status(400).json({ error: 'Revenue cannot be negative' });

  const existing = db.prepare('SELECT id FROM revenue_entries WHERE location_id = ? AND date = ?').get(req.locationId, date);
  let entryId;
  if (existing) {
    entryId = existing.id;
    db.prepare('UPDATE revenue_entries SET total = ?, note = ? WHERE id = ?').run(finalTotal, note || null, entryId);
    db.prepare('DELETE FROM revenue_items WHERE entry_id = ?').run(entryId);
    db.prepare('DELETE FROM revenue_account_items WHERE entry_id = ?').run(entryId);
  } else {
    entryId = Number(db.prepare(
      'INSERT INTO revenue_entries (location_id, date, total, note) VALUES (?,?,?,?)')
      .run(req.locationId, date, finalTotal, note || null).lastInsertRowid);
  }
  // Compute each channel's commission from its category settings and store it.
  const cats = db.prepare('SELECT id, commission_percent, commission_invoiced FROM revenue_categories WHERE location_id = ?')
    .all(req.locationId);
  const catById = Object.fromEntries(cats.map(c => [c.id, c]));
  const ins = db.prepare(
    'INSERT INTO revenue_items (entry_id, category_id, amount, commission_amount, commission_invoiced) VALUES (?,?,?,?,?)');
  let commissions = 0;
  breakdown.forEach(i => {
    const cat = catById[Number(i.category_id)];
    const commission = cat && cat.commission_percent ? num(i.amount) * cat.commission_percent / 100 : 0;
    commissions += commission;
    ins.run(entryId, Number(i.category_id), num(i.amount), commission, cat ? cat.commission_invoiced : 0);
  });
  // Optional split across money accounts (independent of the channel breakdown).
  if (Array.isArray(accounts)) {
    const valid = new Set(db.prepare('SELECT id FROM accounts WHERE location_id = ?')
      .all(req.locationId).map(a => a.id));
    const insAcc = db.prepare(
      'INSERT INTO revenue_account_items (entry_id, account_id, amount) VALUES (?,?,?)');
    accounts.filter(a => valid.has(Number(a.account_id)) && num(a.amount) !== 0)
      .forEach(a => insAcc.run(entryId, Number(a.account_id), num(a.amount)));
  }
  res.json({ ok: true, total: finalTotal, commissions });
});

r.delete('/revenue', checkLocation, (req, res) => {
  if (badDate(req.query.date)) return res.status(400).json({ error: 'Invalid date' });
  db.prepare('DELETE FROM revenue_entries WHERE location_id = ? AND date = ?').run(req.locationId, req.query.date);
  res.json({ ok: true });
});

// ============ variable costs (day view) ============
r.get('/costs/day', checkLocation, (req, res) => {
  const { date } = req.query;
  if (badDate(date)) return res.status(400).json({ error: 'Invalid date' });
  const revenue = db.prepare('SELECT total FROM revenue_entries WHERE location_id = ? AND date = ?').get(req.locationId, date);
  const categories = db.prepare(
    `SELECT * FROM variable_cost_categories WHERE location_id = ? AND active = 1 ORDER BY position, id`)
    .all(req.locationId);
  const existing = db.prepare(
    `SELECT category_id, amount, invoiced, account_id FROM variable_costs WHERE location_id = ? AND date = ?`)
    .all(req.locationId, date);
  const accounts = db.prepare(
    'SELECT id, name FROM accounts WHERE location_id = ? AND active = 1 ORDER BY position, id').all(req.locationId);
  res.json({ dayRevenue: revenue ? revenue.total : null, categories, existing, accounts });
});

// Bulk upsert one day's variable costs: rows = [{category_id, amount, invoiced}]
r.put('/costs/day', checkLocation, (req, res) => {
  const { date, rows } = req.body;
  if (badDate(date) || !Array.isArray(rows)) return res.status(400).json({ error: 'Invalid request' });
  const del = db.prepare('DELETE FROM variable_costs WHERE location_id = ? AND date = ? AND category_id = ?');
  const up = db.prepare(
    `INSERT INTO variable_costs (location_id, date, category_id, amount, invoiced, account_id) VALUES (?,?,?,?,?,?)
     ON CONFLICT (location_id, date, category_id) DO UPDATE
       SET amount = excluded.amount, invoiced = excluded.invoiced, account_id = excluded.account_id`);
  for (const row of rows) {
    const amt = num(row.amount);
    if (amt === 0) del.run(req.locationId, date, Number(row.category_id));
    else up.run(req.locationId, date, Number(row.category_id), amt, bool01(row.invoiced),
      row.account_id ? Number(row.account_id) : null);
  }
  res.json({ ok: true });
});

// ============ recurring costs ============
r.get('/recurring', checkLocation, (req, res) => {
  const items = db.prepare(
    `SELECT rc.*, c.name AS category_name FROM recurring_costs rc
     JOIN recurring_cost_categories c ON c.id = rc.category_id
     WHERE rc.location_id = ? AND rc.active = 1 ORDER BY c.position, rc.description`)
    .all(req.locationId);
  items.forEach(it => { it.daily = calc.dailyRate(it); });
  res.json(items);
});

r.post('/recurring', requireOwner, checkLocation, (req, res) => {
  const { category_id, description, amount, frequency, invoiced, start_date, account_id } = req.body;
  if (!category_id || !description || num(amount) <= 0 || !['weekly', 'biweekly', 'monthly'].includes(frequency))
    return res.status(400).json({ error: 'Category, description, amount and frequency are required' });
  const start = !badDate(start_date) ? start_date : new Date().toISOString().slice(0, 10);
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO recurring_costs (location_id, category_id, description, amount, frequency, invoiced, start_date, account_id)
     VALUES (?,?,?,?,?,?,?,?)`)
    .run(req.locationId, Number(category_id), description.trim(), num(amount), frequency, bool01(invoiced), start,
      account_id ? Number(account_id) : null);
  res.json({ id: Number(lastInsertRowid) });
});

r.put('/recurring/:id', requireOwner, checkLocation, (req, res) => {
  const it = db.prepare('SELECT * FROM recurring_costs WHERE id = ? AND location_id = ?')
    .get(Number(req.params.id), req.locationId);
  if (!it) return res.status(404).json({ error: 'Not found' });
  const b = req.body;
  db.prepare(
    `UPDATE recurring_costs SET category_id=?, description=?, amount=?, frequency=?, invoiced=?, start_date=?, end_date=?, account_id=? WHERE id=?`)
    .run(
      b.category_id !== undefined ? Number(b.category_id) : it.category_id,
      b.description !== undefined ? String(b.description).trim() : it.description,
      b.amount !== undefined ? num(b.amount) : it.amount,
      ['weekly', 'biweekly', 'monthly'].includes(b.frequency) ? b.frequency : it.frequency,
      b.invoiced !== undefined ? bool01(b.invoiced) : it.invoiced,
      !badDate(b.start_date) ? b.start_date : it.start_date,
      b.end_date === null ? null : (!badDate(b.end_date) ? b.end_date : it.end_date),
      b.account_id !== undefined ? (b.account_id ? Number(b.account_id) : null) : it.account_id,
      it.id);
  res.json({ ok: true });
});

r.delete('/recurring/:id', requireOwner, checkLocation, (req, res) => {
  // "Delete" = end it today so history stays correct; if it never overlapped any data period it's removed outright.
  const it = db.prepare('SELECT * FROM recurring_costs WHERE id = ? AND location_id = ?')
    .get(Number(req.params.id), req.locationId);
  if (!it) return res.status(404).json({ error: 'Not found' });
  const today = new Date().toISOString().slice(0, 10);
  if (it.start_date >= today) db.prepare('DELETE FROM recurring_costs WHERE id = ?').run(it.id);
  else db.prepare('UPDATE recurring_costs SET end_date = ? WHERE id = ?').run(calc.addDays(today, -1), it.id);
  res.json({ ok: true });
});

// ============ one-off costs ============
r.get('/oneoff', checkLocation, (req, res) => {
  const { start, end } = req.query;
  if (badDate(start) || badDate(end)) return res.status(400).json({ error: 'Invalid range' });
  res.json(db.prepare(
    `SELECT * FROM oneoff_costs WHERE location_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC, id DESC`)
    .all(req.locationId, start, end));
});

r.post('/oneoff', checkLocation, (req, res) => {
  const { date, description, amount, invoiced, account_id } = req.body;
  if (badDate(date) || !description || num(amount) <= 0)
    return res.status(400).json({ error: 'Date, description and amount are required' });
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO oneoff_costs (location_id, date, description, amount, invoiced, account_id) VALUES (?,?,?,?,?,?)')
    .run(req.locationId, date, description.trim(), num(amount), bool01(invoiced),
      account_id ? Number(account_id) : null);
  res.json({ id: Number(lastInsertRowid) });
});

r.delete('/oneoff/:id', checkLocation, (req, res) => {
  db.prepare('DELETE FROM oneoff_costs WHERE id = ? AND location_id = ?')
    .run(Number(req.params.id), req.locationId);
  res.json({ ok: true });
});

// ============ dashboard ============
r.get('/dashboard', checkLocation, (req, res) => {
  const granularity = ['day', 'week', 'month'].includes(req.query.granularity) ? req.query.granularity : 'day';
  const anchor = !badDate(req.query.date) ? req.query.date : new Date().toISOString().slice(0, 10);

  const bounds = calc.periodBounds(granularity, anchor);
  const start = bounds.start;
  // For a period still in progress, only count costs accrued up to the anchor date
  // (otherwise a month view on the 5th would already carry the whole month's rent).
  const end = bounds.end > anchor && start <= anchor ? anchor : bounds.end;
  const current = calc.summary(req.locationId, start, end);
  current.periodEnd = bounds.end; // full period, for labels
  const be = calc.breakEven(req.locationId, start, end, current);

  // Compare like with like: if the current period is only partly elapsed,
  // clamp the previous period to the same number of days.
  const prevAnchor = calc.prevPeriodAnchor(granularity, anchor);
  const prevBounds = calc.periodBounds(granularity, prevAnchor);
  let prevEnd = prevBounds.end;
  if (end < bounds.end) {
    const elapsed = Math.round((Date.parse(end) - Date.parse(start)) / 864e5);
    const clamped = calc.addDays(prevBounds.start, elapsed);
    if (clamped < prevEnd) prevEnd = clamped;
  }
  const previous = calc.summary(req.locationId, prevBounds.start, prevEnd);

  res.json({
    granularity, anchor,
    current, previous,
    breakEven: be,
    benchmarks: calc.benchmarks(current),
    trend: calc.trend(req.locationId, end > anchor ? anchor : end, 30)
  });
});

// ============ money accounts ============
r.get('/accounts-view', checkLocation, (req, res) => {
  const granularity = ['day', 'week', 'month'].includes(req.query.granularity) ? req.query.granularity : 'day';
  const anchor = !badDate(req.query.date) ? req.query.date : new Date().toISOString().slice(0, 10);
  const bounds = calc.periodBounds(granularity, anchor);
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

r.delete('/transfers/:id', checkLocation, (req, res) => {
  db.prepare('DELETE FROM transfers WHERE id = ? AND location_id = ?')
    .run(Number(req.params.id), req.locationId);
  res.json({ ok: true });
});

// ============ employees ============
r.get('/employees', checkLocation, (req, res) => {
  res.json(db.prepare(
    'SELECT * FROM employees WHERE location_id = ? AND active = 1 ORDER BY name').all(req.locationId));
});

r.post('/employees', checkLocation, (req, res) => {
  const { name, position, pay_type, rate } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO employees (location_id, name, position, pay_type, rate) VALUES (?,?,?,?,?)')
    .run(req.locationId, String(name).trim(), (position || '').trim() || null,
      pay_type === 'salary' ? 'salary' : 'hourly', num(rate));
  res.json({ id: Number(lastInsertRowid) });
});

r.put('/employees/:id', checkLocation, (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND location_id = ?')
    .get(Number(req.params.id), req.locationId);
  if (!emp) return res.status(404).json({ error: 'Not found' });
  const b = req.body;
  db.prepare('UPDATE employees SET name=?, position=?, pay_type=?, rate=? WHERE id=?')
    .run(b.name !== undefined ? String(b.name).trim() : emp.name,
      b.position !== undefined ? ((b.position || '').trim() || null) : emp.position,
      b.pay_type !== undefined ? (b.pay_type === 'salary' ? 'salary' : 'hourly') : emp.pay_type,
      b.rate !== undefined ? num(b.rate) : emp.rate, emp.id);
  res.json({ ok: true });
});

r.delete('/employees/:id', checkLocation, (req, res) => {
  // Keep shift history: archive if they have shifts, delete outright otherwise.
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) c FROM shifts WHERE employee_id = ?').get(id).c > 0;
  if (used) db.prepare('UPDATE employees SET active = 0 WHERE id = ? AND location_id = ?').run(id, req.locationId);
  else db.prepare('DELETE FROM employees WHERE id = ? AND location_id = ?').run(id, req.locationId);
  res.json({ ok: true, archived: used });
});

// ============ weekly schedule ============
const mondayOf = d => {
  const dt = new Date(d + 'T12:00:00Z');
  const dow = dt.getUTCDay();
  return calc.addDays(d, -((dow + 6) % 7));
};
const shiftHours = s => ((s.end_min <= s.start_min ? s.end_min + 1440 : s.end_min) - s.start_min) / 60;

function scheduleData(locationId, weekMonday) {
  const days = Array.from({ length: 7 }, (_, i) => calc.addDays(weekMonday, i));
  const sunday = days[6];
  const employees = db.prepare(
    'SELECT * FROM employees WHERE location_id = ? AND active = 1 ORDER BY name').all(locationId);
  const shifts = db.prepare(
    'SELECT * FROM shifts WHERE location_id = ? AND date BETWEEN ? AND ?').all(locationId, weekMonday, sunday);

  const perEmployee = employees.map(e => {
    const own = shifts.filter(s => s.employee_id === e.id);
    const hours = own.reduce((sum, s) => sum + shiftHours(s), 0);
    const cost = e.pay_type === 'salary' ? e.rate : hours * e.rate;
    return { employee_id: e.id, hours, cost, overtime: hours > 48 };
  });
  const totalCost = perEmployee.reduce((s, x) => s + x.cost, 0);
  const totalHours = perEmployee.reduce((s, x) => s + x.hours, 0);

  // Budgeted payroll = recurring costs in labor-tagged categories, for this week.
  const budget = calc.recurringForRange(locationId, weekMonday, sunday).byTag.labor || 0;
  let budgetFlag = 'na';
  if (budget > 0) {
    const dev = (totalCost - budget) / budget;
    budgetFlag = dev > 0.10 ? 'over' : dev < -0.10 ? 'under' : 'ok';
  }
  return { week: weekMonday, days, employees, shifts, perEmployee,
           totals: { hours: totalHours, cost: totalCost },
           budget: { amount: budget, flag: budgetFlag } };
}

r.get('/schedule', checkLocation, (req, res) => {
  const anchor = !badDate(req.query.week) ? req.query.week : new Date().toISOString().slice(0, 10);
  res.json(scheduleData(req.locationId, mondayOf(anchor)));
});

// Upsert one cell. start/end as minutes from midnight; equal times = clear the cell.
r.put('/schedule/shift', checkLocation, (req, res) => {
  const { employee_id, date, start_min, end_min } = req.body;
  if (badDate(date)) return res.status(400).json({ error: 'Invalid date' });
  const emp = db.prepare('SELECT id FROM employees WHERE id = ? AND location_id = ?')
    .get(Number(employee_id), req.locationId);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  const s = Math.max(0, Math.min(1439, num(start_min))), e = Math.max(0, Math.min(1439, num(end_min)));
  if (s === e) {
    db.prepare('DELETE FROM shifts WHERE employee_id = ? AND date = ?').run(emp.id, date);
  } else {
    db.prepare(
      `INSERT INTO shifts (location_id, employee_id, date, start_min, end_min) VALUES (?,?,?,?,?)
       ON CONFLICT (employee_id, date) DO UPDATE SET start_min = excluded.start_min, end_min = excluded.end_min`)
      .run(req.locationId, emp.id, date, s, e);
  }
  res.json({ ok: true });
});

r.delete('/schedule/shift', checkLocation, (req, res) => {
  const { employee_id, date } = req.query;
  if (badDate(date)) return res.status(400).json({ error: 'Invalid date' });
  db.prepare(`DELETE FROM shifts WHERE employee_id = ? AND date = ? AND location_id = ?`)
    .run(Number(employee_id), date, req.locationId);
  res.json({ ok: true });
});

// Replace the target week with a copy of the previous week's shifts.
r.post('/schedule/copy-last-week', checkLocation, (req, res) => {
  const week = mondayOf(!badDate(req.body.week) ? req.body.week : new Date().toISOString().slice(0, 10));
  const prevWeek = calc.addDays(week, -7);
  const prev = db.prepare(
    'SELECT s.* FROM shifts s JOIN employees e ON e.id = s.employee_id AND e.active = 1 ' +
    'WHERE s.location_id = ? AND s.date BETWEEN ? AND ?')
    .all(req.locationId, prevWeek, calc.addDays(prevWeek, 6));
  if (!prev.length) return res.status(400).json({ error: 'Last week has no schedule to copy' });
  db.prepare('DELETE FROM shifts WHERE location_id = ? AND date BETWEEN ? AND ?')
    .run(req.locationId, week, calc.addDays(week, 6));
  const ins = db.prepare(
    'INSERT INTO shifts (location_id, employee_id, date, start_min, end_min) VALUES (?,?,?,?,?)');
  prev.forEach(s => ins.run(req.locationId, s.employee_id, calc.addDays(s.date, 7), s.start_min, s.end_min));
  res.json({ ok: true, copied: prev.length });
});

// ============ CSV import ============
// Rows are parsed client-side. type: 'revenue' -> [{date,total}] or [{date,category,amount}]
//                                type: 'costs'  -> [{date,category,amount,invoiced,description?}]
r.post('/import', requireOwner, checkLocation, (req, res) => {
  const { type, rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'No rows to import' });
  if (rows.length > 5000) return res.status(400).json({ error: 'Too many rows (max 5000 per import)' });
  let imported = 0; const errors = [];

  if (type === 'revenue') {
    const hasCategories = rows.some(x => x.category);
    if (hasCategories) {
      const cats = db.prepare(
        'SELECT id, name, commission_percent, commission_invoiced FROM revenue_categories WHERE location_id = ?').all(req.locationId);
      const byName = Object.fromEntries(cats.map(c => [c.name.toLowerCase(), c]));
      const byDate = {};
      rows.forEach((row, i) => {
        if (badDate(row.date)) return errors.push(`Row ${i + 1}: bad date "${row.date}"`);
        const cat = byName[String(row.category || '').toLowerCase().trim()];
        if (!cat) return errors.push(`Row ${i + 1}: unknown revenue category "${row.category}"`);
        const amount = num(row.amount);
        (byDate[row.date] = byDate[row.date] || []).push({
          category_id: cat.id, amount,
          commission: cat.commission_percent ? amount * cat.commission_percent / 100 : 0,
          commission_invoiced: cat.commission_invoiced
        });
      });
      for (const [date, items] of Object.entries(byDate)) {
        const total = items.reduce((s, i) => s + i.amount, 0);
        const existing = db.prepare('SELECT id FROM revenue_entries WHERE location_id = ? AND date = ?').get(req.locationId, date);
        let eid;
        if (existing) {
          eid = existing.id;
          db.prepare('UPDATE revenue_entries SET total = ? WHERE id = ?').run(total, eid);
          db.prepare('DELETE FROM revenue_items WHERE entry_id = ?').run(eid);
        } else {
          eid = Number(db.prepare('INSERT INTO revenue_entries (location_id, date, total) VALUES (?,?,?)')
            .run(req.locationId, date, total).lastInsertRowid);
        }
        const ins = db.prepare(
          'INSERT INTO revenue_items (entry_id, category_id, amount, commission_amount, commission_invoiced) VALUES (?,?,?,?,?)');
        items.forEach(i => ins.run(eid, i.category_id, i.amount, i.commission, i.commission_invoiced));
        imported++;
      }
    } else {
      const up = db.prepare(
        `INSERT INTO revenue_entries (location_id, date, total) VALUES (?,?,?)
         ON CONFLICT (location_id, date) DO UPDATE SET total = excluded.total`);
      rows.forEach((row, i) => {
        if (badDate(row.date)) return errors.push(`Row ${i + 1}: bad date "${row.date}"`);
        up.run(req.locationId, row.date, num(row.total ?? row.amount));
        imported++;
      });
    }
  } else if (type === 'costs') {
    const cats = db.prepare('SELECT id, name, default_invoiced FROM variable_cost_categories WHERE location_id = ?').all(req.locationId);
    const byName = Object.fromEntries(cats.map(c => [c.name.toLowerCase(), c]));
    const up = db.prepare(
      `INSERT INTO variable_costs (location_id, date, category_id, amount, invoiced) VALUES (?,?,?,?,?)
       ON CONFLICT (location_id, date, category_id) DO UPDATE SET amount = excluded.amount, invoiced = excluded.invoiced`);
    const insOne = db.prepare(
      'INSERT INTO oneoff_costs (location_id, date, description, amount, invoiced) VALUES (?,?,?,?,?)');
    rows.forEach((row, i) => {
      if (badDate(row.date)) return errors.push(`Row ${i + 1}: bad date "${row.date}"`);
      const cat = byName[String(row.category || '').toLowerCase().trim()];
      const inv = row.invoiced !== undefined && row.invoiced !== '' ? bool01(row.invoiced) : (cat ? cat.default_invoiced : 0);
      if (cat) { up.run(req.locationId, row.date, cat.id, num(row.amount), inv); imported++; }
      else if (row.description || row.category) {
        insOne.run(req.locationId, row.date, row.description || row.category, num(row.amount), inv);
        imported++;
      } else errors.push(`Row ${i + 1}: no category or description`);
    });
  } else {
    return res.status(400).json({ error: 'Unknown import type' });
  }
  res.json({ imported, errors: errors.slice(0, 20), totalErrors: errors.length });
});

module.exports = r;
