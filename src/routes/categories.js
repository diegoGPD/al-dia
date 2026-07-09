// The four configurable groups: revenue channels, day-to-day cost categories,
// recurring cost categories, and money accounts.
const { db } = require('../db');
const { requireOwner, checkLocation } = require('../auth');
const { num, bool01 } = require('../lib/parse');

const CAT_TABLES = {
  revenue: 'revenue_categories',
  variable: 'variable_cost_categories',
  recurring: 'recurring_cost_categories',
  accounts: 'accounts'
};

module.exports = (r) => {
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
};
