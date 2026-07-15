// Loyalty domain logic: shared stamp program, customer state, visits, rewards.
const crypto = require('node:crypto');
const { db } = require('../db');

const config = () => db.prepare('SELECT * FROM loyalty_config WHERE id = 1').get();

function customerByCode(code) {
  return db.prepare('SELECT * FROM customers WHERE code = ?').get(String(code || '').trim());
}

// Progress: stamps roll over after each earned reward.
function stateOf(customer) {
  const cfg = config();
  const visits = db.prepare('SELECT COUNT(*) c FROM loyalty_visits WHERE customer_id = ?').get(customer.id).c;
  const redeemed = db.prepare('SELECT COUNT(*) c FROM loyalty_redemptions WHERE customer_id = ?').get(customer.id).c;
  const earned = Math.floor(visits / cfg.stamps_needed);
  const available = Math.max(0, earned - redeemed);
  return {
    name: customer.name, code: customer.code,
    visits, stamps: visits % cfg.stamps_needed,
    stampsNeeded: cfg.stamps_needed,
    rewardText: cfg.reward_text, programName: cfg.program_name,
    rewardsAvailable: available,
    toNext: cfg.stamps_needed - (visits % cfg.stamps_needed)
  };
}

function createCustomer({ name, phone, email }) {
  const code = 'AD' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const auth = crypto.randomBytes(16).toString('hex');
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO customers (code, auth_token, name, phone, email) VALUES (?,?,?,?,?)')
    .run(code, auth, name.trim(), (phone || '').trim() || null, (email || '').trim().toLowerCase() || null);
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(lastInsertRowid));
}

// One stamp per customer per calendar day (abuse guard).
function addVisit(customer, locationId) {
  const already = db.prepare(
    `SELECT COUNT(*) c FROM loyalty_visits WHERE customer_id = ? AND date(visited_at) = date('now')`)
    .get(customer.id).c;
  if (already > 0) return { ok: false, reason: 'already_today', state: stateOf(customer) };
  db.prepare('INSERT INTO loyalty_visits (customer_id, location_id) VALUES (?,?)')
    .run(customer.id, locationId || null);
  touch(customer.id);
  const state = stateOf(customer);
  return { ok: true, state, justEarned: state.stamps === 0 && state.visits > 0 };
}

function redeem(customer, locationId) {
  const state = stateOf(customer);
  if (state.rewardsAvailable < 1) return { ok: false, reason: 'nothing_to_redeem', state };
  db.prepare('INSERT INTO loyalty_redemptions (customer_id, location_id) VALUES (?,?)')
    .run(customer.id, locationId || null);
  touch(customer.id);
  return { ok: true, state: stateOf(customer) };
}

function touch(customerId) {
  db.prepare(`UPDATE customers SET updated_at = datetime('now') WHERE id = ?`).run(customerId);
}

function deleteCustomer(customer) {
  db.prepare('DELETE FROM wallet_registrations WHERE serial = ?').run(customer.code);
  db.prepare('DELETE FROM customers WHERE id = ?').run(customer.id); // visits/redemptions cascade
}

module.exports = { config, customerByCode, stateOf, createCustomer, addVisit, redeem, deleteCustomer, touch };
