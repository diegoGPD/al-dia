// Loyalty API. `publicRoutes` mounts before the auth wall (customer-facing +
// Apple's PassKit web service); `staffRoutes` mounts behind it.
const { db } = require('../db');
const { requireOwner, checkLocation } = require('../auth');
const loyalty = require('../loyalty/state');
const passkit = require('../loyalty/passkit');
const gwallet = require('../loyalty/google');

const baseUrl = req => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

function publicRoutes(r) {
  r.post('/loyalty/signup', (req, res) => {
    const cfg = loyalty.config();
    if (!cfg.active) return res.status(403).json({ error: 'El programa no está activo por ahora' });
    const { name, phone, email } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Tu nombre es necesario' });
    if (!(phone || '').trim() && !(email || '').trim())
      return res.status(400).json({ error: 'Deja un teléfono o un correo' });
    const customer = loyalty.createCustomer({ name, phone, email });
    res.json({ code: customer.code, cardUrl: `${baseUrl(req)}/card/${customer.code}` });
  });

  // Self-service data deletion (privacy requirement).
  r.post('/loyalty/optout', (req, res) => {
    const customer = loyalty.customerByCode(req.body.code);
    if (!customer) return res.status(404).json({ error: 'Tarjeta no encontrada' });
    loyalty.deleteCustomer(customer);
    res.json({ ok: true });
  });

  // Apple Wallet pass download
  r.get('/loyalty/pass/:code', (req, res) => {
    if (!passkit.appleReady()) return res.status(503).json({ error: 'Apple Wallet not configured yet' });
    const customer = loyalty.customerByCode(req.params.code);
    if (!customer) return res.status(404).json({ error: 'Not found' });
    try {
      const buf = passkit.buildPkpass(customer, loyalty.stateOf(customer), baseUrl(req));
      res.set('Content-Type', 'application/vnd.apple.pkpass');
      res.set('Content-Disposition', `attachment; filename="${customer.code}.pkpass"`);
      res.send(buf);
    } catch (e) {
      console.error('pkpass build:', e.message);
      res.status(500).json({ error: 'Could not build the pass — check certificates' });
    }
  });

  // Save to Google Wallet
  r.get('/loyalty/gpay/:code', async (req, res) => {
    if (!gwallet.googleReady()) return res.status(503).json({ error: 'Google Wallet not configured yet' });
    const customer = loyalty.customerByCode(req.params.code);
    if (!customer) return res.status(404).json({ error: 'Not found' });
    try { res.redirect(await gwallet.saveLink(customer, loyalty.stateOf(customer))); }
    catch (e) { console.error('gpay link:', e.message); res.status(500).json({ error: 'Google Wallet error' }); }
  });

  // ---- Apple PassKit web service (spec-defined paths & auth) ----
  const passAuth = (req, res) => {
    const token = (req.get('Authorization') || '').replace('ApplePass ', '');
    const customer = loyalty.customerByCode(req.params.serial);
    if (!customer || customer.auth_token !== token) { res.status(401).end(); return null; }
    return customer;
  };

  r.post('/passes/v1/devices/:deviceId/registrations/:passTypeId/:serial', (req, res) => {
    const customer = passAuth(req, res);
    if (!customer) return;
    const existing = db.prepare('SELECT 1 x FROM wallet_registrations WHERE device_id = ? AND serial = ?')
      .get(req.params.deviceId, req.params.serial);
    db.prepare(`INSERT INTO wallet_registrations (device_id, push_token, serial) VALUES (?,?,?)
      ON CONFLICT (device_id, serial) DO UPDATE SET push_token = excluded.push_token`)
      .run(req.params.deviceId, req.body.pushToken, req.params.serial);
    res.status(existing ? 200 : 201).end();
  });

  r.delete('/passes/v1/devices/:deviceId/registrations/:passTypeId/:serial', (req, res) => {
    const customer = passAuth(req, res);
    if (!customer) return;
    db.prepare('DELETE FROM wallet_registrations WHERE device_id = ? AND serial = ?')
      .run(req.params.deviceId, req.params.serial);
    res.status(200).end();
  });

  r.get('/passes/v1/devices/:deviceId/registrations/:passTypeId', (req, res) => {
    const since = req.query.passesUpdatedSince || '';
    const rows = db.prepare(
      `SELECT c.code, c.updated_at FROM wallet_registrations w
       JOIN customers c ON c.code = w.serial WHERE w.device_id = ?`).all(req.params.deviceId);
    const updated = rows.filter(x => !since || x.updated_at > since);
    if (!updated.length) return res.status(204).end();
    const lastUpdated = updated.map(x => x.updated_at).sort().pop();
    res.json({ serialNumbers: updated.map(x => x.code), lastUpdated });
  });

  r.get('/passes/v1/passes/:passTypeId/:serial', (req, res) => {
    const customer = passAuth(req, res);
    if (!customer) return;
    if (!passkit.appleReady()) return res.status(503).end();
    const buf = passkit.buildPkpass(customer, loyalty.stateOf(customer), baseUrl(req));
    res.set('Content-Type', 'application/vnd.apple.pkpass');
    res.set('Last-Modified', new Date(customer.updated_at + 'Z').toUTCString());
    res.send(buf);
  });

  r.post('/passes/v1/log', (req, res) => {
    (req.body.logs || []).forEach(l => console.log('PassKit device log:', l));
    res.status(200).end();
  });
}

// Fired after any change that should reach the customer's card.
function notifyCard(customer, state, message) {
  try { passkit.pushUpdate(customer.code); } catch (e) { console.error('APNs:', e.message); }
  gwallet.pushUpdate(customer, state, message); // async, self-catching
}

function staffRoutes(r) {
  // Scan result → stamp a visit
  r.post('/loyalty/visit', checkLocation, (req, res) => {
    const customer = loyalty.customerByCode(req.body.code);
    if (!customer) return res.status(404).json({ error: 'Card not recognized' });
    const result = loyalty.addVisit(customer, req.locationId);
    if (result.ok) {
      notifyCard(customer, result.state, result.justEarned
        ? `🎁 ¡Ganaste ${result.state.rewardText}! Canjéala cuando quieras.`
        : `Sello agregado — ${result.state.toNext} para tu recompensa.`);
    }
    res.json(result);
  });

  r.post('/loyalty/redeem', checkLocation, (req, res) => {
    const customer = loyalty.customerByCode(req.body.code);
    if (!customer) return res.status(404).json({ error: 'Card not recognized' });
    const result = loyalty.redeem(customer, req.locationId);
    if (result.ok) notifyCard(customer, result.state, '¡Recompensa canjeada! Gracias por tu visita.');
    res.json(result);
  });

  r.get('/loyalty/config', (req, res) => {
    const cfg = loyalty.config();
    res.json({
      ...cfg,
      customers: db.prepare('SELECT COUNT(*) c FROM customers').get().c,
      visitsThisMonth: db.prepare(
        `SELECT COUNT(*) c FROM loyalty_visits WHERE visited_at >= date('now','start of month')`).get().c,
      appleReady: passkit.appleReady(),
      appleCert: passkit.certInfo(),
      googleReady: gwallet.googleReady(),
      joinUrl: `${baseUrl(req)}/loyalty/join`
    });
  });

  r.put('/loyalty/config', requireOwner, (req, res) => {
    const b = req.body, cfg = loyalty.config();
    db.prepare('UPDATE loyalty_config SET program_name=?, stamps_needed=?, reward_text=?, active=? WHERE id=1')
      .run(
        (b.program_name || cfg.program_name).trim(),
        Math.max(2, Math.min(50, Number(b.stamps_needed) || cfg.stamps_needed)),
        (b.reward_text || cfg.reward_text).trim(),
        b.active !== undefined ? (b.active ? 1 : 0) : cfg.active);
    res.json({ ok: true });
  });

  // In-app wallet credential setup (owner). Files land on the server volume;
  // nothing is ever sent back to the browser.
  r.post('/loyalty/wallet-config', requireOwner, async (req, res) => {
    const b = req.body;
    const out = { ok: true };
    try {
      // identifiers
      const cfg = db.prepare('SELECT * FROM loyalty_config WHERE id = 1').get();
      db.prepare('UPDATE loyalty_config SET pass_type_id=?, apple_team_id=?, google_issuer_id=? WHERE id=1')
        .run(
          b.pass_type_id !== undefined ? ((b.pass_type_id || '').trim() || null) : cfg.pass_type_id,
          b.apple_team_id !== undefined ? ((b.apple_team_id || '').trim() || null) : cfg.apple_team_id,
          b.google_issuer_id !== undefined ? ((b.google_issuer_id || '').trim() || null) : cfg.google_issuer_id);
      // Apple: .p12 straight from Keychain, converted server-side
      if (b.p12_base64) {
        if (b.p12_base64.length > 4_000_000) throw new Error('That .p12 file is too large');
        out.appleCert = passkit.importP12(b.p12_base64, b.p12_password || '');
      }
      // Google: service-account key JSON
      if (b.service_account_json) {
        out.serviceAccount = gwallet.saveServiceAccount(b.service_account_json);
      }
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const wwdrOk = await passkit.ensureWwdr();
    out.appleReady = passkit.appleReady();
    out.googleReady = gwallet.googleReady();
    if (out.appleCert && !wwdrOk)
      out.note = "Couldn't download Apple's WWDR certificate yet — save again in a minute.";
    res.json(out);
  });

  r.get('/loyalty/customers', requireOwner, (req, res) => {
    const rows = db.prepare(
      `SELECT c.id, c.code, c.name, c.phone, c.email, c.created_at,
              (SELECT COUNT(*) FROM loyalty_visits v WHERE v.customer_id = c.id) visits,
              (SELECT COUNT(*) FROM loyalty_redemptions x WHERE x.customer_id = c.id) redeemed
       FROM customers c ORDER BY c.created_at DESC LIMIT 200`).all();
    res.json(rows);
  });

  r.delete('/loyalty/customers/:id', requireOwner, (req, res) => {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(req.params.id));
    if (!customer) return res.status(404).json({ error: 'Not found' });
    loyalty.deleteCustomer(customer);
    res.json({ ok: true });
  });
}

module.exports = { publicRoutes, staffRoutes };
