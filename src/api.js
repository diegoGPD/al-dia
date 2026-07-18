// API index: mounts the public session routes, then the auth wall,
// then every authenticated module. Paths are defined inside each module.
const express = require('express');
const { requireAuth } = require('./auth');

const r = express.Router();

require('./routes/session')(r);   // status, setup, login, logout (public)
require('./routes/loyalty').publicRoutes(r); // customer signup/card/pass + PassKit web service
require('./routes/webhooks').publicRoutes(r); // tokened POS inbound webhook

r.use(requireAuth);               // everything below needs a session

require('./routes/loyalty').staffRoutes(r);  // scan visits, redeem, program config
require('./routes/webhooks').staffRoutes(r); // webhook URL + event log (owner)
require('./routes/quick').staffRoutes(r);    // quick-link management + receipts
require('./routes/demo')(r);                 // demo-only: reset + order simulator (inert unless DEMO_MODE=1)

require('./routes/admin')(r);     // me, locations, users, maintenance
require('./routes/categories')(r);// the four configurable groups
require('./routes/logs')(r);      // revenue, day costs, recurring, one-offs, import
require('./routes/money')(r);     // accounts view, transfers, balance corrections
require('./routes/team')(r);      // roster + weekly schedule
require('./routes/analytics')(r); // dashboard, forecast, insights, goals, compare

module.exports = r;
