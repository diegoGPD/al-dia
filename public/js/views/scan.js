/* Al Día — loyalty card scanner (staff) */
'use strict';
(() => {
  const { api, state, registerRoute, render, esc, toast } = App;
  const { qLoc, isOwner } = App.ui;

  let stream = null;
  let scanning = false;

  registerRoute('scan', async () => `
    <h2 class="page-title">Scan loyalty card</h2>
    <div class="card">
      <div id="scanArea">
        <video id="scanVideo" playsinline muted style="width:100%;border-radius:12px;background:#000;min-height:220px"></video>
        <canvas id="scanCanvas" style="display:none"></canvas>
        <div class="hint center" id="scanStatus">Starting camera…</div>
      </div>
      <div id="scanResult"></div>
      <details style="margin-top:10px"><summary class="hint">Type the code instead</summary>
        <form id="manualForm" class="row2" style="margin-top:8px">
          <label>Code<input name="code" placeholder="AD1A2B3C4D5E" autocapitalize="characters"></label>
          <button class="btn primary" type="submit" style="align-self:end">Stamp visit</button>
        </form>
      </details>
    </div>`);

  registerRoute('scan_bind', (app) => {
    const video = app.querySelector('#scanVideo');
    const canvas = app.querySelector('#scanCanvas');
    const status = app.querySelector('#scanStatus');
    const resultEl = app.querySelector('#scanResult');

    const stop = () => {
      scanning = false;
      if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    };
    // stop camera when navigating away
    window.addEventListener('hashchange', stop, { once: true });

    async function ensureJsQR() {
      if (window.jsQR) return;
      await new Promise((ok, bad) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js';
        s.onload = ok; s.onerror = bad;
        document.head.appendChild(s);
      });
    }

    async function stamp(code) {
      stop();
      status.textContent = '';
      try {
        const r = await api('/loyalty/visit', { method: 'POST',
          body: { location_id: state.locationId, code } });
        showResult(r, code);
      } catch (err) {
        resultEl.innerHTML = `<div class="status-banner bad"><div class="status-title">${esc(err.message)}</div></div>
          <button class="btn primary full" id="again">Scan again</button>`;
        bindAgain();
      }
    }

    function showResult(r, code) {
      const s = r.state;
      const dots = Array.from({ length: s.stampsNeeded }, (_, i) =>
        `<span class="stamp-dot ${i < s.stamps ? 'on' : ''}"></span>`).join('');
      let banner;
      if (!r.ok && r.reason === 'already_today') {
        banner = `<div class="status-banner warn"><div class="status-title">Already stamped today</div>
          <div class="status-sub">${esc(s.name)} — one stamp per day.</div></div>`;
      } else if (r.justEarned) {
        banner = `<div class="status-banner good"><div class="status-title">🎁 ${esc(s.name)} earned: ${esc(s.rewardText)}!</div>
          <div class="status-sub">Their card has been updated and notified.</div></div>`;
      } else {
        banner = `<div class="status-banner good"><div class="status-title">✓ Stamp added for ${esc(s.name)}</div>
          <div class="status-sub">${s.toNext} more to their reward.</div></div>`;
      }
      resultEl.innerHTML = `
        ${banner}
        <div class="stamps-row">${dots}</div>
        ${s.rewardsAvailable > 0 ? `
          <button class="btn full" id="redeemBtn">🎁 Redeem reward now (${s.rewardsAvailable} available)</button>` : ''}
        <button class="btn primary full" id="again" style="margin-top:8px">Scan next customer</button>`;
      const redeem = resultEl.querySelector('#redeemBtn');
      if (redeem) redeem.onclick = async () => {
        try {
          await api('/loyalty/redeem', { method: 'POST', body: { location_id: state.locationId, code } });
          toast('Reward redeemed 🎉'); render();
        } catch (err) { toast(err.message, true); }
      };
      bindAgain();
    }

    function bindAgain() {
      const b = resultEl.querySelector('#again');
      if (b) b.onclick = () => render();
    }

    async function startCamera() {
      try {
        await ensureJsQR();
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.srcObject = stream;
        await video.play();
        status.textContent = 'Point the camera at the customer\'s QR code';
        scanning = true;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const tick = () => {
          if (!scanning) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth; canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const hit = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            if (hit && hit.data) { stamp(hit.data.trim()); return; }
          }
          requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        status.textContent = 'Camera unavailable — type the code below instead.';
      }
    }
    startCamera();

    app.querySelector('#manualForm').onsubmit = (e) => {
      e.preventDefault();
      const code = new FormData(e.target).get('code').trim().toUpperCase();
      if (code) stamp(code);
    };
  });
})();
