// Inventario: capture from the phone, single cost ledger, catalog hygiene,
// price analytics, and the composition chart reconciling with the cost totals.
// Run: node scripts/inventario-tests.js   (boots the real server on a temp db)
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/aldia-inventario-tests';
process.env.PORT = process.env.PORT || '4603';
delete process.env.SETUP_CODE;
require('node:fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });
const { db } = require('../src/db');
require('../server.js');
const calc = require('../src/calc');
const inv = require('../src/inventario/core');
const M = require('../public/compra/normalize');
const { addDays, todayStr } = require('../src/lib/dates');
const B = `http://127.0.0.1:${process.env.PORT}/api`;

let failures = 0;
function chk(label, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}: ${label}${ok ? '' : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!ok) failures++;
}
const near = (a, b) => Math.abs(a - b) < 0.005;
function client() {
  const jar = {};
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(B + path, { method,
      headers: { 'Content-Type': 'application/json', Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      body: body ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      if (kv.slice(i + 1)) jar[kv.slice(0, i)] = kv.slice(i + 1); else delete jar[kv.slice(0, i)];
    }
    let json = null; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, json };
  };
  return call;
}
const q1 = (sql, ...a) => db.prepare(sql).get(...a);

(async () => {
  await new Promise(r => setTimeout(r, 400));
  const owner = client();
  await owner('POST', '/setup', { name: 'Diego', email: 'd@t.mx', password: 'password123', locationName: 'Bugo MTY' });
  await owner('POST', '/locations', { name: 'Bugo TRC' });
  const [MTY, TRC] = db.prepare('SELECT id FROM locations ORDER BY id').all().map(r => r.id);
  await owner('POST', '/gerente-admin/gerentes', { name: 'Ana', pin: '1234', location_ids: [MTY, TRC] });
  await owner('POST', '/gerente-admin/gerentes', { name: 'Beto', pin: '5678', location_ids: [MTY] });
  const ana = q1(`SELECT id FROM gerentes WHERE name='Ana'`).id, beto = q1(`SELECT id FROM gerentes WHERE name='Beto'`).id;
  const today = todayStr();

  console.log('== name matching: the same product under another name is found ==');
  chk('normalize', 'pollo pechuga', M.normalize('  Pollos  Pechúga '));
  chk('plural / accent / case', true, M.normalize('LIMONES') === M.normalize('limón'));
  chk('tomate = tomates', true, M.normalize('Tomates') === M.normalize('tomate'));
  chk('nueces = nuez', true, M.normalize('Nueces') === M.normalize('nuez'));
  chk('word order and filler ignored', true, M.score('pechuga de pollo', M.normalize('Pollo pechuga')) > 0);
  chk('prefix while typing', true, M.score('poll', M.normalize('Pollo pechuga')) > 0);
  chk('one typo forgiven', true, M.score('pechuva', M.normalize('Pollo pechuga')) > 0);
  chk('unrelated does not match', 0, M.score('queso', M.normalize('Pollo pechuga')));
  chk('exact beats partial', true, M.score('pollo', M.normalize('Pollo')) > M.score('pollo', M.normalize('Pollo pechuga')));

  console.log('== phone access: personal link, then PIN ==');
  const phone = client();
  chk('unknown phone has no access', null, (await phone('GET', '/p/boot')).json.mode);
  chk('catalog refused', 401, (await phone('GET', `/p/catalogo?location=${MTY}`)).status);
  chk('bad link refused', 404, (await phone('POST', '/p/activate', { k: 'nope' })).status);
  let r = await owner('POST', '/inventario/links', { gerente_id: ana });
  const k = new URL(r.json.url).searchParams.get('k');
  chk('link is stored hashed', false, q1('SELECT token_hash h FROM gerente_links').h === k);
  chk('activate', 200, (await phone('POST', '/p/activate', { k })).status);
  r = await phone('GET', '/p/boot');
  chk('phone now belongs to Ana, both sucursales', ['link', 'Ana', 2], [r.json.mode, r.json.gerente.name, r.json.locations.length]);
  chk('still needs the PIN', 401, (await phone('GET', `/p/catalogo?location=${MTY}`)).status);
  chk('wrong PIN', 401, (await phone('POST', '/p/pin', { pin: '5678' })).status);   // Beto's PIN does not open Ana's phone
  const A = { 'X-Gerente': (await phone('POST', '/p/pin', { pin: '1234' })).json.token };
  // Beto on his own phone
  const phoneB = client();
  await phoneB('POST', '/p/activate', { k: new URL((await owner('POST', '/inventario/links', { gerente_id: beto })).json.url).searchParams.get('k') });
  const Bh = { 'X-Gerente': (await phoneB('POST', '/p/pin', { pin: '5678' })).json.token };
  chk("Ana's session does not work on Beto's phone", 401, (await phoneB('GET', `/p/catalogo?location=${MTY}`, null, A)).status);
  chk('Beto has no access to TRC', 403, (await phoneB('GET', `/p/catalogo?location=${TRC}`, null, Bh)).status);

  console.log('== the phone reaches nothing else, and no prices ==');
  for (const p of ['/me', `/dashboard?location=${MTY}`, '/inventario/insumos', `/inventario/resumen?location=${MTY}`,
                   `/inventario/precio?insumo=1`, `/costs/composition?location=${MTY}`]) {
    chk(`no access to ${p.split('?')[0]}`, 401, (await phone('GET', p, null, A)).status);
  }

  console.log('== capture: multi-line, new insumo and presentación inline ==');
  let cat = (await phone('GET', `/p/catalogo?location=${MTY}`, null, A)).json;
  chk('catalog starts empty', 0, cat.insumos.length);
  const cuenta = cat.cuentas[0].id;
  const compra1 = { client_uid: 'uid-1', location_id: MTY, proveedor_nombre: 'Carnes del Norte', account_id: cuenta, lineas: [
    { nuevo_insumo: { nombre: 'Pollo pechuga', categoria: 'Proteína', unidad_base: 'kg' }, nueva_presentacion: { nombre: 'Caja', factor: 10 }, cantidad: 2, total: 2840 },
    { nuevo_insumo: { nombre: 'Bowl 32 oz', categoria: 'Desechables', unidad_base: 'pieza' }, nueva_presentacion: { nombre: 'Paquete', factor: 50 }, cantidad: 3, total: 450 },
    { nuevo_insumo: { nombre: 'Carbón', categoria: 'Otros', unidad_base: 'kg' }, cantidad: 4, total: 120 } ] };
  r = await phone('POST', '/p/compras', compra1, A);
  chk('saved', 200, r.status);
  chk('one compra, total = sum of its lines', [1, 3410], [q1('SELECT COUNT(*) c FROM compras').c, r.json.compra.total]);
  const l1 = q1(`SELECT l.* FROM compra_lineas l JOIN insumos i ON i.id = l.insumo_id WHERE i.nombre = 'Pollo pechuga'`);
  chk('snapshots stored on the line', [2, 10, 20, 'kg', 2840, 142],
    [l1.cantidad, l1.factor_snapshot, l1.cantidad_base, l1.unidad_base_snapshot, l1.total_linea, l1.costo_unitario_base]);
  chk('loose purchase uses factor 1', [1, 4, 30], Object.values(q1(
    `SELECT l.factor_snapshot f, l.cantidad_base c, l.costo_unitario_base u FROM compra_lineas l JOIN insumos i ON i.id = l.insumo_id WHERE i.nombre = 'Carbón'`)));
  chk('insumos created by a gerente wait for review', [3, 0], Object.values(q1('SELECT COUNT(*) c, SUM(revisado) s FROM insumos')));
  chk('presentación learned', { nombre: 'Caja', factor: 10 }, q1(`SELECT nombre, factor FROM insumo_presentaciones WHERE insumo_id = ?`, l1.insumo_id));
  chk('proveedor created', 'Carnes del Norte', q1('SELECT nombre n FROM proveedores').n);

  console.log('== single ledger: every line is one row in the existing cost table ==');
  const costs = db.prepare(`SELECT o.*, vc.benchmark_tag tag FROM oneoff_costs o LEFT JOIN variable_cost_categories vc ON vc.id = o.category_id ORDER BY o.id`).all();
  chk('three cost rows, same money', [3, 3410], [costs.length, costs.reduce((s, c) => s + c.amount, 0)]);
  chk('food / packaging / uncategorised', ['food', 'packaging', null], costs.map(c => c.tag));
  chk('carry account, date, sucursal and gerente', [cuenta, today, MTY, ana, 'Ana'],
    [costs[0].account_id, costs[0].date, costs[0].location_id, costs[0].gerente_id, costs[0].logged_by]);
  chk('readable description', 'Pollo pechuga · 2 Caja (20 kg)', costs[0].description);
  const sum = calc.summary(MTY, today, today);
  chk('flows into the existing summary', 3410, sum.costs.total);
  chk('food benchmark sees the chicken', 2840, sum.tagTotals.food);
  chk('packaging benchmark sees the bowls', 450, sum.tagTotals.packaging);
  chk('nothing landed in the other sucursal', 0, calc.summary(TRC, today, today).costs.total);
  chk('lines and ledger agree', [], inv.ledgerDrift());

  console.log('== a retried upload is the same purchase ==');
  r = await phone('POST', '/p/compras', compra1, A);
  chk('second arrival accepted as duplicate', [200, true], [r.status, r.json.duplicate]);
  chk('still one compra and three cost rows', [1, 3], [q1('SELECT COUNT(*) c FROM compras').c, q1('SELECT COUNT(*) c FROM oneoff_costs').c]);

  console.log('== the same product by another name does not create a duplicate ==');
  cat = (await phone('GET', `/p/catalogo?location=${MTY}`, null, A)).json;
  chk('frecuentes: used insumos come back', 3, cat.insumos.filter(i => i.uso > 0).length);
  chk('catalog sends no prices to the gerente', false, /costo|precio|total/.test(JSON.stringify(cat.insumos)));
  const hits = q => cat.insumos.filter(i => M.score(q, i.nombre_normalizado) > 0).map(i => i.nombre);
  chk('"Pechugas de pollo" surfaces the existing one', ['Pollo pechuga'], hits('Pechugas de pollo'));
  chk('"poll" surfaces it while typing', ['Pollo pechuga'], hits('poll'));
  r = await phone('POST', '/p/compras', { client_uid: 'uid-2', location_id: MTY, lineas: [
    { nuevo_insumo: { nombre: 'POLLOS PECHÚGA', categoria: 'Proteína', unidad_base: 'kg' }, cantidad: 5, total: 700 } ] }, A);
  chk('even if "create" is forced, the server reuses it', 3, q1('SELECT COUNT(*) c FROM insumos').c);
  chk('line points at the existing insumo', l1.insumo_id, q1(`SELECT insumo_id i FROM compra_lineas ORDER BY id DESC LIMIT 1`).i);

  console.log('== editing a presentación never rewrites history ==');
  db.prepare('UPDATE insumo_presentaciones SET factor = 12 WHERE insumo_id = ?').run(l1.insumo_id);
  chk('old line keeps factor 10 and $142/kg', [10, 20, 142], Object.values(q1(
    'SELECT factor_snapshot f, cantidad_base c, costo_unitario_base u FROM compra_lineas WHERE id = ?', l1.id)));
  db.prepare('UPDATE insumo_presentaciones SET factor = 10 WHERE insumo_id = ?').run(l1.insumo_id);

  console.log('== gerente permissions on captures ==');
  const mine = (await phone('GET', `/p/catalogo?location=${MTY}`, null, A)).json.mias;
  chk('Ana sees her two captures of today', 2, mine.length);
  chk("Beto sees none of Ana's", 0, (await phoneB('GET', `/p/catalogo?location=${MTY}`, null, Bh)).json.mias.length);
  const c2 = mine[0].id;
  chk('Beto cannot edit it', 403, (await phoneB('PUT', `/p/compras/${c2}`, { location_id: MTY, lineas: [{ insumo_id: l1.insumo_id, cantidad: 1, total: 1 }] }, Bh)).status);
  r = await phone('PUT', `/p/compras/${c2}`, { location_id: MTY, lineas: [{ insumo_id: l1.insumo_id, presentacion_id: l1.presentacion_id, cantidad: 1, total: 1500 }] }, A);
  chk('Ana can', 200, r.status);
  chk('edit replaced the cost row too (no orphan, no double)', [4, 4910], Object.values(q1('SELECT COUNT(*) c, SUM(amount) s FROM oneoff_costs')));
  chk('ledger still agrees', [], inv.ledgerDrift());
  db.prepare(`UPDATE compras SET fecha = ? WHERE id = ?`).run(addDays(today, -1), c2);
  db.prepare(`UPDATE oneoff_costs SET date = ? WHERE id IN (SELECT oneoff_cost_id FROM compra_lineas WHERE compra_id = ?)`).run(addDays(today, -1), c2);
  chk('not editable once it is no longer today', 403, (await phone('PUT', `/p/compras/${c2}`, { location_id: MTY, lineas: [{ insumo_id: l1.insumo_id, cantidad: 1, total: 1 }] }, A)).status);
  chk('bad line rejected whole (no half-saved purchase)', [400, 2], [(await phone('POST', '/p/compras', { client_uid: 'uid-bad', location_id: MTY,
    lineas: [{ insumo_id: l1.insumo_id, cantidad: 1, total: 100 }, { insumo_id: l1.insumo_id, cantidad: 0, total: 5 }] }, A)).status, q1('SELECT COUNT(*) c FROM compras').c]);

  console.log('== the quick register is untouched, and purchase rows are locked there ==');
  r = await owner('POST', `/oneoff?location=${MTY}`, { location_id: MTY, date: today, description: 'Gas', amount: 800 });
  chk('quick register still saves', 200, r.status);
  chk('…and edits its own rows', 200, (await owner('PUT', `/oneoff/${r.json.id}?location=${MTY}`, { location_id: MTY, amount: 850 })).status);
  chk('editing a purchase line there is refused', 409, (await owner('PUT', `/oneoff/${costs[0].id}?location=${MTY}`, { location_id: MTY, amount: 1 })).status);
  chk('deleting it there is refused', 409, (await owner('DELETE', `/oneoff/${costs[0].id}?location=${MTY}`, { location_id: MTY })).status);
  chk('amount unchanged', 2840, q1('SELECT amount a FROM oneoff_costs WHERE id = ?', costs[0].id).a);

  console.log('== catalog hygiene ==');
  r = await owner('GET', '/inventario/insumos?pendientes=1');
  chk('review queue lists the three', 3, r.json.insumos.length);
  // a real duplicate that slipped through under a different word
  await phone('POST', '/p/compras', { client_uid: 'uid-3', location_id: MTY, proveedor_nombre: 'Carnes del Norte', lineas: [
    { nuevo_insumo: { nombre: 'Pechuga s/hueso', categoria: 'Proteína', unidad_base: 'kg' }, nueva_presentacion: { nombre: 'caja', factor: 10 }, cantidad: 1, total: 1500 },
    { nuevo_insumo: { nombre: 'Pechuga s/hueso', categoria: 'Proteína', unidad_base: 'kg' }, nueva_presentacion: { nombre: 'Bolsa', factor: 5 }, cantidad: 1, total: 760 } ] }, A);
  const dupe = q1(`SELECT id FROM insumos WHERE nombre = 'Pechuga s/hueso'`).id;
  const before = q1('SELECT COUNT(*) c, SUM(total_linea) s FROM compra_lineas');
  const priceBefore = db.prepare('SELECT id, costo_unitario_base u, factor_snapshot f FROM compra_lineas ORDER BY id').all();
  const carbon = q1(`SELECT id FROM insumos WHERE nombre = 'Carbón'`).id;
  await owner('PUT', `/inventario/insumos/${carbon}`, { unidad_base: 'pieza', confirmar_unidad: true });
  chk('merge refused across different units', 409, (await owner('POST', '/inventario/insumos/merge', { survivor_id: l1.insumo_id, ids: [carbon] })).status);
  r = await owner('POST', '/inventario/insumos/merge', { survivor_id: l1.insumo_id, ids: [dupe] });
  chk('merge moved its 2 lines', [200, 2], [r.status, r.json.lineas_movidas]);
  chk('no purchase line lost, money unchanged', before, q1('SELECT COUNT(*) c, SUM(total_linea) s FROM compra_lineas'));
  chk('stored unit prices and factors untouched', priceBefore, db.prepare('SELECT id, costo_unitario_base u, factor_snapshot f FROM compra_lineas ORDER BY id').all());
  chk('all chicken history on the survivor', 4, q1('SELECT COUNT(*) c FROM compra_lineas WHERE insumo_id = ?', l1.insumo_id).c);
  chk('presentaciones merged: Caja once, Bolsa added', ['Caja:10', 'Bolsa:5'],
    db.prepare('SELECT nombre, factor FROM insumo_presentaciones WHERE insumo_id = ? ORDER BY id').all(l1.insumo_id).map(p => `${p.nombre}:${p.factor}`));
  chk('merged insumo kept, marked, not deleted', [0, l1.insumo_id], Object.values(q1('SELECT activo a, merged_into m FROM insumos WHERE id = ?', dupe)));
  chk('gone from the phone catalog', false, (await phone('GET', `/p/catalogo?location=${MTY}`, null, A)).json.insumos.some(i => i.id === dupe));
  r = await phone('POST', '/p/compras', { client_uid: 'uid-4', location_id: MTY, lineas: [{ insumo_id: dupe, cantidad: 2, total: 290 }] }, A);
  chk('a capture queued before the merge still lands on the survivor', l1.insumo_id, q1('SELECT insumo_id i FROM compra_lineas ORDER BY id DESC LIMIT 1').i);
  chk('ledger agrees after merge', [], inv.ledgerDrift());

  r = await owner('PUT', `/inventario/insumos/${l1.insumo_id}`, { unidad_base: 'pieza' });
  chk('changing the unit asks for confirmation', [409, true], [r.status, r.json.needsConfirm]);
  chk('nothing changed yet', 'kg', q1('SELECT unidad_base u FROM insumos WHERE id = ?', l1.insumo_id).u);
  await owner('PUT', `/inventario/insumos/${l1.insumo_id}`, { unidad_base: 'pieza', confirmar_unidad: true });
  chk('history keeps its unit and price', ['kg', 142], Object.values(q1('SELECT unidad_base_snapshot u, costo_unitario_base c FROM compra_lineas WHERE id = ?', l1.id)));
  await owner('PUT', `/inventario/insumos/${l1.insumo_id}`, { unidad_base: 'kg', confirmar_unidad: true, revisado: true, nombre: 'Pollo pechuga' });

  console.log('== price analytics ==');
  // six purchases of tortilla at TRC: five at $20/kg, then one at $23 (15% up) and one at $22 (≤12% vs the new average)
  const tort = inv.findOrCreateInsumo({ nombre: 'Tortilla', categoria: 'Abarrotes', unidad_base: 'kg' }, { userId: 1 }).insumo;
  chk('admin-created insumo is already reviewed', 1, tort.revisado);
  const buy = (day, total, prov) => inv.saveCompra({ locationId: TRC, gerenteId: ana, name: 'Ana' },
    { fecha: addDays(today, -day), proveedor_nombre: prov, lineas: [{ insumo_id: tort.id, cantidad: 10, total }] });
  [12, 11, 10, 9, 8].forEach(d => buy(d, 200, 'Tortillería A'));
  buy(3, 230, 'Tortillería B'); buy(2, 220, 'Tortillería B');
  r = await owner('GET', `/inventario/resumen?location=${TRC}&from=${addDays(today, -6)}&to=${today}`);
  chk('one alert: the $23 purchase', [1, 23, 20, 15], [r.json.alertas.length, r.json.alertas[0].costo_unitario_base, r.json.alertas[0].promedio, r.json.alertas[0].sobre_pct]);
  chk('defaults 12% / last 5', [12, 5], [r.json.alerta_pct, r.json.alerta_n]);
  chk('spend this period vs previous, with % change', [450, 1000, -55], [r.json.rows[0].gasto, r.json.rows[0].gasto_prev, r.json.rows[0].cambio_pct]);
  chk('average price per kg', 22.5, r.json.rows[0].precio_promedio);
  await owner('PUT', '/inventario/ajustes', { alerta_pct: 5, alerta_n: 5 });
  chk('threshold is configurable', 2, (await owner('GET', `/inventario/resumen?location=${TRC}&from=${addDays(today, -6)}&to=${today}`)).json.alertas.length);
  await owner('PUT', '/inventario/ajustes', { alerta_pct: 12, alerta_n: 5 });
  r = await owner('GET', `/inventario/precio?insumo=${tort.id}&location=${TRC}&from=${addDays(today, -30)}&to=${today}`);
  chk('price series: one point per purchase, as stored', [20, 20, 20, 20, 20, 23, 22], r.json.serie.map(s => s.costo_unitario_base));
  chk('supplier comparison, cheapest first', [['Tortillería A', 20], ['Tortillería B', 22.5]], r.json.proveedores.map(p => [p.proveedor, p.costo_promedio]));
  chk('filter by sucursal', 0, (await owner('GET', `/inventario/precio?insumo=${tort.id}&location=${MTY}`)).json.serie.length);
  chk('filter by categoría', ['Tortilla'], (await owner('GET', `/inventario/resumen?location=all&categoria=Abarrotes&from=${addDays(today, -30)}&to=${today}`)).json.rows.map(x => x.nombre));

  console.log('== composition chart reconciles with the existing cost totals ==');
  // give MTY every kind of cost: rent (spread), a day-to-day cost, sales with commission, the purchases above
  const rentCat = q1(`SELECT id FROM recurring_cost_categories WHERE location_id = ? AND name = 'Rent'`, MTY).id;
  db.prepare(`INSERT INTO recurring_costs (location_id, category_id, description, amount, frequency, invoiced, start_date) VALUES (?,?,?,?,?,0,?)`)
    .run(MTY, rentCat, 'Renta local', 30000, 'monthly', addDays(today, -40));
  const foodCat = q1(`SELECT id FROM variable_cost_categories WHERE location_id = ? AND benchmark_tag = 'food'`, MTY).id;
  db.prepare('INSERT INTO variable_costs (location_id, date, category_id, amount, invoiced) VALUES (?,?,?,?,0)').run(MTY, today, foodCat, 300);
  const { upsertDayRevenue } = require('../src/lib/revenue');
  const uber = q1(`SELECT id FROM revenue_categories WHERE location_id = ? AND name LIKE '%Uber Eats%'`, MTY).id;
  for (let d = 0; d < 10; d++) upsertDayRevenue(MTY, addDays(today, -d), { items: [{ category_id: uber, amount: 5000 }] });
  const from = addDays(today, -9);
  r = await owner('GET', `/costs/composition?location=${MTY}&from=${from}&to=${today}`);
  const days = r.json.days.filter(d => !d.lead);
  chk('one bar per day', 10, days.length);
  chk('6 lead days for the 7-day average', 6, r.json.days.filter(d => d.lead).length);
  chk('each day: segments add up to that day\'s total from summary()', true,
    days.every(d => near(d.segments.reduce((s, x) => s + x.amount, 0), d.total) && near(d.total, calc.summary(MTY, d.date, d.date).costs.total)));
  const period = calc.summary(MTY, from, today);
  chk('sum of the bars = the period total from summary()', true, near(days.reduce((s, d) => s + d.total, 0), period.costs.total));
  chk('…which is what the endpoint reports as the period', true, near(r.json.period.costs, period.costs.total));
  chk('revenue line matches too', true, near(days.reduce((s, d) => s + d.revenue, 0), period.revenue));
  const todayBar = days[days.length - 1];
  const seg = Object.fromEntries(todayBar.segments.map(s => [s.label, s]));
  chk('product money shown by insumo categoría', [true, true], [seg['Proteína'].producto, seg['Desechables'].producto]);
  chk('quick-register and day-to-day costs keep their own blocks', [true, true], ['Otros gastos' in seg, 'Food & drink ingredients' in seg]);
  chk('day-to-day food block is only the non-purchase part', 300, seg['Food & drink ingredients'].amount);
  chk('rent is fijo, commissions variable', ['fijo', 'variable'], [seg['Rent'].tipo, seg['Comisiones'].tipo]);
  chk('no negative or duplicate segments', true, todayBar.segments.every(s => s.amount > 0) && new Set(todayBar.segments.map(s => s.key)).size === todayBar.segments.length);
  chk('range capped', 400, (await owner('GET', `/costs/composition?location=${MTY}&from=${addDays(today, -200)}&to=${today}`)).status);

  console.log('== drill-down ==');
  r = await owner('GET', `/costs/day-lines?location=${MTY}&date=${today}`);
  const dl = r.json;
  const dlSum = dl.compras.reduce((s, c) => s + c.total, 0) + dl.otros.reduce((s, o) => s + o.amount, 0) + dl.diarios.reduce((s, o) => s + o.amount, 0)
    + dl.fijos.reduce((s, o) => s + o.amount, 0) + dl.nomina + dl.comisiones;
  chk('everything listed adds up to the day total', true, near(dlSum, dl.total));
  chk('purchase shows insumos, proveedor, cuenta and who', ['Pollo pechuga', 'Carnes del Norte', true, 'Ana'],
    [dl.compras[0].lineas[0].insumo, dl.compras[0].proveedor, !!dl.compras[0].cuenta, dl.compras[0].capturo]);
  chk('quick-register cost listed separately', ['Gas'], dl.otros.map(o => o.description));

  console.log('== voiding a purchase removes its cost rows with it ==');
  const victim = q1(`SELECT id FROM compras WHERE client_uid = 'uid-4'`).id;
  const costBefore = calc.summary(MTY, today, today).costs.total;
  chk('delete', 200, (await owner('DELETE', `/inventario/compras/${victim}`)).status);
  chk('day total dropped by exactly that purchase', true, near(costBefore - 290, calc.summary(MTY, today, today).costs.total));
  chk('ledger agrees at the end', [], inv.ledgerDrift());

  console.log('== quick-expense link (/go) also captures by product, without a PIN ==');
  const mgr = (await owner('POST', '/users', { email: 'm@t.mx', name: 'Mario', password: 'password123', locationIds: [TRC] })).json.id;
  const goUrl = (await owner('POST', `/quick-links/${mgr}`)).json.url;
  const goPhone = client();
  chk('no cookie yet: no access', null, (await goPhone('GET', '/p/boot')).json.mode);
  const page = await fetch(goUrl, { redirect: 'manual' });
  const qCookie = (page.headers.getSetCookie().find(c => c.startsWith('aldia_qlink=')) || '').split(';')[0];
  chk('/go plants the cookie', true, qCookie.length > 'aldia_qlink='.length);
  chk('/go page links to /compra', true, (await page.text()).includes('href="/compra/"'));
  const Q = { Cookie: qCookie };
  let qb = (await goPhone('GET', '/p/boot', null, Q)).json;
  chk('boot: quick mode, Mario, only TRC, token handed over', ['quick', 'Mario', [TRC], true], [qb.mode, qb.gerente.name, qb.locations.map(l => l.id), !!qb.token]);
  const QA = { Cookie: qCookie, 'X-Gerente': qb.token };
  chk('no token: refused', 401, (await goPhone('GET', `/p/catalogo?location=${TRC}`, null, Q)).status);
  chk("Ana's gerente token does not open Mario's link", 401, (await goPhone('GET', `/p/catalogo?location=${TRC}`, null, { Cookie: qCookie, ...A })).status);
  chk('MTY not allowed for Mario', 403, (await goPhone('GET', `/p/catalogo?location=${MTY}`, null, QA)).status);
  chk('catalog opens', 200, (await goPhone('GET', `/p/catalogo?location=${TRC}`, null, QA)).status);
  const trcBefore = calc.summary(TRC, today, today).costs.total;
  r = await goPhone('POST', '/p/compras', { client_uid: 'uid-q1', location_id: TRC, lineas: [
    { nuevo_insumo: { nombre: 'Tortilla harina', categoria: 'Abarrotes', unidad_base: 'kg' }, cantidad: 5, total: 300 },
    { insumo_id: l1.insumo_id, cantidad: 1, total: 150 } ] }, QA);
  chk('saved by the quick-link user', 200, r.status);
  const qc = q1('SELECT gerente_id g, usuario_id u FROM compras WHERE client_uid = ?', 'uid-q1');
  chk('compra carries usuario_id, no gerente', [null, mgr], [qc.g, qc.u]);
  chk('cost rows logged by Mario', 'Mario', q1(`SELECT logged_by l FROM oneoff_costs WHERE description LIKE 'Tortilla harina%'`).l);
  chk("a manager's new insumo waits for review", 0, q1(`SELECT revisado r FROM insumos WHERE nombre = 'Tortilla harina'`).r);
  chk('TRC day total grew by the purchase', true, near(trcBefore + 450, calc.summary(TRC, today, today).costs.total));
  r = await goPhone('GET', `/p/catalogo?location=${TRC}`, null, QA);
  chk('sees only his own capture of today', [1, 450], [r.json.mias.length, r.json.mias[0].total]);
  chk("Ana's phone does not see Mario's compra", 0, (await phoneB('GET', `/p/catalogo?location=${MTY}`, null, Bh)).json.mias.filter(c => c.total === 450).length);
  const qid = r.json.mias[0].id;
  chk('edits his own', 200, (await goPhone('PUT', `/p/compras/${qid}`, { location_id: TRC, lineas: [{ insumo_id: l1.insumo_id, cantidad: 1, total: 160 }] }, QA)).status);
  chk('edit landed in the ledger', true, near(trcBefore + 160, calc.summary(TRC, today, today).costs.total));
  chk('ledger agrees', [], inv.ledgerDrift());
  await owner('DELETE', `/quick-links/${mgr}`);
  chk('revoked quick link is locked out', 401, (await goPhone('GET', `/p/catalogo?location=${TRC}`, null, QA)).status);

  console.log('== base catalog: loads once, never duplicates, never edits ==');
  const seed = require('../data-seed/catalogo-base.json');
  chk('seed has no duplicate names', seed.insumos.length, new Set(seed.insumos.map(i => M.normalize(i.nombre))).size);
  chk('seed categories/units valid', true, seed.insumos.every(i => inv.CATEGORIAS.includes(i.categoria) && inv.UNIDADES.includes(i.unidad_base)));
  const insBefore = q1('SELECT COUNT(*) c FROM insumos').c;
  // 'Pollo pechuga' exists under a gerente with unit kg; seed has 'Pollo pechuga premium' (different name) — both stay.
  r = await owner('GET', '/inventario/catalogo-base');
  chk('preview counts what is missing', seed.insumos.length, r.json.faltan);
  r = await owner('POST', '/inventario/catalogo-base');
  chk('all new created, reviewed, by the owner', [seed.insumos.length, seed.insumos.length], [r.json.insumos,
    q1('SELECT COUNT(*) c FROM insumos WHERE revisado = 1 AND creado_por_usuario IS NOT NULL AND id > ?', insBefore).c]);
  chk('proveedores created with notas', 'Pedir con 4 días de anticipación, entre lunes y jueves', q1(`SELECT notas n FROM proveedores WHERE nombre = 'Tortillas Estella'`).n);
  chk('an existing proveedor is reused, not duplicated', 1, q1(`SELECT COUNT(*) c FROM proveedores WHERE nombre_normalizado = ?`, M.normalize('Carnes del Norte')).c);
  const total = q1('SELECT COUNT(*) c FROM insumos').c, provTotal = q1('SELECT COUNT(*) c FROM proveedores').c;
  r = await owner('POST', '/inventario/catalogo-base');
  chk('second load: nothing new', [0, 0, seed.insumos.length], [r.json.insumos, r.json.proveedores, r.json.existentes]);
  chk('tables unchanged', [total, provTotal], [q1('SELECT COUNT(*) c FROM insumos').c, q1('SELECT COUNT(*) c FROM proveedores').c]);
  chk('phone is refused', 401, (await phoneB('POST', '/inventario/catalogo-base', null, Bh)).status);

  console.log('== revoking a phone ==');
  await owner('DELETE', `/inventario/links/${q1('SELECT id FROM gerente_links WHERE gerente_id = ?', ana).id}`);
  chk('revoked phone is locked out', 401, (await phone('GET', `/p/catalogo?location=${MTY}`, null, A)).status);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL INVENTARIO TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
