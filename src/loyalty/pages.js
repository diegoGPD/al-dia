// Customer-facing pages (public, Spanish): signup, the live card, printable QR.
const express = require('express');
const loyalty = require('./state');
const passkit = require('./passkit');
const gwallet = require('./google');

const router = express.Router();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';

const page = (title, body) => `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f7f6;color:#1e2a26;
    margin:0;display:flex;justify-content:center;min-height:100dvh;padding:20px;box-sizing:border-box}
  .card{background:#fff;border-radius:18px;box-shadow:0 1px 3px rgba(20,40,32,.12);padding:26px;max-width:420px;width:100%;
    align-self:flex-start;margin-top:4vh}
  h1{color:#1a7f5a;font-size:26px;margin:0 0 4px;text-align:center}
  .sub{color:#64756e;text-align:center;margin:0 0 20px;font-size:14px}
  label{display:block;font-size:14px;font-weight:600;margin-bottom:12px}
  input{display:block;width:100%;box-sizing:border-box;margin-top:5px;border:1px solid #e3e9e6;border-radius:10px;
    padding:12px;font-size:16px}
  .btn{display:block;width:100%;box-sizing:border-box;border:0;background:#1a7f5a;color:#fff;border-radius:11px;
    padding:14px;font-size:16px;font-weight:700;cursor:pointer;text-align:center;text-decoration:none;margin-top:6px}
  .btn.ghost{background:#fff;color:#c0392b;border:1px solid #e3e9e6;font-weight:600;font-size:13px;padding:10px}
  .hint{color:#64756e;font-size:12px;line-height:1.5}
  .err{color:#c0392b;font-size:14px;min-height:1.2em;margin:8px 0 0}
  .stamps{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:18px 0}
  .stamp{width:34px;height:34px;border-radius:50%;border:2px solid #1a7f5a;display:flex;align-items:center;
    justify-content:center;font-size:17px;color:#fff;background:#fff}
  .stamp.on{background:#1a7f5a}
  .reward{background:#e6f4ee;border:1px solid #1a7f5a;border-radius:12px;padding:14px;text-align:center;
    font-weight:700;color:#14684a;margin:14px 0}
  #qr{display:flex;justify-content:center;margin:18px 0}
  #qr img,#qr canvas{border:10px solid #fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.15)}
  .code{letter-spacing:2px;text-align:center;color:#64756e;font-size:13px;margin-bottom:14px}
  @media print{.no-print{display:none}body{background:#fff}.card{box-shadow:none}}
</style></head><body><div class="card">${body}</div>
</body></html>`;

// ---- signup ----
router.get('/loyalty/join', (req, res) => {
  const cfg = loyalty.config();
  if (!cfg.active) return res.send(page('Programa de lealtad', `<h1>${esc(cfg.program_name)}</h1><p class="sub">El programa no está activo por el momento. ¡Vuelve pronto!</p>`));
  res.send(page(`Únete a ${cfg.program_name}`, `
    <h1>${esc(cfg.program_name)}</h1>
    <p class="sub">Junta ${cfg.stamps_needed} sellos y llévate: <strong>${esc(cfg.reward_text)}</strong></p>
    <form id="f">
      <label>Tu nombre<input name="name" required autocomplete="name"></label>
      <label>Teléfono <span class="hint">(o correo, uno de los dos)</span><input name="phone" type="tel" autocomplete="tel"></label>
      <label>Correo<input name="email" type="email" autocomplete="email"></label>
      <button class="btn" type="submit">Crear mi tarjeta</button>
      <p class="err" id="err"></p>
      <p class="hint">Solo usamos tus datos para el programa de lealtad. Puedes borrar tu tarjeta y tus datos cuando quieras desde la propia tarjeta.</p>
    </form>
    <script>
      document.getElementById('f').onsubmit = async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const r = await fetch('/api/loyalty/signup', { method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ name:f.get('name'), phone:f.get('phone'), email:f.get('email') }) });
        const d = await r.json();
        if (!r.ok) { document.getElementById('err').textContent = d.error; return; }
        location.href = d.cardUrl;
      };
    </script>`));
});

// ---- the live card ----
router.get('/card/:code', (req, res) => {
  const customer = loyalty.customerByCode(req.params.code);
  if (!customer) return res.status(404).send(page('Tarjeta', '<h1>Tarjeta no encontrada</h1><p class="sub">Puede que haya sido eliminada.</p>'));
  const s = loyalty.stateOf(customer);
  const stamps = Array.from({ length: s.stampsNeeded }, (_, i) =>
    `<div class="stamp ${i < s.stamps ? 'on' : ''}">${i < s.stamps ? '✓' : ''}</div>`).join('');
  res.send(page(`Tu tarjeta — ${s.programName}`, `
    <h1>${esc(s.programName)}</h1>
    <p class="sub">Hola, <strong>${esc(s.name)}</strong> · ${s.visits} visita${s.visits === 1 ? '' : 's'}</p>
    ${s.rewardsAvailable > 0
      ? `<div class="reward">🎁 ${esc(s.rewardText)} — ¡lista para canjear${s.rewardsAvailable > 1 ? ` (×${s.rewardsAvailable})` : ''}! Muéstrala en caja.</div>`
      : `<p class="sub">Te faltan <strong>${s.toNext}</strong> para: ${esc(s.rewardText)}</p>`}
    <div class="stamps">${stamps}</div>
    <div id="qr"></div>
    <div class="code">${esc(s.code)}</div>
    <p class="hint" style="text-align:center">Muestra este código en caja en cada visita.</p>
    ${passkit.appleReady() ? `<a class="btn" href="/api/loyalty/pass/${esc(s.code)}">📲 Agregar a Apple Wallet</a>` : ''}
    ${gwallet.googleReady() ? `<a class="btn" style="background:#1f1f1f" href="/api/loyalty/gpay/${esc(s.code)}">📲 Guardar en Google Wallet</a>` : ''}
    <p class="hint no-print" style="margin-top:16px">💡 Guarda esta página en tu pantalla de inicio para tenerla siempre a la mano. Se actualiza sola en cada visita.</p>
    <button class="btn ghost no-print" id="del">Borrar mi tarjeta y mis datos</button>
    <script src="${QR_LIB}"></script>
    <script>
      new QRCode(document.getElementById('qr'), { text: ${JSON.stringify(s.code)}, width: 180, height: 180 });
      document.getElementById('del').onclick = async () => {
        if (!confirm('¿Borrar tu tarjeta y todos tus datos? Perderás tus sellos.')) return;
        await fetch('/api/loyalty/optout', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ code: ${JSON.stringify(s.code)} }) });
        alert('Listo. Tus datos fueron eliminados.');
        location.href = '/loyalty/join';
      };
    </script>`));
});

// ---- printable signup QR (table tent / counter sign) ----
router.get('/loyalty/qr', (req, res) => {
  const cfg = loyalty.config();
  const joinUrl = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`) + '/loyalty/join';
  res.send(page(`QR — ${cfg.program_name}`, `
    <h1>${esc(cfg.program_name)}</h1>
    <p class="sub">Escanea y junta sellos.<br>Cada ${cfg.stamps_needed} visitas: <strong>${esc(cfg.reward_text)}</strong></p>
    <div id="qr"></div>
    <p class="hint" style="text-align:center">${esc(joinUrl)}</p>
    <button class="btn no-print" onclick="print()">🖨 Imprimir</button>
    <script src="${QR_LIB}"></script>
    <script>new QRCode(document.getElementById('qr'), { text: ${JSON.stringify(joinUrl)}, width: 240, height: 240 });</script>`));
});

module.exports = router;
