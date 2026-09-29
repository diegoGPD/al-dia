// PideDirecto integration: turns order webhooks (and nightly reconciliation
// via their API) into revenue entries, using the existing categories/accounts.
//
// - Arrives on the SAME already-configured webhook URL (/api/webhooks/pos/<token>).
// - Idempotent: every order lands in pd_orders keyed by orderId; the affected
//   day's revenue is rebuilt from that ledger, so retries and cancellations
//   can never double-count.
// - Revenue uses the order's `total` (what the customer paid, i.e. GROSS);
//   delivery-app commissions are then applied by the existing channel
//   commission model, matching how manual logging works.
//
// Env (server-side only, never logged):
//   PIDEDIRECTO_API_KEY   — private production key
//   PIDEDIRECTO_API_BASE  — optional, default https://api.pidedirecto.mx
const { db } = require('../db');
const { num } = require('../lib/parse');
const { todayStr, addDays: addDaysLib } = require('../lib/dates');
const { upsertDayRevenue } = require('../lib/revenue');

const apiKeyPresent = () => !!process.env.PIDEDIRECTO_API_KEY;

// Their docs don't publish the API base URL (it comes from the account
// manager), so we probe likely combinations once and remember what works.
// PIDEDIRECTO_API_BASE overrides everything if set.
const BASE_CANDIDATES = () => [
  process.env.PIDEDIRECTO_API_BASE,
  'https://api.pidedirecto.mx',
  'https://api.pidedirecto.com'
].filter(Boolean);
const PATH_PREFIXES = ['/pidedirectoexternal', '/api', ''];
let workingApi = null; // { base, prefix } once discovered

async function pdApi(method, body) {
  if (!apiKeyPresent()) throw new Error('PIDEDIRECTO_API_KEY not configured');
  const headers = { 'Content-Type': 'application/json', 'x-api-key': process.env.PIDEDIRECTO_API_KEY };
  const combos = workingApi ? [workingApi]
    : BASE_CANDIDATES().flatMap(base => PATH_PREFIXES.map(prefix => ({ base, prefix })));
  const tried = [];
  for (const c of combos) {
    const url = `${c.base}${c.prefix}/${method}`;
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (res.status === 404) { tried.push(`${url} → 404`); continue; }
      if (!res.ok) throw new Error(`${method} HTTP ${res.status} at ${url}`);
      workingApi = c;
      return await res.json();
    } catch (e) {
      if (String(e.message).includes('HTTP')) throw e;
      tried.push(`${url} → ${e.message}`);
    }
  }
  workingApi = null;
  throw new Error(`Could not reach PideDirecto API (${method}). Tried: ${tried.join('; ')}. ` +
    'Ask your account manager for the production API base URL and set PIDEDIRECTO_API_BASE.');
}

// Mexico City is UTC-6 year-round (no DST since 2022); todayStr() uses the
// same offset, so orders and period boundaries agree on what "today" means.
const TZ_OFFSET_H = Number(process.env.TZ_OFFSET_HOURS ?? -6);
function localDate(isoTs) {
  const t = Date.parse(isoTs);
  if (!Number.isFinite(t)) return todayStr();
  return new Date(t + TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10);
}

// ---------- payload interpretation (defensive: field names verified against
// docs where possible, tolerant where the docs were incomplete) ----------
function extractOrder(payload) {
  const o = (payload.order && typeof payload.order === 'object') ? { ...payload, ...payload.order } : payload;
  const orderId = o.orderId || o.order_id || null;
  if (!orderId) return null;
  const eventType = String(payload.eventType || payload.event || payload.webhookEventType || payload.type || '').toUpperCase();
  const orderStatus = String(o.orderStatus || o.status || '').toUpperCase();
  let status = 'OTHER';
  if (eventType === 'ORDER_COMPLETED' || orderStatus === 'COMPLETE' || orderStatus === 'COMPLETED' || o.completedAt) status = 'COMPLETE';
  if (eventType === 'ORDER_CANCELLED' || eventType === 'ORDER_REJECTED' ||
      orderStatus === 'CANCELLED' || orderStatus === 'REJECTED' || o.cancelledAt) status = 'CANCELLED';
  // Payment method, incl. custom methods (this is how a "BanRegio" terminal
  // shows up); verified against live payloads via the Settings event log.
  const custom = o.customPaymentMethod ||
    (Array.isArray(o.payments) && o.payments[0] && o.payments[0].customPaymentMethod) || null;
  const method = String(o.paymentMethod || '').toUpperCase() || null;
  return {
    orderId: String(orderId),
    eventType: eventType || null,
    status,
    channel: String(o.app || o.channel || '').toUpperCase() || null,
    paymentMethod: [method, custom ? String(custom).toUpperCase() : null].filter(Boolean).join('/') || null,
    amount: num(o.total ?? o.subtotal),
    date: localDate(o.completedAt || o.deliveredAt || o.createdAt || o.acceptedAt),
    storeId: o.storeId || null
  };
}

// Food-prep info only, mapped from the documented orderItems structure —
// no customer, address or payment data ever leaves through this path.
function extractItems(o) {
  const src = (o.order && typeof o.order === 'object') ? o.order : o;
  const items = [];
  for (const it of (Array.isArray(src.orderItems) ? src.orderItems : [])) {
    const modifiers = [];
    for (const g of (it.modifierGroups || [])) {
      for (const m of (g.modifiers || [])) {
        modifiers.push((m.quantity > 1 ? `${m.quantity}× ` : '') + (m.name || ''));
        for (const sg of (m.subModifierGroups || [])) {
          for (const sm of (sg.subModifiers || [])) {
            modifiers.push((sm.quantity > 1 ? `${sm.quantity}× ` : '') + (sm.name || ''));
          }
        }
      }
    }
    items.push({
      name: it.name || '?',
      quantity: it.quantity ?? 1,
      ...(it.note ? { note: String(it.note) } : {}),
      modifiers
    });
  }
  return items;
}

const FEED_CHANNELS = ['UBER_EATS', 'RAPPI', 'DIDI_FOOD'];

// Appends exactly once per order (order_id UNIQUE) — webhook retries and
// reconciler overlaps can't duplicate feed entries. Emits on the FIRST event
// we see for a delivery-app order (normally ORDER_CREATED), because the
// kitchen needs it while there's still food to prepare — not at completion.
function feedInsert(locationId, o, rawPayload) {
  if (o.status === 'CANCELLED' || !FEED_CHANNELS.includes(o.channel)) return;
  const items = extractItems(rawPayload || {});
  const src = (rawPayload && rawPayload.order) || rawPayload || {};
  const note = src.notes || src.instructions || null;
  db.prepare(`INSERT OR IGNORE INTO external_feed (order_id, location_id, channel, note, items_json)
    VALUES (?,?,?,?,?)`)
    .run(o.orderId, locationId, o.channel, note ? String(note).slice(0, 300) : null, JSON.stringify(items));
}

function looksLikePideDirecto(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const o = (payload.order && typeof payload.order === 'object') ? payload.order : payload;
  return !!(o.orderId && (o.app || o.orderStatus || payload.eventType || payload.event || o.total !== undefined));
}

// ---------- mapping PD channels/payments to the user's categories/accounts ----------
function findCategory(cats, needles) {
  const hit = cats.find(c => needles.some(n => c.name.toLowerCase().includes(n)));
  return hit ? hit.id : null;
}

function buildMapping(locationId) {
  const cats = db.prepare(
    'SELECT id, name FROM revenue_categories WHERE location_id = ? AND active = 1').all(locationId);
  const accounts = db.prepare(
    'SELECT id, name FROM accounts WHERE location_id = ? AND active = 1').all(locationId);

  // Strict classification: unknown POS payment methods are NOT guessed —
  // they land in the unclassified bucket and get flagged for the owner,
  // because POS commission depends on how the customer paid (0/5/17%).
  const categoryFor = (channel, payment) => {
    const pay = payment || '';
    switch (channel) {
      case 'UBER_EATS': return findCategory(cats, ['uber eats']);
      case 'DIDI_FOOD': return findCategory(cats, ['didi']);
      case 'RAPPI': return findCategory(cats, ['rappi']);
      case 'PEDIDOS_YA': return findCategory(cats, ['pedidos ya', 'pedidosya']);
      case 'PIDEDIRECTOPOS':
      case 'PIDEDIRECTOKIOSK':
        if (pay.includes('BANREGIO')) return findCategory(cats, ['banregio', 'banorte']);
        if (pay.startsWith('CASH')) return findCategory(cats, ['efectivo en tienda']);
        if (pay.startsWith('CARD')) return findCategory(cats, ['tarjeta en tienda']);
        return null; // PAYMENT_TERMINAL / TRANSFER / MULTIPLE / etc. → flag, don't guess
      case 'PIDEDIRECTO': // their ecommerce (menú web)
        if (pay.startsWith('CASH')) return findCategory(cats, ['efectivo menú web', 'efectivo menu web']);
        return findCategory(cats, ['tarjeta menú web', 'tarjeta menu web']);
      default: return null;
    }
  };

  const DELIVERY = ['UBER_EATS', 'DIDI_FOOD', 'RAPPI', 'PEDIDOS_YA'];
  const accountFor = (channel, payment) => {
    if (DELIVERY.includes(channel)) {
      const a = accounts.find(x => /delivery|apps/i.test(x.name));
      return a ? a.id : null;
    }
    if (payment === 'CASH') { // cash physically received
      const a = accounts.find(x => /^(cash|efectivo)$/i.test(x.name.trim()));
      return a ? a.id : null;
    }
    return null; // don't guess where card/transfer money landed
  };

  return { categoryFor, accountFor };
}

// ---------- ledger + day rebuild ----------
// The ONLY way an order gets a location: its own restaurant id, matched
// against locations.pd_store_id. No name matching, no "current" location, no
// default — an unrecognised restaurant is parked as unassigned for review.
// Matches on any location, active or not: the restaurant id is unique, so it
// identifies one location unambiguously, and an order should never be filed
// somewhere else just because its restaurant was temporarily deactivated.
function resolveLocation(storeId) {
  if (!storeId) return null;
  const row = db.prepare(
    'SELECT id FROM locations WHERE pd_store_id = ?').get(String(storeId).trim());
  return row ? row.id : null;
}

function upsertOrder(locationId, o, source) {
  db.prepare(`INSERT INTO pd_orders (order_id, location_id, date, channel, payment_method, amount, status, source, store_id, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT (order_id) DO UPDATE SET
      location_id = excluded.location_id, date = excluded.date, channel = excluded.channel,
      payment_method = excluded.payment_method, amount = excluded.amount, status = excluded.status,
      store_id = COALESCE(excluded.store_id, pd_orders.store_id), updated_at = datetime('now')`)
    .run(o.orderId, locationId, o.date, o.channel, o.paymentMethod, o.amount, o.status, source, o.storeId || null);
}

// Rebuild one day's revenue entry from all COMPLETE orders in the ledger.
function rebuildDay(locationId, date) {
  const orders = db.prepare(
    `SELECT * FROM pd_orders WHERE location_id = ? AND date = ? AND status = 'COMPLETE'`)
    .all(locationId, date);

  // Safety guards so bad/missing order data never wipes a day's real numbers:
  // 1. Orders whose amounts are all zero mean we couldn't fetch details yet.
  // 2. A day never touched by PideDirecto data isn't overwritten by an empty rebuild.
  const existing = db.prepare(
    'SELECT note FROM revenue_entries WHERE location_id = ? AND date = ?').get(locationId, date);
  const enriched = orders.filter(o => o.amount > 0);
  if (orders.length && !enriched.length)
    return { skipped: true, reason: 'orders have no amounts yet (details pending)', orders: orders.length };
  if (!orders.length && (!existing || existing.note !== 'PideDirecto (auto)'))
    return { skipped: true, reason: 'no PD orders and day not PD-managed', orders: 0 };

  const { categoryFor, accountFor } = buildMapping(locationId);

  const items = {}, accounts = {};
  const unmapped = {};
  for (const o of orders) {
    const catId = categoryFor(o.channel, o.payment_method);
    if (catId) items[catId] = (items[catId] || 0) + o.amount;
    else unmapped[o.channel || '?'] = (unmapped[o.channel || '?'] || 0) + o.amount;
    const accId = accountFor(o.channel, o.payment_method);
    if (accId) accounts[accId] = (accounts[accId] || 0) + o.amount;
  }
  const unmappedTotal = Object.values(unmapped).reduce((s, v) => s + v, 0);
  const result = upsertDayRevenue(locationId, date, {
    // Unmapped orders still count in the day's total so money never vanishes —
    // they just lack a channel breakdown until a category is mapped.
    total: unmappedTotal,
    items: Object.entries(items).map(([category_id, amount]) => ({ category_id: Number(category_id), amount })),
    accounts: Object.entries(accounts).map(([account_id, amount]) => ({ account_id: Number(account_id), amount })),
    note: 'PideDirecto (auto)'
  });
  // upsertDayRevenue uses breakdown sum when items exist; add unmapped on top if both present
  if (Object.keys(items).length && unmappedTotal > 0) {
    const itemsSum = Object.values(items).reduce((s, v) => s + v, 0);
    db.prepare('UPDATE revenue_entries SET total = ? WHERE location_id = ? AND date = ?')
      .run(itemsSum + unmappedTotal, locationId, date);
  }
  return { orders: orders.length, total: result.total + (Object.keys(items).length ? unmappedTotal : 0), unmapped };
}

// ---------- webhook entry point ----------
// Live payloads are thin notifications ({orderId, storeId, eventType,
// occurredAt}) — the money fields come from a getOrder call.
// NOTE: `tokenLocationId` is the location that owns the webhook URL. It is used
// ONLY to file the raw event for inspection. It never decides where the order
// goes: PideDirecto exposes a single webhook URL for every restaurant, so the
// token says nothing about which restaurant sent the order. The order's own
// storeId decides, or it stays unassigned.
async function processWebhook(tokenLocationId, payload) {
  let o = extractOrder(payload);
  if (!o) return { status: 'stored', note: 'PideDirecto-like payload without orderId — stored for inspection' };

  let enrichNote = '';
  let fullRaw = payload;
  if ((o.amount <= 0 || !o.channel) && apiKeyPresent()) {
    try {
      const raw = await pdApi('getOrder', { orderId: o.orderId });
      const full = extractOrder(raw && typeof raw === 'object' ? raw : {});
      if (full) {
        fullRaw = raw;
        o = { ...full,
          status: o.status !== 'OTHER' ? o.status : full.status,
          eventType: o.eventType || full.eventType };
      }
    } catch (e) {
      enrichNote = ` ⚠ couldn't fetch order details (${e.message.slice(0, 160)}) — amount pending, the reconciler will fill it in.`;
    }
  } else if (o.amount <= 0 && !apiKeyPresent()) {
    enrichNote = ' ⚠ webhook carries no amount and PIDEDIRECTO_API_KEY is not set — cannot fetch order details.';
  }

  const locationId = resolveLocation(o.storeId);
  if (locationId === null) {
    // Never guess. Park it with no location so it shows up under Unassigned
    // orders and can be claimed once the restaurant id is configured.
    upsertOrder(null, o, 'webhook');
    return {
      status: 'unassigned',
      note: o.storeId
        ? `Order ${o.orderId.slice(0, 8)}… saved as UNASSIGNED — restaurant id ${String(o.storeId).slice(0, 12)}… doesn't match any location. Add it to a location in Settings → PideDirecto, then re-assign from Settings → Unassigned orders.`
        : `Order ${o.orderId.slice(0, 8)}… saved as UNASSIGNED — the payload carries no restaurant id.`
    };
  }

  upsertOrder(locationId, o, 'webhook');
  feedInsert(locationId, o, fullRaw);
  if (o.status === 'OTHER') {
    return { status: 'tracked', note: `Order ${o.orderId.slice(0, 8)}… ${o.eventType || 'update'} tracked (revenue only counts completed orders)${enrichNote}` };
  }
  const r = rebuildDay(locationId, o.date);
  if (r.skipped) {
    return { status: 'tracked', note: `Order ${o.orderId.slice(0, 8)}… recorded but day not rebuilt: ${r.reason}.${enrichNote}` };
  }
  const unmappedNote = Object.keys(r.unmapped).length
    ? ` ⚠ unmapped channels: ${Object.entries(r.unmapped).map(([c, v]) => `${c} (${v.toFixed(2)})`).join(', ')} — counted in the total, add matching sales channels in Settings for the breakdown.`
    : '';
  return {
    status: 'processed',
    note: `${o.status === 'CANCELLED' ? 'Cancellation' : 'Completed order'} ${o.orderId.slice(0, 8)}… (${o.channel || '?'}${o.paymentMethod ? ' · ' + o.paymentMethod : ''}, ${o.amount.toFixed(2)}) → ${o.date} rebuilt from ${r.orders} orders, total ${r.total.toFixed(2)}.${unmappedNote}${enrichNote}`
  };
}

// ---------- real commission rates per channel (owner-editable) ----------
// Rates live on the matching revenue category (commission_percent), which the
// owner can edit any time in Settings. This table defines the channel →
// category match and the real rates for one-tap application.
const PD_RATE_TARGETS = [
  { key: 'UBER_EATS', label: 'Uber Eats', needles: ['uber eats'], percent: 55 },
  { key: 'RAPPI', label: 'Rappi', needles: ['rappi'], percent: 45 },
  { key: 'DIDI_FOOD', label: 'Didi Food', needles: ['didi'], percent: 50 },
  { key: 'PIDEDIRECTO_CARD', label: 'PideDirecto web (tarjeta)', needles: ['tarjeta menú web', 'tarjeta menu web'], percent: 8 },
  { key: 'PIDEDIRECTO_CASH', label: 'PideDirecto web (efectivo)', needles: ['efectivo menú web', 'efectivo menu web'], percent: 8 },
  { key: 'POS_CASH', label: 'POS — efectivo', needles: ['efectivo en tienda'], percent: 0 },
  { key: 'POS_CARD', label: 'POS — tarjeta', needles: ['tarjeta en tienda'], percent: 5 },
  { key: 'POS_BANREGIO', label: 'POS — BanRegio', needles: ['banregio', 'banorte'], percent: 17 }
];

function ratesView(locationId) {
  const cats = db.prepare(
    'SELECT id, name, commission_percent FROM revenue_categories WHERE location_id = ? AND active = 1').all(locationId);
  return PD_RATE_TARGETS.map(t => {
    const cat = cats.find(c => t.needles.some(n => c.name.toLowerCase().includes(n)));
    return { ...t, category: cat ? { id: cat.id, name: cat.name, current: cat.commission_percent } : null };
  });
}

function applyRealRates(locationId) {
  const view = ratesView(locationId);
  const applied = [], unmatched = [];
  for (const t of view) {
    if (!t.category) { unmatched.push(t.label); continue; }
    db.prepare('UPDATE revenue_categories SET commission_percent = ? WHERE id = ?')
      .run(t.percent, t.category.id);
    applied.push(`${t.category.name} → ${t.percent}%`);
  }
  return { applied, unmatched };
}

// ---------- reconciliation via their API (safety net for missed webhooks) ----------
async function backfillRange(locationId, startIso, endIso) {
  const loc = db.prepare('SELECT pd_store_id FROM locations WHERE id = ?').get(locationId);
  if (!loc?.pd_store_id || !apiKeyPresent()) {
    return { skipped: true, reason: !loc?.pd_store_id ? 'no store id configured' : 'no API key configured' };
  }
  const body = await pdApi('getOrders', { storeId: loc.pd_store_id, startDate: startIso, endDate: endIso });
  const orders = Array.isArray(body) ? body : (body.orders || []);

  const { categoryFor } = buildMapping(locationId);
  const catNames = Object.fromEntries(db.prepare(
    'SELECT id, name FROM revenue_categories WHERE location_id = ?').all(locationId).map(c => [c.id, c.name]));
  const dates = new Set();
  const byChannel = {}; // classification report
  let seen = 0, foreign = 0, unassigned = 0;
  for (const raw of orders) {
    const o = extractOrder(raw);
    if (!o) continue;
    // Route each order by its own restaurant id, exactly like the webhook. The
    // query was filtered to this location's restaurant id, so an order that
    // came back without one belongs to that same id by construction; anything
    // carrying a different id is filed where it really belongs, never here.
    const storeId = o.storeId || loc.pd_store_id;
    const ownerId = resolveLocation(storeId);
    if (ownerId === null) { upsertOrder(null, { ...o, storeId }, 'backfill'); unassigned++; seen++; continue; }
    if (ownerId !== locationId) {
      upsertOrder(ownerId, { ...o, storeId }, 'backfill');
      feedInsert(ownerId, o, raw);
      if (o.status === 'COMPLETE') rebuildDay(ownerId, o.date);
      foreign++; seen++; continue;
    }
    upsertOrder(locationId, { ...o, storeId }, 'backfill');
    feedInsert(locationId, o, raw);
    if (o.status === 'COMPLETE') {
      const catId = categoryFor(o.channel, o.paymentMethod);
      const key = catId
        ? `${o.channel}${o.paymentMethod ? ' · ' + o.paymentMethod : ''} → ${catNames[catId]}`
        : `⚠ UNCLASSIFIED: ${o.channel || '?'} · ${o.paymentMethod || 'no payment method'}`;
      const b = byChannel[key] = byChannel[key] || { count: 0, amount: 0, classified: !!catId };
      b.count++; b.amount += o.amount;
    }
    dates.add(o.date);
    seen++;
  }
  for (const d of dates) rebuildDay(locationId, d);
  return {
    skipped: false, orders: seen, daysRebuilt: dates.size, foreign, unassigned,
    report: Object.entries(byChannel)
      .sort((a, b) => b[1].amount - a[1].amount)
      .map(([k, v]) => ({ group: k, count: v.count, amount: Math.round(v.amount * 100) / 100, classified: v.classified })),
    unclassified: Object.values(byChannel).filter(v => !v.classified).reduce((s, v) => s + v.count, 0)
  };
}

async function reconcileLocation(locationId, daysBack = 3) {
  return backfillRange(locationId,
    new Date(Date.now() - daysBack * 864e5).toISOString(),
    new Date(Date.now() + 864e5).toISOString());
}

async function reconcileAll() {
  if (!apiKeyPresent()) return;
  const locs = db.prepare(
    `SELECT id FROM locations WHERE active = 1 AND pd_store_id IS NOT NULL`).all();
  for (const l of locs) {
    try {
      const r = await reconcileLocation(l.id);
      if (!r.skipped) console.log(`PideDirecto reconcile loc ${l.id}: ${r.orders} orders, ${r.daysRebuilt} days`);
    } catch (e) { console.error(`PideDirecto reconcile loc ${l.id}:`, e.message); }
  }
}

// Nightly-ish safety net: on boot and every 6 hours.
function startReconciler() {
  setTimeout(reconcileAll, 30e3);
  setInterval(reconcileAll, 6 * 3600e3);
}

function statusFor(locationId) {
  const loc = db.prepare('SELECT pd_store_id FROM locations WHERE id = ?').get(locationId);
  const today = localDate(new Date().toISOString());
  return {
    storeId: loc?.pd_store_id || null,
    apiKeyPresent: apiKeyPresent(),
    ordersToday: db.prepare(
      `SELECT COUNT(*) c FROM pd_orders WHERE location_id = ? AND date = ? AND status = 'COMPLETE'`)
      .get(locationId, today).c,
    totalOrders: db.prepare('SELECT COUNT(*) c FROM pd_orders WHERE location_id = ?').get(locationId).c
  };
}

// ---------- unassigned orders (admin review) ----------
// Orders whose restaurant id matched no location. They are never guessed into a
// location; the owner either configures the id or assigns them by hand.
function unassignedOrders(limit = 200) {
  const rows = db.prepare(
    `SELECT order_id, store_id, date, channel, payment_method, amount, status, source, updated_at
       FROM pd_orders WHERE location_id IS NULL
      ORDER BY date DESC, updated_at DESC LIMIT ?`).all(limit);
  const groups = {};
  for (const r of rows) {
    const k = r.store_id || '(no restaurant id)';
    const g = groups[k] = groups[k] || { storeId: r.store_id, count: 0, amount: 0, firstDate: r.date, lastDate: r.date };
    g.count++;
    if (r.status === 'COMPLETE') g.amount += r.amount;
    if (r.date < g.firstDate) g.firstDate = r.date;
    if (r.date > g.lastDate) g.lastDate = r.date;
  }
  return {
    total: db.prepare('SELECT COUNT(*) c FROM pd_orders WHERE location_id IS NULL').get().c,
    groups: Object.values(groups).sort((a, b) => b.count - a.count),
    orders: rows
  };
}

// Claim every unassigned order carrying `storeId` for a location, and record
// the restaurant id on that location so future orders route themselves.
function claimStore(locationId, storeId) {
  const sid = String(storeId || '').trim();
  if (!sid) return { moved: 0, reason: 'no restaurant id given' };
  const clash = db.prepare(
    'SELECT id, name FROM locations WHERE pd_store_id = ? AND id <> ?').get(sid, locationId);
  if (clash) return { moved: 0, reason: `restaurant id already belongs to ${clash.name}` };
  const own = db.prepare('SELECT pd_store_id, name FROM locations WHERE id = ?').get(locationId);
  // One location = one restaurant. Refuse to silently replace a configured id,
  // which would orphan every order already routed by it.
  if (own?.pd_store_id && String(own.pd_store_id).trim() !== sid) {
    return { moved: 0, reason: `${own.name} is already set to restaurant id ${String(own.pd_store_id).slice(0, 12)}… — clear it first, or assign this one to another location` };
  }
  const rows = db.prepare(
    'SELECT order_id, date, status FROM pd_orders WHERE location_id IS NULL AND store_id = ?').all(sid);
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE locations SET pd_store_id = ? WHERE id = ?').run(sid, locationId);
    db.prepare('UPDATE pd_orders SET location_id = ?, updated_at = datetime(\'now\') WHERE location_id IS NULL AND store_id = ?')
      .run(locationId, sid);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const dates = [...new Set(rows.filter(r => r.status === 'COMPLETE').map(r => r.date))];
  for (const d of dates) rebuildDay(locationId, d);
  return { moved: rows.length, daysRebuilt: dates.length };
}

// ---------- recovering the restaurant id for orders stored before we kept it ----------
// Offline and free: every webhook delivery is kept verbatim in pos_events, and
// those payloads carry the restaurant id. Only fills blanks — never overwrites.
function backfillStoreIdsFromEvents() {
  const events = db.prepare('SELECT payload FROM pos_events ORDER BY id').all();
  const upd = db.prepare(
    'UPDATE pd_orders SET store_id = ? WHERE order_id = ? AND store_id IS NULL');
  let filled = 0, scanned = 0;
  for (const e of events) {
    let p; try { p = JSON.parse(e.payload); } catch { continue; }
    const o = extractOrder(p && typeof p === 'object' ? p : {});
    if (!o || !o.storeId) continue;
    scanned++;
    if (upd.run(String(o.storeId).trim(), o.orderId).changes) filled++;
  }
  return { events: events.length, withStoreId: scanned, filled };
}

// The complete but slow path: ask PideDirecto for each order still missing its
// restaurant id. Read-only against their API; writes nothing but store_id.
async function fetchMissingStoreIds(limit = 300) {
  if (!apiKeyPresent()) return { skipped: true, reason: 'no API key configured' };
  const rows = db.prepare(
    `SELECT order_id FROM pd_orders WHERE store_id IS NULL ORDER BY date DESC LIMIT ?`).all(limit);
  const upd = db.prepare('UPDATE pd_orders SET store_id = ? WHERE order_id = ?');
  let filled = 0, failed = 0;
  for (const r of rows) {
    try {
      const raw = await pdApi('getOrder', { orderId: r.order_id });
      const o = extractOrder(raw && typeof raw === 'object' ? raw : {});
      if (o && o.storeId) { upd.run(String(o.storeId).trim(), r.order_id); filled++; }
      else failed++;
    } catch { failed++; }
  }
  const left = db.prepare('SELECT COUNT(*) c FROM pd_orders WHERE store_id IS NULL').get().c;
  return { skipped: false, tried: rows.length, filled, failed, stillMissing: left };
}

// ---------- one-time repair of historically mis-routed orders ----------
// Recomputes location_id for EVERY stored order from its own restaurant id.
// Nothing is deleted and no amounts change — only location_id moves.
// dryRun (default) reports what would change and touches nothing.
function repairOrderLocations({ dryRun = true } = {}) {
  const locs = db.prepare('SELECT id, name, pd_store_id FROM locations').all();
  const nameOf = id => (locs.find(l => l.id === id)?.name || (id === null ? 'unassigned' : `location ${id}`));
  const byStore = new Map(locs.filter(l => l.pd_store_id).map(l => [String(l.pd_store_id).trim(), l.id]));

  const orders = db.prepare(
    `SELECT order_id, location_id, store_id, date, amount, status FROM pd_orders`).all();
  const moves = new Map();          // "from → to" -> stats
  const changes = [];               // per-order log
  let noStoreId = 0;

  for (const o of orders) {
    const sid = o.store_id ? String(o.store_id).trim() : null;
    // No restaurant id stored → we cannot know where it belongs. Leave it
    // exactly as it is rather than guessing or blanking it.
    if (!sid) { noStoreId++; continue; }
    const target = byStore.has(sid) ? byStore.get(sid) : null;
    if (target === o.location_id) continue;
    const key = `${nameOf(o.location_id)} → ${nameOf(target)}`;
    const m = moves.get(key) || { from: nameOf(o.location_id), to: nameOf(target), count: 0, sales: 0, firstDate: o.date, lastDate: o.date };
    m.count++;
    if (o.status === 'COMPLETE') m.sales += o.amount;
    if (o.date < m.firstDate) m.firstDate = o.date;
    if (o.date > m.lastDate) m.lastDate = o.date;
    moves.set(key, m);
    changes.push({ order_id: o.order_id, old_location: nameOf(o.location_id), new_location: nameOf(target),
                   old_location_id: o.location_id, new_location_id: target, date: o.date, amount: o.amount, status: o.status });
  }

  // Orders that would LEAVE a location because their restaurant id isn't set on
  // any location yet. Correct (we never guess) but it lowers that location's
  // reported sales, so configure the ids first and re-run instead.
  const toUnassigned = changes.filter(c => c.new_location_id === null && c.old_location_id !== null);
  const unknownStoreIds = [...new Set(orders
    .filter(o => o.store_id && !byStore.has(String(o.store_id).trim()))
    .map(o => String(o.store_id).trim()))];

  const summary = {
    dryRun, scanned: orders.length, wouldChange: changes.length, noStoreId,
    toUnassigned: toUnassigned.length,
    toUnassignedSales: Math.round(toUnassigned.reduce((s, c) => s + (c.status === 'COMPLETE' ? c.amount : 0), 0) * 100) / 100,
    unknownStoreIds,
    moves: [...moves.values()].sort((a, b) => b.count - a.count),
    locations: locs.map(l => ({ id: l.id, name: l.name, storeId: l.pd_store_id || null }))
  };
  if (dryRun) return { ...summary, changes };

  const stamp = new Date().toISOString();
  const touchedDays = new Set();
  db.exec('BEGIN');
  try {
    const upd = db.prepare('UPDATE pd_orders SET location_id = ?, updated_at = datetime(\'now\') WHERE order_id = ?');
    const log = db.prepare(`INSERT INTO pd_order_location_fixes
      (order_id, old_location_id, old_location, new_location_id, new_location, order_date, amount, changed_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    for (const c of changes) {
      upd.run(c.new_location_id, c.order_id);
      log.run(c.order_id, c.old_location_id, c.old_location, c.new_location_id, c.new_location, c.date, c.amount, stamp);
      if (c.status === 'COMPLETE') {
        if (c.old_location_id !== null) touchedDays.add(`${c.old_location_id}|${c.date}`);
        if (c.new_location_id !== null) touchedDays.add(`${c.new_location_id}|${c.date}`);
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  // Re-derive the affected days on both sides so revenue follows the orders.
  // A day that was logged by hand is never overwritten — it's reported instead.
  const skippedDays = [];
  for (const k of touchedDays) {
    const [lid, date] = k.split('|');
    const r = rebuildDay(Number(lid), date);
    if (r.skipped) skippedDays.push({ location: nameOf(Number(lid)), date, reason: r.reason });
  }
  return { ...summary, applied: changes.length, daysRebuilt: touchedDays.size - skippedDays.length,
           skippedDays, changedAt: stamp };
}

module.exports = {
  looksLikePideDirecto, processWebhook, reconcileLocation, backfillRange,
  startReconciler, statusFor, ratesView, applyRealRates, rebuildDay,
  resolveLocation, unassignedOrders, claimStore, repairOrderLocations,
  backfillStoreIdsFromEvents, fetchMissingStoreIds
};
