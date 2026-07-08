// Reset any user's password from the server console (e.g. `railway ssh`):
//   node scripts/reset-password.js you@email.com newpassword123
const bcrypt = require('bcryptjs');
const { db } = require('../src/db');

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error('Usage: node scripts/reset-password.js <email> <new password, 8+ chars>');
  process.exit(1);
}
const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase());
if (!user) { console.error(`No user with email ${email}`); process.exit(1); }
db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
  .run(bcrypt.hashSync(password, 10), user.id);
console.log(`Password updated for ${email}`);
