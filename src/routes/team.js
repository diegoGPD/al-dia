// Employee roster and turn-based weekly scheduling:
// define turns per day (label + times), drop people into them.
const { db } = require('../db');
const { checkLocation } = require('../auth');
const { num } = require('../lib/parse');
const { badDate, todayStr, addDays, mondayOf } = require('../lib/dates');
// (activeOn is defined below and shared by scheduling + assignment validation)
const calc = require('../calc');

const turnHours = t => ((t.end_min <= t.start_min ? t.end_min + 1440 : t.end_min) - t.start_min) / 60;
const activeOn = (e, date) =>
  (e.start_date || '0000-01-01') <= date && (!e.end_date || e.end_date >= date);

function scheduleData(locationId, weekMonday) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekMonday, i));
  const sunday = days[6];
  // Everyone who could work any day this week, plus anyone already assigned
  // (so historical weeks still show who was there, marked as former).
  const employees = db.prepare(
    `SELECT e.*, t.name tag_name, t.color tag_color FROM employees e
     LEFT JOIN staff_tags t ON t.id = e.tag_id
     WHERE e.location_id = ? AND e.active = 1
       AND COALESCE(e.start_date,'0000-01-01') <= ? AND (e.end_date IS NULL OR e.end_date >= ?)
     ORDER BY e.name`).all(locationId, sunday, weekMonday);
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
  // Anyone assigned but no longer employed on that week (legacy data) is still
  // shown, flagged, and costs nothing.
  const shownIds = new Set(employees.map(e => e.id));
  const extraIds = [...new Set(assignments.map(a => a.employee_id))].filter(id => !shownIds.has(id));
  if (extraIds.length) {
    const extras = db.prepare(
      `SELECT * FROM employees WHERE id IN (${extraIds.map(() => '?').join(',')})`).all(...extraIds);
    extras.forEach(e => { e.former = 1; employees.push(e); });
    employees.sort((a, b) => a.name.localeCompare(b.name));
  }

  const perEmployee = employees.map(e => {
    // Only turns on days this person was actually employed count.
    const own = turns.filter(t => t.employee_ids.includes(e.id) && activeOn(e, t.date));
    const hours = own.reduce((s, t) => s + t.hours, 0);
    const salaryDays = days.filter(d => activeOn(e, d) && turns.some(t => t.employee_ids.length)).length;
    const cost = e.pay_type === 'salary' ? e.rate * (salaryDays / 7) : hours * e.rate;
    return { employee_id: e.id, hours, cost, overtime: hours > 48 };
  });
  const totalCost = perEmployee.reduce((s, x) => s + x.cost, 0);
  const totalHours = perEmployee.reduce((s, x) => s + x.hours, 0);

  const closed = db.prepare(
    'SELECT date FROM closed_days WHERE location_id = ? AND date BETWEEN ? AND ?')
    .all(locationId, weekMonday, sunday).map(r => r.date);

  const budget = calc.recurringForRange(locationId, weekMonday, sunday).byTag.labor || 0;
  let budgetFlag = 'na';
  if (budget > 0) {
    const dev = (totalCost - budget) / budget;
    budgetFlag = dev > 0.10 ? 'over' : dev < -0.10 ? 'under' : 'ok';
  }
  // Shift rows for the grid: one row per distinct label+times, with the
  // per-day turn (if any) hanging off it.
  const rows = [];
  for (const t of turns) {
    const key = `${t.label}|${t.start_min}|${t.end_min}`;
    let row = rows.find(r => r.key === key);
    if (!row) {
      row = { key, label: t.label, start_min: t.start_min, end_min: t.end_min,
              hours: t.hours, color: t.color || null, byDate: {} };
      rows.push(row);
    }
    if (!row.color && t.color) row.color = t.color;
    row.byDate[t.date] = { id: t.id, employee_ids: t.employee_ids };
  }
  rows.sort((a, b) => a.start_min - b.start_min || a.label.localeCompare(b.label));

  const tags = db.prepare(
    'SELECT * FROM staff_tags WHERE location_id = ? ORDER BY position, id').all(locationId);

  return { week: weekMonday, days, employees, turns, rows, closed, tags, perEmployee,
           totals: { hours: totalHours, cost: totalCost },
           budget: { amount: budget, flag: budgetFlag } };
}

function turnOwned(locationId, id) {
  return db.prepare('SELECT * FROM turns WHERE id = ? AND location_id = ?').get(Number(id), locationId);
}

module.exports = (r) => {
  // ---- roster (unchanged) ----
  // ?former=1 includes people whose end date has passed.
  r.get('/employees', checkLocation, (req, res) => {
    const today = todayStr();
    const rows = db.prepare(
      `SELECT e.*, t.name tag_name, t.color tag_color FROM employees e
       LEFT JOIN staff_tags t ON t.id = e.tag_id
       WHERE e.location_id = ? AND e.active = 1 ORDER BY e.name`).all(req.locationId);
    const withFlag = rows.map(e => ({ ...e, former: e.end_date && e.end_date < today ? 1 : 0 }));
    res.json(req.query.former === '1' ? withFlag : withFlag.filter(e => !e.former));
  });

  r.post('/employees', checkLocation, (req, res) => {
    const { name, position, pay_type, rate, start_date, end_date, tag_id } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name required' });
    const start = !badDate(start_date) ? start_date : todayStr();
    const end = !badDate(end_date) ? end_date : null;
    if (end && end < start) return res.status(400).json({ error: 'End date is before the start date' });
    const tag = tag_id ? db.prepare('SELECT * FROM staff_tags WHERE id = ? AND location_id = ?')
      .get(Number(tag_id), req.locationId) : null;
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO employees (location_id, name, position, pay_type, rate, start_date, end_date, tag_id)
       VALUES (?,?,?,?,?,?,?,?)`)
      .run(req.locationId, String(name).trim(), tag ? tag.name : ((position || '').trim() || null),
        pay_type === 'salary' ? 'salary' : 'hourly', num(rate), start, end, tag ? tag.id : null);
    res.json({ id: Number(lastInsertRowid) });
  });

  r.put('/employees/:id', checkLocation, (req, res) => {
    const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND location_id = ?')
      .get(Number(req.params.id), req.locationId);
    if (!emp) return res.status(404).json({ error: 'Not found' });
    const b = req.body;
    const start = b.start_date !== undefined
      ? (!badDate(b.start_date) ? b.start_date : emp.start_date) : emp.start_date;
    const end = b.end_date !== undefined
      ? (b.end_date === null || b.end_date === '' ? null : (!badDate(b.end_date) ? b.end_date : emp.end_date))
      : emp.end_date;
    if (end && start && end < start) return res.status(400).json({ error: 'End date is before the start date' });
    const tagId = b.tag_id !== undefined ? (b.tag_id ? Number(b.tag_id) : null) : emp.tag_id;
    const tag = tagId ? db.prepare('SELECT * FROM staff_tags WHERE id = ? AND location_id = ?')
      .get(tagId, req.locationId) : null;
    db.prepare(`UPDATE employees SET name=?, position=?, pay_type=?, rate=?, start_date=?, end_date=?, tag_id=?
      WHERE id=?`)
      .run(b.name !== undefined ? String(b.name).trim() : emp.name,
        tag ? tag.name : (b.position !== undefined ? ((b.position || '').trim() || null) : emp.position),
        b.pay_type !== undefined ? (b.pay_type === 'salary' ? 'salary' : 'hourly') : emp.pay_type,
        b.rate !== undefined ? num(b.rate) : emp.rate, start, end, tag ? tag.id : null, emp.id);
    res.json({ ok: true });
  });

  // What would be affected by removing this person — shown before deciding.
  r.get('/employees/:id/impact', checkLocation, (req, res) => {
    const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND location_id = ?')
      .get(Number(req.params.id), req.locationId);
    if (!emp) return res.status(404).json({ error: 'Not found' });
    const today = todayStr();
    const upcoming = db.prepare(
      `SELECT t.date, t.label FROM turn_assignments ta JOIN turns t ON t.id = ta.turn_id
       WHERE ta.employee_id = ? AND t.date >= ? ORDER BY t.date`).all(emp.id, today);
    const past = db.prepare(
      `SELECT COUNT(*) c FROM turn_assignments ta JOIN turns t ON t.id = ta.turn_id
       WHERE ta.employee_id = ? AND t.date < ?`).get(emp.id, today).c;
    res.json({
      name: emp.name, start_date: emp.start_date, end_date: emp.end_date,
      upcomingCount: upcoming.length, upcomingDates: upcoming.map(u => u.date),
      pastCount: past
    });
  });

  // mode=former  -> keep the record, set an end date, history preserved
  // mode=purge   -> delete the record and everything attached to it
  // clear_upcoming=1 -> also strip them from turns dated today or later
  r.delete('/employees/:id', checkLocation, (req, res) => {
    const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND location_id = ?')
      .get(Number(req.params.id), req.locationId);
    if (!emp) return res.status(404).json({ error: 'Not found' });
    const today = todayStr();
    const mode = req.query.mode === 'purge' ? 'purge' : 'former';
    let cleared = 0;

    // Never touch shifts before today: historical labor cost stays intact.
    if (req.query.clear_upcoming === '1' || mode === 'purge') {
      cleared = db.prepare(
        `DELETE FROM turn_assignments WHERE employee_id = ? AND turn_id IN
           (SELECT id FROM turns WHERE location_id = ? AND date >= ?)`)
        .run(emp.id, req.locationId, today).changes;
    }

    if (mode === 'purge') {
      // Historical assignments go too — this is the irreversible option.
      db.prepare('DELETE FROM turn_assignments WHERE employee_id = ?').run(emp.id);
      db.prepare('DELETE FROM employees WHERE id = ? AND location_id = ?').run(emp.id, req.locationId);
      return res.json({ ok: true, mode, cleared, purged: true });
    }

    const endDate = !badDate(req.query.end_date) ? req.query.end_date : addDays(today, -1);
    db.prepare('UPDATE employees SET end_date = ?, active = 1 WHERE id = ?').run(endDate, emp.id);
    res.json({ ok: true, mode, cleared, end_date: endDate });
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
    const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND location_id = ? AND active = 1')
      .get(Number(req.body.employee_id), req.locationId);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    if (!activeOn(emp, t.date))
      return res.status(400).json({ error: `${emp.name} wasn't employed on ${t.date}` });
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

  // ---- staff role tags ----
  r.get('/staff-tags', checkLocation, (req, res) => {
    res.json(db.prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM employees e WHERE e.tag_id = t.id AND e.active = 1) people
       FROM staff_tags t WHERE t.location_id = ? ORDER BY t.position, t.id`).all(req.locationId));
  });

  r.post('/staff-tags', checkLocation, (req, res) => {
    const name = (req.body.name || '').trim().slice(0, 30);
    if (!name) return res.status(400).json({ error: 'Name required' });
    const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM staff_tags WHERE location_id = ?')
      .get(req.locationId).p;
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO staff_tags (location_id, name, color, position) VALUES (?,?,?,?)')
      .run(req.locationId, name, (req.body.color || '#1a7f5a').slice(0, 9), pos);
    res.json({ id: Number(lastInsertRowid), name });
  });

  r.put('/staff-tags/:id', checkLocation, (req, res) => {
    const tag = db.prepare('SELECT * FROM staff_tags WHERE id = ? AND location_id = ?')
      .get(Number(req.params.id), req.locationId);
    if (!tag) return res.status(404).json({ error: 'Not found' });
    db.prepare('UPDATE staff_tags SET name = ?, color = ? WHERE id = ?')
      .run(req.body.name !== undefined ? String(req.body.name).trim().slice(0, 30) || tag.name : tag.name,
        req.body.color || tag.color, tag.id);
    res.json({ ok: true });
  });

  r.delete('/staff-tags/:id', checkLocation, (req, res) => {
    const id = Number(req.params.id);
    db.prepare('UPDATE employees SET tag_id = NULL WHERE tag_id = ? AND location_id = ?').run(id, req.locationId);
    db.prepare('DELETE FROM staff_tags WHERE id = ? AND location_id = ?').run(id, req.locationId);
    res.json({ ok: true });
  });

  // ---- closed days: black out a whole column at once ----
  r.post('/schedule/closed', checkLocation, (req, res) => {
    const { date, closed, clear } = req.body;
    if (badDate(date)) return res.status(400).json({ error: 'Invalid date' });
    let cleared = 0;
    if (closed) {
      db.prepare('INSERT OR IGNORE INTO closed_days (location_id, date) VALUES (?,?)')
        .run(req.locationId, date);
      if (clear !== false) {
        // Nobody works on a closed day — drop that day's assignments (the turn
        // rows themselves stay, so reopening restores the layout).
        cleared = db.prepare(
          `DELETE FROM turn_assignments WHERE turn_id IN
             (SELECT id FROM turns WHERE location_id = ? AND date = ?)`)
          .run(req.locationId, date).changes;
      }
    } else {
      db.prepare('DELETE FROM closed_days WHERE location_id = ? AND date = ?')
        .run(req.locationId, date);
    }
    res.json({ ok: true, closed: !!closed, cleared });
  });

  // ---- shift rows: create/edit/delete a row across the whole week ----
  // A row is a label+times; the per-day turns are created on demand.
  r.post('/schedule/rows', checkLocation, (req, res) => {
    const { week, label, start_min, end_min, color, days } = req.body;
    if (badDate(week)) return res.status(400).json({ error: 'Invalid week' });
    const s = Math.max(0, Math.min(1439, num(start_min))), e = Math.max(0, Math.min(1439, num(end_min)));
    if (s === e) return res.status(400).json({ error: 'Start and end are the same' });
    const monday = mondayOf(week);
    const closedSet = new Set(db.prepare(
      'SELECT date FROM closed_days WHERE location_id = ? AND date BETWEEN ? AND ?')
      .all(req.locationId, monday, addDays(monday, 6)).map(x => x.date));
    const wanted = Array.isArray(days) && days.length
      ? days.filter(d => !badDate(d))
      : Array.from({ length: 7 }, (_, i) => addDays(monday, i));
    const ins = db.prepare(
      'INSERT INTO turns (location_id, date, label, start_min, end_min, position, color) VALUES (?,?,?,?,?,?,?)');
    let created = 0;
    for (const d of wanted) {
      if (closedSet.has(d)) continue;
      const exists = db.prepare(
        'SELECT id FROM turns WHERE location_id = ? AND date = ? AND label = ? AND start_min = ? AND end_min = ?')
        .get(req.locationId, d, (label || 'Turno').trim(), s, e);
      if (exists) continue;
      ins.run(req.locationId, d, (label || 'Turno').trim().slice(0, 40) || 'Turno', s, e, s, color || null);
      created++;
    }
    res.json({ ok: true, created });
  });

  // Edit or delete every turn belonging to one row of the grid, for this week.
  r.put('/schedule/rows', checkLocation, (req, res) => {
    const { week, key, label, start_min, end_min, color } = req.body;
    if (badDate(week) || !key) return res.status(400).json({ error: 'Invalid request' });
    const [oldLabel, oldStart, oldEnd] = String(key).split('|');
    const monday = mondayOf(week);
    const s = start_min !== undefined ? Math.max(0, Math.min(1439, num(start_min))) : Number(oldStart);
    const e = end_min !== undefined ? Math.max(0, Math.min(1439, num(end_min))) : Number(oldEnd);
    if (s === e) return res.status(400).json({ error: 'Start and end are the same' });
    const changed = db.prepare(
      `UPDATE turns SET label = ?, start_min = ?, end_min = ?, color = ?
       WHERE location_id = ? AND date BETWEEN ? AND ? AND label = ? AND start_min = ? AND end_min = ?`)
      .run(label !== undefined ? String(label).trim().slice(0, 40) || 'Turno' : oldLabel, s, e,
        color !== undefined ? color : null,
        req.locationId, monday, addDays(monday, 6), oldLabel, Number(oldStart), Number(oldEnd)).changes;
    res.json({ ok: true, changed });
  });

  r.delete('/schedule/rows', checkLocation, (req, res) => {
    const { week, key } = req.query;
    if (badDate(week) || !key) return res.status(400).json({ error: 'Invalid request' });
    const [label, start, end] = String(key).split('|');
    const monday = mondayOf(week);
    const changed = db.prepare(
      `DELETE FROM turns WHERE location_id = ? AND date BETWEEN ? AND ?
         AND label = ? AND start_min = ? AND end_min = ?`)
      .run(req.locationId, monday, addDays(monday, 6), label, Number(start), Number(end)).changes;
    res.json({ ok: true, changed });
  });

  // Assign into a grid cell, creating that day's turn if it doesn't exist yet.
  r.post('/schedule/cell', checkLocation, (req, res) => {
    const { date, key, employee_id, color } = req.body;
    if (badDate(date) || !key) return res.status(400).json({ error: 'Invalid request' });
    if (db.prepare('SELECT 1 x FROM closed_days WHERE location_id = ? AND date = ?').get(req.locationId, date))
      return res.status(400).json({ error: 'That day is marked closed' });
    const [label, start, end] = String(key).split('|');
    let turn = db.prepare(
      `SELECT id FROM turns WHERE location_id = ? AND date = ? AND label = ? AND start_min = ? AND end_min = ?`)
      .get(req.locationId, date, label, Number(start), Number(end));
    if (!turn) {
      turn = { id: Number(db.prepare(
        'INSERT INTO turns (location_id, date, label, start_min, end_min, position, color) VALUES (?,?,?,?,?,?,?)')
        .run(req.locationId, date, label, Number(start), Number(end), Number(start), color || null).lastInsertRowid) };
    }
    const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND location_id = ? AND active = 1')
      .get(Number(employee_id), req.locationId);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    if (!activeOn(emp, date))
      return res.status(400).json({ error: `${emp.name} wasn't employed on ${date}` });
    db.prepare('INSERT OR IGNORE INTO turn_assignments (turn_id, employee_id) VALUES (?,?)').run(turn.id, emp.id);
    res.json({ ok: true, turn_id: turn.id });
  });

  // Batch save: everything the user staged in the schedule editor, applied in
  // one transaction so the schedule is never half-updated.
  r.post('/schedule/assignments', checkLocation, (req, res) => {
    const adds = Array.isArray(req.body.adds) ? req.body.adds : [];
    const removes = Array.isArray(req.body.removes) ? req.body.removes : [];
    const turnIds = [...new Set([...adds, ...removes].map(x => Number(x.turn_id)))];
    if (!turnIds.length) return res.json({ ok: true, added: 0, removed: 0 });

    const turns = Object.fromEntries(db.prepare(
      `SELECT id, date FROM turns WHERE location_id = ? AND id IN (${turnIds.map(() => '?').join(',')})`)
      .all(req.locationId, ...turnIds).map(t => [t.id, t]));
    const emps = Object.fromEntries(db.prepare(
      'SELECT * FROM employees WHERE location_id = ? AND active = 1').all(req.locationId).map(e => [e.id, e]));

    const errors = [];
    for (const a of adds) {
      const t = turns[Number(a.turn_id)], e = emps[Number(a.employee_id)];
      if (!t || !e) { errors.push('Unknown turn or employee'); continue; }
      if (!activeOn(e, t.date)) errors.push(`${e.name} wasn't employed on ${t.date}`);
    }
    if (errors.length) return res.status(400).json({ error: errors[0], errors });

    const insA = db.prepare('INSERT OR IGNORE INTO turn_assignments (turn_id, employee_id) VALUES (?,?)');
    const delA = db.prepare('DELETE FROM turn_assignments WHERE turn_id = ? AND employee_id = ?');
    let added = 0, removed = 0;
    db.exec('BEGIN');
    try {
      for (const x of removes) {
        if (turns[Number(x.turn_id)]) removed += delA.run(Number(x.turn_id), Number(x.employee_id)).changes;
      }
      for (const x of adds) {
        if (turns[Number(x.turn_id)]) added += insA.run(Number(x.turn_id), Number(x.employee_id)).changes;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      return res.status(500).json({ error: 'Could not save the schedule changes' });
    }
    res.json({ ok: true, added, removed });
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
    const roster = db.prepare(
      'SELECT * FROM employees WHERE location_id = ? AND active = 1').all(req.locationId);
    const byId = Object.fromEntries(roster.map(e => [e.id, e]));
    let copied = 0;
    for (const t of prevTurns) {
      const newDate = addDays(t.date, 7);
      const newId = Number(insT.run(req.locationId, newDate, t.label, t.start_min, t.end_min, t.position).lastInsertRowid);
      const people = db.prepare('SELECT employee_id FROM turn_assignments WHERE turn_id = ?').all(t.id);
      // Skip anyone who has since left (or hasn't started) by the new date.
      people.filter(p => byId[p.employee_id] && activeOn(byId[p.employee_id], newDate))
        .forEach(p => insA.run(newId, p.employee_id));
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
