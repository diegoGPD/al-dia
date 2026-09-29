#!/usr/bin/env node
// Recompute every stored order's location from the PideDirecto restaurant id
// saved with it. Nothing is deleted, no amount/date/channel is touched — only
// location_id, and only when the restaurant id says so.
//
//   node scripts/fix-order-locations.js               # DRY RUN (default)
//   node scripts/fix-order-locations.js --apply       # actually move them
//   node scripts/fix-order-locations.js --fetch-ids   # ask PideDirecto for the
//                                                     # restaurant id of orders
//                                                     # stored before we kept it
// Orders with no restaurant id stored are left exactly as they are.
const pd = require('../src/integrations/pidedirecto');
const { db } = require('../src/db');

const apply = process.argv.includes('--apply');
const fetchIds = process.argv.includes('--fetch-ids');
const mx = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

main().catch(e => { console.error(e); process.exit(1); });
async function main() {

// Recover restaurant ids first — the repair can only judge orders that have one.
const ev = pd.backfillStoreIdsFromEvents();
console.log(`\nRestaurant ids recovered from stored webhook deliveries: ${ev.filled} (${ev.withStoreId} of ${ev.events} deliveries carried one).`);
if (fetchIds) {
  const f = await pd.fetchMissingStoreIds(2000);
  console.log(f.skipped ? `Skipped API lookup: ${f.reason}`
    : `Asked PideDirecto for ${f.tried} orders: ${f.filled} ids recovered, ${f.failed} failed, ${f.stillMissing} still without an id.`);
}

const r = pd.repairOrderLocations({ dryRun: !apply });

console.log(`\n${apply ? 'APPLIED' : 'DRY RUN — nothing was changed'}`);
console.log(`Scanned ${r.scanned} orders.\n`);

console.log('Locations and their PideDirecto restaurant ids:');
for (const l of r.locations) console.log(`  ${l.name.padEnd(20)} ${l.storeId || '(none configured)'}`);

if (!r.moves.length) {
  console.log('\nNothing to move — every order already sits where its restaurant id points.');
} else {
  console.log(`\n${apply ? 'Moved' : 'Would move'} ${apply ? r.applied : r.wouldChange} orders:\n`);
  for (const m of r.moves) {
    console.log(`  ${m.from} → ${m.to}`);
    console.log(`     ${m.count} orders · ${m.firstDate} → ${m.lastDate} · ${mx(m.sales)} in completed sales`);
  }
}
if (r.toUnassigned) {
  console.log(`\n⚠ STOP AND READ: ${r.toUnassigned} orders (${mx(r.toUnassignedSales)} in sales) would leave their current location and become UNASSIGNED,`);
  console.log('  because the restaurant id they carry is not set on any location. That would LOWER that location\'s reported sales.');
  console.log('  Restaurant ids seen on orders but not configured anywhere:');
  for (const s of r.unknownStoreIds) console.log(`     ${s}`);
  console.log('  Set each of those on the right location (Settings → POS webhook → PideDirecto → Restaurant ID), then re-run this.');
}
if (r.noStoreId) {
  console.log(`\n${r.noStoreId} orders have no restaurant id stored — left untouched (never guessed).`);
  if (!fetchIds) console.log('   Re-run with --fetch-ids to ask PideDirecto for their restaurant ids first.');
}
if (r.skippedDays?.length) {
  console.log(`\n⚠ ${r.skippedDays.length} day(s) kept their manual revenue instead of being rebuilt:`);
  for (const d of r.skippedDays) console.log(`   ${d.location} ${d.date} — ${d.reason}`);
}

if (!apply) {
  const sample = (r.changes || []).slice(0, 20);
  if (sample.length) {
    console.log('\nFirst orders that would move:');
    for (const c of sample) console.log(`  ${c.order_id}  ${c.date}  ${mx(c.amount)}  ${c.old_location} → ${c.new_location}`);
    if (r.changes.length > sample.length) console.log(`  … and ${r.changes.length - sample.length} more`);
  }
  console.log('\nRe-run with --apply to make these changes. Every move is written to pd_order_location_fixes.');
} else {
  console.log(`\n${r.daysRebuilt} day(s) recalculated. Audit log:`);
  for (const row of db.prepare(
    `SELECT order_id, order_date, amount, old_location, new_location, changed_at
       FROM pd_order_location_fixes WHERE changed_at = ? ORDER BY order_date LIMIT 20`).all(r.changedAt)) {
    console.log(`  ${row.order_id}  ${row.order_date}  ${mx(row.amount)}  ${row.old_location} → ${row.new_location}  @ ${row.changed_at}`);
  }
  console.log('  (full log in the pd_order_location_fixes table)');
}

}
