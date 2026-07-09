// Public session routes: first-run setup, login, logout.
const bcrypt = require('bcryptjs');
const { db, createLocation } = require('../db');
const { setSession, clearSession } = require('../auth');

module.exports = (r) => {
  r.get('/status', (req, res) => {
    const hasUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c > 0;
    res.json({ needsSetup: !hasUsers, setupCodeRequired: !!process.env.SETUP_CODE });
  });

  // First run: create the owner account and first location.
  // If SETUP_CODE is set in the environment, it must match — so an empty
  // database never becomes a free-for-all on a public URL.
  r.post('/setup', (req, res) => {
    if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0)
      return res.status(400).json({ error: 'Already set up' });
    if (process.env.SETUP_CODE && String(req.body.setup_code || '') !== process.env.SETUP_CODE)
      return res.status(403).json({ error: 'Wrong setup code' });
    const { email, name, password, locationName } = req.body;
    if (!email || !password || password.length < 8)
      return res.status(400).json({ error: 'Email and a password of at least 8 characters are required' });
    const hash = bcrypt.hashSync(password, 10);
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)')
      .run(email.trim().toLowerCase(), name || 'Owner', hash, 'owner');
    createLocation((locationName || 'My restaurant').trim());
    setSession(res, Number(lastInsertRowid));
    res.json({ ok: true });
  });

  r.post('/login', (req, res) => {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').trim().toLowerCase());
    if (!user || !bcrypt.compareSync(password || '', user.password_hash))
      return res.status(401).json({ error: 'Wrong email or password' });
    setSession(res, user.id);
    res.json({ ok: true });
  });

  r.post('/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });
};
