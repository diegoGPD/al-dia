// Loyalty domain logic: shared stamp program, customer state, visits, rewards.
const crypto = require('node:crypto');
const { db } = require('../db');

const config = () => db.prepare('SELECT * FROM loyalty_config WHERE id = 1').get();

function customerByCode(code) {
  return db.prepare('SELECT * FROM customers WHERE code = ?').get(String(code || '').trim());
}

const rewards = () => db.prepare(
  'SELECT * FROM loyalty_rewards WHERE active = 1 ORDER BY milestone').all();

// The last milestone closes the card; its size is the grid (10 slots).
const cardSize = () => {
  const r = rewards();
  return r.length ? r[r.length - 1].milestone : config().stamps_needed;
};

// Visits only count from the start of the current card, bounded by visit id so
// that a reset and a visit landing in the same second can't confuse each other.
// Customers who predate cycles have NULL, meaning everything counts.
const visitsInCycle = customer => db.prepare(
  `SELECT COUNT(*) c FROM loyalty_visits
    WHERE customer_id = ? AND (? IS NULL OR id > ?)`)
  .get(customer.id, customer.cycle_from_visit_id, customer.cycle_from_visit_id).c;

// Progress on the current card, plus every reward the customer is still owed —
// including ones earned on a previous card and never claimed.
function stateOf(customer) {
  const cfg = config();
  const size = cardSize();
  const stamps = Math.min(visitsInCycle(customer), size);
  const lifetime = db.prepare(
    'SELECT COUNT(*) c FROM loyalty_visits WHERE customer_id = ?').get(customer.id).c;
  const pending = db.prepare(
    `SELECT g.id, g.reward_id, g.earned_at, r.name, r.icon, r.milestone
       FROM loyalty_reward_grants g JOIN loyalty_rewards r ON r.id = g.reward_id
      WHERE g.customer_id = ? AND g.redeemed_at IS NULL
      ORDER BY r.milestone`).all(customer.id);

  const slots = rewards().map(r => ({
    id: r.id, milestone: r.milestone, name: r.name, icon: r.icon,
    reached: stamps >= r.milestone
  }));
  const next = slots.find(s => !s.reached) || null;

  return {
    name: customer.name, code: customer.code,
    stamps, stampsNeeded: size, visits: lifetime,
    programName: cfg.program_name,
    rewards: slots,
    pending,                                   // earned, not yet handed over
    rewardsAvailable: pending.length,
    nextReward: next,
    toNext: next ? next.milestone - stamps : 0,
    // kept so older callers (dashboards, Google text modules) keep working
    rewardText: next ? next.name : (pending[0] ? pending[0].name : cfg.reward_text)
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

// One stamp per customer per calendar day (abuse guard). An owner can override
// for a genuine second visit; the override is recorded as a normal visit.
function addVisit(customer, locationId, { override = false } = {}) {
  if (!override) {
    const already = db.prepare(
      `SELECT COUNT(*) c FROM loyalty_visits WHERE customer_id = ? AND date(visited_at) = date('now')`)
      .get(customer.id).c;
    if (already > 0) return { ok: false, reason: 'already_today', state: stateOf(customer) };
  }
  const before = stateOf(customer);
  db.prepare('INSERT INTO loyalty_visits (customer_id, location_id) VALUES (?,?)')
    .run(customer.id, locationId || null);

  // Crossing a milestone grants that reward, once per card.
  const after = visitsInCycle(customer);
  const justEarned = [];
  for (const r of rewards()) {
    if (after !== r.milestone) continue;      // exactly on the milestone visit
    db.prepare('INSERT INTO loyalty_reward_grants (customer_id, reward_id) VALUES (?,?)')
      .run(customer.id, r.id);
    justEarned.push(r);
  }
  touch(customer.id);
  return { ok: true, state: stateOf(customer), justEarned, previous: before };
}

// Staff hand over one specific reward. The card only empties once the final
// reward is redeemed — and any reward still owed survives that reset, because
// grants live in their own table.
function redeem(customer, locationId, rewardId = null) {
  const state = stateOf(customer);
  const grant = rewardId
    ? state.pending.find(p => p.reward_id === Number(rewardId))
    : state.pending[0];
  if (!grant) return { ok: false, reason: 'nothing_to_redeem', state };

  db.prepare(`UPDATE loyalty_reward_grants
    SET redeemed_at = datetime('now'), redeemed_location_id = ? WHERE id = ?`)
    .run(locationId || null, grant.id);
  db.prepare('INSERT INTO loyalty_redemptions (customer_id, location_id, reward_id) VALUES (?,?,?)')
    .run(customer.id, locationId || null, grant.reward_id);

  const last = rewards().slice(-1)[0];
  const cardFull = visitsInCycle(customer) >= cardSize();
  if (last && grant.reward_id === last.id && cardFull) {
    // Close the card at the newest visit: everything up to here belongs to the
    // card just finished, everything after starts the next one.
    const lastVisit = db.prepare(
      'SELECT COALESCE(MAX(id), 0) m FROM loyalty_visits WHERE customer_id = ?').get(customer.id).m;
    db.prepare('UPDATE customers SET cycle_from_visit_id = ? WHERE id = ?').run(lastVisit, customer.id);
  }
  touch(customer.id);
  const fresh = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer.id);
  return { ok: true, redeemed: grant, state: stateOf(fresh) };
}

function touch(customerId) {
  db.prepare(`UPDATE customers SET updated_at = datetime('now') WHERE id = ?`).run(customerId);
}

function deleteCustomer(customer) {
  db.prepare('DELETE FROM wallet_registrations WHERE serial = ?').run(customer.code);
  db.prepare('DELETE FROM customers WHERE id = ?').run(customer.id); // visits/redemptions cascade
}

module.exports = { config, customerByCode, stateOf, createCustomer, addVisit, redeem,
  deleteCustomer, touch, rewards, cardSize, visitsInCycle };
