// Calculation engine: period summaries, break-even, margins, trends, benchmarks.
const { db } = require('./db');
const { addDays, daysBetween, dow, mondayOf } = require('./lib/dates');

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

// ---------- scheduled team labor, booked daily ----------
// Each day carries its own labor cost: that day's hourly shifts at their
// rates, plus salaried staff spread evenly across the week (weekly rate / 7)
// for any week that actually has a schedule. Weeks with no shifts cost
// nothing, so nothing appears until the scheduler is used.
// An employee's active date range is the source of truth: a turn assignment
// outside it costs nothing, even if the historical schedule still lists them.
const EMP_ACTIVE_ON = `(COALESCE(e.start_date,'0000-01-01') <= %DATE% AND (e.end_date IS NULL OR e.end_date >= %DATE%))`;

function laborMaps(locationId, start, end) {
  // widen to whole weeks so the "does this week have a schedule" test is right
  const wideStart = mondayOf(start), wideEnd = addDays(mondayOf(end), 6);
  const hourly = Object.fromEntries(db.prepare(
    `SELECT t.date, SUM(((CASE WHEN t.end_min <= t.start_min THEN t.end_min + 1440 ELSE t.end_min END) - t.start_min) / 60.0 * e.rate) v
     FROM turn_assignments ta
     JOIN turns t ON t.id = ta.turn_id
     JOIN employees e ON e.id = ta.employee_id AND e.pay_type = 'hourly'
     WHERE t.location_id = ? AND t.date BETWEEN ? AND ?
       AND ${EMP_ACTIVE_ON.replace(/%DATE%/g, 't.date')}
     GROUP BY t.date`)
    .all(locationId, wideStart, wideEnd).map(r => [r.date, r.v]));
  const scheduledWeeks = new Set(db.prepare(
    `SELECT DISTINCT t.date FROM turns t JOIN turn_assignments ta ON ta.turn_id = t.id
     WHERE t.location_id = ? AND t.date BETWEEN ? AND ?`)
    .all(locationId, wideStart, wideEnd).map(r => mondayOf(r.date)));
  // Salaried staff cost their weekly rate only on days they're employed.
  const salaried = db.prepare(
    `SELECT rate, start_date, end_date FROM employees
     WHERE location_id = ? AND active = 1 AND pay_type = 'salary'`).all(locationId);
  const salaryOn = date => salaried.reduce((s, e) =>
    s + (((e.start_date || '0000-01-01') <= date && (!e.end_date || e.end_date >= date)) ? e.rate / 7 : 0), 0);
  const onDay = date => (hourly[date] || 0) + (scheduledWeeks.has(mondayOf(date)) ? salaryOn(date) : 0);
  return { onDay, scheduledWeeks, salaryOn };
}

function laborForRange(locationId, start, end) {
  const { onDay } = laborMaps(locationId, start, end);
  let total = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) total += onDay(d);
  return total;
}

// ---------- payout reconciliation ----------
// Once a real payout is known for a channel+window, it replaces the commission
// estimate there. When the queried period only partly overlaps a reconciled
// window, the correction is applied in proportion to the sales that fall inside
// the overlap — so a day view shows its share and a month view the whole thing,
// with no double counting.
function reconciliationAdjustment(locationId, start, end) {
  const recons = db.prepare(
    `SELECT r.*, c.name channel FROM channel_reconciliations r
     JOIN revenue_categories c ON c.id = r.category_id
     WHERE r.location_id = ? AND r.start_date <= ? AND r.end_date >= ?`)
    .all(locationId, end, start);
  let total = 0;
  const byChannel = [];
  for (const r of recons) {
    const oStart = r.start_date > start ? r.start_date : start;
    const oEnd = r.end_date < end ? r.end_date : end;
    if (oStart > oEnd) continue;
    const overlapGross = db.prepare(
      `SELECT COALESCE(SUM(ri.amount),0) v FROM revenue_items ri
       JOIN revenue_entries re ON re.id = ri.entry_id
       WHERE re.location_id = ? AND ri.category_id = ? AND re.date BETWEEN ? AND ?`)
      .get(locationId, r.category_id, oStart, oEnd).v;
    const share = r.gross > 0 ? overlapGross / r.gross : 0;
    // Kept less than estimated -> commissions were understated (positive adj).
    const adj = (r.estimated_net - r.actual_net) * share;
    total += adj;
    byChannel.push({
      channel: r.channel, category_id: r.category_id,
      window: `${r.start_date} → ${r.end_date}`,
      estimated_net: r.estimated_net, actual_net: r.actual_net,
      variance: r.actual_net - r.estimated_net, applied: adj, share
    });
  }
  return { total, byChannel };
}

// ---------- period summary ----------
function summary(locationId, start, end) {
  const revenue = db.prepare(
    `SELECT COALESCE(SUM(total),0) t FROM revenue_entries
     WHERE location_id = ? AND date BETWEEN ? AND ?`).get(locationId, start, end).t;

  const revByCat = db.prepare(
    `SELECT c.name, COALESCE(SUM(ri.amount),0) amount,
            COALESCE(SUM(ri.commission_amount),0) commission,
            COALESCE(SUM(CASE WHEN ri.commission_invoiced = 1 THEN ri.commission_amount ELSE 0 END),0) commission_invoiced
     FROM revenue_items ri
     JOIN revenue_entries re ON re.id = ri.entry_id
     JOIN revenue_categories c ON c.id = ri.category_id
     WHERE re.location_id = ? AND re.date BETWEEN ? AND ?
     GROUP BY c.id ORDER BY c.position`).all(locationId, start, end);
  const commissions = revByCat.reduce((s, r) => s + r.commission, 0);
  const commissionsInvoiced = revByCat.reduce((s, r) => s + r.commission_invoiced, 0);

  const varRows = db.prepare(
    `SELECT c.name, c.benchmark_tag,
            COALESCE(SUM(vc.amount),0) amount,
            COALESCE(SUM(CASE WHEN vc.invoiced = 1 THEN vc.amount ELSE 0 END),0) invoiced
     FROM variable_costs vc JOIN variable_cost_categories c ON c.id = vc.category_id
     WHERE vc.location_id = ? AND vc.date BETWEEN ? AND ?
     GROUP BY c.id ORDER BY c.position`).all(locationId, start, end);

  // One-offs tagged with a cost category (a bulk food buy, say) belong with
  // that category — they count toward its benchmark and the day-to-day rate.
  // Untagged ones stay in the "unusual" bucket.
  const allOneoffs = db.prepare(
    `SELECT o.description, o.amount, o.invoiced, o.date, o.category_id,
            c.name category_name, c.benchmark_tag
     FROM oneoff_costs o LEFT JOIN variable_cost_categories c ON c.id = o.category_id
     WHERE o.location_id = ? AND o.date BETWEEN ? AND ? ORDER BY o.date`).all(locationId, start, end);
  const oneoffRows = allOneoffs.filter(r => !r.category_id);
  for (const r of allOneoffs.filter(r => r.category_id && r.category_name)) {
    let row = varRows.find(v => v.name === r.category_name);
    if (!row) { row = { name: r.category_name, benchmark_tag: r.benchmark_tag, amount: 0, invoiced: 0 }; varRows.push(row); }
    row.amount += r.amount;
    if (r.invoiced) row.invoiced += r.amount;
  }
  const variable = varRows.reduce((s, r) => s + r.amount, 0);
  const variableInvoiced = varRows.reduce((s, r) => s + r.invoiced, 0);
  const oneoff = oneoffRows.reduce((s, r) => s + r.amount, 0);
  const oneoffInvoiced = oneoffRows.reduce((s, r) => s + (r.invoiced ? r.amount : 0), 0);

  const rec = recurringForRange(locationId, start, end);
  const labor = laborForRange(locationId, start, end);

  // Real payouts override the commission estimate where they're known.
  const recon = reconciliationAdjustment(locationId, start, end);
  const commissionsEstimated = commissions;
  const commissionsFinal = commissions + recon.total;

  const totalCosts = variable + commissionsFinal + oneoff + rec.total + labor;
  const profit = revenue - totalCosts;
  // Scheduled labor counts as not-invoiced spend.
  const invoicedTotal = variableInvoiced + commissionsInvoiced + oneoffInvoiced + rec.invoiced;

  // Benchmark tag totals (food/labor from variable; labor/occupancy from recurring; scheduled team = labor)
  const tag = { food: 0, labor: labor, occupancy: 0 };
  for (const r of varRows) if (r.benchmark_tag) tag[r.benchmark_tag] += r.amount;
  for (const [t, amt] of Object.entries(rec.byTag)) tag[t] += amt;

  return {
    start, end,
    revenue,
    revenueByCategory: revByCat,
    costs: {
      variable, variableByCategory: varRows,
      commissions: commissionsFinal, commissionsEstimated,
      commissionAdjustment: recon.total, reconciliations: recon.byChannel,
      commissionsByChannel: revByCat.filter(r => r.commission > 0),
      recurring: rec.total, recurringByCategory: rec.byCategory,
      oneoff, oneoffItems: oneoffRows,
      labor,
      total: totalCosts
    },
    // Both scheduled labor AND labor-tagged recurring costs present = payroll
    // probably counted twice. Surfaced as a warning in the UI.
    laborDoubleCount: labor > 0 && (rec.byTag.labor || 0) > 0,
    laborRecurring: rec.byTag.labor || 0,
    invoiced: {
      total: invoicedTotal,
      notInvoiced: totalCosts - invoicedTotal,
      variable: variableInvoiced,
      commissions: commissionsInvoiced,
      recurring: rec.invoiced,
      oneoff: oneoffInvoiced
    },
    profit,
    grossMargin: revenue > 0 ? (revenue - variable - commissionsFinal) / revenue : null,
    netMargin: revenue > 0 ? profit / revenue : null,
    tagTotals: tag
  };
}

// ---------- break-even ----------
// Fixed costs F, sales-scaling ratio v -> break-even sales = F / (1 - v).
// The ratio always covers BOTH components: day-to-day costs AND channel
// commissions. Each uses this period's actual data when present, otherwise
// the last 28 days of history, otherwise category defaults — so break-even
// never quietly drops commissions just because today's costs aren't logged yet.
// Historical fallback ratios, with sanity rails. A thin or lopsided window
// (one big grocery run against a single slow day) can produce a ratio like
// 82%, which combined with real commissions exceeds 100% and makes break-even
// meaningless. Such a sample is rejected rather than trusted.
const PLAUSIBLE_VAR_MAX = 0.75;   // day-to-day costs above 75% of sales
const PLAUSIBLE_COMM_MAX = 0.60;  // blended commission above 60% of sales
const MIN_SAMPLE_DAYS = 5;

// Day-to-day spend for a range, counting one-offs filed under a cost category
// (a bulk food buy) exactly like summary() does.
function variableSpend(locationId, start, end) {
  const vc = db.prepare(
    `SELECT COALESCE(SUM(amount),0) t FROM variable_costs
     WHERE location_id = ? AND date BETWEEN ? AND ?`).get(locationId, start, end).t;
  const oo = db.prepare(
    `SELECT COALESCE(SUM(amount),0) t FROM oneoff_costs
     WHERE location_id = ? AND date BETWEEN ? AND ? AND category_id IS NOT NULL`)
    .get(locationId, start, end).t;
  return vc + oo;
}

// Break-even needs a RATE, and a rate is only meaningful over enough time.
// Food is bought in bulk: a big Monday order against a slow week reads as 60%
// of sales, but selling more that week would NOT have cost 60% more — the food
// was already in the walk-in. Using that number inflates the target wildly.
// So the day-to-day rate comes from a trailing window that smooths purchasing.
const TYPICAL_WINDOW_DAYS = 84;
const TYPICAL_MIN_DAYS = 21;

function typicalVarRatio(locationId, end) {
  const start = addDays(end, -(TYPICAL_WINDOW_DAYS - 1));
  const r = db.prepare(
    `SELECT COUNT(*) days, COALESCE(SUM(total),0) rev FROM revenue_entries
     WHERE location_id = ? AND date BETWEEN ? AND ? AND total > 0`).get(locationId, start, end);
  if (r.days < TYPICAL_MIN_DAYS || r.rev <= 0) return null;
  const ratio = variableSpend(locationId, start, end) / r.rev;
  if (ratio <= 0 || ratio > PLAUSIBLE_VAR_MAX) return null;
  return { ratio, days: r.days, from: start, to: end };
}

function recentScalingRatios(locationId, before) {
  const start = addDays(before, -89); // look back up to 90 days for a real sample
  const rows = db.prepare(
    `SELECT COUNT(*) days, COALESCE(SUM(total),0) t FROM revenue_entries
     WHERE location_id = ? AND date BETWEEN ? AND ? AND total > 0`)
    .get(locationId, start, before);
  const rev = rows.t;
  if (rev <= 0 || rows.days < MIN_SAMPLE_DAYS) return { varRatio: null, commRatio: null, thin: true };
  const vc = db.prepare(
    `SELECT COALESCE(SUM(amount),0) t FROM variable_costs WHERE location_id = ? AND date BETWEEN ? AND ?`)
    .get(locationId, start, before).t;
  const cm = db.prepare(
    `SELECT COALESCE(SUM(ri.commission_amount),0) t FROM revenue_items ri
     JOIN revenue_entries re ON re.id = ri.entry_id
     WHERE re.location_id = ? AND re.date BETWEEN ? AND ?`).get(locationId, start, before).t;
  const v = vc > 0 ? vc / rev : null;
  const c = cm > 0 ? cm / rev : null;
  return {
    varRatio: v !== null && v <= PLAUSIBLE_VAR_MAX ? v : null,
    commRatio: c !== null && c <= PLAUSIBLE_COMM_MAX ? c : null,
    thin: false
  };
}

function breakEven(locationId, start, end, sum) {
  const fixed = sum.costs.recurring + sum.costs.oneoff + sum.costs.labor;
  const recent = recentScalingRatios(locationId, addDays(start, -1));
  let sources = 0; // how many components come from this period's actual data

  // Rate first, this period second: bulk purchases make a single period's
  // ratio meaningless as a marginal cost rate.
  const typical = typicalVarRatio(locationId, end);
  const periodVarRatio = sum.revenue > 0 && sum.costs.variable > 0
    ? sum.costs.variable / sum.revenue : null;

  let varRatio, varSource;
  if (typical) {
    varRatio = typical.ratio; varSource = 'typical'; sources++;
  } else if (periodVarRatio !== null) {
    varRatio = periodVarRatio; varSource = 'actual'; sources++;
  } else if (recent.varRatio !== null) {
    varRatio = recent.varRatio; varSource = 'history';
  } else {
    varRatio = Math.min(db.prepare(
      `SELECT COALESCE(SUM(default_percent),0) p FROM variable_cost_categories
       WHERE location_id = ? AND active = 1 AND entry_mode = 'percent'`).get(locationId).p / 100, PLAUSIBLE_VAR_MAX);
    varSource = 'defaults';
  }

  let commRatio, commSource;
  if (sum.revenue > 0 && sum.costs.commissions > 0) {
    commRatio = sum.costs.commissions / sum.revenue; commSource = 'actual'; sources++;
  } else if (recent.commRatio !== null) {
    commRatio = recent.commRatio; commSource = 'history';
  } else {
    commRatio = Math.min(db.prepare(
      `SELECT COALESCE(AVG(commission_percent),0) p FROM revenue_categories
       WHERE location_id = ? AND active = 1`).get(locationId).p / 100, PLAUSIBLE_COMM_MAX);
    commSource = 'defaults';
  }

  const ratio = varRatio + commRatio;
  const ratioSource = sources === 2 ? 'actual' : sources === 1 ? 'mixed' : 'estimated';
  const base = {
    ratio, varRatio, commRatio, varSource, commSource, ratioSource, fixed,
    // What this period alone spent, so the UI can explain a lumpy week
    // without letting it distort the target.
    periodVarRatio,
    typicalWindowDays: typical ? typical.days : null,
    lumpy: typical && periodVarRatio !== null && Math.abs(periodVarRatio - typical.ratio) > 0.08
  };

  // If costs would eat 90%+ of every sale, break-even is either unreachable or
  // (far more likely) the inputs are wrong. Say so instead of printing a
  // number that looks authoritative and is off by an order of magnitude.
  if (ratio >= 0.90) {
    const guess = varSource !== 'actual'
      ? "this period has no day-to-day costs logged yet, so the rate had to be estimated"
      : "day-to-day costs plus commissions are eating almost every peso of sales";
    return { ...base, salesNeeded: null, gap: null, status: 'ratio_implausible', reason: guess };
  }
  const salesNeeded = fixed / (1 - ratio);
  const gap = sum.revenue - salesNeeded;
  let status;
  if (salesNeeded === 0 && sum.revenue === 0) status = 'no_data';
  else if (Math.abs(gap) <= salesNeeded * 0.02) status = 'at';
  else status = gap > 0 ? 'above' : 'below';
  return { ...base, salesNeeded, gap, status };
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
  const commRows = db.prepare(
    `SELECT re.date, SUM(ri.commission_amount) a FROM revenue_items ri
     JOIN revenue_entries re ON re.id = ri.entry_id
     WHERE re.location_id = ? AND re.date BETWEEN ? AND ? GROUP BY re.date`)
    .all(locationId, start, endDate);
  const rev = Object.fromEntries(revRows.map(r => [r.date, r.total]));
  const vc = Object.fromEntries(varRows.map(r => [r.date, r.a]));
  const oo = Object.fromEntries(offRows.map(r => [r.date, r.a]));
  const cm = Object.fromEntries(commRows.map(r => [r.date, r.a]));
  const labor = laborMaps(locationId, start, endDate);
  const items = recurringItems(locationId);

  const out = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const recDay = items
      .filter(it => it.start_date <= date && (!it.end_date || it.end_date >= date))
      .reduce((s, it) => s + dailyRate(it), 0);
    const revenue = rev[date] || 0;
    const costs = (vc[date] || 0) + (cm[date] || 0) + (oo[date] || 0) + recDay + labor.onDay(date);
    out.push({ date, revenue, costs, profit: revenue - costs });
  }
  return out;
}

// ---------- money accounts ----------
// Movement for every account over [start, end]: money in (tagged revenue +
// incoming transfers), money out (tagged costs + outgoing transfers).
function accountMovement(locationId, start, end) {
  const q = (sql) => Object.fromEntries(
    db.prepare(sql).all(locationId, start, end).map(r => [r.k, r.v]));
  const revIn = q(`SELECT rai.account_id k, COALESCE(SUM(rai.amount),0) v
    FROM revenue_account_items rai JOIN revenue_entries re ON re.id = rai.entry_id
    WHERE re.location_id = ? AND re.date BETWEEN ? AND ? GROUP BY rai.account_id`);
  const varOut = q(`SELECT account_id k, COALESCE(SUM(amount),0) v FROM variable_costs
    WHERE location_id = ? AND date BETWEEN ? AND ? AND account_id IS NOT NULL GROUP BY account_id`);
  const oneOut = q(`SELECT account_id k, COALESCE(SUM(amount),0) v FROM oneoff_costs
    WHERE location_id = ? AND date BETWEEN ? AND ? AND account_id IS NOT NULL GROUP BY account_id`);
  const trIn = q(`SELECT to_account_id k, COALESCE(SUM(amount),0) v FROM transfers
    WHERE location_id = ? AND date BETWEEN ? AND ? GROUP BY to_account_id`);
  const trOut = q(`SELECT from_account_id k, COALESCE(SUM(amount),0) v FROM transfers
    WHERE location_id = ? AND date BETWEEN ? AND ? GROUP BY from_account_id`);
  // manual corrections (signed)
  const adj = q(`SELECT account_id k, COALESCE(SUM(amount),0) v FROM account_adjustments
    WHERE location_id = ? AND date BETWEEN ? AND ? GROUP BY account_id`);
  // recurring: daily-equivalent for items tagged to an account
  const recOut = {};
  for (const it of recurringItems(locationId)) {
    if (!it.account_id) continue;
    const amt = dailyRate(it) * overlapDays(it, start, end);
    if (amt > 0) recOut[it.account_id] = (recOut[it.account_id] || 0) + amt;
  }
  return { revIn, varOut, oneOut, recOut, trIn, trOut, adj };
}

function accountsView(locationId, start, end) {
  const accounts = db.prepare(
    'SELECT * FROM accounts WHERE location_id = ? AND active = 1 ORDER BY position, id').all(locationId);
  const period = accountMovement(locationId, start, end);
  const prior = accountMovement(locationId, '1900-01-01', addDays(start, -1));

  const rows = accounts.map(a => {
    const g = (m) => m[a.id] || 0;
    const moneyIn = g(period.revIn) + g(period.trIn);
    const moneyOut = g(period.varOut) + g(period.oneOut) + g(period.recOut) + g(period.trOut);
    const priorNet = (g(prior.revIn) + g(prior.trIn) + g(prior.adj)) -
      (g(prior.varOut) + g(prior.oneOut) + g(prior.recOut) + g(prior.trOut));
    const adjustment = g(period.adj);
    return {
      id: a.id, name: a.name, opening_balance: a.opening_balance,
      moneyIn, moneyOut, net: moneyIn - moneyOut + adjustment, adjustment,
      balance: a.opening_balance + priorNet + (moneyIn - moneyOut) + adjustment
    };
  });

  // Anything not tagged to an account, so totals always tie out with the dashboard.
  const sum = summary(locationId, start, end);
  const taggedIn = rows.reduce((s, r) => s + (period.revIn[r.id] || 0), 0);
  const taggedOut = Object.values(period.varOut).reduce((s, v) => s + v, 0) +
    Object.values(period.oneOut).reduce((s, v) => s + v, 0) +
    Object.values(period.recOut).reduce((s, v) => s + v, 0);
  // Commissions are never account-tagged (the platforms deduct them before
  // paying out) and scheduled team cost isn't paid from an account here either.
  const costsExclCommissions = sum.costs.total - sum.costs.commissions - sum.costs.labor;
  return {
    accounts: rows,
    unassigned: {
      moneyIn: Math.max(0, sum.revenue - taggedIn),
      moneyOut: Math.max(0, costsExclCommissions - taggedOut)
    },
    totals: {
      revenue: sum.revenue,
      costs: costsExclCommissions,
      commissionsNote: sum.costs.commissions
    }
  };
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

// ---------- self-check ----------
// A period total must equal the sum of its own days. This recomputes the
// window day by day from the source rows and compares; any disagreement is a
// bug in aggregation, so it's logged loudly and surfaced to the UI rather than
// silently shipping wrong numbers.
function verifyPeriodConsistency(locationId, start, end) {
  const whole = summary(locationId, start, end);
  let revenue = 0, costs = 0, profit = 0, days = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const one = summary(locationId, d, d);
    revenue += one.revenue; costs += one.costs.total; profit += one.profit;
    if (++days > 400) break; // safety valve
  }
  const TOL = 0.01;
  const diffs = {
    revenue: whole.revenue - revenue,
    costs: whole.costs.total - costs,
    profit: whole.profit - profit
  };
  const ok = Object.values(diffs).every(v => Math.abs(v) < TOL);
  if (!ok) {
    console.error('[consistency] period total != sum of days',
      { locationId, start, end, whole: whole.costs.total, sumOfDays: costs, diffs });
  }
  return { ok, days, diffs, period: { revenue: whole.revenue, costs: whole.costs.total, profit: whole.profit },
           sumOfDays: { revenue, costs, profit } };
}

module.exports = {
  summary, breakEven, trend, benchmarks, verifyPeriodConsistency,
  dailyRate, recurringForRange, accountsView,
  laborForRange, laborMaps, reconciliationAdjustment
};
