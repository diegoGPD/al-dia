/* Al Día — views */
'use strict';
(() => {
  const { api, state, registerRoute, nav, render, loadMe,
          money, money2, pct, esc, fmtDate, fmtRange, today, addDays, addMonths, toast } = App;

  const isOwner = () => state.me?.user.role === 'owner';
  const qLoc = () => `location=${state.locationId}`;

  // ======================================================================
  // Login & first-run setup
  // ======================================================================
  registerRoute('_login', () => `
    <div class="auth-wrap"><div class="auth-card">
      <h1 class="auth-logo">Al Día</h1>
      <p class="auth-sub">Your restaurant's money, at a glance</p>
      <form id="loginForm">
        <label>Email<input type="email" name="email" required autocomplete="email"></label>
        <label>Password<input type="password" name="password" required autocomplete="current-password"></label>
        <button class="btn primary full" type="submit">Sign in</button>
        <p class="form-error" id="authErr"></p>
      </form>
    </div></div>`);

  registerRoute('_login_bind', (app) => {
    app.querySelector('#loginForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
        await loadMe(); nav('dashboard'); render();
      } catch (err) { app.querySelector('#authErr').textContent = err.message; }
    };
  });

  registerRoute('_setup', () => `
    <div class="auth-wrap"><div class="auth-card">
      <h1 class="auth-logo">Al Día</h1>
      <p class="auth-sub">Welcome! Let's set up your account — takes 30 seconds.</p>
      <form id="setupForm">
        <label>Your name<input name="name" required placeholder="Diego"></label>
        <label>Email<input type="email" name="email" required autocomplete="email"></label>
        <label>Password <span class="hint">(at least 8 characters)</span>
          <input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
        <label>Your restaurant's name<input name="locationName" required placeholder="La Cocina Centro"></label>
        <button class="btn primary full" type="submit">Create my account</button>
        <p class="form-error" id="authErr"></p>
      </form>
    </div></div>`);

  registerRoute('_setup_bind', (app) => {
    app.querySelector('#setupForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('/setup', { method: 'POST', body: {
          name: f.get('name'), email: f.get('email'),
          password: f.get('password'), locationName: f.get('locationName') } });
        await loadMe(); nav('dashboard'); render();
      } catch (err) { app.querySelector('#authErr').textContent = err.message; }
    };
  });

  // ======================================================================
  // Shared period bar (dashboard + costs breakdown)
  // ======================================================================
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
    app.querySelectorAll('.seg-btn').forEach(b => b.onclick = () => {
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

  // ======================================================================
  // Dashboard
  // ======================================================================
  registerRoute('dashboard', async () => {
    const d = await fetchDashboard();
    const c = d.current, p = d.previous, be = d.breakEven;
    const hasData = c.revenue > 0 || c.costs.total > 0;

    // status banner
    let banner;
    if (!hasData) {
      banner = `<div class="status-banner neutral"><div class="status-title">No data yet for this period</div>
        <div class="status-sub">Log your sales and costs to see how you're doing.</div></div>`;
    } else if (be.status === 'above') {
      banner = `<div class="status-banner good"><div class="status-title">✓ Profitable</div>
        <div class="status-sub">You're ${money(be.gap)} above your break-even point.</div></div>`;
    } else if (be.status === 'at') {
      banner = `<div class="status-banner warn"><div class="status-title">≈ At break-even</div>
        <div class="status-sub">You're covering your costs, but not keeping much yet.</div></div>`;
    } else {
      banner = `<div class="status-banner bad"><div class="status-title">Below break-even</div>
        <div class="status-sub">You need ${money(Math.abs(be.gap || 0))} more in sales to cover your costs.</div></div>`;
    }

    // goodWhenDown: for costs, a drop is good news
    const delta = (cur, prev, goodWhenDown) => {
      if (!prev) return '';
      const diff = cur - prev;
      const good = goodWhenDown ? diff <= 0 : diff >= 0;
      return `<span class="delta ${good ? 'up' : 'down'}">${diff >= 0 ? '+' : ''}${money(diff)} vs previous</span>`;
    };

    const beCard = be.salesNeeded !== null && be.salesNeeded > 0 ? `
      <div class="card">
        <div class="card-title">Break-even point</div>
        <div class="be-row"><span>Sales needed to cover all costs</span><strong>${money(be.salesNeeded)}</strong></div>
        <div class="be-row"><span>Your sales so far</span><strong>${money(c.revenue)}</strong></div>
        <div class="progress"><div class="progress-fill ${c.revenue >= be.salesNeeded ? 'good' : ''}"
          style="width:${Math.min(100, be.salesNeeded > 0 ? c.revenue / be.salesNeeded * 100 : 0)}%"></div></div>
        <div class="hint">${be.ratioSource === 'estimated'
          ? 'Estimated from your category defaults — it gets more accurate as you log real costs.'
          : `Based on your fixed costs of ${money(be.fixed)} and variable costs running at ${pct(be.ratio)} of sales.`}</div>
      </div>` : '';

    const bmCard = d.benchmarks.length ? `
      <div class="card">
        <div class="card-title">How you compare to typical restaurants</div>
        ${d.benchmarks.map(b => {
          const flagText = { high: 'Above typical', low: 'Below typical', great: 'Above typical', low_note: 'Below typical', ok: 'In range' }[b.flag];
          const flagCls = { high: 'bad', low: 'bad', great: 'good', low_note: 'warn', ok: 'good' }[b.flag];
          return `<div class="bm-row">
            <div class="bm-name">${b.label}<span class="hint"> · typical ${(b.low * 100).toFixed(0)}–${(b.high * 100).toFixed(0)}%</span></div>
            <div class="bm-val"><strong>${pct(b.value)}</strong> <span class="pill ${flagCls}">${flagText}</span></div>
          </div>`;
        }).join('')}
        <div class="hint">General industry benchmarks, not your targets. Set category tags in Settings so these stay accurate.</div>
      </div>` : '';

    return `
      ${periodBar(d)}
      ${banner}
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-label">Money in</div>
          <div class="stat-value">${money(c.revenue)}</div>${delta(c.revenue, p.revenue)}</div>
        <div class="stat-card"><div class="stat-label">Money out</div>
          <div class="stat-value">${money(c.costs.total)}</div>${delta(c.costs.total, p.costs.total, true)}</div>
        <div class="stat-card wide ${c.profit >= 0 ? 'profit' : 'loss'}">
          <div class="stat-label">What you kept</div>
          <div class="stat-value">${money(c.profit)}</div>
          <div class="stat-sub">${c.revenue > 0 ? `Net margin ${pct(c.netMargin)} · Gross margin ${pct(c.grossMargin)}` : ''} ${delta(c.profit, p.profit)}</div>
        </div>
      </div>
      ${beCard}
      <div class="card">
        <div class="card-title">Last 30 days</div>
        ${trendChart(d.trend)}
        <div class="legend">
          <span><i class="dot rev"></i>Money in</span>
          <span><i class="dot cost"></i>Money out</span>
        </div>
      </div>
      ${bmCard}
      <div class="quick-actions">
        <a class="btn primary" href="#/log-revenue">+ Log sales</a>
        <a class="btn" href="#/log-costs">+ Log costs</a>
      </div>`;
  });
  registerRoute('dashboard_bind', bindPeriodBar);

  // SVG trend chart, no dependencies
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

  // ======================================================================
  // Log hub
  // ======================================================================
  registerRoute('log', async () => `
    <h2 class="page-title">Log something</h2>
    <div class="log-menu">
      <a href="#/log-revenue" class="log-tile"><span class="log-icon">💰</span>
        <div><strong>Sales</strong><div class="hint">What came in today</div></div></a>
      <a href="#/log-costs" class="log-tile"><span class="log-icon">🛒</span>
        <div><strong>Daily costs</strong><div class="hint">Food, packaging, commissions…</div></div></a>
      <a href="#/oneoff" class="log-tile"><span class="log-icon">🔧</span>
        <div><strong>One-off cost</strong><div class="hint">Repairs, permits, anything unusual</div></div></a>
      ${isOwner() ? `<a href="#/recurring" class="log-tile"><span class="log-icon">📅</span>
        <div><strong>Recurring costs</strong><div class="hint">Rent, payroll, utilities — set once</div></div></a>` : ''}
    </div>`);

  // ======================================================================
  // Log revenue
  // ======================================================================
  let revDate = null;
  registerRoute('log-revenue', async () => {
    revDate = revDate || today();
    const [cats, existing] = await Promise.all([
      api(`/categories?${qLoc()}`),
      api(`/revenue?${qLoc()}&date=${revDate}`)
    ]);
    const itemsByCat = Object.fromEntries(existing.items.map(i => [i.category_id, i.amount]));
    const hasBreakdown = existing.items.length > 0;
    return `
      <h2 class="page-title">Log sales</h2>
      <form id="revForm" class="card">
        <label>Date<input type="date" id="revDate" value="${revDate}" max="${today()}"></label>
        <label>Total sales for the day
          <input type="number" inputmode="decimal" step="any" min="0" id="revTotal"
            value="${existing.entry ? existing.entry.total : ''}" placeholder="0" ${hasBreakdown ? 'readonly' : ''}></label>
        <details id="revBreakdown" ${hasBreakdown ? 'open' : ''}>
          <summary>Break it down by channel (recommended)</summary>
          <div class="cat-rows">
            ${cats.revenue.map(c => `
              <label class="cat-row">${esc(c.name)}
                ${c.commission_percent ? `<span class="hint">− ${c.commission_percent}% commission${c.commission_invoiced ? ' (invoiced)' : ''}</span>` : ''}
                <input type="number" inputmode="decimal" step="any" min="0" data-cat="${c.id}"
                  data-pct="${c.commission_percent || 0}"
                  class="rev-item" value="${itemsByCat[c.id] ?? ''}" placeholder="0"></label>`).join('')}
          </div>
          <div class="day-rev" id="commPreview" style="display:none"></div>
          <div class="hint">The total above updates automatically. Commissions are calculated and counted as costs for you.</div>
        </details>
        <button class="btn primary full" type="submit">${existing.entry ? 'Update' : 'Save'} sales</button>
        ${existing.entry ? `<div class="hint center">Already logged for this day — saving replaces it.</div>` : ''}
      </form>`;
  });

  registerRoute('log-revenue_bind', (app) => {
    const dateEl = app.querySelector('#revDate');
    dateEl.onchange = () => { revDate = dateEl.value; render(); };
    const totalEl = app.querySelector('#revTotal');
    const items = [...app.querySelectorAll('.rev-item')];
    const preview = app.querySelector('#commPreview');
    const sync = () => {
      const filled = items.filter(i => i.value !== '' && Number(i.value) !== 0);
      if (filled.length) {
        const total = items.reduce((s, i) => s + (Number(i.value) || 0), 0);
        totalEl.value = total;
        totalEl.readOnly = true;
        const comm = items.reduce((s, i) => s + (Number(i.value) || 0) * (Number(i.dataset.pct) || 0) / 100, 0);
        preview.style.display = comm > 0 ? '' : 'none';
        if (comm > 0) preview.innerHTML =
          `Commissions on these sales: <strong>−${money(comm)}</strong> → you keep about <strong>${money(total - comm)}</strong> before other costs`;
      } else { totalEl.readOnly = false; preview.style.display = 'none'; }
    };
    items.forEach(i => i.oninput = sync);
    sync();
    app.querySelector('#revForm').onsubmit = async (e) => {
      e.preventDefault();
      const breakdown = items
        .filter(i => i.value !== '' && Number(i.value) !== 0)
        .map(i => ({ category_id: Number(i.dataset.cat), amount: Number(i.value) }));
      try {
        const r = await api('/revenue', { method: 'PUT', body: {
          location_id: state.locationId, date: dateEl.value,
          total: Number(totalEl.value) || 0, items: breakdown } });
        toast(`Sales saved — ${money(r.total)}`);
        nav('dashboard');
      } catch (err) { toast(err.message, true); }
    };
  });

  // ======================================================================
  // Log daily (variable) costs
  // ======================================================================
  let costDate = null;
  registerRoute('log-costs', async () => {
    costDate = costDate || today();
    const d = await api(`/costs/day?${qLoc()}&date=${costDate}`);
    const existing = Object.fromEntries(d.existing.map(e => [e.category_id, e]));
    return `
      <h2 class="page-title">Log daily costs</h2>
      <form id="costForm" class="card">
        <label>Date<input type="date" id="costDate" value="${costDate}" max="${today()}"></label>
        <div class="day-rev ${d.dayRevenue === null ? 'muted' : ''}">
          ${d.dayRevenue === null
            ? 'No sales logged for this day yet — % suggestions need that.'
            : `Sales that day: <strong>${money(d.dayRevenue)}</strong>`}
        </div>
        <div class="cat-rows">
          ${d.categories.map(c => {
            const ex = existing[c.id];
            const suggested = c.entry_mode === 'percent' && d.dayRevenue
              ? Math.round(d.dayRevenue * (c.default_percent || 0) / 100) : null;
            const value = ex ? ex.amount : '';
            const invoiced = ex ? ex.invoiced : c.default_invoiced;
            return `
            <div class="cost-row" data-cat="${c.id}">
              <div class="cost-row-top">
                <span class="cost-name">${esc(c.name)}
                  ${c.entry_mode === 'percent' ? `<span class="hint">~${c.default_percent || 0}% of sales</span>` : ''}</span>
                <label class="inv-toggle"><input type="checkbox" class="cost-inv" ${invoiced ? 'checked' : ''}>Invoiced</label>
              </div>
              <input type="number" inputmode="decimal" step="any" min="0" class="cost-amt"
                value="${value}" placeholder="${suggested !== null ? suggested : '0'}"
                ${suggested !== null ? `data-suggest="${suggested}"` : ''}>
              ${suggested !== null && !ex ? `<button type="button" class="btn tiny use-suggest">Use suggestion: ${money(suggested)}</button>` : ''}
            </div>`;
          }).join('')}
        </div>
        <button class="btn primary full" type="submit">Save costs</button>
        <div class="hint center">Leave a row empty if it doesn't apply — empty rows aren't saved.</div>
      </form>`;
  });

  registerRoute('log-costs_bind', (app) => {
    const dateEl = app.querySelector('#costDate');
    dateEl.onchange = () => { costDate = dateEl.value; render(); };
    app.querySelectorAll('.use-suggest').forEach(btn => btn.onclick = () => {
      const row = btn.closest('.cost-row');
      row.querySelector('.cost-amt').value = row.querySelector('.cost-amt').dataset.suggest;
      btn.remove();
    });
    app.querySelector('#costForm').onsubmit = async (e) => {
      e.preventDefault();
      const rows = [...app.querySelectorAll('.cost-row')].map(row => ({
        category_id: Number(row.dataset.cat),
        amount: Number(row.querySelector('.cost-amt').value) || 0,
        invoiced: row.querySelector('.cost-inv').checked
      }));
      try {
        await api('/costs/day', { method: 'PUT', body: { location_id: state.locationId, date: dateEl.value, rows } });
        toast('Costs saved');
        nav('dashboard');
      } catch (err) { toast(err.message, true); }
    };
  });

  // ======================================================================
  // One-off costs
  // ======================================================================
  registerRoute('oneoff', async () => {
    const start = today().slice(0, 8) + '01';
    const list = await api(`/oneoff?${qLoc()}&start=${addDays(start, -60)}&end=${today()}`);
    return `
      <h2 class="page-title">One-off costs</h2>
      <form id="oneoffForm" class="card">
        <label>Date<input type="date" name="date" value="${today()}" max="${today()}" required></label>
        <label>What was it?<input name="description" required placeholder="Fridge repair, health permit…"></label>
        <label>Amount<input type="number" inputmode="decimal" step="any" min="0.01" name="amount" required placeholder="0"></label>
        <label class="inv-toggle big"><input type="checkbox" name="invoiced">This cost is invoiced (facturado)</label>
        <button class="btn primary full" type="submit">Save cost</button>
      </form>
      ${list.length ? `<div class="card">
        <div class="card-title">Recent one-offs</div>
        ${list.map(o => `
          <div class="list-row">
            <div><strong>${esc(o.description)}</strong>
              <div class="hint">${fmtDate(o.date)} · ${o.invoiced ? 'Invoiced' : 'Not invoiced'}</div></div>
            <div class="list-right">${money(o.amount)}
              <button class="icon-btn danger del-oneoff" data-id="${o.id}" aria-label="Delete">✕</button></div>
          </div>`).join('')}
      </div>` : ''}`;
  });

  registerRoute('oneoff_bind', (app) => {
    app.querySelector('#oneoffForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('/oneoff', { method: 'POST', body: {
          location_id: state.locationId, date: f.get('date'),
          description: f.get('description'), amount: Number(f.get('amount')),
          invoiced: f.get('invoiced') === 'on' } });
        toast('Cost saved'); render();
      } catch (err) { toast(err.message, true); }
    };
    app.querySelectorAll('.del-oneoff').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this cost?')) return;
      await api(`/oneoff/${b.dataset.id}?${qLoc()}`, { method: 'DELETE' });
      toast('Deleted'); render();
    });
  });

  // ======================================================================
  // Recurring costs (owner)
  // ======================================================================
  registerRoute('recurring', async () => {
    if (!isOwner()) return '<div class="card">Only the owner can manage recurring costs.</div>';
    const [items, cats] = await Promise.all([
      api(`/recurring?${qLoc()}`), api(`/categories?${qLoc()}`)
    ]);
    const dailyTotal = items.reduce((s, i) => s + i.daily, 0);
    const FREQ = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly' };
    return `
      <h2 class="page-title">Recurring costs</h2>
      <div class="card highlight">
        <div class="be-row"><span>Your fixed costs run at</span>
          <strong>${money(dailyTotal)} / day</strong></div>
        <div class="hint">≈ ${money(dailyTotal * 30.4)} per month. This is what your sales need to cover before profit.</div>
      </div>
      <form id="recForm" class="card">
        <div class="card-title">Add a recurring cost</div>
        <label>Category
          <select name="category_id" required>
            <option value="">Choose…</option>
            ${cats.recurring.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
          </select></label>
        <label>Description<input name="description" required placeholder="Rent for Centro location"></label>
        <div class="row2">
          <label>Amount<input type="number" inputmode="decimal" step="any" min="0.01" name="amount" required placeholder="0"></label>
          <label>How often you pay it
            <select name="frequency">
              <option value="monthly">Monthly</option>
              <option value="biweekly">Every 2 weeks</option>
              <option value="weekly">Weekly</option>
            </select></label>
        </div>
        <label class="inv-toggle big"><input type="checkbox" name="invoiced">Invoiced (facturado)</label>
        <button class="btn primary full" type="submit">Add recurring cost</button>
      </form>
      ${items.length ? `<div class="card">
        <div class="card-title">Current recurring costs</div>
        ${items.map(i => `
          <div class="list-row">
            <div><strong>${esc(i.description)}</strong>
              <div class="hint">${esc(i.category_name)} · ${FREQ[i.frequency]} · ${i.invoiced ? 'Invoiced' : 'Not invoiced'}</div></div>
            <div class="list-right">${money(i.amount)}<div class="hint">${money(i.daily)}/day</div>
              <button class="icon-btn danger del-rec" data-id="${i.id}" aria-label="End">✕</button></div>
          </div>`).join('')}
        <div class="hint">Deleting ends the cost from today — your past numbers stay correct.</div>
      </div>` : ''}`;
  });

  registerRoute('recurring_bind', (app) => {
    const form = app.querySelector('#recForm');
    if (form) form.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('/recurring', { method: 'POST', body: {
          location_id: state.locationId, category_id: Number(f.get('category_id')),
          description: f.get('description'), amount: Number(f.get('amount')),
          frequency: f.get('frequency'), invoiced: f.get('invoiced') === 'on',
          start_date: today() } });
        toast('Recurring cost added'); render();
      } catch (err) { toast(err.message, true); }
    };
    app.querySelectorAll('.del-rec').forEach(b => b.onclick = async () => {
      if (!confirm('End this recurring cost? Past periods keep it; from today it stops counting.')) return;
      await api(`/recurring/${b.dataset.id}?${qLoc()}`, { method: 'DELETE' });
      toast('Ended'); render();
    });
  });

  // ======================================================================
  // Costs breakdown
  // ======================================================================
  registerRoute('breakdown', async () => {
    const d = await fetchDashboard();
    const c = d.current;
    const inv = c.invoiced;
    const invPct = c.costs.total > 0 ? inv.total / c.costs.total : 0;

    const catRows = (obj, isMap) => {
      const entries = isMap
        ? Object.entries(obj).map(([name, v]) => ({ name, amount: v.amount, invoiced: v.invoiced }))
        : obj.map(r => ({ name: r.name, amount: r.amount, invoiced: r.invoiced }));
      return entries.filter(e => e.amount > 0).sort((a, b) => b.amount - a.amount).map(e => `
        <div class="bd-row">
          <div class="bd-name">${esc(e.name)}</div>
          <div class="bd-amt">${money(e.amount)}</div>
          <div class="bd-inv hint">${e.amount > 0 ? Math.round(e.invoiced / e.amount * 100) : 0}% inv.</div>
        </div>`).join('') || '<div class="hint">Nothing in this period.</div>';
    };

    const typeBar = (label, amount, cls) => {
      const w = c.costs.total > 0 ? amount / c.costs.total * 100 : 0;
      return `<div class="type-row"><span>${label}</span><strong>${money(amount)}</strong></div>
        <div class="progress slim"><div class="progress-fill ${cls}" style="width:${w}%"></div></div>`;
    };

    return `
      ${periodBar(d)}
      <div class="card">
        <div class="card-title">Where the money went — ${money(c.costs.total)} total</div>
        ${typeBar('Recurring (rent, payroll…)', c.costs.recurring, 'rec')}
        ${typeBar('Day-to-day (food, supplies…)', c.costs.variable, 'var')}
        ${typeBar('Channel commissions (apps, cards…)', c.costs.commissions, 'comm')}
        ${typeBar('One-offs', c.costs.oneoff, 'one')}
      </div>
      <div class="card">
        <div class="card-title">Invoiced vs not invoiced</div>
        <div class="inv-split">
          <div class="inv-box good"><div class="stat-label">Invoiced (facturado)</div>
            <div class="stat-value small">${money(inv.total)}</div><div class="hint">${pct(invPct)} of all costs</div></div>
          <div class="inv-box warn"><div class="stat-label">Not invoiced</div>
            <div class="stat-value small">${money(inv.notInvoiced)}</div><div class="hint">${pct(1 - invPct)} of all costs</div></div>
        </div>
        <div class="hint">Invoiced portion by type: day-to-day ${money(inv.variable)} · commissions ${money(inv.commissions)} · recurring ${money(inv.recurring)} · one-offs ${money(inv.oneoff)}</div>
      </div>
      <div class="card"><div class="card-title">Commissions by channel</div>
        ${c.costs.commissionsByChannel.length ? c.costs.commissionsByChannel.map(r => `
          <div class="bd-row"><div class="bd-name">${esc(r.name)}<span class="hint"> · on ${money(r.amount)} sold</span></div>
            <div class="bd-amt">${money(r.commission)}</div>
            <div class="bd-inv hint">${r.commission > 0 ? Math.round(r.commission_invoiced / r.commission * 100) : 0}% inv.</div></div>`).join('')
          : '<div class="hint">No commissions this period — they appear when you log sales broken down by channel.</div>'}
      </div>
      <div class="card"><div class="card-title">Day-to-day costs by category</div>${catRows(c.costs.variableByCategory, false)}</div>
      <div class="card"><div class="card-title">Recurring costs by category</div>${catRows(c.costs.recurringByCategory, true)}</div>
      <div class="card"><div class="card-title">One-off costs</div>
        ${c.costs.oneoffItems.length ? c.costs.oneoffItems.map(o => `
          <div class="bd-row"><div class="bd-name">${esc(o.description)}<span class="hint"> · ${fmtDate(o.date)}</span></div>
            <div class="bd-amt">${money(o.amount)}</div>
            <div class="bd-inv hint">${o.invoiced ? 'Inv.' : 'No inv.'}</div></div>`).join('')
          : '<div class="hint">No one-off costs this period.</div>'}
      </div>`;
  });
  registerRoute('breakdown_bind', bindPeriodBar);

  // ======================================================================
  // Settings
  // ======================================================================
  registerRoute('settings', async () => {
    const parts = [`<h2 class="page-title">Settings</h2>`];
    if (isOwner()) {
      const cats = await api(`/categories?${qLoc()}`);
      parts.push(categoriesSection(cats));
      parts.push(await locationsSection());
      parts.push(await usersSection());
      parts.push(importSection());
    }
    parts.push(`
      <div class="card">
        <div class="card-title">Account</div>
        <div class="list-row"><div><strong>${esc(state.me.user.name)}</strong>
          <div class="hint">${esc(state.me.user.email)} · ${state.me.user.role === 'owner' ? 'Owner' : 'Manager'}</div></div>
          <button class="btn" id="logoutBtn">Sign out</button></div>
      </div>`);
    return parts.join('');
  });

  function categoriesSection(cats) {
    const group = (title, group, list, extra) => `
      <details class="cat-group">
        <summary>${title} <span class="hint">(${list.length})</span></summary>
        ${list.map(c => `
          <div class="list-row" data-group="${group}" data-id="${c.id}">
            <div><strong class="cat-label">${esc(c.name)}</strong>
              ${extra ? `<div class="hint">${extra(c)}</div>` : ''}</div>
            <div class="list-right">
              <button class="icon-btn edit-cat" aria-label="Edit">✎</button>
              <button class="icon-btn danger del-cat" aria-label="Delete">✕</button>
            </div>
          </div>`).join('')}
        <button class="btn tiny add-cat" data-group="${group}">+ Add category</button>
      </details>`;
    return `
      <div class="card">
        <div class="card-title">Your categories</div>
        ${group('Sales channels (money in)', 'revenue', cats.revenue, c =>
          c.commission_percent
            ? `${c.commission_percent}% commission · ${c.commission_invoiced ? 'invoiced' : 'not invoiced'}`
            : 'No commission')}
        ${group('Day-to-day costs', 'variable', cats.variable, c =>
          `${c.entry_mode === 'percent' ? `Suggested as ${c.default_percent || 0}% of sales` : 'Entered as an amount'}
           · ${c.default_invoiced ? 'usually invoiced' : 'usually not invoiced'}
           ${c.benchmark_tag ? ` · counts as ${c.benchmark_tag}` : ''}`)}
        ${group('Recurring costs', 'recurring', cats.recurring, c =>
          c.benchmark_tag ? `Counts as ${c.benchmark_tag} for benchmarks` : '')}
        <div class="hint">Categories with history are archived instead of deleted, so old numbers stay right.</div>
      </div>`;
  }

  async function locationsSection() {
    return `
      <div class="card">
        <div class="card-title">Locations</div>
        ${state.me.locations.map(l => `
          <div class="list-row" data-loc="${l.id}">
            <strong>${esc(l.name)}</strong>
            <div class="list-right">
              <button class="icon-btn edit-loc" aria-label="Rename">✎</button>
              ${state.me.locations.length > 1 ? `<button class="icon-btn danger del-loc" aria-label="Delete">✕</button>` : ''}
            </div>
          </div>`).join('')}
        <button class="btn tiny" id="addLoc">+ Add location</button>
        <div class="hint">New locations start with the default categories, ready to customize.</div>
      </div>`;
  }

  async function usersSection() {
    const users = await api('/users');
    return `
      <div class="card">
        <div class="card-title">People</div>
        ${users.map(u => `
          <div class="list-row" data-user="${u.id}">
            <div><strong>${esc(u.name)}</strong>
              <div class="hint">${esc(u.email)} · ${u.role === 'owner' ? 'Owner — everything' :
                'Manager — ' + (u.locationIds || []).map(id => esc(state.me.locations.find(l => l.id === id)?.name || '?')).join(', ')}</div></div>
            ${u.role !== 'owner' ? `<button class="icon-btn danger del-user" aria-label="Remove">✕</button>` : ''}
          </div>`).join('')}
        <button class="btn tiny" id="addUser">+ Add a manager</button>
        <div class="hint">Managers can log sales and costs and see the dashboard for their location only.</div>
      </div>`;
  }

  function importSection() {
    return `
      <div class="card">
        <div class="card-title">Import from CSV</div>
        <p class="hint">Bring in history from a spreadsheet or POS export.
          <strong>Sales file:</strong> columns <code>date,total</code> (or <code>date,category,amount</code>).
          <strong>Costs file:</strong> columns <code>date,category,amount,invoiced</code> — rows whose category
          doesn't match one of yours become one-off costs. Dates as <code>YYYY-MM-DD</code>.</p>
        <div class="row2">
          <label>What are you importing?
            <select id="importType"><option value="revenue">Sales</option><option value="costs">Costs</option></select></label>
          <label>CSV file<input type="file" id="importFile" accept=".csv,text/csv"></label>
        </div>
        <button class="btn primary" id="importBtn">Import</button>
        <p class="hint" id="importResult"></p>
      </div>`;
  }

  registerRoute('settings_bind', (app) => {
    app.querySelector('#logoutBtn').onclick = async () => {
      await api('/logout', { method: 'POST' });
      state.me = null; location.hash = ''; render();
    };
    if (!isOwner()) return;

    // categories
    app.querySelectorAll('.add-cat').forEach(b => b.onclick = () => addCategory(b.dataset.group));
    app.querySelectorAll('.edit-cat').forEach(b => b.onclick = () => {
      const row = b.closest('.list-row');
      editCategory(row.dataset.group, Number(row.dataset.id), row.querySelector('.cat-label').textContent);
    });
    app.querySelectorAll('.del-cat').forEach(b => b.onclick = async () => {
      const row = b.closest('.list-row');
      if (!confirm('Remove this category?')) return;
      const r = await api(`/categories/${row.dataset.group}/${row.dataset.id}?${qLoc()}`, { method: 'DELETE' });
      toast(r.archived ? 'Archived (it had history)' : 'Deleted'); render();
    });

    // locations
    app.querySelector('#addLoc').onclick = async () => {
      const name = prompt('Name of the new location:');
      if (!name) return;
      await api('/locations', { method: 'POST', body: { name } });
      await loadMe(); toast('Location added'); render();
    };
    app.querySelectorAll('.edit-loc').forEach(b => b.onclick = async () => {
      const row = b.closest('.list-row');
      const name = prompt('New name:', row.querySelector('strong').textContent);
      if (!name) return;
      await api(`/locations/${row.dataset.loc}`, { method: 'PUT', body: { name } });
      await loadMe(); render();
    });
    app.querySelectorAll('.del-loc').forEach(b => b.onclick = async () => {
      const row = b.closest('.list-row');
      if (!confirm('Remove this location? Its data is kept but hidden.')) return;
      try {
        await api(`/locations/${row.dataset.loc}`, { method: 'DELETE' });
        await loadMe();
        if (!state.me.locations.some(l => l.id === state.locationId))
          state.locationId = state.me.locations[0]?.id;
        render();
      } catch (err) { toast(err.message, true); }
    });

    // users
    app.querySelector('#addUser').onclick = () => addManagerDialog();
    app.querySelectorAll('.del-user').forEach(b => b.onclick = async () => {
      const row = b.closest('.list-row');
      if (!confirm('Remove this person?')) return;
      await api(`/users/${row.dataset.user}`, { method: 'DELETE' });
      toast('Removed'); render();
    });

    // import
    app.querySelector('#importBtn').onclick = async () => {
      const file = app.querySelector('#importFile').files[0];
      const type = app.querySelector('#importType').value;
      const out = app.querySelector('#importResult');
      if (!file) { out.textContent = 'Choose a CSV file first.'; return; }
      const text = await file.text();
      const rows = parseCSV(text);
      if (!rows.length) { out.textContent = 'Could not read any rows from that file.'; return; }
      out.textContent = `Importing ${rows.length} rows…`;
      try {
        const r = await api(`/import?${qLoc()}`, { method: 'POST', body: { location_id: state.locationId, type, rows } });
        out.textContent = `Done — ${r.imported} imported.` +
          (r.totalErrors ? ` ${r.totalErrors} rows skipped: ${r.errors.join('; ')}` : '');
        toast('Import finished');
      } catch (err) { out.textContent = err.message; }
    };
  });

  // ---- dialogs (simple modal) ----
  function modal(html, onBind) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal">${html}</div>`;
    wrap.onclick = e => { if (e.target === wrap) wrap.remove(); };
    document.body.appendChild(wrap);
    onBind(wrap, () => wrap.remove());
  }

  function addCategory(group) {
    const extra = group === 'variable' ? `
      <label>How is it entered?
        <select name="entry_mode">
          <option value="fixed">As an amount ($)</option>
          <option value="percent">As a % of that day's sales</option>
        </select></label>
      <label class="pct-field hidden">Default %<input type="number" step="any" min="0" max="100" name="default_percent" value="0"></label>
      <label class="inv-toggle big"><input type="checkbox" name="default_invoiced">Usually invoiced</label>
      <label>Counts as (for benchmarks)
        <select name="benchmark_tag"><option value="">Nothing special</option>
          <option value="food">Food & drink cost</option><option value="labor">Labor</option></select></label>`
      : group === 'recurring' ? `
      <label>Counts as (for benchmarks)
        <select name="benchmark_tag"><option value="">Nothing special</option>
          <option value="labor">Labor</option><option value="occupancy">Rent & occupancy</option></select></label>`
      : `
      <label>Commission on this channel <span class="hint">(% taken off each sale — 0 for none)</span>
        <input type="number" step="any" min="0" max="100" name="commission_percent" value="0"></label>
      <label class="inv-toggle big"><input type="checkbox" name="commission_invoiced" checked>Commission is invoiced (facturada)</label>`;
    modal(`
      <h3>New ${group === 'revenue' ? 'sales channel' : 'category'}</h3>
      <form id="catForm">
        <label>Name<input name="name" required autofocus></label>
        ${extra}
        <div class="modal-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn primary">Add</button>
        </div>
      </form>`, (wrap, close) => {
      wrap.querySelector('[data-close]').onclick = close;
      const mode = wrap.querySelector('[name=entry_mode]');
      if (mode) mode.onchange = () =>
        wrap.querySelector('.pct-field').classList.toggle('hidden', mode.value !== 'percent');
      wrap.querySelector('#catForm').onsubmit = async e => {
        e.preventDefault();
        const f = new FormData(e.target);
        try {
          await api(`/categories/${group}?${qLoc()}`, { method: 'POST', body: {
            location_id: state.locationId, name: f.get('name'),
            entry_mode: f.get('entry_mode') || undefined,
            default_percent: f.get('default_percent') || undefined,
            default_invoiced: f.get('default_invoiced') === 'on',
            commission_percent: f.get('commission_percent') || 0,
            commission_invoiced: f.get('commission_invoiced') === 'on',
            benchmark_tag: f.get('benchmark_tag') || null } });
          close(); toast('Category added'); render();
        } catch (err) { toast(err.message, true); }
      };
    });
  }

  async function editCategory(group, id, currentName) {
    // Revenue channels also get commission settings in the edit dialog.
    let commissionFields = '';
    if (group === 'revenue') {
      const cats = await api(`/categories?${qLoc()}`);
      const cat = cats.revenue.find(c => c.id === id) || {};
      commissionFields = `
        <label>Commission on this channel <span class="hint">(% taken off each sale — 0 for none)</span>
          <input type="number" step="any" min="0" max="100" name="commission_percent" value="${cat.commission_percent ?? 0}"></label>
        <label class="inv-toggle big"><input type="checkbox" name="commission_invoiced" ${cat.commission_invoiced ? 'checked' : ''}>Commission is invoiced (facturada)</label>
        <p class="hint">Changing the % only affects sales you log from now on — past days keep the commission they were saved with.</p>`;
    }
    modal(`
      <h3>Edit ${group === 'revenue' ? 'sales channel' : 'category'}</h3>
      <form id="catForm">
        <label>Name<input name="name" value="${esc(currentName)}" required autofocus></label>
        ${commissionFields}
        <div class="modal-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>`, (wrap, close) => {
      wrap.querySelector('[data-close]').onclick = close;
      wrap.querySelector('#catForm').onsubmit = async e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const body = { location_id: state.locationId, name: f.get('name') };
        if (group === 'revenue') {
          body.commission_percent = f.get('commission_percent') || 0;
          body.commission_invoiced = f.get('commission_invoiced') === 'on';
        }
        await api(`/categories/${group}/${id}?${qLoc()}`, { method: 'PUT', body });
        close(); toast('Saved'); render();
      };
    });
  }

  function addManagerDialog() {
    modal(`
      <h3>Add a manager</h3>
      <form id="mgrForm">
        <label>Name<input name="name" required></label>
        <label>Email<input type="email" name="email" required></label>
        <label>Password <span class="hint">(at least 8 characters — share it with them)</span>
          <input name="password" required minlength="8"></label>
        <label>Locations they can see</label>
        ${state.me.locations.map(l =>
          `<label class="inv-toggle big"><input type="checkbox" name="loc" value="${l.id}">${esc(l.name)}</label>`).join('')}
        <div class="modal-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn primary">Add manager</button>
        </div>
      </form>`, (wrap, close) => {
      wrap.querySelector('[data-close]').onclick = close;
      wrap.querySelector('#mgrForm').onsubmit = async e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const locationIds = [...wrap.querySelectorAll('[name=loc]:checked')].map(c => Number(c.value));
        try {
          await api('/users', { method: 'POST', body: {
            name: f.get('name'), email: f.get('email'), password: f.get('password'), locationIds } });
          close(); toast('Manager added'); render();
        } catch (err) { toast(err.message, true); }
      };
    });
  }

  // ---- tiny CSV parser (handles quoted fields) ----
  function parseCSV(text) {
    const lines = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(c => c.trim() !== '')) lines.push(row);
        row = [];
      } else field += ch;
    }
    row.push(field);
    if (row.some(c => c.trim() !== '')) lines.push(row);
    if (lines.length < 2) return [];
    const headers = lines[0].map(h => h.trim().toLowerCase());
    return lines.slice(1).map(cells =>
      Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? '').trim()])));
  }
})();
