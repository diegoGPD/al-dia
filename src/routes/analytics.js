// Dashboard, forecast, insights, goals, and cross-location comparison.
const { db } = require('../db');
const { requireOwner, checkLocation } = require('../auth');
const { num } = require('../lib/parse');
const { badDate, todayStr, addDays, periodBounds, prevPeriodAnchor } = require('../lib/dates');
const calc = require('../calc');
const fc = require('../forecast');

module.exports = (r) => {
  r.get('/dashboard', checkLocation, (req, res) => {
    const granularity = ['day', 'week', 'month'].includes(req.query.granularity) ? req.query.granularity : 'day';
    const anchor = !badDate(req.query.date) ? req.query.date : todayStr();

    const bounds = periodBounds(granularity, anchor);
    const start = bounds.start;
    // For a period still in progress, only count costs accrued up to the anchor
    // date (otherwise a month view on the 5th already carries the whole month's rent).
    const end = bounds.end > anchor && start <= anchor ? anchor : bounds.end;
    const current = calc.summary(req.locationId, start, end);
    current.periodEnd = bounds.end; // full period, for labels
    const be = calc.breakEven(req.locationId, start, end, current);

    // Compare like with like: clamp the previous period to the same number
    // of elapsed days as the current one.
    const prevBounds = periodBounds(granularity, prevPeriodAnchor(granularity, anchor));
    let prevEnd = prevBounds.end;
    if (end < bounds.end) {
      const elapsed = Math.round((Date.parse(end) - Date.parse(start)) / 864e5);
      const clamped = addDays(prevBounds.start, elapsed);
      if (clamped < prevEnd) prevEnd = clamped;
    }
    const previous = calc.summary(req.locationId, prevBounds.start, prevEnd);

    res.json({
      granularity, anchor,
      current, previous,
      breakEven: be,
      benchmarks: calc.benchmarks(current),
      trend: calc.trend(req.locationId, end > anchor ? anchor : end, 30)
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
