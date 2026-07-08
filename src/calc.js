// Calculation engine: period summaries, break-even, margins, trends, benchmarks.
const { db } = require('./db');

// ---------- date helpers (all dates are YYYY-MM-DD strings, UTC-safe) ----------
const d2u = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const u2d = ms => new Date(ms).toISOString().slice(0, 10);
const addDays = (s, n) => u2d(d2u(s) + n * 864e5);
const daysBetween = (a, b) => Math.round((d2u(b) - d2u(a)) / 864e5); // inclusive count = +1

// Period bounds for a granularity around an anchor date. Weeks start Monday.
function periodBounds(granularity, anchor) {
  if (granularity === 'day') return { start: anchor, end: anchor };
  if (granularity === 'week') {
    const dow = new Date(d2u(anchor)).getUTCDay(); // 0=Sun
    const start = addDays(anchor, -((dow + 6) % 7));
    return { start, end: addDays(start, 6) };
  }
  // month
  const start = anchor.slice(0, 8) + '01';
  const next = new Date(Date.UTC(+anchor.slice(0, 4), +anchor.slice(5, 7), 1));
  return { start, end: u2d(next.getTime() - 864e5) };
}

function prevPeriodAnchor(granularity, anchor) {
  if (granularity === 'day') return addDays(anchor, -1);
  if (granularity === 'week') return addDays(anchor, -7);
  const d = new Date(Date.UTC(+anchor.slice(0, 4), +anchor.slice(5, 7) - 2, 1));
  return u2d(d.getTime());
}

// ---------- recurring costs ----------
const DAILY_DIVISOR = { weekly: 7, biweekly: 14, monthly: 365 / 12 };
const dailyRate = item => item.amount / DAILY_DIVISOR[item.frequency];

// Days an item is live within [start, end]
function overlapDays(item, start, end) {
  const s = item.start_date > start ? item.start_date : start;
  const e = item.end_date && item.end_date < end ? item.end_date : end;
  if (s > e) return 0;
  return daysBetween(s, e) + 1;
}

function recurringItems(locationId) {
  return db.prepare(
    `SELECT rc.*, c.name AS category_name, c.benchmark_tag
     FROM recurring_costs rc JOIN recurring_cost_categories c ON c.id = rc.category_id
     WHERE rc.location_id = ? AND rc.active = 1`).all(locationId);
}

function recurringForRange(locationId, start, end) {
  const items = recurringItems(locationId);
  let total = 0, invoiced = 0;
  const byCategory = {}, byTag = {};
  for (const it of items) {
    const amt = dailyRate(it) * overlapDays(it, start, end);
    if (amt <= 0) continue;
    total += amt;
    if (it.invoiced) invoiced += amt;
    const key = it.category_name;
    byCategory[key] = byCategory[key] || { amount: 0, invoiced: 0 };
    byCategory[key].amount += amt;
    if (it.invoiced) byCategory[key].invoiced += amt;
    if (it.benchmark_tag) byTag[it.benchmark_tag] = (byTag[it.benchmark_tag] || 0) + amt;
  }
  return { total, invoiced, byCategory, byTag };
}

// Current daily fixed-cost burn (items live today).
function recurringDailyNow(locationId, today) {
  return recurringItems(locationId)
    .filter(it => it.start_date <= today && (!it.end_date || it.end_date >= today))
    .reduce((sum, it) => sum + dailyRate(it), 0);
}

// ---------- period summary ----------
function summary(locationId, start, end) {
  const revenue = db.prepare(
    `SELECT COALESCE(SUM(total),0) t FROM revenue_entries
     WHERE location_id = ? AND date BETWEEN ? AND ?`).get(locationId, start, end).t;

  const revByCat = db.prepare(
    `SELECT c.name, COALESCE(SUM(ri.amount),0) amount
     FROM revenue_items ri
     JOIN revenue_entries re ON re.id = ri.entry_id
     JOIN revenue_categories c ON c.id = ri.category_id
     WHERE re.location_id = ? AND re.date BETWEEN ? AND ?
     GROUP BY c.id ORDER BY c.position`).all(locationId, start, end);

  const varRows = db.prepare(
    `SELECT c.name, c.benchmark_tag,
            COALESCE(SUM(vc.amount),0) amount,
            COALESCE(SUM(CASE WHEN vc.invoiced = 1 THEN vc.amount ELSE 0 END),0) invoiced
     FROM variable_costs vc JOIN variable_cost_categories c ON c.id = vc.category_id
     WHERE vc.location_id = ? AND vc.date BETWEEN ? AND ?
     GROUP BY c.id ORDER BY c.position`).all(locationId, start, end);
  const variable = varRows.reduce((s, r) => s + r.amount, 0);
  const variableInvoiced = varRows.reduce((s, r) => s + r.invoiced, 0);

  const oneoffRows = db.prepare(
    `SELECT description, amount, invoiced, date FROM oneoff_costs
     WHERE location_id = ? AND date BETWEEN ? AND ? ORDER BY date`).all(locationId, start, end);
  const oneoff = oneoffRows.reduce((s, r) => s + r.amount, 0);
  const oneoffInvoiced = oneoffRows.reduce((s, r) => s + (r.invoiced ? r.amount : 0), 0);

  const rec = recurringForRange(locationId, start, end);

  const totalCosts = variable + oneoff + rec.total;
  const profit = revenue - totalCosts;
  const invoicedTotal = variableInvoiced + oneoffInvoiced + rec.invoiced;

  // Benchmark tag totals (food/labor from variable; labor/occupancy from recurring)
  const tag = { food: 0, labor: 0, occupancy: 0 };
  for (const r of varRows) if (r.benchmark_tag) tag[r.benchmark_tag] += r.amount;
  for (const [t, amt] of Object.entries(rec.byTag)) tag[t] += amt;

  return {
    start, end,
    revenue,
    revenueByCategory: revByCat,
    costs: {
      variable, variableByCategory: varRows,
      recurring: rec.total, recurringByCategory: rec.byCategory,
      oneoff, oneoffItems: oneoffRows,
      total: totalCosts
    },
    invoiced: {
      total: invoicedTotal,
      notInvoiced: totalCosts - invoicedTotal,
      variable: variableInvoiced,
      recurring: rec.invoiced,
      oneoff: oneoffInvoiced
    },
    profit,
    grossMargin: revenue > 0 ? (revenue - variable) / revenue : null,
    netMargin: revenue > 0 ? profit / revenue : null,
    tagTotals: tag
  };
}

// ---------- break-even ----------
// Fixed costs for the period F, variable-cost ratio v -> break-even sales = F / (1 - v).
function breakEven(locationId, start, end, sum) {
  const fixed = sum.costs.recurring + sum.costs.oneoff;
  let ratio = null, ratioSource = 'actual';
  if (sum.revenue > 0 && sum.costs.variable > 0) {
    ratio = sum.costs.variable / sum.revenue;
  } else {
    // No sales/cost data yet: estimate from the default % of percent-based categories.
    const rows = db.prepare(
      `SELECT COALESCE(SUM(default_percent),0) p FROM variable_cost_categories
       WHERE location_id = ? AND active = 1 AND entry_mode = 'percent'`).get(locationId);
    ratio = Math.min(rows.p / 100, 0.95);
    ratioSource = 'estimated';
  }
  if (ratio >= 0.99) return { salesNeeded: null, ratio, ratioSource, fixed, gap: null, status: 'unprofitable_ratio' };
  const salesNeeded = fixed / (1 - ratio);
  const gap = sum.revenue - salesNeeded;
  let status;
  if (salesNeeded === 0 && sum.revenue === 0) status = 'no_data';
  else if (Math.abs(gap) <= salesNeeded * 0.02) status = 'at';
  else status = gap > 0 ? 'above' : 'below';
  return { salesNeeded, ratio, ratioSource, fixed, gap, status };
}

// ---------- daily trend ----------
function trend(locationId, endDate, days = 30) {
  const start = addDays(endDate, -(days - 1));
  const revRows = db.prepare(
    `SELECT date, total FROM revenue_entries WHERE location_id = ? AND date BETWEEN ? AND ?`)
    .all(locationId, start, endDate);
  const varRows = db.prepare(
    `SELECT date, SUM(amount) a FROM variable_costs WHERE location_id = ? AND date BETWEEN ? AND ? GROUP BY date`)
    .all(locationId, start, endDate);
  const offRows = db.prepare(
    `SELECT date, SUM(amount) a FROM oneoff_costs WHERE location_id = ? AND date BETWEEN ? AND ? GROUP BY date`)
    .all(locationId, start, endDate);
  const rev = Object.fromEntries(revRows.map(r => [r.date, r.total]));
  const vc = Object.fromEntries(varRows.map(r => [r.date, r.a]));
  const oo = Object.fromEntries(offRows.map(r => [r.date, r.a]));
  const items = recurringItems(locationId);

  const out = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const recDay = items
      .filter(it => it.start_date <= date && (!it.end_date || it.end_date >= date))
      .reduce((s, it) => s + dailyRate(it), 0);
    const revenue = rev[date] || 0;
    const costs = (vc[date] || 0) + (oo[date] || 0) + recDay;
    out.push({ date, revenue, costs, profit: revenue - costs });
  }
  return out;
}

// ---------- general industry benchmarks (typical full-service/quick-service ranges) ----------
const BENCHMARKS = [
  { key: 'food',      label: 'Food & drink cost', low: 0.28, high: 0.35 },
  { key: 'labor',     label: 'Labor cost',        low: 0.25, high: 0.35 },
  { key: 'prime',     label: 'Prime cost (food + labor)', low: 0.55, high: 0.65 },
  { key: 'occupancy', label: 'Rent & occupancy',  low: 0.05, high: 0.10 },
  { key: 'net',       label: 'Net profit margin', low: 0.03, high: 0.09 }
];

function benchmarks(sum) {
  if (sum.revenue <= 0) return [];
  const pct = {
    food: sum.tagTotals.food / sum.revenue,
    labor: sum.tagTotals.labor / sum.revenue,
    occupancy: sum.tagTotals.occupancy / sum.revenue,
    net: sum.netMargin
  };
  pct.prime = pct.food + pct.labor;
  return BENCHMARKS.map(b => {
    const value = pct[b.key];
    let flag = 'ok';
    if (b.key === 'net') {
      if (value < b.low) flag = 'low';           // for net margin, low is bad
      else if (value > b.high) flag = 'great';
    } else {
      if (value > b.high) flag = 'high';         // for costs, high is bad
      else if (value < b.low) flag = 'low_note'; // unusually low — worth a look
    }
    return { ...b, value, flag };
  });
}

module.exports = {
  periodBounds, prevPeriodAnchor, addDays,
  summary, breakEven, trend, benchmarks,
  recurringDailyNow, dailyRate
};
