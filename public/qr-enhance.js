/* Shared camera tuning + multi-pass QR decoding for cheap webcams and tablets.
   Used by the owner scanner (public/js/views/scan.js) and the gerente tablet
   (public/gerente/app.js). Loaded as a plain script: window.QREnhance.

   What it does for a blurry, low-contrast camera:
   - asks for the highest resolution and continuous autofocus the camera has;
   - tries each frame several ways before giving up on it: the centre of the
     frame enlarged (a QR held in front of the lens is almost always there),
     the full frame, and a contrast-stretched centre for dim or washed-out
     screens; inverted codes (dark-mode phones) are tried on the centre pass;
   - exposes an overlay so staff know to fill the square with the card. */
(() => {
  'use strict';

  function constraints(deviceId) {
    const video = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
    video.width = { ideal: 1920 };
    video.height = { ideal: 1080 };
    video.frameRate = { ideal: 30 };
    return { video };
  }

  // Best effort: continuous focus, and a touch of zoom on cameras that offer
  // it (phone/tablet rear cameras), so the code fills more pixels.
  async function tune(track) {
    if (!track || !track.applyConstraints) return;
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    const adv = [];
    if (caps.focusMode && caps.focusMode.includes('continuous')) adv.push({ focusMode: 'continuous' });
    if (caps.zoom && caps.zoom.max > 1) adv.push({ zoom: Math.min(caps.zoom.max, Math.max(caps.zoom.min || 1, 1.5)) });
    if (!adv.length) return;
    try { await track.applyConstraints({ advanced: adv }); } catch { /* camera said no; fine */ }
  }

  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });

  // Draw a region of the video into the work canvas at a target size.
  function crop(video, sx, sy, sw, sh, outW, outH) {
    work.width = outW; work.height = outH;
    wctx.imageSmoothingEnabled = true;
    wctx.imageSmoothingQuality = 'high';
    wctx.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);
    return work;
  }

  // Grayscale + percentile contrast stretch, in place on the work canvas.
  function stretch(cv) {
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, cv.width, cv.height), d = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const y = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      d[i] = y; hist[y]++;
    }
    const n = d.length / 4;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.02) { hi = v; break; } }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const y = Math.max(0, Math.min(255, Math.round((d[i] - lo) * 255 / span)));
      d[i] = d[i + 1] = d[i + 2] = y;
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  /* decode(cv, opts) is the caller's decoder (BarcodeDetector or jsQR) taking a
     canvas; opts.invert asks jsQR to also try inverted codes. Returns the code
     or null. Passes are ordered cheapest-and-likeliest first. */
  async function decodeFrame(video, decode) {
    const W = video.videoWidth, H = video.videoHeight;
    if (!W || !H) return null;
    const side = Math.round(Math.min(W, H) * 0.7);
    const sx = Math.round((W - side) / 2), sy = Math.round((H - side) / 2);
    const out = Math.max(side, 720);                     // enlarge small/blurry centres

    const passes = [
      () => crop(video, sx, sy, side, side, out, out),
      () => crop(video, 0, 0, W, H, Math.min(W, 1280), Math.round(H * Math.min(W, 1280) / W)),
      () => stretch(crop(video, sx, sy, side, side, out, out))
    ];
    for (let i = 0; i < passes.length; i++) {
      let hit = null;
      try { hit = await decode(passes[i](), { invert: i !== 1 }); } catch { /* next pass */ }
      if (hit) return hit;
    }
    return null;
  }

  // A square guide over the video. The wrapper must be position:relative.
  function overlay(wrapper) {
    if (!wrapper || wrapper.querySelector('.qr-guide')) return;
    const g = document.createElement('div');
    g.className = 'qr-guide';
    g.innerHTML = '<div class="qr-box"></div><div class="qr-tip">acerca la tarjeta hasta llenar el cuadro</div>';
    if (!document.getElementById('qr-guide-css')) {
      const st = document.createElement('style'); st.id = 'qr-guide-css';
      st.textContent = `.qr-guide{position:absolute;inset:0;pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:center}
.qr-box{width:62%;max-width:360px;aspect-ratio:1;border:3px dashed rgba(255,255,255,.85);border-radius:18px;box-shadow:0 0 0 9999px rgba(0,0,0,.28)}
.qr-tip{margin-top:10px;color:#fff;font-size:13px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,.8)}`;
      document.head.appendChild(st);
    }
    wrapper.appendChild(g);
  }

  window.QREnhance = { constraints, tune, decodeFrame, overlay };
})();
