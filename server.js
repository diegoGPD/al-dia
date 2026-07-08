// Al Día — restaurant profitability tracker
const express = require('express');
const path = require('node:path');
const api = require('./src/api');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.use('/api', api);

// Static frontend
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// JSON errors, no stack traces to clients
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Al Día running on port ${PORT}`));
