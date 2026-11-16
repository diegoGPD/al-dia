/* Vista de Gerente — shared tablet. Plain JS, no libraries, one file.
   The gerente can do three things here and nothing else: scan loyalty cards,
   log an expense, run the apertura / cierre checklist.

   Checklist progress is written to the tablet on EVERY tap and sent to the
   server in the background, so a refresh, a dead battery or a wifi drop never
   loses a half-finished checklist. */
'use strict';
(() => {
  const app = document.getElementById('app');
  const IDLE_MS = 5 * 60e3;
  const TZ_OFFSET_H = -6;                       // America/Monterrey, no DST

  // ------------------------------------------------------------ helpers ----
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(n) || 0);
  const hhmm = iso => iso ? new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '';
  const dayLabel = d => new Date(d + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
  const LS = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
    keys(prefix) { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(prefix)) out.push(k); } } catch { /* ignore */ } return out; }
  };
  // Same rule as the server: before 5 am still belongs to yesterday's shift.
  function businessDate() {
    const local = new Date(Date.now() + TZ_OFFSET_H * 3600e3);
    if (local.getUTCHours() < 5) local.setUTCDate(local.getUTCDate() - 1);
    return local.toISOString().slice(0, 10);
  }

  let toastTimer = null;
  function toast(msg, bad) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, bad ? 5000 : 2800);
  }

  const S = { boot: null, session: null, view: 'home', p: {}, online: navigator.onLine, lastActive: Date.now(), returnTo: null };

  async function api(method, path, body, token) {
    let res;
    try {
      res = await fetch('/api' + path, {
        method, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Gerente': token || (S.session ? S.session.token : '') },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch {
      setOnline(false);
      const e = new Error('Sin conexión.'); e.offline = true; throw e;
    }
    setOnline(true);
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const e = new Error(data.error || 'Algo salió mal.'); e.status = res.status; e.code = data.code; e.data = data;
      // PIN session gone (expired, gerente deactivated) → back to the PIN pad.
      if (res.status === 401 && data.code === 'pin' && !token && S.session) lock(true);
      if (res.status === 401 && data.code === 'tablet') { LS.del('g.boot'); location.reload(); }
      throw e;
    }
    return data;
  }

  function setOnline(v) {
    if (S.online === v) return;
    S.online = v;
    const d = document.querySelector('.dot'); if (d) d.className = 'dot' + (v ? '' : ' off');
    if (v) syncAll();
  }
  window.addEventListener('online', () => setOnline(true));
  window.addEventListener('offline', () => setOnline(false));

  // ------------------------------------------------------------ session ----
  function saveSession() { if (S.session) LS.set('g.session', { ...S.session, last: S.lastActive }); }
  function lock(keepPlace) {
    stopCamera();
    S.returnTo = keepPlace && S.view !== 'pin' ? { view: S.view, p: S.p } : null;
    S.session = null; LS.del('g.session');
    go('pin');
  }
  let lastSaved = 0;
  function active() {
    S.lastActive = Date.now();
    if (S.session && S.lastActive - lastSaved > 15e3) { lastSaved = S.lastActive; saveSession(); }
  }
  ['pointerdown', 'keydown', 'input'].forEach(ev => document.addEventListener(ev, active, { passive: true }));
  setInterval(() => { if (S.session && Date.now() - S.lastActive > IDLE_MS) lock(true); }, 5000);

  // --------------------------------------------------------------- views ----
  function go(view, p = {}) {
    if (S.view === 'scan' && view !== 'scan') stopCamera();
    S.view = view; S.p = p; render();
    window.scrollTo(0, 0);
  }

  function header() {
    return `<div class="top">
      <span class="dot${S.online ? '' : ' off'}" title="Conexión"></span>
      <div class="who"><b>${esc(S.session.name)}</b><span>${esc(S.boot.location.name)}</span></div>
      <button data-act="switch">Cambiar gerente</button>
    </div>`;
  }
  const backBtn = (label = '← Inicio', act = 'home') => `<button class="btn small back" data-act="${act}">${label}</button>`;

  function render() {
    const v = VIEWS[S.view] || VIEWS.home;
    if (S.view === 'pin' || S.view === 'setup' || S.view === 'dead') { app.innerHTML = v(); }
    else { app.innerHTML = header() + `<main>${v()}</main>`; }
    if (AFTER[S.view]) AFTER[S.view]();
  }

  const VIEWS = {};
  const AFTER = {};
  const ACT = {};

  app.addEventListener('click', ev => {
    const el = ev.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = ACT[el.dataset.act];
    if (fn) fn(el, ev);
  });

  ACT.home = () => go('home');
  ACT.switch = () => lock(false);

  // ---- dead end / setup ---------------------------------------------------
  VIEWS.dead = () => `<div class="center-screen"><div class="big-note">No hay conexión y esta tablet aún no tiene datos guardados.</div>
    <p><button class="btn primary" data-act="reload">Reintentar</button></p></div>`;
  ACT.reload = () => location.reload();

  // One-time: the owner signs in here to tie this tablet to a sucursal. Their
  // session is closed again immediately; only the device registration stays.
  VIEWS.setup = () => `<div class="center-screen"><div class="pin-wrap" style="text-align:left">
      <div class="title">Registrar esta tablet</div>
      <p class="hint">Solo una vez. El administrador inicia sesión para ligar la tablet a una sucursal; después solo se usa con el PIN de cada gerente.</p>
      ${S.p.locations ? `
        <label class="f">Sucursal</label>
        <select class="in" id="suLoc">${S.p.locations.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>
        <label class="f">Nombre de la tablet</label>
        <input class="in" id="suName" value="Tablet de caja">
        <p><button class="btn primary full" data-act="register">Registrar tablet</button></p>` : `
        <label class="f">Correo del administrador</label>
        <input class="in" id="suEmail" type="email" autocomplete="username">
        <label class="f">Contraseña</label>
        <input class="in" id="suPass" type="password" autocomplete="current-password">
        <p><button class="btn primary full" data-act="ownerLogin">Continuar</button></p>`}
    </div></div>`;
  ACT.ownerLogin = async () => {
    try {
      await api('POST', '/login', { email: document.getElementById('suEmail').value, password: document.getElementById('suPass').value });
      const me = await api('GET', '/me');
      if (me.user.role !== 'owner') { await api('POST', '/logout'); return toast('Solo el administrador puede registrar la tablet.', true); }
      go('setup', { locations: me.locations });
    } catch (e) { toast(e.status === 401 ? 'Correo o contraseña incorrectos.' : e.message, true); }
  };
  ACT.register = async () => {
    try {
      await api('POST', '/gerente-admin/tablets/register',
        { location_id: Number(document.getElementById('suLoc').value), name: document.getElementById('suName').value });
      await api('POST', '/logout');
      location.reload();
    } catch (e) { toast(e.message, true); }
  };

  // ---- PIN ----------------------------------------------------------------
  let pin = '';
  VIEWS.pin = () => `<div class="center-screen"><div class="pin-wrap">
      <div class="hint">${esc(S.boot.location.name)}</div>
      <div class="title" style="margin-top:6px">Ingresa tu PIN</div>
      <div class="pin-dots">${[0, 1, 2, 3].map(i => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('')}</div>
      <div class="pad">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-act="digit" data-d="${n}">${n}</button>`).join('')}
        <span></span><button data-act="digit" data-d="0">0</button><button data-act="del" aria-label="Borrar">⌫</button>
      </div>
      <div class="pin-msg" id="pinMsg">${S.online ? '' : 'Sin conexión. Se necesita internet para entrar.'}</div>
    </div></div>`;
  const drawDots = () => document.querySelectorAll('.pin-dots i').forEach((d, i) => { d.className = i < pin.length ? 'on' : ''; });
  ACT.del = () => { pin = pin.slice(0, -1); drawDots(); };
  ACT.digit = async el => {
    if (pin.length >= 4) return;
    pin += el.dataset.d; drawDots();
    if (pin.length < 4) return;
    const tryPin = pin; pin = '';
    const msg = document.getElementById('pinMsg');
    try {
      const r = await api('POST', '/g/pin', { pin: tryPin });
      S.session = { id: r.gerente.id, name: r.gerente.name, token: r.token };
      S.lastActive = Date.now(); saveSession();
      const back = S.returnTo; S.returnTo = null;
      if (back && back.view === 'checklist') openChecklist(back.p.type);
      else go('home');
      syncAll();
    } catch (e) {
      drawDots();
      if (msg) msg.textContent = e.offline ? 'Sin conexión. Se necesita internet para entrar.' : e.message;
    }
  };

  // ---- home ---------------------------------------------------------------
  VIEWS.home = () => {
    const pend = pendingOps();
    return `<div class="home">
      <button class="b1" data-act="goScan"><span class="ico">📷</span>Escanear tarjeta</button>
      <button class="b2" data-act="goExpense"><span class="ico">💵</span>Agregar gasto</button>
      <button class="b3" data-act="goChecklists"><span class="ico">✅</span>Apertura / Cierre</button>
    </div>
    ${pend ? `<p class="sync pending" style="margin-top:14px">${pend} marcas del checklist guardadas en la tablet, pendientes de enviar. Se envían solas al volver el wifi.</p>` : ''}`;
  };
  ACT.goScan = () => go('scan');
  ACT.goExpense = () => go('expense');
  ACT.goChecklists = () => go('checklists');

  // =========================================================== 1. SCAN =====
  let stream = null, scanning = false, lastHit = { code: '', at: 0 }, detector = null, autoBack = null;
  function stopCamera() {
    scanning = false; clearTimeout(autoBack);
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  }
  async function getDecoder(canvas) {
    if (detector) return detector;
    if ('BarcodeDetector' in window) {
      try {
        if ((await window.BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
          const d = new window.BarcodeDetector({ formats: ['qr_code'] });
          detector = async cv => { const f = await d.detect(cv); return f.length ? f[0].rawValue : null; };
          return detector;
        }
      } catch { /* fall through */ }
    }
    // Local copy — the scanner must not depend on a CDN being reachable.
    if (!window.jsQR) await new Promise((ok, bad) => {
      const s = document.createElement('script'); s.src = '/gerente/jsQR.js';
      s.onload = ok; s.onerror = () => bad(new Error('decoder')); document.head.appendChild(s);
    });
    detector = async (cv, opts) => {
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      const img = ctx.getImageData(0, 0, cv.width, cv.height);
      const hit = window.jsQR(img.data, img.width, img.height, { inversionAttempts: opts && opts.invert ? 'attemptBoth' : 'dontInvert' });
      return hit && hit.data ? hit.data : null;
    };
    return detector;
  }
  function camError(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'La cámara no tiene permiso. Toca el candado 🔒 en la barra de direcciones, permite la cámara y recarga.';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No se encontró ninguna cámara en esta tablet.';
    if (n === 'NotReadableError') return 'La cámara está ocupada por otra app. Ciérrala y vuelve a intentar.';
    if (e && e.message === 'decoder') return 'No se pudo cargar el lector de QR.';
    return 'No se pudo abrir la cámara.';
  }

  VIEWS.scan = () => {
    const c = S.p.customer;
    if (c) return backBtn() + customerCard(c);
    return `${backBtn()}
      <div class="card">
        <div class="title">Escanear tarjeta</div>
        ${S.p.msg ? `<div class="banner ${S.p.msg.kind}">${esc(S.p.msg.text)}</div>` : ''}
        <div style="position:relative"><video class="cam" id="cam" playsinline muted autoplay></video></div>
        <canvas id="camCanvas" style="display:none"></canvas>
        <p class="hint" id="camStatus">Abriendo cámara…</p>
      </div>
      <div class="card">
        <label class="f" style="margin-top:0">¿No funciona la cámara? Busca por teléfono</label>
        <div class="row">
          <input class="in" id="phone" type="tel" inputmode="tel" placeholder="871 123 4567" style="flex:2">
          <button class="btn primary" data-act="findPhone">Buscar</button>
        </div>
        <div id="matches">${(S.p.matches || []).map(m => `
          <div class="list-item"><div class="grow"><b>${esc(m.name)}</b><div class="hint">${esc(m.phone)}</div></div>
            <button class="btn small" data-act="pick" data-code="${esc(m.code)}">Elegir</button></div>`).join('')}</div>
      </div>`;
  };

  function customerCard(c) {
    const s = c.state, r = S.p.result;
    const prize = new Set(s.rewards.map(x => x.milestone));
    const dots = Array.from({ length: s.stampsNeeded }, (_, i) =>
      `<i class="${prize.has(i + 1) ? 'prize ' : ''}${i < s.stamps ? 'on' : ''}"></i>`).join('');
    let banner = '';
    if (r && r.kind === 'visit') banner = r.earned.length
      ? `<div class="banner ok">🎁 ¡Visita registrada! Ganó: ${esc(r.earned.join(' y '))}<small>Entrégale su recompensa y toca “Canjear”.</small></div>`
      : `<div class="banner ok">✓ Visita registrada</div>`;
    else if (r && r.kind === 'dup') banner = `<div class="banner warn">Esta tarjeta ya tiene su visita de hoy<small>Solo se registra una visita por día.</small></div>`;
    else if (r && r.kind === 'redeem') banner = `<div class="banner ok">🎉 Recompensa canjeada: ${esc(r.name)}</div>`;
    else if (r && r.kind === 'err') banner = `<div class="banner bad">${esc(r.text)}</div>`;
    const due = s.pending.length
      ? `<div class="banner warn">🎁 Recompensa pendiente: ${esc(s.pending.map(p => p.name).join(' y '))}</div>`
      : `<p class="hint">${s.nextReward ? `Le faltan ${s.toNext} visita${s.toNext === 1 ? '' : 's'} para su ${esc(s.nextReward.name)}.` : 'Tarjeta completa.'}</p>`;
    const canVisit = !c.stampedToday && !(r && (r.kind === 'visit' || r.kind === 'dup'));
    return `<div class="card">
      ${banner}
      <div class="title">${esc(c.name)}</div>
      <div><b style="font-size:22px">Visitas: ${String(s.stamps).padStart(2, '0')} / ${s.stampsNeeded}</b></div>
      <div class="stamps">${dots}</div>
      ${due}
      ${canVisit ? `<p><button class="btn primary full" data-act="visit" data-code="${esc(c.code)}">Registrar visita</button></p>`
        : (!r || r.kind === 'redeem' || r.kind === 'err') && c.stampedToday ? '<p class="hint">Ya tiene su visita de hoy.</p>' : ''}
      ${s.pending.map(p => `<p><button class="btn orange full" data-act="redeem" data-code="${esc(c.code)}" data-reward="${p.reward_id}">Canjear recompensa: ${esc(p.name)}</button></p>`).join('')}
      <p><button class="btn full" data-act="nextCustomer">Siguiente cliente</button></p>
    </div>`;
  }

  AFTER.scan = async () => {
    if (S.p.customer) return;
    const video = document.getElementById('cam'), canvas = document.getElementById('camCanvas'), status = document.getElementById('camStatus');
    stopCamera();
    try {
      stream = await navigator.mediaDevices.getUserMedia(window.QREnhance.constraints());
      if (S.view !== 'scan' || S.p.customer) return stopCamera();
      video.srcObject = stream; await video.play();
      await window.QREnhance.tune(stream.getVideoTracks()[0]);
      window.QREnhance.overlay(video.parentElement);
      const decode = await getDecoder(canvas);
      status.textContent = 'Apunta la cámara al código QR del cliente.';
      scanning = true;
      const tick = async () => {
        if (!scanning) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth) {
          let found = null; try { found = await window.QREnhance.decodeFrame(video, decode); } catch { /* keep going */ }
          if (found) {
            const code = String(found).trim().toUpperCase(), now = Date.now();
            // The same card held in front of the lens is one scan, not twenty.
            if (!(code === lastHit.code && now - lastHit.at < 8000)) { lastHit = { code, at: now }; scanning = false; return lookup({ code }); }
          }
        }
        setTimeout(tick, 180);                  // ~5 fps is plenty and keeps a cheap tablet cool
      };
      tick();
    } catch (e) { if (status) status.innerHTML = `<b style="color:var(--red)">${esc(camError(e))}</b> Usa la búsqueda por teléfono.`; }
  };

  async function lookup(q) {
    try {
      const r = await api('POST', '/g/loyalty/lookup', q);
      if (r.matches) return go('scan', { matches: r.matches });
      stopCamera(); go('scan', { customer: r.customer });
    } catch (e) { go('scan', { msg: { kind: 'bad', text: e.message } }); }
  }
  ACT.findPhone = () => { const v = document.getElementById('phone').value; if (v.trim()) lookup({ phone: v }); };
  ACT.pick = el => lookup({ code: el.dataset.code });
  ACT.nextCustomer = () => go('scan');
  ACT.visit = async el => {
    el.disabled = true;
    try {
      const r = await api('POST', '/g/loyalty/visit', { code: el.dataset.code });
      go('scan', { customer: r.customer, result: r.ok ? { kind: 'visit', earned: r.justEarned } : { kind: 'dup' } });
      // Nothing left to do for this customer → back to the camera on its own.
      if (!r.customer.state.pending.length) autoBack = setTimeout(() => { if (S.view === 'scan' && S.p.customer) go('scan'); }, 5000);
    } catch (e) { go('scan', { customer: S.p.customer, result: { kind: 'err', text: e.message } }); }
  };
  ACT.redeem = async el => {
    el.disabled = true;
    try {
      const r = await api('POST', '/g/loyalty/redeem', { code: el.dataset.code, reward_id: Number(el.dataset.reward) });
      go('scan', { customer: r.customer, result: { kind: 'redeem', name: r.redeemed } });
    } catch (e) { go('scan', { customer: S.p.customer, result: { kind: 'err', text: e.message } }); }
  };

  // ======================================================== 2. EXPENSE =====
  let exp = null;                               // form state survives re-renders
  const blankExp = () => ({ id: null, amount: '', category_id: null, account_id: null, note: '', photo: null });
  VIEWS.expense = () => {
    const m = S.p.meta;
    if (!m) return backBtn() + '<div class="card"><div class="big-note">Cargando…</div></div>';
    if (!exp) exp = blankExp();
    return `${backBtn()}
      <div class="card">
        <div class="title">${exp.id ? 'Editar gasto' : 'Agregar gasto'}</div>
        <input class="in amount" id="xAmount" type="text" inputmode="decimal" placeholder="$0.00" value="${esc(exp.amount)}" autocomplete="off">
        <label class="f">Categoría</label>
        <div class="chips">
          ${m.categories.map(c => `<button class="chip ${exp.category_id === c.id ? 'on' : ''}" data-act="xCat" data-id="${c.id}">${esc(c.name)}</button>`).join('')}
          <button class="chip ${exp.category_id === 0 ? 'on' : ''}" data-act="xCat" data-id="0">Otro gasto</button>
        </div>
        <label class="f">¿De dónde salió el dinero?</label>
        <div class="chips">${m.accounts.map(a => `<button class="chip ${exp.account_id === a.id ? 'on' : ''}" data-act="xAcc" data-id="${a.id}">${esc(a.name)}</button>`).join('')}</div>
        <label class="f">Nota (opcional)</label>
        <input class="in" id="xNote" value="${esc(exp.note)}" placeholder="¿Qué se compró?" autocomplete="off">
        <label class="f">Foto del ticket (opcional)</label>
        <div class="row">
          <button class="btn" data-act="xPhoto">${exp.photo ? '📎 Foto lista — cambiar' : '📷 Tomar foto'}</button>
          ${exp.photo ? '<button class="btn" data-act="xNoPhoto">Quitar foto</button>' : ''}
        </div>
        <input type="file" id="xFile" accept="image/*" capture="environment" style="display:none">
        <p style="margin-top:18px"><button class="btn primary full" data-act="xSave">${exp.id ? 'Guardar cambios' : 'Guardar gasto'}</button></p>
        ${exp.id ? '<p><button class="btn full" data-act="xCancel">Cancelar edición</button></p>' : ''}
      </div>
      <div class="card">
        <div class="title" style="font-size:20px">Mis gastos de hoy</div>
        ${m.mine.length ? m.mine.map(x => `<div class="list-item">
            <div class="grow"><b>${money(x.amount)}</b> ${x.has_receipt ? '📎' : ''}
              <div class="hint">${esc(x.category_name || 'Otro gasto')}${x.account_name ? ' · ' + esc(x.account_name) : ''}${x.description && x.description !== x.category_name ? ' · ' + esc(x.description) : ''}</div></div>
            <button class="btn small" data-act="xEdit" data-id="${x.id}">Editar</button></div>`).join('')
          : '<p class="hint">Todavía no registras gastos hoy.</p>'}
      </div>`;
  };
  AFTER.expense = async () => {
    if (!S.p.meta) {
      try { const meta = await api('GET', '/g/expenses'); if (S.view === 'expense') go('expense', { meta }); }
      catch (e) { toast(e.offline ? 'Sin conexión. Para registrar gastos se necesita internet.' : e.message, true); }
      return;
    }
    const a = document.getElementById('xAmount'), n = document.getElementById('xNote'), f = document.getElementById('xFile');
    a.oninput = () => { exp.amount = a.value; };
    n.oninput = () => { exp.note = n.value; };
    if (!exp.id && !exp.amount) a.focus();
    // Shrink the photo on the tablet: a 12 MP ticket is 4 MB, this is ~150 KB.
    f.onchange = () => {
      const file = f.files && f.files[0]; if (!file) return;
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1280 / Math.max(img.width, img.height));
        const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        exp.photo = cv.toDataURL('image/jpeg', 0.7).split(',')[1];
        URL.revokeObjectURL(img.src); render();
      };
      img.onerror = () => toast('No se pudo leer la foto.', true);
      img.src = URL.createObjectURL(file);
    };
  };
  ACT.xCat = el => { exp.category_id = Number(el.dataset.id); render(); };
  ACT.xAcc = el => { const id = Number(el.dataset.id); exp.account_id = exp.account_id === id ? null : id; render(); };
  ACT.xPhoto = () => document.getElementById('xFile').click();
  ACT.xNoPhoto = () => { exp.photo = null; render(); };
  ACT.xCancel = () => { exp = blankExp(); render(); };
  ACT.xEdit = el => {
    const x = S.p.meta.mine.find(m => m.id === Number(el.dataset.id)); if (!x) return;
    exp = { id: x.id, amount: String(x.amount), category_id: x.category_id || 0, account_id: x.account_id || null,
      note: x.description && x.description !== x.category_name && x.description !== 'Otro gasto' ? x.description : '', photo: null };
    render(); window.scrollTo(0, 0);
  };
  ACT.xSave = async el => {
    const amount = Number(String(exp.amount).replace(/[$,\s]/g, ''));
    if (!(amount > 0)) return toast('Escribe el monto.', true);
    if (exp.category_id === null) return toast('Elige una categoría.', true);
    el.disabled = true;
    const body = { amount, category_id: exp.category_id || null, account_id: exp.account_id, note: exp.note, receipt_base64: exp.photo || undefined };
    try {
      const r = exp.id ? await api('PUT', `/g/expenses/${exp.id}`, body) : await api('POST', '/g/expenses', body);
      toast(exp.id ? 'Gasto actualizado' : `Gasto guardado: ${money(amount)}`);
      exp = blankExp(); S.p.meta.mine = r.mine; render();
    } catch (e) {
      el.disabled = false;
      // The form stays exactly as typed — nothing is lost, it just isn't saved yet.
      toast(e.offline ? 'Sin conexión: el gasto AÚN NO se guardó. Vuelve a tocar Guardar cuando regrese el wifi.' : e.message, true);
    }
  };

  // ====================================================== 3. CHECKLIST =====
  // Local copy of a run:  g.cl.<runId> = { run, local:{itemId:{checked,at}}, queue:[op], comments, dirty, open }
  // "queue" is everything not yet confirmed by the server. Each op remembers
  // the PIN session that made it, so a tap is credited to whoever tapped even
  // if it reaches the server after someone else has taken over the tablet.
  const clKey = id => `g.cl.${id}`;
  const loadCl = id => LS.get(clKey(id));
  const saveCl = st => { if (!LS.set(clKey(st.run.id), st)) toast('La tablet no tiene espacio para guardar el avance.', true); };
  const ptr = () => LS.get('g.cl.ptr', {});
  function pendingOps() { return LS.keys('g.cl.').filter(k => k !== 'g.cl.ptr').reduce((n, k) => n + ((LS.get(k) || {}).queue || []).length, 0); }
  function isOn(st, item) { const l = st.local[item.id]; return l ? l.checked : !!item.checked_at; }
  function counts(st) {
    let done = 0, total = 0;
    for (const s of st.run.sections) for (const it of s.items) { total++; if (isOn(st, it)) done++; }
    return { done, total };
  }
  function adoptRun(run) {
    const old = loadCl(run.id);
    const st = old ? { ...old, run } : { run, local: {}, queue: [], comments: run.comments || '', dirty: false, open: null };
    // Server truth wins for anything we are not still waiting to send.
    const waiting = new Set(st.queue.map(o => o.item_id));
    for (const id of Object.keys(st.local)) if (!waiting.has(Number(id))) delete st.local[id];
    if (!st.dirty) st.comments = run.comments || '';
    if (run.status === 'completed') { st.queue = []; st.local = {}; st.dirty = false; }
    if (st.open === null || st.open === undefined) {
      const first = run.sections.find(s => s.items.some(it => !isOn(st, it)));
      st.open = first ? first.pos : -1;
    }
    saveCl(st);
    const p = ptr(); p[run.type] = { date: run.business_date, id: run.id }; LS.set('g.cl.ptr', p);
    return st;
  }
  // Old finished runs don't need to live on the tablet.
  function tidy() {
    const keepFrom = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
    for (const k of LS.keys('g.cl.')) {
      if (k === 'g.cl.ptr') continue;
      const st = LS.get(k);
      if (!st || !st.run || (st.run.business_date < keepFrom && !(st.queue || []).length)) LS.del(k);
    }
  }

  VIEWS.checklists = () => {
    const t = S.p.today, p = ptr(), bd = businessDate();
    const tile = (type, label, ico) => {
      const local = p[type] && p[type].date === bd ? loadCl(p[type].id) : null;
      const info = t ? t[type] : null;
      let sub = '';
      if (info && !info.configured && info.status === 'none') sub = 'Aún no está configurado';
      else if ((info && info.status === 'completed') || (local && local.run.status === 'completed')) sub = '✓ Terminado hoy — ver';
      else if (local) { const c = counts(local); sub = `En curso: ${c.done} / ${c.total} — continuar`; }
      else if (info && info.status === 'in_progress') sub = `En curso: ${info.done} / ${info.total} — continuar`;
      else sub = 'Iniciar';
      return `<button class="${type === 'apertura' ? 'b2' : 'b3'}" data-act="openCl" data-type="${type}"><span class="ico">${ico}</span>${label}<small>${sub}</small></button>`;
    };
    return `${backBtn()}
      <div class="home" style="grid-template-columns:1fr 1fr">${tile('apertura', 'Apertura', '🌅')}${tile('cierre', 'Cierre', '🌙')}</div>
      <p style="margin-top:14px"><button class="btn full" data-act="goHistory">Historial (últimos 7 días)</button></p>`;
  };
  AFTER.checklists = async () => {
    if (S.p.today) return;
    try { const today = await api('GET', '/g/checklist/today'); if (S.view === 'checklists') { S.p.today = today; render(); } }
    catch { /* offline: the tiles fall back to what the tablet has saved */ }
  };
  ACT.openCl = el => openChecklist(el.dataset.type);
  ACT.goHistory = () => go('history');

  async function openChecklist(type) {
    try {
      const r = await api('POST', '/g/checklist/start', { type });
      const st = adoptRun(r.run);
      go('checklist', { type, id: st.run.id });
      syncAll();
    } catch (e) {
      // Offline: carry on from the copy on the tablet if today's run is there.
      const p = ptr()[type];
      if (e.offline && p && p.date === businessDate() && loadCl(p.id)) return go('checklist', { type, id: p.id });
      toast(e.offline ? 'Sin conexión. Para iniciar el checklist se necesita internet (después ya puedes seguir sin wifi).' : e.message, true);
    }
  }

  function sectionHtml(st, s, readonly) {
    const done = s.items.filter(it => isOn(st, it)).length;
    const open = readonly || st.open === s.pos;
    return `<div class="sec ${done === s.items.length ? 'done' : ''}" data-sec="${s.pos}">
      <button class="sec-head" data-act="toggleSec" data-pos="${s.pos}">
        <span class="t">${esc(s.title)}</span><span class="n">${done} / ${s.items.length}</span>
        ${readonly ? '' : `<span class="arrow">${open ? '▲' : '▼'}</span>`}
      </button>
      ${open ? `${s.note ? `<div class="sec-note">${esc(s.note)}</div>` : ''}
        ${s.items.map(it => {
          const on = isOn(st, it), l = st.local[it.id];
          const when = on ? hhmm(l ? l.at : it.checked_at) : '';
          return `<button class="item ${on ? 'on' : ''} ${it.warning ? 'warn' : ''}" data-act="tick" data-id="${it.id}" ${readonly ? 'disabled' : ''}>
            <span class="box">${on ? '✓' : ''}</span><span class="txt">${esc(it.text)}</span>
            <span class="when">${when}${readonly && it.checked_by_name ? ' · ' + esc(it.checked_by_name) : ''}</span></button>`;
        }).join('')}` : ''}
    </div>`;
  }
  const syncLine = st => st.run.status === 'completed' ? ''
    : st.queue.length || st.dirty
      ? `<span class="sync pending">Guardado en la tablet · ${S.online ? 'enviando…' : 'se enviará al volver el wifi'}</span>`
      : '<span class="sync">✓ Todo guardado</span>';

  VIEWS.checklist = () => {
    const st = loadCl(S.p.id);
    if (!st) return backBtn('← Regresar', 'goChecklists') + '<div class="card">No se encontró el checklist.</div>';
    const run = st.run, c = counts(st), readonly = run.status === 'completed';
    const label = run.type === 'apertura' ? 'Apertura' : 'Cierre';
    return `${backBtn('← Regresar', 'goChecklists')}
      ${readonly ? `<div class="banner ok">✓ ${label} terminado${run.finished_at ? ' a las ' + hhmm(run.finished_at) : ''}
        <small>${esc((run.gerentes || []).map(g => g.name).join(', '))} · inició ${hhmm(run.started_at)} · este registro ya no se puede modificar.</small></div>` : ''}
      <div class="progress">
        <div class="nums"><div>${label} · <span>${dayLabel(run.business_date)}</span></div><div id="clNum">${c.done} / ${c.total}</div></div>
        <div class="bar"><div id="clBar" style="width:${c.total ? Math.round(100 * c.done / c.total) : 0}%"></div></div>
        <div id="clSync" style="margin-top:6px">${syncLine(st)}</div>
      </div>
      ${run.header_note ? `<p class="hint"><b>${esc(run.header_note)}</b></p>` : ''}
      <div id="clSecs">${run.sections.map(s => sectionHtml(st, s, readonly)).join('')}</div>
      <div class="card">
        <label class="f" style="margin-top:0">Comentarios / Incidencias</label>
        ${readonly ? `<p>${esc(run.comments || 'Sin comentarios.')}</p>`
          : `<textarea class="in" id="clComments" placeholder="${esc(run.comments_placeholder || '')}">${esc(st.comments || '')}</textarea>`}
        ${run.footer_note ? `<div class="footer-red">${esc(run.footer_note)}</div>` : ''}
      </div>
      ${readonly ? '' : `<p><button class="btn primary full" id="clFinish" data-act="finishCl" ${c.done === c.total ? '' : 'disabled'}>Finalizar ${label.toLowerCase()}</button></p>
        <p class="hint" id="clLeft">${c.done === c.total ? '' : `Faltan ${c.total - c.done} actividades por marcar.`}</p>`}`;
  };
  AFTER.checklist = () => {
    const ta = document.getElementById('clComments');
    if (ta) ta.oninput = () => {
      const st = loadCl(S.p.id); if (!st) return;
      st.comments = ta.value; st.dirty = true; saveCl(st); scheduleSync();
      const sy = document.getElementById('clSync'); if (sy) sy.innerHTML = syncLine(st);
    };
  };
  function redrawSections(st) {
    const el = document.getElementById('clSecs');
    if (el) el.innerHTML = st.run.sections.map(s => sectionHtml(st, s, false)).join('');
  }
  function redrawProgress(st) {
    const c = counts(st);
    const n = document.getElementById('clNum'), b = document.getElementById('clBar'), f = document.getElementById('clFinish'),
      l = document.getElementById('clLeft'), sy = document.getElementById('clSync');
    if (n) n.textContent = `${c.done} / ${c.total}`;
    if (b) b.style.width = (c.total ? Math.round(100 * c.done / c.total) : 0) + '%';
    if (f) f.disabled = c.done !== c.total;
    if (l) l.textContent = c.done === c.total ? '' : `Faltan ${c.total - c.done} actividades por marcar.`;
    if (sy) sy.innerHTML = syncLine(st);
  }
  ACT.goChecklists = () => go('checklists');
  ACT.toggleSec = el => {
    const st = loadCl(S.p.id); if (!st || st.run.status === 'completed') return;
    const pos = Number(el.dataset.pos);
    st.open = st.open === pos ? -1 : pos; saveCl(st); redrawSections(st);
  };
  ACT.tick = el => {
    const st = loadCl(S.p.id); if (!st || st.run.status === 'completed') return;
    const id = Number(el.dataset.id);
    const sec = st.run.sections.find(s => s.items.some(it => it.id === id));
    const item = sec.items.find(it => it.id === id);
    const checked = !isOn(st, item), at = new Date().toISOString();
    // Saved to the tablet FIRST, then drawn, then (eventually) sent.
    st.local[id] = { checked, at };
    st.queue.push({ item_id: id, checked, at, token: S.session.token });
    // Finishing a section folds it away and opens the next one with work left.
    if (checked && sec.items.every(it => isOn(st, it))) {
      const next = st.run.sections.find(s => s.items.some(it => !isOn(st, it)));
      st.open = next ? next.pos : -1;
      saveCl(st); redrawSections(st);
      const nx = next && document.querySelector(`[data-sec="${next.pos}"]`);
      if (nx) nx.scrollIntoView({ block: 'start' }), window.scrollBy(0, -150);
    } else {
      saveCl(st);
      el.classList.toggle('on', checked);
      el.querySelector('.box').textContent = checked ? '✓' : '';
      el.querySelector('.when').textContent = checked ? hhmm(at) : '';
      const done = sec.items.filter(it => isOn(st, it)).length;
      const secEl = el.closest('.sec');
      secEl.querySelector('.n').textContent = `${done} / ${sec.items.length}`;
      secEl.classList.toggle('done', done === sec.items.length);
    }
    redrawProgress(st);
    scheduleSync();
  };
  ACT.finishCl = async el => {
    let st = loadCl(S.p.id); if (!st) return;
    const c = counts(st);
    if (c.done !== c.total) return;
    el.disabled = true;
    const ta = document.getElementById('clComments');
    try {
      await syncAll();                          // flush taps made under earlier PIN sessions first
      st = loadCl(S.p.id);
      const r = await api('POST', '/g/checklist/finish', { run_id: st.run.id, comments: ta ? ta.value : st.comments,
        ops: st.queue.map(({ item_id, checked, at }) => ({ item_id, checked, at })) });
      adoptRun(r.run); toast('Checklist finalizado ✓'); render(); window.scrollTo(0, 0);
    } catch (e) {
      el.disabled = false;
      if (e.data && e.data.run) { adoptRun(e.data.run); render(); }
      toast(e.offline ? 'Sin conexión. Tu avance está guardado en la tablet; toca Finalizar cuando regrese el wifi.' : e.message, true);
    }
  };

  // ---- background sync ----------------------------------------------------
  let syncTimer = null, syncing = null;
  function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(syncAll, 1200); }
  function syncAll() {
    if (syncing) return syncing;
    syncing = (async () => {
      for (const k of LS.keys('g.cl.')) {
        if (k === 'g.cl.ptr') continue;
        let st = LS.get(k);
        if (!st || !st.run || st.run.status === 'completed' || !(st.queue.length || st.dirty)) continue;
        // One request per PIN session, so each tap is credited to its gerente.
        const tokens = [...new Set(st.queue.map(o => o.token))];
        if (!tokens.length && S.session) tokens.push(S.session.token);
        for (const token of tokens) {
          const batch = st.queue.filter(o => o.token === token);
          const sendComments = st.dirty && S.session && token === S.session.token;
          const body = { run_id: st.run.id, ops: batch.map(({ item_id, checked, at }) => ({ item_id, checked, at })),
            comments: sendComments ? st.comments : undefined };
          let r;
          try { r = await api('POST', '/g/checklist/sync', body, token); }
          catch (e) {
            if (e.offline) return;              // try again when the wifi is back
            // That gerente's session ran out: send under whoever is here now
            // rather than lose the ticks.
            if (e.status === 401 && S.session && token !== S.session.token) {
              try { r = await api('POST', '/g/checklist/sync', body, S.session.token); } catch { continue; }
            } else continue;
          }
          // Re-read: the gerente may have tapped more while this was in flight.
          st = LS.get(k) || st;
          const sent = new Set(batch.map(o => `${o.item_id}|${o.at}`));
          st.queue = st.queue.filter(o => !sent.has(`${o.item_id}|${o.at}`));
          if (sendComments && st.comments === body.comments) st.dirty = false;
          LS.set(k, st);
          adoptRun(r.run);
          st = LS.get(k);
        }
        if (S.view === 'checklist' && S.p.id === st.run.id) {
          if (st.run.status === 'completed') render();
          else { const sy = document.getElementById('clSync'); if (sy) sy.innerHTML = syncLine(st); }
        }
      }
    })().finally(() => { syncing = null; });
    return syncing;
  }
  setInterval(() => { if (pendingOps()) syncAll(); }, 20e3);

  // ---- history ------------------------------------------------------------
  VIEWS.history = () => {
    const rows = S.p.rows;
    return `${backBtn('← Regresar', 'goChecklists')}<div class="card"><div class="title">Historial · últimos 7 días</div>
      ${!rows ? '<p class="hint">Cargando…</p>' : !rows.length ? '<p class="hint">Aún no hay registros.</p>' : rows.map(r => `
        <div class="list-item">
          <div class="grow"><b>${r.type === 'apertura' ? '🌅 Apertura' : '🌙 Cierre'} · ${dayLabel(r.business_date)}</b>
            <div class="hint">${esc(r.gerentes || '')} · ${hhmm(r.started_at)}${r.finished_at ? ' – ' + hhmm(r.finished_at) + ` (${r.duration_min} min)` : ''}
              ${r.status === 'completed' ? '<span class="pill ok">Terminado</span>' : `<span class="pill warn">En curso ${r.done}/${r.total}</span>`}
              ${r.has_comments ? '<span class="pill">💬 Comentarios</span>' : ''}</div></div>
          <button class="btn small" data-act="seeRun" data-id="${r.id}">Ver</button>
        </div>`).join('')}</div>`;
  };
  AFTER.history = async () => {
    if (S.p.rows) return;
    try { const rows = await api('GET', '/g/checklist/history'); if (S.view === 'history') { S.p.rows = rows; render(); } }
    catch (e) { toast(e.offline ? 'Sin conexión. El historial necesita internet.' : e.message, true); }
  };
  ACT.seeRun = async el => {
    try { const run = await api('GET', `/g/checklist/run/${el.dataset.id}`); go('record', { run }); }
    catch (e) { toast(e.message, true); }
  };
  VIEWS.record = () => {
    const run = S.p.run, st = { run, local: {} };
    const label = run.type === 'apertura' ? 'Apertura' : 'Cierre';
    return `${backBtn('← Historial', 'goHistory')}
      <div class="card"><div class="title">${label} · ${dayLabel(run.business_date)}</div>
        <p>${run.status === 'completed' ? '<span class="pill ok">Terminado</span>' : '<span class="pill warn">En curso</span>'}
          <b>${run.done} / ${run.total}</b></p>
        <p class="hint">Gerente(s): ${esc(run.gerentes.map(g => g.name).join(', '))}<br>
          Inicio ${hhmm(run.started_at)}${run.finished_at ? ' · Fin ' + hhmm(run.finished_at) : ''}</p></div>
      ${run.sections.map(s => sectionHtml(st, s, true)).join('')}
      <div class="card"><label class="f" style="margin-top:0">Comentarios / Incidencias</label><p>${esc(run.comments || 'Sin comentarios.')}</p></div>`;
  };

  // ---------------------------------------------------------------- boot ----
  async function start() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/gerente/sw.js', { scope: '/gerente/' }).catch(() => {});
    tidy();
    try { S.boot = await api('GET', '/g/boot'); if (S.boot.registered) LS.set('g.boot', S.boot); else LS.del('g.boot'); }
    catch { S.boot = LS.get('g.boot'); }       // offline: use what this tablet already knows
    if (!S.boot) return go('dead');
    if (!S.boot.registered) return go('setup');
    const saved = LS.get('g.session');
    if (saved && saved.token && Date.now() - (saved.last || 0) < IDLE_MS) {
      S.session = { id: saved.id, name: saved.name, token: saved.token }; S.lastActive = Date.now();
      go('home'); syncAll();
    } else { LS.del('g.session'); go('pin'); }
  }
  start();
})();
