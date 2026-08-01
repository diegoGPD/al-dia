// Back-fills category_id on one-off costs whose description carries the
// category as a prefix — the shape the quick-entry page used to save before
// one-offs had a real category field, e.g.
//   "Food & drink ingredients — Champis Fresco y Material Capacitación"
// The prefix is stripped, so the description keeps only the real note.
const { db } = require('../db');

const SEPARATORS = ['—', '–', '-', ':', '|'];

function plan(locationId) {
  const cats = db.prepare(
    `SELECT id, name FROM variable_cost_categories WHERE location_id = ? AND active = 1`)
    .all(locationId)
    // longest first, so "Food & drink ingredients" wins over a shorter overlap
    .sort((a, b) => b.name.length - a.name.length);
  const rows = db.prepare(
    `SELECT id, description, amount, date FROM oneoff_costs
     WHERE location_id = ? AND category_id IS NULL`).all(locationId);

  const matches = [];
  for (const r of rows) {
    const desc = (r.description || '').trim();
    const lower = desc.toLowerCase();
    for (const c of cats) {
      const name = c.name.toLowerCase();
      if (!lower.startsWith(name)) continue;
      let rest = desc.slice(c.name.length).trim();
      if (rest && SEPARATORS.includes(rest[0])) rest = rest.slice(1).trim();
      // Only a genuine prefix match: either the whole description is the
      // category, or a separator/space followed it.
      const boundaryOk = desc.length === c.name.length ||
        SEPARATORS.includes(desc[c.name.length]) || desc[c.name.length] === ' ';
      if (!boundaryOk) continue;
      matches.push({
        id: r.id, date: r.date, amount: r.amount,
        from: desc, to: rest || c.name,
        category_id: c.id, category_name: c.name
      });
      break;
    }
  }
  return matches;
}

function apply(locationId) {
  const matches = plan(locationId);
  const up = db.prepare('UPDATE oneoff_costs SET category_id = ?, description = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const m of matches) up.run(m.category_id, m.to, m.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const byCategory = {};
  for (const m of matches) {
    byCategory[m.category_name] = byCategory[m.category_name] || { count: 0, amount: 0 };
    byCategory[m.category_name].count++;
    byCategory[m.category_name].amount += m.amount;
  }
  return { updated: matches.length, byCategory, matches };
}

module.exports = { plan, apply };
