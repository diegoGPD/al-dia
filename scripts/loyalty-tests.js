// Reward model: 5 = drink, 10 = burrito, card resets only after the burrito is
// redeemed, and a reward earned but never claimed survives that reset.
// Run: node scripts/loyalty-tests.js
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/aldia-loyalty-tests';
require('node:fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const { db, createLocation } = require('../src/db');
const loyalty = require('../src/loyalty/state');

let failures = 0;
function chk(label, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}: ${label}${ok ? '' : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!ok) failures++;
}
const loc = createLocation('Bugo MTY');
const fresh = c => db.prepare('SELECT * FROM customers WHERE id = ?').get(c.id);
// visits are one-per-day, so tests use the override to simulate separate days
const visit = c => loyalty.addVisit(fresh(c), loc, { override: true });

console.log('== defaults: 5 -> bebida, 10 -> burrito ==');
chk('two rewards', [5, 10], loyalty.rewards().map(r => r.milestone));
chk('icons', ['drink', 'burrito'], loyalty.rewards().map(r => r.icon));
chk('card is 10 slots', 10, loyalty.cardSize());

console.log('== the grid fills, milestones grant rewards ==');
const a = loyalty.createCustomer({ name: 'Ana', phone: '81', email: 'a@b.mx' });
for (let i = 0; i < 4; i++) visit(a);
let s = loyalty.stateOf(fresh(a));
chk('4 stamps', 4, s.stamps);
chk('nothing earned yet', 0, s.rewardsAvailable);
chk('next is the drink at 5', 'bebida', s.nextReward.name);
chk('one visit to go', 1, s.toNext);

const fifth = visit(a);
chk('visit 5 earns the drink', ['bebida'], fifth.justEarned.map(r => r.name));
s = loyalty.stateOf(fresh(a));
chk('drink is pending', 1, s.rewardsAvailable);
chk('card did NOT reset at 5', 5, s.stamps);
chk('next is the burrito', 'burrito', s.nextReward.name);

console.log('== one stamp per day unless overridden ==');
chk('second stamp same day refused', 'already_today', loyalty.addVisit(fresh(a), loc).reason);
chk('still 5 stamps', 5, loyalty.stateOf(fresh(a)).stamps);

console.log('== reaching 10 earns the burrito, card stays full until redeemed ==');
for (let i = 0; i < 4; i++) visit(a);
const tenth = visit(a);
chk('visit 10 earns the burrito', ['burrito'], tenth.justEarned.map(r => r.name));
s = loyalty.stateOf(fresh(a));
chk('10 stamps', 10, s.stamps);
chk('both rewards owed', 2, s.rewardsAvailable);
chk('card has not reset yet', 10, s.stamps);

console.log('== THE IMPORTANT ONE: redeeming the burrito must not eat the drink ==');
const burrito = loyalty.rewards().find(r => r.icon === 'burrito');
const r1 = loyalty.redeem(fresh(a), loc, burrito.id);
chk('burrito redeemed', 'burrito', r1.redeemed.name);
chk('card reset to empty', 0, r1.state.stamps);
chk('the unclaimed drink survived the reset', 1, r1.state.rewardsAvailable);
chk('and it is still the drink', 'bebida', r1.state.pending[0].name);

console.log('== the surviving drink can still be handed over later ==');
const r2 = loyalty.redeem(fresh(a), loc);
chk('drink redeemed', 'bebida', r2.redeemed.name);
chk('nothing owed now', 0, r2.state.rewardsAvailable);
chk('card still empty', 0, r2.state.stamps);
chk('lifetime visits remembered', 10, r2.state.visits);

console.log('== second card earns rewards again ==');
for (let i = 0; i < 5; i++) visit(a);
s = loyalty.stateOf(fresh(a));
chk('5 stamps on the new card', 5, s.stamps);
chk('drink earned again', 1, s.rewardsAvailable);
chk('lifetime visits keep counting', 15, s.visits);

console.log('== redeeming with nothing owed is refused ==');
const b = loyalty.createCustomer({ name: 'Beto' });
chk('refused', 'nothing_to_redeem', loyalty.redeem(fresh(b), loc).reason);

console.log('== a customer from before cycles existed keeps their visits ==');
const old = loyalty.createCustomer({ name: 'Viejo' });
db.prepare("UPDATE customers SET cycle_from_visit_id = NULL WHERE id = ?").run(old.id);
for (let i = 0; i < 3; i++) visit(old);
chk('legacy visits still count', 3, loyalty.stateOf(fresh(old)).stamps);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL LOYALTY TESTS PASSED');
process.exit(failures ? 1 : 0);
