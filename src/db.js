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
