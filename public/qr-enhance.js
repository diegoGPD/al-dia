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
    video.width = { ideal: 1280 };          // 1080p turns autofocus off on some webcams
    video.height = { ideal: 720 };
    video.frameRate = { ideal: 30 };
    return { video };
  }

  // Best effort: continuous focus, and a touch of zoom on cameras that offer
  // it (phone/tablet rear cameras), so the code fills more pixels.
  // Focus and a touch of zoom are always safe. Exposure is not: a phone screen
  // is self-lit and wants the camera underexposed, but a webcam underexposed in
  // a normal room shows nothing at all. So tune() only sets focus/zoom, and
  // exposure is toggled by the scan loop (see alternate below): auto first,
  // then darker after a couple of seconds without a read, back and forth.
  async function tune(track) {
    if (!track || !track.applyConstraints) return;
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    const tries = [];
    if (caps.focusMode && caps.focusMode.includes('continuous')) tries.push({ focusMode: 'continuous' });
    // No zoom: on a webcam it is digital, i.e. a blur. The decoder enlarges the
    // centre itself, which is the same thing without throwing away pixels.
    for (const c of tries) {
      try { await track.applyConstraints({ advanced: [c] }); } catch { /* camera said no; fine */ }
    }
  }

  // Which light controls this camera exposes to the browser (UVC webcams on
  // Windows/Linux usually offer brightness/contrast; phones offer exposure).
  function lightControls(track) {
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    const out = [];
    if (caps.exposureCompensation && caps.exposureCompensation.min < 0) out.push('exposureCompensation');
    if (caps.exposureMode && caps.exposureMode.includes('manual') && caps.exposureTime) out.push('exposureTime');
    if (caps.brightness && caps.brightness.max > caps.brightness.min) out.push('brightness');
    if (caps.contrast && caps.contrast.max > caps.contrast.min) out.push('contrast');
    return out;
  }
  const snap = (v, r) => r.step ? Math.round(v / r.step) * r.step : v;
  const lerp = (r, t) => r.min + (r.max - r.min) * t;

  // Focus: what the camera offers, a way to nudge autofocus, and manual distance.
  function focusInfo(track) {
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    return { modes: caps.focusMode || [], distance: caps.focusDistance || null,
      current: (track && track.getSettings ? track.getSettings() : {}).focusDistance };
  }
  async function refocus(track) {
    const f = focusInfo(track);
    const seq = [];
    if (f.modes.includes('manual')) seq.push({ focusMode: 'manual' });
    if (f.modes.includes('single-shot')) seq.push({ focusMode: 'single-shot' });
    if (f.modes.includes('continuous')) seq.push({ focusMode: 'continuous' });
    for (const c of seq) { try { await track.applyConstraints({ advanced: [c] }); } catch { /* ignore */ } await new Promise(r => setTimeout(r, 150)); }
  }
  async function setFocus(track, distance) {
    try { await track.applyConstraints({ advanced: [{ focusMode: 'manual' }, { focusDistance: distance }] }); return true; }
    catch { try { await track.applyConstraints({ advanced: [{ focusMode: 'manual', focusDistance: distance }] }); return true; } catch { return false; } }
  }

  // Exposure presets: 'auto', 'dark' (mild) and 'darkest' (for a phone at full
  // brightness). Each is a list of constraints applied one by one.
  function exposureModes(track) {
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    const auto = [], dark = [], darkest = [];
    if (caps.exposureCompensation && caps.exposureCompensation.min < 0) {
      const ec = caps.exposureCompensation;
      auto.push({ exposureCompensation: 0 });
      dark.push({ exposureCompensation: snap(ec.min * 0.65, ec) });
      darkest.push({ exposureCompensation: ec.min });
    }
    if (caps.exposureMode && caps.exposureMode.includes('manual') && caps.exposureTime) {
      const et = caps.exposureTime;
      if (caps.exposureMode.includes('continuous')) auto.push({ exposureMode: 'continuous' });
      dark.push({ exposureMode: 'manual', exposureTime: snap(lerp(et, 0.15), et) });
      darkest.push({ exposureMode: 'manual', exposureTime: snap(lerp(et, 0.03), et) });
    }
    if (caps.brightness && caps.brightness.max > caps.brightness.min) {
      const b = caps.brightness, cur = (track.getSettings() || {}).brightness;
      auto.push({ brightness: cur !== undefined ? cur : snap(lerp(b, 0.5), b) });
      dark.push({ brightness: snap(lerp(b, 0.2), b) });
      darkest.push({ brightness: b.min });
    }
    if (caps.contrast && caps.contrast.max > caps.contrast.min) {
      const c = caps.contrast, cur = (track.getSettings() || {}).contrast;
      auto.push({ contrast: cur !== undefined ? cur : snap(lerp(c, 0.5), c) });
      dark.push({ contrast: snap(lerp(c, 0.75), c) });
      darkest.push({ contrast: c.max });
    }
    return auto.length || dark.length ? { auto, dark, darkest } : null;
  }
  async function applyMode(track, list) {
    for (const c of list) { try { await track.applyConstraints({ advanced: [c] }); } catch { /* ignore */ } }
  }

  // Call once per scan loop. Returns a function to call on every frame with
  // whether a code was read; it flips exposure after `everyMs` without one.
  // Returns { tick, force }: tick() on every frame without a read; force(mode)
  // pins a mode ('darkest' for a bright phone, null to go back to alternating).
  function alternate(track, everyMs = 2500) {
    const modes = exposureModes(track);
    let cur = 'auto', since = Date.now(), busy = false, pinned = null;
    const tick = async () => {
      if (!modes || pinned || busy || Date.now() - since < everyMs) return;
      busy = true;
      cur = cur === 'auto' ? 'dark' : 'auto';
      await applyMode(track, modes[cur]);
      since = Date.now(); busy = false;
    };
    const force = async mode => {
      pinned = mode;
      if (!modes) return false;
      await applyMode(track, modes[mode || 'auto']);
      cur = mode || 'auto'; since = Date.now();
      return true;
    };
    return { tick, force, available: !!modes };
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

  // Darken an overexposed centre: a strong gamma pulls the washed-out greys
  // of the black modules back down while the lit white stays white.
  function darken(cv) {
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, cv.width, cv.height), d = img.data;
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.round(255 * Math.pow(v / 255, 3));
    for (let i = 0; i < d.length; i += 4) {
      const y = lut[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8];
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
      [() => crop(video, sx, sy, side, side, out, out), true],
      [() => crop(video, 0, 0, W, H, Math.min(W, 1280), Math.round(H * Math.min(W, 1280) / W)), false],
      [() => darken(crop(video, sx, sy, side, side, out, out)), false],       // bright phone screen
      [() => darken(crop(video, sx, sy, side, side, 400, 400)), false],       // bloom merges at a smaller size
      [() => stretch(crop(video, sx, sy, side, side, out, out)), true]        // dim / washed-out screen
    ];
    for (const [make, invert] of passes) {
      let hit = null;
      try { hit = await decode(make(), { invert }); } catch { /* next pass */ }
      if (hit) return hit;
    }
    return null;
  }

  // A square guide over the video. The wrapper must be position:relative.
  function overlay(wrapper) {
    if (!wrapper || wrapper.querySelector('.qr-guide')) return;
    const g = document.createElement('div');
    g.className = 'qr-guide';
    g.innerHTML = '<div class="qr-box"></div><div class="qr-tip">tarjeta dentro del cuadro, a unos 25 cm — si se ve borrosa, aléjala</div>';
    if (!document.getElementById('qr-guide-css')) {
      const st = document.createElement('style'); st.id = 'qr-guide-css';
      st.textContent = `.qr-guide{position:absolute;inset:0;pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:center}
.qr-box{width:48%;max-width:300px;aspect-ratio:1;border:3px dashed rgba(255,255,255,.85);border-radius:18px;box-shadow:0 0 0 9999px rgba(0,0,0,.28)}
.qr-tip{margin-top:10px;color:#fff;font-size:13px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,.8)}`;
      document.head.appendChild(st);
    }
    wrapper.appendChild(g);
  }

  window.QREnhance = { constraints, tune, alternate, lightControls, focusInfo, refocus, setFocus, decodeFrame, overlay };
})();
