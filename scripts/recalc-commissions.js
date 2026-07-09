// Recompute all stored commissions using each channel's CURRENT rate.
// Run on the server (e.g. `railway ssh`):
//   node scripts/recalc-commissions.js            # all locations
//   node scripts/recalc-commissions.js 2          # just location id 2
const { db } = require('../src/db');

const locArg = process.argv[2] ? Number(process.argv[2]) : null;
const locations = db.prepare('SELECT id, name FROM locations' + (locArg ? ' WHERE id = ?' : ''))
  .all(...(locArg ? [locArg] : []));

for (const loc of locations) {
  const cats = Object.fromEntries(db.prepare(
    'SELECT id, commission_percent, commission_invoiced FROM revenue_categories WHERE location_id = ?')
    .all(loc.id).map(c => [c.id, c]));
  const items = db.prepare(
    `SELECT ri.id, ri.category_id, ri.amount, ri.commission_amount
     FROM revenue_items ri JOIN revenue_entries re ON re.id = ri.entry_id
     WHERE re.location_id = ?`).all(loc.id);
  const up = db.prepare('UPDATE revenue_items SET commission_amount = ?, commission_invoiced = ? WHERE id = ?');
  let before = 0, after = 0;
  for (const it of items) {
    const cat = cats[it.category_id];
    if (!cat) continue;
    const newComm = cat.commission_percent ? it.amount * cat.commission_percent / 100 : 0;
    before += it.commission_amount; after += newComm;
    up.run(newComm, cat.commission_invoiced, it.id);
  }
  console.log(`${loc.name}: ${items.length} items recalculated. Commissions ${before.toFixed(2)} -> ${after.toFixed(2)} (${(after - before >= 0 ? '+' : '')}${(after - before).toFixed(2)})`);
}
