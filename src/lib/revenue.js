// Shared day-revenue upsert used by the manual log flow, CSV import,
// and the POS webhook — one code path for commissions and account splits.
const { db } = require('../db');
const { num } = require('./parse');

// items: [{category_id, amount}] · accounts: [{account_id, amount}]
function upsertDayRevenue(locationId, date, { total, items = [], accounts = [], note = null }) {
  const breakdown = items.filter(i => num(i.amount) !== 0);
  const finalTotal = breakdown.length
    ? breakdown.reduce((s, i) => s + num(i.amount), 0)
    : num(total);
  if (finalTotal < 0) throw new Error('Revenue cannot be negative');

  const existing = db.prepare('SELECT id FROM revenue_entries WHERE location_id = ? AND date = ?')
    .get(locationId, date);
  let entryId;
  if (existing) {
    entryId = existing.id;
    db.prepare('UPDATE revenue_entries SET total = ?, note = ? WHERE id = ?').run(finalTotal, note, entryId);
    db.prepare('DELETE FROM revenue_items WHERE entry_id = ?').run(entryId);
    db.prepare('DELETE FROM revenue_account_items WHERE entry_id = ?').run(entryId);
  } else {
    entryId = Number(db.prepare(
      'INSERT INTO revenue_entries (location_id, date, total, note) VALUES (?,?,?,?)')
      .run(locationId, date, finalTotal, note).lastInsertRowid);
  }

  const catById = Object.fromEntries(db.prepare(
    'SELECT id, commission_percent, commission_invoiced FROM revenue_categories WHERE location_id = ?')
    .all(locationId).map(c => [c.id, c]));
  const ins = db.prepare(
    'INSERT INTO revenue_items (entry_id, category_id, amount, commission_amount, commission_invoiced) VALUES (?,?,?,?,?)');
  let commissions = 0;
  for (const i of breakdown) {
    const cat = catById[Number(i.category_id)];
    const commission = cat && cat.commission_percent ? num(i.amount) * cat.commission_percent / 100 : 0;
    commissions += commission;
    ins.run(entryId, Number(i.category_id), num(i.amount), commission, cat ? cat.commission_invoiced : 0);
  }

  if (accounts.length) {
    const valid = new Set(db.prepare('SELECT id FROM accounts WHERE location_id = ?')
      .all(locationId).map(a => a.id));
    const insAcc = db.prepare(
      'INSERT INTO revenue_account_items (entry_id, account_id, amount) VALUES (?,?,?)');
    accounts.filter(a => valid.has(Number(a.account_id)) && num(a.amount) !== 0)
      .forEach(a => insAcc.run(entryId, Number(a.account_id), num(a.amount)));
  }
  return { total: finalTotal, commissions };
}

module.exports = { upsertDayRevenue };
