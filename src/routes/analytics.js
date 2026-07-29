// Dashboard, forecast, insights, goals, and cross-location comparison.
const { db } = require('../db');
const { requireOwner, checkLocation } = require('../auth');
const { num } = require('../lib/parse');
const { badDate, todayStr, addDays, periodBounds, prevPeriodAnchor, effectiveEnd } = require('../lib/dates');
const calc = require('../calc');
const fc = require('../forecast');

module.exports = (r) => {
  r.get('/dashboard', checkLocation, (req, res) => {
    const granularity = ['day', 'week', 'month', 'custom'].includes(req.query.granularity) ? req.query.granularity : 'day';
    const anchor = !badDate(req.query.date) ? req.query.date : todayStr();

    // Custom: explicit start/end; everything else derives from the anchor.
    let bounds;
    if (granularity === 'custom') {
      let s = !badDate(req.query.start) ? req.query.start : todayStr();
      let e = !badDate(req.query.end) ? req.query.end : todayStr();
      if (e < s) [s, e] = [e, s];
      bounds = { start: s, end: e };
    } else {
      bounds = periodBounds(granularity, anchor);
    }
    const start = bounds.start;
    // Finished periods count in full; a period still running stops at today.
    const today = todayStr();
    const end = effectiveEnd(bounds, today);
    const current = calc.summary(req.locationId, start, end);
    current.periodEnd = bounds.end; // full period, for labels
    const be = calc.breakEven(req.locationId, start, end, current);

    // Compare like with like: the immediately preceding period of the same
    // length, clamped to the same number of elapsed days.
    let prevBounds;
    if (granularity === 'custom') {
      const len = Math.round((Date.parse(bounds.end) - Date.parse(start)) / 864e5) + 1;
      prevBounds = { start: addDays(start, -len), end: addDays(start, -1) };
    } else {
      prevBounds = periodBounds(granularity, prevPeriodAnchor(granularity, anchor));
    }
    // Only clamp the comparison when the CURRENT period is genuinely partial
    // (i.e. still running) — never because a past period was truncated.
    let prevEnd = prevBounds.end;
    if (end < bounds.end) {
      const elapsed = Math.round((Date.parse(end) - Date.parse(start)) / 864e5);
      const clamped = addDays(prevBounds.start, elapsed);
      if (clamped < prevEnd) prevEnd = clamped;
    }
    const previous = calc.summary(req.locationId, prevBounds.start, prevEnd);

    // Self-check: the period total must equal the sum of its days.
    const check = granularity === 'day' ? { ok: true, days: 1 }
      : calc.verifyPeriodConsistency(req.locationId, start, end);

    res.json({
      granularity, anchor,
      current, previous,
      breakEven: be,
      benchmarks: calc.benchmarks(current),
      trend: calc.trend(req.locationId, end > today ? today : end, 30),
      consistency: check
    });
  });

  // Per-channel commission table for any period (works with custom ranges).
  // ?channel=<id> isolates one channel; otherwise all are returned.
  r.get('/channels', checkLocation, (req, res) => {
    const granularity = ['day', 'week', 'month', 'custom'].includes(req.query.granularity) ? req.query.granularity : 'day';
    const anchor = !badDate(req.query.date) ? req.query.date : todayStr();
    let bounds;
    if (granularity === 'custom') {
      let s = !badDate(req.query.start) ? req.query.start : todayStr();
      let e = !badDate(req.query.end) ? req.query.end : todayStr();
      if (e < s) [s, e] = [e, s];
      bounds = { start: s, end: e };
    } else {
      bounds = periodBounds(granularity, anchor);
    }
    const end = effectiveEnd(bounds);

    const rows = db.prepare(
      `SELECT c.id, c.name, c.commission_percent config_percent,
              COALESCE(SUM(ri.amount),0) revenue,
              COALESCE(SUM(ri.commission_amount),0) commission,
              COALESCE(SUM(CASE WHEN ri.commission_invoiced = 1 THEN ri.commission_amount ELSE 0 END),0) commission_invoiced,
              COUNT(*) entries
       FROM revenue_categories c
       LEFT JOIN revenue_items ri ON ri.category_id = c.id
       LEFT JOIN revenue_entries re ON re.id = ri.entry_id AND re.date BETWEEN ? AND ?
       WHERE c.location_id = ? AND c.active = 1 AND (re.id IS NOT NULL OR ri.id IS NULL)
       GROUP BY c.id ORDER BY c.position, c.id`)
      .all(bounds.start, end, req.locationId)
      .map(r => ({
        ...r,
        effective_percent: r.revenue > 0 ? r.commission / r.revenue * 100 : null,
        net: r.revenue - r.commission
      }));

    const only = Number(req.query.channel) || null;
    const channels = only ? rows.filter(r => r.id === only) : rows;
    const totals = channels.reduce((t, r) => ({
      revenue: t.revenue + r.revenue,
      commission: t.commission + r.commission,
      net: t.net + r.net
    }), { revenue: 0, commission: 0, net: 0 });
    res.json({
      start: bounds.start, end, periodEnd: bounds.end, granularity,
      channels, totals,
      allChannels: rows.map(r => ({ id: r.id, name: r.name }))
    });
  });

  r.get('/forecast', checkLocation, (req, res) => {
    res.json({
      week: fc.forecast(req.locationId, 7),
      month: fc.forecast(req.locationId, 30),
      accountsWeek: fc.accountProjection(req.locationId, 7),
      accountsMonth: fc.accountProjection(req.locationId, 30),
      holidays: fc.upcomingHolidays(30)
    });
  });

  r.get('/insights', checkLocation, (req, res) => {
    const ins = fc.insights(req.locationId);
    ins.channelStats = fc.channelBehavior(req.locationId);
    ins.goals = db.prepare('SELECT type, target FROM goals WHERE location_id = ?').all(req.locationId);
    // month-to-date baseline for goal pace + the what-if simulator
    const today = todayStr();
    const b = periodBounds('month', today);
    const mtd = calc.summary(req.locationId, b.start, today);
    ins.monthToDate = {
      revenue: mtd.revenue, profit: mtd.profit, netMargin: mtd.netMargin,
      variable: mtd.costs.variable, commissions: mtd.costs.commissions,
      recurring: mtd.costs.recurring, oneoff: mtd.costs.oneoff,
      dayOfMonth: Number(today.slice(8, 10)), daysInMonth: Number(b.end.slice(8, 10))
    };
    res.json(ins);
  });

  r.put('/goals', checkLocation, (req, res) => {
    const { type, target } = req.body;
    if (!['profit', 'margin'].includes(type)) return res.status(400).json({ error: 'Unknown goal type' });
    if (target === null || target === '' || num(target) <= 0) {
      db.prepare('DELETE FROM goals WHERE location_id = ? AND type = ?').run(req.locationId, type);
      return res.json({ ok: true, cleared: true });
    }
    db.prepare(`INSERT INTO goals (location_id, type, target) VALUES (?,?,?)
      ON CONFLICT (location_id, type) DO UPDATE SET target = excluded.target`)
      .run(req.locationId, type, num(target));
    res.json({ ok: true });
  });

  // Month-to-date side-by-side across the owner's locations.
  r.get('/compare', requireOwner, (req, res) => {
    const today = todayStr();
    const b = periodBounds('month', today);
    const rows = db.prepare('SELECT id, name FROM locations WHERE active = 1 ORDER BY name').all()
      .map(loc => {
        const s = calc.summary(loc.id, b.start, today);
        return { id: loc.id, name: loc.name, revenue: s.revenue,
          costs: s.costs.total, profit: s.profit, netMargin: s.netMargin };
      });
    res.json(rows);
  });
};
