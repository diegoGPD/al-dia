/* Al Día — money: cost breakdown & accounts */
'use strict';
(() => {
  const { api, state, registerRoute, nav, render, loadMe,
          money, money2, pct, esc, fmtDate, fmtRange, today, addDays, addMonths, toast } = App;
  const { isOwner, qLoc, modal, periodBar, bindPeriodBar, fetchDashboard, periodQuery, moveDayDialog, trendChart } = App.ui;

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
      <div class="card" id="channelCard">
        <div class="card-title">Commission by channel</div>
        <div class="hint" id="channelBody">Loading…</div>
      </div>
      ${c.costs.reconciliations && c.costs.reconciliations.length ? `
      <div class="card">
        <div class="card-title">Real payouts applied to this period</div>
        ${c.costs.reconciliations.map(r => `
          <div class="bd-row"><div class="bd-name">${esc(r.channel)}<span class="hint"> · ${esc(r.window)}${r.share < 0.999 ? ` · ${Math.round(r.share * 100)}% of it falls here` : ''}</span></div>
            <div class="bd-amt ${r.variance < 0 ? 'neg' : 'pos'}">${r.variance >= 0 ? '+' : ''}${money(r.variance)}</div>
            <div class="bd-inv hint">est ${money(r.estimated_net)} → real ${money(r.actual_net)}</div></div>`).join('')}
        <div class="hint">These figures replace the commission estimate in this period's profit, margin and break-even.
          Estimated commissions were ${money(c.costs.commissionsEstimated)}; after corrections, ${money(c.costs.commissions)}.</div>
      </div>` : ''}
      <div class="card" id="reconCard">
        <div class="card-title">🔒 Reconcile a real payout</div>
        <div id="reconBody" class="hint">Loading…</div>
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
  let channelFilter = null; // null = all channels

  registerRoute('breakdown_bind', (app) => {
    bindPeriodBar(app);
    loadChannels(app);
    if (isOwner()) loadReconcile(app);
    else { const b = app.querySelector('#reconCard'); if (b) b.remove(); }
  });

  // ---- PIN-gated payout reconciliation ----
  async function loadReconcile(app) {
    const box = app.querySelector('#reconBody');
    if (!box) return;
    const [status, chans, history] = await Promise.all([
      api('/reconcile/status'),
      api(`/channels?${qLoc()}&${periodQuery()}`),
      api(`/reconcile/history?${qLoc()}`)
    ]);

    const historyHtml = history.length ? `
      <details style="margin-top:12px"><summary class="hint">History (${history.length})</summary>
        ${history.map(h => `
          <div class="bd-row"><div class="bd-name">${esc(h.channel)}
            <span class="hint">${h.start_date} → ${h.end_date} · saved ${h.created_at.slice(0, 10)}${h.note ? ' · ' + esc(h.note) : ''}</span></div>
            <div class="bd-amt ${h.variance < 0 ? 'neg' : 'pos'}">${h.variance >= 0 ? '+' : ''}${money(h.variance)}</div>
            <div class="bd-inv hint">${money(h.estimated_net)} → ${money(h.actual_net)}
              ${status.unlocked ? `<button class="icon-btn danger del-recon" data-id="${h.id}" aria-label="Delete">✕</button>` : ''}</div></div>`).join('')}
      </details>` : '';

    if (!status.unlocked) {
      box.innerHTML = `
        <p class="hint">Entering real payouts overrides estimated figures, so it's PIN-protected.</p>
        <form id="pinForm" class="row2">
          <label>PIN<input type="password" inputmode="numeric" name="pin" placeholder="••••" autocomplete="off"></label>
          <button class="btn primary" type="submit" style="align-self:end">Unlock</button>
        </form>
        ${historyHtml}`;
      box.querySelector('#pinForm').onsubmit = async (e) => {
        e.preventDefault();
        try {
          const r = await api('/reconcile/unlock', { method: 'POST', body: { pin: new FormData(e.target).get('pin') } });
          toast(`Unlocked for ${r.minutes} minutes`);
          loadReconcile(app);
        } catch (err) { toast(err.message, true); }
      };
      return;
    }

    const withSales = chans.channels.filter(c => c.revenue > 0);
    box.innerHTML = `
      <p class="hint">Unlocked (${Math.round(status.expiresInSec / 60)} min left) ·
        <a href="#" id="lockNow">lock now</a> · <a href="#" id="changePin">change PIN</a></p>
      ${withSales.length ? `
      <form id="reconForm">
        <div class="row2">
          <label>Channel
            <select name="category_id">
              ${withSales.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
            </select></label>
          <label>Actual amount received
            <input type="number" inputmode="decimal" step="any" min="0" name="actual_net" placeholder="0" required></label>
        </div>
        <div class="row2">
          <label>From<input type="date" name="start" value="${chans.start}" required></label>
          <label>To<input type="date" name="end" value="${chans.end}" required></label>
        </div>
        <label>Note <span class="hint">(optional)</span><input name="note" placeholder="Payout Uber semana 28"></label>
        <div class="day-rev" id="reconPreview"></div>
        <button class="btn primary full" type="submit">Save real payout</button>
      </form>` : '<p class="hint">No channel sales in this period to reconcile.</p>'}
      ${historyHtml}`;

    box.querySelector('#lockNow').onclick = async (e) => {
      e.preventDefault();
      await api('/reconcile/lock', { method: 'POST' });
      toast('Locked'); loadReconcile(app);
    };
    box.querySelector('#changePin').onclick = (e) => { e.preventDefault(); changePinDialog(); };
    box.querySelectorAll('.del-recon').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this correction? The estimate applies again for that period.')) return;
      await api(`/reconcile/${b.dataset.id}?${qLoc()}`, { method: 'DELETE' });
      toast('Deleted'); render();
    });

    const form = box.querySelector('#reconForm');
    if (!form) return;
    const preview = box.querySelector('#reconPreview');
    const refresh = async () => {
      const f = new FormData(form);
      try {
        const p = await api(`/reconcile/preview?${qLoc()}&category_id=${f.get('category_id')}&start=${f.get('start')}&end=${f.get('end')}`);
        const actual = Number(f.get('actual_net'));
        const diff = actual ? actual - p.estimated_net : null;
        preview.innerHTML = `Sold ${money(p.gross)} · estimated kept <strong>${money(p.estimated_net)}</strong>` +
          (diff !== null && f.get('actual_net') !== ''
            ? ` → actual <strong>${money(actual)}</strong> <span class="${diff < 0 ? 'neg' : 'pos'}">(${diff >= 0 ? '+' : ''}${money(diff)})</span>` : '') +
          (p.overlapping.length ? `<br>⚠ Already reconciled ${p.overlapping[0].start_date} → ${p.overlapping[0].end_date}` : '');
      } catch (err) { preview.textContent = err.message; }
    };
    form.querySelectorAll('select,input').forEach(el => el.addEventListener('change', refresh));
    form.querySelector('[name=actual_net]').addEventListener('input', refresh);
    refresh();

    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      try {
        const r = await api(`/reconcile?${qLoc()}`, { method: 'POST', body: {
          location_id: state.locationId, category_id: Number(f.get('category_id')),
          start: f.get('start'), end: f.get('end'),
          actual_net: Number(f.get('actual_net')), note: f.get('note') } });
        toast(`${r.channel}: estimated ${money(r.estimated_net)} → actual ${money(r.actual_net)} (${r.variance >= 0 ? '+' : ''}${money(r.variance)})`);
        render();
      } catch (err) { toast(err.message, true); }
    };
  }

  function changePinDialog() {
    modal(`
      <h3>Change reconciliation PIN</h3>
      <form id="pinChange">
        <label>Current PIN<input type="password" inputmode="numeric" name="current_pin" required autocomplete="off"></label>
        <label>New PIN <span class="hint">(4–8 digits)</span>
          <input type="password" inputmode="numeric" name="new_pin" required pattern="\\d{4,8}" autocomplete="off"></label>
        <div class="modal-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn primary">Change PIN</button>
        </div>
      </form>`, (wrap, close) => {
      wrap.querySelector('[data-close]').onclick = close;
      wrap.querySelector('#pinChange').onsubmit = async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        try {
          await api('/reconcile/change-pin', { method: 'POST', body: {
            current_pin: f.get('current_pin'), new_pin: f.get('new_pin') } });
          close(); toast('PIN changed — reconciliation re-locked'); render();
        } catch (err) { toast(err.message, true); }
      };
    });
  }

  async function loadChannels(app) {
    const box = app.querySelector('#channelBody');
    if (!box) return;
    const d = await api(`/channels?${qLoc()}&${periodQuery()}${channelFilter ? '&channel=' + channelFilter : ''}`);
    const rows = d.channels.filter(c => c.revenue > 0 || c.id === channelFilter);
    box.innerHTML = `
      <div class="ch-filter">
        <select id="chanPick">
          <option value="">All channels</option>
          ${d.allChannels.map(c => `<option value="${c.id}" ${channelFilter === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>
      ${rows.length ? `
      <table class="chan-table">
        <thead><tr><th>Channel</th><th>Sold</th><th>Rate</th><th>Commission</th><th>Kept</th></tr></thead>
        <tbody>
          ${rows.sort((a, b) => b.commission - a.commission).map(r => `
            <tr>
              <td>${esc(r.name)}</td>
              <td>${money(r.revenue)}</td>
              <td class="${r.effective_percent >= 40 ? 'neg' : ''}">${r.effective_percent === null ? '—' : r.effective_percent.toFixed(1) + '%'}</td>
              <td><strong>${money(r.commission)}</strong></td>
              <td class="pos">${money(r.net)}</td>
            </tr>`).join('')}
        </tbody>
        <tfoot><tr>
          <td><strong>${channelFilter ? 'Selected' : 'All channels'}</strong></td>
          <td><strong>${money(d.totals.revenue)}</strong></td>
          <td>${d.totals.revenue > 0 ? (d.totals.commission / d.totals.revenue * 100).toFixed(1) + '%' : '—'}</td>
          <td><strong>${money(d.totals.commission)}</strong></td>
          <td class="pos"><strong>${money(d.totals.net)}</strong></td>
        </tr></tfoot>
      </table>
      <div class="hint">Rate shown is what you actually paid this period (commission ÷ sold), so a channel whose rate changed mid-period reads honestly. Works with any period, including custom ranges.</div>`
      : '<div class="hint">No sales through these channels in this period.</div>'}`;
    box.querySelector('#chanPick').onchange = (e) => {
      channelFilter = Number(e.target.value) || null;
      loadChannels(app);
    };
  }

  // ======================================================================
  // Money accounts view
  // ======================================================================
  registerRoute('accounts', async () => {
    const d = await api(`/accounts-view?${qLoc()}&${periodQuery()}`);
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

})();
