// Shared request-parsing helpers.
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const bool01 = v =>
  (v === true || v === 1 || v === '1' || v === 'true' || v === 'yes' || v === 'si' || v === 'sí') ? 1 : 0;

module.exports = { num, bool01 };
