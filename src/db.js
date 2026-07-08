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

CREATE TABLE IF NOT EXISTS revenue_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS revenue_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES revenue_entries(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES revenue_categories(id) ON DELETE CASCADE,
  amount REAL NOT NULL DEFAULT 0,
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

// ---- Default categories for a new location (all fully editable/deletable) ----
const DEFAULTS = {
  revenue: ['Food sales', 'Drink sales', 'Delivery / takeout'],
  variable: [
    { name: 'Food & drink ingredients', entry_mode: 'percent', default_percent: 30, default_invoiced: 1, benchmark_tag: 'food' },
    { name: 'Packaging & to-go supplies', entry_mode: 'percent', default_percent: 2, default_invoiced: 1, benchmark_tag: null },
    { name: 'Delivery app commissions', entry_mode: 'percent', default_percent: 8, default_invoiced: 1, benchmark_tag: null },
    { name: 'Card processing fees', entry_mode: 'percent', default_percent: 3, default_invoiced: 1, benchmark_tag: null },
    { name: 'Extra staff / overtime', entry_mode: 'fixed', default_percent: null, default_invoiced: 0, benchmark_tag: 'labor' }
  ],
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
  const insRev = db.prepare('INSERT INTO revenue_categories (location_id, name, position) VALUES (?,?,?)');
  DEFAULTS.revenue.forEach((name, i) => insRev.run(locationId, name, i));

  const insVar = db.prepare(`INSERT INTO variable_cost_categories
    (location_id, name, entry_mode, default_percent, default_invoiced, benchmark_tag, position)
    VALUES (?,?,?,?,?,?,?)`);
  DEFAULTS.variable.forEach((c, i) =>
    insVar.run(locationId, c.name, c.entry_mode, c.default_percent, c.default_invoiced, c.benchmark_tag, i));

  const insRec = db.prepare('INSERT INTO recurring_cost_categories (location_id, name, benchmark_tag, position) VALUES (?,?,?,?)');
  DEFAULTS.recurring.forEach((c, i) => insRec.run(locationId, c.name, c.benchmark_tag, i));
}

function createLocation(name) {
  const { lastInsertRowid } = db.prepare('INSERT INTO locations (name) VALUES (?)').run(name);
  const id = Number(lastInsertRowid);
  seedCategories(id);
  return id;
}

module.exports = { db, DATA_DIR, createLocation };
