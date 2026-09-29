// Order routing tests: an order's location comes from its PideDirecto
// restaurant id and nothing else. Run: node scripts/routing-tests.js
// Uses a throwaway database; no network calls (payloads carry full amounts, so
// the getOrder enrichment path never runs).
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/aldia-routing-tests';
process.env.TZ_OFFSET_HOURS = process.env.TZ_OFFSET_HOURS ?? '-6';
delete process.env.PIDEDIRECTO_API_KEY;
require('node:fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const { db, createLocation } = require('../src/db');
const pd = require('../src/integrations/pidedirecto');

let failures = 0;
function chk(label, expected, actual) {
  const ok = expected === actual;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}: ${label}${ok ? '' : `  (expected ${expected}, got ${actual})`}`);
  if (!ok) failures++;
}

const MTY_STORE = '77185c4a-1ccd-48e9-8f8a-fd15ac768c0d';
const TRC_STORE = 'bb992f10-7f4d-4e21-9c55-0f0aa1d93e77';

const mty = createLocation('Monterrey');
const trc = createLocation('Torreón');
db.prepare('UPDATE locations SET pd_store_id = ? WHERE id = ?').run(MTY_STORE, mty);
db.prepare('UPDATE locations SET pd_store_id = ? WHERE id = ?').run(TRC_STORE, trc);

const order = (id, storeId, amount = 250) => ({
  eventType: 'ORDER_COMPLETED',
  orderId: id, storeId,
  app: 'UBER_EATS', total: amount, orderStatus: 'COMPLETE',
  completedAt: '2026-09-20T18:00:00.000Z'
});
const locOf = id => db.prepare('SELECT location_id FROM pd_orders WHERE order_id = ?').get(id).location_id;

(async () => {
  console.log('== the restaurant id decides, not the webhook URL ==');
  // Every webhook arrives on ONE url (PideDirecto allows a single one), so the
  // token location below is deliberately the "wrong" one for half the orders.
  await pd.processWebhook(mty, order('o-mty-1', MTY_STORE));
  await pd.processWebhook(mty, order('o-trc-1', TRC_STORE));   // same url, other restaurant
  await pd.processWebhook(trc, order('o-mty-2', MTY_STORE));   // token says Torreón
  chk('Monterrey restaurant id -> Monterrey', mty, locOf('o-mty-1'));
  chk('Torreón restaurant id on Monterrey url -> Torreón', trc, locOf('o-trc-1'));
  chk('Monterrey restaurant id on Torreón url -> Monterrey', mty, locOf('o-mty-2'));

  console.log('== an unknown restaurant id is never guessed ==');
  const r = await pd.processWebhook(mty, order('o-unknown', 'ffffffff-0000-0000-0000-000000000000'));
  chk('reported as unassigned', 'unassigned', r.status);
  chk('stored with no location', null, locOf('o-unknown'));
  const noId = await pd.processWebhook(mty, order('o-no-store', null));
  chk('missing restaurant id -> unassigned', 'unassigned', noId.status);
  chk('admin list counts both', 2, pd.unassignedOrders().total);

  console.log('== revenue follows the routing ==');
  const rev = (loc) => db.prepare(
    `SELECT total FROM revenue_entries WHERE location_id = ? AND date = '2026-09-20'`).get(loc);
  chk('Monterrey booked 500 (2 orders)', 500, rev(mty)?.total);
  chk('Torreón booked 250 (1 order)', 250, rev(trc)?.total);

  console.log('== claiming a restaurant id adopts its parked orders ==');
  const stl = createLocation('Saltillo');
  const claim = pd.claimStore(stl, 'ffffffff-0000-0000-0000-000000000000');
  chk('one order moved', 1, claim.moved);
  chk('now belongs to Saltillo', stl, locOf('o-unknown'));
  chk('only the id-less order stays unassigned', 1, pd.unassignedOrders().total);
  chk('a restaurant id cannot be claimed twice', 0, pd.claimStore(stl, TRC_STORE).moved);
  chk('a configured location is not silently re-pointed', 0,
    pd.claimStore(mty, '11111111-2222-3333-4444-555555555555').moved);
  chk('and Monterrey kept its id', MTY_STORE,
    db.prepare('SELECT pd_store_id s FROM locations WHERE id = ?').get(mty).s);

  console.log('== repair: dry run reports, changes nothing ==');
  // Simulate the historical damage: Torreón's order filed under Monterrey.
  db.prepare(`UPDATE pd_orders SET location_id = ? WHERE store_id = ?`).run(mty, TRC_STORE);
  const dry = pd.repairOrderLocations();                 // dry run by default
  chk('dry run flag', true, dry.dryRun);
  chk('would move the Torreón order', 1, dry.wouldChange);
  chk('reports the direction', 'Monterrey → Torreón', dry.moves[0] && `${dry.moves[0].from} → ${dry.moves[0].to}`);
  chk('reports the sales involved', 250, dry.moves[0] && dry.moves[0].sales);
  chk('nothing actually moved', mty, locOf('o-trc-1'));
  chk('one order has no restaurant id to judge by', 1, dry.noStoreId);
  chk('audit log still empty', 0,
    db.prepare('SELECT COUNT(*) c FROM pd_order_location_fixes').get().c);

  console.log('== repair: applying moves them and logs every change ==');
  const applied = pd.repairOrderLocations({ dryRun: false });
  chk('applied count', 1, applied.applied);
  chk('o-trc-1 back in Torreón', trc, locOf('o-trc-1'));
  chk('every change logged', 1,
    db.prepare('SELECT COUNT(*) c FROM pd_order_location_fixes').get().c);
  const logged = db.prepare(
    `SELECT * FROM pd_order_location_fixes WHERE order_id = 'o-trc-1'`).get();
  chk('log names the old location', 'Monterrey', logged.old_location);
  chk('log names the new location', 'Torreón', logged.new_location);
  chk('log stamps the time', true, !!logged.changed_at);
  chk('Monterrey revenue re-derived', 500, rev(mty)?.total);
  chk('Torreón revenue rebuilt', 250, rev(trc)?.total);
  chk('re-running finds nothing left to fix', 0, pd.repairOrderLocations().wouldChange);

  console.log('== amounts and orders are never destroyed ==');
  chk('all 5 orders still there', 5, db.prepare('SELECT COUNT(*) c FROM pd_orders').get().c);
  chk('amounts untouched', 250,
    db.prepare(`SELECT amount FROM pd_orders WHERE order_id = 'o-trc-1'`).get().amount);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL ROUTING TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
