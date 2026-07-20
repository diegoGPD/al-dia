// Employee roster and turn-based weekly scheduling:
// define turns per day (label + times), drop people into them.
const { db } = require('../db');
const { checkLocation } = require('../auth');
const { num } = require('../lib/parse');
const { badDate, todayStr, addDays, mondayOf } = require('../lib/dates');
const calc = require('../calc');

const turnHours = t => ((t.end_min <= t.start_min ? t.end_min + 1440 : t.end_min) - t.start_min) / 60;

function scheduleData(locationId, weekMonday) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekMonday, i));
  const sunday = days[6];
  const employees = db.prepare(
    'SELECT * FROM employees WHERE location_id = ? AND active = 1 ORDER BY name').all(locationId);
  const turns = db.prepare(
    'SELECT * FROM turns WHERE location_id = ? AND date BETWEEN ? AND ? ORDER BY date, start_min, position, id')
    .all(locationId, weekMonday, sunday);
  const assignments = turns.length ? db.prepare(
    `SELECT ta.turn_id, ta.employee_id FROM turn_assignments ta
     WHERE ta.turn_id IN (${turns.map(() => '?').join(',')})`).all(...turns.map(t => t.id)) : [];
  for (const t of turns) {
    t.hours = turnHours(t);
    t.employee_ids = assignments.filter(a => a.turn_id === t.id).map(a => a.employee_id);
  }

  const perEmployee = employees.map(e => {
    const own = turns.filter(t => t.employee_ids.includes(e.id));
    const hours = own.reduce((s, t) => s + t.hours, 0);
    const cost = e.pay_type === 'salary' ? e.rate : hours * e.rate;
    return { employee_id: e.id, hours, cost, overtime: hours > 48 };
  });
  const totalCost = perEmployee.reduce((s, x) => s + x.cost, 0);
  const totalHours = perEmployee.reduce((s, x) => s + x.hours, 0);

  const budget = calc.recurringForRange(locationId, weekMonday, sunday).byTag.labor || 0;
  let budgetFlag = 'na';
  if (budget > 0) {
    const dev = (totalCost - budget) / budget;
    budgetFlag = dev > 0.10 ? 'over' : dev < -0.10 ? 'under' : 'ok';
  }
  return { week: weekMonday, days, employees, turns, perEmployee,
           totals: { hours: totalHours, cost: totalCost },
           budget: { amount: budget, flag: budgetFlag } };
}

function turnOwned(locationId, id) {
  return db.prepare('SELECT * FROM turns WHERE id = ? AND location_id = ?').get(Number(id), locationId);
}

module.exports = (r) => {
  // ---- roster (unchanged) ----
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
    const id = Number(req.params.id);
    const used = db.prepare('SELECT COUNT(*) c FROM turn_assignments WHERE employee_id = ?').get(id).c > 0;
    if (used) db.prepare('UPDATE employees SET active = 0 WHERE id = ? AND location_id = ?').run(id, req.locationId);
    else db.prepare('DELETE FROM employees WHERE id = ? AND location_id = ?').run(id, req.locationId);
    res.json({ ok: true, archived: used });
  });

  // ---- schedule ----
  r.get('/schedule', checkLocation, (req, res) => {
    const anchor = !badDate(req.query.week) ? req.query.week : todayStr();
    res.json(scheduleData(req.locationId, mondayOf(anchor)));
  });

  // Turns
  r.post('/schedule/turns', checkLocation, (req, res) => {
    const { date, label, start_min, end_min } = req.body;
    if (badDate(date)) return res.status(400).json({ error: 'Invalid date' });
    const s = Math.max(0, Math.min(1439, num(start_min))), e = Math.max(0, Math.min(1439, num(end_min)));
    if (s === e) return res.status(400).json({ error: 'Start and end are the same' });
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM turns WHERE location_id = ? AND date = ?')
      .get(req.locationId, date).p;
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO turns (location_id, date, label, start_min, end_min, position) VALUES (?,?,?,?,?,?)')
      .run(req.locationId, date, (label || 'Turno').trim().slice(0, 40) || 'Turno', s, e, pos);
    res.json({ id: Number(lastInsertRowid) });
  });

  r.put('/schedule/turns/:id', checkLocation, (req, res) => {
    const t = turnOwned(req.locationId, req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    const b = req.body;
    const s = b.start_min !== undefined ? Math.max(0, Math.min(1439, num(b.start_min))) : t.start_min;
    const e = b.end_min !== undefined ? Math.max(0, Math.min(1439, num(b.end_min))) : t.end_min;
    if (s === e) return res.status(400).json({ error: 'Start and end are the same' });
    db.prepare('UPDATE turns SET label = ?, start_min = ?, end_min = ? WHERE id = ?')
      .run(b.label !== undefined ? String(b.label).trim().slice(0, 40) || 'Turno' : t.label, s, e, t.id);
    res.json({ ok: true });
  });

  r.delete('/schedule/turns/:id', checkLocation, (req, res) => {
    const t = turnOwned(req.locationId, req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM turns WHERE id = ?').run(t.id); // assignments cascade
    res.json({ ok: true });
  });

  // Assignments: drop a name into a turn / take it out
  r.post('/schedule/turns/:id/assign', checkLocation, (req, res) => {
    const t = turnOwned(req.locationId, req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    const emp = db.prepare('SELECT id FROM employees WHERE id = ? AND location_id = ? AND active = 1')
      .get(Number(req.body.employee_id), req.locationId);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    db.prepare('INSERT OR IGNORE INTO turn_assignments (turn_id, employee_id) VALUES (?,?)').run(t.id, emp.id);
    res.json({ ok: true });
  });

  r.delete('/schedule/turns/:id/assign/:employeeId', checkLocation, (req, res) => {
    const t = turnOwned(req.locationId, req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM turn_assignments WHERE turn_id = ? AND employee_id = ?')
      .run(t.id, Number(req.params.employeeId));
    res.json({ ok: true });
  });

  // Copy last week: turns AND who's in them.
  r.post('/schedule/copy-last-week', checkLocation, (req, res) => {
    const week = mondayOf(!badDate(req.body.week) ? req.body.week : todayStr());
    const prevWeek = addDays(week, -7);
    const prevTurns = db.prepare(
      'SELECT * FROM turns WHERE location_id = ? AND date BETWEEN ? AND ?')
      .all(req.locationId, prevWeek, addDays(prevWeek, 6));
    if (!prevTurns.length) return res.status(400).json({ error: 'Last week has no schedule to copy' });
    db.prepare('DELETE FROM turns WHERE location_id = ? AND date BETWEEN ? AND ?')
      .run(req.locationId, week, addDays(week, 6));
    const insT = db.prepare(
      'INSERT INTO turns (location_id, date, label, start_min, end_min, position) VALUES (?,?,?,?,?,?)');
    const insA = db.prepare('INSERT OR IGNORE INTO turn_assignments (turn_id, employee_id) VALUES (?,?)');
    const activeEmp = new Set(db.prepare(
      'SELECT id FROM employees WHERE location_id = ? AND active = 1').all(req.locationId).map(e => e.id));
    let copied = 0;
    for (const t of prevTurns) {
      const newId = Number(insT.run(req.locationId, addDays(t.date, 7), t.label, t.start_min, t.end_min, t.position).lastInsertRowid);
      const people = db.prepare('SELECT employee_id FROM turn_assignments WHERE turn_id = ?').all(t.id);
      people.filter(p => activeEmp.has(p.employee_id)).forEach(p => insA.run(newId, p.employee_id));
      copied++;
    }
    res.json({ ok: true, copied });
  });

  // ---- day templates: save a day's turn structure, apply it anywhere ----
  r.get('/schedule/templates', checkLocation, (req, res) => {
    res.json(db.prepare('SELECT id, name, turns_json FROM turn_templates WHERE location_id = ? ORDER BY name')
      .all(req.locationId).map(t => ({ ...t, turns: JSON.parse(t.turns_json) })));
  });

  r.post('/schedule/templates', checkLocation, (req, res) => {
    const { name, date } = req.body;
    if (!name || badDate(date)) return res.status(400).json({ error: 'Name and date required' });
    const turns = db.prepare(
      'SELECT label, start_min, end_min FROM turns WHERE location_id = ? AND date = ? ORDER BY start_min')
      .all(req.locationId, date);
    if (!turns.length) return res.status(400).json({ error: 'That day has no turns to save' });
    db.prepare('INSERT INTO turn_templates (location_id, name, turns_json) VALUES (?,?,?)')
      .run(req.locationId, String(name).trim().slice(0, 40), JSON.stringify(turns));
    res.json({ ok: true, turns: turns.length });
  });

  r.post('/schedule/templates/:id/apply', checkLocation, (req, res) => {
    const tpl = db.prepare('SELECT * FROM turn_templates WHERE id = ? AND location_id = ?')
      .get(Number(req.params.id), req.locationId);
    if (!tpl) return res.status(404).json({ error: 'Not found' });
    const { date } = req.body;
    if (badDate(date)) return res.status(400).json({ error: 'Invalid date' });
    db.prepare('DELETE FROM turns WHERE location_id = ? AND date = ?').run(req.locationId, date);
    const ins = db.prepare(
      'INSERT INTO turns (location_id, date, label, start_min, end_min, position) VALUES (?,?,?,?,?,?)');
    JSON.parse(tpl.turns_json).forEach((t, i) =>
      ins.run(req.locationId, date, t.label, t.start_min, t.end_min, i));
    res.json({ ok: true });
  });

  r.delete('/schedule/templates/:id', checkLocation, (req, res) => {
    db.prepare('DELETE FROM turn_templates WHERE id = ? AND location_id = ?')
      .run(Number(req.params.id), req.locationId);
    res.json({ ok: true });
  });
};
