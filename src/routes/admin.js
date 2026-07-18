// Session identity + owner administration: locations, users, maintenance.
const bcrypt = require('bcryptjs');
const { db, createLocation } = require('../db');
const { requireOwner, checkLocation } = require('../auth');

module.exports = (r) => {
  r.get('/me', (req, res) => {
    const locations = db.prepare(
      `SELECT id, name FROM locations WHERE active = 1 AND id IN (${req.user.locationIds.map(() => '?').join(',') || 'NULL'}) ORDER BY name`)
      .all(...req.user.locationIds);
    res.json({
      user: { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role },
      locations,
      demo: process.env.DEMO_MODE === '1'
    });
  });

  // ---- locations ----
  r.post('/locations', requireOwner, (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name required' });
    res.json({ id: createLocation(name) });
  });

  r.put('/locations/:id', requireOwner, (req, res) => {
    db.prepare('UPDATE locations SET name = ? WHERE id = ?').run((req.body.name || '').trim(), Number(req.params.id));
    res.json({ ok: true });
  });

  r.delete('/locations/:id', requireOwner, (req, res) => {
    const count = db.prepare('SELECT COUNT(*) c FROM locations WHERE active = 1').get().c;
    if (count <= 1) return res.status(400).json({ error: 'You need at least one location' });
    db.prepare('UPDATE locations SET active = 0 WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // ---- users ----
  r.get('/users', requireOwner, (req, res) => {
    const users = db.prepare('SELECT id, email, name, role FROM users ORDER BY role, name').all();
    for (const u of users) {
      u.locationIds = u.role === 'owner' ? null :
        db.prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(u.id).map(x => x.location_id);
    }
    res.json(users);
  });

  r.post('/users', requireOwner, (req, res) => {
    const { email, name, password, locationIds } = req.body;
    if (!email || !password || password.length < 8)
      return res.status(400).json({ error: 'Email and a password of at least 8 characters are required' });
    if (!Array.isArray(locationIds) || locationIds.length === 0)
      return res.status(400).json({ error: 'Assign at least one location' });
    try {
      const { lastInsertRowid } = db.prepare(
        'INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)')
        .run(email.trim().toLowerCase(), name || 'Manager', bcrypt.hashSync(password, 10), 'manager');
      const ins = db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?,?)');
      locationIds.forEach(id => ins.run(Number(lastInsertRowid), Number(id)));
      res.json({ id: Number(lastInsertRowid) });
    } catch {
      res.status(400).json({ error: 'That email is already in use' });
    }
  });

  r.put('/users/:id', requireOwner, (req, res) => {
    const id = Number(req.params.id);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: 'Not found' });
    const { name, password, locationIds } = req.body;
    if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
    if (password) {
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), id);
    }
    if (Array.isArray(locationIds) && target.role === 'manager') {
      db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(id);
      const ins = db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?,?)');
      locationIds.forEach(lid => ins.run(id, Number(lid)));
    }
    res.json({ ok: true });
  });

  r.delete('/users/:id', requireOwner, (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  // ---- maintenance: recompute stored commissions with current channel rates ----
  r.post('/admin/recalc-commissions', requireOwner, checkLocation, (req, res) => {
    const cats = Object.fromEntries(db.prepare(
      'SELECT id, commission_percent, commission_invoiced FROM revenue_categories WHERE location_id = ?')
      .all(req.locationId).map(c => [c.id, c]));
    const items = db.prepare(
      `SELECT ri.id, ri.category_id, ri.amount, ri.commission_amount
       FROM revenue_items ri JOIN revenue_entries re ON re.id = ri.entry_id
       WHERE re.location_id = ?`).all(req.locationId);
    const up = db.prepare('UPDATE revenue_items SET commission_amount = ?, commission_invoiced = ? WHERE id = ?');
    let updated = 0, before = 0, after = 0;
    for (const it of items) {
      const cat = cats[it.category_id];
      if (!cat) continue;
      const newComm = cat.commission_percent ? it.amount * cat.commission_percent / 100 : 0;
      before += it.commission_amount;
      after += newComm;
      up.run(newComm, cat.commission_invoiced, it.id);
      updated++;
    }
    res.json({ ok: true, updated, before, after, delta: after - before });
  });
};
