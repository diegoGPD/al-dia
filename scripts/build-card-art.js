#!/usr/bin/env node
// Pre-renders the bugo bogo stamp grid for every possible card state.
//
// Why pre-render instead of drawing per request: the grid depends only on the
// visit count (0–10), so there are 11 images, not one per customer. Building
// them here means the server never touches image code — it just serves a file —
// and both wallets read the exact same pixels. No image library, no native
// module, nothing to break the Docker build.
//
//   node scripts/build-card-art.js
//
// Output: public/card/grid-<n>[-m2]@{1,2,3}x.png  (Apple strip + Google hero)
const fs = require('node:fs');
const path = require('node:path');
const { readPng, writePng, cropAlpha, resize, solid, compose } = require('./lib/png');

const BRAND = path.join(__dirname, '..', 'assets', 'brand');
const OUT = path.join(__dirname, '..', 'public', 'cardart');

// Brand tokens — from the card design, used everywhere.
const ORANGE = [0xEC, 0x56, 0x2B];

// Apple storeCard strip is 375×144 pt. @3x is the master; the rest are
// downscaled from it so all three densities are pixel-consistent.
const W3 = 1125, H3 = 432;

const art = name => cropAlpha(readPng(path.join(BRAND, name + '.png')));
const A = {
  empty:   art('stamp-empty'),
  filled:  art('stamp-filled'),
  mystery: art('stamp-mystery'),
  drink:   art('reward-drink'),
  burrito: art('reward-burrito'),
  unbugo:  art('tagline-unbugo')
};

// Visit 5 earns the drink, visit 10 the burrito. Until a milestone is reached
// its slot stays a "?" — the surprise is the point.
const MILESTONES = { 5: 'drink', 10: 'burrito' };

function slotArt(slot, visits) {
  const reward = MILESTONES[slot];
  if (slot <= visits) return reward ? A[reward] : A.filled;
  return reward ? A.mystery : A.empty;
}

// Layout: "un bugo?" top-right (baked in so it uses the real brand font —
// Apple renders all pass *text* in the system font), then 2 rows × 5 below.
// "mejor 2" is not here: it lives on the back of the pass, which keeps the
// circles full size.
const D = 160;                                // circle diameter
const GAP_X = (W3 - 5 * D) / 6;
const TOP = 66, GAP_Y = 14;
const TAG_W = 250;

function buildGrid(visits) {
  const canvas = solid(W3, H3, ORANGE);
  const th = Math.round(A.unbugo.h * TAG_W / A.unbugo.w);
  compose(canvas, resize(A.unbugo, TAG_W, th), Math.round(W3 - GAP_X - TAG_W), Math.round((TOP - th) / 2));

  const cache = new Map();
  const scaled = a => {
    if (!cache.has(a)) cache.set(a, resize(a, D, D));
    return cache.get(a);
  };
  for (let i = 0; i < 10; i++) {
    const row = Math.floor(i / 5), col = i % 5;
    compose(canvas, scaled(slotArt(i + 1, visits)),
      Math.round(GAP_X + col * (D + GAP_X)), Math.round(TOP + row * (D + GAP_Y)));
  }
  return canvas;
}

// Google's hero image wants ~3:1 (1032×336); the Apple strip is 2.6:1. Letting
// Google crop would clip the grid, so the same art is re-laid out at its ratio.
const GW = 1032, GH = 336;
function buildHero(visits) {
  const canvas = solid(GW, GH, ORANGE);
  const d = 118, gx = (GW - 5 * d) / 6, top = 52, gy = 12;
  const th = Math.round(A.unbugo.h * 190 / A.unbugo.w);
  compose(canvas, resize(A.unbugo, 190, th), Math.round(GW - gx - 190), Math.round((top - th) / 2));
  const cache = new Map();
  const scaled = a => { if (!cache.has(a)) cache.set(a, resize(a, d, d)); return cache.get(a); };
  for (let i = 0; i < 10; i++) {
    const row = Math.floor(i / 5), col = i % 5;
    compose(canvas, scaled(slotArt(i + 1, visits)),
      Math.round(gx + col * (d + gx)), Math.round(top + row * (d + gy)));
  }
  return canvas;
}

// Pass icon (square) and logo, straight from the brand art. The logo is cream
// on transparency, so it sits on the orange pass background as drawn.
function buildChrome() {
  const icon = art('stamp-empty');
  for (const [name, px] of [['icon.png', 29], ['icon@2x.png', 58], ['icon@3x.png', 87]]) {
    const r = resize(icon, px, px);
    fs.writeFileSync(path.join(OUT, name), writePng(r.w, r.h, r.data));
  }
  // Apple caps the logo at 160×50 pt; fit the oval inside that, keeping ratio.
  const logo = art('logo');
  for (const [name, mult] of [['logo.png', 1], ['logo@2x.png', 2], ['logo@3x.png', 3]]) {
    const boxW = 160 * mult, boxH = 50 * mult;
    const scale = Math.min(boxW / logo.w, boxH / logo.h);
    const r = resize(logo, Math.max(1, Math.round(logo.w * scale)), Math.max(1, Math.round(logo.h * scale)));
    fs.writeFileSync(path.join(OUT, name), writePng(r.w, r.h, r.data));
  }
  return 6;
}

fs.mkdirSync(OUT, { recursive: true });
let n = buildChrome();
for (let v = 0; v <= 10; v++) {
  const master = buildGrid(v);
  for (const [suffix, div] of [['@3x', 1], ['@2x', 1.5], ['', 3]]) {
    const img = div === 1 ? master : resize(master, Math.round(W3 / div), Math.round(H3 / div));
    fs.writeFileSync(path.join(OUT, `grid-${v}${suffix}.png`), writePng(img.w, img.h, img.data));
    n++;
  }
  const hero = buildHero(v);
  fs.writeFileSync(path.join(OUT, `hero-${v}.png`), writePng(hero.w, hero.h, hero.data));
  n++;
}
console.log(`wrote ${n} files to public/card/`);
