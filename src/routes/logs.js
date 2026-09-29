// Daily logging: revenue, day costs, recurring costs, one-offs, CSV import.
const { db } = require('../db');
const { requireOwner, checkLocation } = require('../auth');
const { num, bool01 } = require('../lib/parse');
const { badDate, todayStr, addDays } = require('../lib/dates');
const { upsertDayRevenue } = require('../lib/revenue');
const calc = require('../calc');

module.exports = (r) => {
  // ---- revenue ----
  r.get('/revenue', checkLocation, (req, res) => {
    const { date } = req.query;
    if (badDate(date)) return res.status(400).json({ error: 'Invalid date' });
    const entry = db.prepare('SELECT * FROM revenue_entries WHERE location_id = ? AND date = ?').get(req.locationId, date);
    const items = entry
      ? db.prepare('SELECT category_id, amount, commission_amount, commission_invoiced FROM revenue_items WHERE entry_id = ?').all(entry.id) : [];
    const accountItems = entry
      ? db.prepare('SELECT account_id, amount FROM revenue_account_items WHERE entry_id = ?').all(entry.id) : [];
    res.json({ entry: entry || null, items, accountItems });
  });

  // Upsert a day's revenue. Channel commissions are computed and stored by the
  // shared helper; the optional account split is stored independently.
  r.put('/revenue', checkLocation, (req, res) => {
    const { date, total, items, note, accounts } = req.body;
    if (badDate(date)) return res.status(400).json({ error: 'Invalid date' });
    try {
      const result = upsertDayRevenue(req.locationId, date, {
        total, note: note || null,
        items: Array.isArray(items) ? items : [],
        accounts: Array.isArray(accounts) ? accounts : []
      });
      res.json({ ok: true, ...result });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Move a whole day's revenue log to a different date (wrong-day fixes).
  r.post('/revenue/move', checkLocation, (req, res) => {
    const { from_date, to_date } = req.body;
    if (badDate(from_date) || badDate(to_date)) return res.status(400).json({ error: 'Invalid dates' });
    const entry = db.prepare('SELECT id FROM revenue_entries WHERE location_id = ? AND date = ?')
      .get(req.locationId, from_date);
    if (!entry) return res.status(404).json({ error: 'Nothing logged on that day' });
    const clash = db.prepare('SELECT id FROM revenue_entries WHERE location_id = ? AND date = ?')
      .get(req.locationId, to_date);
    if (clash) return res.status(400).json({ error: `There's already a sales log on ${to_date} — delete or move that one first` });
    db.prepare('UPDATE revenue_entries SET date = ? WHERE id = ?').run(to_date, entry.id);
    res.json({ ok: true });
  });

  r.delete('/revenue', checkLocation, (req, res) => {
    if (badDate(req.query.date)) return res.status(400).json({ error: 'Invalid date' });
    db.prepare('DELETE FROM revenue_entries WHERE location_id = ? AND date = ?').run(req.locationId, req.query.date);
    res.json({ ok: true });
  });

  // ---- day costs ----
  r.get('/costs/day', checkLocation, (req, res) => {
    const { date } = req.query;
    if (badDate(date)) return res.status(400).json({ error: 'Invalid date' });
    const revenue = db.prepare('SELECT total FROM revenue_entries WHERE location_id = ? AND date = ?').get(req.locationId, date);
    const categories = db.prepare(
      `SELECT * FROM variable_cost_categories WHERE location_id = ? AND active = 1 ORDER BY position, id`)
      .all(req.locationId);
    const existing = db.prepare(
      `SELECT category_id, amount, invoiced, account_id FROM variable_costs WHERE location_id = ? AND date = ?`)
      .all(req.locationId, date);
    const accounts = db.prepare(
      'SELECT id, name FROM accounts WHERE location_id = ? AND active = 1 ORDER BY position, id').all(req.locationId);
    res.json({ dayRevenue: revenue ? revenue.total : null, categories, existing, accounts });
  });

  r.put('/costs/day', checkLocation, (req, res) => {
    const { date, rows } = req.body;
    if (badDate(date) || !Array.isArray(rows)) return res.status(400).json({ error: 'Invalid request' });
    const del = db.prepare('DELETE FROM variable_costs WHERE location_id = ? AND date = ? AND category_id = ?');
    const up = db.prepare(
      `INSERT INTO variable_costs (location_id, date, category_id, amount, invoiced, account_id) VALUES (?,?,?,?,?,?)
       ON CONFLICT (location_id, date, category_id) DO UPDATE
         SET amount = excluded.amount, invoiced = excluded.invoiced, account_id = excluded.account_id`);
    for (const row of rows) {
      const amt = num(row.amount);
      if (amt === 0) del.run(req.locationId, date, Number(row.category_id));
      else up.run(req.locationId, date, Number(row.category_id), amt, bool01(row.invoiced),
        row.account_id ? Number(row.account_id) : null);
    }
    res.json({ ok: true });
  });

  r.post('/costs/move', checkLocation, (req, res) => {
    const { from_date, to_date } = req.body;
    if (badDate(from_date) || badDate(to_date)) return res.status(400).json({ error: 'Invalid dates' });
    const rows = db.prepare('SELECT category_id FROM variable_costs WHERE location_id = ? AND date = ?')
      .all(req.locationId, from_date);
    if (!rows.length) return res.status(404).json({ error: 'No costs logged on that day' });
    const clash = db.prepare('SELECT COUNT(*) c FROM variable_costs WHERE location_id = ? AND date = ?')
      .get(req.locationId, to_date).c;
    if (clash) return res.status(400).json({ error: `There are already costs on ${to_date} — edit that day instead` });
    db.prepare('UPDATE variable_costs SET date = ? WHERE location_id = ? AND date = ?')
      .run(to_date, req.locationId, from_date);
    res.json({ ok: true });
  });

  // ---- recurring costs ----
  // A recurring cost can only be erased from history if it never touched a
  // period that's already been reported on: no finished day inside its own
  // date range, and no channel reconciliation overlapping it. Otherwise past
  // totals would silently change, so the cost is ended instead of deleted.
  function periodLocked(locationId, it) {
    const today = todayStr();
    const lastApplied = it.end_date && it.end_date < today ? it.end_date : addDays(today, -1);
    if (it.start_date <= lastApplied) {
      return { locked: true, reason: `it already applied to closed days (${it.start_date} → ${lastApplied})` };
    }
    const recon = db.prepare(
      `SELECT COUNT(*) c FROM channel_reconciliations
        WHERE location_id = ? AND end_date >= ? AND start_date <= ?`)
      .get(locationId, it.start_date, it.end_date || '9999-12-31').c;
    if (recon) return { locked: true, reason: 'it falls inside a reconciled period' };
    return { locked: false, reason: null };
  }

  // Active = no end date yet, or an end date that hasn't passed (inclusive, in
  // America/Monterrey). Ended ones are returned separately so they can sit in
  // their own collapsed section instead of cluttering the live list.
  r.get('/recurring', checkLocation, (req, res) => {
    const rows = db.prepare(
      `SELECT rc.*, c.name AS category_name FROM recurring_costs rc
       JOIN recurring_cost_categories c ON c.id = rc.category_id
       WHERE rc.location_id = ? AND rc.active = 1 ORDER BY c.position, rc.description`)
      .all(req.locationId);
    const today = todayStr();
    const active = [], ended = [];
    for (const it of rows) {
      it.daily = calc.dailyRate(it);
      it.ended = !!(it.end_date && it.end_date < today);
      it.locked = periodLocked(req.locationId, it);   // drives "Delete permanently"
      (it.ended ? ended : active).push(it);
    }
    ended.sort((a, b) => (b.end_date || '').localeCompare(a.end_date || ''));
    res.json({ active, ended });
  });

  r.post('/recurring', requireOwner, checkLocation, (req, res) => {
    const { category_id, description, amount, frequency, invoiced, start_date, end_date, account_id } = req.body;
    if (!category_id || !description || num(amount) <= 0 || !['weekly', 'biweekly', 'monthly'].includes(frequency))
      return res.status(400).json({ error: 'Category, description, amount and frequency are required' });
    const start = !badDate(start_date) ? start_date : todayStr();
    // Empty / null end date = ongoing. If given, it can't be before the start.
    const end = badDate(end_date) ? null : end_date;
    if (end && end < start)
      return res.status(400).json({ error: 'The end date can’t be before the start date.' });
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO recurring_costs (location_id, category_id, description, amount, frequency, invoiced, start_date, end_date, account_id)
       VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(req.locationId, Number(category_id), description.trim(), num(amount), frequency, bool01(invoiced), start, end,
        account_id ? Number(account_id) : null);
    res.json({ id: Number(lastInsertRowid) });
  });

  r.put('/recurring/:id', requireOwner, checkLocation, (req, res) => {
    const it = db.prepare('SELECT * FROM recurring_costs WHERE id = ? AND location_id = ?')
      .get(Number(req.params.id), req.locationId);
    if (!it) return res.status(404).json({ error: 'Not found' });
    const b = req.body;
    const start = !badDate(b.start_date) ? b.start_date : it.start_date;
    // null or '' = ongoing (the form's "Ongoing" toggle sends null).
    const end = (b.end_date === null || b.end_date === '') ? null
      : (!badDate(b.end_date) ? b.end_date : (b.end_date === undefined ? it.end_date : it.end_date));
    if (end && end < start)
      return res.status(400).json({ error: 'The end date can’t be before the start date.' });
    db.prepare(
      `UPDATE recurring_costs SET category_id=?, description=?, amount=?, frequency=?, invoiced=?, start_date=?, end_date=?, account_id=? WHERE id=?`)
      .run(
        b.category_id !== undefined ? Number(b.category_id) : it.category_id,
        b.description !== undefined ? String(b.description).trim() : it.description,
        b.amount !== undefined ? num(b.amount) : it.amount,
        ['weekly', 'biweekly', 'monthly'].includes(b.frequency) ? b.frequency : it.frequency,
        b.invoiced !== undefined ? bool01(b.invoiced) : it.invoiced,
        start, end,
        b.account_id !== undefined ? (b.account_id ? Number(b.account_id) : null) : it.account_id,
        it.id);
    res.json({ ok: true });
  });

  // Two separate outcomes, never mixed up:
  //   mode=end   (default) → stops the cost from today on; every past period
  //                           keeps it, so no historical total moves.
  //   mode=purge           → removes the cost entirely, allowed only when it
  //                           never applied to a closed or reconciled period.
  r.delete('/recurring/:id', requireOwner, checkLocation, (req, res) => {
    const it = db.prepare('SELECT * FROM recurring_costs WHERE id = ? AND location_id = ?')
      .get(Number(req.params.id), req.locationId);
    if (!it) return res.status(404).json({ error: 'Not found' });
    const mode = (req.body?.mode || req.query.mode || 'end').toLowerCase();
    const today = todayStr();

    if (mode === 'purge') {
      const lock = periodLocked(req.locationId, it);
      if (lock.locked) {
        return res.status(409).json({
          error: `“${it.description}” can’t be deleted permanently because ${lock.reason}. End it instead — past periods keep it and future ones stop.`,
          canEnd: true
        });
      }
      db.prepare('DELETE FROM recurring_costs WHERE id = ?').run(it.id);
      return res.json({ ok: true, mode: 'purge' });
    }

    // End today: today is the last day it counts (inclusive), so tomorrow on
    // it no longer spreads. Past periods are untouched.
    const end = today >= it.start_date ? today : it.start_date;
    db.prepare('UPDATE recurring_costs SET end_date = ? WHERE id = ?').run(end, it.id);
    res.json({ ok: true, mode: 'end', end_date: end });
  });

  // Undo an ending: put the cost back on the active list, ongoing again.
  r.post('/recurring/:id/resume', requireOwner, checkLocation, (req, res) => {
    const it = db.prepare('SELECT * FROM recurring_costs WHERE id = ? AND location_id = ?')
      .get(Number(req.params.id), req.locationId);
    if (!it) return res.status(404).json({ error: 'Not found' });
    db.prepare('UPDATE recurring_costs SET end_date = NULL WHERE id = ?').run(it.id);
    res.json({ ok: true });
  });

  // ---- one-off costs ----
  r.get('/oneoff', checkLocation, (req, res) => {
    const { start, end } = req.query;
    if (badDate(start) || badDate(end)) return res.status(400).json({ error: 'Invalid range' });
    res.json(db.prepare(
      `SELECT o.*, c.name category_name FROM oneoff_costs o
       LEFT JOIN variable_cost_categories c ON c.id = o.category_id
       WHERE o.location_id = ? AND o.date BETWEEN ? AND ? ORDER BY o.date DESC, o.id DESC`)
      .all(req.locationId, start, end));
  });

  r.post('/oneoff', checkLocation, (req, res) => {
    const { date, description, amount, invoiced, account_id, category_id } = req.body;
    if (badDate(date) || !description || num(amount) <= 0)
      return res.status(400).json({ error: 'Date, description and amount are required' });
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO oneoff_costs (location_id, date, description, amount, invoiced, account_id, category_id)
       VALUES (?,?,?,?,?,?,?)`)
      .run(req.locationId, date, description.trim(), num(amount), bool01(invoiced),
        account_id ? Number(account_id) : null, category_id ? Number(category_id) : null);
    res.json({ id: Number(lastInsertRowid) });
  });

  r.put('/oneoff/:id', checkLocation, (req, res) => {
    const it = db.prepare('SELECT * FROM oneoff_costs WHERE id = ? AND location_id = ?')
      .get(Number(req.params.id), req.locationId);
    if (!it) return res.status(404).json({ error: 'Not found' });
    const b = req.body;
    db.prepare(`UPDATE oneoff_costs SET date=?, description=?, amount=?, invoiced=?, account_id=?, category_id=?
      WHERE id=?`)
      .run(!badDate(b.date) ? b.date : it.date,
        b.description !== undefined ? String(b.description).trim() : it.description,
        b.amount !== undefined ? num(b.amount) : it.amount,
        b.invoiced !== undefined ? bool01(b.invoiced) : it.invoiced,
        b.account_id !== undefined ? (b.account_id ? Number(b.account_id) : null) : it.account_id,
        b.category_id !== undefined ? (b.category_id ? Number(b.category_id) : null) : it.category_id,
        it.id);
    res.json({ ok: true });
  });

  r.delete('/oneoff/:id', checkLocation, (req, res) => {
    db.prepare('DELETE FROM oneoff_costs WHERE id = ? AND location_id = ?')
      .run(Number(req.params.id), req.locationId);
    res.json({ ok: true });
  });

  // ---- CSV import (rows parsed client-side) ----
  r.post('/import', requireOwner, checkLocation, (req, res) => {
    const { type, rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'No rows to import' });
    if (rows.length > 5000) return res.status(400).json({ error: 'Too many rows (max 5000 per import)' });
    let imported = 0; const errors = [];

    if (type === 'revenue') {
      const hasCategories = rows.some(x => x.category);
      if (hasCategories) {
        const cats = db.prepare(
          'SELECT id, name, commission_percent, commission_invoiced FROM revenue_categories WHERE location_id = ?').all(req.locationId);
        const byName = Object.fromEntries(cats.map(c => [c.name.toLowerCase(), c]));
        const byDate = {};
        rows.forEach((row, i) => {
          if (badDate(row.date)) return errors.push(`Row ${i + 1}: bad date "${row.date}"`);
          const cat = byName[String(row.category || '').toLowerCase().trim()];
          if (!cat) return errors.push(`Row ${i + 1}: unknown revenue category "${row.category}"`);
          const amount = num(row.amount);
          (byDate[row.date] = byDate[row.date] || []).push({
            category_id: cat.id, amount,
            commission: cat.commission_percent ? amount * cat.commission_percent / 100 : 0,
            commission_invoiced: cat.commission_invoiced
          });
        });
        for (const [date, items] of Object.entries(byDate)) {
          const total = items.reduce((s, i) => s + i.amount, 0);
          const existing = db.prepare('SELECT id FROM revenue_entries WHERE location_id = ? AND date = ?').get(req.locationId, date);
          let eid;
          if (existing) {
            eid = existing.id;
            db.prepare('UPDATE revenue_entries SET total = ? WHERE id = ?').run(total, eid);
            db.prepare('DELETE FROM revenue_items WHERE entry_id = ?').run(eid);
          } else {
            eid = Number(db.prepare('INSERT INTO revenue_entries (location_id, date, total) VALUES (?,?,?)')
              .run(req.locationId, date, total).lastInsertRowid);
          }
          const ins = db.prepare(
            'INSERT INTO revenue_items (entry_id, category_id, amount, commission_amount, commission_invoiced) VALUES (?,?,?,?,?)');
          items.forEach(i => ins.run(eid, i.category_id, i.amount, i.commission, i.commission_invoiced));
          imported++;
        }
      } else {
        const up = db.prepare(
          `INSERT INTO revenue_entries (location_id, date, total) VALUES (?,?,?)
           ON CONFLICT (location_id, date) DO UPDATE SET total = excluded.total`);
        rows.forEach((row, i) => {
          if (badDate(row.date)) return errors.push(`Row ${i + 1}: bad date "${row.date}"`);
          up.run(req.locationId, row.date, num(row.total ?? row.amount));
          imported++;
        });
      }
    } else if (type === 'costs') {
      const cats = db.prepare('SELECT id, name, default_invoiced FROM variable_cost_categories WHERE location_id = ?').all(req.locationId);
      const byName = Object.fromEntries(cats.map(c => [c.name.toLowerCase(), c]));
      const up = db.prepare(
        `INSERT INTO variable_costs (location_id, date, category_id, amount, invoiced) VALUES (?,?,?,?,?)
         ON CONFLICT (location_id, date, category_id) DO UPDATE SET amount = excluded.amount, invoiced = excluded.invoiced`);
      const insOne = db.prepare(
        'INSERT INTO oneoff_costs (location_id, date, description, amount, invoiced) VALUES (?,?,?,?,?)');
      rows.forEach((row, i) => {
        if (badDate(row.date)) return errors.push(`Row ${i + 1}: bad date "${row.date}"`);
        const cat = byName[String(row.category || '').toLowerCase().trim()];
        const inv = row.invoiced !== undefined && row.invoiced !== '' ? bool01(row.invoiced) : (cat ? cat.default_invoiced : 0);
        if (cat) { up.run(req.locationId, row.date, cat.id, num(row.amount), inv); imported++; }
        else if (row.description || row.category) {
          insOne.run(req.locationId, row.date, row.description || row.category, num(row.amount), inv);
          imported++;
        } else errors.push(`Row ${i + 1}: no category or description`);
      });
    } else {
      return res.status(400).json({ error: 'Unknown import type' });
    }
    res.json({ imported, errors: errors.slice(0, 20), totalErrors: errors.length });
  });
};
