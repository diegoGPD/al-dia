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
    { name: 'Packaging & to-go supplies', entry_mode: 'percent', default_percent: 2, default_invoiced: 1, benchmark_tag: null },
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

module.exports = { db, DATA_DIR, createLocation };
