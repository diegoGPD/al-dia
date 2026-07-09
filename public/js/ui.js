/* Al Día — shared UI helpers used by every view module */
'use strict';
App.ui = (() => {
  const { api, state, render, money, esc, fmtDate, fmtRange, today, addDays, addMonths, toast } = App;

  const isOwner = () => state.me?.user.role === 'owner';
  const qLoc = () => `location=${state.locationId}`;

  // ---- simple bottom-sheet modal ----
  function modal(html, onBind) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal">${html}</div>`;
    wrap.onclick = e => { if (e.target === wrap) wrap.remove(); };
    document.body.appendChild(wrap);
    onBind(wrap, () => wrap.remove());
  }

  // ---- period switcher (day/week/month + prev/next) ----
  function periodBar(d) {
    const label = state.granularity === 'day' ? fmtDate(state.anchor, { weekday: 'long', month: 'long', day: 'numeric' })
      : state.granularity === 'week' ? fmtRange(d.current.start, d.current.periodEnd || d.current.end)
      : new Date(state.anchor + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    return `
    <div class="period-bar">
      <div class="seg">
        ${['day', 'week', 'month'].map(g =>
          `<button class="seg-btn ${state.granularity === g ? 'on' : ''}" data-gran="${g}">${g[0].toUpperCase() + g.slice(1)}</button>`).join('')}
      </div>
      <div class="period-nav">
        <button class="icon-btn" id="prevPeriod" aria-label="Previous">‹</button>
        <span class="period-label">${esc(label)}</span>
        <button class="icon-btn" id="nextPeriod" aria-label="Next">›</button>
        ${state.anchor !== today() ? '<button class="btn tiny" id="goToday">Today</button>' : ''}
      </div>
    </div>`;
  }

  function bindPeriodBar(app) {
    // Only the day/week/month buttons — not other .seg-btn elements like the
    // Costs/Accounts sub-tabs, whose handlers this would otherwise overwrite.
    app.querySelectorAll('.seg-btn[data-gran]').forEach(b => b.onclick = () => {
      state.granularity = b.dataset.gran;
      localStorage.setItem('aldia_gran', b.dataset.gran);
      render();
    });
    const move = dir => {
      state.anchor = state.granularity === 'month' ? addMonths(state.anchor, dir)
        : addDays(state.anchor, dir * (state.granularity === 'week' ? 7 : 1));
      render();
    };
    app.querySelector('#prevPeriod').onclick = () => move(-1);
    app.querySelector('#nextPeriod').onclick = () => move(1);
    const t = app.querySelector('#goToday');
    if (t) t.onclick = () => { state.anchor = today(); render(); };
  }

  const fetchDashboard = () =>
    api(`/dashboard?${qLoc()}&granularity=${state.granularity}&date=${state.anchor}`);

  // ---- SVG trend chart, no dependencies ----
  function trendChart(rows) {
    const W = 640, H = 200, PAD = { l: 8, r: 8, t: 10, b: 22 };
    const max = Math.max(...rows.map(r => Math.max(r.revenue, r.costs)), 1);
    const x = i => PAD.l + i * (W - PAD.l - PAD.r) / (rows.length - 1);
    const y = v => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
    const line = key => rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[key]).toFixed(1)}`).join('');
    const area = `M${x(0)},${y(rows[0].revenue)} ${rows.map((r, i) => `L${x(i)},${y(r.revenue)}`).join(' ')} L${x(rows.length - 1)},${H - PAD.b} L${x(0)},${H - PAD.b} Z`;
    const labels = [0, Math.floor(rows.length / 2), rows.length - 1].map(i =>
      `<text x="${x(i)}" y="${H - 6}" class="ch-label" text-anchor="${i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle'}">${fmtDate(rows[i].date, { month: 'short', day: 'numeric' })}</text>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="none" role="img" aria-label="Revenue vs costs, last 30 days">
      <line x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}" class="ch-axis"/>
      <path d="${area}" class="ch-area"/>
      <path d="${line('revenue')}" class="ch-line rev"/>
      <path d="${line('costs')}" class="ch-line cost"/>
      ${labels}
    </svg>`;
  }

  // ---- shared "move this day's log to another date" dialog ----
  function moveDayDialog(what, fromDate, doMove) {
    modal(`
      <h3>Move ${what}</h3>
      <p class="hint">Everything logged on ${fmtDate(fromDate)} moves to the date you pick.</p>
      <form id="moveForm">
        <label>New date<input type="date" name="to" value="${fromDate}" max="${today()}" required></label>
        <div class="modal-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn primary">Move</button>
        </div>
      </form>`, (wrap, close) => {
      wrap.querySelector('[data-close]').onclick = close;
      wrap.querySelector('#moveForm').onsubmit = async e => {
        e.preventDefault();
        const to = new FormData(e.target).get('to');
        if (to === fromDate) { close(); return; }
        try { await doMove(to); close(); toast('Moved to ' + fmtDate(to)); render(); }
        catch (err) { toast(err.message, true); }
      };
    });
  }

  return { isOwner, qLoc, modal, periodBar, bindPeriodBar, fetchDashboard, trendChart, moveDayDialog };
})();
