// Apertura / Cierre checklists: editable templates, one run per location per
// business day, and records that never change once finished.
const { db } = require('../db');
const { addDays } = require('../lib/dates');

const TZ_OFFSET_H = Number(process.env.TZ_OFFSET_HOURS ?? -6);
const TYPES = ['apertura', 'cierre'];

// A cierre that ends after midnight belongs to the day it closes: anything
// before 5:00 am local still counts as the previous business day.
function businessDate(nowMs = Date.now()) {
  const local = new Date(nowMs + TZ_OFFSET_H * 3600e3);
  const day = local.toISOString().slice(0, 10);
  return local.getUTCHours() < 5 ? addDays(day, -1) : day;
}

// ---------------------------------------------------------------- seed -----
const W = text => ({ text, warning: 1 });
const SEED_CIERRE = {
  header_note: 'Marca cada casilla solo cuando la actividad esté completamente terminada.',
  comments_placeholder: 'Anota faltantes, fallas, productos que no hubo para descongelar o cualquier situación fuera de lo normal.',
  footer_note: 'Si falta producto, algo no funciona o existe cualquier duda: hablarle a ALESS o a DIEGO sin titubear.',
  sections: [
    { title: 'BARRA CALIENTE', items: [
      'Apagar la barra caliente.',
      'Sacar todos los insertos de la barra caliente.',
      'Guardar correctamente toda la comida de la barra caliente.',
      'Guardar la lechuga de barra en el refrigerador.',
      'Guardar las tortillas en el refrigerador.'] },
    { title: 'CREPERAS', items: [
      'Crepera industrial: bajar la temperatura hasta 0.',
      'Crepera industrial: desconectar la crepera de la corriente.',
      'Crepera industrial: desconectar también su regulador.',
      W('CUIDADO: No desconectar la comandera.'),
      'Desconectar la crepera pequeña que está al lado de la barra fría.'] },
    { title: 'BARRA FRÍA Y REFRIGERACIÓN', items: [
      'Guardar todos los botes de salsas en el refrigerador.',
      'Guardar los ice packs en el congelador.',
      'Guardar los tocino bites y el parmesano en el refrigerador pequeño.',
      'Mandar a lavado el scoop de guacamole.',
      'Colocar las tapas de metal en todos los insertos de la barra fría.',
      'Verificar que la barra fría se quede prendida.',
      'Verificar que el refrigerador se quede prendido.',
      'Verificar que el congelador se quede prendido.',
      'Verificar que la enfriadora de bebidas se quede prendida.'] },
    { title: 'COCINA', items: [
      'Verificar que el depósito de residuos de la plancha quede sin comida.',
      'Verificar que todos los pilotos estén apagados.',
      "Apagar 'el enojón' (aire de cocina).",
      'Verificar que el extractor esté apagado.',
      'Apagar las luces de cocina.'] },
    { title: 'PREPARACIÓN PARA EL DÍA SIGUIENTE', items: [
      'Dejar 3 paquetes de pollo descongelándose.',
      'Dejar 3 paquetes de carne descongelándose.',
      'Si no hay suficiente pollo o carne para descongelar, avisar ASAP a ALESS.',
      'Revisar el inventario de tapas.',
      'Revisar el inventario de bowls.',
      'Si no hay suficientes tapas o bowls, avisar ASAP a ALESS.',
      'Verificar que haya 2 galones de jugo de limón en refrigeración.',
      'Verificar que haya 1 galón de jugo de naranja en refrigeración.'] },
    { title: 'LAVADO Y LIMPIEZA', items: [
      'Lavar los recipientes de salsas de enfrente.',
      'Lavar el rallador de queso.',
      'Lavar todos los trastes pendientes.',
      'Revisar nuevamente que no quede ningún traste sin lavar.',
      'Vaciar los botes de basura de la barra.',
      'Cerrar correctamente la bolsa de basura.',
      'Dejar la bolsa dentro del bote de basura y dejar el bote bien tapado.',
      'Barrer todas las áreas de trabajo.',
      'Trapear todas las áreas de trabajo.',
      'Revisar que el trapeador no se quede dentro de la cubeta.'] },
    { title: 'EQUIPO Y ELECTRÓNICOS', items: [
      'Apagar las televisiones del menú.',
      'Pausar la música de la computadora.',
      W('NO apagar la computadora.'),
      'Dejar la computadora encendida y solamente bloquear la pantalla.',
      'Apagar la máquina enlatadora.',
      'Conectar el cable del teclado a la terminal para dejarlo cargando durante la noche.',
      'Apagar el mini split.'] },
    { title: 'BAÑO Y ÁREA DE ENFRENTE', items: [
      'Verificar que la luz del baño esté apagada.',
      'Apagar las luces de enfrente.',
      'Apagar las luces de los letreros de afuera.'] },
    { title: 'GAS', warning_note: 'IMPORTANTE: Estas llaves deben quedar completamente cerradas.', items: [
      'Cerrar la llave del gas de adentro.',
      'Cerrar la llave del gas de afuera.',
      'Verificar nuevamente que ambas llaves hayan quedado completamente cerradas.'] },
    { title: 'SEGURIDAD DEL LOCAL', items: [
      'Bajar todas las cortinas de fierro.',
      'Colocar el candado correspondiente en cada cortina.',
      'Revisar que todos los candados estén correctamente cerrados.'] },
    { title: 'VERIFICACIÓN FINAL ANTES DE IRSE', items: [
      'Gas de adentro cerrado.', 'Gas de afuera cerrado.', 'Pilotos apagados.',
      'Barra caliente apagada.', 'Creperas apagadas y desconectadas.', 'Extractor apagado.',
      "'El enojón' apagado.", 'Mini split apagado.', 'Luces de cocina apagadas.',
      'Luces de enfrente apagadas.', 'Luces de letreros apagadas.', 'Teles apagadas.',
      'Computadora encendida pero con pantalla bloqueada.', 'Refrigerador prendido.',
      'Congelador prendido.', 'Barra fría prendida.', 'Enfriadora de bebidas prendida.',
      'No quedan trastes sucios.', 'No queda comida fuera de refrigeración.',
      'Basura cerrada y bote tapado.', 'Cortinas abajo y con candado.'] }
  ]
};
const SEED_APERTURA = {
  header_note: SEED_CIERRE.header_note,
  comments_placeholder: 'Anota faltantes, fallas o cualquier situación fuera de lo normal.',
  footer_note: SEED_CIERRE.footer_note,
  sections: []                       // filled in by the admin from the editor
};

// Every location gets both templates the first time anyone asks for them, so a
// location added later is covered without a migration.
function ensureTemplates(locationId) {
  for (const type of TYPES) {
    if (db.prepare('SELECT 1 x FROM checklist_templates WHERE location_id = ? AND type = ?').get(locationId, type)) continue;
    const seed = type === 'cierre' ? SEED_CIERRE : SEED_APERTURA;
    db.exec('BEGIN');
    try {
      const tid = Number(db.prepare(
        `INSERT INTO checklist_templates (location_id, type, header_note, comments_placeholder, footer_note)
         VALUES (?,?,?,?,?)`).run(locationId, type, seed.header_note, seed.comments_placeholder, seed.footer_note).lastInsertRowid);
      seed.sections.forEach((sec, si) => {
        const sid = Number(db.prepare(
          'INSERT INTO checklist_sections (template_id, title, warning_note, position) VALUES (?,?,?,?)')
          .run(tid, sec.title, sec.warning_note || null, si).lastInsertRowid);
        sec.items.forEach((it, ii) => {
          const item = typeof it === 'string' ? { text: it, warning: 0 } : it;
          db.prepare('INSERT INTO checklist_items (section_id, text, warning, position) VALUES (?,?,?,?)')
            .run(sid, item.text, item.warning, ii);
        });
      });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

function templateFull(locationId, type, { includeInactive = false } = {}) {
  ensureTemplates(locationId);
  const tpl = db.prepare('SELECT * FROM checklist_templates WHERE location_id = ? AND type = ?').get(locationId, type);
  const act = includeInactive ? '' : 'AND active = 1';
  tpl.sections = db.prepare(
    `SELECT * FROM checklist_sections WHERE template_id = ? ${act} ORDER BY position, id`).all(tpl.id);
  for (const s of tpl.sections) {
    s.items = db.prepare(
      `SELECT * FROM checklist_items WHERE section_id = ? ${act} ORDER BY position, id`).all(s.id);
  }
  return tpl;
}

// ----------------------------------------------------------------- runs ----
const nowIso = () => new Date().toISOString();

function runFull(runId) {
  const run = db.prepare(
    `SELECT r.*, l.name location_name, g1.name started_by_name, g2.name finished_by_name
       FROM checklist_runs r JOIN locations l ON l.id = r.location_id
       LEFT JOIN gerentes g1 ON g1.id = r.started_by
       LEFT JOIN gerentes g2 ON g2.id = r.finished_by
      WHERE r.id = ?`).get(runId);
  if (!run) return null;
  const items = db.prepare(
    `SELECT i.id, i.section_pos, i.section_title, i.section_note, i.position, i.text, i.warning,
            i.checked_at, i.checked_by, g.name checked_by_name
       FROM checklist_run_items i LEFT JOIN gerentes g ON g.id = i.checked_by
      WHERE i.run_id = ? ORDER BY i.section_pos, i.position, i.id`).all(runId);
  const sections = [];
  for (const it of items) {
    let sec = sections[sections.length - 1];
    if (!sec || sec.pos !== it.section_pos) {
      sec = { pos: it.section_pos, title: it.section_title, note: it.section_note, items: [] };
      sections.push(sec);
    }
    sec.items.push({ id: it.id, text: it.text, warning: !!it.warning,
      checked_at: it.checked_at, checked_by: it.checked_by, checked_by_name: it.checked_by_name });
  }
  run.sections = sections;
  run.total = items.length;
  run.done = items.filter(i => i.checked_at).length;
  run.gerentes = db.prepare(
    `SELECT g.id, g.name, rg.joined_at FROM checklist_run_gerentes rg
       JOIN gerentes g ON g.id = rg.gerente_id WHERE rg.run_id = ? ORDER BY rg.joined_at`).all(runId);
  return run;
}

const joinRun = (runId, gerenteId) => db.prepare(
  'INSERT OR IGNORE INTO checklist_run_gerentes (run_id, gerente_id, joined_at) VALUES (?,?,?)')
  .run(runId, gerenteId, nowIso());

// Today's run for this type: resumed if it exists, created from the template
// (snapshotted right now) if it doesn't.
function startOrResume(locationId, type, gerenteId) {
  if (!TYPES.includes(type)) return { error: 'Tipo inválido' };
  const date = businessDate();
  const existing = db.prepare(
    'SELECT id, status FROM checklist_runs WHERE location_id = ? AND type = ? AND business_date = ?')
    .get(locationId, type, date);
  if (existing) {
    if (existing.status === 'in_progress') joinRun(existing.id, gerenteId);
    return { run: runFull(existing.id), resumed: true };
  }
  const tpl = templateFull(locationId, type);
  const count = tpl.sections.reduce((n, s) => n + s.items.length, 0);
  if (!count) return { error: `El checklist de ${type} aún no está configurado. Pídele al administrador que lo llene.`, notConfigured: true };

  const started = nowIso();
  db.exec('BEGIN');
  let runId;
  try {
    runId = Number(db.prepare(
      `INSERT INTO checklist_runs (location_id, type, business_date, started_at, started_by,
         header_note, comments_placeholder, footer_note) VALUES (?,?,?,?,?,?,?,?)`)
      .run(locationId, type, date, started, gerenteId,
        tpl.header_note, tpl.comments_placeholder, tpl.footer_note).lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO checklist_run_items (run_id, section_pos, section_title, section_note, position, text, warning)
       VALUES (?,?,?,?,?,?,?)`);
    let si = 0;
    for (const s of tpl.sections) {
      if (!s.items.length) continue;
      s.items.forEach((it, ii) => ins.run(runId, si, s.title, s.warning_note || null, ii, it.text, it.warning ? 1 : 0));
      si++;
    }
    db.prepare('INSERT INTO checklist_run_gerentes (run_id, gerente_id, joined_at) VALUES (?,?,?)')
      .run(runId, gerenteId, started);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    // Two taps racing to start the same checklist: the loser resumes the winner's.
    const again = db.prepare(
      'SELECT id FROM checklist_runs WHERE location_id = ? AND type = ? AND business_date = ?')
      .get(locationId, type, date);
    if (again) { joinRun(again.id, gerenteId); return { run: runFull(again.id), resumed: true }; }
    throw e;
  }
  return { run: runFull(runId), resumed: false };
}

// The tablet's clock is trusted for WHEN something was ticked (it may sync an
// hour later), but never for a moment in the future.
function cleanAt(at) {
  const t = Date.parse(at);
  if (!Number.isFinite(t) || t > Date.now() + 5 * 60e3) return nowIso();
  return new Date(t).toISOString();
}

// Idempotent: each op is "item X was (un)ticked at T". Re-sending the same
// queue changes nothing, and an older op never overrides a newer one.
function applyOps(runId, ops, gerenteId, comments) {
  const run = db.prepare('SELECT id, status FROM checklist_runs WHERE id = ?').get(runId);
  if (!run) return { error: 'Checklist no encontrado' };
  if (run.status === 'completed') return { completed: true };   // immutable — silently ignored
  joinRun(runId, gerenteId);
  const get = db.prepare('SELECT id, op_at FROM checklist_run_items WHERE id = ? AND run_id = ?');
  const upd = db.prepare('UPDATE checklist_run_items SET checked_at = ?, checked_by = ?, op_at = ? WHERE id = ?');
  for (const op of Array.isArray(ops) ? ops.slice(0, 2000) : []) {
    const item = get.get(Number(op.item_id), runId);
    if (!item) continue;
    const at = cleanAt(op.at);
    if (item.op_at && at < item.op_at) continue;
    upd.run(op.checked ? at : null, op.checked ? gerenteId : null, at, item.id);
  }
  if (typeof comments === 'string') {
    db.prepare('UPDATE checklist_runs SET comments = ? WHERE id = ?').run(comments.slice(0, 4000), runId);
  }
  return { ok: true };
}

function finish(runId, gerenteId, comments) {
  const run = db.prepare('SELECT * FROM checklist_runs WHERE id = ?').get(runId);
  if (!run) return { error: 'Checklist no encontrado' };
  if (run.status === 'completed') return { ok: true, already: true };
  const left = db.prepare(
    'SELECT COUNT(*) c FROM checklist_run_items WHERE run_id = ? AND checked_at IS NULL').get(runId).c;
  if (left > 0) return { error: `Faltan ${left} actividades por marcar.`, left };
  db.prepare(
    `UPDATE checklist_runs SET status = 'completed', finished_at = ?, finished_by = ?, comments = ? WHERE id = ?`)
    .run(nowIso(), gerenteId, typeof comments === 'string' ? comments.trim().slice(0, 4000) : (run.comments || null), runId);
  joinRun(runId, gerenteId);
  return { ok: true };
}

function todayStatus(locationId) {
  const date = businessDate();
  const out = { business_date: date };
  for (const type of TYPES) {
    const run = db.prepare(
      `SELECT r.id, r.status,
              (SELECT COUNT(*) FROM checklist_run_items i WHERE i.run_id = r.id) total,
              (SELECT COUNT(*) FROM checklist_run_items i WHERE i.run_id = r.id AND i.checked_at IS NOT NULL) done
         FROM checklist_runs r WHERE r.location_id = ? AND r.type = ? AND r.business_date = ?`)
      .get(locationId, type, date);
    const tpl = templateFull(locationId, type);
    out[type] = {
      configured: tpl.sections.some(s => s.items.length > 0),
      status: run ? run.status : 'none',
      run_id: run ? run.id : null, done: run ? run.done : 0, total: run ? run.total : 0
    };
  }
  return out;
}

function history({ locationIds, from, to, type, gerenteId, limit = 300 }) {
  if (!locationIds.length) return [];
  const where = [`r.location_id IN (${locationIds.map(() => '?').join(',')})`];
  const args = [...locationIds];
  if (from) { where.push('r.business_date >= ?'); args.push(from); }
  if (to) { where.push('r.business_date <= ?'); args.push(to); }
  if (TYPES.includes(type)) { where.push('r.type = ?'); args.push(type); }
  if (gerenteId) {
    where.push('EXISTS (SELECT 1 FROM checklist_run_gerentes rg WHERE rg.run_id = r.id AND rg.gerente_id = ?)');
    args.push(Number(gerenteId));
  }
  const rows = db.prepare(
    `SELECT r.id, r.location_id, l.name location_name, r.type, r.business_date, r.status,
            r.started_at, r.finished_at,
            CASE WHEN r.comments IS NOT NULL AND trim(r.comments) <> '' THEN 1 ELSE 0 END has_comments,
            (SELECT group_concat(name, ', ') FROM (SELECT g.name FROM checklist_run_gerentes rg
               JOIN gerentes g ON g.id = rg.gerente_id WHERE rg.run_id = r.id ORDER BY rg.joined_at)) gerentes,
            (SELECT COUNT(*) FROM checklist_run_items i WHERE i.run_id = r.id) total,
            (SELECT COUNT(*) FROM checklist_run_items i WHERE i.run_id = r.id AND i.checked_at IS NOT NULL) done
       FROM checklist_runs r JOIN locations l ON l.id = r.location_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.business_date DESC, r.started_at DESC LIMIT ?`).all(...args, limit);
  for (const r of rows) {
    r.duration_min = r.finished_at
      ? Math.max(0, Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 60e3)) : null;
  }
  return rows;
}

// Days with no finished apertura / cierre. Counting starts at the first one
// ever completed at that location, so nothing is flagged before the team has
// actually begun using a checklist; days marked closed are skipped.
function missing(locationId, lookbackDays = 30) {
  const today = businessDate();
  const out = [];
  const closed = new Set(db.prepare(
    'SELECT date FROM closed_days WHERE location_id = ? AND date >= ?')
    .all(locationId, addDays(today, -lookbackDays)).map(r => r.date));
  for (const type of TYPES) {
    const first = db.prepare(
      `SELECT MIN(business_date) d FROM checklist_runs
        WHERE location_id = ? AND type = ? AND status = 'completed'`).get(locationId, type).d;
    if (!first) continue;
    const runs = Object.fromEntries(db.prepare(
      'SELECT business_date, status FROM checklist_runs WHERE location_id = ? AND type = ? AND business_date >= ?')
      .all(locationId, type, addDays(today, -lookbackDays)).map(r => [r.business_date, r.status]));
    let d = addDays(today, -lookbackDays);
    if (d < first) d = first;
    for (; d < today; d = addDays(d, 1)) {
      if (closed.has(d) || runs[d] === 'completed') continue;
      out.push({ date: d, type, state: runs[d] === 'in_progress' ? 'sin_finalizar' : 'faltante' });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.type.localeCompare(b.type));
}

module.exports = { TYPES, businessDate, ensureTemplates, templateFull, startOrResume, runFull,
  applyOps, finish, todayStatus, history, missing };
