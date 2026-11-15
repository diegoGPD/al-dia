// Inventario routes.
//   /p/...           the gerente capturing purchases — on their own phone
//                    (personal link + PIN) or on the registered tablet.
//                    Write-mostly: catalog names, their own captures of today,
//                    and nothing about prices or reports.
//   /inventario/...  owner: catalog hygiene, analytics, access links.
//   /costs/...       owner: composition charts for the costs page.
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireOwner, signToken, verifyToken, parseCookies } = require('../auth');
const { todayStr, addDays, badDate, daysBetween } = require('../lib/dates');
const inv = require('../inventario/core');
const comp = require('../inventario/composition');

const LINK_COOKIE = 'aldia_glink';
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const SESSION_HOURS = 16;

// Turns a thrown inv.fail() into its HTTP status; anything else is a real bug.
const h = fn => (req, res, next) => {
  try { const out = fn(req, res); if (out && out.catch) out.catch(next); }
  catch (e) {
    if (e.expose) return res.status(e.status || 400).json({ error: e.message, needsConfirm: e.needsConfirm || undefined });
    next(e);
  }
};

function linkFrom(req) {
  const token = parseCookies(req)[LINK_COOKIE];
  if (!token) return null;
  return db.prepare(
    `SELECT k.id, k.gerente_id, g.name, g.pin_hash FROM gerente_links k JOIN gerentes g ON g.id = k.gerente_id
      WHERE k.token_hash = ? AND k.active = 1 AND g.active = 1`).get(sha(token)) || null;
}
const locationsOf = gerenteId => db.prepare(
  `SELECT l.id, l.name FROM locations l JOIN gerente_locations gl ON gl.location_id = l.id
    WHERE gl.gerente_id = ? AND l.active = 1 ORDER BY l.name`).all(gerenteId);

// Who is capturing, and for which sucursales may they capture.
function requireCapturer(req, res, next) {
  const payload = verifyToken(req.get('X-Gerente'));
  const link = linkFrom(req);
  if (link) {
    if (!payload || payload.lid !== link.id || payload.gid !== link.gerente_id)
      return res.status(401).json({ error: 'Ingresa tu PIN.', code: 'pin' });
    req.gerente = { id: link.gerente_id, name: link.name };
    req.gLocations = locationsOf(link.gerente_id);
  } else {
    const { tabletFrom } = require('./gerente');
    const tablet = tabletFrom(req);
    if (!tablet) return res.status(401).json({ error: 'Este teléfono no tiene acceso. Pide tu enlace al administrador.', code: 'device' });
    const g = payload && payload.tid === tablet.id ? db.prepare(
      `SELECT g.id, g.name FROM gerentes g JOIN gerente_locations gl ON gl.gerente_id = g.id
        WHERE g.id = ? AND g.active = 1 AND gl.location_id = ?`).get(payload.gid, tablet.location_id) : null;
    if (!g) return res.status(401).json({ error: 'Ingresa tu PIN.', code: 'pin' });
    req.gerente = g;
    req.gLocations = [{ id: tablet.location_id, name: tablet.location_name }];
  }
  const asked = Number(req.query.location || (req.body && req.body.location_id)) || (req.gLocations.length === 1 ? req.gLocations[0].id : 0);
  if (asked && !req.gLocations.some(l => l.id === asked)) return res.status(403).json({ error: 'No tienes acceso a esa sucursal.' });
  req.locationId = asked || null;
  next();
}
const needLocation = (req, res, next) => req.locationId ? next() : res.status(400).json({ error: 'Elige la sucursal.' });

const pinFails = new Map();
function pinLocked(key) {
  const f = pinFails.get(key);
  return f && f.count >= 5 && Date.now() < f.until ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}

// A gerente's own purchases of today at a sucursal — the only ones they can see or edit.
const ownToday = (gerenteId, locationId) => db.prepare(
  'SELECT id FROM compras WHERE gerente_id = ? AND location_id = ? AND fecha = ? ORDER BY id DESC')
  .all(gerenteId, locationId, todayStr()).map(r => stripPrices(inv.compraFull(r.id)));
// They entered these totals themselves; nothing beyond that is sent back.
function stripPrices(c) {
  return { id: c.id, fecha: c.fecha, proveedor_id: c.proveedor_id, proveedor: c.proveedor, account_id: c.account_id,
    cuenta: c.cuenta, notas: c.notas, tiene_foto: c.tiene_foto, total: c.total,
    lineas: c.lineas.map(l => ({ insumo_id: l.insumo_id, insumo: l.insumo, unidad: l.unidad, presentacion_id: l.presentacion_id,
      presentacion_nombre: l.presentacion_nombre, factor: l.factor_snapshot, cantidad: l.cantidad, total: l.total_linea })) };
}

// ============================================================ phone routes ==
function publicRoutes(r) {
  // Opening the personal link once plants the device cookie on that phone.
  r.post('/p/activate', (req, res) => {
    const k = String(req.body.k || '');
    const link = k ? db.prepare(
      `SELECT k.id FROM gerente_links k JOIN gerentes g ON g.id = k.gerente_id
        WHERE k.token_hash = ? AND k.active = 1 AND g.active = 1`).get(sha(k)) : null;
    if (!link) return res.status(404).json({ error: 'Este enlace ya no es válido. Pide uno nuevo al administrador.' });
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.append('Set-Cookie', `${LINK_COOKIE}=${k}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${2 * 365 * 86400}${secure}`);
    res.json({ ok: true });
  });

  r.get('/p/boot', (req, res) => {
    const link = linkFrom(req);
    if (link) {
      db.prepare(`UPDATE gerente_links SET last_seen_at = datetime('now') WHERE id = ?`).run(link.id);
      return res.json({ mode: 'link', gerente: { id: link.gerente_id, name: link.name }, locations: locationsOf(link.gerente_id), today: todayStr() });
    }
    const { tabletFrom } = require('./gerente');
    const tablet = tabletFrom(req);
    if (tablet) return res.json({ mode: 'tablet', locations: [{ id: tablet.location_id, name: tablet.location_name }], today: todayStr() });
    res.json({ mode: null });
  });

  r.post('/p/pin', (req, res) => {
    const link = linkFrom(req);
    if (!link) return res.status(401).json({ error: 'Este teléfono no tiene acceso.', code: 'device' });
    const wait = pinLocked(link.id);
    if (wait) return res.status(429).json({ error: `Demasiados intentos. Espera ${wait} segundos.` });
    const pin = String(req.body.pin || '');
    if (!/^\d{4}$/.test(pin) || !bcrypt.compareSync(pin, link.pin_hash)) {
      const f = pinFails.get(link.id) || { count: 0, until: 0 };
      f.count = Date.now() > f.until && f.count >= 5 ? 1 : f.count + 1; f.until = Date.now() + 60e3;
      pinFails.set(link.id, f);
      return res.status(401).json({ error: 'PIN incorrecto.' });
    }
    pinFails.delete(link.id);
    res.json({ gerente: { id: link.gerente_id, name: link.name },
      token: signToken({ gid: link.gerente_id, lid: link.id, exp: Date.now() + SESSION_HOURS * 3600e3 }) });
  });

  const g = [requireCapturer, needLocation];

  r.get('/p/catalogo', g, (req, res) => {
    res.json({
      today: todayStr(),
      categorias: inv.CATEGORIAS, unidades: inv.UNIDADES,
      insumos: inv.catalog(req.locationId),
      proveedores: db.prepare('SELECT id, nombre FROM proveedores WHERE activo = 1 ORDER BY nombre').all(),
      cuentas: db.prepare('SELECT id, name nombre FROM accounts WHERE location_id = ? AND active = 1 ORDER BY position').all(req.locationId),
      mias: ownToday(req.gerente.id, req.locationId)
    });
  });

  r.post('/p/compras', g, h((req, res) => {
    const out = inv.saveCompra({ locationId: req.locationId, gerenteId: req.gerente.id, name: req.gerente.name }, req.body);
    res.json({ ok: true, duplicate: out.duplicate, compra: stripPrices(out.compra), mias: ownToday(req.gerente.id, req.locationId) });
  }));

  r.put('/p/compras/:id', g, h((req, res) => {
    const own = db.prepare('SELECT id FROM compras WHERE id = ? AND gerente_id = ? AND location_id = ? AND fecha = ?')
      .get(Number(req.params.id), req.gerente.id, req.locationId, todayStr());
    if (!own) return res.status(403).json({ error: 'Solo puedes editar tus compras de hoy.' });
    // Their own capture of today stays "of today": the date isn't theirs to move.
    inv.updateCompra(own.id, { gerenteId: req.gerente.id, name: req.gerente.name }, { ...req.body, fecha: todayStr() });
    res.json({ ok: true, mias: ownToday(req.gerente.id, req.locationId) });
  }));
}

// ============================================================ owner routes ==
function staffRoutes(r) {
  const I = '/inventario';
  const own = (req, id) => req.user.locationIds.includes(Number(id));
  // "location=all" (or none) means every sucursal the owner has.
  const locs = req => {
    const q = req.query.location;
    if (!q || q === 'all') return req.user.locationIds;
    return own(req, q) ? [Number(q)] : [];
  };
  const range = req => {
    const to = badDate(req.query.to) ? todayStr() : req.query.to;
    const from = badDate(req.query.from) ? addDays(to, -29) : req.query.from;
    return { from, to };
  };
  const filters = req => ({ locationIds: locs(req), ...range(req),
    categoria: inv.CATEGORIAS.includes(req.query.categoria) ? req.query.categoria : null,
    proveedorId: Number(req.query.proveedor) || null });

  // ---- catalog ------------------------------------------------------------
  r.get(`${I}/insumos`, requireOwner, (req, res) => res.json({
    categorias: inv.CATEGORIAS, unidades: inv.UNIDADES,
    insumos: inv.listInsumos({ pendientes: req.query.pendientes === '1', incluirInactivos: req.query.inactivos === '1' }),
    pendientes: db.prepare('SELECT COUNT(*) c FROM insumos WHERE revisado = 0 AND activo = 1 AND merged_into IS NULL').get().c
  }));
  r.post(`${I}/insumos`, requireOwner, h((req, res) => {
    res.json(inv.findOrCreateInsumo(req.body, { userId: req.user.id }));
  }));
  r.put(`${I}/insumos/:id`, requireOwner, h((req, res) => res.json(inv.updateInsumo(req.params.id, req.body))));
  r.post(`${I}/insumos/merge`, requireOwner, h((req, res) => res.json(inv.mergeInsumos(req.body.survivor_id, req.body.ids))));

  r.get(`${I}/proveedores`, requireOwner, (req, res) => res.json(db.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM compras c WHERE c.proveedor_id = p.id) compras FROM proveedores p ORDER BY p.activo DESC, p.nombre`).all()));
  r.post(`${I}/proveedores`, requireOwner, h((req, res) => {
    const p = inv.findOrCreateProveedor(req.body.nombre);
    if (!p) throw inv.fail('Falta el nombre');
    if (req.body.notas !== undefined) db.prepare('UPDATE proveedores SET notas = ? WHERE id = ?').run(String(req.body.notas).trim() || null, p.id);
    res.json({ ok: true, id: p.id });
  }));
  r.put(`${I}/proveedores/:id`, requireOwner, h((req, res) => {
    const p = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(Number(req.params.id));
    if (!p) throw inv.fail('No encontrado', 404);
    const { normalize } = require('../../public/compra/normalize');
    const nombre = req.body.nombre !== undefined ? String(req.body.nombre).trim() || p.nombre : p.nombre;
    db.prepare('UPDATE proveedores SET nombre = ?, nombre_normalizado = ?, notas = ?, activo = ? WHERE id = ?')
      .run(nombre, normalize(nombre) || nombre.toLowerCase(),
        req.body.notas !== undefined ? String(req.body.notas).trim() || null : p.notas,
        req.body.activo !== undefined ? (req.body.activo ? 1 : 0) : p.activo, p.id);
    res.json({ ok: true });
  }));

  // ---- settings: category mapping, alert thresholds -----------------------
  r.get(`${I}/ajustes`, requireOwner, (req, res) => {
    const loc = Number(req.query.location);
    if (!own(req, loc)) return res.status(403).json({ error: 'Sucursal inválida' });
    res.json({ config: inv.config(), mapa: inv.categoryMap(loc), categorias: inv.CATEGORIAS,
      costCategories: db.prepare('SELECT id, name FROM variable_cost_categories WHERE location_id = ? AND active = 1 ORDER BY position').all(loc) });
  });
  r.put(`${I}/ajustes`, requireOwner, h((req, res) => {
    const b = req.body;
    if (b.alerta_pct !== undefined || b.alerta_n !== undefined) {
      const cur = inv.config();
      const pct = b.alerta_pct !== undefined ? Number(b.alerta_pct) : cur.alerta_pct;
      const n = b.alerta_n !== undefined ? Math.round(Number(b.alerta_n)) : cur.alerta_n;
      if (!(pct > 0 && pct <= 500) || !(n >= 1 && n <= 50)) throw inv.fail('Valores de alerta inválidos');
      db.prepare('UPDATE inventario_config SET alerta_pct = ?, alerta_n = ? WHERE id = 1').run(pct, n);
    }
    if (b.categoria) {
      if (!own(req, b.location_id)) throw inv.fail('Sucursal inválida', 403);
      inv.setCategoryMap(Number(b.location_id), b.categoria, Number(b.cost_category_id) || null);
    }
    res.json({ ok: true });
  }));

  // ---- phone access links -------------------------------------------------
  const listLinks = () => db.prepare(
    `SELECT k.id, k.gerente_id, g.name gerente, k.created_at, k.last_seen_at FROM gerente_links k
       JOIN gerentes g ON g.id = k.gerente_id WHERE k.active = 1 ORDER BY g.name, k.id`).all();
  r.get(`${I}/links`, requireOwner, (req, res) => res.json(listLinks()));
  r.post(`${I}/links`, requireOwner, h((req, res) => {
    const g = db.prepare('SELECT id FROM gerentes WHERE id = ? AND active = 1').get(Number(req.body.gerente_id));
    if (!g) throw inv.fail('Gerente no encontrado', 404);
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO gerente_links (gerente_id, token_hash) VALUES (?,?)').run(g.id, sha(token));
    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    // Shown once: only the hash is stored, so it can't be displayed again.
    res.json({ ok: true, url: `${base}/compra/?k=${token}`, links: listLinks() });
  }));
  r.delete(`${I}/links/:id`, requireOwner, (req, res) => {
    db.prepare('UPDATE gerente_links SET active = 0 WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true, links: listLinks() });
  });

  // ---- analytics ----------------------------------------------------------
  r.get(`${I}/resumen`, requireOwner, (req, res) => {
    const f = filters(req);
    res.json({ filtros: { from: f.from, to: f.to }, ...inv.gastoPorInsumo(f), ...inv.alertas(f) });
  });
  r.get(`${I}/precio`, requireOwner, h((req, res) => {
    const insumo = inv.resolveInsumo(req.query.insumo);
    if (!insumo) throw inv.fail('Insumo no encontrado', 404);
    const f = { ...filters(req), categoria: null, insumoId: insumo.id };
    res.json({ insumo: { id: insumo.id, nombre: insumo.nombre, unidad_base: insumo.unidad_base, categoria: insumo.categoria },
      serie: inv.precioSerie(f), proveedores: inv.proveedoresCompare({ ...f, proveedorId: null }) });
  }));

  r.get(`${I}/compras`, requireOwner, (req, res) => {
    const f = filters(req);
    if (!f.locationIds.length) return res.json([]);
    res.json(db.prepare(
      `SELECT id FROM compras WHERE location_id IN (${f.locationIds.map(() => '?').join(',')}) AND fecha BETWEEN ? AND ?
        ORDER BY fecha DESC, id DESC LIMIT 300`).all(...f.locationIds, f.from, f.to).map(x => inv.compraFull(x.id)));
  });
  r.get(`${I}/compras/:id`, requireOwner, h((req, res) => {
    const c = inv.compraFull(req.params.id);
    if (!c || !own(req, c.location_id)) throw inv.fail('No encontrada', 404);
    res.json(c);
  }));
  // Voids a mistaken capture: the purchase, its lines and their cost rows go together.
  r.delete(`${I}/compras/:id`, requireOwner, h((req, res) => {
    const c = db.prepare('SELECT id, location_id FROM compras WHERE id = ?').get(Number(req.params.id));
    if (!c || !own(req, c.location_id)) throw inv.fail('No encontrada', 404);
    inv.deleteCompra(c.id);
    res.json({ ok: true });
  }));

  // ---- cost charts --------------------------------------------------------
  r.get('/costs/composition', requireOwner, h((req, res) => {
    const loc = Number(req.query.location);
    if (!own(req, loc)) throw inv.fail('Sucursal inválida', 403);
    let { from, to } = range(req);
    // "last N days" is anchored on the server's today (America/Monterrey), the
    // same today the rest of the app uses — not on the device's clock.
    const n = Number(req.query.days);
    if (n >= 1) { to = todayStr(); from = addDays(to, -(Math.round(n) - 1)); }
    if (from > to) throw inv.fail('Rango inválido');
    if (daysBetween(from, to) > 92) throw inv.fail('El rango máximo para las gráficas es de 93 días.');
    res.json(comp.composition(loc, from, to));
  }));
  r.get('/costs/day-lines', requireOwner, h((req, res) => {
    const loc = Number(req.query.location);
    if (!own(req, loc) || badDate(req.query.date)) throw inv.fail('Parámetros inválidos');
    res.json(comp.dayLines(loc, req.query.date));
  }));
}

module.exports = { publicRoutes, staffRoutes };
