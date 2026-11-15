// Vista de Gerente. Two audiences:
//   /g/...              the shared tablet. Authenticated by the tablet's device
//                       cookie plus the PIN session of whoever is using it.
//                       It can scan cards, log its own expenses and run
//                       checklists — and nothing else. No financial data.
//   /gerente-admin/...  the owner: people, tablets, templates, history.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { db, DATA_DIR } = require('../db');
const { requireOwner, signToken, verifyToken, parseCookies } = require('../auth');
const { num } = require('../lib/parse');
const { todayStr, addDays, badDate } = require('../lib/dates');
const loyalty = require('../loyalty/state');
const cl = require('../gerente/checklists');

const TABLET_COOKIE = 'aldia_tablet';
const RECEIPT_DIR = path.join(DATA_DIR, 'receipts');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const PIN_RE = /^\d{4}$/;
const SESSION_HOURS = 16;          // a PIN session outlives one shift, not two

// ------------------------------------------------------------- tablet auth --
function tabletFrom(req) {
  const token = parseCookies(req)[TABLET_COOKIE];
  if (!token) return null;
  return db.prepare(
    `SELECT t.id, t.name, t.location_id, l.name location_name
       FROM tablets t JOIN locations l ON l.id = t.location_id
      WHERE t.token_hash = ? AND t.active = 1 AND l.active = 1`).get(sha(token)) || null;
}

function requireTablet(req, res, next) {
  const tablet = tabletFrom(req);
  if (!tablet) return res.status(401).json({ error: 'Esta tablet no está registrada.', code: 'tablet' });
  req.tablet = tablet;
  next();
}

// The gerente's token is issued on PIN entry and bound to this tablet.
function requireGerente(req, res, next) {
  const payload = verifyToken(req.get('X-Gerente'));
  if (!payload || payload.tid !== req.tablet.id)
    return res.status(401).json({ error: 'Ingresa tu PIN.', code: 'pin' });
  const g = db.prepare(
    `SELECT g.id, g.name FROM gerentes g JOIN gerente_locations gl ON gl.gerente_id = g.id
      WHERE g.id = ? AND g.active = 1 AND gl.location_id = ?`).get(payload.gid, req.tablet.location_id);
  if (!g) return res.status(401).json({ error: 'Ingresa tu PIN.', code: 'pin' });
  req.gerente = g;
  next();
}

// 5 wrong PINs on a tablet → wait a minute. In memory is enough: it resets on
// deploy, and the point is only to stop someone walking through 0000–9999.
const pinFails = new Map();
function pinLocked(tabletId) {
  const f = pinFails.get(tabletId);
  return f && f.count >= 5 && Date.now() < f.until ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}

function findByPin(locationId, pin, exceptId = null) {
  const rows = db.prepare(
    `SELECT g.id, g.name, g.pin_hash FROM gerentes g JOIN gerente_locations gl ON gl.gerente_id = g.id
      WHERE g.active = 1 AND gl.location_id = ?`).all(locationId);
  return rows.find(g => g.id !== exceptId && bcrypt.compareSync(pin, g.pin_hash)) || null;
}

function saveReceipt(costId, b64) {
  if (!b64 || typeof b64 !== 'string' || b64.length > 8.5e6) return;
  try {
    fs.mkdirSync(RECEIPT_DIR, { recursive: true });
    const file = `${costId}.jpg`;
    fs.writeFileSync(path.join(RECEIPT_DIR, file), Buffer.from(b64, 'base64'));
    db.prepare('UPDATE oneoff_costs SET receipt = ? WHERE id = ?').run(file, costId);
  } catch (e) { console.error('receipt save:', e.message); }
}

const digits = s => String(s || '').replace(/\D/g, '');
const maskPhone = p => { const d = digits(p); return d.length >= 4 ? `••• ${d.slice(-4)}` : ''; };

function customerView(customer) {
  const state = loyalty.stateOf(customer);
  const stampedToday = db.prepare(
    `SELECT COUNT(*) c FROM loyalty_visits WHERE customer_id = ? AND date(visited_at) = date('now')`)
    .get(customer.id).c > 0;
  return { code: customer.code, name: customer.name, state, stampedToday };
}

// =========================================================== tablet routes ==
function publicRoutes(r) {
  // What is this device? Never 401s — the page needs an answer to draw itself.
  r.get('/g/boot', (req, res) => {
    const tablet = tabletFrom(req);
    if (!tablet) return res.json({ registered: false });
    db.prepare(`UPDATE tablets SET last_seen_at = datetime('now') WHERE id = ?`).run(tablet.id);
    res.json({ registered: true, tablet: { id: tablet.id, name: tablet.name },
      location: { id: tablet.location_id, name: tablet.location_name },
      business_date: cl.businessDate(), now: new Date().toISOString() });
  });

  r.post('/g/pin', requireTablet, (req, res) => {
    const wait = pinLocked(req.tablet.id);
    if (wait) return res.status(429).json({ error: `Demasiados intentos. Espera ${wait} segundos.` });
    const pin = String(req.body.pin || '');
    const g = PIN_RE.test(pin) ? findByPin(req.tablet.location_id, pin) : null;
    if (!g) {
      const f = pinFails.get(req.tablet.id) || { count: 0, until: 0 };
      f.count = Date.now() > f.until && f.count >= 5 ? 1 : f.count + 1;
      f.until = Date.now() + 60e3;
      pinFails.set(req.tablet.id, f);
      return res.status(401).json({ error: 'PIN incorrecto.' });
    }
    pinFails.delete(req.tablet.id);
    res.json({
      gerente: { id: g.id, name: g.name },
      token: signToken({ gid: g.id, tid: req.tablet.id, exp: Date.now() + SESSION_HOURS * 3600e3 })
    });
  });

  const g = [requireTablet, requireGerente];

  // ---- 1. loyalty ---------------------------------------------------------
  r.post('/g/loyalty/lookup', g, (req, res) => {
    if (req.body.code) {
      const c = loyalty.customerByCode(String(req.body.code).trim().toUpperCase());
      if (!c) return res.status(404).json({ error: 'Tarjeta no reconocida.' });
      return res.json({ customer: customerView(c) });
    }
    const d = digits(req.body.phone);
    if (d.length < 7) return res.status(400).json({ error: 'Escribe al menos 7 dígitos del teléfono.' });
    const tail = d.slice(-10);
    // Phones were typed by customers in every format, so compare digits only.
    const matches = db.prepare('SELECT * FROM customers WHERE phone IS NOT NULL').all()
      .filter(c => { const p = digits(c.phone); return p && (p.endsWith(tail) || tail.endsWith(p.slice(-10))); })
      .slice(0, 6);
    if (!matches.length) return res.status(404).json({ error: 'No hay ninguna tarjeta con ese teléfono.' });
    if (matches.length === 1) return res.json({ customer: customerView(matches[0]) });
    res.json({ matches: matches.map(c => ({ code: c.code, name: c.name, phone: maskPhone(c.phone) })) });
  });

  r.post('/g/loyalty/visit', g, (req, res) => {
    const { notifyCard, visitMessage } = require('./loyalty');
    const c = loyalty.customerByCode(String(req.body.code || '').trim().toUpperCase());
    if (!c) return res.status(404).json({ error: 'Tarjeta no reconocida.' });
    // No override here: one stamp per day is the rule on the tablet.
    const result = loyalty.addVisit(c, req.tablet.location_id, { gerenteId: req.gerente.id });
    if (result.ok) notifyCard(c, result.state, visitMessage(result));
    const fresh = db.prepare('SELECT * FROM customers WHERE id = ?').get(c.id);
    res.json({ ok: result.ok, reason: result.reason || null,
      justEarned: (result.justEarned || []).map(x => x.name), customer: customerView(fresh) });
  });

  r.post('/g/loyalty/redeem', g, (req, res) => {
    const { notifyCard } = require('./loyalty');
    const c = loyalty.customerByCode(String(req.body.code || '').trim().toUpperCase());
    if (!c) return res.status(404).json({ error: 'Tarjeta no reconocida.' });
    const result = loyalty.redeem(c, req.tablet.location_id, req.body.reward_id || null, req.gerente.id);
    if (!result.ok) return res.status(409).json({ error: 'Esta tarjeta no tiene recompensa por canjear.' });
    notifyCard(c, result.state, `canjeaste tu ${result.redeemed.name} — ¡gracias por venir!`);
    const fresh = db.prepare('SELECT * FROM customers WHERE id = ?').get(c.id);
    res.json({ ok: true, redeemed: result.redeemed.name, customer: customerView(fresh) });
  });

  // ---- 2. expenses --------------------------------------------------------
  // Same oneoff_costs rows the rest of the app uses, so they land in the
  // profitability numbers with no extra work. The tablet only ever sees the
  // rows this gerente created today.
  const ownToday = (req) => db.prepare(
    `SELECT o.id, o.amount, o.description, o.category_id, o.account_id, o.receipt IS NOT NULL has_receipt,
            c.name category_name, a.name account_name
       FROM oneoff_costs o
       LEFT JOIN variable_cost_categories c ON c.id = o.category_id
       LEFT JOIN accounts a ON a.id = o.account_id
      WHERE o.location_id = ? AND o.gerente_id = ? AND o.date = ?
        AND NOT EXISTS (SELECT 1 FROM compra_lineas cl WHERE cl.oneoff_cost_id = o.id)   -- purchases are edited as purchases
      ORDER BY o.id DESC`)
    .all(req.tablet.location_id, req.gerente.id, todayStr());

  r.get('/g/expenses', g, (req, res) => {
    const loc = req.tablet.location_id;
    res.json({
      today: todayStr(),
      categories: db.prepare(
        'SELECT id, name FROM variable_cost_categories WHERE location_id = ? AND active = 1 ORDER BY position').all(loc),
      accounts: db.prepare(
        'SELECT id, name FROM accounts WHERE location_id = ? AND active = 1 ORDER BY position').all(loc),
      mine: ownToday(req)
    });
  });

  function expenseFields(req) {
    const loc = req.tablet.location_id;
    const amount = num(req.body.amount);
    if (!(amount > 0)) return { error: 'Escribe el monto.' };
    const cat = req.body.category_id ? db.prepare(
      'SELECT id, name, default_invoiced FROM variable_cost_categories WHERE id = ? AND location_id = ? AND active = 1')
      .get(Number(req.body.category_id), loc) : null;
    if (req.body.category_id && !cat) return { error: 'Categoría inválida.' };
    const acc = req.body.account_id ? db.prepare(
      'SELECT id FROM accounts WHERE id = ? AND location_id = ? AND active = 1')
      .get(Number(req.body.account_id), loc) : null;
    if (req.body.account_id && !acc) return { error: 'Cuenta inválida.' };
    const note = String(req.body.note || '').trim().slice(0, 200);
    return { amount, cat, acc, description: note || (cat ? cat.name : 'Otro gasto') };
  }

  r.post('/g/expenses', g, (req, res) => {
    const f = expenseFields(req);
    if (f.error) return res.status(400).json({ error: f.error });
    const id = Number(db.prepare(
      `INSERT INTO oneoff_costs (location_id, date, description, amount, invoiced, account_id, category_id,
         logged_by, gerente_id, tablet_id) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(req.tablet.location_id, todayStr(), f.description, f.amount,
        f.cat && f.cat.default_invoiced ? 1 : 0, f.acc ? f.acc.id : null, f.cat ? f.cat.id : null,
        req.gerente.name, req.gerente.id, req.tablet.id).lastInsertRowid);
    saveReceipt(id, req.body.receipt_base64);
    res.json({ ok: true, id, mine: ownToday(req) });
  });

  r.put('/g/expenses/:id', g, (req, res) => {
    const own = db.prepare(
      `SELECT id FROM oneoff_costs o WHERE id = ? AND location_id = ? AND gerente_id = ? AND date = ?
         AND NOT EXISTS (SELECT 1 FROM compra_lineas cl WHERE cl.oneoff_cost_id = o.id)`)
      .get(Number(req.params.id), req.tablet.location_id, req.gerente.id, todayStr());
    if (!own) return res.status(403).json({ error: 'Solo puedes editar tus gastos de hoy.' });
    const f = expenseFields(req);
    if (f.error) return res.status(400).json({ error: f.error });
    db.prepare('UPDATE oneoff_costs SET amount = ?, description = ?, category_id = ?, account_id = ? WHERE id = ?')
      .run(f.amount, f.description, f.cat ? f.cat.id : null, f.acc ? f.acc.id : null, own.id);
    saveReceipt(own.id, req.body.receipt_base64);
    res.json({ ok: true, mine: ownToday(req) });
  });

  // ---- 3. apertura / cierre ----------------------------------------------
  const ownRun = (req, id) => {
    const run = db.prepare('SELECT id, location_id, business_date FROM checklist_runs WHERE id = ?').get(Number(id));
    return run && run.location_id === req.tablet.location_id ? run : null;
  };

  r.get('/g/checklist/today', g, (req, res) => res.json(cl.todayStatus(req.tablet.location_id)));

  r.post('/g/checklist/start', g, (req, res) => {
    const out = cl.startOrResume(req.tablet.location_id, req.body.type, req.gerente.id);
    if (out.error) return res.status(out.notConfigured ? 409 : 400).json({ error: out.error });
    res.json(out);
  });

  r.post('/g/checklist/sync', g, (req, res) => {
    if (!ownRun(req, req.body.run_id)) return res.status(404).json({ error: 'Checklist no encontrado' });
    const out = cl.applyOps(Number(req.body.run_id), req.body.ops, req.gerente.id, req.body.comments);
    if (out.error) return res.status(400).json({ error: out.error });
    res.json({ ok: true, run: cl.runFull(Number(req.body.run_id)) });
  });

  r.post('/g/checklist/finish', g, (req, res) => {
    if (!ownRun(req, req.body.run_id)) return res.status(404).json({ error: 'Checklist no encontrado' });
    const id = Number(req.body.run_id);
    cl.applyOps(id, req.body.ops, req.gerente.id);
    const out = cl.finish(id, req.gerente.id, req.body.comments);
    if (out.error) return res.status(409).json({ error: out.error, run: cl.runFull(id) });
    res.json({ ok: true, run: cl.runFull(id) });
  });

  // Gerentes can look back one week, read-only.
  r.get('/g/checklist/history', g, (req, res) => {
    res.json(cl.history({ locationIds: [req.tablet.location_id], from: addDays(cl.businessDate(), -7) }));
  });

  r.get('/g/checklist/run/:id', g, (req, res) => {
    const run = ownRun(req, req.params.id);
    if (!run || run.business_date < addDays(cl.businessDate(), -7))
      return res.status(404).json({ error: 'Checklist no encontrado' });
    res.json(cl.runFull(run.id));
  });
}

// ============================================================ owner routes ==
function staffRoutes(r) {
  const own = (req, locationId) => req.user.locationIds.includes(Number(locationId));
  const A = '/gerente-admin';

  // ---- gerentes -----------------------------------------------------------
  const listGerentes = () => db.prepare('SELECT id, name, active, created_at FROM gerentes ORDER BY active DESC, name').all()
    .map(g => ({ ...g, location_ids: db.prepare(
      'SELECT location_id FROM gerente_locations WHERE gerente_id = ?').all(g.id).map(x => x.location_id) }));

  r.get(`${A}/gerentes`, requireOwner, (req, res) => res.json(listGerentes()));

  // A PIN identifies a person on the tablet, so two people sharing a location
  // can never have the same one.
  function pinClash(pin, locationIds, exceptId) {
    for (const loc of locationIds) {
      const hit = findByPin(loc, pin, exceptId);
      if (hit) return hit;
    }
    return null;
  }

  function setLocations(gerenteId, ids) {
    db.prepare('DELETE FROM gerente_locations WHERE gerente_id = ?').run(gerenteId);
    const ins = db.prepare('INSERT OR IGNORE INTO gerente_locations (gerente_id, location_id) VALUES (?,?)');
    ids.forEach(id => ins.run(gerenteId, id));
  }

  r.post(`${A}/gerentes`, requireOwner, (req, res) => {
    const name = String(req.body.name || '').trim();
    const pin = String(req.body.pin || '');
    const locs = (req.body.location_ids || []).map(Number).filter(id => own(req, id));
    if (!name) return res.status(400).json({ error: 'Falta el nombre.' });
    if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos.' });
    if (!locs.length) return res.status(400).json({ error: 'Elige al menos una sucursal.' });
    if (pinClash(pin, locs, null)) return res.status(409).json({ error: 'Ese PIN ya lo usa otro gerente de esa sucursal. Elige otro.' });
    const id = Number(db.prepare('INSERT INTO gerentes (name, pin_hash) VALUES (?,?)')
      .run(name, bcrypt.hashSync(pin, 8)).lastInsertRowid);
    setLocations(id, locs);
    res.json({ ok: true, gerentes: listGerentes() });
  });

  r.put(`${A}/gerentes/:id`, requireOwner, (req, res) => {
    const gte = db.prepare('SELECT * FROM gerentes WHERE id = ?').get(Number(req.params.id));
    if (!gte) return res.status(404).json({ error: 'No encontrado' });
    const b = req.body;
    const locs = Array.isArray(b.location_ids)
      ? b.location_ids.map(Number).filter(id => own(req, id))
      : db.prepare('SELECT location_id FROM gerente_locations WHERE gerente_id = ?').all(gte.id).map(x => x.location_id);
    if (!locs.length) return res.status(400).json({ error: 'Elige al menos una sucursal.' });
    let hash = gte.pin_hash;
    if (b.pin !== undefined && b.pin !== '') {
      if (!PIN_RE.test(String(b.pin))) return res.status(400).json({ error: 'El PIN debe ser de 4 dígitos.' });
      if (pinClash(String(b.pin), locs, gte.id)) return res.status(409).json({ error: 'Ese PIN ya lo usa otro gerente de esa sucursal. Elige otro.' });
      hash = bcrypt.hashSync(String(b.pin), 8);
    }
    db.prepare('UPDATE gerentes SET name = ?, pin_hash = ?, active = ? WHERE id = ?')
      .run(b.name !== undefined ? String(b.name).trim() || gte.name : gte.name, hash,
        b.active !== undefined ? (b.active ? 1 : 0) : gte.active, gte.id);
    setLocations(gte.id, locs);
    res.json({ ok: true, gerentes: listGerentes() });
  });

  // ---- tablets ------------------------------------------------------------
  const listTablets = req => db.prepare(
    `SELECT t.id, t.name, t.location_id, l.name location_name, t.created_at, t.last_seen_at
       FROM tablets t JOIN locations l ON l.id = t.location_id WHERE t.active = 1 ORDER BY t.id`).all()
    .filter(t => own(req, t.location_id));

  r.get(`${A}/tablets`, requireOwner, (req, res) => res.json(listTablets(req)));

  // Run ON the tablet by the owner: it plants the device cookie in that browser.
  r.post(`${A}/tablets/register`, requireOwner, (req, res) => {
    const loc = Number(req.body.location_id);
    if (!own(req, loc)) return res.status(403).json({ error: 'Sucursal inválida.' });
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO tablets (location_id, name, token_hash) VALUES (?,?,?)')
      .run(loc, String(req.body.name || '').trim() || 'Tablet', sha(token));
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.append('Set-Cookie',
      `${TABLET_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${5 * 365 * 86400}${secure}`);
    res.json({ ok: true });
  });

  r.delete(`${A}/tablets/:id`, requireOwner, (req, res) => {
    const t = db.prepare('SELECT * FROM tablets WHERE id = ?').get(Number(req.params.id));
    if (!t || !own(req, t.location_id)) return res.status(404).json({ error: 'No encontrada' });
    db.prepare('UPDATE tablets SET active = 0 WHERE id = ?').run(t.id);
    res.json({ ok: true, tablets: listTablets(req) });
  });

  // ---- templates ----------------------------------------------------------
  // Editing only ever touches the template. Runs carry their own copy of the
  // items, taken when they started, so history is unaffected by anything here.
  const tplOf = (req, templateId) => {
    const t = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(Number(templateId));
    return t && own(req, t.location_id) ? t : null;
  };
  const secOf = (req, sectionId) => {
    const s = db.prepare('SELECT * FROM checklist_sections WHERE id = ?').get(Number(sectionId));
    return s && tplOf(req, s.template_id) ? s : null;
  };
  const sendTpl = (req, res, tpl) => res.json(cl.templateFull(tpl.location_id, tpl.type, { includeInactive: true }));

  r.get(`${A}/template`, requireOwner, (req, res) => {
    const loc = Number(req.query.location);
    if (!own(req, loc) || !cl.TYPES.includes(req.query.type)) return res.status(400).json({ error: 'Parámetros inválidos' });
    res.json(cl.templateFull(loc, req.query.type, { includeInactive: true }));
  });

  r.put(`${A}/template/:id`, requireOwner, (req, res) => {
    const t = tplOf(req, req.params.id);
    if (!t) return res.status(404).json({ error: 'No encontrado' });
    const v = (k) => req.body[k] !== undefined ? (String(req.body[k]).trim() || null) : t[k];
    db.prepare('UPDATE checklist_templates SET header_note = ?, comments_placeholder = ?, footer_note = ? WHERE id = ?')
      .run(v('header_note'), v('comments_placeholder'), v('footer_note'), t.id);
    sendTpl(req, res, t);
  });

  r.post(`${A}/sections`, requireOwner, (req, res) => {
    const t = tplOf(req, req.body.template_id);
    const title = String(req.body.title || '').trim();
    if (!t || !title) return res.status(400).json({ error: 'Falta el título de la sección.' });
    const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 p FROM checklist_sections WHERE template_id = ?').get(t.id).p;
    db.prepare('INSERT INTO checklist_sections (template_id, title, warning_note, position) VALUES (?,?,?,?)')
      .run(t.id, title, String(req.body.warning_note || '').trim() || null, pos);
    sendTpl(req, res, t);
  });

  r.put(`${A}/sections/:id`, requireOwner, (req, res) => {
    const s = secOf(req, req.params.id);
    if (!s) return res.status(404).json({ error: 'No encontrada' });
    const b = req.body;
    db.prepare('UPDATE checklist_sections SET title = ?, warning_note = ?, active = ? WHERE id = ?')
      .run(b.title !== undefined ? String(b.title).trim() || s.title : s.title,
        b.warning_note !== undefined ? String(b.warning_note).trim() || null : s.warning_note,
        b.active !== undefined ? (b.active ? 1 : 0) : s.active, s.id);
    sendTpl(req, res, tplOf(req, s.template_id));
  });

  r.post(`${A}/items`, requireOwner, (req, res) => {
    const s = secOf(req, req.body.section_id);
    const text = String(req.body.text || '').trim();
    if (!s || !text) return res.status(400).json({ error: 'Falta el texto de la actividad.' });
    const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 p FROM checklist_items WHERE section_id = ?').get(s.id).p;
    db.prepare('INSERT INTO checklist_items (section_id, text, warning, position) VALUES (?,?,?,?)')
      .run(s.id, text, req.body.warning ? 1 : 0, pos);
    sendTpl(req, res, tplOf(req, s.template_id));
  });

  r.put(`${A}/items/:id`, requireOwner, (req, res) => {
    const it = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(Number(req.params.id));
    const s = it && secOf(req, it.section_id);
    if (!s) return res.status(404).json({ error: 'No encontrada' });
    const b = req.body;
    db.prepare('UPDATE checklist_items SET text = ?, warning = ?, active = ? WHERE id = ?')
      .run(b.text !== undefined ? String(b.text).trim() || it.text : it.text,
        b.warning !== undefined ? (b.warning ? 1 : 0) : it.warning,
        b.active !== undefined ? (b.active ? 1 : 0) : it.active, it.id);
    sendTpl(req, res, tplOf(req, s.template_id));
  });

  // New order = the list of ids as the admin arranged them.
  r.post(`${A}/reorder`, requireOwner, (req, res) => {
    const ids = (req.body.ids || []).map(Number);
    let tpl = null;
    if (req.body.kind === 'sections') {
      const upd = db.prepare('UPDATE checklist_sections SET position = ? WHERE id = ?');
      ids.forEach((id, i) => { const s = secOf(req, id); if (s) { upd.run(i, id); tpl = tplOf(req, s.template_id); } });
    } else {
      const upd = db.prepare('UPDATE checklist_items SET position = ? WHERE id = ?');
      ids.forEach((id, i) => {
        const it = db.prepare('SELECT section_id FROM checklist_items WHERE id = ?').get(id);
        const s = it && secOf(req, it.section_id);
        if (s) { upd.run(i, id); tpl = tplOf(req, s.template_id); }
      });
    }
    if (!tpl) return res.status(400).json({ error: 'Nada que reordenar' });
    sendTpl(req, res, tpl);
  });

  // ---- history ------------------------------------------------------------
  r.get(`${A}/history`, requireOwner, (req, res) => {
    const q = req.query;
    const locs = q.location ? [Number(q.location)].filter(id => own(req, id)) : req.user.locationIds;
    res.json(cl.history({ locationIds: locs,
      from: badDate(q.from) ? null : q.from, to: badDate(q.to) ? null : q.to,
      type: q.type, gerenteId: q.gerente ? Number(q.gerente) : null }));
  });

  r.get(`${A}/run/:id`, requireOwner, (req, res) => {
    const run = cl.runFull(Number(req.params.id));
    if (!run || !own(req, run.location_id)) return res.status(404).json({ error: 'No encontrado' });
    res.json(run);
  });

  r.get(`${A}/missing`, requireOwner, (req, res) => {
    const loc = Number(req.query.location);
    if (!own(req, loc)) return res.status(403).json({ error: 'Sucursal inválida.' });
    res.json(cl.missing(loc));
  });
}

module.exports = { publicRoutes, staffRoutes, tabletFrom };
