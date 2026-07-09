// Shared date helpers. All dates are YYYY-MM-DD strings, handled UTC-safe.
const d2u = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const u2d = ms => new Date(ms).toISOString().slice(0, 10);

const addDays = (s, n) => u2d(d2u(s) + n * 864e5);
const daysBetween = (a, b) => Math.round((d2u(b) - d2u(a)) / 864e5);
const todayStr = () => new Date().toISOString().slice(0, 10);
const dow = s => new Date(d2u(s)).getUTCDay();               // 0 = Sunday
const mondayOf = s => addDays(s, -((dow(s) + 6) % 7));

// Period bounds for day/week/month around an anchor date. Weeks start Monday.
function periodBounds(granularity, anchor) {
  if (granularity === 'day') return { start: anchor, end: anchor };
  if (granularity === 'week') {
    const start = mondayOf(anchor);
    return { start, end: addDays(start, 6) };
  }
  const start = anchor.slice(0, 8) + '01';
  const next = new Date(Date.UTC(+anchor.slice(0, 4), +anchor.slice(5, 7), 1));
  return { start, end: u2d(next.getTime() - 864e5) };
}

function prevPeriodAnchor(granularity, anchor) {
  if (granularity === 'day') return addDays(anchor, -1);
  if (granularity === 'week') return addDays(anchor, -7);
  return u2d(Date.UTC(+anchor.slice(0, 4), +anchor.slice(5, 7) - 2, 1));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const badDate = d => !d || !DATE_RE.test(d);

module.exports = { addDays, daysBetween, todayStr, dow, mondayOf, periodBounds, prevPeriodAnchor, badDate };
