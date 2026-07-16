/* Al Día — logging flows: hub, sales, day costs, one-offs, recurring */
'use strict';
(() => {
  const { api, state, registerRoute, nav, render, loadMe,
          money, money2, pct, esc, fmtDate, fmtRange, today, addDays, addMonths, toast } = App;
  const { isOwner, qLoc, modal, periodBar, bindPeriodBar, fetchDashboard, moveDayDialog, trendChart } = App.ui;

  // ======================================================================
  // Log hub
  // ======================================================================
  registerRoute('log', async () => `
    <h2 class="page-title">Log something</h2>
    <div class="log-menu">
      <a href="#/scan" class="log-tile"><span class="log-icon">🎟️</span>
        <div><strong>Scan loyalty card</strong><div class="hint">Stamp a customer's visit</div></div></a>
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
              <div class="hint">${fmtDate(o.date)} · ${o.invoiced ? 'Invoiced' : 'Not invoiced'}${o.logged_by ? ' · by ' + esc(o.logged_by) : ''}${o.receipt ? ` · <a href="/api/oneoff/${o.id}/receipt" target="_blank">📎 receipt</a>` : ''}</div></div>
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

})();
