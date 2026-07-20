// Forecasting & insights engine.
// Everything here is derived from the user's own logged history — day-of-week
// patterns, recent trend, and week-by-week effective cost/commission ratios
// (which drift as the channel mix changes). No generic industry assumptions.
const { db } = require('./db');
const calc = require('./calc');
const { addDays, todayStr, dow, mondayOf } = require('./lib/dates');

// ---------- raw history ----------
function dailyHistory(locationId, days = 84) {
  const end = addDays(todayStr(), -1); // exclude today (may be half-logged)
  const start = addDays(end, -(days - 1));
  const rev = db.prepare(
    `SELECT date, total FROM revenue_entries WHERE location_id = ? AND date BETWEEN ? AND ? ORDER BY date`)
    .all(locationId, start, end);
  const comm = Object.fromEntries(db.prepare(
    `SELECT re.date, SUM(ri.commission_amount) a FROM revenue_items ri
     JOIN revenue_entries re ON re.id = ri.entry_id
     WHERE re.location_id = ? AND re.date BETWEEN ? AND ? GROUP BY re.date`)
    .all(locationId, start, end).map(r => [r.date, r.a]));
  const vc = Object.fromEntries(db.prepare(
    `SELECT date, SUM(amount) a FROM variable_costs WHERE location_id = ? AND date BETWEEN ? AND ? GROUP BY date`)
    .all(locationId, start, end).map(r => [r.date, r.a]));
  const oo = Object.fromEntries(db.prepare(
    `SELECT date, SUM(amount) a FROM oneoff_costs WHERE location_id = ? AND date BETWEEN ? AND ? GROUP BY date`)
    .all(locationId, start, end).map(r => [r.date, r.a]));
  return rev.map(r => ({
    date: r.date, dow: dow(r.date), revenue: r.total,
    commissions: comm[r.date] || 0, variable: vc[r.date] || 0, oneoff: oo[r.date] || 0
  }));
}

// Group logged days into Monday-start weeks (most recent first).
function weeklyHistory(hist) {
  const weeks = {};
  for (const d of hist) {
    const monday = addDays(d.date, -((d.dow + 6) % 7));
    (weeks[monday] = weeks[monday] || { week: monday, revenue: 0, commissions: 0, variable: 0, oneoff: 0, days: 0 });
    const w = weeks[monday];
    w.revenue += d.revenue; w.commissions += d.commissions;
    w.variable += d.variable; w.oneoff += d.oneoff; w.days++;
  }
  return Object.values(weeks).sort((a, b) => b.week.localeCompare(a.week));
}

// Recency-weighted ratio of cost to revenue across recent weeks.
// This is where week-to-week commission drift is learned.
function learnedRatio(weeks, key, maxWeeks = 6) {
  let num = 0, den = 0;
  weeks.slice(0, maxWeeks).forEach((w, i) => {
    if (w.revenue <= 0) return;
    const weight = Math.pow(0.8, i);
    num += weight * w[key];
    den += weight * w.revenue;
  });
  return den > 0 ? num / den : null;
}

// ---------- revenue model: weekday averages × trend ----------
function weekdayModel(hist) {
  const byDow = Array.from({ length: 7 }, () => ({ num: 0, den: 0, values: [] }));
  const lastDate = hist.length ? hist[hist.length - 1].date : todayStr();
  for (const d of hist) {
    const weeksAgo = Math.floor((Date.parse(lastDate) - Date.parse(d.date)) / (7 * 864e5));
    const w = Math.pow(0.85, weeksAgo);
    byDow[d.dow].num += w * d.revenue;
    byDow[d.dow].den += w;
    byDow[d.dow].values.push(d.revenue);
  }
  const overallMean = hist.length ? hist.reduce((s, d) => s + d.revenue, 0) / hist.length : 0;
  return byDow.map(b => {
    const mean = b.den > 0 ? b.num / b.den : overallMean;
    const n = b.values.length;
    const variance = n > 1
      ? b.values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)
      : (overallMean * 0.35) ** 2; // wide guess when we have almost nothing
    return { mean, sd: Math.sqrt(variance), samples: n };
  });
}

function trendFactor(hist) {
  const cut = addDays(todayStr(), -28);
  const recent = hist.filter(d => d.date >= cut);
  const prior = hist.filter(d => d.date < cut);
  if (recent.length < 7 || prior.length < 7) return 1;
  const rAvg = recent.reduce((s, d) => s + d.revenue, 0) / recent.length;
  const pAvg = prior.reduce((s, d) => s + d.revenue, 0) / prior.length;
  if (pAvg <= 0) return 1;
  return Math.max(0.75, Math.min(1.25, rAvg / pAvg));
}

// ---------- the forecast ----------
function forecast(locationId, horizonDays) {
  const hist = dailyHistory(locationId);
  const weeks = weeklyHistory(hist);
  const model = weekdayModel(hist);
  const trend = trendFactor(hist);

  // Cost ratios learned from recent weeks; fall back to category defaults.
  let commRatio = learnedRatio(weeks, 'commissions');
  let varRatio = learnedRatio(weeks, 'variable');
  let ratioSource = 'learned';
  if (commRatio === null || varRatio === null) {
    ratioSource = 'defaults';
    const p = db.prepare(`SELECT COALESCE(SUM(default_percent),0) p FROM variable_cost_categories
      WHERE location_id = ? AND active = 1 AND entry_mode = 'percent'`).get(locationId).p;
    const c = db.prepare(`SELECT COALESCE(AVG(commission_percent),0) p FROM revenue_categories
      WHERE location_id = ? AND active = 1`).get(locationId).p;
    if (varRatio === null) varRatio = Math.min(p / 100, 0.9);
    if (commRatio === null) commRatio = Math.min(c / 100, 0.5);
  }
  const oneoffPerDay = weeks.length
    ? weeks.reduce((s, w) => s + w.oneoff, 0) / weeks.reduce((s, w) => s + w.days, 0) : 0;

  // Day-by-day projection
  const start = todayStr();
  const end = addDays(start, horizonDays - 1);
  let revenue = 0, variance = 0;
  const daily = [];
  for (let i = 0; i < horizonDays; i++) {
    const date = addDays(start, i);
    const m = model[dow(date)];
    const dayRev = m.mean * trend;
    revenue += dayRev;
    variance += (m.sd * trend) ** 2;
    daily.push({ date, revenue: dayRev });
  }
  const sd = Math.sqrt(variance);

  // Recurring costs are known exactly from the schedule.
  const recurring = calc.recurringForRange(locationId, start, end).total;

  // Team labor, day by day: weeks already scheduled use their real cost;
  // unscheduled future weeks fall back to the most recent scheduled week's
  // daily average. Zero if the scheduler isn't used.
  const laborMap = calc.laborMaps(locationId, start, end);
  let fallbackDaily = 0;
  for (let back = 1; back <= 8; back++) {
    const monday = addDays(start, -((dow(start) + 6) % 7) - back * 7);
    const weekCost = calc.laborForRange(locationId, monday, addDays(monday, 6));
    if (weekCost > 0) { fallbackDaily = weekCost / 7; break; }
  }
  let labor = 0;
  for (let i = 0; i < horizonDays; i++) {
    const date = addDays(start, i);
    const scheduled = laborMap.onDay(date);
    labor += scheduled > 0 ? scheduled : fallbackDaily;
  }

  const scalingCosts = revenue * (varRatio + commRatio);
  const oneoffEst = oneoffPerDay * horizonDays;
  const fixed = recurring + oneoffEst + labor;
  const costs = scalingCosts + fixed;
  const profit = revenue - costs;
  const profitLow = (revenue - sd) - ((revenue - sd) * (varRatio + commRatio) + fixed);
  const profitHigh = (revenue + sd) - ((revenue + sd) * (varRatio + commRatio) + fixed);

  // Break-even for the horizon
  const ratio = varRatio + commRatio;
  const beSales = ratio < 0.99 ? fixed / (1 - ratio) : null;
  let beStatus = 'unknown';
  if (beSales !== null) {
    if (revenue - sd > beSales) beStatus = 'on_track';
    else if (revenue + sd < beSales) beStatus = 'off_track';
    else beStatus = 'close';
  }

  const loggedDays = hist.length;
  const confidence = loggedDays >= 28 ? 'good' : loggedDays >= 14 ? 'medium' : 'low';

  return {
    horizonDays, start, end,
    revenue: { point: revenue, low: Math.max(0, revenue - sd), high: revenue + sd },
    costs: { point: costs, scaling: scalingCosts, recurring, oneoffEst, labor },
    profit: { point: profit, low: profitLow, high: profitHigh },
    ratios: { variable: varRatio, commissions: commRatio, source: ratioSource },
    breakEven: { sales: beSales, status: beStatus },
    trendFactor: trend,
    confidence, loggedDays, daily
  };
}

// Rough cash position ahead: current balance + average daily net movement
// (manual corrections excluded so one-time fixes don't skew the drift).
function accountProjection(locationId, horizonDays) {
  const today = todayStr();
  const view = calc.accountsView(locationId, today, today);
  const start = addDays(today, -28), end = addDays(today, -1);
  const accounts = view.accounts.map(a => {
    const inRow = db.prepare(
      `SELECT COALESCE(SUM(rai.amount),0) v FROM revenue_account_items rai
       JOIN revenue_entries re ON re.id = rai.entry_id
       WHERE re.location_id = ? AND rai.account_id = ? AND re.date BETWEEN ? AND ?`)
      .get(locationId, a.id, start, end).v;
    const outVar = db.prepare(
      `SELECT COALESCE(SUM(amount),0) v FROM variable_costs
       WHERE location_id = ? AND account_id = ? AND date BETWEEN ? AND ?`).get(locationId, a.id, start, end).v;
    const outOne = db.prepare(
      `SELECT COALESCE(SUM(amount),0) v FROM oneoff_costs
       WHERE location_id = ? AND account_id = ? AND date BETWEEN ? AND ?`).get(locationId, a.id, start, end).v;
    const trIn = db.prepare(
      `SELECT COALESCE(SUM(amount),0) v FROM transfers
       WHERE location_id = ? AND to_account_id = ? AND date BETWEEN ? AND ?`).get(locationId, a.id, start, end).v;
    const trOut = db.prepare(
      `SELECT COALESCE(SUM(amount),0) v FROM transfers
       WHERE location_id = ? AND from_account_id = ? AND date BETWEEN ? AND ?`).get(locationId, a.id, start, end).v;
    const recOut = calc.recurringForRange(locationId, start, end); // all; filter by account below
    let recForAccount = 0;
    for (const it of db.prepare(
      `SELECT * FROM recurring_costs WHERE location_id = ? AND active = 1 AND account_id = ?`)
      .all(locationId, a.id)) {
      recForAccount += calc.dailyRate(it) * 28;
    }
    const dailyNet = (inRow + trIn - outVar - outOne - trOut - recForAccount) / 28;
    return { id: a.id, name: a.name, balance: a.balance,
             projected: a.balance + dailyNet * horizonDays, dailyNet };
  });
  return accounts;
}

// ---------- Mexican holidays (restaurant-relevant) ----------
function mexicanHolidays(year) {
  const nthDow = (month, dowWanted, n) => { // month 1-12
    let count = 0;
    for (let day = 1; day <= 31; day++) {
      const d = new Date(Date.UTC(year, month - 1, day));
      if (d.getUTCMonth() !== month - 1) break;
      if (d.getUTCDay() === dowWanted && ++count === n) return d.toISOString().slice(0, 10);
    }
    return null;
  };
  return [
    { date: `${year}-01-01`, name: 'Año Nuevo' },
    { date: `${year}-01-06`, name: 'Día de Reyes' },
    { date: `${year}-02-02`, name: 'Día de la Candelaria' },
    { date: nthDow(2, 1, 1), name: 'Día de la Constitución (puente)' },
    { date: `${year}-02-14`, name: 'San Valentín' },
    { date: nthDow(3, 1, 3), name: 'Natalicio de Benito Juárez (puente)' },
    { date: `${year}-04-30`, name: 'Día del Niño' },
    { date: `${year}-05-01`, name: 'Día del Trabajo' },
    { date: `${year}-05-10`, name: 'Día de las Madres' },
    { date: nthDow(6, 0, 3), name: 'Día del Padre' },
    { date: `${year}-09-15`, name: 'Grito de Independencia' },
    { date: `${year}-09-16`, name: 'Día de la Independencia' },
    { date: `${year}-11-01`, name: 'Día de Muertos' },
    { date: `${year}-11-02`, name: 'Día de Muertos' },
    { date: nthDow(11, 1, 3), name: 'Revolución Mexicana (puente)' },
    { date: `${year}-12-12`, name: 'Virgen de Guadalupe' },
    { date: `${year}-12-24`, name: 'Nochebuena' },
    { date: `${year}-12-25`, name: 'Navidad' },
    { date: `${year}-12-31`, name: 'Fin de Año' }
  ].filter(h => h.date);
}

function upcomingHolidays(horizonDays = 30) {
  const start = todayStr(), end = addDays(start, horizonDays);
  const year = Number(start.slice(0, 4));
  return [...mexicanHolidays(year), ...mexicanHolidays(year + 1)]
    .filter(h => h.date >= start && h.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- insights ----------
function pctChange(now, before) {
  if (!before || before <= 0) return null;
  return (now - before) / before;
}

function insights(locationId) {
  const hist = dailyHistory(locationId, 84);
  const weeks = weeklyHistory(hist).filter(w => w.days >= 3); // ignore fragmentary weeks
  const model = weekdayModel(hist);
  const today = todayStr();
  const out = { enoughData: hist.length >= 7, loggedDays: hist.length };
  if (!out.enoughData) return out;

  // Weekday pattern
  const DAYS_ES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const sampled = model.map((m, i) => ({ day: DAYS_ES[i], mean: m.mean, samples: m.samples }))
    .filter(x => x.samples >= 2);
  out.weekdays = sampled.sort((a, b) => b.mean - a.mean);

  // Channel growth: last 28 days vs prior 28
  const cut = addDays(today, -28), prevCut = addDays(today, -56);
  const chanRows = (a, b) => db.prepare(
    `SELECT c.name, COALESCE(SUM(ri.amount),0) v FROM revenue_items ri
     JOIN revenue_entries re ON re.id = ri.entry_id
     JOIN revenue_categories c ON c.id = ri.category_id
     WHERE re.location_id = ? AND re.date >= ? AND re.date < ? GROUP BY c.id`)
    .all(locationId, a, b);
  const chanNow = chanRows(cut, addDays(today, 1));
  const chanPrev = Object.fromEntries(chanRows(prevCut, cut).map(r => [r.name, r.v]));
  out.channels = chanNow.map(r => ({ name: r.name, now: r.v, change: pctChange(r.v, chanPrev[r.name]) }))
    .filter(r => r.now > 0 || chanPrev[r.name] > 0)
    .sort((a, b) => (b.change ?? -9) - (a.change ?? -9));

  // Cost creep: variable category growth vs revenue growth (same windows)
  const revNow = hist.filter(d => d.date >= cut).reduce((s, d) => s + d.revenue, 0);
  const revPrev = hist.filter(d => d.date >= prevCut && d.date < cut).reduce((s, d) => s + d.revenue, 0);
  const revGrowth = pctChange(revNow, revPrev);
  const costRows = (a, b) => db.prepare(
    `SELECT c.name, COALESCE(SUM(vc.amount),0) v FROM variable_costs vc
     JOIN variable_cost_categories c ON c.id = vc.category_id
     WHERE vc.location_id = ? AND vc.date >= ? AND vc.date < ? GROUP BY c.id`)
    .all(locationId, a, b);
  const costNow = costRows(cut, addDays(today, 1));
  const costPrev = Object.fromEntries(costRows(prevCut, cut).map(r => [r.name, r.v]));
  out.costCreep = costNow.map(r => {
    const change = pctChange(r.v, costPrev[r.name]);
    return { name: r.name, now: r.v, change,
      creeping: change !== null && revGrowth !== null && change > revGrowth + 0.05 && r.v > 0 };
  }).sort((a, b) => (b.change ?? -9) - (a.change ?? -9));
  out.revGrowth = revGrowth;

  // Weekly margin + effective commission rate series (drift the user asked about)
  const yesterday = addDays(today, -1);
  out.weekly = weeks.slice(0, 8).map(w => {
    // Prorate fixed costs for partial weeks so the current week's margin is honest.
    const rec = calc.recurringForRange(locationId, w.week, addDays(w.week, 6)).total * (w.days / 7);
    const weekEnd = addDays(w.week, 6) < yesterday ? addDays(w.week, 6) : yesterday;
    const labor = calc.laborForRange(locationId, w.week, weekEnd);
    const costs = w.variable + w.commissions + w.oneoff + rec + labor;
    return {
      week: w.week, revenue: w.revenue, profit: w.revenue - costs,
      margin: w.revenue > 0 ? (w.revenue - costs) / w.revenue : null,
      commissionRate: w.revenue > 0 ? w.commissions / w.revenue : null
    };
  });
  const margins = out.weekly.filter(w => w.margin !== null).map(w => w.margin);
  out.marginTrend = margins.length >= 3
    ? (margins[0] > margins[margins.length - 1] + 0.02 ? 'improving'
      : margins[0] < margins[margins.length - 1] - 0.02 ? 'declining' : 'stable')
    : 'unknown';
  const commRates = out.weekly.filter(w => w.commissionRate !== null).map(w => w.commissionRate);
  out.commissionDrift = commRates.length >= 2 ? commRates[0] - commRates[commRates.length - 1] : null;

  // Outliers in last 28 days (relative to weekday norm)
  out.outliers = hist.filter(d => d.date >= cut).filter(d => {
    const m = model[d.dow];
    return m.samples >= 3 && m.sd > 0 && Math.abs(d.revenue - m.mean) > 2 * m.sd;
  }).map(d => ({ date: d.date, revenue: d.revenue, expected: model[d.dow].mean }));

  // Records
  const bestDay = hist.reduce((b, d) => d.revenue > (b?.revenue ?? -1) ? d : b, null);
  const worstDay = hist.filter(d => d.revenue > 0).reduce((b, d) => d.revenue < (b?.revenue ?? 1e18) ? d : b, null);
  const fullWeeks = weeks.filter(w => w.days >= 6);
  out.records = {
    bestDay: bestDay ? { date: bestDay.date, revenue: bestDay.revenue } : null,
    worstDay: worstDay ? { date: worstDay.date, revenue: worstDay.revenue } : null,
    bestWeek: fullWeeks.length ? fullWeeks.reduce((b, w) => w.revenue > b.revenue ? w : b) : null,
    worstWeek: fullWeeks.length ? fullWeeks.reduce((b, w) => w.revenue < b.revenue ? w : b) : null
  };

  // Scheduled labor cost per week vs revenue (turn-based)
  const laborWeek = (monday) => {
    const assigned = db.prepare(
      `SELECT t.start_min, t.end_min, e.pay_type, e.rate
       FROM turn_assignments ta JOIN turns t ON t.id = ta.turn_id
       JOIN employees e ON e.id = ta.employee_id
       WHERE t.location_id = ? AND t.date BETWEEN ? AND ?`)
      .all(locationId, monday, addDays(monday, 6));
    if (!assigned.length) return null;
    const hourly = assigned.filter(s => s.pay_type === 'hourly')
      .reduce((sum, s) => sum + ((s.end_min <= s.start_min ? s.end_min + 1440 : s.end_min) - s.start_min) / 60 * s.rate, 0);
    const salaried = db.prepare(
      `SELECT COALESCE(SUM(rate),0) v FROM employees WHERE location_id = ? AND active = 1 AND pay_type = 'salary'`)
      .get(locationId).v;
    return hourly + salaried;
  };
  if (weeks.length >= 2) {
    const l0 = laborWeek(weeks[0].week), l1 = laborWeek(weeks[1].week);
    if (l0 !== null && l1 !== null && l1 > 0 && weeks[1].revenue > 0) {
      const laborGrowth = (l0 - l1) / l1;
      const wRevGrowth = (weeks[0].revenue - weeks[1].revenue) / weeks[1].revenue;
      out.labor = { thisWeek: l0, lastWeek: l1, laborGrowth, revGrowth: wRevGrowth,
        flag: laborGrowth > wRevGrowth + 0.05 };
    }
  }

  out.summary = writeSummary(out);
  return out;
}

// ---------- per-channel behavior: sold vs actually kept after commission ----------
function channelBehavior(locationId) {
  const today = todayStr();
  const start = addDays(today, -55); // 8 weeks
  const rows = db.prepare(
    `SELECT re.date, c.id, c.name, ri.amount, ri.commission_amount
     FROM revenue_items ri
     JOIN revenue_entries re ON re.id = ri.entry_id
     JOIN revenue_categories c ON c.id = ri.category_id
     WHERE re.location_id = ? AND re.date BETWEEN ? AND ?`)
    .all(locationId, start, today);
  if (!rows.length) return { channels: [], weekly: [] };

  const cut = addDays(today, -28);
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const byChannel = {};
  const weeklyTotals = {};
  for (const r of rows) {
    const ch = byChannel[r.id] = byChannel[r.id] || {
      name: r.name, gross: 0, commission: 0,
      recent: 0, prior: 0, weekly: {}, byDow: Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }))
    };
    ch.gross += r.amount; ch.commission += r.commission_amount;
    if (r.date >= cut) ch.recent += r.amount; else ch.prior += r.amount;
    const wk = mondayOf(r.date);
    ch.weekly[wk] = ch.weekly[wk] || { gross: 0, net: 0 };
    ch.weekly[wk].gross += r.amount;
    ch.weekly[wk].net += r.amount - r.commission_amount;
    const d = dow(r.date);
    ch.byDow[d].sum += r.amount; ch.byDow[d].n++;
    const wt = weeklyTotals[wk] = weeklyTotals[wk] || { week: wk, gross: 0, net: 0 };
    wt.gross += r.amount; wt.net += r.amount - r.commission_amount;
  }

  const weeks = Object.keys(weeklyTotals).sort();
  const totalGross = Object.values(byChannel).reduce((s, c) => s + c.gross, 0);
  const channels = Object.values(byChannel).map(c => {
    const samples = c.byDow.reduce((s, d) => s + d.n, 0);
    let bestDay = null;
    if (samples >= 8) {
      const avgs = c.byDow.map((d, i) => ({ day: DAYS[i], avg: d.n ? d.sum / d.n : 0, n: d.n }))
        .filter(x => x.n >= 2);
      if (avgs.length >= 2) bestDay = avgs.reduce((b, x) => x.avg > b.avg ? x : b).day;
    }
    return {
      name: c.name,
      gross: c.gross, commission: c.commission, net: c.gross - c.commission,
      rate: c.gross > 0 ? c.commission / c.gross : 0,
      share: totalGross > 0 ? c.gross / totalGross : 0,
      growth: c.prior > 0 ? (c.recent - c.prior) / c.prior : null,
      bestDay,
      weekly: weeks.map(w => ({ week: w, gross: c.weekly[w]?.gross || 0, net: c.weekly[w]?.net || 0 }))
    };
  }).sort((a, b) => b.gross - a.gross);

  return { channels, weekly: weeks.map(w => weeklyTotals[w]) };
}

// Short plain-language summary assembled from the strongest facts.
function writeSummary(ins) {
  const s = [];
  const w = ins.weekly || [];
  const fmt = v => '$' + Math.round(v).toLocaleString('es-MX');
  if (w.length >= 2 && w[1].revenue > 0) {
    const ch = (w[0].revenue - w[1].revenue) / w[1].revenue;
    s.push(`Sales this week are ${Math.abs(ch * 100).toFixed(0)}% ${ch >= 0 ? 'up' : 'down'} vs last week (${fmt(w[0].revenue)} so far).`);
  }
  if (ins.marginTrend === 'declining') s.push('Your net margin has been slipping over the past few weeks.');
  else if (ins.marginTrend === 'improving') s.push('Your net margin is trending up — whatever changed, it\'s working.');
  const creeps = (ins.costCreep || []).filter(c => c.creeping);
  if (creeps.length) s.push(`${creeps[0].name} is growing faster than your sales — worth a look before it eats the margin.`);
  if (ins.commissionDrift !== null && Math.abs(ins.commissionDrift) > 0.01) {
    s.push(`Your effective commission rate has ${ins.commissionDrift > 0 ? 'risen' : 'fallen'} about ${Math.abs(ins.commissionDrift * 100).toFixed(1)} points over recent weeks as your channel mix shifted.`);
  }
  if (ins.labor?.flag) s.push('Scheduled labor cost is climbing faster than revenue this week.');
  if ((ins.outliers || []).length) {
    const o = ins.outliers[ins.outliers.length - 1];
    s.push(`${o.date} was unusual: ${fmt(o.revenue)} vs a typical ${fmt(o.expected)} for that weekday.`);
  }
  if (ins.weekdays?.length >= 2) {
    s.push(`${ins.weekdays[0].day}s are your strongest days; ${ins.weekdays[ins.weekdays.length - 1].day}s the weakest.`);
  }
  return s.slice(0, 4).join(' ');
}

module.exports = { forecast, accountProjection, upcomingHolidays, insights, channelBehavior };
