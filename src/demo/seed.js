// Demo seeding: wipes the (demo) database and builds "La Milpa", a fake
// two-location restaurant with 8 weeks of believable history.
// Only ever runs when DEMO_MODE=1 — the route and boot hook both check.
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { db, createLocation } = require('../db');
const { addDays, todayStr, dow, mondayOf } = require('../lib/dates');
const pd = require('../integrations/pidedirecto');

const rnd = (a, b) => a + Math.random() * (b - a);
const ri = (a, b) => Math.round(rnd(a, b));

function wipe() {
  db.exec('PRAGMA foreign_keys = OFF;');
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all();
  for (const t of tables) db.exec(`DELETE FROM "${t.name}"`);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`INSERT OR IGNORE INTO loyalty_config (id) VALUES (1)`);
}

// Demo commission rates — deliberately generic, nobody's real contract.
const DEMO_RATES = [
  ['uber eats', 30], ['rappi', 28], ['didi', 25],
  ['tarjeta menú web', 8], ['efectivo menú web', 8],
  ['tarjeta en tienda', 5], ['efectivo en tienda', 0], ['banorte', 17]
];

const CHANNEL_MIX = [ // [pd channel, payment, weight, avg ticket]
  ['PIDEDIRECTOPOS', 'CASH', 22, 260],
  ['PIDEDIRECTOPOS', 'CARD', 30, 310],
  ['PIDEDIRECTOPOS', 'CARD/BANREGIO', 8, 330],
  ['PIDEDIRECTO', 'CARD', 12, 285],
  ['UBER_EATS', 'CARD', 15, 340],
  ['RAPPI', 'CARD', 8, 300],
  ['DIDI_FOOD', 'CARD', 5, 290]
];
const DOW_MULT = [1.15, 0.55, 0.7, 0.85, 1.0, 1.35, 1.5]; // Sun..Sat

function seed() {
  wipe();
  const today = todayStr();

  // ---- people & locations ----
  const hash = bcrypt.hashSync(crypto.randomBytes(12).toString('hex'), 8);
  db.prepare(`INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)`)
    .run('demo@lamilpa.mx', 'Ana (demo)', hash, 'owner');
  const loc1 = createLocation('La Milpa — Centro');
  const loc2 = createLocation('La Milpa — Roma');
  const mgr = db.prepare(`INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)`)
    .run('sofia@lamilpa.mx', 'Sofía (gerente)', hash, 'manager');
  db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?,?)')
    .run(Number(mgr.lastInsertRowid), loc1);

  for (const loc of [loc1, loc2]) {
    for (const [needle, pct] of DEMO_RATES) {
      db.prepare(`UPDATE revenue_categories SET commission_percent = ? WHERE location_id = ? AND lower(name) LIKE ?`)
        .run(pct, loc, `%${needle}%`);
    }
  }
  db.prepare(`UPDATE locations SET pd_store_id = ? WHERE id = ?`)
    .run('11111111-2222-4333-8444-555555555555', loc1);

  // ---- accounts ----
  const accs = Object.fromEntries(db.prepare(
    'SELECT id, name FROM accounts WHERE location_id = ?').all(loc1).map(a => [a.name, a.id]));
  db.prepare('UPDATE accounts SET opening_balance = 9500 WHERE id = ?').run(accs['Cash']);
  db.prepare('UPDATE accounts SET opening_balance = 118000 WHERE id = ?').run(accs['Bank 1']);
  db.prepare('UPDATE accounts SET opening_balance = 43000 WHERE id = ?').run(accs['Bank 2']);
  db.prepare('UPDATE accounts SET opening_balance = 8200 WHERE id = ?').run(accs['Delivery apps']);

  // ---- recurring costs ----
  const recCat = (loc, needle) => db.prepare(
    `SELECT id FROM recurring_cost_categories WHERE location_id = ? AND lower(name) LIKE ?`)
    .get(loc, `%${needle}%`).id;
  const recStart = addDays(today, -70);
  const addRec = (loc, needle, desc, amount, freq, inv, acc) => db.prepare(
    `INSERT INTO recurring_costs (location_id, category_id, description, amount, frequency, invoiced, start_date, account_id)
     VALUES (?,?,?,?,?,?,?,?)`)
    .run(loc, recCat(loc, needle), desc, amount, freq, inv, recStart, acc || null);
  addRec(loc1, 'rent', 'Renta local Centro', 38000, 'monthly', 1, accs['Bank 1']);
  addRec(loc1, 'salaries', 'Nómina base', 48000, 'monthly', 0, accs['Bank 1']);
  addRec(loc1, 'utilities', 'CFE + agua + gas', 7400, 'monthly', 1, accs['Bank 1']);
  addRec(loc1, 'internet', 'Internet y teléfono', 899, 'monthly', 1, accs['Bank 2']);
  addRec(loc1, 'subscriptions', 'Software punto de venta', 1200, 'monthly', 1, accs['Bank 2']);
  addRec(loc2, 'rent', 'Renta Roma', 29000, 'monthly', 1, null);
  addRec(loc2, 'salaries', 'Nómina base Roma', 34000, 'monthly', 0, null);
  addRec(loc2, 'utilities', 'Servicios Roma', 5200, 'monthly', 1, null);

  // ---- 8 weeks of PideDirecto orders for Centro (the star of the show) ----
  const upOrder = db.prepare(
    `INSERT INTO pd_orders (order_id, location_id, date, channel, payment_method, amount, status, source)
     VALUES (?,?,?,?,?,?,?,?)`);
  const totalWeight = CHANNEL_MIX.reduce((s, c) => s + c[2], 0);
  const pickChannel = () => {
    let roll = Math.random() * totalWeight;
    for (const c of CHANNEL_MIX) { roll -= c[2]; if (roll <= 0) return c; }
    return CHANNEL_MIX[0];
  };
  const foodCat = db.prepare(
    `SELECT id FROM variable_cost_categories WHERE location_id = ? AND lower(name) LIKE '%ingredient%'`).get(loc1);
  const packCat = db.prepare(
    `SELECT id FROM variable_cost_categories WHERE location_id = ? AND lower(name) LIKE '%packaging%'`).get(loc1);

  const daysBack = 56;
  for (let i = daysBack; i >= 1; i--) {
    const date = addDays(today, -i);
    const growth = 1 + (daysBack - i) / daysBack * 0.22; // gentle upward trend
    const nOrders = Math.max(15, Math.round(ri(36, 46) * DOW_MULT[dow(date)] * growth));
    let dayTotal = 0;
    for (let k = 0; k < nOrders; k++) {
      const [channel, payment, , ticket] = pickChannel();
      const amount = Math.round(ticket * rnd(0.55, 1.6));
      const cancelled = Math.random() < 0.025;
      if (!cancelled) dayTotal += amount;
      upOrder.run(crypto.randomUUID(), loc1, date, channel, payment, amount,
        cancelled ? 'CANCELLED' : 'COMPLETE', 'webhook');
    }
    pd.rebuildDay(loc1, date); // the real pipeline: categories, commissions, accounts
    // day costs: food ~30%, packaging ~2%
    db.prepare(`INSERT INTO variable_costs (location_id, date, category_id, amount, invoiced, account_id)
      VALUES (?,?,?,?,1,?)`)
      .run(loc1, date, foodCat.id, Math.round(dayTotal * rnd(0.27, 0.33)), Math.random() < 0.5 ? accs['Bank 1'] : null);
    db.prepare(`INSERT INTO variable_costs (location_id, date, category_id, amount, invoiced)
      VALUES (?,?,?,?,1)`)
      .run(loc1, date, packCat.id, Math.round(dayTotal * rnd(0.015, 0.025)));
  }

  // Recent webhook feed so "Recent deliveries" looks alive
  const recent = db.prepare(
    `SELECT order_id, date, channel, payment_method, amount FROM pd_orders
     WHERE location_id = ? AND status = 'COMPLETE' ORDER BY date DESC LIMIT 8`).all(loc1);
  for (const o of recent.reverse()) {
    db.prepare(`INSERT INTO pos_events (location_id, payload, status, note, received_at)
      VALUES (?,?,?,?, datetime('now', ?))`)
      .run(loc1,
        JSON.stringify({ orderId: o.order_id, storeId: '11111111-2222-4333-8444-555555555555', eventType: 'ORDER_COMPLETED', occurredAt: o.date + 'T21:30:00.000Z' }),
        'processed',
        `Completed order ${o.order_id.slice(0, 8)}… (${o.channel} · ${o.payment_method}, ${o.amount.toFixed(2)}) → ${o.date} rebuilt`,
        `-${ri(1, 40)} hours`);
  }

  // ---- Roma: manual logging flow (smaller, simpler) ----
  const romaCats = db.prepare(
    `SELECT id, name FROM revenue_categories WHERE location_id = ? AND active = 1`).all(loc2);
  const romaCash = romaCats.find(c => /efectivo en tienda/i.test(c.name)).id;
  const romaCard = romaCats.find(c => /tarjeta en tienda/i.test(c.name)).id;
  const { upsertDayRevenue } = require('../lib/revenue');
  for (let i = 42; i >= 1; i--) {
    const date = addDays(today, -i);
    if (dow(date) === 1) continue; // closed Mondays — a pattern insights can find
    const total = Math.round(9500 * DOW_MULT[dow(date)] * rnd(0.8, 1.2));
    upsertDayRevenue(loc2, date, {
      items: [
        { category_id: romaCash, amount: Math.round(total * 0.45) },
        { category_id: romaCard, amount: Math.round(total * 0.55) }
      ]
    });
  }

  // ---- one-offs & transfers ----
  const oneoffs = [
    [-38, 'Reparación de refrigerador', 3400, 0], [-25, 'Permiso de alcoholes', 5200, 1],
    [-19, 'Sillas nuevas terraza', 4800, 1], [-11, 'Fumigación', 1600, 1],
    [-6, 'Vasos y platos extra', 950, 0], [-2, 'Plomero — fuga en cocina', 1200, 0]
  ];
  for (const [off, desc, amt, inv] of oneoffs) {
    db.prepare(`INSERT INTO oneoff_costs (location_id, date, description, amount, invoiced, account_id, logged_by)
      VALUES (?,?,?,?,?,?,?)`)
      .run(loc1, addDays(today, off), desc, amt, inv, inv ? accs['Bank 1'] : accs['Cash'],
        Math.random() < 0.5 ? 'Sofía (gerente)' : null);
  }
  for (let w = 8; w >= 1; w--) {
    db.prepare(`INSERT INTO transfers (location_id, date, from_account_id, to_account_id, amount, note)
      VALUES (?,?,?,?,?,?)`)
      .run(loc1, addDays(today, -w * 7 + 2), accs['Cash'], accs['Bank 1'], ri(4000, 9000), 'Depósito semanal');
  }

  // ---- team & schedule ----
  const team = [
    ['Carlos', 'Cocina', 'hourly', 72], ['María', 'Cocina', 'hourly', 68],
    ['Luis', 'Mesero', 'hourly', 62], ['Fernanda', 'Mesera', 'hourly', 62],
    ['Diego', 'Caja', 'hourly', 66], ['Chef Rodrigo', 'Chef', 'salary', 3400]
  ];
  const empIds = team.map(([name, position, type, rate]) => Number(db.prepare(
    `INSERT INTO employees (location_id, name, position, pay_type, rate) VALUES (?,?,?,?,?)`)
    .run(loc1, name, position, type, rate).lastInsertRowid));
  const insTurn = db.prepare(
    'INSERT INTO turns (location_id, date, label, start_min, end_min, position) VALUES (?,?,?,?,?,?)');
  const insAssign = db.prepare('INSERT OR IGNORE INTO turn_assignments (turn_id, employee_id) VALUES (?,?)');
  const thisMonday = mondayOf(today);
  for (let w = -3; w <= 1; w++) { // 3 past weeks, current, next
    for (let d = 0; d < 7; d++) {
      const date = addDays(thisMonday, w * 7 + d);
      const dayNum = dow(date);
      const closeAt = dayNum === 5 || dayNum === 6 ? 23 * 60 : 21 * 60 + 30;
      const manana = Number(insTurn.run(loc1, date, 'Mañana', 9 * 60, 16 * 60, 0).lastInsertRowid);
      const tarde = Number(insTurn.run(loc1, date, 'Tarde', 15 * 60 + 30, closeAt, 1).lastInsertRowid);
      empIds.forEach((id, idx) => {
        if (dayNum === 1 && idx > 2) return;          // slow Mondays: skeleton crew
        if (idx % 6 === (d + idx) % 6) return;        // everyone gets ~1 day off
        insAssign.run(idx % 2 === 0 ? manana : tarde, id);
        if (idx === 0 && dayNum >= 5) insAssign.run(tarde, id); // Carlos doubles on weekends
      });
    }
  }
  db.prepare('INSERT INTO turn_templates (location_id, name, turns_json) VALUES (?,?,?)')
    .run(loc1, 'Día normal', JSON.stringify([
      { label: 'Mañana', start_min: 540, end_min: 960 },
      { label: 'Tarde', start_min: 930, end_min: 1290 }]));

  // ---- loyalty ----
  db.prepare(`UPDATE loyalty_config SET program_name = ?, stamps_needed = 8, reward_text = ? WHERE id = 1`)
    .run('La Milpa Rewards', 'Un postre gratis');
  const customers = ['Valeria R.', 'Jorge M.', 'Paola G.', 'Andrés T.', 'Lucía F.',
    'Roberto C.', 'Camila S.', 'Héctor L.', 'Mariana P.', 'Iván D.'];
  customers.forEach((name, i) => {
    const cid = Number(db.prepare(
      `INSERT INTO customers (code, auth_token, name, phone) VALUES (?,?,?,?)`)
      .run('AD' + crypto.randomBytes(6).toString('hex').toUpperCase(),
        crypto.randomBytes(16).toString('hex'), name, `55${ri(10000000, 99999999)}`).lastInsertRowid);
    const visits = ri(1, 14);
    for (let v = 0; v < visits; v++) {
      db.prepare(`INSERT INTO loyalty_visits (customer_id, location_id, visited_at)
        VALUES (?,?, datetime('now', ?))`)
        .run(cid, i % 3 === 0 ? loc2 : loc1, `-${visits - v} days`);
    }
    if (visits >= 8 && Math.random() < 0.6) {
      db.prepare(`INSERT INTO loyalty_redemptions (customer_id, location_id) VALUES (?,?)`).run(cid, loc1);
    }
  });

  // ---- goals ----
  db.prepare(`INSERT INTO goals (location_id, type, target) VALUES (?,?,?)`).run(loc1, 'profit', 55000);
  db.prepare(`INSERT INTO goals (location_id, type, target) VALUES (?,?,?)`).run(loc1, 'margin', 12);

  return { ok: true };
}

// One simulated live order through the REAL webhook-processing path —
// the party trick for showing the PideDirecto integration in action.
async function simulateOrder(locationId) {
  const totalWeight = CHANNEL_MIX.reduce((s, c) => s + c[2], 0);
  let roll = Math.random() * totalWeight, chosen = CHANNEL_MIX[0];
  for (const c of CHANNEL_MIX) { roll -= c[2]; if (roll <= 0) { chosen = c; break; } }
  const [channel, payment, , ticket] = chosen;
  const amount = Math.round(ticket * rnd(0.6, 1.5));
  const [method, custom] = payment.split('/');
  const payload = {
    orderId: crypto.randomUUID(),
    storeId: '11111111-2222-4333-8444-555555555555',
    eventType: 'ORDER_COMPLETED',
    occurredAt: new Date().toISOString(),
    app: channel, paymentMethod: method, customPaymentMethod: custom || undefined,
    total: String(amount), completedAt: new Date().toISOString(), orderStatus: 'COMPLETE'
  };
  db.prepare('INSERT INTO pos_events (location_id, payload, status, note) VALUES (?,?,?,?)')
    .run(locationId, JSON.stringify(payload), 'stored', 'simulated');
  const r = await pd.processWebhook(locationId, payload);
  db.prepare(`UPDATE pos_events SET status = ?, note = ? WHERE id =
    (SELECT MAX(id) FROM pos_events WHERE location_id = ?)`).run(r.status, r.note, locationId);
  return { channel, payment, amount, ...r };
}

module.exports = { seed, wipe, simulateOrder };
