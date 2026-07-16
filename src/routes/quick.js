// Quick cost entry: a private, unguessable, write-only link per user.
// Managers open it, type an amount, tap a category, done — no login screen.
// The page can only CREATE one-off costs; it exposes no business data.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('../db');
const { requireOwner } = require('../auth');
const { num, bool01 } = require('../lib/parse');
const { badDate } = require('../lib/dates');

const RECEIPT_DIR = path.join(DATA_DIR, 'receipts');

// Local "today" (Mexico City, UTC-6 year-round unless overridden).
const TZ_OFFSET_H = Number(process.env.TZ_OFFSET_HOURS ?? -6);
const todayLocal = () => new Date(Date.now() + TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10);

// ---- link resolution ----
function linkByToken(token) {
  const link = db.prepare(
    `SELECT q.token, q.active, u.id user_id, u.name, u.role
     FROM quick_links q JOIN users u ON u.id = q.user_id
     WHERE q.token = ?`).get(String(token || ''));
  if (!link || !link.active) return null;
  link.locations = link.role === 'owner'
    ? db.prepare('SELECT id, name FROM locations WHERE active = 1 ORDER BY name').all()
    : db.prepare(
      `SELECT l.id, l.name FROM locations l JOIN user_locations ul ON ul.location_id = l.id
       WHERE ul.user_id = ? AND l.active = 1 ORDER BY l.name`).all(link.user_id);
  return link.locations.length ? link : null;
}

// ---- simple per-token rate limit: 30 submissions per hour ----
const hits = new Map();
function rateLimited(token) {
  const now = Date.now();
  const list = (hits.get(token) || []).filter(t => now - t < 3600e3);
  if (list.length >= 30) { hits.set(token, list); return true; }
  list.push(now);
  hits.set(token, list);
  return false;
}

// ---- the page (neutral: no restaurant name, nothing to see) ----
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function quickPage(link) {
  const cats = db.prepare(
    `SELECT DISTINCT name, default_invoiced FROM variable_cost_categories
     WHERE location_id IN (${link.locations.map(() => '?').join(',')}) AND active = 1
     ORDER BY position`).all(...link.locations.map(l => l.id));
  const meta = {
    locations: link.locations,
    categories: [...cats.map(c => ({ name: c.name, invoiced: !!c.default_invoiced })), { name: 'Otro gasto', invoiced: false }]
  };
  return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Registro</title>
<style>
  :root{--g:#1a7f5a;--ink:#1e2a26;--line:#e3e9e6;--muted:#64756e}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f7f6;color:var(--ink);
    margin:0;padding:16px;display:flex;justify-content:center;min-height:100dvh;box-sizing:border-box}
  .w{max-width:420px;width:100%}
  .amt{width:100%;box-sizing:border-box;font-size:42px;font-weight:800;text-align:center;border:2px solid var(--line);
    border-radius:16px;padding:16px;margin-bottom:14px}
  .amt:focus{outline:none;border-color:var(--g)}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
  .chip{border:1.5px solid var(--line);background:#fff;border-radius:999px;padding:10px 14px;font-size:14px;
    font-weight:600;cursor:pointer}
  .chip.on{background:var(--g);border-color:var(--g);color:#fff}
  .row{display:flex;gap:10px;align-items:center;justify-content:space-between;background:#fff;border-radius:12px;
    padding:12px 14px;margin-bottom:10px;font-size:15px;font-weight:600}
  .row input[type=checkbox]{width:22px;height:22px;accent-color:var(--g)}
  .row input[type=date]{border:0;font-size:15px;font-weight:600;color:var(--ink);background:transparent;text-align:right}
  select,textarea{width:100%;box-sizing:border-box;border:1.5px solid var(--line);border-radius:12px;padding:12px;
    font-size:15px;font-family:inherit;margin-bottom:10px;background:#fff}
  .btn{width:100%;border:0;background:var(--g);color:#fff;border-radius:14px;padding:18px;font-size:18px;
    font-weight:800;cursor:pointer}
  .btn:disabled{opacity:.5}
  .photo{display:block;text-align:center;color:var(--muted);font-size:14px;font-weight:600;padding:10px;
    border:1.5px dashed var(--line);border-radius:12px;margin-bottom:12px;cursor:pointer;background:#fff}
  .photo.has{border-color:var(--g);color:var(--g)}
  #ok{position:fixed;inset:0;background:var(--g);color:#fff;display:none;align-items:center;justify-content:center;
    flex-direction:column;font-size:34px;font-weight:800;z-index:9}
  .hint{color:var(--muted);font-size:12px;text-align:center;margin-top:10px}
  .err{color:#c0392b;font-size:14px;text-align:center;min-height:1.2em;margin-top:8px}
</style></head><body>
<div class="w">
  <form id="f">
    <input class="amt" id="amount" type="number" inputmode="decimal" step="any" min="0.01" placeholder="$0" autofocus required>
    <div class="chips" id="chips"></div>
    ${meta.locations.length > 1 ? `<select id="loc">${meta.locations.map(l =>
      `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>` : ''}
    <div class="row"><span>Con factura</span><input type="checkbox" id="inv"></div>
    <div class="row"><span>Fecha</span><input type="date" id="date" max="${todayLocal()}" value="${todayLocal()}"></div>
    <textarea id="note" rows="1" placeholder="Nota (opcional)"></textarea>
    <label class="photo" id="photoBtn">📷 Foto del ticket (opcional)
      <input type="file" id="photo" accept="image/*" capture="environment" hidden></label>
    <button class="btn" type="submit">Guardar</button>
    <p class="err" id="err"></p>
    <p class="hint">Solo registra gastos. Nada más.</p>
  </form>
</div>
<div id="ok">✅<div style="font-size:22px;margin-top:8px">Guardado</div></div>
<script>
const META = ${JSON.stringify(meta)};
const chipsEl = document.getElementById('chips');
let selected = null;
META.categories.forEach(c => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'chip'; b.textContent = c.name;
  b.onclick = () => {
    selected = c;
    [...chipsEl.children].forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    document.getElementById('inv').checked = c.invoiced;
  };
  chipsEl.appendChild(b);
});
let photoData = null;
const photoInput = document.getElementById('photo');
document.getElementById('photoBtn').onclick = () => photoInput.click();
photoInput.onchange = () => {
  const f = photoInput.files[0];
  if (!f) return;
  if (f.size > 6 * 1024 * 1024) { document.getElementById('err').textContent = 'Foto muy grande (máx 6MB)'; return; }
  const r = new FileReader();
  r.onload = () => { photoData = r.result.split(',')[1]; document.getElementById('photoBtn').classList.add('has');
    document.getElementById('photoBtn').firstChild.textContent = '📷 Foto lista ✓ '; };
  r.readAsDataURL(f);
};
const savedLoc = localStorage.getItem('q_loc');
const locSel = document.getElementById('loc');
if (locSel && savedLoc && [...locSel.options].some(o => o.value === savedLoc)) locSel.value = savedLoc;
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  if (!selected) { err.textContent = 'Elige una categoría'; return; }
  const note = document.getElementById('note').value.trim();
  if (selected.name === 'Otro gasto' && !note) { err.textContent = 'Para "Otro gasto" escribe una nota'; return; }
  const btn = e.target.querySelector('.btn'); btn.disabled = true;
  try {
    const res = await fetch(location.pathname + '/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: Number(document.getElementById('amount').value),
        category: selected.name, note,
        invoiced: document.getElementById('inv').checked,
        date: document.getElementById('date').value,
        location_id: locSel ? Number(locSel.value) : META.locations[0].id,
        receipt_base64: photoData
      })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Error');
    if (locSel) localStorage.setItem('q_loc', locSel.value);
    const ok = document.getElementById('ok');
    ok.style.display = 'flex';
    setTimeout(() => {
      ok.style.display = 'none';
      document.getElementById('amount').value = '';
      document.getElementById('note').value = '';
      photoData = null; photoInput.value = '';
      document.getElementById('photoBtn').classList.remove('has');
      document.getElementById('photoBtn').firstChild.textContent = '📷 Foto del ticket (opcional) ';
      selected = null; [...chipsEl.children].forEach(x => x.classList.remove('on'));
      document.getElementById('amount').focus();
    }, 1300);
  } catch (ex) { err.textContent = ex.message; }
  btn.disabled = false;
};
</script></body></html>`;
}

// ---- routes ----
function publicRoutes(r) {
  // (mounted on the app, not under /api — see pagesRouter below)
}

function pagesRouter() {
  const express = require('express');
  const router = express.Router();

  router.get('/go/:token', (req, res) => {
    const link = linkByToken(req.params.token);
    if (!link) return res.status(404).send('<!DOCTYPE html><meta charset="utf8"><title>404</title><p style="font-family:sans-serif;text-align:center;margin-top:30vh">Enlace no válido.</p>');
    res.send(quickPage(link));
  });

  router.post('/go/:token/submit', (req, res) => {
    const link = linkByToken(req.params.token);
    if (!link) return res.status(404).json({ error: 'Enlace no válido' });
    if (rateLimited(link.token)) return res.status(429).json({ error: 'Demasiados registros — espera un momento' });

    const b = req.body || {};
    const amount = num(b.amount);
    if (amount <= 0) return res.status(400).json({ error: 'Falta el monto' });
    if (amount > 1_000_000) return res.status(400).json({ error: 'Monto demasiado grande' });
    const locId = Number(b.location_id);
    if (!link.locations.some(l => l.id === locId)) return res.status(403).json({ error: 'Ubicación no permitida' });
    const date = !badDate(b.date) && b.date <= todayLocal() ? b.date : todayLocal();
    const category = String(b.category || '').slice(0, 60).trim() || 'Gasto';
    const note = String(b.note || '').slice(0, 200).trim();
    const description = note && category !== 'Otro gasto' ? `${category} — ${note}`
      : note ? note : category;

    const { lastInsertRowid } = db.prepare(
      `INSERT INTO oneoff_costs (location_id, date, description, amount, invoiced, logged_by)
       VALUES (?,?,?,?,?,?)`)
      .run(locId, date, description, amount, bool01(b.invoiced), link.name);

    if (b.receipt_base64 && typeof b.receipt_base64 === 'string' && b.receipt_base64.length < 8.5e6) {
      try {
        fs.mkdirSync(RECEIPT_DIR, { recursive: true });
        const file = `${Number(lastInsertRowid)}.jpg`;
        fs.writeFileSync(path.join(RECEIPT_DIR, file), Buffer.from(b.receipt_base64, 'base64'));
        db.prepare('UPDATE oneoff_costs SET receipt = ? WHERE id = ?').run(file, Number(lastInsertRowid));
      } catch (e) { console.error('receipt save:', e.message); }
    }
    res.json({ ok: true });
  });

  return router;
}

// ---- owner management (behind auth) ----
function staffRoutes(r) {
  // Receipt viewing for any authorized user of that location.
  r.get('/oneoff/:id/receipt', (req, res) => {
    const cost = db.prepare('SELECT location_id, receipt FROM oneoff_costs WHERE id = ?')
      .get(Number(req.params.id));
    if (!cost || !cost.receipt || !req.user.locationIds.includes(cost.location_id))
      return res.status(404).json({ error: 'No receipt' });
    const file = path.join(RECEIPT_DIR, path.basename(cost.receipt));
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'No receipt' });
    res.set('Content-Type', 'image/jpeg');
    res.send(fs.readFileSync(file));
  });

  r.get('/quick-links', requireOwner, (req, res) => {
    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const rows = db.prepare(
      `SELECT q.token, q.active, q.created_at, u.id user_id, u.name
       FROM quick_links q JOIN users u ON u.id = q.user_id`).all();
    res.json(rows.map(x => ({ ...x, url: `${base}/go/${x.token}` })));
  });

  r.post('/quick-links/:userId', requireOwner, (req, res) => {
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(req.params.userId));
    if (!user) return res.status(404).json({ error: 'Not found' });
    const token = crypto.randomBytes(24).toString('base64url');
    db.prepare(`INSERT INTO quick_links (token, user_id, active) VALUES (?,?,1)
      ON CONFLICT (user_id) DO UPDATE SET token = excluded.token, active = 1, created_at = datetime('now')`)
      .run(token, user.id);
    const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ url: `${base}/go/${token}` });
  });

  r.delete('/quick-links/:userId', requireOwner, (req, res) => {
    db.prepare('UPDATE quick_links SET active = 0 WHERE user_id = ?').run(Number(req.params.userId));
    res.json({ ok: true });
  });
}

module.exports = { pagesRouter, staffRoutes, publicRoutes };
