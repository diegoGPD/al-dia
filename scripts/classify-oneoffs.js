// Classify existing one-off costs whose description starts with a cost
// category name (the old "Category — note" format).
//   node scripts/classify-oneoffs.js            # preview only
//   node scripts/classify-oneoffs.js --apply    # write the changes
const { db } = require('../src/db');
const { plan, apply } = require('../src/lib/classify-oneoffs');

const doApply = process.argv.includes('--apply');
const locations = db.prepare('SELECT id, name FROM locations WHERE active = 1').all();

for (const loc of locations) {
  const matches = plan(loc.id);
  console.log(`\n${loc.name}: ${matches.length} one-off cost(s) can be classified`);
  for (const m of matches) {
    console.log(`  ${m.date}  ${String(m.amount).padStart(9)}  ${m.category_name}`);
    console.log(`      "${m.from}"  ->  "${m.to}"`);
  }
  if (doApply && matches.length) {
    const r = apply(loc.id);
    console.log(`  applied: ${r.updated} updated`);
    for (const [name, v] of Object.entries(r.byCategory)) {
      console.log(`    ${name}: ${v.count} cost(s), ${v.amount.toFixed(2)}`);
    }
  }
}
if (!doApply) console.log('\nPreview only — re-run with --apply to save these changes.');
