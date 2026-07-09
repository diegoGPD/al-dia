/* Al Día — money: cost breakdown & accounts */
'use strict';
(() => {
  const { api, state, registerRoute, nav, render, loadMe,
          money, money2, pct, esc, fmtDate, fmtRange, today, addDays, addMonths, toast } = App;
  const { isOwner, qLoc, modal, periodBar, bindPeriodBar, fetchDashboard, moveDayDialog, trendChart } = App.ui;

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

})();
