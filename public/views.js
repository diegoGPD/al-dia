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
        <p class="hint center"><a href="#" id="forgotPw">Forgot your password?</a></p>
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
    app.querySelector('#forgotPw').onclick = (e) => {
      e.preventDefault();
      app.querySelector('#authErr').textContent =
        'Managers: ask the owner to reset it (Settings → People). Owner: run the reset command on the server — see the README ("Password reset").';
    };
  });

  registerRoute('_setup', (status) => `
    <div class="auth-wrap"><div class="auth-card">
      <h1 class="auth-logo">Al Día</h1>
      <p class="auth-sub">Welcome! Let's set up your account — takes 30 seconds.</p>
      <form id="setupForm">
        <label>Your name<input name="name" required placeholder="Diego"></label>
        <label>Email<input type="email" name="email" required autocomplete="email"></label>
        <label>Password <span class="hint">(at least 8 characters)</span>
          <input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
        <label>Your restaurant's name<input name="locationName" required placeholder="La Cocina Centro"></label>
        ${App.state.setupCodeRequired ? `<label>Setup code <span class="hint">(set by whoever deployed this)</span>
          <input name="setup_code" required autocomplete="off"></label>` : ''}
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
          password: f.get('password'), locationName: f.get('locationName'),
          setup_code: f.get('setup_code') || undefined } });
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
      </div>
      <a class="log-tile" href="#/insights"><span class="log-icon">🔮</span>
        <div><strong>Forecast & insights</strong>
        <div class="hint">Where you're headed, what's changing, and why</div></div></a>`;
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
    const accByAcc = Object.fromEntries((existing.accountItems || []).map(i => [i.account_id, i.amount]));
    const hasAccSplit = (existing.accountItems || []).length > 0;
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
        <details id="accSplit" ${hasAccSplit ? 'open' : ''}>
          <summary>Where did the money land? (optional)</summary>
          <div class="cat-rows">
            ${cats.accounts.map(a => `
              <label class="cat-row">${esc(a.name)}
                <input type="number" inputmode="decimal" step="any" min="0" data-acc="${a.id}"
                  class="acc-item" value="${accByAcc[a.id] ?? ''}" placeholder="0"></label>`).join('')}
          </div>
          <div class="hint" id="accRemaining"></div>
        </details>
        <button class="btn primary full" type="submit">${existing.entry ? 'Update' : 'Save'} sales</button>
        ${existing.entry ? `<div class="hint center">Already logged for this day — saving replaces it.
          <br><a href="#" id="moveRev">Logged on the wrong day? Move it to another date</a></div>` : ''}
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

    // account split helper: show how much of the total is still unassigned
    const accItems = [...app.querySelectorAll('.acc-item')];
    const accRemaining = app.querySelector('#accRemaining');
    const syncAcc = () => {
      const assigned = accItems.reduce((s, i) => s + (Number(i.value) || 0), 0);
      const total = Number(totalEl.value) || 0;
      if (assigned === 0) { accRemaining.textContent = 'Split the total across your accounts — anything left over shows as "unassigned".'; return; }
      const left = total - assigned;
      accRemaining.textContent = Math.abs(left) < 0.005
        ? '✓ Fully assigned'
        : left > 0 ? `${money(left)} still unassigned`
        : `⚠ Assigned ${money(-left)} more than the day's total`;
    };
    accItems.forEach(i => i.oninput = syncAcc);
    totalEl.addEventListener('input', syncAcc);
    items.forEach(i => i.addEventListener('input', syncAcc));
    syncAcc();

    app.querySelector('#revForm').onsubmit = async (e) => {
      e.preventDefault();
      const breakdown = items
        .filter(i => i.value !== '' && Number(i.value) !== 0)
        .map(i => ({ category_id: Number(i.dataset.cat), amount: Number(i.value) }));
      const accounts = accItems
        .filter(i => i.value !== '' && Number(i.value) !== 0)
        .map(i => ({ account_id: Number(i.dataset.acc), amount: Number(i.value) }));
      try {
        const r = await api('/revenue', { method: 'PUT', body: {
          location_id: state.locationId, date: dateEl.value,
          total: Number(totalEl.value) || 0, items: breakdown, accounts } });
        toast(`Sales saved — ${money(r.total)}`);
        nav('dashboard');
      } catch (err) { toast(err.message, true); }
    };
    const mv = app.querySelector('#moveRev');
    if (mv) mv.onclick = (e) => {
      e.preventDefault();
      moveDayDialog('sales log', dateEl.value, async (to) => {
        await api('/revenue/move', { method: 'POST', body: {
          location_id: state.locationId, from_date: dateEl.value, to_date: to } });
        revDate = to;
      });
    };
  });

  // Shared "move this day's log to another date" dialog.
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
              <div class="cost-inputs">
                <input type="number" inputmode="decimal" step="any" min="0" class="cost-amt"
                  value="${value}" placeholder="${suggested !== null ? suggested : '0'}"
                  ${suggested !== null ? `data-suggest="${suggested}"` : ''}>
                <select class="cost-acc" aria-label="Paid from">
                  <option value="">Paid from…</option>
                  ${d.accounts.map(a => `<option value="${a.id}" ${ex && ex.account_id === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
                </select>
              </div>
              ${suggested !== null && !ex ? `<button type="button" class="btn tiny use-suggest">Use suggestion: ${money(suggested)}</button>` : ''}
            </div>`;
          }).join('')}
        </div>
        <button class="btn primary full" type="submit">Save costs</button>
        <div class="hint center">Leave a row empty if it doesn't apply — empty rows aren't saved.
          ${d.existing.length ? `<br><a href="#" id="moveCosts">Logged on the wrong day? Move these costs</a>` : ''}</div>
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
        invoiced: row.querySelector('.cost-inv').checked,
        account_id: Number(row.querySelector('.cost-acc').value) || null
      }));
      try {
        await api('/costs/day', { method: 'PUT', body: { location_id: state.locationId, date: dateEl.value, rows } });
        toast('Costs saved');
        nav('dashboard');
      } catch (err) { toast(err.message, true); }
    };
    const mv = app.querySelector('#moveCosts');
    if (mv) mv.onclick = (e) => {
      e.preventDefault();
      moveDayDialog("day's costs", dateEl.value, async (to) => {
        await api('/costs/move', { method: 'POST', body: {
          location_id: state.locationId, from_date: dateEl.value, to_date: to } });
        costDate = to;
      });
    };
  });

  // ======================================================================
  // One-off costs
  // ======================================================================
  registerRoute('oneoff', async () => {
    const start = today().slice(0, 8) + '01';
    const [list, cats] = await Promise.all([
      api(`/oneoff?${qLoc()}&start=${addDays(start, -60)}&end=${today()}`),
      api(`/categories?${qLoc()}`)
    ]);
    return `
      <h2 class="page-title">One-off costs</h2>
      <form id="oneoffForm" class="card">
        <label>Date<input type="date" name="date" value="${today()}" max="${today()}" required></label>
        <label>What was it?<input name="description" required placeholder="Fridge repair, health permit…"></label>
        <div class="row2">
          <label>Amount<input type="number" inputmode="decimal" step="any" min="0.01" name="amount" required placeholder="0"></label>
          <label>Paid from <span class="hint">(optional)</span>
            <select name="account_id"><option value="">—</option>
              ${cats.accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></label>
        </div>
        <label class="inv-toggle big"><input type="checkbox" name="invoiced">This cost is invoiced (facturado)</label>
        <button class="btn primary full" type="submit">Save cost</button>
      </form>
      ${list.length ? `<div class="card">
        <div class="card-title">Recent one-offs</div>
        ${list.map(o => `
          <div class="list-row" data-oneoff='${esc(JSON.stringify({ id: o.id, date: o.date, description: o.description, amount: o.amount, invoiced: o.invoiced, account_id: o.account_id }))}'>
            <div><strong>${esc(o.description)}</strong>
              <div class="hint">${fmtDate(o.date)} · ${o.invoiced ? 'Invoiced' : 'Not invoiced'}</div></div>
            <div class="list-right">${money(o.amount)}
              <button class="icon-btn edit-oneoff" aria-label="Edit">✎</button>
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
          invoiced: f.get('invoiced') === 'on',
          account_id: Number(f.get('account_id')) || null } });
        toast('Cost saved'); render();
      } catch (err) { toast(err.message, true); }
    };
    app.querySelectorAll('.del-oneoff').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this cost?')) return;
      await api(`/oneoff/${b.dataset.id}?${qLoc()}`, { method: 'DELETE' });
      toast('Deleted'); render();
    });
    app.querySelectorAll('.edit-oneoff').forEach(b => b.onclick = async () => {
      const o = JSON.parse(b.closest('.list-row').dataset.oneoff);
      const cats = await api(`/categories?${qLoc()}`);
      modal(`
        <h3>Edit one-off cost</h3>
        <form id="ooEdit">
          <label>Date<input type="date" name="date" value="${o.date}" max="${today()}" required></label>
          <label>What was it?<input name="description" value="${esc(o.description)}" required></label>
          <div class="row2">
            <label>Amount<input type="number" inputmode="decimal" step="any" min="0.01" name="amount" value="${o.amount}" required></label>
            <label>Paid from
              <select name="account_id"><option value="">—</option>
                ${cats.accounts.map(a => `<option value="${a.id}" ${o.account_id === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
          </div>
          <label class="inv-toggle big"><input type="checkbox" name="invoiced" ${o.invoiced ? 'checked' : ''}>Invoiced (facturado)</label>
          <div class="modal-actions">
            <button type="button" class="btn" data-close>Cancel</button>
            <button type="submit" class="btn primary">Save</button>
          </div>
        </form>`, (wrap, close) => {
        wrap.querySelector('[data-close]').onclick = close;
        wrap.querySelector('#ooEdit').onsubmit = async e => {
          e.preventDefault();
          const f = new FormData(e.target);
          try {
            await api(`/oneoff/${o.id}?${qLoc()}`, { method: 'PUT', body: {
              location_id: state.locationId, date: f.get('date'), description: f.get('description'),
              amount: Number(f.get('amount')), invoiced: f.get('invoiced') === 'on',
              account_id: Number(f.get('account_id')) || null } });
            close(); toast('Saved'); render();
          } catch (err) { toast(err.message, true); }
        };
      });
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
        <div class="row2">
          <label>Paid from <span class="hint">(optional)</span>
            <select name="account_id"><option value="">—</option>
              ${cats.accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></label>
          <label>Starts counting from
            <input type="date" name="start_date" value="${today()}" required></label>
        </div>
        <label class="inv-toggle big"><input type="checkbox" name="invoiced">Invoiced (facturado)</label>
        <button class="btn primary full" type="submit">Add recurring cost</button>
      </form>
      ${items.length ? `<div class="card">
        <div class="card-title">Current recurring costs</div>
        ${items.map(i => `
          <div class="list-row" data-rec='${esc(JSON.stringify({ id: i.id, category_id: i.category_id, description: i.description, amount: i.amount, frequency: i.frequency, invoiced: i.invoiced, account_id: i.account_id, start_date: i.start_date }))}'>
            <div><strong>${esc(i.description)}</strong>
              <div class="hint">${esc(i.category_name)} · ${FREQ[i.frequency]} · ${i.invoiced ? 'Invoiced' : 'Not invoiced'} · since ${fmtDate(i.start_date, { month: 'short', day: 'numeric', year: 'numeric' })}</div></div>
            <div class="list-right">${money(i.amount)}<div class="hint">${money(i.daily)}/day</div>
              <button class="icon-btn edit-rec" aria-label="Edit">✎</button>
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
          account_id: Number(f.get('account_id')) || null,
          start_date: f.get('start_date') || today() } });
        toast('Recurring cost added'); render();
      } catch (err) { toast(err.message, true); }
    };
    app.querySelectorAll('.del-rec').forEach(b => b.onclick = async () => {
      if (!confirm('End this recurring cost? Past periods keep it; from today it stops counting.')) return;
      await api(`/recurring/${b.dataset.id}?${qLoc()}`, { method: 'DELETE' });
      toast('Ended'); render();
    });
    app.querySelectorAll('.edit-rec').forEach(b => b.onclick = async () => {
      const it = JSON.parse(b.closest('.list-row').dataset.rec);
      const cats = await api(`/categories?${qLoc()}`);
      modal(`
        <h3>Edit recurring cost</h3>
        <form id="recEdit">
          <label>Category
            <select name="category_id">${cats.recurring.map(c =>
              `<option value="${c.id}" ${c.id === it.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
          <label>Description<input name="description" value="${esc(it.description)}" required></label>
          <div class="row2">
            <label>Amount<input type="number" inputmode="decimal" step="any" min="0.01" name="amount" value="${it.amount}" required></label>
            <label>How often
              <select name="frequency">
                <option value="monthly" ${it.frequency === 'monthly' ? 'selected' : ''}>Monthly</option>
                <option value="biweekly" ${it.frequency === 'biweekly' ? 'selected' : ''}>Every 2 weeks</option>
                <option value="weekly" ${it.frequency === 'weekly' ? 'selected' : ''}>Weekly</option>
              </select></label>
          </div>
          <div class="row2">
            <label>Paid from
              <select name="account_id"><option value="">—</option>
                ${cats.accounts.map(a => `<option value="${a.id}" ${it.account_id === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
            <label>Starts counting from<input type="date" name="start_date" value="${it.start_date}" required></label>
          </div>
          <label class="inv-toggle big"><input type="checkbox" name="invoiced" ${it.invoiced ? 'checked' : ''}>Invoiced (facturado)</label>
          <p class="hint">Changing the start date rewrites this cost's history — every past day from that date counts it.</p>
          <div class="modal-actions">
            <button type="button" class="btn" data-close>Cancel</button>
            <button type="submit" class="btn primary">Save</button>
          </div>
        </form>`, (wrap, close) => {
        wrap.querySelector('[data-close]').onclick = close;
        wrap.querySelector('#recEdit').onsubmit = async e => {
          e.preventDefault();
          const f = new FormData(e.target);
          try {
            await api(`/recurring/${it.id}?${qLoc()}`, { method: 'PUT', body: {
              location_id: state.locationId, category_id: Number(f.get('category_id')),
              description: f.get('description'), amount: Number(f.get('amount')),
              frequency: f.get('frequency'), invoiced: f.get('invoiced') === 'on',
              account_id: Number(f.get('account_id')) || null,
              start_date: f.get('start_date') } });
            close(); toast('Saved'); render();
          } catch (err) { toast(err.message, true); }
        };
      });
    });
  });

  // ======================================================================
  // Costs breakdown
  // ======================================================================
  // Sub-tabs shared by the Costs and Accounts pages
  const moneySubnav = (active) => `
    <div class="seg subnav">
      <button class="seg-btn ${active === 'breakdown' ? 'on' : ''}" onclick="location.hash='#/breakdown'">Costs</button>
      <button class="seg-btn ${active === 'accounts' ? 'on' : ''}" onclick="location.hash='#/accounts'">Accounts</button>
    </div>`;

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
      ${moneySubnav('breakdown')}
      ${periodBar(d)}
      <div class="card">
        <div class="card-title">Where the money went — ${money(c.costs.total)} total</div>
        ${typeBar('Recurring (rent, subscriptions…)', c.costs.recurring, 'rec')}
        ${typeBar('Team (scheduled labor)', c.costs.labor, 'labor')}
        ${typeBar('Day-to-day (food, supplies…)', c.costs.variable, 'var')}
        ${typeBar('Channel commissions (apps, cards…)', c.costs.commissions, 'comm')}
        ${typeBar('One-offs', c.costs.oneoff, 'one')}
        ${c.laborDoubleCount ? `<div class="hint" style="margin-top:8px">⚠ You have payroll in recurring costs <em>and</em> a team schedule — that may count labor twice. If the schedule is your real payroll, delete the recurring payroll item (it still works as the budget line on the Team page).</div>` : ''}
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
  // Money accounts view
  // ======================================================================
  registerRoute('accounts', async () => {
    const d = await api(`/accounts-view?${qLoc()}&granularity=${state.granularity}&date=${state.anchor}`);
    const hasUnassigned = d.unassigned.moneyIn > 0.005 || d.unassigned.moneyOut > 0.005;
    return `
      ${moneySubnav('accounts')}
      ${periodBar({ current: { start: d.start, end: d.end, periodEnd: d.periodEnd } })}
      <div class="card">
        <div class="card-title">Where your money is</div>
        ${d.accounts.map(a => `
          <div class="acc-row">
            <div class="acc-head"><strong>${esc(a.name)}</strong>
              <span class="acc-balance-wrap">
                <span class="acc-balance ${a.balance < 0 ? 'neg' : ''}">${money(a.balance)}</span>
                <button class="icon-btn adjust-acc" data-id="${a.id}" data-name="${esc(a.name)}"
                  data-balance="${a.balance}" aria-label="Correct balance">✎</button>
              </span></div>
            <div class="acc-move hint">
              In ${money(a.moneyIn)} · Out ${money(a.moneyOut)} ·
              Net <span class="${a.net >= 0 ? 'pos' : 'neg'}">${a.net >= 0 ? '+' : ''}${money(a.net)}</span> this period
              ${a.adjustment ? ` · includes manual correction of ${a.adjustment > 0 ? '+' : ''}${money(a.adjustment)}` : ''}
            </div>
          </div>`).join('')}
        ${hasUnassigned ? `
          <div class="acc-row unassigned">
            <div class="acc-head"><strong>Unassigned</strong></div>
            <div class="acc-move hint">
              Sales not tagged to an account: ${money(d.unassigned.moneyIn)} ·
              Costs not tagged: ${money(d.unassigned.moneyOut)}
            </div>
          </div>` : ''}
        <div class="hint">Balances = opening balance + everything tagged since the start. Commissions (${money(d.totals.commissionsNote)} this period) never hit an account — the platforms keep them before paying out. Tag sales and costs to accounts when you log them; untagged money shows here as unassigned so totals always match the dashboard.</div>
      </div>
      <div class="card">
        <div class="card-title">Transfers between accounts</div>
        <button class="btn primary" id="addTransfer">+ Record a transfer</button>
        ${d.transfers.length ? d.transfers.map(t => `
          <div class="list-row" data-tr='${esc(JSON.stringify({ id: t.id, date: t.date, from: t.from_account_id, to: t.to_account_id, amount: t.amount, note: t.note }))}'>
            <div><strong>${esc(t.from_name)} → ${esc(t.to_name)}</strong>
              <div class="hint">${fmtDate(t.date)}${t.note ? ' · ' + esc(t.note) : ''}</div></div>
            <div class="list-right">${money(t.amount)}
              <button class="icon-btn edit-transfer" aria-label="Edit">✎</button>
              <button class="icon-btn danger del-transfer" data-id="${t.id}" aria-label="Delete">✕</button></div>
          </div>`).join('') : '<div class="hint" style="margin-top:10px">No transfers this period.</div>'}
      </div>`;
  });

  registerRoute('accounts_bind', (app) => {
    bindPeriodBar(app);
    app.querySelector('#addTransfer').onclick = async () => {
      const cats = await api(`/categories?${qLoc()}`);
      const opts = cats.accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
      modal(`
        <h3>Record a transfer</h3>
        <form id="trForm">
          <label>Date<input type="date" name="date" value="${today()}" max="${today()}" required></label>
          <div class="row2">
            <label>From<select name="from" required>${opts}</select></label>
            <label>To<select name="to" required>${opts}</select></label>
          </div>
          <label>Amount<input type="number" inputmode="decimal" step="any" min="0.01" name="amount" required placeholder="0"></label>
          <label>Note <span class="hint">(optional)</span><input name="note" placeholder="Cash deposit"></label>
          <div class="modal-actions">
            <button type="button" class="btn" data-close>Cancel</button>
            <button type="submit" class="btn primary">Save transfer</button>
          </div>
        </form>`, (wrap, close) => {
        wrap.querySelector('[data-close]').onclick = close;
        const sel = wrap.querySelectorAll('select');
        if (sel[1].options.length > 1) sel[1].selectedIndex = 1;
        wrap.querySelector('#trForm').onsubmit = async e => {
          e.preventDefault();
          const f = new FormData(e.target);
          try {
            await api('/transfers', { method: 'POST', body: {
              location_id: state.locationId, date: f.get('date'),
              from_account_id: Number(f.get('from')), to_account_id: Number(f.get('to')),
              amount: Number(f.get('amount')), note: f.get('note') } });
            close(); toast('Transfer saved'); render();
          } catch (err) { toast(err.message, true); }
        };
      });
    };
    app.querySelectorAll('.del-transfer').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this transfer?')) return;
      await api(`/transfers/${b.dataset.id}?${qLoc()}`, { method: 'DELETE' });
      toast('Deleted'); render();
    });
    app.querySelectorAll('.edit-transfer').forEach(b => b.onclick = async () => {
      const t = JSON.parse(b.closest('.list-row').dataset.tr);
      const cats = await api(`/categories?${qLoc()}`);
      const opts = sel => cats.accounts.map(a =>
        `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
      modal(`
        <h3>Edit transfer</h3>
        <form id="trEdit">
          <label>Date<input type="date" name="date" value="${t.date}" max="${today()}" required></label>
          <div class="row2">
            <label>From<select name="from" required>${opts(t.from)}</select></label>
            <label>To<select name="to" required>${opts(t.to)}</select></label>
          </div>
          <label>Amount<input type="number" inputmode="decimal" step="any" min="0.01" name="amount" value="${t.amount}" required></label>
          <label>Note<input name="note" value="${esc(t.note || '')}"></label>
          <div class="modal-actions">
            <button type="button" class="btn" data-close>Cancel</button>
            <button type="submit" class="btn primary">Save</button>
          </div>
        </form>`, (wrap, close) => {
        wrap.querySelector('[data-close]').onclick = close;
        wrap.querySelector('#trEdit').onsubmit = async e => {
          e.preventDefault();
          const f = new FormData(e.target);
          try {
            await api(`/transfers/${t.id}?${qLoc()}`, { method: 'PUT', body: {
              location_id: state.locationId, date: f.get('date'),
              from_account_id: Number(f.get('from')), to_account_id: Number(f.get('to')),
              amount: Number(f.get('amount')), note: f.get('note') } });
            close(); toast('Saved'); render();
          } catch (err) { toast(err.message, true); }
        };
      });
    });
    app.querySelectorAll('.adjust-acc').forEach(b => b.onclick = () => {
      modal(`
        <h3>Correct balance — ${esc(b.dataset.name)}</h3>
        <p class="hint">Current balance: <strong>${money(Number(b.dataset.balance))}</strong>.
          Enter what it should actually be — the difference is saved as a manual correction, dated today.</p>
        <form id="adjForm">
          <label>Actual balance<input type="number" inputmode="decimal" step="any" name="new_balance"
            value="${Math.round(Number(b.dataset.balance) * 100) / 100}" required></label>
          <label>Note <span class="hint">(optional)</span><input name="note" placeholder="Counted the register"></label>
          <label>PIN<input type="password" inputmode="numeric" name="pin" required placeholder="••••"></label>
          <div class="modal-actions">
            <button type="button" class="btn" data-close>Cancel</button>
            <button type="submit" class="btn primary">Save correction</button>
          </div>
        </form>`, (wrap, close) => {
        wrap.querySelector('[data-close]').onclick = close;
        wrap.querySelector('#adjForm').onsubmit = async e => {
          e.preventDefault();
          const f = new FormData(e.target);
          try {
            const r = await api('/accounts/adjust', { method: 'POST', body: {
              location_id: state.locationId, account_id: Number(b.dataset.id),
              new_balance: Number(f.get('new_balance')), pin: f.get('pin'), note: f.get('note') } });
            close();
            toast(r.adjusted === 0 ? 'Already matched — nothing to correct'
              : `Corrected by ${r.adjusted > 0 ? '+' : ''}${money(r.adjusted)}`);
            render();
          } catch (err) { toast(err.message, true); }
        };
      });
    });
  });

  // ======================================================================
  // Forecast & insights
  // ======================================================================
  let fcHorizon = 'week';
  registerRoute('insights', async () => {
    const [f, ins] = await Promise.all([
      api(`/forecast?${qLoc()}`), api(`/insights?${qLoc()}`)
    ]);
    const fx = fcHorizon === 'week' ? f.week : f.month;
    const accs = fcHorizon === 'week' ? f.accountsWeek : f.accountsMonth;
    const confText = { good: `based on ${fx.loggedDays} days of your history`,
      medium: `medium confidence — only ${fx.loggedDays} days logged so far`,
      low: `low confidence — only ${fx.loggedDays} days logged; this sharpens as you log more` }[fx.confidence];
    const beText = { on_track: ['good', '✓ On track to clear break-even'],
      close: ['warn', '≈ Close to break-even — could go either way'],
      off_track: ['bad', 'Trending below break-even'],
      unknown: ['', ''] }[fx.breakEven.status];

    const mtd = ins.monthToDate;
    const goals = Object.fromEntries((ins.goals || []).map(g => [g.type, g.target]));
    const pace = mtd.dayOfMonth > 0 ? mtd.daysInMonth / mtd.dayOfMonth : 1;

    return `
      <h2 class="page-title">Forecast & insights</h2>

      ${ins.enoughData && ins.summary ? `
      <div class="card highlight">
        <div class="card-title">In short</div>
        <p class="summary-text">${esc(ins.summary)}</p>
      </div>` : `
      <div class="card"><div class="card-title">Not much to say yet</div>
        <p class="hint">Only ${ins.loggedDays || 0} days logged. Keep logging daily — patterns, forecasts and flags appear as history builds.</p></div>`}

      <div class="card">
        <div class="card-title">Looking ahead</div>
        <div class="seg" style="margin-bottom:12px">
          <button class="seg-btn ${fcHorizon === 'week' ? 'on' : ''}" data-horizon="week">Next 7 days</button>
          <button class="seg-btn ${fcHorizon === 'month' ? 'on' : ''}" data-horizon="month">Next 30 days</button>
        </div>
        <div class="be-row"><span>Projected sales</span>
          <strong>${money(fx.revenue.low)} – ${money(fx.revenue.high)}</strong></div>
        <div class="be-row"><span>Projected costs <span class="hint">(recurring exact: ${money(fx.costs.recurring)}${fx.costs.labor > 0 ? ` · team ${money(fx.costs.labor)}` : ''})</span></span>
          <strong>≈ ${money(fx.costs.point)}</strong></div>
        <div class="be-row"><span>Projected profit</span>
          <strong class="${fx.profit.point >= 0 ? 'pos' : 'neg'}">${money(fx.profit.low)} – ${money(fx.profit.high)}</strong></div>
        ${fx.breakEven.sales !== null ? `
          <div class="be-row"><span>Break-even for this period</span><strong>${money(fx.breakEven.sales)}</strong></div>
          ${beText[1] ? `<span class="pill ${beText[0]}">${beText[1]}</span>` : ''}` : ''}
        <div class="hint" style="margin-top:8px">
          Uses your weekday patterns (×${fx.trendFactor.toFixed(2)} recent trend) and cost rates learned from
          your last weeks — day-to-day costs at ${pct(fx.ratios.variable)} and commissions at ${pct(fx.ratios.commissions)}
          of sales${fx.ratios.source === 'defaults' ? ' (from category defaults until you have more history)' : ', as your channel mix actually ran'}.
          ${confText}. These are estimates from your own history, not guarantees — and not financial advice.
        </div>
        ${f.holidays.length ? `<div class="hint" style="margin-top:6px">📅 Coming up: ${f.holidays.map(h =>
          `${esc(h.name)} (${fmtDate(h.date, { month: 'short', day: 'numeric' })})`).join(', ')} — holidays often shift restaurant traffic; the forecast doesn't model them yet.</div>` : ''}
      </div>

      <div class="card">
        <div class="card-title">Cash position ahead (rough)</div>
        ${accs.map(a => `
          <div class="be-row"><span>${esc(a.name)} <span class="hint">now ${money(a.balance)}</span></span>
            <strong class="${a.projected < 0 ? 'neg' : ''}">→ ≈ ${money(a.projected)}</strong></div>`).join('')}
        <div class="hint">Projects each account's average daily movement from your last 4 weeks. Rough by nature.</div>
      </div>

      <details class="card" open>
        <summary class="card-title">What-if simulator</summary>
        <div class="whatif" data-rev="${mtd.revenue}" data-var="${mtd.variable}" data-comm="${mtd.commissions}"
          data-rec="${mtd.recurring}" data-one="${mtd.oneoff}" data-dom="${mtd.dayOfMonth}">
          <label>Price change: <strong id="wiPriceVal">0%</strong>
            <input type="range" id="wiPrice" min="-15" max="15" value="0" step="1"></label>
          <label>Day-to-day cost change (food, supplies…): <strong id="wiVarVal">0%</strong>
            <input type="range" id="wiVar" min="-15" max="15" value="0" step="1"></label>
          <label>Extra monthly recurring cost: <strong id="wiRecVal">$0</strong>
            <input type="range" id="wiRec" min="0" max="30000" value="0" step="500"></label>
          <div class="day-rev" id="wiResult"></div>
          <div class="hint">Plays with a copy of this month's numbers — your real data never changes. Assumes sales volume stays the same when prices move.</div>
        </div>
      </details>

      <details class="card">
        <summary class="card-title">Goals</summary>
        <form id="goalForm" class="row2">
          <label>Monthly profit target
            <input type="number" inputmode="decimal" step="any" min="0" name="profit" value="${goals.profit ?? ''}" placeholder="e.g. 40000"></label>
          <label>Net margin target %
            <input type="number" inputmode="decimal" step="any" min="0" max="100" name="margin" value="${goals.margin ?? ''}" placeholder="e.g. 12"></label>
        </form>
        <button class="btn primary" id="saveGoals">Save goals</button>
        ${goals.profit ? (() => {
          const projected = mtd.profit * pace;
          const onPace = projected >= goals.profit;
          return `<div class="be-row" style="margin-top:12px"><span>Profit pace (${mtd.dayOfMonth}/${mtd.daysInMonth} days)</span>
            <strong>${money(mtd.profit)} → ≈ ${money(projected)} <span class="pill ${onPace ? 'good' : 'bad'}">${onPace ? 'On pace' : 'Behind'}</span></strong></div>
            <div class="progress"><div class="progress-fill ${onPace ? 'good' : ''}" style="width:${Math.min(100, goals.profit > 0 ? mtd.profit / goals.profit * 100 : 0)}%"></div></div>`;
        })() : ''}
        ${goals.margin && mtd.netMargin !== null ? `
          <div class="be-row"><span>Net margin now</span>
            <strong>${pct(mtd.netMargin)} vs target ${goals.margin}%
            <span class="pill ${mtd.netMargin * 100 >= goals.margin ? 'good' : 'bad'}">${mtd.netMargin * 100 >= goals.margin ? 'Met' : 'Below'}</span></strong></div>` : ''}
      </details>

      ${ins.channelStats?.channels?.length ? channelSection(ins.channelStats) : ''}

      ${ins.enoughData ? `
      <details class="card">
        <summary class="card-title">Patterns & changes</summary>
        ${ins.weekdays?.length ? `<div class="ins-block"><strong>Your week, ranked</strong>
          ${ins.weekdays.map(w => `<div class="bd-row"><div class="bd-name">${w.day}s</div>
            <div class="bd-amt">${money(w.mean)}</div><div class="bd-inv hint">avg</div></div>`).join('')}</div>` : ''}
        ${ins.channels?.length ? `<div class="ins-block"><strong>Channels, last 4 weeks vs prior 4</strong>
          ${ins.channels.map(c => `<div class="bd-row"><div class="bd-name">${esc(c.name)}</div>
            <div class="bd-amt">${money(c.now)}</div>
            <div class="bd-inv ${c.change > 0 ? 'pos' : c.change < 0 ? 'neg' : ''}">${c.change === null ? 'new' : (c.change > 0 ? '+' : '') + (c.change * 100).toFixed(0) + '%'}</div></div>`).join('')}</div>` : ''}
        ${ins.costCreep?.length ? `<div class="ins-block"><strong>Cost growth vs sales growth (${ins.revGrowth === null ? '—' : (ins.revGrowth > 0 ? '+' : '') + (ins.revGrowth * 100).toFixed(0) + '%'})</strong>
          ${ins.costCreep.map(c => `<div class="bd-row"><div class="bd-name">${esc(c.name)} ${c.creeping ? '<span class="pill bad">creeping</span>' : ''}</div>
            <div class="bd-amt">${money(c.now)}</div>
            <div class="bd-inv ${c.change > 0 ? 'neg' : 'pos'}">${c.change === null ? 'new' : (c.change > 0 ? '+' : '') + (c.change * 100).toFixed(0) + '%'}</div></div>`).join('')}</div>` : ''}
        ${ins.weekly?.length >= 2 ? `<div class="ins-block"><strong>Weekly margin & effective commission rate</strong>
          ${ins.weekly.map(w => `<div class="bd-row"><div class="bd-name">${fmtDate(w.week, { month: 'short', day: 'numeric' })}</div>
            <div class="bd-amt">${w.margin === null ? '—' : pct(w.margin)}</div>
            <div class="bd-inv hint">${w.commissionRate === null ? '—' : pct(w.commissionRate)} comm.</div></div>`).join('')}
          <div class="hint">Margin trend: ${ins.marginTrend}. Commission rate reflects your real channel mix each week.</div></div>` : ''}
        ${ins.outliers?.length ? `<div class="ins-block"><strong>Unusual days (last 4 weeks)</strong>
          ${ins.outliers.map(o => `<div class="bd-row"><div class="bd-name">${fmtDate(o.date)}</div>
            <div class="bd-amt">${money(o.revenue)}</div><div class="bd-inv hint">vs ~${money(o.expected)}</div></div>`).join('')}</div>` : ''}
        ${ins.records?.bestDay ? `<div class="ins-block"><strong>Records</strong>
          <div class="hint">Best day: ${fmtDate(ins.records.bestDay.date)} — ${money(ins.records.bestDay.revenue)}.
          ${ins.records.worstDay ? `Slowest: ${fmtDate(ins.records.worstDay.date)} — ${money(ins.records.worstDay.revenue)}.` : ''}
          ${ins.records.bestWeek ? `Best week: ${fmtDate(ins.records.bestWeek.week)} — ${money(ins.records.bestWeek.revenue)}.` : ''}</div></div>` : ''}
        ${ins.labor ? `<div class="ins-block"><strong>Labor vs revenue</strong>
          <div class="hint">Scheduled labor ${money(ins.labor.thisWeek)} this week (${(ins.labor.laborGrowth * 100).toFixed(0)}% vs last)
          against revenue ${(ins.labor.revGrowth * 100).toFixed(0)}%.
          ${ins.labor.flag ? '<span class="pill bad">Labor climbing faster than sales</span>' : '<span class="pill good">In line</span>'}</div></div>` : ''}
      </details>` : ''}

      <div id="compareSlot"></div>`;
  });

  // ---- sales channels: sold vs actually kept after commissions ----
  function channelSection(cs) {
    const totGross = cs.channels.reduce((s, c) => s + c.gross, 0);
    const totNet = cs.channels.reduce((s, c) => s + c.net, 0);
    return `
      <div class="card">
        <div class="card-title">Sales channels — sold vs kept</div>
        <div class="be-row"><span>Sold (last 8 weeks)</span><strong>${money(totGross)}</strong></div>
        <div class="be-row"><span>Actually kept after commissions</span>
          <strong class="pos">${money(totNet)} <span class="hint">(${totGross > 0 ? Math.round(totNet / totGross * 100) : 100}%)</span></strong></div>
        ${cs.weekly.length >= 2 ? grossNetChart(cs.weekly) + `
        <div class="legend"><span><i class="dot rev"></i>Sold</span><span><i class="dot net"></i>Kept after commissions</span></div>` : ''}
        <div class="ch-list">
          ${cs.channels.map(c => `
            <div class="ch-row">
              <div class="ch-head">
                <div><strong>${esc(c.name)}</strong>
                  <span class="hint">${Math.round(c.share * 100)}% of sales${c.bestDay ? ` · strongest: ${c.bestDay}s` : ''}</span></div>
                <div class="ch-growth ${c.growth === null ? '' : c.growth >= 0 ? 'pos' : 'neg'}">
                  ${c.growth === null ? '' : (c.growth >= 0 ? '▲ +' : '▼ ') + (c.growth * 100).toFixed(0) + '%'}</div>
              </div>
              <div class="ch-bars" title="Sold vs kept">
                <div class="ch-bar gross" style="width:${totGross > 0 ? Math.max(2, c.gross / cs.channels[0].gross * 100) : 0}%"></div>
                <div class="ch-bar net" style="width:${totGross > 0 ? Math.max(1, c.net / cs.channels[0].gross * 100) : 0}%"></div>
              </div>
              <div class="ch-nums">
                <span>Sold <strong>${money(c.gross)}</strong></span>
                <span>− ${(c.rate * 100).toFixed(1)}% comm. (${money(c.commission)})</span>
                <span>Kept <strong class="pos">${money(c.net)}</strong></span>
                ${sparkline(c.weekly)}
              </div>
            </div>`).join('')}
        </div>
        <div class="hint">Growth compares the last 4 weeks to the 4 before. "Kept" is after channel commissions only — food, labor and rent still come out of it.</div>
      </div>`;
  }

  function grossNetChart(weekly) {
    const W = 640, H = 170, PAD = { l: 8, r: 8, t: 12, b: 22 };
    const max = Math.max(...weekly.map(w => w.gross), 1);
    const x = i => PAD.l + i * (W - PAD.l - PAD.r) / Math.max(1, weekly.length - 1);
    const y = v => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
    const line = key => weekly.map((w, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(w[key]).toFixed(1)}`).join('');
    const gapArea = `M${x(0)},${y(weekly[0].gross)} ${weekly.map((w, i) => `L${x(i)},${y(w.gross)}`).join(' ')}
      ${weekly.slice().reverse().map((w, i) => `L${x(weekly.length - 1 - i)},${y(w.net)}`).join(' ')} Z`;
    const labels = [0, weekly.length - 1].map(i =>
      `<text x="${x(i)}" y="${H - 6}" class="ch-label" text-anchor="${i === 0 ? 'start' : 'end'}">${fmtDate(weekly[i].week, { month: 'short', day: 'numeric' })}</text>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="none" role="img" aria-label="Sold vs kept per week">
      <line x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}" class="ch-axis"/>
      <path d="${gapArea}" class="ch-gap"/>
      <path d="${line('gross')}" class="ch-line rev"/>
      <path d="${line('net')}" class="ch-line net"/>
      ${labels}</svg>`;
  }

  function sparkline(weekly) {
    const W = 90, H = 26;
    const max = Math.max(...weekly.map(w => w.gross), 1);
    const bw = W / weekly.length;
    return `<svg viewBox="0 0 ${W} ${H}" class="spark" aria-hidden="true">
      ${weekly.map((w, i) => {
        const h = Math.max(1.5, w.gross / max * (H - 2));
        return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" class="spark-bar"/>`;
      }).join('')}</svg>`;
  }

  registerRoute('insights_bind', (app) => {
    app.querySelectorAll('[data-horizon]').forEach(b => b.onclick = () => {
      fcHorizon = b.dataset.horizon; render();
    });

    // what-if: recompute instantly from month-to-date baseline
    const wi = app.querySelector('.whatif');
    if (wi) {
      const base = {
        rev: Number(wi.dataset.rev), vc: Number(wi.dataset.var), comm: Number(wi.dataset.comm),
        rec: Number(wi.dataset.rec), one: Number(wi.dataset.one)
      };
      const els = ['wiPrice', 'wiVar', 'wiRec'].map(id => app.querySelector('#' + id));
      const calcWi = () => {
        const [priceP, varP, recExtra] = els.map(e => Number(e.value));
        app.querySelector('#wiPriceVal').textContent = (priceP > 0 ? '+' : '') + priceP + '%';
        app.querySelector('#wiVarVal').textContent = (varP > 0 ? '+' : '') + varP + '%';
        app.querySelector('#wiRecVal').textContent = money(recExtra);
        if (base.rev <= 0) { app.querySelector('#wiResult').textContent = 'Log some sales this month first.'; return; }
        const rev2 = base.rev * (1 + priceP / 100);
        const commRatio = base.comm / base.rev;            // commissions scale with sales
        const vc2 = base.vc * (1 + varP / 100);            // food cost change
        // extra monthly recurring, prorated to the days elapsed this month
        const rec2 = base.rec + recExtra * ((Number(wi.dataset.dom) || 30) / 30.4);
        const profit2 = rev2 - vc2 - rev2 * commRatio - rec2 - base.one;
        const margin2 = profit2 / rev2;
        const baseProfit = base.rev - base.vc - base.comm - base.rec - base.one;
        const ratio2 = (vc2 + rev2 * commRatio) / rev2;
        const be2 = ratio2 < 0.99 ? (rec2 + base.one) / (1 - ratio2) : null;
        app.querySelector('#wiResult').innerHTML =
          `Month so far would be: profit <strong>${money(profit2)}</strong> (${money(profit2 - baseProfit) } vs real) ·
           net margin <strong>${pct(margin2)}</strong>${be2 ? ` · break-even sales <strong>${money(be2)}</strong>` : ''}`;
      };
      els.forEach(e => e.oninput = calcWi);
      calcWi();
    }

    // goals
    const gf = app.querySelector('#goalForm');
    app.querySelector('#saveGoals').onclick = async () => {
      const f = new FormData(gf);
      try {
        await api('/goals', { method: 'PUT', body: { location_id: state.locationId, type: 'profit', target: f.get('profit') || null } });
        await api('/goals', { method: 'PUT', body: { location_id: state.locationId, type: 'margin', target: f.get('margin') || null } });
        toast('Goals saved'); render();
      } catch (err) { toast(err.message, true); }
    };

    // location comparison (owner, 2+ locations)
    if (isOwner() && state.me.locations.length > 1) {
      api('/compare').then(rows => {
        const slot = app.querySelector('#compareSlot');
        if (!slot) return;
        slot.innerHTML = `<div class="card">
          <div class="card-title">Your locations this month</div>
          ${rows.map(r => `<div class="bd-row"><div class="bd-name"><strong>${esc(r.name)}</strong></div>
            <div class="bd-amt ${r.profit >= 0 ? 'pos' : 'neg'}">${money(r.profit)}</div>
            <div class="bd-inv hint">${money(r.revenue)} sold · ${r.netMargin === null ? '—' : pct(r.netMargin)}</div></div>`).join('')}
        </div>`;
      }).catch(() => {});
    }
  });

  // ======================================================================
  // Team schedule
  // ======================================================================
  let schedWeek = null; // Monday of the shown week
  const mondayOf = d => {
    const dt = new Date(d + 'T12:00:00');
    return addDays(d, -((dt.getDay() + 6) % 7));
  };
  const fmtTime = min => {
    const h = Math.floor(min / 60), m = min % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
  };
  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  registerRoute('schedule', async () => {
    schedWeek = schedWeek || mondayOf(today());
    const d = await api(`/schedule?${qLoc()}&week=${schedWeek}`);
    schedWeek = d.week;
    const perEmp = Object.fromEntries(d.perEmployee.map(p => [p.employee_id, p]));
    const shiftMap = {};
    d.shifts.forEach(s => { shiftMap[`${s.employee_id}|${s.date}`] = s; });
    const isToday = date => date === today();

    const budgetPill = { over: ['bad', 'Over budget'], under: ['warn', 'Under budget'], ok: ['good', 'On budget'], na: ['', ''] }[d.budget.flag];
    const overtime = d.employees.filter(e => perEmp[e.id]?.overtime);

    return `
      <h2 class="page-title">Team schedule</h2>
      <div class="period-bar"><div class="period-nav">
        <button class="icon-btn" id="prevWeek" aria-label="Previous week">‹</button>
        <span class="period-label">${fmtRange(d.days[0], d.days[6])}</span>
        <button class="icon-btn" id="nextWeek" aria-label="Next week">›</button>
        ${schedWeek !== mondayOf(today()) ? '<button class="btn tiny" id="thisWeek">This week</button>' : ''}
      </div></div>

      ${d.employees.length === 0 ? `
        <div class="card"><div class="card-title">No employees yet</div>
          <p class="hint">Add your team below and the schedule grid appears here.</p></div>` : `
      <div class="card sched-card">
        <div class="sched-scroll">
          <table class="sched">
            <thead><tr><th class="sched-name">Employee</th>
              ${d.days.map((dt, i) => `<th class="${isToday(dt) ? 'today' : ''}">${DAY_NAMES[i]}<div class="hint">${dt.slice(8)}</div></th>`).join('')}
              <th>Hrs</th><th>Cost</th></tr></thead>
            <tbody>
              ${d.employees.map(e => `
                <tr>
                  <td class="sched-name"><strong>${esc(e.name)}</strong>
                    <div class="hint">${esc(e.position || '')}${perEmp[e.id]?.overtime ? ' <span class="pill warn">+48h</span>' : ''}</div></td>
                  ${d.days.map(dt => {
                    const s = shiftMap[`${e.id}|${dt}`];
                    return `<td><button class="shift-cell ${s ? 'filled' : ''} ${isToday(dt) ? 'today' : ''}"
                      data-emp="${e.id}" data-date="${dt}" data-name="${esc(e.name)}"
                      data-start="${s ? s.start_min : ''}" data-end="${s ? s.end_min : ''}">
                      ${s ? `${fmtTime(s.start_min)}<br>${fmtTime(s.end_min)}` : '+'}</button></td>`;
                  }).join('')}
                  <td class="sched-num">${(perEmp[e.id]?.hours || 0).toFixed(1)}</td>
                  <td class="sched-num">${money(perEmp[e.id]?.cost || 0)}${e.pay_type === 'salary' ? '<div class="hint">salary</div>' : ''}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="sched-actions">
          <button class="btn tiny" id="copyWeek">⧉ Copy last week</button>
          <button class="btn tiny" id="exportPng">⬇ Export as image</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">This week's labor cost</div>
        <div class="be-row"><span>Scheduled (${d.totals.hours.toFixed(1)} h total)</span><strong>${money(d.totals.cost)}</strong></div>
        ${d.budget.amount > 0 ? `
          <div class="be-row"><span>Budgeted payroll (recurring costs tagged "labor")</span><strong>${money(d.budget.amount)}</strong></div>
          <div class="be-row"><span>Difference</span>
            <strong>${d.totals.cost >= d.budget.amount ? '+' : ''}${money(d.totals.cost - d.budget.amount)}
            <span class="pill ${budgetPill[0]}">${budgetPill[1]}</span></strong></div>`
          : `<div class="hint">Tag a recurring cost category as "labor" in Settings and add your payroll there to compare scheduled vs budgeted cost.</div>`}
        ${overtime.length ? `<div class="hint">⚠ Over 48 h/week (typical Mexican full-time standard): ${overtime.map(e => esc(e.name)).join(', ')}. Just a heads-up, not legal advice.</div>` : ''}
        <div class="hint">This cost books itself into your numbers automatically, spread day by day — hourly people on the days they work, salaries split across the week. No need to log it as a cost anywhere else.</div>
      </div>`}

      <details class="card" id="rosterBox">
        <summary class="card-title">Manage employees (${d.employees.length})</summary>
        ${d.employees.map(e => `
          <div class="list-row" data-emp="${e.id}">
            <div><strong>${esc(e.name)}</strong>
              <div class="hint">${esc(e.position || '—')} · ${e.pay_type === 'salary' ? `${money(e.rate)}/week salary` : `${money2(e.rate)}/hour`}</div></div>
            <div class="list-right">
              <button class="icon-btn edit-emp" aria-label="Edit">✎</button>
              <button class="icon-btn danger del-emp" aria-label="Remove">✕</button>
            </div>
          </div>`).join('')}
        <form id="empForm" class="emp-form">
          <div class="row2">
            <label>Name<input name="name" required placeholder="Ana"></label>
            <label>Role<input name="position" placeholder="Cocina, caja, mesero…"></label>
          </div>
          <div class="row2">
            <label>Pay type
              <select name="pay_type"><option value="hourly">Per hour</option><option value="salary">Fixed weekly salary</option></select></label>
            <label>Rate <span class="hint">($/h or $/week)</span>
              <input type="number" inputmode="decimal" step="any" min="0" name="rate" required placeholder="0"></label>
          </div>
          <button class="btn primary" type="submit">+ Add employee</button>
        </form>
      </details>`;
  });

  registerRoute('schedule_bind', (app) => {
    const rerender = () => render();
    app.querySelector('#prevWeek').onclick = () => { schedWeek = addDays(schedWeek, -7); rerender(); };
    app.querySelector('#nextWeek').onclick = () => { schedWeek = addDays(schedWeek, 7); rerender(); };
    const tw = app.querySelector('#thisWeek');
    if (tw) tw.onclick = () => { schedWeek = mondayOf(today()); rerender(); };

    // shift cells
    app.querySelectorAll('.shift-cell').forEach(btn => btn.onclick = () => shiftDialog(btn));

    // copy last week
    const cp = app.querySelector('#copyWeek');
    if (cp) cp.onclick = async () => {
      if (!confirm('Replace this week with a copy of last week\'s schedule?')) return;
      try {
        const r = await api('/schedule/copy-last-week', { method: 'POST',
          body: { location_id: state.locationId, week: schedWeek } });
        toast(`Copied ${r.copied} shifts`); rerender();
      } catch (err) { toast(err.message, true); }
    };

    // PNG export
    const ex = app.querySelector('#exportPng');
    if (ex) ex.onclick = () => exportSchedulePng();

    // roster
    const form = app.querySelector('#empForm');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      try {
        await api(`/employees?${qLoc()}`, { method: 'POST', body: {
          location_id: state.locationId, name: f.get('name'), position: f.get('position'),
          pay_type: f.get('pay_type'), rate: Number(f.get('rate')) } });
        toast('Employee added'); rerender();
      } catch (err) { toast(err.message, true); }
    };
    app.querySelectorAll('.del-emp').forEach(b => b.onclick = async () => {
      const row = b.closest('.list-row');
      if (!confirm('Remove this employee? Past schedules are kept.')) return;
      await api(`/employees/${row.dataset.emp}?${qLoc()}`, { method: 'DELETE' });
      toast('Removed'); rerender();
    });
    app.querySelectorAll('.edit-emp').forEach(b => b.onclick = () => empDialog(b.closest('.list-row').dataset.emp));
  });

  function shiftDialog(btn) {
    const { emp, date, name } = btn.dataset;
    const start = btn.dataset.start !== '' ? fmtTime(Number(btn.dataset.start)).padStart(5, '0') : '09:00';
    const end = btn.dataset.end !== '' ? fmtTime(Number(btn.dataset.end)).padStart(5, '0') : '17:00';
    const pad = t => { const [h, m] = t.split(':'); return `${h.padStart(2, '0')}:${m}`; };
    modal(`
      <h3>${esc(name)} — ${fmtDate(date)}</h3>
      <form id="shiftForm">
        <div class="row2">
          <label>Starts<input type="time" name="start" value="${pad(start)}" required></label>
          <label>Ends<input type="time" name="end" value="${pad(end)}" required></label>
        </div>
        <p class="hint">If it ends past midnight, just set the end time earlier than the start — it counts to the next day.</p>
        <div class="modal-actions">
          ${btn.dataset.start !== '' ? '<button type="button" class="btn danger-btn" id="clearShift">Clear shift</button>' : ''}
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>`, (wrap, close) => {
      wrap.querySelector('[data-close]').onclick = close;
      const clear = wrap.querySelector('#clearShift');
      if (clear) clear.onclick = async () => {
        await api(`/schedule/shift?${qLoc()}&employee_id=${emp}&date=${date}`, { method: 'DELETE' });
        close(); render();
      };
      wrap.querySelector('#shiftForm').onsubmit = async e => {
        e.preventDefault();
        const f = new FormData(e.target);
        try {
          await api('/schedule/shift', { method: 'PUT', body: {
            location_id: state.locationId, employee_id: Number(emp), date,
            start_min: toMin(f.get('start')), end_min: toMin(f.get('end')) } });
          close(); render();
        } catch (err) { toast(err.message, true); }
      };
    });
  }

  async function empDialog(id) {
    const emps = await api(`/employees?${qLoc()}`);
    const e = emps.find(x => x.id === Number(id));
    if (!e) return;
    modal(`
      <h3>Edit employee</h3>
      <form id="empEdit">
        <label>Name<input name="name" value="${esc(e.name)}" required></label>
        <label>Role<input name="position" value="${esc(e.position || '')}"></label>
        <div class="row2">
          <label>Pay type
            <select name="pay_type">
              <option value="hourly" ${e.pay_type === 'hourly' ? 'selected' : ''}>Per hour</option>
              <option value="salary" ${e.pay_type === 'salary' ? 'selected' : ''}>Fixed weekly salary</option>
            </select></label>
          <label>Rate<input type="number" inputmode="decimal" step="any" min="0" name="rate" value="${e.rate}" required></label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>`, (wrap, close) => {
      wrap.querySelector('[data-close]').onclick = close;
      wrap.querySelector('#empEdit').onsubmit = async ev => {
        ev.preventDefault();
        const f = new FormData(ev.target);
        await api(`/employees/${e.id}?${qLoc()}`, { method: 'PUT', body: {
          location_id: state.locationId, name: f.get('name'), position: f.get('position'),
          pay_type: f.get('pay_type'), rate: Number(f.get('rate')) } });
        close(); toast('Saved'); render();
      };
    });
  }

  // Draws the week to a canvas and downloads a PNG — names, days and times only.
  async function exportSchedulePng() {
    const d = await api(`/schedule?${qLoc()}&week=${schedWeek}`);
    const locName = state.me.locations.find(l => l.id === state.locationId)?.name || '';
    const shiftMap = {};
    d.shifts.forEach(s => { shiftMap[`${s.employee_id}|${s.date}`] = s; });

    const nameW = 170, dayW = 110, rowH = 52, headH = 84, dayHeadH = 44;
    const W = nameW + dayW * 7 + 2, H = headH + dayHeadH + rowH * d.employees.length + 16;
    const scale = 2;
    const cv = document.createElement('canvas');
    cv.width = W * scale; cv.height = H * scale;
    const ctx = cv.getContext('2d');
    ctx.scale(scale, scale);

    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    // header
    ctx.fillStyle = '#1a7f5a'; ctx.fillRect(0, 0, W, headH);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 22px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText(locName, 16, 34);
    ctx.font = '400 15px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText(`Week: ${fmtRange(d.days[0], d.days[6])}`, 16, 60);

    // day headers
    ctx.fillStyle = '#f5f7f6'; ctx.fillRect(0, headH, W, dayHeadH);
    ctx.fillStyle = '#1e2a26';
    ctx.font = '700 13px -apple-system, Segoe UI, Roboto, sans-serif';
    d.days.forEach((dt, i) => {
      const x = nameW + i * dayW;
      ctx.fillText(`${DAY_NAMES[i]} ${dt.slice(8)}`, x + 10, headH + 27);
    });

    // rows
    d.employees.forEach((e, r) => {
      const y = headH + dayHeadH + r * rowH;
      if (r % 2 === 1) { ctx.fillStyle = '#f8faf9'; ctx.fillRect(0, y, W, rowH); }
      ctx.fillStyle = '#1e2a26';
      ctx.font = '700 14px -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.fillText(e.name.slice(0, 20), 12, y + 22);
      if (e.position) {
        ctx.fillStyle = '#64756e';
        ctx.font = '400 12px -apple-system, Segoe UI, Roboto, sans-serif';
        ctx.fillText(e.position.slice(0, 22), 12, y + 40);
      }
      d.days.forEach((dt, i) => {
        const s = shiftMap[`${e.id}|${dt}`];
        const x = nameW + i * dayW;
        if (s) {
          ctx.fillStyle = '#e6f4ee';
          ctx.fillRect(x + 4, y + 6, dayW - 8, rowH - 12);
          ctx.fillStyle = '#14684a';
          ctx.font = '600 13px -apple-system, Segoe UI, Roboto, sans-serif';
          ctx.fillText(`${fmtTime(s.start_min)} – ${fmtTime(s.end_min)}`, x + 12, y + 31);
        } else {
          ctx.fillStyle = '#c8d2cd';
          ctx.font = '400 13px -apple-system, Segoe UI, Roboto, sans-serif';
          ctx.fillText('—', x + 12, y + 31);
        }
      });
    });

    // grid lines
    ctx.strokeStyle = '#e3e9e6'; ctx.lineWidth = 1;
    for (let i = 0; i <= 7; i++) {
      const x = nameW + i * dayW;
      ctx.beginPath(); ctx.moveTo(x, headH); ctx.lineTo(x, H - 16); ctx.stroke();
    }
    for (let r = 0; r <= d.employees.length; r++) {
      const y = headH + dayHeadH + r * rowH;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    const a = document.createElement('a');
    a.download = `horario-${locName.replace(/\s+/g, '-').toLowerCase()}-${d.week}.png`;
    a.href = cv.toDataURL('image/png');
    a.click();
    toast('Schedule image downloaded');
  }

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
        ${group('Money accounts', 'accounts', cats.accounts, c =>
          `Opening balance: ${money(c.opening_balance || 0)}`)}
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
            ${u.role !== 'owner' ? `<div class="list-right">
              <button class="icon-btn edit-user" aria-label="Edit">✎</button>
              <button class="icon-btn danger del-user" aria-label="Remove">✕</button></div>` : ''}
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
    app.querySelectorAll('.edit-user').forEach(b => b.onclick = () => {
      const row = b.closest('.list-row');
      const name = row.querySelector('strong').textContent;
      modal(`
        <h3>Edit manager</h3>
        <form id="userEdit">
          <label>Name<input name="name" value="${esc(name)}" required></label>
          <label>New password <span class="hint">(leave empty to keep the current one)</span>
            <input name="password" minlength="8" placeholder="••••••••"></label>
          <div class="modal-actions">
            <button type="button" class="btn" data-close>Cancel</button>
            <button type="submit" class="btn primary">Save</button>
          </div>
        </form>`, (wrap, close) => {
        wrap.querySelector('[data-close]').onclick = close;
        wrap.querySelector('#userEdit').onsubmit = async e => {
          e.preventDefault();
          const f = new FormData(e.target);
          const body = { name: f.get('name') };
          if (f.get('password')) body.password = f.get('password');
          try {
            await api(`/users/${row.dataset.user}`, { method: 'PUT', body });
            close(); toast('Saved'); render();
          } catch (err) { toast(err.message, true); }
        };
      });
    });
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
      : group === 'accounts' ? `
      <label>Opening balance <span class="hint">(what's in it right now)</span>
        <input type="number" step="any" name="opening_balance" value="0"></label>`
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
            opening_balance: f.get('opening_balance') || 0,
            benchmark_tag: f.get('benchmark_tag') || null } });
          close(); toast('Category added'); render();
        } catch (err) { toast(err.message, true); }
      };
    });
  }

  async function editCategory(group, id, currentName) {
    // Revenue channels get commission settings; accounts get an opening balance.
    let commissionFields = '';
    if (group === 'revenue') {
      const cats = await api(`/categories?${qLoc()}`);
      const cat = cats.revenue.find(c => c.id === id) || {};
      commissionFields = `
        <label>Commission on this channel <span class="hint">(% taken off each sale — 0 for none)</span>
          <input type="number" step="any" min="0" max="100" name="commission_percent" value="${cat.commission_percent ?? 0}"></label>
        <label class="inv-toggle big"><input type="checkbox" name="commission_invoiced" ${cat.commission_invoiced ? 'checked' : ''}>Commission is invoiced (facturada)</label>
        <p class="hint">Changing the % only affects sales you log from now on — past days keep the commission they were saved with.</p>`;
    } else if (group === 'accounts') {
      const cats = await api(`/categories?${qLoc()}`);
      const cat = cats.accounts.find(c => c.id === id) || {};
      commissionFields = `
        <label>Opening balance
          <input type="number" step="any" name="opening_balance" value="${cat.opening_balance ?? 0}"></label>`;
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
        } else if (group === 'accounts') {
          body.opening_balance = f.get('opening_balance') || 0;
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
