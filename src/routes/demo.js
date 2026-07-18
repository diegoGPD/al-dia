// Demo-only routes. Every endpoint hard-checks DEMO_MODE so this file is
// completely inert on the real deployment.
const demoOnly = (req, res, next) => {
  if (process.env.DEMO_MODE !== '1') return res.status(404).json({ error: 'Not found' });
  next();
};

module.exports = (r) => {
  r.post('/demo/reset', demoOnly, (req, res) => {
    require('../demo/seed').seed();
    res.json({ ok: true });
  });

  r.post('/demo/simulate-order', demoOnly, async (req, res) => {
    try {
      const locationId = Number(req.body.location_id) || 1;
      res.json(await require('../demo/seed').simulateOrder(locationId));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
