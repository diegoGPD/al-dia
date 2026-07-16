// Al Día — restaurant profitability tracker
const express = require('express');
const path = require('node:path');
const api = require('./src/api');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Railway/other proxies: honor X-Forwarded-Proto
app.use(express.json({ limit: '10mb' })); // receipt photos ride in JSON

app.use('/api', api);
app.use(require('./src/loyalty/pages')); // public: /loyalty/join, /card/:code, /loyalty/qr
app.use(require('./src/routes/quick').pagesRouter()); // public: /go/:token quick cost entry

// Static frontend
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// JSON errors, no stack traces to clients
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

// PideDirecto reconciliation safety net (no-op until API key + store id exist)
require('./src/integrations/pidedirecto').startReconciler();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Al Día running on port ${PORT}`));
