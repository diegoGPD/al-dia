// Employee roster and the weekly schedule.
const { db } = require('../db');
const { checkLocation } = require('../auth');
const { num } = require('../lib/parse');
const { badDate, todayStr, addDays, mondayOf } = require('../lib/dates');
const calc = require('../calc');

const shiftHours = s => ((s.end_min <= s.start_min ? s.end_min + 1440 : s.end_min) - s.start_min) / 60;

function scheduleData(locationId, weekMonday) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekMonday, i));
  const sunday = days[6];
  const employees = db.prepare(
    'SELECT * FROM employees WHERE location_id = ? AND active = 1 ORDER BY name').all(locationId);
  const shifts = db.prepare(
    'SELECT * FROM shifts WHERE location_id = ? AND date BETWEEN ? AND ?').all(locationId, weekMonday, sunday);

  const perEmployee = employees.map(e => {
    const own = shifts.filter(s => s.employee_id === e.id);
    const hours = own.reduce((sum, s) => sum + shiftHours(s), 0);
    const cost = e.pay_type === 'salary' ? e.rate : hours * e.rate;
    return { employee_id: e.id, hours, cost, overtime: hours > 48 };
  });
  const totalCost = perEmployee.reduce((s, x) => s + x.cost, 0);
  const totalHours = perEmployee.reduce((s, x) => s + x.hours, 0);

  // Budgeted payroll = recurring costs in labor-tagged categories, for this week.
  const budget = calc.recurringForRange(locationId, weekMonday, sunday).byTag.labor || 0;
  let budgetFlag = 'na';
  if (budget > 0) {
    const dev = (totalCost - budget) / budget;
    budgetFlag = dev > 0.10 ? 'over' : dev < -0.10 ? 'under' : 'ok';
  }
  return { week: weekMonday, days, employees, shifts, perEmployee,
           totals: { hours: totalHours, cost: totalCost },
           budget: { amount: budget, flag: budgetFlag } };
}

module.exports = (r) => {
  // ---- roster ----
  r.get('/employees', checkLocation, (req, res) => {
    res.json(db.prepare(
      'SELECT * FROM employees WHERE location_id = ? AND active = 1 ORDER BY name').all(req.locationId));
  });

  r.post('/employees', checkLocation, (req, res) => {
    const { name, position, pay_type, rate } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO employees (location_id, name, position, pay_type, rate) VALUES (?,?,?,?,?)')
      .run(req.locationId, String(name).trim(), (position || '').trim() || null,
        pay_type === 'salary' ? 'salary' : 'hourly', num(rate));
    res.json({ id: Number(lastInsertRowid) });
  });

  r.put('/employees/:id', checkLocation, (req, res) => {
    const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND location_id = ?')
      .get(Number(req.params.id), req.locationId);
    if (!emp) return res.status(404).json({ error: 'Not found' });
    const b = req.body;
    db.prepare('UPDATE employees SET name=?, position=?, pay_type=?, rate=? WHERE id=?')
      .run(b.name !== undefined ? String(b.name).trim() : emp.name,
        b.position !== undefined ? ((b.position || '').trim() || null) : emp.position,
        b.pay_type !== undefined ? (b.pay_type === 'salary' ? 'salary' : 'hourly') : emp.pay_type,
        b.rate !== undefined ? num(b.rate) : emp.rate, emp.id);
    res.json({ ok: true });
  });

  r.delete('/employees/:id', checkLocation, (req, res) => {
    // Keep shift history: archive if they have shifts, delete outright otherwise.
    const id = Number(req.params.id);
    const used = db.prepare('SELECT COUNT(*) c FROM shifts WHERE employee_id = ?').get(id).c > 0;
    if (used) db.prepare('UPDATE employees SET active = 0 WHERE id = ? AND location_id = ?').run(id, req.locationId);
    else db.prepare('DELETE FROM employees WHERE id = ? AND location_id = ?').run(id, req.locationId);
    res.json({ ok: true, archived: used });
  });

  // ---- schedule ----
  r.get('/schedule', checkLocation, (req, res) => {
    const anchor = !badDate(req.query.week) ? req.query.week : todayStr();
    res.json(scheduleData(req.locationId, mondayOf(anchor)));
  });

  // Upsert one cell. Times in minutes from midnight; equal times = clear the cell.
  r.put('/schedule/shift', checkLocation, (req, res) => {
    const { employee_id, date, start_min, end_min } = req.body;
    if (badDate(date)) return res.status(400).json({ error: 'Invalid date' });
    const emp = db.prepare('SELECT id FROM employees WHERE id = ? AND location_id = ?')
      .get(Number(employee_id), req.locationId);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const s = Math.max(0, Math.min(1439, num(start_min))), e = Math.max(0, Math.min(1439, num(end_min)));
    if (s === e) {
      db.prepare('DELETE FROM shifts WHERE employee_id = ? AND date = ?').run(emp.id, date);
    } else {
      db.prepare(
        `INSERT INTO shifts (location_id, employee_id, date, start_min, end_min) VALUES (?,?,?,?,?)
         ON CONFLICT (employee_id, date) DO UPDATE SET start_min = excluded.start_min, end_min = excluded.end_min`)
        .run(req.locationId, emp.id, date, s, e);
    }
    res.json({ ok: true });
  });

  r.delete('/schedule/shift', checkLocation, (req, res) => {
    const { employee_id, date } = req.query;
    if (badDate(date)) return res.status(400).json({ error: 'Invalid date' });
    db.prepare(`DELETE FROM shifts WHERE employee_id = ? AND date = ? AND location_id = ?`)
      .run(Number(employee_id), date, req.locationId);
    res.json({ ok: true });
  });

  // Replace the target week with a copy of the previous week's shifts.
  r.post('/schedule/copy-last-week', checkLocation, (req, res) => {
    const week = mondayOf(!badDate(req.body.week) ? req.body.week : todayStr());
    const prevWeek = addDays(week, -7);
    const prev = db.prepare(
      'SELECT s.* FROM shifts s JOIN employees e ON e.id = s.employee_id AND e.active = 1 ' +
      'WHERE s.location_id = ? AND s.date BETWEEN ? AND ?')
      .all(req.locationId, prevWeek, addDays(prevWeek, 6));
    if (!prev.length) return res.status(400).json({ error: 'Last week has no schedule to copy' });
    db.prepare('DELETE FROM shifts WHERE location_id = ? AND date BETWEEN ? AND ?')
      .run(req.locationId, week, addDays(week, 6));
    const ins = db.prepare(
      'INSERT INTO shifts (location_id, employee_id, date, start_min, end_min) VALUES (?,?,?,?,?)');
    prev.forEach(s => ins.run(req.locationId, s.employee_id, addDays(s.date, 7), s.start_min, s.end_min));
    res.json({ ok: true, copied: prev.length });
  });
};
