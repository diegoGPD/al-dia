// Daily cost composition for the charts on the costs page.
//
// There is no aggregation logic of its own here: every day's numbers come from
// calc.summary(location, day, day) — the same function behind the dashboard —
// so recurring-cost spreading, labor, commissions and reconciliations are
// whatever the rest of the app says they are. The only thing added is a
// re-labelling: the part of a cost category that came from purchase lines is
// shown under its insumo categoría instead. That moves money between segments
// of a day; it never changes the day's total.
const { db } = require('../db');
const calc = require('../calc');
const { addDays, daysBetween } = require('../lib/dates');

const LEAD = 6;                                // extra days in front, for the 7-day average
const clean = n => (Math.abs(n) < 0.005 ? 0 : n);

function composition(locationId, start, end) {
  const from = addDays(start, -LEAD);
  // Purchase money per day, by insumo categoría and by the cost category it was posted to.
  const split = {};
  for (const r of db.prepare(
    `SELECT o.date, i.categoria, vc.name cost_cat, SUM(o.amount) amount
       FROM compra_lineas l JOIN oneoff_costs o ON o.id = l.oneoff_cost_id JOIN insumos i ON i.id = l.insumo_id
       LEFT JOIN variable_cost_categories vc ON vc.id = o.category_id
      WHERE o.location_id = ? AND o.date BETWEEN ? AND ? GROUP BY o.date, i.categoria, vc.name`).all(locationId, from, end)) {
    (split[r.date] = split[r.date] || []).push(r);
  }

  const days = [];
  for (let d = from; d <= end; d = addDays(d, 1)) {
    const s = calc.summary(locationId, d, d);
    const seg = {};                            // key -> { label, tipo, producto, amount }
    const add = (key, label, tipo, producto, amount) => {
      if (!seg[key]) seg[key] = { label, tipo, producto, amount: 0 };
      seg[key].amount += amount;
    };
    for (const [name, v] of Object.entries(s.costs.recurringByCategory)) add('rec:' + name, name, 'fijo', false, v.amount);
    if (s.costs.labor) add('labor', 'Nómina (horario)', 'fijo', false, s.costs.labor);
    if (s.costs.commissions) add('comm', 'Comisiones', 'variable', false, s.costs.commissions);
    for (const r of s.costs.variableByCategory) add('cat:' + r.name, r.name, 'variable', false, r.amount);
    if (s.costs.oneoff) add('otros', 'Otros gastos', 'variable', false, s.costs.oneoff);
    for (const r of split[d] || []) {
      add(r.cost_cat ? 'cat:' + r.cost_cat : 'otros', r.cost_cat || 'Otros gastos', 'variable', false, -r.amount);
      add('ins:' + r.categoria, r.categoria, 'variable', true, r.amount);
    }
    const segments = Object.entries(seg).map(([key, v]) => ({ key, ...v, amount: clean(v.amount) })).filter(v => v.amount !== 0);
    days.push({ date: d, lead: d < start, revenue: s.revenue, total: s.costs.total, segments });
  }
  // The whole period, straight from the shared helper, for the UI to check against.
  const period = calc.summary(locationId, start, end);
  return { start, end, days, period: { revenue: period.revenue, costs: period.costs.total } };
}

// Everything that makes up one day's cost, for the drill-down.
function dayLines(locationId, date) {
  const s = calc.summary(locationId, date, date);
  const compras = db.prepare(
    `SELECT c.id, p.nombre proveedor, a.name cuenta, COALESCE(g.name, u.name) capturo, c.foto IS NOT NULL tiene_foto
       FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id LEFT JOIN accounts a ON a.id = c.account_id
       LEFT JOIN gerentes g ON g.id = c.gerente_id LEFT JOIN users u ON u.id = c.usuario_id
      WHERE c.location_id = ? AND c.fecha = ? ORDER BY c.id`).all(locationId, date)
    .map(c => {
      const lineas = db.prepare(
        `SELECT i.nombre insumo, i.categoria, l.cantidad, l.presentacion_nombre, l.cantidad_base, l.unidad_base_snapshot unidad,
                l.costo_unitario_base, o.amount total, o.id oneoff_id
           FROM compra_lineas l JOIN insumos i ON i.id = l.insumo_id JOIN oneoff_costs o ON o.id = l.oneoff_cost_id
          WHERE l.compra_id = ? ORDER BY l.id`).all(c.id);
      return { ...c, lineas, total: lineas.reduce((t, l) => t + l.total, 0) };
    });
  const otros = db.prepare(
    `SELECT o.id, o.description, o.amount, vc.name categoria, a.name cuenta, o.logged_by capturo, o.receipt IS NOT NULL tiene_foto
       FROM oneoff_costs o LEFT JOIN variable_cost_categories vc ON vc.id = o.category_id LEFT JOIN accounts a ON a.id = o.account_id
      WHERE o.location_id = ? AND o.date = ? AND NOT EXISTS (SELECT 1 FROM compra_lineas l WHERE l.oneoff_cost_id = o.id)
      ORDER BY o.id`).all(locationId, date);
  const diarios = db.prepare(
    `SELECT vc.name categoria, v.amount FROM variable_costs v JOIN variable_cost_categories vc ON vc.id = v.category_id
      WHERE v.location_id = ? AND v.date = ? AND v.amount <> 0 ORDER BY vc.position`).all(locationId, date);
  const fijos = db.prepare(
    `SELECT rc.description, rc.amount, rc.frequency, rc.start_date, rc.end_date, c.name categoria
       FROM recurring_costs rc JOIN recurring_cost_categories c ON c.id = rc.category_id
      WHERE rc.location_id = ? AND rc.active = 1`).all(locationId)
    .map(it => ({ description: it.description, categoria: it.categoria,
      amount: calc.dailyRate(it) * calc.overlapDays(it, date, date) })).filter(it => it.amount > 0);
  return { date, total: s.costs.total, revenue: s.revenue, compras, otros, diarios, fijos,
    nomina: s.costs.labor, comisiones: s.costs.commissions };
}

module.exports = { composition, dayLines, LEAD, daysBetween };
