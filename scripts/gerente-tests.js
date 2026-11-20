// Vista de Gerente: tablet + PIN auth, scoping, checklists, immutability.
// Run: node scripts/gerente-tests.js   (boots the real server on a temp db)
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/aldia-gerente-tests';
process.env.PORT = process.env.PORT || '4599';
delete process.env.SETUP_CODE;
require('node:fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });
const { db } = require('../src/db');
require('../server.js');
const B = `http://127.0.0.1:${process.env.PORT}/api`;

let failures = 0;
function chk(label, expected, actual) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}: ${label}${ok ? '' : `  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!ok) failures++;
}
// tiny cookie-jar client
function client() {
  const jar = {};
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(B + path, { method,
      headers: { 'Content-Type': 'application/json',
        Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      body: body ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      if (kv.slice(i + 1)) jar[kv.slice(0, i)] = kv.slice(i + 1); else delete jar[kv.slice(0, i)];
    }
    let json = null; try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
  };
  call.jar = jar;
  return call;
}

(async () => {
  await new Promise(r => setTimeout(r, 400));
  const owner = client();
  await owner('POST', '/setup', { name: 'Diego', email: 'd@t.mx', password: 'password123', locationName: 'Bugo MTY' });
  await owner('POST', '/locations', { name: 'Bugo TRC' });
  const locs = db.prepare('SELECT id, name FROM locations ORDER BY id').all();
  const MTY = locs[0].id, TRC = (locs[1] || {}).id;
  chk('two locations exist', true, !!TRC);

  console.log('== existing schema is untouched ==');
  chk('users.role still owner/manager only', true,
    /role IN \('owner','manager'\)/.test(db.prepare(`SELECT sql FROM sqlite_master WHERE name='users'`).get().sql));

  console.log('== gerentes: separate people, hashed PINs, unique per sucursal ==');
  let r = await owner('POST', '/gerente-admin/gerentes', { name: 'Ana', pin: '1234', location_ids: [MTY] });
  chk('create Ana', 200, r.status);
  chk('PIN is not stored in clear', false, db.prepare('SELECT pin_hash h FROM gerentes').get().h.includes('1234'));
  r = await owner('POST', '/gerente-admin/gerentes', { name: 'Beto', pin: '1234', location_ids: [MTY] });
  chk('same PIN at same sucursal refused', 409, r.status);
  r = await owner('POST', '/gerente-admin/gerentes', { name: 'Beto', pin: '5678', location_ids: [MTY] });
  chk('create Beto', 200, r.status);
  r = await owner('POST', '/gerente-admin/gerentes', { name: 'Caro', pin: '1234', location_ids: [TRC] });
  chk('same PIN at another sucursal is fine', 200, r.status);
  r = await owner('POST', '/gerente-admin/gerentes', { name: 'X', pin: '12a4', location_ids: [MTY] });
  chk('PIN must be 4 digits', 400, r.status);
  const ana = db.prepare(`SELECT id FROM gerentes WHERE name='Ana'`).get().id;
  const beto = db.prepare(`SELECT id FROM gerentes WHERE name='Beto'`).get().id;
  chk('no user accounts were created for them', 1, db.prepare('SELECT COUNT(*) c FROM users').get().c);

  console.log('== tablet: nothing works until it is registered ==');
  const tablet = client();
  chk('boot says unregistered', false, (await tablet('GET', '/g/boot')).json.registered);
  chk('PIN refused without tablet', 401, (await tablet('POST', '/g/pin', { pin: '1234' })).status);
  await tablet('POST', '/login', { email: 'd@t.mx', password: 'password123' });
  chk('register', 200, (await tablet('POST', '/gerente-admin/tablets/register', { location_id: MTY, name: 'Caja' })).status);
  await tablet('POST', '/logout');
  const boot = (await tablet('GET', '/g/boot')).json;
  chk('boot now registered at MTY', MTY, boot.location && boot.location.id);
  chk('device token is stored hashed', false,
    db.prepare('SELECT token_hash h FROM tablets').get().h === tablet.jar.aldia_tablet);

  console.log('== the tablet can reach NOTHING else in the app ==');
  for (const p of ['/me', `/dashboard?location=${MTY}`, `/oneoff?location=${MTY}&start=2020-01-01&end=2030-01-01`,
                   '/loyalty/customers', '/gerente-admin/gerentes', '/gerente-admin/history']) {
    chk(`no access to ${p.split('?')[0]}`, 401, (await tablet('GET', p)).status);
  }

  console.log('== PIN ==');
  chk('wrong PIN', 401, (await tablet('POST', '/g/pin', { pin: '0000' })).status);
  r = await tablet('POST', '/g/pin', { pin: '1234' });
  chk('1234 on the MTY tablet is Ana, never TRC\'s Caro', 'Ana', r.json.gerente.name);
  const tokA = r.json.token;
  const tokB = (await tablet('POST', '/g/pin', { pin: '5678' })).json.token;
  const A = { 'X-Gerente': tokA }, Bh = { 'X-Gerente': tokB };
  chk('actions need a PIN session', 401, (await tablet('GET', '/g/expenses')).status);
  chk('forged token refused', 401,
    (await tablet('GET', '/g/expenses', null, { 'X-Gerente': tokA.slice(0, -3) + 'abc' })).status);
  for (let i = 0; i < 5; i++) await tablet('POST', '/g/pin', { pin: '0000' });
  chk('locked after 5 wrong tries', 429, (await tablet('POST', '/g/pin', { pin: '1234' })).status);

  console.log('== loyalty: scan, phone fallback, who did it ==');
  const loyalty = require('../src/loyalty/state');
  const cust = loyalty.createCustomer({ name: 'Cliente Uno', phone: '+52 871 184 0155', email: 'c@x.mx' });
  const freshCust = () => db.prepare('SELECT * FROM customers WHERE id = ?').get(cust.id);
  r = await tablet('POST', '/g/loyalty/lookup', { code: cust.code }, A);
  chk('lookup by QR code', 'Cliente Uno', r.json.customer.name);
  r = await tablet('POST', '/g/loyalty/lookup', { phone: '871-184-0155' }, A);
  chk('lookup by phone, any format', cust.code, r.json.customer && r.json.customer.code);
  chk('unknown phone', 404, (await tablet('POST', '/g/loyalty/lookup', { phone: '8110000000' }, A)).status);
  r = await tablet('POST', '/g/loyalty/visit', { code: cust.code }, A);
  chk('visit registered', true, r.json.ok);
  chk('visit carries the gerente', ana, db.prepare('SELECT gerente_id g FROM loyalty_visits').get().g);
  chk('visit carries the sucursal', MTY, db.prepare('SELECT location_id l FROM loyalty_visits').get().l);
  r = await tablet('POST', '/g/loyalty/visit', { code: cust.code }, Bh);
  chk('second stamp same day refused', 'already_today', r.json.reason);
  chk('still one visit', 1, db.prepare('SELECT COUNT(*) c FROM loyalty_visits').get().c);
  chk('nothing to redeem yet', 409, (await tablet('POST', '/g/loyalty/redeem', { code: cust.code }, A)).status);
  for (let i = 0; i < 4; i++) loyalty.addVisit(freshCust(), MTY, { override: true });
  r = await tablet('POST', '/g/loyalty/lookup', { code: cust.code }, A);
  chk('reward due at 5 visits', ['bebida'], r.json.customer.state.pending.map(p => p.name));
  r = await tablet('POST', '/g/loyalty/redeem',
    { code: cust.code, reward_id: r.json.customer.state.pending[0].reward_id }, Bh);
  chk('redeemed', 'bebida', r.json.redeemed);
  chk('redemption carries the gerente', beto, db.prepare('SELECT gerente_id g FROM loyalty_redemptions').get().g);

  console.log('== expenses: existing model, own + today only ==');
  const meta = (await tablet('GET', '/g/expenses', null, A)).json;
  chk('uses the sucursal categories', true, meta.categories.length > 0);
  chk('uses the sucursal accounts', true, meta.accounts.length > 0);
  r = await tablet('POST', '/g/expenses',
    { amount: 250.5, category_id: meta.categories[0].id, account_id: meta.accounts[0].id, note: 'Hielo' }, A);
  chk('expense saved', 200, r.status);
  const row = db.prepare('SELECT * FROM oneoff_costs WHERE id = ?').get(r.json.id);
  chk('lands in oneoff_costs for the tablet sucursal', [MTY, 250.5, 'Hielo'], [row.location_id, row.amount, row.description]);
  chk('with category, account and gerente', [meta.categories[0].id, meta.accounts[0].id, ana, 'Ana'],
    [row.category_id, row.account_id, row.gerente_id, row.logged_by]);
  chk('amount required', 400, (await tablet('POST', '/g/expenses', { amount: 0 }, A)).status);
  chk("another sucursal's category refused", 400, (await tablet('POST', '/g/expenses', { amount: 5,
    category_id: db.prepare('SELECT id FROM variable_cost_categories WHERE location_id = ?').get(TRC).id }, A)).status);
  chk("Beto does not see Ana's expense", 0, (await tablet('GET', '/g/expenses', null, Bh)).json.mine.length);
  chk('Beto cannot edit it', 403, (await tablet('PUT', `/g/expenses/${row.id}`, { amount: 1 }, Bh)).status);
  chk('Ana can', 200, (await tablet('PUT', `/g/expenses/${row.id}`, { amount: 300, note: 'Hielo x2' }, A)).status);
  const calc = require('../src/calc');
  chk('counts in the existing cost summary', true, calc.summary(MTY, meta.today, meta.today).costs.total >= 300);
  db.prepare(`UPDATE oneoff_costs SET date = '2020-01-01' WHERE id = ?`).run(row.id);
  chk('not editable once it is no longer today', 403, (await tablet('PUT', `/g/expenses/${row.id}`, { amount: 1 }, A)).status);

  console.log('== checklist: seed, start, resume, sync ==');
  const st = (await tablet('GET', '/g/checklist/today', null, A)).json;
  chk('cierre configured from the seed', true, st.cierre.configured);
  chk('apertura empty, waiting for the admin', false, st.apertura.configured);
  chk('empty apertura cannot be started', 409, (await tablet('POST', '/g/checklist/start', { type: 'apertura' }, A)).status);
  r = await tablet('POST', '/g/checklist/start', { type: 'cierre' }, A);
  const run = r.json.run;
  chk('11 sections', 11, run.sections.length);
  chk('79 items', 79, run.total);
  chk('warnings flagged', ['CUIDADO: No desconectar la comandera.', 'NO apagar la computadora.'],
    run.sections.flatMap(s => s.items).filter(i => i.warning).map(i => i.text));
  chk('GAS section carries its red note', true, /IMPORTANTE/.test(run.sections.find(s => s.title === 'GAS').note));
  chk('header note + footer come with the run', [true, true], [/completamente terminada/.test(run.header_note), /sin titubear/.test(run.footer_note)]);
  const items = run.sections.flatMap(s => s.items);
  const t0 = new Date(Date.now() - 60e3).toISOString();
  const first10 = items.slice(0, 10).map(i => ({ item_id: i.id, checked: true, at: t0 }));
  r = await tablet('POST', '/g/checklist/sync', { run_id: run.id, ops: first10 }, A);
  chk('10 ticked', 10, r.json.run.done);
  r = await tablet('POST', '/g/checklist/sync', { run_id: run.id, ops: first10 }, A);
  chk('re-sending the same queue changes nothing', 10, r.json.run.done);
  chk('timestamp is the tap time, not the sync time', t0, r.json.run.sections[0].items[0].checked_at);
  const later = new Date().toISOString();
  await tablet('POST', '/g/checklist/sync', { run_id: run.id, ops: [{ item_id: items[0].id, checked: false, at: later }] }, A);
  r = await tablet('POST', '/g/checklist/sync', { run_id: run.id, ops: [{ item_id: items[0].id, checked: true, at: t0 }] }, A);
  chk('a stale op never overrides a newer one', 9, r.json.run.done);
  r = await tablet('POST', '/g/checklist/start', { type: 'cierre' }, Bh);
  chk('a second gerente resumes the same run', [run.id, true, 9], [r.json.run.id, r.json.resumed, r.json.run.done]);
  chk('both gerentes recorded', ['Ana', 'Beto'], r.json.run.gerentes.map(g => g.name));
  chk('finish refused while items remain', 409, (await tablet('POST', '/g/checklist/finish', { run_id: run.id }, Bh)).status);

  console.log('== editing the template does not touch a run in progress ==');
  const tpl = (await owner('GET', `/gerente-admin/template?location=${MTY}&type=cierre`)).json;
  await owner('PUT', `/gerente-admin/items/${tpl.sections[0].items[0].id}`, { text: 'TEXTO CAMBIADO' });
  await owner('PUT', `/gerente-admin/sections/${tpl.sections[1].id}`, { active: false });
  await owner('POST', '/gerente-admin/items', { section_id: tpl.sections[0].id, text: 'Nueva actividad', warning: true });
  r = await tablet('POST', '/g/checklist/start', { type: 'cierre' }, A);
  chk('run still has its 79 original items', 79, r.json.run.total);
  chk('with the original wording', 'Apagar la barra caliente.', r.json.run.sections[0].items[0].text);
  const edited = (await owner('GET', `/gerente-admin/template?location=${MTY}&type=cierre`)).json;
  chk('template itself did change', 'TEXTO CAMBIADO', edited.sections[0].items[0].text);
  const ids = edited.sections.map(s => s.id).reverse();
  r = await owner('POST', '/gerente-admin/reorder', { kind: 'sections', ids });
  chk('sections reorder', ids, r.json.sections.map(s => s.id));
  chk('TRC template is separate and untouched', 'Apagar la barra caliente.',
    (await owner('GET', `/gerente-admin/template?location=${TRC}&type=cierre`)).json.sections[0].items[0].text);

  console.log('== bulk paste into a template ==');
  const ap = (await owner('GET', `/gerente-admin/template?location=${MTY}&type=apertura`)).json;
  let pre = (await owner('GET', `/gerente-admin/template/${ap.id}/import`)).json;
  chk('prepared apertura list is offered', true, pre.text.includes('# ABRIR EL LOCAL Y GAS'));
  let imp = (await owner('POST', `/gerente-admin/template/${ap.id}/import`, { text: pre.text, preview: true })).json;
  chk('preview counts but writes nothing', [33, 6, 0], [imp.actividades, imp.secciones_nuevas,
    (await owner('GET', `/gerente-admin/template?location=${MTY}&type=apertura`)).json.sections.length]);
  imp = (await owner('POST', `/gerente-admin/template/${ap.id}/import`, { text: pre.text })).json;
  chk('applied: 6 sections, 33 activities, in order', [6, 33, 'Retirar los candados de las rejas y abrir la puerta de cocina para comenzar labores.'],
    [imp.template.sections.length, imp.template.sections.reduce((n, s) => n + s.items.length, 0), imp.template.sections[0].items[0].text]);
  imp = (await owner('POST', `/gerente-admin/template/${ap.id}/import`, { text: pre.text })).json;
  chk('pasting twice adds nothing', [0, 33], [imp.actividades, imp.repetidas]);
  imp = (await owner('POST', `/gerente-admin/template/${ap.id}/import`, { text: '# barra caliente\n- [ ] Algo nuevo\n! Cuidado con esto' })).json;
  const bc = imp.template.sections.find(s => s.title === 'BARRA CALIENTE');
  chk('section matched ignoring case; bullets stripped; ! is a warning', [4, 'Algo nuevo', 1], [bc.items.length, bc.items[2].text, bc.items[3].warning]);
  const ci = (await owner('GET', `/gerente-admin/template?location=${TRC}&type=cierre`)).json;
  const ciBefore = ci.sections.length;
  pre = (await owner('GET', `/gerente-admin/template/${ci.id}/import`)).json;
  imp = (await owner('POST', `/gerente-admin/template/${ci.id}/import`, { text: pre.text })).json;
  chk('cierre additions land in the existing sections', [ciBefore, 8],
    [imp.template.sections.length, imp.actividades]);
  const lav = imp.template.sections.find(s => s.title === 'LAVADO Y LIMPIEZA');
  chk('appended at the end of the section', 'Dejar las mesas de trabajo y de barra limpias y listas para usarse el día siguiente.', lav.items[lav.items.length - 1].text);
  imp = (await owner('POST', `/gerente-admin/template/${ap.id}/import`, { text: '# NUEVA\nUna', replace: true })).json;
  chk('replace deactivates, never deletes', [6, 1], [imp.desactivadas, imp.template.sections.filter(s => s.active).length]);
  chk('tablet cannot import', 401, (await tablet('POST', `/gerente-admin/template/${ap.id}/import`, { text: '# X\ny' }, A)).status);

  console.log('== finish, then immutable ==');
  r = await tablet('POST', '/g/checklist/finish', { run_id: run.id, comments: 'Faltó pollo',
    ops: items.map(i => ({ item_id: i.id, checked: true, at: new Date().toISOString() })) }, Bh);
  chk('finished', ['completed', 79], [r.json.run.status, r.json.run.done]);
  chk('started by Ana, finished by Beto', ['Ana', 'Beto'], [r.json.run.started_by_name, r.json.run.finished_by_name]);
  const snap = () => JSON.stringify(db.prepare('SELECT * FROM checklist_run_items WHERE run_id = ? ORDER BY id').all(run.id));
  const frozen = snap();
  await tablet('POST', '/g/checklist/sync', { run_id: run.id, comments: 'cambiado después',
    ops: items.map(i => ({ item_id: i.id, checked: false, at: new Date(Date.now() + 1000).toISOString() })) }, A);
  chk('later ops cannot alter a finished record', true, frozen === snap());
  chk('nor its comments', 'Faltó pollo', db.prepare('SELECT comments c FROM checklist_runs WHERE id = ?').get(run.id).c);
  r = await tablet('POST', '/g/checklist/start', { type: 'cierre' }, A);
  chk('starting again today shows the finished one', 'completed', r.json.run.status);
  chk('one cierre per sucursal per day', 1, db.prepare(`SELECT COUNT(*) c FROM checklist_runs WHERE type='cierre'`).get().c);

  console.log('== history ==');
  r = await tablet('GET', '/g/checklist/history', null, A);
  chk('gerente sees it in the 7-day list', [run.id, 'Ana, Beto', 1], [r.json[0].id, r.json[0].gerentes, r.json[0].has_comments]);
  r = await owner('GET', `/gerente-admin/history?type=cierre&gerente=${beto}`);
  chk('admin filter by type + gerente', 1, r.json.length);
  chk('admin filter excludes others', 0, (await owner('GET', '/gerente-admin/history?type=apertura')).json.length);
  r = await owner('GET', `/gerente-admin/run/${run.id}`);
  chk('detail has per-item timestamps and who', true,
    r.json.sections.every(s => s.items.every(i => i.checked_at && i.checked_by_name)));
  db.prepare(`UPDATE checklist_runs SET business_date = '2026-01-05' WHERE id = ?`).run(run.id);
  chk('gerente cannot open a record older than 7 days', 404, (await tablet('GET', `/g/checklist/run/${run.id}`, null, A)).status);
  chk('admin still can', 200, (await owner('GET', `/gerente-admin/run/${run.id}`)).status);

  console.log('== missing-day flags ==');
  const cl = require('../src/gerente/checklists');
  const { addDays } = require('../src/lib/dates');
  const today = cl.businessDate();
  db.prepare('UPDATE checklist_runs SET business_date = ? WHERE id = ?').run(addDays(today, -3), run.id);
  r = await owner('GET', `/gerente-admin/missing?location=${MTY}`);
  chk('days after the first cierre with none are flagged', [addDays(today, -1), addDays(today, -2)], r.json.map(m => m.date));
  chk('apertura never used → never flagged', true, r.json.every(m => m.type === 'cierre'));
  db.prepare('INSERT INTO closed_days (location_id, date) VALUES (?,?)').run(MTY, addDays(today, -1));
  chk('a closed day is not flagged', [addDays(today, -2)],
    (await owner('GET', `/gerente-admin/missing?location=${MTY}`)).json.map(m => m.date));

  console.log('== business day: a cierre after midnight belongs to the day it closes ==');
  const at = h => Date.UTC(2026, 10, 10, h + 6, 0);            // local = UTC-6
  chk('23:00 → same day', '2026-11-10', cl.businessDate(at(23)));
  chk('01:30 next day → still the 10th', '2026-11-10', cl.businessDate(at(25) + 30 * 60e3));
  chk('05:00 → new day', '2026-11-11', cl.businessDate(at(29)));

  console.log('== revoking a tablet ==');
  await owner('DELETE', `/gerente-admin/tablets/${db.prepare('SELECT id FROM tablets').get().id}`);
  chk('revoked tablet is locked out', 401, (await tablet('GET', '/g/expenses', null, A)).status);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL GERENTE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
