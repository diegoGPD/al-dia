// Inventario: insumo catalog, purchases, catalog hygiene and price analytics.
//
// Money rule: every purchase line owns exactly one oneoff_costs row, written
// in the same transaction. Profit, benchmarks and accounts read oneoff_costs
// as they always have; nothing here is a second ledger.
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('../db');
const { addDays, daysBetween, badDate, todayStr } = require('../lib/dates');
const { normalize } = require('../../public/compra/normalize');

const CATEGORIAS = ['Proteína', 'Abarrotes', 'Lácteos', 'Desechables', 'Bebidas', 'Otros'];
const UNIDADES = ['kg', 'litro', 'pieza'];
const RECEIPT_DIR = path.join(DATA_DIR, 'receipts');
const round2 = n => Math.round(n * 100) / 100;
const round4 = n => Math.round(n * 10000) / 10000;
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status, expose: true });

function tx(fn) {
  db.exec('BEGIN');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ------------------------------------------------------- category mapping --
// Default: food-type insumos post into the sucursal's food category,
// desechables into packaging, Otros stays uncategorised.
const DEFAULT_TAG = { 'Proteína': 'food', 'Abarrotes': 'food', 'Lácteos': 'food', 'Bebidas': 'food', 'Desechables': 'packaging', 'Otros': null };
function categoryMap(locationId) {
  const have = Object.fromEntries(db.prepare(
    'SELECT categoria, cost_category_id FROM insumo_categoria_map WHERE location_id = ?').all(locationId)
    .map(r => [r.categoria, r.cost_category_id]));
  for (const cat of CATEGORIAS) {
    if (cat in have) continue;
    const tag = DEFAULT_TAG[cat];
    const row = tag ? db.prepare(
      `SELECT id FROM variable_cost_categories WHERE location_id = ? AND active = 1 AND benchmark_tag = ?
        ORDER BY position, id LIMIT 1`).get(locationId, tag) : null;
    have[cat] = row ? row.id : null;
    db.prepare('INSERT OR IGNORE INTO insumo_categoria_map (location_id, categoria, cost_category_id) VALUES (?,?,?)')
      .run(locationId, cat, have[cat]);
  }
  return have;
}
function setCategoryMap(locationId, categoria, costCategoryId) {
  if (!CATEGORIAS.includes(categoria)) throw fail('Categoría inválida');
  if (costCategoryId && !db.prepare(
    'SELECT 1 x FROM variable_cost_categories WHERE id = ? AND location_id = ?').get(costCategoryId, locationId))
    throw fail('Esa categoría de costo no es de esta sucursal');
  categoryMap(locationId);
  db.prepare('UPDATE insumo_categoria_map SET cost_category_id = ? WHERE location_id = ? AND categoria = ?')
    .run(costCategoryId || null, locationId, categoria);
}

// ---------------------------------------------------------------- catalog --
// A merged insumo points at its survivor; follow the chain so an id captured
// offline before the merge still lands on the right product.
function resolveInsumo(id) {
  let row = db.prepare('SELECT * FROM insumos WHERE id = ?').get(Number(id));
  for (let i = 0; row && row.merged_into && i < 10; i++) {
    row = db.prepare('SELECT * FROM insumos WHERE id = ?').get(row.merged_into);
  }
  return row || null;
}

// reviewed: owners' insumos are trusted; a gerente's (or a manager's via the quick link) wait in Pendientes.
function findOrCreateInsumo({ nombre, categoria, unidad_base }, { gerenteId = null, userId = null, reviewed = !!userId } = {}) {
  const name = String(nombre || '').trim().replace(/\s+/g, ' ');
  const norm = normalize(name);
  if (!name || !norm) throw fail('Falta el nombre del insumo');
  // Same product typed slightly differently is the same product.
  const existing = db.prepare(
    'SELECT * FROM insumos WHERE nombre_normalizado = ? AND activo = 1 AND merged_into IS NULL ORDER BY id LIMIT 1').get(norm);
  if (existing) return { insumo: existing, created: false };
  if (!CATEGORIAS.includes(categoria)) throw fail('Elige la categoría del insumo');
  if (!UNIDADES.includes(unidad_base)) throw fail('Elige la unidad base del insumo');
  const id = Number(db.prepare(
    `INSERT INTO insumos (nombre, nombre_normalizado, categoria, unidad_base, revisado, creado_por_gerente, creado_por_usuario)
     VALUES (?,?,?,?,?,?,?)`).run(name, norm, categoria, unidad_base, reviewed ? 1 : 0, gerenteId, userId).lastInsertRowid);
  return { insumo: db.prepare('SELECT * FROM insumos WHERE id = ?').get(id), created: true };
}

function findOrCreatePresentacion(insumoId, { nombre, factor }) {
  const name = String(nombre || '').trim().replace(/\s+/g, ' ');
  const f = Number(factor);
  if (!name) throw fail('Falta el nombre de la presentación');
  if (!(f > 0)) throw fail('¿Cuántas unidades base trae la presentación?');
  const norm = normalize(name) || name.toLowerCase();
  const hit = db.prepare(
    'SELECT * FROM insumo_presentaciones WHERE insumo_id = ? AND nombre_normalizado = ? AND ABS(factor - ?) < 1e-9')
    .get(insumoId, norm, f);
  if (hit) return hit;
  const id = Number(db.prepare(
    'INSERT INTO insumo_presentaciones (insumo_id, nombre, nombre_normalizado, factor) VALUES (?,?,?,?)')
    .run(insumoId, name, norm, f).lastInsertRowid);
  return db.prepare('SELECT * FROM insumo_presentaciones WHERE id = ?').get(id);
}

function findOrCreateProveedor(nombre) {
  const name = String(nombre || '').trim().replace(/\s+/g, ' ');
  if (!name) return null;
  const norm = normalize(name) || name.toLowerCase();
  const hit = db.prepare('SELECT * FROM proveedores WHERE nombre_normalizado = ? ORDER BY activo DESC, id LIMIT 1').get(norm);
  if (hit) return hit;
  const id = Number(db.prepare('INSERT INTO proveedores (nombre, nombre_normalizado) VALUES (?,?)').run(name, norm).lastInsertRowid);
  return db.prepare('SELECT * FROM proveedores WHERE id = ?').get(id);
}

// What the phone needs to capture: products, their presentaciones, and how
// often THIS sucursal buys each one. No prices — gerentes don't get price data.
function catalog(locationId) {
  const since = addDays(todayStr(), -90);
  const uso = Object.fromEntries(db.prepare(
    `SELECT l.insumo_id id, COUNT(*) n, MAX(c.fecha) ultimo FROM compra_lineas l
       JOIN compras c ON c.id = l.compra_id
      WHERE c.location_id = ? AND c.fecha >= ? GROUP BY l.insumo_id`).all(locationId, since).map(r => [r.id, r]));
  const pres = {};
  for (const p of db.prepare('SELECT id, insumo_id, nombre, factor FROM insumo_presentaciones ORDER BY id').all()) {
    (pres[p.insumo_id] = pres[p.insumo_id] || []).push({ id: p.id, nombre: p.nombre, factor: p.factor });
  }
  return db.prepare(
    `SELECT id, nombre, nombre_normalizado, categoria, unidad_base FROM insumos
      WHERE activo = 1 AND merged_into IS NULL`).all()
    .map(i => ({ ...i, presentaciones: pres[i.id] || [], uso: uso[i.id] ? uso[i.id].n : 0, ultimo_uso: uso[i.id] ? uso[i.id].ultimo : null }))
    .sort((a, b) => b.uso - a.uso || String(b.ultimo_uso || '').localeCompare(String(a.ultimo_uso || '')) || a.nombre.localeCompare(b.nombre));
}

// -------------------------------------------------------------- purchases --
function compraFull(id) {
  const c = db.prepare(
    `SELECT c.*, p.nombre proveedor, a.name cuenta, g.name gerente, u.name usuario, l.name ubicacion
       FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id
       LEFT JOIN accounts a ON a.id = c.account_id LEFT JOIN gerentes g ON g.id = c.gerente_id
       LEFT JOIN users u ON u.id = c.usuario_id JOIN locations l ON l.id = c.location_id
      WHERE c.id = ?`).get(Number(id));
  if (!c) return null;
  c.lineas = db.prepare(
    `SELECT l.id, l.insumo_id, i.nombre insumo, i.categoria, l.presentacion_id, l.presentacion_nombre, l.cantidad,
            l.factor_snapshot, l.cantidad_base, l.unidad_base_snapshot unidad, l.total_linea, l.costo_unitario_base
       FROM compra_lineas l JOIN insumos i ON i.id = l.insumo_id WHERE l.compra_id = ? ORDER BY l.id`).all(c.id);
  c.total = round2(c.lineas.reduce((s, l) => s + l.total_linea, 0));   // always the sum of its lines
  c.tiene_foto = !!c.foto;
  return c;
}

function fmtQty(n) { return String(round4(n)).replace(/\.0+$/, ''); }

// Writes the lines of a purchase and, for each one, its cost row.
function writeLines(compra, lineas, ctx) {
  if (!Array.isArray(lineas) || !lineas.length) throw fail('Agrega al menos un producto');
  if (lineas.length > 60) throw fail('Demasiadas líneas en una sola compra');
  const map = categoryMap(compra.location_id);
  for (const ln of lineas) {
    let insumo;
    if (ln.insumo_id) {
      insumo = resolveInsumo(ln.insumo_id);
      if (!insumo) throw fail('Uno de los insumos ya no existe');
    } else if (ln.nuevo_insumo) {
      insumo = findOrCreateInsumo(ln.nuevo_insumo, { gerenteId: ctx.gerenteId, userId: ctx.userId, reviewed: ctx.reviewed }).insumo;
    } else throw fail('Falta el insumo en una línea');

    const cantidad = Number(ln.cantidad), total = round2(Number(ln.total));
    if (!(cantidad > 0)) throw fail(`Falta la cantidad de ${insumo.nombre}`);
    if (!(total > 0)) throw fail(`Falta el total de ${insumo.nombre}`);

    let pres = null;
    if (ln.presentacion_id) {
      pres = db.prepare('SELECT * FROM insumo_presentaciones WHERE id = ?').get(Number(ln.presentacion_id));
      // After a merge the presentación may have moved to the survivor; anything
      // else is a mismatch and is rebuilt from what the phone sent.
      if (pres && pres.insumo_id !== insumo.id) pres = findOrCreatePresentacion(insumo.id, { nombre: pres.nombre, factor: pres.factor });
    } else if (ln.nueva_presentacion) {
      pres = findOrCreatePresentacion(insumo.id, ln.nueva_presentacion);
    }
    const factor = pres ? pres.factor : 1;                 // no presentación = bought loose, in the base unit
    const cantidadBase = round4(cantidad * factor);
    const costoUnit = round4(total / cantidadBase);

    const cat = map[insumo.categoria] ? db.prepare(
      'SELECT id, default_invoiced FROM variable_cost_categories WHERE id = ?').get(map[insumo.categoria]) : null;
    const desc = pres
      ? `${insumo.nombre} · ${fmtQty(cantidad)} ${pres.nombre} (${fmtQty(cantidadBase)} ${insumo.unidad_base})`
      : `${insumo.nombre} · ${fmtQty(cantidadBase)} ${insumo.unidad_base}`;
    const costId = Number(db.prepare(
      `INSERT INTO oneoff_costs (location_id, date, description, amount, invoiced, account_id, category_id,
         logged_by, gerente_id, receipt) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(compra.location_id, compra.fecha, desc, total, cat && cat.default_invoiced ? 1 : 0,
        compra.account_id, cat ? cat.id : null, ctx.name || null, compra.gerente_id, compra.foto || null).lastInsertRowid);
    db.prepare(
      `INSERT INTO compra_lineas (compra_id, insumo_id, presentacion_id, presentacion_nombre, cantidad, factor_snapshot,
         cantidad_base, unidad_base_snapshot, total_linea, costo_unitario_base, oneoff_cost_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(compra.id, insumo.id, pres ? pres.id : null, pres ? pres.nombre : null, cantidad, factor,
        cantidadBase, insumo.unidad_base, total, costoUnit, costId);
  }
}

function removeLines(compraId) {
  const ids = db.prepare('SELECT oneoff_cost_id id FROM compra_lineas WHERE compra_id = ?').all(compraId).map(r => r.id);
  db.prepare('DELETE FROM compra_lineas WHERE compra_id = ?').run(compraId);
  const del = db.prepare('DELETE FROM oneoff_costs WHERE id = ?');
  ids.forEach(id => del.run(id));
}

function header(locationId, p) {
  const fecha = badDate(p.fecha) ? todayStr() : p.fecha;
  if (fecha > todayStr()) throw fail('La fecha no puede ser futura');
  const acc = p.account_id ? db.prepare(
    'SELECT id FROM accounts WHERE id = ? AND location_id = ? AND active = 1').get(Number(p.account_id), locationId) : null;
  if (p.account_id && !acc) throw fail('Cuenta inválida para esta sucursal');
  let prov = null;
  if (p.proveedor_id) prov = db.prepare('SELECT id FROM proveedores WHERE id = ?').get(Number(p.proveedor_id));
  else if (p.proveedor_nombre) prov = findOrCreateProveedor(p.proveedor_nombre);
  return { fecha, account_id: acc ? acc.id : null, proveedor_id: prov ? prov.id : null,
    notas: String(p.notas || '').trim().slice(0, 300) || null };
}

function savePhoto(compraId, b64) {
  if (!b64 || typeof b64 !== 'string' || b64.length > 8.5e6) return null;
  try {
    fs.mkdirSync(RECEIPT_DIR, { recursive: true });
    const file = `compra-${compraId}.jpg`;
    fs.writeFileSync(path.join(RECEIPT_DIR, file), Buffer.from(b64, 'base64'));
    return file;
  } catch (e) { console.error('foto compra:', e.message); return null; }
}

// ctx: { locationId, gerenteId, userId, name }
function saveCompra(ctx, p) {
  const uid = p.client_uid ? String(p.client_uid).slice(0, 80) : null;
  if (uid) {
    // The phone retries until it hears back. A second arrival is the same purchase.
    const dup = db.prepare('SELECT id FROM compras WHERE client_uid = ?').get(uid);
    if (dup) return { compra: compraFull(dup.id), duplicate: true };
  }
  const id = tx(() => {
    const h = header(ctx.locationId, p);
    const cid = Number(db.prepare(
      `INSERT INTO compras (client_uid, location_id, fecha, proveedor_id, account_id, gerente_id, usuario_id, notas)
       VALUES (?,?,?,?,?,?,?,?)`)
      .run(uid, ctx.locationId, h.fecha, h.proveedor_id, h.account_id, ctx.gerenteId || null, ctx.userId || null, h.notas).lastInsertRowid);
    const foto = savePhoto(cid, p.foto_base64);
    if (foto) db.prepare('UPDATE compras SET foto = ? WHERE id = ?').run(foto, cid);
    writeLines(db.prepare('SELECT * FROM compras WHERE id = ?').get(cid), p.lineas, ctx);
    return cid;
  });
  return { compra: compraFull(id), duplicate: false };
}

function updateCompra(compraId, ctx, p) {
  tx(() => {
    const cur = db.prepare('SELECT * FROM compras WHERE id = ?').get(compraId);
    const h = header(cur.location_id, { ...p, fecha: p.fecha || cur.fecha });
    db.prepare('UPDATE compras SET fecha = ?, proveedor_id = ?, account_id = ?, notas = ? WHERE id = ?')
      .run(h.fecha, h.proveedor_id, h.account_id, h.notas, compraId);
    const foto = savePhoto(compraId, p.foto_base64);
    if (foto) db.prepare('UPDATE compras SET foto = ? WHERE id = ?').run(foto, compraId);
    removeLines(compraId);
    writeLines(db.prepare('SELECT * FROM compras WHERE id = ?').get(compraId), p.lineas, ctx);
  });
  return compraFull(compraId);
}

function deleteCompra(compraId) {
  tx(() => { removeLines(compraId); db.prepare('DELETE FROM compras WHERE id = ?').run(compraId); });
}

const isCompraCost = oneoffId => !!db.prepare('SELECT 1 x FROM compra_lineas WHERE oneoff_cost_id = ?').get(Number(oneoffId));

// Lines whose stored total no longer equals their cost row. Must be empty.
function ledgerDrift() {
  return db.prepare(
    `SELECT l.id linea_id, l.total_linea, o.amount, c.fecha, o.date, c.location_id loc_compra, o.location_id loc_costo
       FROM compra_lineas l JOIN compras c ON c.id = l.compra_id JOIN oneoff_costs o ON o.id = l.oneoff_cost_id
      WHERE ABS(l.total_linea - o.amount) > 0.005 OR c.fecha <> o.date OR c.location_id <> o.location_id`).all();
}

// ------------------------------------------------------- catalog hygiene ---
function listInsumos({ pendientes = false, incluirInactivos = false } = {}) {
  const where = ['i.merged_into IS NULL'];
  if (pendientes) where.push('i.revisado = 0', 'i.activo = 1');
  else if (!incluirInactivos) where.push('i.activo = 1');
  return db.prepare(
    `SELECT i.*, g.name creado_por,
            (SELECT COUNT(*) FROM compra_lineas l WHERE l.insumo_id = i.id) compras,
            (SELECT MAX(c.fecha) FROM compra_lineas l JOIN compras c ON c.id = l.compra_id WHERE l.insumo_id = i.id) ultima_compra
       FROM insumos i LEFT JOIN gerentes g ON g.id = i.creado_por_gerente
      WHERE ${where.join(' AND ')} ORDER BY i.revisado, i.nombre`).all()
    .map(i => ({ ...i, presentaciones: db.prepare(
      'SELECT id, nombre, factor FROM insumo_presentaciones WHERE insumo_id = ? ORDER BY id').all(i.id) }));
}

function updateInsumo(id, b) {
  const cur = db.prepare('SELECT * FROM insumos WHERE id = ? AND merged_into IS NULL').get(Number(id));
  if (!cur) throw fail('Insumo no encontrado', 404);
  const nombre = b.nombre !== undefined ? String(b.nombre).trim().replace(/\s+/g, ' ') : cur.nombre;
  if (!nombre || !normalize(nombre)) throw fail('Falta el nombre');
  const categoria = b.categoria !== undefined ? b.categoria : cur.categoria;
  const unidad = b.unidad_base !== undefined ? b.unidad_base : cur.unidad_base;
  if (!CATEGORIAS.includes(categoria)) throw fail('Categoría inválida');
  if (!UNIDADES.includes(unidad)) throw fail('Unidad inválida');
  if (unidad !== cur.unidad_base && b.confirmar_unidad !== true) {
    const n = db.prepare('SELECT COUNT(*) c FROM compra_lineas WHERE insumo_id = ?').get(cur.id).c;
    throw Object.assign(fail(
      `Cambiar la unidad de ${cur.unidad_base} a ${unidad} no modifica las ${n} compras ya registradas: conservan su precio por ${cur.unidad_base}. Confirma para continuar.`, 409),
      { needsConfirm: true });
  }
  // Only the catalog row changes. Purchase lines keep the unit, factor and
  // unit cost they were stored with.
  db.prepare('UPDATE insumos SET nombre = ?, nombre_normalizado = ?, categoria = ?, unidad_base = ?, activo = ?, revisado = ? WHERE id = ?')
    .run(nombre, normalize(nombre), categoria, unidad,
      b.activo !== undefined ? (b.activo ? 1 : 0) : cur.activo,
      b.revisado !== undefined ? (b.revisado ? 1 : 0) : cur.revisado, cur.id);
  return db.prepare('SELECT * FROM insumos WHERE id = ?').get(cur.id);
}

// Fold duplicates into one survivor. Purchase lines are re-pointed, never
// deleted or re-priced; the merged insumos stay in the table, marked.
function mergeInsumos(survivorId, otherIds) {
  const survivor = db.prepare('SELECT * FROM insumos WHERE id = ? AND merged_into IS NULL').get(Number(survivorId));
  if (!survivor) throw fail('El insumo que se conserva no existe', 404);
  const ids = [...new Set((otherIds || []).map(Number))].filter(id => id && id !== survivor.id);
  if (!ids.length) throw fail('Elige al menos un insumo para fusionar');
  const others = ids.map(id => db.prepare('SELECT * FROM insumos WHERE id = ? AND merged_into IS NULL').get(id));
  if (others.some(o => !o)) throw fail('Uno de los insumos ya no existe o ya fue fusionado', 404);
  const bad = others.find(o => o.unidad_base !== survivor.unidad_base);
  if (bad) throw fail(`"${bad.nombre}" está en ${bad.unidad_base} y "${survivor.nombre}" en ${survivor.unidad_base}. Para fusionarlos deben tener la misma unidad base.`, 409);

  let moved = 0;
  tx(() => {
    for (const o of others) {
      for (const p of db.prepare('SELECT * FROM insumo_presentaciones WHERE insumo_id = ?').all(o.id)) {
        const twin = db.prepare(
          'SELECT id FROM insumo_presentaciones WHERE insumo_id = ? AND nombre_normalizado = ? AND ABS(factor - ?) < 1e-9')
          .get(survivor.id, p.nombre_normalizado, p.factor);
        if (twin) {
          db.prepare('UPDATE compra_lineas SET presentacion_id = ? WHERE presentacion_id = ?').run(twin.id, p.id);
          db.prepare('DELETE FROM insumo_presentaciones WHERE id = ?').run(p.id);
        } else {
          db.prepare('UPDATE insumo_presentaciones SET insumo_id = ? WHERE id = ?').run(survivor.id, p.id);
        }
      }
      moved += db.prepare('UPDATE compra_lineas SET insumo_id = ? WHERE insumo_id = ?').run(survivor.id, o.id).changes;
      db.prepare('UPDATE insumos SET merged_into = ?, activo = 0, revisado = 1 WHERE id = ?').run(survivor.id, o.id);
      // anything merged into `o` earlier now points straight at the survivor
      db.prepare('UPDATE insumos SET merged_into = ? WHERE merged_into = ?').run(survivor.id, o.id);
    }
    db.prepare('UPDATE insumos SET revisado = 1 WHERE id = ?').run(survivor.id);
  });
  return { survivor: db.prepare('SELECT * FROM insumos WHERE id = ?').get(survivor.id), lineas_movidas: moved, fusionados: ids.length };
}

// --------------------------------------------------------------- analytics --
const config = () => db.prepare('SELECT alerta_pct, alerta_n FROM inventario_config WHERE id = 1').get();

function filterSql(f, args) {
  const w = [`c.location_id IN (${f.locationIds.map(() => '?').join(',')})`];
  args.push(...f.locationIds);
  if (f.from) { w.push('c.fecha >= ?'); args.push(f.from); }
  if (f.to) { w.push('c.fecha <= ?'); args.push(f.to); }
  if (f.categoria) { w.push('i.categoria = ?'); args.push(f.categoria); }
  if (f.proveedorId) { w.push('c.proveedor_id = ?'); args.push(Number(f.proveedorId)); }
  if (f.insumoId) { w.push('l.insumo_id = ?'); args.push(Number(f.insumoId)); }
  return w.join(' AND ');
}
const FROM = `FROM compra_lineas l JOIN compras c ON c.id = l.compra_id JOIN insumos i ON i.id = l.insumo_id`;

// Spend per insumo for the period and for the equally long period before it.
function gastoPorInsumo(f) {
  if (!f.locationIds.length) return { rows: [], total: 0, total_prev: 0, prev: null };
  const one = (from, to) => {
    const args = [];
    const where = filterSql({ ...f, from, to }, args);
    return db.prepare(
      `SELECT l.insumo_id id, i.nombre, i.categoria, i.unidad_base unidad, SUM(l.total_linea) gasto,
              SUM(l.cantidad_base) cantidad_base, COUNT(*) lineas ${FROM} WHERE ${where} GROUP BY l.insumo_id`).all(...args);
  };
  const cur = one(f.from, f.to);
  const len = daysBetween(f.from, f.to) + 1;
  const prevTo = addDays(f.from, -1), prevFrom = addDays(prevTo, -(len - 1));
  const prev = Object.fromEntries(one(prevFrom, prevTo).map(r => [r.id, r.gasto]));
  const rows = cur.map(r => ({
    ...r, gasto: round2(r.gasto), cantidad_base: round4(r.cantidad_base),
    precio_promedio: r.cantidad_base > 0 ? round4(r.gasto / r.cantidad_base) : null,
    gasto_prev: round2(prev[r.id] || 0),
    cambio_pct: prev[r.id] > 0 ? round2((r.gasto - prev[r.id]) / prev[r.id] * 100) : null
  })).sort((a, b) => b.gasto - a.gasto);
  return { rows, total: round2(rows.reduce((s, r) => s + r.gasto, 0)),
    total_prev: round2(Object.values(prev).reduce((s, v) => s + v, 0)), prev: { from: prevFrom, to: prevTo } };
}

// Every purchase of one insumo, with the unit cost exactly as stored.
function precioSerie(f) {
  const args = [];
  const where = filterSql(f, args);
  return db.prepare(
    `SELECT l.id, c.id compra_id, c.fecha, l.costo_unitario_base, l.unidad_base_snapshot unidad, l.cantidad_base, l.total_linea,
            l.cantidad, l.presentacion_nombre, p.nombre proveedor, loc.name ubicacion
       ${FROM} LEFT JOIN proveedores p ON p.id = c.proveedor_id JOIN locations loc ON loc.id = c.location_id
      WHERE ${where} ORDER BY c.fecha, l.id`).all(...args);
}

// A line is flagged when its unit cost is more than X% above the average of
// the previous N purchases of that insumo at the same sucursal, in the same unit.
function alertas(f) {
  const { alerta_pct, alerta_n } = config();
  const args = [];
  const where = filterSql(f, args);
  const lines = db.prepare(
    `SELECT l.id, l.insumo_id, i.nombre insumo, i.categoria, c.id compra_id, c.fecha, c.location_id, loc.name ubicacion,
            l.costo_unitario_base, l.unidad_base_snapshot unidad, l.total_linea, p.nombre proveedor, g.name gerente
       ${FROM} LEFT JOIN proveedores p ON p.id = c.proveedor_id JOIN locations loc ON loc.id = c.location_id
       LEFT JOIN gerentes g ON g.id = c.gerente_id
      WHERE ${where} ORDER BY c.fecha DESC, l.id DESC`).all(...args);
  const before = db.prepare(
    `SELECT l.costo_unitario_base v FROM compra_lineas l JOIN compras c ON c.id = l.compra_id
      WHERE l.insumo_id = ? AND c.location_id = ? AND l.unidad_base_snapshot = ?
        AND (c.fecha < ? OR (c.fecha = ? AND l.id < ?)) ORDER BY c.fecha DESC, l.id DESC LIMIT ?`);
  const out = [];
  for (const ln of lines) {
    const prev = before.all(ln.insumo_id, ln.location_id, ln.unidad, ln.fecha, ln.fecha, ln.id, alerta_n);
    if (!prev.length) continue;
    const avg = prev.reduce((s, r) => s + r.v, 0) / prev.length;
    const pct = (ln.costo_unitario_base - avg) / avg * 100;
    if (pct > alerta_pct) out.push({ ...ln, promedio: round4(avg), sobre_pct: round2(pct), compras_previas: prev.length });
  }
  return { alertas: out, alerta_pct, alerta_n };
}

function proveedoresCompare(f) {
  const args = [];
  const where = filterSql(f, args);
  return db.prepare(
    `SELECT COALESCE(p.nombre, 'Sin proveedor') proveedor, l.unidad_base_snapshot unidad, COUNT(*) compras,
            SUM(l.cantidad_base) cantidad_base, SUM(l.total_linea) gasto, MAX(c.fecha) ultima
       ${FROM} LEFT JOIN proveedores p ON p.id = c.proveedor_id WHERE ${where}
      GROUP BY c.proveedor_id, l.unidad_base_snapshot`).all(...args)
    .map(r => ({ ...r, gasto: round2(r.gasto), cantidad_base: round4(r.cantidad_base),
      costo_promedio: round4(r.gasto / r.cantidad_base) }))       // weighted by quantity bought
    .sort((a, b) => a.costo_promedio - b.costo_promedio);
}

// One-shot base catalog (data-seed/catalogo-base.json). Idempotent: an insumo
// or proveedor that already exists under any spelling is left exactly as is;
// only the missing ones are created (as reviewed, by the owner). Never edits.
function importCatalog(seed, { userId }) {
  const out = { proveedores: 0, insumos: 0, existentes: 0 };
  tx(() => {
    for (const p of seed.proveedores || []) {
      const before = db.prepare('SELECT COUNT(*) c FROM proveedores').get().c;
      const prov = findOrCreateProveedor(p.nombre);
      if (db.prepare('SELECT COUNT(*) c FROM proveedores').get().c > before) {
        out.proveedores++;
        if (p.notas) db.prepare('UPDATE proveedores SET notas = ? WHERE id = ?').run(String(p.notas), prov.id);
      }
    }
    for (const i of seed.insumos || []) {
      const r = findOrCreateInsumo(i, { userId, reviewed: true });
      if (r.created) out.insumos++; else out.existentes++;
    }
  });
  return out;
}

module.exports = { importCatalog, CATEGORIAS, UNIDADES, categoryMap, setCategoryMap, resolveInsumo, findOrCreateInsumo,
  findOrCreatePresentacion, findOrCreateProveedor, catalog, compraFull, saveCompra, updateCompra, deleteCompra,
  isCompraCost, ledgerDrift, listInsumos, updateInsumo, mergeInsumos, config, gastoPorInsumo, precioSerie,
  alertas, proveedoresCompare, fail };
