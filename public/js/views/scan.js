/* bugo bogo — loyalty card scanner (staff). Works on phones and on a PC
   webcam: the old version demanded a rear camera and hid every failure behind
   "Camera unavailable", including the QR decoder failing to download. */
'use strict';
(() => {
  const { api, state, registerRoute, render, esc, toast } = App;
  const { qLoc, isOwner } = App.ui;

  let stream = null;
  let scanning = false;
  let lastHit = { code: null, at: 0 };

  const LAST_CAM = 'aldia.scanner.camera';
  const remembered = () => { try { return localStorage.getItem(LAST_CAM); } catch { return null; } };
  const remember = id => { try { localStorage.setItem(LAST_CAM, id); } catch { /* private mode */ } };

  registerRoute('scan', async () => `
    <h2 class="page-title">escanear tarjeta</h2>
    <div class="card">
      <div id="scanArea">
        <video id="scanVideo" playsinline muted autoplay
               style="width:100%;border-radius:12px;background:#000;min-height:220px;object-fit:cover"></video>
        <canvas id="scanCanvas" style="display:none"></canvas>
        <div class="hint center" id="scanStatus">iniciando cámara…</div>
        <label id="camPickWrap" style="display:none;margin-top:8px">cámara
          <select id="camPick"></select></label>
      </div>
      <div id="scanResult"></div>
      <form id="manualForm" class="row2" style="margin-top:10px">
        <label>o escribe el código
          <input name="code" placeholder="AD1A2B3C4D5E" autocapitalize="characters" autocomplete="off"></label>
        <button class="btn primary" type="submit" style="align-self:end">registrar visita</button>
      </form>
      <div class="hint">también funciona con lector de código de barras USB: escanea y listo.</div>
      <input id="wedge" inputmode="none" aria-hidden="true"
             style="position:absolute;opacity:0;width:1px;height:1px;pointer-events:none">
    </div>`);

  registerRoute('scan_bind', (app) => {
    const video = app.querySelector('#scanVideo');
    const canvas = app.querySelector('#scanCanvas');
    const status = app.querySelector('#scanStatus');
    const resultEl = app.querySelector('#scanResult');
    const camPick = app.querySelector('#camPick');
    const camWrap = app.querySelector('#camPickWrap');
    const wedge = app.querySelector('#wedge');

    const stop = () => {
      scanning = false;
      if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    };
    window.addEventListener('hashchange', stop, { once: true });

    // ---- decoder: native first, jsQR as fallback -------------------------
    let detector = null;
    async function getDecoder() {
      if (detector) return detector;
      if ('BarcodeDetector' in window) {
        try {
          const formats = await window.BarcodeDetector.getSupportedFormats();
          if (formats.includes('qr_code')) {
            const d = new window.BarcodeDetector({ formats: ['qr_code'] });
            detector = async cv => {
              const found = await d.detect(cv);
              return found.length ? found[0].rawValue : null;
            };
            return detector;
          }
        } catch { /* fall through to jsQR */ }
      }
      if (!window.jsQR) {
        await new Promise((ok, bad) => {
          const s = document.createElement('script');
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js';
          s.onload = ok;
          s.onerror = () => bad(new Error('decoder'));
          document.head.appendChild(s);
        });
      }
      const ctx2 = canvas.getContext('2d', { willReadFrequently: true });
      detector = async cv => {
        const img = ctx2.getImageData(0, 0, cv.width, cv.height);
        const hit = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        return hit && hit.data ? hit.data : null;
      };
      return detector;
    }

    // ---- actions ---------------------------------------------------------
    async function stamp(code, override = false) {
      stop();
      status.textContent = '';
      try {
        const r = await api('/loyalty/visit', { method: 'POST',
          body: { location_id: state.locationId, code, override } });
        showResult(r, code);
      } catch (err) {
        resultEl.innerHTML = `<div class="status-banner bad"><div class="status-title">${esc(err.message)}</div></div>
          <button class="btn primary full" id="again">escanear otra vez</button>`;
        bindAgain();
      }
    }

    function showResult(r, code) {
      const s = r.state;
      const dots = Array.from({ length: s.stampsNeeded }, (_, i) =>
        `<span class="stamp-dot ${i < s.stamps ? 'on' : ''}"></span>`).join('');
      // justEarned is a LIST of rewards crossed on this visit — [] is truthy,
      // so it has to be tested by length.
      const earned = (r.justEarned || []).length ? r.justEarned : null;
      let banner;
      if (!r.ok && r.reason === 'already_today') {
        banner = `<div class="status-banner warn"><div class="status-title">ya tiene sello de hoy</div>
          <div class="status-sub">${esc(s.name)} — un sello por día.</div></div>
          ${isOwner() ? '<button class="btn full" id="forceBtn">sellar de todas formas</button>' : ''}`;
      } else if (earned) {
        banner = `<div class="status-banner good">
          <div class="status-title">🎁 ${esc(s.name)} ganó: ${esc(earned.map(x => x.name).join(' y '))}</div>
          <div class="status-sub">su tarjeta ya se actualizó.</div></div>`;
      } else {
        banner = `<div class="status-banner good"><div class="status-title">✓ sello para ${esc(s.name)}</div>
          <div class="status-sub">${s.nextReward
            ? `faltan ${s.toNext} para su ${esc(s.nextReward.name)}`
            : 'tarjeta completa'}</div></div>`;
      }
      // One button per reward actually owed — the drink and the burrito are
      // handed over separately, never automatically on scan.
      const owed = (s.pending || []).map(p => `
        <button class="btn full redeem-one" data-reward="${p.reward_id}" style="margin-top:6px">
          🎁 canjear ${esc(p.name)}</button>`).join('');
      resultEl.innerHTML = `
        ${banner}
        <div class="stamps-row">${dots}</div>
        <div class="hint center">visitas: ${String(s.stamps).padStart(2, '0')} / ${s.stampsNeeded}</div>
        ${owed}
        <button class="btn primary full" id="again" style="margin-top:8px">siguiente cliente</button>`;

      resultEl.querySelectorAll('.redeem-one').forEach(b => b.onclick = async () => {
        b.disabled = true;
        try {
          const res = await api('/loyalty/redeem', { method: 'POST',
            body: { location_id: state.locationId, code, reward_id: Number(b.dataset.reward) } });
          toast(`canjeado: ${res.redeemed ? res.redeemed.name : 'premio'} 🎉`);
          showResult({ ok: true, state: res.state, justEarned: [] }, code);
        } catch (err) { b.disabled = false; toast(err.message, true); }
      });
      const force = resultEl.querySelector('#forceBtn');
      if (force) force.onclick = () => stamp(code, true);
      bindAgain();
    }

    function bindAgain() {
      const b = resultEl.querySelector('#again');
      if (b) b.onclick = () => render();
    }

    // ---- camera ----------------------------------------------------------
    function cameraError(e) {
      const n = e && e.name;
      if (n === 'NotAllowedError' || n === 'SecurityError')
        return 'permiso de cámara denegado. da permiso en el candado 🔒 de la barra de direcciones y recarga.';
      if (n === 'NotFoundError' || n === 'OverconstrainedError')
        return 'no encontré ninguna cámara en esta computadora.';
      if (n === 'NotReadableError')
        return 'la cámara está ocupada por otra app (zoom, meet, teams). ciérrala y recarga.';
      if (e && e.message === 'decoder')
        return 'no pude cargar el lector de QR (¿sin internet?). escribe el código abajo.';
      return `no pude abrir la cámara: ${e && e.message ? e.message : 'error desconocido'}`;
    }

    async function listCameras() {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter(d => d.kind === 'videoinput');
      if (cams.length > 1) {
        camWrap.style.display = '';
        camPick.innerHTML = cams.map((c, i) =>
          `<option value="${c.deviceId}">${esc(c.label || `cámara ${i + 1}`)}</option>`).join('');
        const want = remembered();
        if (want && cams.some(c => c.deviceId === want)) camPick.value = want;
        camPick.onchange = () => { remember(camPick.value); start(camPick.value); };
      }
      return cams;
    }

    async function start(deviceId) {
      stop();
      try {
        // Permission first with a loose constraint. Asking for the rear camera
        // as a hard requirement is what breaks laptops and desktops; it is only
        // ever a preference.
        const constraints = deviceId
          ? { video: { deviceId: { exact: deviceId } } }
          : { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } } };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;
        await video.play();

        const track = stream.getVideoTracks()[0];
        const settings = track.getSettings ? track.getSettings() : {};
        if (settings.deviceId) remember(settings.deviceId);
        // Mirror a front-facing webcam so staff can aim it; the canvas copies
        // the raw video, so decoding is unaffected by this CSS flip.
        video.style.transform = settings.facingMode === 'environment' ? 'none' : 'scaleX(-1)';

        const cams = await listCameras();           // labels need permission first
        if (camPick.options.length && settings.deviceId) camPick.value = settings.deviceId;

        const decode = await getDecoder();
        status.textContent = cams.length > 1
          ? 'apunta al código QR del cliente'
          : 'apunta al código QR del cliente';
        scanning = true;

        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const tick = async () => {
          if (!scanning) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth) {
            canvas.width = video.videoWidth; canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0);
            let found = null;
            try { found = await decode(canvas); } catch { /* keep scanning */ }
            if (found) {
              const code = String(found).trim();
              const now = Date.now();
              // One QR held in front of the lens must log one visit, not forty.
              if (!(code === lastHit.code && now - lastHit.at < 5000)) {
                lastHit = { code, at: now };
                stamp(code);
                return;
              }
            }
          }
          requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        scanning = false;
        status.innerHTML = `<span class="neg">${esc(cameraError(e))}</span>`;
      }
    }

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) start(remembered() || null);
    else status.innerHTML = '<span class="neg">este navegador no permite cámara aquí. escribe el código abajo.</span>';

    // ---- manual entry + USB barcode scanners (keyboard wedge) ------------
    app.querySelector('#manualForm').onsubmit = (e) => {
      e.preventDefault();
      const code = new FormData(e.target).get('code').trim().toUpperCase();
      if (code) stamp(code);
    };
    // A handheld scanner "types" the code then Enter. Keep a hidden input
    // focused so it lands somewhere even when nothing is selected.
    const focusWedge = () => { if (!resultEl.innerHTML && document.activeElement === document.body) wedge.focus(); };
    focusWedge();
    document.addEventListener('click', focusWedge);
    wedge.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const code = wedge.value.trim().toUpperCase();
      wedge.value = '';
      if (code) stamp(code);
    });
  });
})();
