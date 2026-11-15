// Database setup: schema, migrations, and default-category seeding.
// Uses Node's built-in SQLite (node:sqlite) — no native modules to compile.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'aldia.db'));
try { db.exec('PRAGMA journal_mode = WAL;'); } catch { /* some filesystems don't support WAL */ }
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

-- Which locations a manager can access (owners see all).
CREATE TABLE IF NOT EXISTS user_locations (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, location_id)
);

-- Revenue channels. Each can carry its own commission (e.g. Uber Eats 30%,
-- card terminal 2.5%) and whether that commission is invoiced (facturada).
CREATE TABLE IF NOT EXISTS revenue_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  commission_percent REAL,            -- % taken off this channel's sales (NULL/0 = none)
  commission_invoiced INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS variable_cost_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  entry_mode TEXT NOT NULL DEFAULT 'fixed' CHECK (entry_mode IN ('fixed','percent')),
  default_percent REAL,               -- suggested % of the day's sales (entry_mode='percent')
  default_invoiced INTEGER NOT NULL DEFAULT 0,
  benchmark_tag TEXT CHECK (benchmark_tag IN ('food','labor') OR benchmark_tag IS NULL),
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS recurring_cost_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  benchmark_tag TEXT CHECK (benchmark_tag IN ('labor','occupancy') OR benchmark_tag IS NULL),
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- One row per location per day. total is authoritative; items are the optional breakdown.
CREATE TABLE IF NOT EXISTS revenue_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                 -- YYYY-MM-DD
  total REAL NOT NULL DEFAULT 0,
  note TEXT,
  UNIQUE (location_id, date)
);

-- Commission is computed and stored at save time, so changing a channel's %
-- later doesn't rewrite history.
CREATE TABLE IF NOT EXISTS revenue_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES revenue_entries(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES revenue_categories(id) ON DELETE CASCADE,
  amount REAL NOT NULL DEFAULT 0,
  commission_amount REAL NOT NULL DEFAULT 0,
  commission_invoiced INTEGER NOT NULL DEFAULT 0,
  UNIQUE (entry_id, category_id)
);

-- One row per location per day per variable-cost category.
CREATE TABLE IF NOT EXISTS variable_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES variable_cost_categories(id) ON DELETE CASCADE,
  amount REAL NOT NULL DEFAULT 0,
  invoiced INTEGER NOT NULL DEFAULT 0,
  UNIQUE (location_id, date, category_id)
);

-- Ongoing costs entered once; spread into a daily equivalent by frequency.
CREATE TABLE IF NOT EXISTS recurring_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES recurring_cost_categories(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','biweekly','monthly')),
  invoiced INTEGER NOT NULL DEFAULT 0,
  start_date TEXT NOT NULL,           -- counts from this date
  end_date TEXT,                      -- NULL = still active
  active INTEGER NOT NULL DEFAULT 1
);

-- Money accounts: where money actually sits (cash, banks, delivery apps owing you).
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  opening_balance REAL NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- Optional split of a day's revenue across accounts (independent of the
-- sales-channel breakdown).
CREATE TABLE IF NOT EXISTS revenue_account_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES revenue_entries(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount REAL NOT NULL DEFAULT 0,
  UNIQUE (entry_id, account_id)
);

-- Moving money between accounts (e.g. depositing cash at the bank).
CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  from_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_transfers_loc_date ON transfers(location_id, date);

-- ===== Customer loyalty (one shared program across locations) =====
CREATE TABLE IF NOT EXISTS loyalty_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  program_name TEXT NOT NULL DEFAULT 'Al Día Rewards',
  stamps_needed INTEGER NOT NULL DEFAULT 10,
  reward_text TEXT NOT NULL DEFAULT 'Un platillo gratis',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,          -- what their QR encodes
  auth_token TEXT NOT NULL,           -- PassKit web-service auth for this pass
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loyalty_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  location_id INTEGER REFERENCES locations(id),
  visited_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_visits_customer ON loyalty_visits(customer_id);

CREATE TABLE IF NOT EXISTS loyalty_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  location_id INTEGER REFERENCES locations(id),
  redeemed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Milestone rewards: visit 5 earns a drink, visit 10 a burrito. Editable, but
-- these are the defaults. position orders them on the card.
CREATE TABLE IF NOT EXISTS loyalty_rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  milestone INTEGER NOT NULL,          -- visits needed, within one card cycle
  name TEXT NOT NULL,                  -- shown to the customer: "bebida"
  icon TEXT NOT NULL,                  -- art key: 'drink' | 'burrito'
  active INTEGER NOT NULL DEFAULT 1
);

-- A reward a customer has actually earned. Rewards are granted as rows rather
-- than derived from the visit count, so that resetting the card after the last
-- reward can never silently swallow an earlier one the customer never claimed.
CREATE TABLE IF NOT EXISTS loyalty_reward_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  reward_id INTEGER NOT NULL REFERENCES loyalty_rewards(id) ON DELETE CASCADE,
  earned_at TEXT NOT NULL DEFAULT (datetime('now')),
  redeemed_at TEXT,
  redeemed_location_id INTEGER REFERENCES locations(id)
);
CREATE INDEX IF NOT EXISTS idx_grants_customer ON loyalty_reward_grants(customer_id);

-- Apple Wallet device registrations (PassKit web service protocol)
CREATE TABLE IF NOT EXISTS wallet_registrations (
  device_id TEXT NOT NULL,
  push_token TEXT NOT NULL,
  serial TEXT NOT NULL,               -- customer code
  PRIMARY KEY (device_id, serial)
);

-- Performance targets (one per type per location).
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('profit','margin')),
  target REAL NOT NULL,
  UNIQUE (location_id, type)
);

-- Manual balance corrections (PIN-protected): signed amount that nudges an
-- account's balance to match reality.
CREATE TABLE IF NOT EXISTS account_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,               -- + adds to the balance, - removes
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_adjust_loc_date ON account_adjustments(location_id, date);

-- Employee roster (per location)
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position TEXT,
  pay_type TEXT NOT NULL DEFAULT 'hourly' CHECK (pay_type IN ('hourly','salary')),
  rate REAL NOT NULL DEFAULT 0,       -- $/hour, or flat $/week for salary
  active INTEGER NOT NULL DEFAULT 1
);

-- One shift per employee per day. Times in minutes from midnight;
-- end < start means the shift runs past midnight.
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                 -- YYYY-MM-DD
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  UNIQUE (employee_id, date)
);
CREATE INDEX IF NOT EXISTS idx_shifts_loc_date ON shifts(location_id, date);

CREATE TABLE IF NOT EXISTS oneoff_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  invoiced INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_revenue_loc_date ON revenue_entries(location_id, date);
CREATE INDEX IF NOT EXISTS idx_varcost_loc_date ON variable_costs(location_id, date);
CREATE INDEX IF NOT EXISTS idx_oneoff_loc_date ON oneoff_costs(location_id, date);
`);

// ---- Migrations for databases created before per-channel commissions ----
function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === col);
}
if (!hasColumn('revenue_categories', 'commission_percent')) {
  db.exec(`ALTER TABLE revenue_categories ADD COLUMN commission_percent REAL;
           ALTER TABLE revenue_categories ADD COLUMN commission_invoiced INTEGER NOT NULL DEFAULT 1;`);
}
if (!hasColumn('revenue_items', 'commission_amount')) {
  db.exec(`ALTER TABLE revenue_items ADD COLUMN commission_amount REAL NOT NULL DEFAULT 0;
           ALTER TABLE revenue_items ADD COLUMN commission_invoiced INTEGER NOT NULL DEFAULT 0;`);
}
// "Paid from" account tagging on every cost type (optional, nullable).
for (const table of ['variable_costs', 'oneoff_costs', 'recurring_costs']) {
  if (!hasColumn(table, 'account_id')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN account_id INTEGER REFERENCES accounts(id)`);
  }
}
// Wallet identifiers configured in-app (env vars still win if set).
if (!hasColumn('loyalty_config', 'pass_type_id')) {
  db.exec(`ALTER TABLE loyalty_config ADD COLUMN pass_type_id TEXT;
           ALTER TABLE loyalty_config ADD COLUMN apple_team_id TEXT;
           ALTER TABLE loyalty_config ADD COLUMN google_issuer_id TEXT;`);
}
// PideDirecto: per-location store id + order ledger (idempotency by order id).
if (!hasColumn('locations', 'pd_store_id')) {
  db.exec(`ALTER TABLE locations ADD COLUMN pd_store_id TEXT;
           CREATE TABLE IF NOT EXISTS pd_orders (
             order_id TEXT PRIMARY KEY,
             location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
             date TEXT NOT NULL,
             channel TEXT,
             payment_method TEXT,
             amount REAL NOT NULL DEFAULT 0,
             status TEXT NOT NULL DEFAULT 'OTHER',
             source TEXT NOT NULL DEFAULT 'webhook',
             updated_at TEXT NOT NULL DEFAULT (datetime('now'))
           );
           CREATE INDEX IF NOT EXISTS idx_pd_orders_loc_date ON pd_orders(location_id, date);`);
}

// Turn-based scheduling: turns (label + times per day) with people dropped in.
if (!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='turns'`).get()) {
  db.exec(`
    CREATE TABLE turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      label TEXT NOT NULL,
      start_min INTEGER NOT NULL,
      end_min INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_turns_loc_date ON turns(location_id, date);
    CREATE TABLE turn_assignments (
      turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      PRIMARY KEY (turn_id, employee_id)
    );
    CREATE TABLE turn_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      turns_json TEXT NOT NULL
    );
  `);
  // Migrate any existing per-person shifts into equivalent turns so history
  // (and the labor already booked into P&L) is preserved exactly.
  const oldShifts = db.prepare('SELECT * FROM shifts ORDER BY date, start_min').all();
  const findTurn = db.prepare(
    'SELECT id FROM turns WHERE location_id = ? AND date = ? AND start_min = ? AND end_min = ?');
  const makeTurn = db.prepare(
    'INSERT INTO turns (location_id, date, label, start_min, end_min) VALUES (?,?,?,?,?)');
  const assign = db.prepare(
    'INSERT OR IGNORE INTO turn_assignments (turn_id, employee_id) VALUES (?,?)');
  for (const s of oldShifts) {
    let turn = findTurn.get(s.location_id, s.date, s.start_min, s.end_min);
    const turnId = turn ? turn.id
      : Number(makeTurn.run(s.location_id, s.date, 'Turno', s.start_min, s.end_min).lastInsertRowid);
    assign.run(turnId, s.employee_id);
  }
}

// Channel payout reconciliation: the real amount kept for a channel over a
// period, replacing the commission estimate for that window.
if (!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='channel_reconciliations'`).get()) {
  db.exec(`
    CREATE TABLE channel_reconciliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      category_id INTEGER NOT NULL REFERENCES revenue_categories(id) ON DELETE CASCADE,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      gross REAL NOT NULL,             -- sales through the channel in the window
      estimated_net REAL NOT NULL,     -- what our commission % predicted we'd keep
      actual_net REAL NOT NULL,        -- what the payout actually was
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_recon_loc ON channel_reconciliations(location_id, start_date, end_date);
  `);
}

// An order's location must come from the restaurant id in its payload and
// nothing else. That means pd_orders.location_id has to accept NULL (unknown
// restaurant -> parked as unassigned) and pd_store_id must be unique so two
// locations can never claim the same restaurant.
if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='pd_orders'`).get()
    && /location_id INTEGER NOT NULL/.test(db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='pd_orders'`).get().sql)) {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    CREATE TABLE pd_orders_new (
      order_id TEXT PRIMARY KEY,
      location_id INTEGER REFERENCES locations(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      channel TEXT,
      payment_method TEXT,
      amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'OTHER',
      source TEXT NOT NULL DEFAULT 'webhook',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      store_id TEXT
    );
    INSERT INTO pd_orders_new (order_id, location_id, date, channel, payment_method, amount, status, source, updated_at)
      SELECT order_id, location_id, date, channel, payment_method, amount, status, source, updated_at FROM pd_orders;
    DROP TABLE pd_orders;
    ALTER TABLE pd_orders_new RENAME TO pd_orders;
    CREATE INDEX idx_pd_orders_loc_date ON pd_orders(location_id, date);
    CREATE INDEX idx_pd_orders_store ON pd_orders(store_id);
  `);
  db.exec('PRAGMA foreign_keys = ON;');
}
if (!hasColumn('pd_orders', 'store_id')) {
  db.exec(`ALTER TABLE pd_orders ADD COLUMN store_id TEXT;
           CREATE INDEX IF NOT EXISTS idx_pd_orders_store ON pd_orders(store_id);`);
}
// One restaurant id belongs to exactly one location. If two locations were
// sharing one id (which by itself makes routing ambiguous), keep it on the
// location that already holds the most orders for it and clear the others,
// loudly — otherwise the unique index below would fail and the app wouldn't boot.
for (const dup of db.prepare(
  `SELECT pd_store_id FROM locations WHERE pd_store_id IS NOT NULL
    GROUP BY pd_store_id HAVING COUNT(*) > 1`).all()) {
  const holders = db.prepare(
    `SELECT l.id, l.name,
            (SELECT COUNT(*) FROM pd_orders o WHERE o.location_id = l.id) AS orders
       FROM locations l WHERE l.pd_store_id = ? ORDER BY orders DESC, l.id ASC`).all(dup.pd_store_id);
  const keep = holders[0];
  for (const h of holders.slice(1)) {
    db.prepare('UPDATE locations SET pd_store_id = NULL WHERE id = ?').run(h.id);
    console.warn(`[al-dia] PideDirecto restaurant id ${dup.pd_store_id} was on both "${keep.name}" and "${h.name}". Kept it on "${keep.name}"; cleared it from "${h.name}" — set the correct id for that location in Settings.`);
  }
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_pd_store
         ON locations(pd_store_id) WHERE pd_store_id IS NOT NULL;`);

// The stamp card runs in cycles: it empties after the final reward is redeemed.
// The boundary is the id of the last visit on the finished card, NOT a
// timestamp — two visits can share a second, and a reset must never swallow a
// stamp earned in that same second (or keep one that belonged to the old card).
// NULL means "no card has been completed yet", so every visit counts.
if (!hasColumn('customers', 'cycle_from_visit_id')) {
  db.exec(`ALTER TABLE customers ADD COLUMN cycle_from_visit_id INTEGER`);
}
// Which reward a redemption was for (legacy rows predate per-reward tracking).
if (!hasColumn('loyalty_redemptions', 'reward_id')) {
  db.exec(`ALTER TABLE loyalty_redemptions ADD COLUMN reward_id INTEGER`);
}
// Seed the two default rewards once.
if (!db.prepare('SELECT COUNT(*) c FROM loyalty_rewards').get().c) {
  db.prepare(`INSERT INTO loyalty_rewards (milestone, name, icon) VALUES (?,?,?)`).run(5, 'bebida', 'drink');
  db.prepare(`INSERT INTO loyalty_rewards (milestone, name, icon) VALUES (?,?,?)`).run(10, 'burrito', 'burrito');
  // The card is a 10-slot grid; keep the old stamps_needed in step with it.
  db.prepare(`UPDATE loyalty_config SET stamps_needed = 10 WHERE id = 1`).run();
}

// Audit trail for the location-repair script: every order it moves.
db.exec(`
  CREATE TABLE IF NOT EXISTS pd_order_location_fixes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    old_location_id INTEGER,
    old_location TEXT,
    new_location_id INTEGER,
    new_location TEXT,
    order_date TEXT,
    amount REAL,
    changed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pd_fixes_changed ON pd_order_location_fixes(changed_at);
`);

// Staff role tags (Gerente, Cocina, Front…) — owner-defined, colour-coded,
// shown beside names on the schedule.
if (!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='staff_tags'`).get()) {
  db.exec(`
    CREATE TABLE staff_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#1a7f5a',
      position INTEGER NOT NULL DEFAULT 0
    );`);
  if (!hasColumn('employees', 'tag_id')) {
    db.exec(`ALTER TABLE employees ADD COLUMN tag_id INTEGER REFERENCES staff_tags(id)`);
  }
  // Turn the roles people already typed into real tags, so nothing is re-entered.
  const PALETTE = ['#1a7f5a', '#2d6cdf', '#c77d1a', '#8e44ad', '#16a085', '#c0392b'];
  const rows = db.prepare(
    `SELECT DISTINCT location_id, trim(position) p FROM employees
     WHERE position IS NOT NULL AND trim(position) <> ''`).all();
  const byLoc = {};
  for (const r of rows) (byLoc[r.location_id] = byLoc[r.location_id] || []).push(r.p);
  const insTag = db.prepare('INSERT INTO staff_tags (location_id, name, color, position) VALUES (?,?,?,?)');
  for (const [loc, names] of Object.entries(byLoc)) {
    names.forEach((n, i) => {
      const id = Number(insTag.run(Number(loc), n, PALETTE[i % PALETTE.length], i).lastInsertRowid);
      db.prepare(`UPDATE employees SET tag_id = ? WHERE location_id = ? AND trim(position) = ?`)
        .run(id, Number(loc), n);
    });
  }
}

// Days the restaurant is closed — blacked out across the whole schedule grid.
if (!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='closed_days'`).get()) {
  db.exec(`CREATE TABLE closed_days (
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    PRIMARY KEY (location_id, date)
  );`);
}
// A colour per shift row, so the grid reads like the owner's spreadsheet.
if (!hasColumn('turns', 'color')) {
  db.exec(`ALTER TABLE turns ADD COLUMN color TEXT`);
}

// Packaging deserves its own benchmark line (delivery-heavy kitchens spend
// real money on it), so the tag list gains 'packaging'. SQLite can't alter a
// CHECK constraint in place — rebuild the table, preserving every row.
if (!db.prepare(`SELECT 1 x FROM pragma_table_info('variable_cost_categories') WHERE name = 'benchmark_tag'`).get()
    || !/packaging/.test(db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='variable_cost_categories'`).get()?.sql || '')) {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    CREATE TABLE variable_cost_categories_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      entry_mode TEXT NOT NULL DEFAULT 'fixed' CHECK (entry_mode IN ('fixed','percent')),
      default_percent REAL,
      default_invoiced INTEGER NOT NULL DEFAULT 0,
      benchmark_tag TEXT CHECK (benchmark_tag IN ('food','labor','packaging') OR benchmark_tag IS NULL),
      position INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO variable_cost_categories_new
      SELECT id, location_id, name, entry_mode, default_percent, default_invoiced, benchmark_tag, position, active
      FROM variable_cost_categories;
    DROP TABLE variable_cost_categories;
    ALTER TABLE variable_cost_categories_new RENAME TO variable_cost_categories;
  `);
  db.exec('PRAGMA foreign_keys = ON;');
}
// Tag packaging-like categories that have no tag yet, whatever schema version
// the database arrived on, so the benchmark works without manual setup.
db.prepare(`UPDATE variable_cost_categories SET benchmark_tag = 'packaging'
  WHERE benchmark_tag IS NULL AND (lower(name) LIKE '%packaging%' OR lower(name) LIKE '%empaque%'
    OR lower(name) LIKE '%to-go%' OR lower(name) LIKE '%desechable%')`).run();

// One-off costs can name a cost category (e.g. a bulk food purchase), so they
// land in the right bucket for benchmarks and the day-to-day cost rate instead
// of being lumped in as "unusual".
if (!hasColumn('oneoff_costs', 'category_id')) {
  db.exec(`ALTER TABLE oneoff_costs ADD COLUMN category_id INTEGER REFERENCES variable_cost_categories(id)`);
}

// Employment dates: an employee only costs money inside their active range.
if (!hasColumn('employees', 'start_date')) {
  db.exec(`ALTER TABLE employees ADD COLUMN start_date TEXT;
           ALTER TABLE employees ADD COLUMN end_date TEXT;`);
  // Existing staff: backdate so historical labor math is unchanged.
  db.exec(`UPDATE employees SET start_date = '2000-01-01' WHERE start_date IS NULL`);
}

// Kitchen feed: append-only log of completed delivery-app orders (items only),
// polled by an external local server via an integer cursor. Plus named API
// tokens for such single-purpose integrations.
if (!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='external_feed'`).get()) {
  db.exec(`
    CREATE TABLE external_feed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL UNIQUE,
      location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      note TEXT,
      items_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE app_tokens (
      name TEXT PRIMARY KEY,
      token TEXT NOT NULL
    );
  `);
}

// Quick-entry links (write-only cost form, one per user, revocable).
if (!hasColumn('oneoff_costs', 'receipt')) {
  db.exec(`ALTER TABLE oneoff_costs ADD COLUMN receipt TEXT;
           ALTER TABLE oneoff_costs ADD COLUMN logged_by TEXT;
           CREATE TABLE IF NOT EXISTS quick_links (
             token TEXT PRIMARY KEY,
             user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
             active INTEGER NOT NULL DEFAULT 1,
             created_at TEXT NOT NULL DEFAULT (datetime('now'))
           );`);
}

// Per-location secret for the inbound POS webhook.
if (!hasColumn('locations', 'webhook_token')) {
  db.exec(`ALTER TABLE locations ADD COLUMN webhook_token TEXT;
           CREATE TABLE IF NOT EXISTS pos_events (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
             received_at TEXT NOT NULL DEFAULT (datetime('now')),
             payload TEXT NOT NULL,
             status TEXT NOT NULL DEFAULT 'stored',
             note TEXT
           );
           CREATE INDEX IF NOT EXISTS idx_pos_events_loc ON pos_events(location_id, id);`);
}

// ---- Default categories for a new location (all fully editable/deletable) ----
// Commission % values are editable starting points — adjust them in Settings
// to match your actual contracts (they vary per agreement).
const DEFAULTS = {
  revenue: [
    { name: 'Tarjeta Menú web',             commission_percent: 3,   commission_invoiced: 1 },
    { name: 'Efectivo Menú web',            commission_percent: 0,   commission_invoiced: 1 },
    { name: 'Tarjeta en tienda',            commission_percent: 2.5, commission_invoiced: 1 },
    { name: 'Efectivo en tienda',           commission_percent: 0,   commission_invoiced: 1 },
    { name: 'Banorte',                      commission_percent: 2.5, commission_invoiced: 1 },
    { name: 'Órdenes de Didi Food',         commission_percent: 25,  commission_invoiced: 1 },
    { name: 'Órdenes de Uber Eats',         commission_percent: 30,  commission_invoiced: 1 },
    { name: 'Órdenes de Rappi',             commission_percent: 25,  commission_invoiced: 1 },
    { name: 'Tarjeta Uber Daas Ecommerce',  commission_percent: 3,   commission_invoiced: 1 },
    { name: 'Efectivo Uber Daas Ecommerce', commission_percent: 0,   commission_invoiced: 1 }
  ],
  variable: [
    { name: 'Food & drink ingredients', entry_mode: 'percent', default_percent: 30, default_invoiced: 1, benchmark_tag: 'food' },
    { name: 'Packaging & to-go supplies', entry_mode: 'percent', default_percent: 2, default_invoiced: 1, benchmark_tag: 'packaging' },
    { name: 'Extra staff / overtime', entry_mode: 'fixed', default_percent: null, default_invoiced: 0, benchmark_tag: 'labor' }
  ],
  accounts: ['Cash', 'Bank 1', 'Bank 2', 'Delivery apps'],
  recurring: [
    { name: 'Rent', benchmark_tag: 'occupancy' },
    { name: 'Salaries (base payroll)', benchmark_tag: 'labor' },
    { name: 'Utilities (electricity, gas, water)', benchmark_tag: null },
    { name: 'Internet & phone', benchmark_tag: null },
    { name: 'Insurance', benchmark_tag: null },
    { name: 'Subscriptions & software', benchmark_tag: null },
    { name: 'Loan payments', benchmark_tag: null }
  ]
};

function seedCategories(locationId) {
  const insRev = db.prepare(
    'INSERT INTO revenue_categories (location_id, name, commission_percent, commission_invoiced, position) VALUES (?,?,?,?,?)');
  DEFAULTS.revenue.forEach((c, i) =>
    insRev.run(locationId, c.name, c.commission_percent, c.commission_invoiced, i));

  const insVar = db.prepare(`INSERT INTO variable_cost_categories
    (location_id, name, entry_mode, default_percent, default_invoiced, benchmark_tag, position)
    VALUES (?,?,?,?,?,?,?)`);
  DEFAULTS.variable.forEach((c, i) =>
    insVar.run(locationId, c.name, c.entry_mode, c.default_percent, c.default_invoiced, c.benchmark_tag, i));

  const insRec = db.prepare('INSERT INTO recurring_cost_categories (location_id, name, benchmark_tag, position) VALUES (?,?,?,?)');
  DEFAULTS.recurring.forEach((c, i) => insRec.run(locationId, c.name, c.benchmark_tag, i));

  const insAcc = db.prepare('INSERT INTO accounts (location_id, name, position) VALUES (?,?,?)');
  DEFAULTS.accounts.forEach((name, i) => insAcc.run(locationId, name, i));
}

db.exec(`INSERT OR IGNORE INTO loyalty_config (id) VALUES (1)`);

// One-time repair (runs after every schema migration above): employees removed
// under the old flow were archived (active = 0) with no end date, which left
// their upcoming shifts orphaned in the schedule and still costing money. Give
// them an end date at their last worked day (history preserved) and drop any
// assignment from today onward.
if (!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_orphan_fix'`).get()) {
  const today = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
  for (const e of db.prepare(`SELECT id FROM employees WHERE active = 0 AND end_date IS NULL`).all()) {
    const last = db.prepare(
      `SELECT MAX(t.date) d FROM turn_assignments ta JOIN turns t ON t.id = ta.turn_id
       WHERE ta.employee_id = ? AND t.date < ?`).get(e.id, today).d;
    db.prepare('UPDATE employees SET end_date = ?, active = 1 WHERE id = ?').run(last || today, e.id);
    db.prepare(
      `DELETE FROM turn_assignments WHERE employee_id = ? AND turn_id IN
         (SELECT id FROM turns WHERE date >= ?)`).run(e.id, today);
  }
  db.exec('CREATE TABLE _orphan_fix (done INTEGER)');
}

function createLocation(name) {
  const { lastInsertRowid } = db.prepare('INSERT INTO locations (name) VALUES (?)').run(name);
  const id = Number(lastInsertRowid);
  seedCategories(id);
  return id;
}

// One-time reseed: locations that still have the untouched pre-commission default
// categories AND no logged data get the new channel-based defaults instead.
(function reseedOldDefaults() {
  const OLD_REVENUE = ['Food sales', 'Drink sales', 'Delivery / takeout'];
  const OLD_VARIABLE = ['Food & drink ingredients', 'Packaging & to-go supplies',
    'Delivery app commissions', 'Card processing fees', 'Extra staff / overtime'];
  const sameSet = (a, b) => a.length === b.length && a.slice().sort().join('|') === b.slice().sort().join('|');

  for (const loc of db.prepare('SELECT id FROM locations WHERE active = 1').all()) {
    // Locations created before the accounts feature get the default accounts.
    if (db.prepare('SELECT COUNT(*) c FROM accounts WHERE location_id = ?').get(loc.id).c === 0) {
      const insAcc = db.prepare('INSERT INTO accounts (location_id, name, position) VALUES (?,?,?)');
      DEFAULTS.accounts.forEach((name, i) => insAcc.run(loc.id, name, i));
    }
    const hasRevData = db.prepare('SELECT COUNT(*) c FROM revenue_entries WHERE location_id = ?').get(loc.id).c > 0;
    const revNames = db.prepare('SELECT name FROM revenue_categories WHERE location_id = ?').all(loc.id).map(r => r.name);
    if (!hasRevData && sameSet(revNames, OLD_REVENUE)) {
      db.prepare('DELETE FROM revenue_categories WHERE location_id = ?').run(loc.id);
      const ins = db.prepare(
        'INSERT INTO revenue_categories (location_id, name, commission_percent, commission_invoiced, position) VALUES (?,?,?,?,?)');
      DEFAULTS.revenue.forEach((c, i) => ins.run(loc.id, c.name, c.commission_percent, c.commission_invoiced, i));
    }
    const hasVarData = db.prepare('SELECT COUNT(*) c FROM variable_costs WHERE location_id = ?').get(loc.id).c > 0;
    const varNames = db.prepare('SELECT name FROM variable_cost_categories WHERE location_id = ?').all(loc.id).map(r => r.name);
    if (!hasVarData && sameSet(varNames, OLD_VARIABLE)) {
      db.prepare('DELETE FROM variable_cost_categories WHERE location_id = ?').run(loc.id);
      const ins = db.prepare(`INSERT INTO variable_cost_categories
        (location_id, name, entry_mode, default_percent, default_invoiced, benchmark_tag, position) VALUES (?,?,?,?,?,?,?)`);
      DEFAULTS.variable.forEach((c, i) =>
        ins.run(loc.id, c.name, c.entry_mode, c.default_percent, c.default_invoiced, c.benchmark_tag, i));
    }
  }
})();

// ---------------------------------------------------------------------------
// Vista de Gerente (shared tablet). Everything here is additive: new tables
// and nullable columns only — no table holding real data is rebuilt.
// ---------------------------------------------------------------------------
db.exec(`
  -- People who run a shift. Not app users: no email, no password, just a PIN
  -- they type on the shared tablet. Owners/managers in "users" are untouched.
  CREATE TABLE IF NOT EXISTS gerentes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS gerente_locations (
    gerente_id INTEGER NOT NULL REFERENCES gerentes(id) ON DELETE CASCADE,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    PRIMARY KEY (gerente_id, location_id)
  );

  -- A registered tablet belongs to one location. Only the hash of its device
  -- token is kept; the token itself lives in an httpOnly cookie on the tablet.
  CREATE TABLE IF NOT EXISTS tablets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT
  );

  -- Checklist templates are data: one per location and type, editable.
  CREATE TABLE IF NOT EXISTS checklist_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('apertura','cierre')),
    header_note TEXT,
    comments_placeholder TEXT,
    footer_note TEXT,
    UNIQUE (location_id, type)
  );
  CREATE TABLE IF NOT EXISTS checklist_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    warning_note TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS checklist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id INTEGER NOT NULL REFERENCES checklist_sections(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    warning INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );

  -- One apertura and one cierre per location per business day. The template
  -- is copied into checklist_run_items when the run STARTS, so editing the
  -- template later can never change a record, finished or half-done.
  CREATE TABLE IF NOT EXISTS checklist_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('apertura','cierre')),
    business_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
    started_at TEXT NOT NULL,
    started_by INTEGER REFERENCES gerentes(id),
    finished_at TEXT,
    finished_by INTEGER REFERENCES gerentes(id),
    comments TEXT,
    header_note TEXT,
    comments_placeholder TEXT,
    footer_note TEXT,
    UNIQUE (location_id, type, business_date)
  );
  CREATE TABLE IF NOT EXISTS checklist_run_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES checklist_runs(id) ON DELETE CASCADE,
    section_pos INTEGER NOT NULL,
    section_title TEXT NOT NULL,
    section_note TEXT,
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    warning INTEGER NOT NULL DEFAULT 0,
    checked_at TEXT,
    checked_by INTEGER REFERENCES gerentes(id),
    op_at TEXT                      -- when the tablet recorded the last tap
  );
  CREATE INDEX IF NOT EXISTS idx_run_items_run ON checklist_run_items(run_id);
  CREATE TABLE IF NOT EXISTS checklist_run_gerentes (
    run_id INTEGER NOT NULL REFERENCES checklist_runs(id) ON DELETE CASCADE,
    gerente_id INTEGER NOT NULL REFERENCES gerentes(id),
    joined_at TEXT NOT NULL,
    PRIMARY KEY (run_id, gerente_id)
  );
`);
// Who did it: nullable, so every existing row simply has no gerente.
for (const table of ['oneoff_costs', 'loyalty_visits', 'loyalty_redemptions', 'loyalty_reward_grants']) {
  if (!hasColumn(table, 'gerente_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN gerente_id INTEGER`);
}
if (!hasColumn('loyalty_reward_grants', 'redeemed_gerente_id')) {
  db.exec(`ALTER TABLE loyalty_reward_grants ADD COLUMN redeemed_gerente_id INTEGER`);
}
if (!hasColumn('oneoff_costs', 'tablet_id')) db.exec(`ALTER TABLE oneoff_costs ADD COLUMN tablet_id INTEGER`);

// ---------------------------------------------------------------------------
// Inventario: catálogo de insumos + compras. Additive only.
//
// The money of a purchase lives in oneoff_costs — the same rows the quick
// register writes — one per purchase line, so purchases reach the profit
// numbers through the existing path and there is no second cost ledger. These
// tables add WHAT was bought (insumo, quantity, unit price) on top of it.
// Recipes, yields, counts and stock are deliberately absent; cantidad_base is
// stored so they can be built on this later.
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS proveedores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    nombre_normalizado TEXT NOT NULL,
    notas TEXT,
    activo INTEGER NOT NULL DEFAULT 1,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One catalog for every sucursal, so prices are comparable between them.
  CREATE TABLE IF NOT EXISTS insumos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    nombre_normalizado TEXT NOT NULL,
    categoria TEXT NOT NULL CHECK (categoria IN ('Proteína','Abarrotes','Lácteos','Desechables','Bebidas','Otros')),
    unidad_base TEXT NOT NULL CHECK (unidad_base IN ('kg','litro','pieza')),
    activo INTEGER NOT NULL DEFAULT 1,
    revisado INTEGER NOT NULL DEFAULT 0,
    merged_into INTEGER REFERENCES insumos(id),   -- a merged insumo is kept, never deleted
    creado_por_gerente INTEGER REFERENCES gerentes(id),
    creado_por_usuario INTEGER REFERENCES users(id),
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_insumos_norm ON insumos(nombre_normalizado);

  CREATE TABLE IF NOT EXISTS insumo_presentaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    insumo_id INTEGER NOT NULL REFERENCES insumos(id),
    nombre TEXT NOT NULL,
    nombre_normalizado TEXT NOT NULL,
    factor REAL NOT NULL CHECK (factor > 0),      -- 1 presentación = factor unidades base
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_present_insumo ON insumo_presentaciones(insumo_id);

  CREATE TABLE IF NOT EXISTS compras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_uid TEXT UNIQUE,                       -- made on the phone: a retried upload never duplicates
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    fecha TEXT NOT NULL,
    proveedor_id INTEGER REFERENCES proveedores(id),
    account_id INTEGER REFERENCES accounts(id),
    gerente_id INTEGER REFERENCES gerentes(id),
    usuario_id INTEGER REFERENCES users(id),
    foto TEXT,
    notas TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_compras_loc_fecha ON compras(location_id, fecha);

  -- factor_snapshot, cantidad_base, costo_unitario_base and the unit are frozen
  -- here at purchase time. History is never recomputed from the catalog.
  CREATE TABLE IF NOT EXISTS compra_lineas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    compra_id INTEGER NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
    insumo_id INTEGER NOT NULL REFERENCES insumos(id),
    presentacion_id INTEGER REFERENCES insumo_presentaciones(id),
    presentacion_nombre TEXT,
    cantidad REAL NOT NULL,
    factor_snapshot REAL NOT NULL,
    cantidad_base REAL NOT NULL,
    unidad_base_snapshot TEXT NOT NULL,
    total_linea REAL NOT NULL,
    costo_unitario_base REAL NOT NULL,
    oneoff_cost_id INTEGER NOT NULL UNIQUE REFERENCES oneoff_costs(id)   -- where the money is
  );
  CREATE INDEX IF NOT EXISTS idx_lineas_insumo ON compra_lineas(insumo_id);
  CREATE INDEX IF NOT EXISTS idx_lineas_compra ON compra_lineas(compra_id);

  -- Which existing cost category each insumo categoría posts into, per sucursal.
  -- NULL = uncategorised (lands with the unusual one-offs).
  CREATE TABLE IF NOT EXISTS insumo_categoria_map (
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    categoria TEXT NOT NULL,
    cost_category_id INTEGER REFERENCES variable_cost_categories(id),
    PRIMARY KEY (location_id, categoria)
  );

  CREATE TABLE IF NOT EXISTS inventario_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    alerta_pct REAL NOT NULL DEFAULT 12,
    alerta_n INTEGER NOT NULL DEFAULT 5
  );
  INSERT OR IGNORE INTO inventario_config (id) VALUES (1);

  -- A gerente's own phone: a personal, revocable link (only its hash is kept),
  -- then their PIN every session.
  CREATE TABLE IF NOT EXISTS gerente_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gerente_id INTEGER NOT NULL REFERENCES gerentes(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT
  );
`);

module.exports = { db, DATA_DIR, createLocation };
