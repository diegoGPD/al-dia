// Regression tests for period aggregation: day / week / month / custom must
// agree with each other and with the raw data. Run: node scripts/period-tests.js
// Uses a throwaway database and a fixed, hand-checkable fixture.
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/aldia-period-tests';
process.env.TZ_OFFSET_HOURS = process.env.TZ_OFFSET_HOURS ?? '-6';
require('node:fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const { db, createLocation } = require('../src/db');
const calc = require('../src/calc');
const { periodBounds, addDays, effectiveEnd, todayStr } = require('../src/lib/dates');
const { upsertDayRevenue } = require('../src/lib/revenue');

let failures = 0;
const near = (a, b, tol = 0.01) => Math.abs(a - b) < tol;
function chk(label, expected, actual) {
  const ok = typeof expected === 'number' ? near(expected, actual) : expected === actual;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}: ${label}${ok ? '' : `  (expected ${expected}, got ${actual})`}`);
  if (!ok) failures++;
}

// ---------- fixture: March 2026, every day identical ----------
// revenue 100/day (cash, 0% commission), food cost 10/day,
// rent 3100/month -> 3100/(365/12) = 101.9178082/day
const loc = createLocation('Fixture');
const cash = db.prepare(
  `SELECT id FROM revenue_categories WHERE location_id = ? AND name = 'Efectivo en tienda'`).get(loc).id;
const food = db.prepare(
  `SELECT id FROM variable_cost_categories WHERE location_id = ? AND name LIKE '%ingredient%'`).get(loc).id;
const rentCat = db.prepare(
  `SELECT id FROM recurring_cost_categories WHERE location_id = ? AND name = 'Rent'`).get(loc).id;

for (let d = 1; d <= 31; d++) {
  const date = `2026-03-${String(d).padStart(2, '0')}`;
  upsertDayRevenue(loc, date, { items: [{ category_id: cash, amount: 100 }] });
  db.prepare(`INSERT INTO variable_costs (location_id, date, category_id, amount, invoiced)
    VALUES (?,?,?,?,0)`).run(loc, date, food, 10);
}
db.prepare(`INSERT INTO recurring_costs (location_id, category_id, description, amount, frequency, invoiced, start_date)
  VALUES (?,?,?,?,?,0,?)`).run(loc, rentCat, 'Rent', 3100, 'monthly', '2026-01-01');

const RENT_DAY = 3100 / (365 / 12);
const DAY_COST = 10 + RENT_DAY;

console.log('== day totals ==');
const day = calc.summary(loc, '2026-03-10', '2026-03-10');
chk('day revenue', 100, day.revenue);
chk('day costs', DAY_COST, day.costs.total);
chk('day profit', 100 - DAY_COST, day.profit);

console.log('== every past week is a FULL 7 days (the reported bug) ==');
for (const anchor of ['2026-03-04', '2026-03-11', '2026-03-18', '2026-03-25']) {
  const b = periodBounds('week', anchor);
  const end = effectiveEnd(b);              // past period -> untouched
  chk(`week ${b.start} spans 7 days`, b.end, end);
  const s = calc.summary(loc, b.start, end);
  chk(`week ${b.start} revenue = 700`, 700, s.revenue);
  chk(`week ${b.start} costs = 7 x day`, 7 * DAY_COST, s.costs.total);
}

console.log('== anchoring anywhere inside a week gives identical totals ==');
const ref = calc.summary(loc, ...(() => { const b = periodBounds('week', '2026-03-09'); return [b.start, b.end]; })());
for (const anchor of ['2026-03-09', '2026-03-11', '2026-03-13', '2026-03-15']) {
  const b = periodBounds('week', anchor);
  const s = calc.summary(loc, b.start, effectiveEnd(b));
  chk(`anchor ${anchor} -> same costs`, ref.costs.total, s.costs.total);
}

console.log('== months use real day counts ==');
for (const [anchor, days, rev] of [['2026-02-15', 28, 0], ['2026-03-15', 31, 3100], ['2026-04-15', 30, 0]]) {
  const b = periodBounds('month', anchor);
  const end = effectiveEnd(b);
  const s = calc.summary(loc, b.start, end);
  chk(`${anchor.slice(0, 7)} has ${days} days`, days, Math.round((Date.parse(end) - Date.parse(b.start)) / 864e5) + 1);
  chk(`${anchor.slice(0, 7)} revenue`, rev, s.revenue);
  chk(`${anchor.slice(0, 7)} rent = ${days} daily slices`, days * RENT_DAY,
    s.costs.recurring);
}

console.log('== totals equal the sum of their days (self-check) ==');
for (const [g, anchor] of [['week', '2026-03-11'], ['month', '2026-03-15'], ['month', '2026-02-15']]) {
  const b = periodBounds(g, anchor);
  const v = calc.verifyPeriodConsistency(loc, b.start, effectiveEnd(b));
  chk(`${g} ${b.start} consistent`, true, v.ok);
}

console.log('== month = sum of the weeks it contains (partial weeks clipped) ==');
{
  const mb = periodBounds('month', '2026-03-15');
  const month = calc.summary(loc, mb.start, mb.end);
  let acc = 0;
  for (let d = mb.start; d <= mb.end;) {
    const wb = periodBounds('week', d);
    const s = wb.start < mb.start ? mb.start : wb.start;
    const e = wb.end > mb.end ? mb.end : wb.end;
    acc += calc.summary(loc, s, e).costs.total;
    d = addDays(wb.end, 1);
  }
  chk('sum of clipped weeks = month', month.costs.total, acc);
}

console.log('== repeated computation is deterministic ==');
{
  const b = periodBounds('month', '2026-03-15');
  const runs = [0, 1, 2].map(() => calc.summary(loc, b.start, b.end).costs.total);
  chk('3 runs identical', true, runs.every(x => near(x, runs[0])));
}

console.log('== custom range = same window computed directly ==');
{
  const a = calc.summary(loc, '2026-03-05', '2026-03-14');
  let acc = 0;
  for (let d = '2026-03-05'; d <= '2026-03-14'; d = addDays(d, 1)) acc += calc.summary(loc, d, d).costs.total;
  chk('10-day custom = its days', a.costs.total, acc);
  chk('10-day custom revenue', 1000, a.revenue);
}

console.log('== a period still running stops at today; finished ones do not ==');
{
  const today = todayStr();
  const cur = periodBounds('month', today);
  chk('current month clamps to today', today, effectiveEnd(cur, today));
  const past = periodBounds('month', '2026-03-15');
  chk('past month unclamped', past.end, effectiveEnd(past, today));
  const future = periodBounds('month', addDays(today, 70));
  chk('future month unclamped', future.end, effectiveEnd(future, today));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PERIOD TESTS PASSED');
process.exit(failures ? 1 : 0);
