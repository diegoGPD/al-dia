/* Captura de compras — the gerente's phone. Plain JS, no libraries.

   A purchase is written to the phone the moment it changes (draft) and again
   when it is saved (outbox), then sent in the background. A refresh, a dead
   battery or no signal never loses a capture; a retry never duplicates one,
   because every purchase carries an id made here. */
'use strict';
(() => {
  const app = document.getElementById('app');
  const M = window.InsumoMatch;
  const IDLE_MS = 5 * 60e3;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
  const numv = v => Number(String(v ?? '').replace(/[$,\s]/g, ''));
  const qty = n => String(Math.round(n * 1000) / 1000);
  const LS = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
  };
  const localToday = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);   // America/Monterrey
  const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2);

  let toastTimer = null;
  function toast(msg, bad) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, bad ? 5000 : 2600);
  }

  const S = { boot: null, session: null, loc: null, view: 'pin', cat: null, draft: null, sheet: null,
    online: navigator.onLine, lastActive: Date.now(), mine: [] };

  async function api(method, path, body, token) {
    let res;
    try {
      res = await fetch('/api' + path, { method, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Gerente': token || (S.session ? S.session.token : '') },
        body: body ? JSON.stringify(body) : undefined });
    } catch { setOnline(false); const e = new Error('Sin señal.'); e.offline = true; throw e; }
    setOnline(true);
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const e = new Error(data.error || 'Algo salió mal.'); e.status = res.status; e.code = data.code;
      if (res.status === 401 && data.code === 'pin' && !token && S.session) lock();
      if (res.status === 401 && data.code === 'device') { LS.del('c.boot'); S.boot = { mode: null }; S.session = null; go('noaccess'); }
      throw e;
    }
    return data;
  }
  function setOnline(v) {
    if (S.online === v) return;
    S.online = v;
    const d = document.querySelector('.dot'); if (d) d.className = 'dot' + (v ? '' : ' off');
    if (v) syncOutbox();
  }
  window.addEventListener('online', () => setOnline(true));
  window.addEventListener('offline', () => setOnline(false));

  // ------------------------------------------------------------ session ----
  function lock() { S.session = null; LS.del('c.session'); S.sheet = null; go('pin'); }
  let lastSaved = 0;
  function active() {
    S.lastActive = Date.now();
    if (S.session && S.lastActive - lastSaved > 15e3) { lastSaved = S.lastActive; LS.set('c.session', { ...S.session, last: S.lastActive }); }
  }
  ['pointerdown', 'keydown', 'input'].forEach(ev => document.addEventListener(ev, active, { passive: true }));
  setInterval(() => { if (S.session && Date.now() - S.lastActive > IDLE_MS) lock(); }, 5000);

  // -------------------------------------------------------------- storage --
  const draftKey = () => `c.draft.${S.loc}`;
  const blankDraft = () => ({ uid: uid(), editingId: null, fecha: localToday(), proveedor: '', account_id: LS.get('c.lastAccount.' + S.loc), foto: null, notas: '', lineas: [] });
  function saveDraft() {
    if (!LS.set(draftKey(), S.draft) && S.draft.foto) { S.draft.foto = null; LS.set(draftKey(), S.draft); toast('El teléfono no tiene espacio para la foto. La compra sí se guardó.', true); }
  }
  const outbox = () => LS.get('c.outbox', []);
  const setOutbox = list => LS.set('c.outbox', list);
  const catKey = () => `c.cat.${S.loc}`;
  function saveCat() { LS.set(catKey(), S.cat); }

  // A catalog from the server replaces the local one, except for insumos made
  // on this phone that the server hasn't heard of yet (still in the outbox).
  function adoptCatalog(fresh) {
    const temps = S.cat ? S.cat.insumos.filter(i => i.id < 0) : [];
    const byNorm = Object.fromEntries(fresh.insumos.map(i => [i.nombre_normalizado, i]));
    const remap = {};
    for (const t of temps) {
      const real = byNorm[t.nombre_normalizado];
      if (real) remap[t.id] = real; else fresh.insumos.push(t);
    }
    S.cat = fresh; S.mine = fresh.mias || [];
    if (S.draft) {
      for (const ln of S.draft.lineas) {
        if (remap[ln.insumo_id]) {
          const real = remap[ln.insumo_id];
          ln.insumo_id = real.id; delete ln.nuevo;
          if (ln.pres && !ln.pres.id) { const p = real.presentaciones.find(x => M.normalize(x.nombre) === M.normalize(ln.pres.nombre) && x.factor === ln.pres.factor); if (p) ln.pres = p; }
        }
      }
      saveDraft();
    }
    saveCat();
  }
  async function loadCatalog() {
    try { adoptCatalog(await api('GET', `/p/catalogo?location=${S.loc}`)); }
    catch (e) {
      if (!e.offline) throw e;
      S.cat = LS.get(catKey());              // no signal: work from what the phone already has
      if (!S.cat) throw e;
    }
  }

  // --------------------------------------------------------------- views ----
  function go(view) { S.view = view; render(); window.scrollTo(0, 0); }
  const VIEWS = {}, ACT = {}, AFTER = {};
  function header() {
    const locName = (S.boot.locations.find(l => l.id === S.loc) || {}).name || '';
    return `<div class="top"><span class="dot${S.online ? '' : ' off'}"></span>
      <div class="who"><b>${esc(S.session.name)}</b><span>${esc(locName)}</span></div>
      ${S.boot.locations.length > 1 ? '<button data-act="pickLoc">Sucursal</button>' : ''}
      <button data-act="lock">Salir</button></div>`;
  }
  function render() {
    const bare = ['pin', 'noaccess', 'dead', 'pickloc'].includes(S.view);
    app.innerHTML = (bare ? '' : header()) + VIEWS[S.view]() + (S.sheet ? sheetHtml() : '');
    if (S.sheet) afterSheet(); else if (AFTER[S.view]) AFTER[S.view]();
  }
  app.addEventListener('click', ev => {
    const el = ev.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = ACT[el.dataset.act]; if (fn) fn(el, ev);
  });
  ACT.lock = () => lock();
  ACT.reload = () => location.reload();

  VIEWS.dead = () => `<div class="center"><div class="note">Sin señal, y este teléfono aún no tiene datos guardados.</div>
    <p><button class="btn primary" data-act="reload">Reintentar</button></p></div>`;
  VIEWS.noaccess = () => `<div class="center"><div class="title">Este teléfono no tiene acceso</div>
    <div class="note">Pídele al administrador tu enlace personal y ábrelo en este teléfono.</div></div>`;

  // ---- PIN ----
  let pin = '';
  VIEWS.pin = () => `<div class="center">
      <div class="hint">${esc(S.boot.gerente ? S.boot.gerente.name : (S.boot.locations[0] || {}).name || '')}</div>
      <div class="title" style="margin-top:4px">Ingresa tu PIN</div>
      <div class="pin-dots">${[0, 1, 2, 3].map(i => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('')}</div>
      <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-act="digit" data-d="${n}">${n}</button>`).join('')}
        <span></span><button data-act="digit" data-d="0">0</button><button data-act="del">⌫</button></div>
      <div class="msg" id="pinMsg">${S.online ? '' : 'Sin señal. Se necesita internet para entrar.'}</div></div>`;
  const dots = () => document.querySelectorAll('.pin-dots i').forEach((d, i) => { d.className = i < pin.length ? 'on' : ''; });
  ACT.del = () => { pin = pin.slice(0, -1); dots(); };
  ACT.digit = async el => {
    if (pin.length >= 4) return;
    pin += el.dataset.d; dots();
    if (pin.length < 4) return;
    const tryPin = pin; pin = '';
    try {
      const r = await api('POST', S.boot.mode === 'tablet' ? '/g/pin' : '/p/pin', { pin: tryPin });
      S.session = { id: r.gerente.id, name: r.gerente.name, token: r.token };
      S.lastActive = Date.now(); LS.set('c.session', { ...S.session, last: S.lastActive });
      await enter();
    } catch (e) { dots(); const m = document.getElementById('pinMsg'); if (m) m.textContent = e.offline ? 'Sin señal. Se necesita internet para entrar.' : e.message; }
  };

  async function enter() {
    const saved = LS.get('c.loc');
    if (S.boot.locations.length === 1) S.loc = S.boot.locations[0].id;
    else if (S.boot.locations.some(l => l.id === saved)) S.loc = saved;
    else return go('pickloc');
    await openLoc();
  }
  async function openLoc() {
    LS.set('c.loc', S.loc);
    try { await loadCatalog(); } catch (e) { toast(e.message, true); return go('dead'); }
    S.draft = LS.get(draftKey()) || blankDraft();
    go('capture'); syncOutbox();
  }
  VIEWS.pickloc = () => `<div class="center"><div class="title">¿En qué sucursal estás?</div>
    <div style="display:grid;gap:10px;width:100%;max-width:340px">
      ${S.boot.locations.map(l => `<button class="btn" data-act="setLoc" data-id="${l.id}">${esc(l.name)}</button>`).join('')}</div></div>`;
  ACT.pickLoc = () => go('pickloc');
  ACT.setLoc = el => { S.loc = Number(el.dataset.id); openLoc(); };

  // ============================================================ CAPTURE ====
  const insumoOf = id => S.cat.insumos.find(i => i.id === id);
  const lineBase = ln => ln.cantidad * (ln.pres ? ln.pres.factor : 1);
  const lineCost = ln => ln.total / lineBase(ln);
  const draftTotal = () => S.draft.lineas.reduce((s, l) => s + l.total, 0);
  function lineText(ln) {
    const ins = insumoOf(ln.insumo_id) || { unidad_base: ln.unidad || '' };
    const u = ins.unidad_base;
    const what = ln.pres ? `${qty(ln.cantidad)} ${esc(ln.pres.nombre)} (${qty(lineBase(ln))} ${u})` : `${qty(ln.cantidad)} ${u}`;
    return `${what} · ${money(ln.total)} · <span class="unit">= ${money(lineCost(ln))}/${u}</span>`;
  }

  VIEWS.capture = () => {
    const d = S.draft, pend = outbox().filter(o => o.loc === S.loc).length;
    return `<main>
      ${d.editingId ? '<div class="card" style="background:var(--warn-bg)"><b>Corrigiendo una compra ya enviada.</b> <button class="btn small" data-act="cancelEdit" style="margin-top:8px">Cancelar corrección</button></div>' : ''}
      <div class="card">
        <div class="two">
          <div><label class="f" style="margin-top:0">Fecha</label>
            <input class="in" type="date" id="cFecha" value="${esc(d.fecha)}" max="${localToday()}" ${d.editingId ? 'disabled' : ''}></div>
          <div><label class="f" style="margin-top:0">Proveedor</label>
            <input class="in" id="cProv" list="provs" value="${esc(d.proveedor)}" placeholder="¿A quién?" autocomplete="off">
            <datalist id="provs">${S.cat.proveedores.map(p => `<option value="${esc(p.nombre)}">`).join('')}</datalist></div>
        </div>
        <label class="f">¿De dónde salió el dinero?</label>
        <div class="chips">${S.cat.cuentas.map(c => `<button class="chip ${d.account_id === c.id ? 'on' : ''}" data-act="acc" data-id="${c.id}">${esc(c.nombre)}</button>`).join('')}</div>
        <div class="two" style="margin-top:12px">
          <button class="btn small" data-act="photo">${d.foto ? '📎 Foto lista' : '📷 Foto del ticket'}</button>
          <button class="btn small" data-act="goMine">Mis compras de hoy${pend ? ` · ${pend} ⏳` : ''}</button>
        </div>
        <input type="file" id="cFile" accept="image/*" capture="environment" style="display:none">
      </div>
      <div class="card">
        <div class="title" style="font-size:18px">Productos</div>
        ${d.lineas.length ? d.lineas.map((ln, i) => `<div class="line">
            <button class="tap" data-act="editLine" data-i="${i}"><b>${esc((insumoOf(ln.insumo_id) || {}).nombre || ln.nombre || '')}</b><span class="hint">${lineText(ln)}</span></button>
            <button class="x" data-act="rmLine" data-i="${i}" aria-label="Quitar">✕</button></div>`).join('')
          : '<p class="hint">Toca “Agregar producto” para empezar.</p>'}
      </div>
    </main>
    <div class="bottom"><div class="inner">
      <button class="btn orange full" data-act="addLine">+ Agregar producto</button>
      <button class="btn primary full" data-act="saveCompra" ${d.lineas.length ? '' : 'disabled'}>${d.editingId ? 'Guardar corrección' : 'Guardar compra'}${d.lineas.length ? ' · ' + money(draftTotal()) : ''}</button>
    </div></div>`;
  };
  AFTER.capture = () => {
    const f = document.getElementById('cFecha'), p = document.getElementById('cProv'), file = document.getElementById('cFile');
    f.onchange = () => { S.draft.fecha = f.value || localToday(); saveDraft(); };
    p.oninput = () => { S.draft.proveedor = p.value; saveDraft(); };
    file.onchange = () => {
      const x = file.files && file.files[0]; if (!x) return;
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1280 / Math.max(img.width, img.height));
        const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        S.draft.foto = cv.toDataURL('image/jpeg', 0.7).split(',')[1];
        URL.revokeObjectURL(img.src); saveDraft(); render();
      };
      img.onerror = () => toast('No se pudo leer la foto.', true);
      img.src = URL.createObjectURL(x);
    };
  };
  ACT.acc = el => { const id = Number(el.dataset.id); S.draft.account_id = S.draft.account_id === id ? null : id; saveDraft(); render(); };
  ACT.photo = () => document.getElementById('cFile').click();
  ACT.rmLine = el => { S.draft.lineas.splice(Number(el.dataset.i), 1); saveDraft(); render(); };
  ACT.cancelEdit = () => { S.draft = blankDraft(); saveDraft(); render(); };

  // ---- the product sheet: search and create are ONE field -------------------
  ACT.addLine = () => { S.sheet = { step: 'search', q: '', editIndex: null }; render(); };
  ACT.editLine = el => {
    const i = Number(el.dataset.i), ln = S.draft.lineas[i];
    const insumo = insumoOf(ln.insumo_id) || { id: ln.insumo_id, nombre: ln.nombre, unidad_base: ln.unidad, presentaciones: ln.pres ? [ln.pres] : [] };
    S.sheet = { step: 'qty', editIndex: i, insumo, pres: ln.pres, otra: null, cantidad: String(ln.cantidad), total: String(ln.total) };
    render();
  };
  ACT.closeSheet = () => { S.sheet = null; render(); };

  const ago = d => {
    if (!d) return '';
    const n = Math.round((Date.parse(localToday()) - Date.parse(d)) / 864e5);
    return n <= 0 ? 'usado hoy' : n === 1 ? 'usado ayer' : `usado hace ${n} días`;
  };
  // Matches first (best first, then the ones this sucursal buys most); the
  // create option only ever comes after them, and not at all on an exact match.
  function search(q) {
    const list = S.cat.insumos;
    if (!M.normalize(q)) {
      const used = list.filter(i => i.uso > 0);
      return { rows: (used.length ? used : [...list].sort((a, b) => a.nombre.localeCompare(b.nombre))).slice(0, 12), create: false, frecuentes: used.length > 0 };
    }
    const norm = M.normalize(q);
    const rows = list.map(i => ({ i, s: M.score(q, i.nombre_normalizado) })).filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s || b.i.uso - a.i.uso).slice(0, 8).map(x => x.i);
    return { rows, create: !list.some(i => i.nombre_normalizado === norm), frecuentes: false };
  }
  function resultsHtml(q) {
    const r = search(q);
    return `${r.frecuentes ? '<div class="sub">Recientes y frecuentes</div>' : ''}
      ${r.rows.length || r.create ? `<div class="results">
        ${r.rows.map(i => `<button class="res" data-act="pickInsumo" data-id="${i.id}"><span class="grow">${esc(i.nombre)}</span>
          <span class="meta">${esc(i.unidad_base)}${i.ultimo_uso ? ' · ' + ago(i.ultimo_uso) : ''}</span></button>`).join('')}
        ${r.create ? `<button class="res create" data-act="startCreate">+ Crear “${esc(q.trim())}”</button>` : ''}
      </div>` : '<p class="hint" style="margin-top:14px">Escribe el nombre del producto.</p>'}`;
  }

  function sheetHtml() {
    const sh = S.sheet;
    if (sh.step === 'search') return `<div class="sheet"><div class="inner">
        <input class="in" id="sQ" placeholder="Buscar o crear producto…" value="${esc(sh.q)}" autocomplete="off" autocapitalize="sentences" enterkeyhint="search">
        <div id="sRes">${resultsHtml(sh.q)}</div>
      </div><div class="bottom"><div class="inner"><button class="btn full" data-act="closeSheet">Cancelar</button></div></div></div>`;

    if (sh.step === 'create') return `<div class="sheet"><div class="inner">
        <div class="title">Nuevo producto</div>
        <label class="f">Nombre</label><input class="in" id="nNombre" value="${esc(sh.nombre)}" autocomplete="off">
        <label class="f">Categoría</label>
        <div class="chips">${S.cat.categorias.map(c => `<button class="chip ${sh.categoria === c ? 'on' : ''}" data-act="nCat" data-v="${esc(c)}">${esc(c)}</button>`).join('')}</div>
        <label class="f">¿En qué se mide?</label>
        <div class="chips">${S.cat.unidades.map(u => `<button class="chip ${sh.unidad === u ? 'on' : ''}" data-act="nUni" data-v="${u}">${u}</button>`).join('')}</div>
      </div><div class="bottom"><div class="inner">
        <button class="btn primary full" data-act="createInsumo">Crear y continuar</button>
        <button class="btn full" data-act="backSearch">← Regresar</button></div></div></div>`;

    const ins = sh.insumo, u = ins.unidad_base;
    const isOtra = !!sh.otra;
    const sel = p => !isOtra && ((sh.pres === null && p === null) || (sh.pres && p && sh.pres.nombre === p.nombre && sh.pres.factor === p.factor));
    return `<div class="sheet"><div class="inner">
        <div class="title">${esc(ins.nombre)}</div>
        <label class="f">¿Cómo venía?</label>
        <div class="chips">
          <button class="chip ${sel(null) ? 'on' : ''}" data-act="pres" data-i="-1">Por ${u}</button>
          ${ins.presentaciones.map((p, i) => `<button class="chip ${sel(p) ? 'on' : ''}" data-act="pres" data-i="${i}">${esc(p.nombre)} · ${qty(p.factor)} ${u}</button>`).join('')}
          <button class="chip ${isOtra ? 'on' : ''}" data-act="presOtra">Otra…</button>
        </div>
        ${isOtra ? `<div class="two">
            <div><label class="f">Nombre</label><input class="in" id="oNombre" value="${esc(sh.otra.nombre)}" placeholder="Caja, bolsa, costal…" autocomplete="off"></div>
            <div><label class="f">¿Cuántos ${u} trae?</label><input class="in" id="oFactor" inputmode="decimal" value="${esc(sh.otra.factor)}" placeholder="10" autocomplete="off"></div>
          </div>` : ''}
        <div class="two">
          <div><label class="f">Cantidad</label><input class="in big" id="qCant" inputmode="decimal" value="${esc(sh.cantidad)}" placeholder="0" autocomplete="off"></div>
          <div><label class="f">Total pagado</label><input class="in big" id="qTotal" inputmode="decimal" value="${esc(sh.total)}" placeholder="$0" autocomplete="off"></div>
        </div>
        <div class="livecost" id="qLive"></div>
      </div><div class="bottom"><div class="inner">
        <button class="btn primary full" data-act="commitLine">${sh.editIndex !== null ? 'Guardar cambios' : 'Agregar a la compra'}</button>
        <button class="btn full" data-act="${sh.editIndex !== null ? 'closeSheet' : 'backSearch'}">${sh.editIndex !== null ? 'Cancelar' : '← Otro producto'}</button></div></div></div>`;
  }
  function sheetFactor() {
    const sh = S.sheet;
    if (sh.otra) return numv(sh.otra.factor);
    return sh.pres ? sh.pres.factor : 1;
  }
  // The gerente sees the unit cost of what they are typing, so a slipped digit shows.
  function drawLive() {
    const sh = S.sheet, el = document.getElementById('qLive'); if (!el) return;
    const c = numv(sh.cantidad), t = numv(sh.total), f = sheetFactor();
    el.textContent = c > 0 && t > 0 && f > 0 ? `= ${money(t / (c * f))} / ${sh.insumo.unidad_base}` : '';
  }
  function afterSheet() {
    const sh = S.sheet;
    if (sh.step === 'search') {
      const q = document.getElementById('sQ');
      q.focus(); q.setSelectionRange(q.value.length, q.value.length);
      q.oninput = () => { sh.q = q.value; document.getElementById('sRes').innerHTML = resultsHtml(sh.q); };
    } else if (sh.step === 'create') {
      const n = document.getElementById('nNombre'); n.oninput = () => { sh.nombre = n.value; };
    } else {
      const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.oninput = () => { fn(el.value); drawLive(); }; return el; };
      const c = bind('qCant', v => { sh.cantidad = v; }); bind('qTotal', v => { sh.total = v; });
      bind('oNombre', v => { sh.otra.nombre = v; }); bind('oFactor', v => { sh.otra.factor = v; });
      drawLive();
      if (!sh.cantidad && !sh.otra && c) c.focus();
    }
  }
  function openQty(insumo) {
    // The presentación learned most recently is the likeliest one again.
    const last = insumo.presentaciones[insumo.presentaciones.length - 1] || null;
    S.sheet = { step: 'qty', editIndex: null, insumo, pres: last, otra: null, cantidad: '', total: '' };
    render();
  }
  ACT.pickInsumo = el => openQty(insumoOf(Number(el.dataset.id)));
  ACT.backSearch = () => { S.sheet = { step: 'search', q: '', editIndex: null }; render(); };
  ACT.startCreate = () => {
    const q = S.sheet.q.trim().replace(/\s+/g, ' ');
    S.sheet = { step: 'create', nombre: q.charAt(0).toUpperCase() + q.slice(1), categoria: null, unidad: null, editIndex: null };
    render();
  };
  ACT.nCat = el => { S.sheet.categoria = el.dataset.v; render(); };
  ACT.nUni = el => { S.sheet.unidad = el.dataset.v; render(); };
  ACT.createInsumo = () => {
    const sh = S.sheet, nombre = String(sh.nombre || '').trim().replace(/\s+/g, ' '), norm = M.normalize(nombre);
    if (!norm) return toast('Escribe el nombre.', true);
    const existing = S.cat.insumos.find(i => i.nombre_normalizado === norm);
    if (existing) { toast(`Ya existe “${existing.nombre}” — usando ese.`); return openQty(existing); }
    if (!sh.categoria) return toast('Elige la categoría.', true);
    if (!sh.unidad) return toast('Elige en qué se mide.', true);
    // Lives on the phone with a temporary id until the purchase reaches the server.
    const tempId = -Date.now();
    const ins = { id: tempId, nombre, nombre_normalizado: norm, categoria: sh.categoria, unidad_base: sh.unidad, presentaciones: [], uso: 0, ultimo_uso: null };
    S.cat.insumos.push(ins); saveCat();
    openQty(ins);
  };
  ACT.pres = el => { const i = Number(el.dataset.i); S.sheet.otra = null; S.sheet.pres = i < 0 ? null : S.sheet.insumo.presentaciones[i]; render(); };
  ACT.presOtra = () => { S.sheet.otra = { nombre: '', factor: '' }; render(); const n = document.getElementById('oNombre'); if (n) n.focus(); };
  ACT.commitLine = () => {
    const sh = S.sheet, ins = sh.insumo;
    let pres = sh.pres;
    if (sh.otra) {
      const nombre = String(sh.otra.nombre || '').trim(), factor = numv(sh.otra.factor);
      if (!nombre) return toast('¿Cómo se llama la presentación?', true);
      if (!(factor > 0)) return toast(`¿Cuántos ${ins.unidad_base} trae?`, true);
      pres = ins.presentaciones.find(p => M.normalize(p.nombre) === M.normalize(nombre) && p.factor === factor);
      if (!pres) { pres = { nombre, factor }; ins.presentaciones.push(pres); saveCat(); }   // remembered for next time
    }
    const cantidad = numv(sh.cantidad), total = Math.round(numv(sh.total) * 100) / 100;
    if (!(cantidad > 0)) return toast('Escribe la cantidad.', true);
    if (!(total > 0)) return toast('Escribe el total pagado.', true);
    const ln = { insumo_id: ins.id, nombre: ins.nombre, unidad: ins.unidad_base, pres: pres ? { id: pres.id || null, nombre: pres.nombre, factor: pres.factor } : null, cantidad, total };
    if (ins.id < 0) ln.nuevo = { nombre: ins.nombre, categoria: ins.categoria, unidad_base: ins.unidad_base };
    if (sh.editIndex !== null) S.draft.lineas[sh.editIndex] = ln; else S.draft.lineas.push(ln);
    saveDraft();
    // Straight back to the search for the next product: capture is a loop.
    S.sheet = sh.editIndex !== null ? null : { step: 'search', q: '', editIndex: null };
    render();
    if (sh.editIndex === null) toast(`Agregado: ${ins.nombre}`);
  };

  // ---- save -----------------------------------------------------------------
  function payload(d) {
    return { client_uid: d.uid, location_id: S.loc, fecha: d.fecha, proveedor_nombre: d.proveedor.trim() || undefined,
      account_id: d.account_id || undefined, notas: d.notas || undefined, foto_base64: d.foto || undefined,
      lineas: d.lineas.map(ln => {
        const ins = insumoOf(ln.insumo_id);
        const o = { cantidad: ln.cantidad, total: ln.total };
        if (ln.insumo_id > 0) o.insumo_id = ln.insumo_id;
        else o.nuevo_insumo = ln.nuevo || { nombre: ins.nombre, categoria: ins.categoria, unidad_base: ins.unidad_base };
        if (ln.pres && ln.pres.id) o.presentacion_id = ln.pres.id;
        else if (ln.pres) o.nueva_presentacion = { nombre: ln.pres.nombre, factor: ln.pres.factor };
        return o;
      }) };
  }
  ACT.saveCompra = async el => {
    const d = S.draft;
    if (!d.lineas.length) return;
    el.disabled = true;
    if (d.account_id) LS.set('c.lastAccount.' + S.loc, d.account_id);
    if (d.editingId) {
      // Correcting something the server already has needs the server.
      try {
        const r = await api('PUT', `/p/compras/${d.editingId}`, payload(d));
        S.mine = r.mias; S.draft = blankDraft(); saveDraft(); toast('Compra corregida'); go('mine'); loadCatalog().catch(() => {});
      } catch (e) { el.disabled = false; toast(e.offline ? 'Sin señal. La corrección sigue aquí; vuelve a intentar cuando haya señal.' : e.message, true); }
      return;
    }
    // New purchase: into the outbox FIRST, then the draft is cleared, then it is sent.
    const list = outbox();
    list.push({ uid: d.uid, loc: S.loc, token: S.session.token, body: payload(d), total: draftTotal(), n: d.lineas.length, at: Date.now(), status: 'pending' });
    if (!setOutbox(list)) { el.disabled = false; return toast('El teléfono no tiene espacio para guardar la compra.', true); }
    const total = draftTotal();
    S.draft = blankDraft(); saveDraft(); render();
    const sent = await syncOutbox();
    toast(sent ? `Compra guardada · ${money(total)}` : 'Guardada en el teléfono. Se enviará sola cuando haya señal.');
    if (S.view === 'capture') render();
  };

  let syncing = null;
  function syncOutbox() {
    if (syncing) return syncing;
    syncing = (async () => {
      let allSent = true, any = false;
      for (const item of outbox()) {
        if (item.status === 'error') { allSent = false; continue; }
        let r = null;
        try { r = await api('POST', '/p/compras', item.body, item.token); }
        catch (e) {
          if (e.offline) { allSent = false; break; }
          // The session that captured it ran out: send it as whoever is signed in now.
          if (e.status === 401 && S.session && item.token !== S.session.token) {
            try { r = await api('POST', '/p/compras', item.body, S.session.token); } catch (e2) { if (e2.offline) { allSent = false; break; } e.message = e2.message; }
          }
          if (!r) {
            if (e.status === 401) { allSent = false; continue; }               // wait for a PIN, keep the capture
            setOutbox(outbox().map(o => o.uid === item.uid ? { ...o, status: 'error', error: e.message } : o));
            allSent = false; continue;
          }
        }
        setOutbox(outbox().filter(o => o.uid !== item.uid)); any = true;
        if (item.loc === S.loc && r.mias) S.mine = r.mias;
      }
      if (any && S.loc) { try { await loadCatalog(); } catch { /* next time */ } if (S.view === 'mine' || (S.view === 'capture' && !S.sheet)) render(); }
      return allSent;
    })().finally(() => { syncing = null; });
    return syncing;
  }
  setInterval(() => { if (S.session && outbox().some(o => o.status === 'pending')) syncOutbox(); }, 20e3);

  // ---- my captures of today -------------------------------------------------
  VIEWS.mine = () => {
    const pend = outbox().filter(o => o.loc === S.loc);
    return `<main>
      <button class="btn small" data-act="goCapture" style="margin-bottom:12px">← Capturar</button>
      ${pend.length ? `<div class="card"><div class="title" style="font-size:18px">En este teléfono, por enviar</div>
        ${pend.map(o => `<div class="line"><div class="grow"><b>${money(o.total)} · ${o.n} producto${o.n === 1 ? '' : 's'}</b>
            ${o.status === 'error' ? `<span class="pill bad">No se pudo enviar</span><div class="hint">${esc(o.error || '')}</div>`
              : '<span class="pill warn">⏳ esperando señal</span>'}</div>
          ${o.status === 'error' ? `<button class="btn small" data-act="retry" data-uid="${esc(o.uid)}">Reintentar</button><button class="x" data-act="discard" data-uid="${esc(o.uid)}">✕</button>` : ''}</div>`).join('')}</div>` : ''}
      <div class="card"><div class="title" style="font-size:18px">Mis compras de hoy</div>
        ${S.mine.length ? S.mine.map(c => `<div class="line"><div class="grow"><b>${money(c.total)}${c.proveedor ? ' · ' + esc(c.proveedor) : ''}</b>
            <span class="hint">${c.lineas.map(l => esc(l.insumo)).join(', ')}${c.cuenta ? ' · ' + esc(c.cuenta) : ''}${c.tiene_foto ? ' · 📎' : ''}</span></div>
          <button class="btn small" data-act="editCompra" data-id="${c.id}">Corregir</button></div>`).join('')
          : '<p class="hint">Aún no has enviado compras hoy.</p>'}</div></main>`;
  };
  // Refresh the list from the server on the way in; offline it shows what the phone has.
  ACT.goMine = async () => { try { await loadCatalog(); } catch { /* offline */ } go('mine'); };
  ACT.goCapture = () => go('capture');
  ACT.retry = el => { setOutbox(outbox().map(o => o.uid === el.dataset.uid ? { ...o, status: 'pending', error: null } : o)); render(); syncOutbox().then(() => render()); };
  ACT.discard = el => {
    if (el.dataset.sure !== '1') { el.dataset.sure = '1'; el.textContent = '¿Borrar?'; el.style.width = 'auto'; return; }
    setOutbox(outbox().filter(o => o.uid !== el.dataset.uid)); render();
  };
  ACT.editCompra = el => {
    const c = S.mine.find(x => x.id === Number(el.dataset.id)); if (!c) return;
    S.draft = { uid: uid(), editingId: c.id, fecha: c.fecha, proveedor: c.proveedor || '', account_id: c.account_id, foto: null, notas: c.notas || '',
      lineas: c.lineas.map(l => ({ insumo_id: l.insumo_id, nombre: l.insumo, unidad: l.unidad, cantidad: l.cantidad, total: l.total,
        pres: l.presentacion_nombre ? { id: l.presentacion_id, nombre: l.presentacion_nombre, factor: l.factor } : null })) };
    saveDraft(); go('capture');
  };

  // ---------------------------------------------------------------- boot ----
  async function start() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/compra/sw.js', { scope: '/compra/' }).catch(() => {});
    // First visit from the personal link: trade the key in the URL for a device
    // cookie, then drop it from the address bar and history.
    const k = new URLSearchParams(location.search).get('k');
    if (k) {
      try { await api('POST', '/p/activate', { k }); } catch (e) { if (!e.offline) toast(e.message, true); }
      try { history.replaceState(null, '', '/compra/'); } catch { /* ignore */ }
    }
    try { S.boot = await api('GET', '/p/boot'); if (S.boot.mode) LS.set('c.boot', S.boot); else LS.del('c.boot'); }
    catch { S.boot = LS.get('c.boot'); }
    if (!S.boot) return go('dead');
    if (!S.boot.mode) return go('noaccess');
    const saved = LS.get('c.session');
    if (saved && saved.token && Date.now() - (saved.last || 0) < IDLE_MS) {
      S.session = { id: saved.id, name: saved.name, token: saved.token }; S.lastActive = Date.now();
      await enter();
    } else { LS.del('c.session'); go('pin'); }
  }
  start();
})();
