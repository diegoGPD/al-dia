/* Al Día — settings */
'use strict';
(() => {
  const { api, state, registerRoute, nav, render, loadMe,
          money, money2, pct, esc, fmtDate, fmtRange, today, addDays, addMonths, toast } = App;
  const { isOwner, qLoc, modal, periodBar, bindPeriodBar, fetchDashboard, moveDayDialog, trendChart } = App.ui;

  // ======================================================================
  // Settings
  // ======================================================================
  registerRoute('settings', async () => {
    const parts = [`<h2 class="page-title">Settings</h2>`];
    if (isOwner()) {
      const cats = await api(`/categories?${qLoc()}`);
      parts.push(categoriesSection(cats));
      parts.push(await loyaltySection());
      parts.push(await posSection());
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

  async function loyaltySection() {
    const cfg = await api(`/loyalty/config?${qLoc()}`);
    return `
      <div class="card">
        <div class="card-title">Loyalty program</div>
        <form id="loyaltyForm">
          <label>Program name<input name="program_name" value="${esc(cfg.program_name)}"></label>
          <div class="row2">
            <label>Stamps for a reward<input type="number" min="2" max="50" name="stamps_needed" value="${cfg.stamps_needed}"></label>
            <label>The reward<input name="reward_text" value="${esc(cfg.reward_text)}"></label>
          </div>
          <label class="inv-toggle big"><input type="checkbox" name="active" ${cfg.active ? 'checked' : ''}>Program active (signups open)</label>
          <button class="btn primary" type="submit">Save program</button>
        </form>
        <div class="be-row" style="margin-top:14px"><span>Customers signed up</span><strong>${cfg.customers}</strong></div>
        <div class="be-row"><span>Visits stamped this month</span><strong>${cfg.visitsThisMonth}</strong></div>
        <div class="be-row"><span>Apple Wallet</span>
          <span class="pill ${cfg.appleReady ? (cfg.appleCert && cfg.appleCert.daysLeft < 45 ? 'warn' : 'good') : 'warn'}">${cfg.appleReady ? 'Active' : 'Not configured'}</span></div>
        ${cfg.appleCert ? (() => {
          const c = cfg.appleCert;
          if (c.daysLeft < 0) return `<div class="status-banner bad" style="padding:10px"><div class="status-sub">⚠️ Your Apple pass certificate EXPIRED on ${c.expires}. New passes can't be issued and existing ones won't update until you renew it (docs/WALLET-SETUP.md, steps 3–6).</div></div>`;
          if (c.daysLeft < 45) return `<div class="status-banner warn" style="padding:10px"><div class="status-sub">⚠️ Your Apple pass certificate expires in ${c.daysLeft} days (${c.expires}). Renew it before then or passes stop updating — see docs/WALLET-SETUP.md.</div></div>`;
          return `<div class="hint">Apple certificate valid until ${c.expires} (${c.daysLeft} days). You'll see a warning here 45 days before it expires.</div>`;
        })() : ''}
        <div class="be-row"><span>Google Wallet</span>
          <span class="pill ${cfg.googleReady ? 'good' : 'warn'}">${cfg.googleReady ? 'Active' : 'Not configured'}</span></div>
        ${cfg.googleReady ? `<div class="hint">Reminder: until Google grants your issuer account <strong>publishing access</strong> (request it in the Google Pay & Wallet Console), only test accounts you've added there can save the card. Real customers need publishing approval.</div>` : ''}
        ${!cfg.appleReady || !cfg.googleReady ? `<div class="hint">Customers get the web card either way. To enable the wallet buttons, follow docs/WALLET-SETUP.md in the project.</div>` : ''}
        <div class="quick-actions" style="margin-top:12px">
          <a class="btn" href="/loyalty/qr" target="_blank">🖨 Printable signup QR</a>
          <a class="btn" href="/loyalty/join" target="_blank">👀 See signup page</a>
        </div>
        <details style="margin-top:10px"><summary class="hint">Wallet setup (Apple / Google)</summary>
          <form id="walletForm" style="margin-top:10px">
            <p class="hint"><strong>Apple:</strong> export your Pass Type ID certificate from Keychain Access as a .p12 and upload it here — the server converts it itself, no Terminal needed.</p>
            <div class="row2">
              <label>Pass Type ID<input name="pass_type_id" value="${esc(cfg.pass_type_id || '')}" placeholder="pass.com.aldia.loyalty"></label>
              <label>Apple Team ID<input name="apple_team_id" value="${esc(cfg.apple_team_id || '')}" placeholder="A1B2C3D4E5"></label>
            </div>
            <div class="row2">
              <label>Certificate (.p12)<input type="file" name="p12" accept=".p12,.pfx"></label>
              <label>.p12 password<input type="password" name="p12_password" autocomplete="off"></label>
            </div>
            <p class="hint"><strong>Google:</strong> your Issuer ID plus the service-account key JSON.</p>
            <div class="row2">
              <label>Google Issuer ID<input name="google_issuer_id" value="${esc(cfg.google_issuer_id || '')}" placeholder="3388000000012345678"></label>
              <label>Service account key (.json)<input type="file" name="sajson" accept=".json,application/json"></label>
            </div>
            <button class="btn primary" type="submit">Save wallet setup</button>
            <p class="hint">Files are stored only on the server. They're never shown back or sent to any browser.</p>
          </form>
        </details>
        <details style="margin-top:10px"><summary class="hint">Customers (${cfg.customers})</summary>
          <div id="custList" class="hint">Loading…</div>
        </details>
      </div>`;
  }

  async function posSection() {
    const [info, pdInfo, pdRates] = await Promise.all([
      api(`/webhooks/pos-info?${qLoc()}`),
      api(`/webhooks/pd-status?${qLoc()}`),
      api(`/webhooks/pd-rates?${qLoc()}`)
    ]);
    const badge = { processed: 'good', stored: 'warn', error: 'bad', tracked: '' };
    const pdBlock = `
      <div style="border-top:1px solid var(--line);margin-top:14px;padding-top:12px">
        <strong>PideDirecto</strong>
        <div class="be-row" style="margin-top:6px"><span>API key on server</span>
          <span class="pill ${pdInfo.apiKeyPresent ? 'good' : 'warn'}">${pdInfo.apiKeyPresent ? 'Present' : 'Missing — set PIDEDIRECTO_API_KEY in Railway'}</span></div>
        <div class="be-row"><span>Completed orders today / total tracked</span>
          <strong>${pdInfo.ordersToday} / ${pdInfo.totalOrders}</strong></div>
        <form id="pdForm" class="row2" style="margin-top:6px">
          <label>Store ID (this location)
            <input name="pd_store_id" value="${esc(pdInfo.storeId || '')}" placeholder="77185c4a-1ccd-48e9-…"></label>
          <button class="btn primary" type="submit" style="align-self:end">Save</button>
        </form>
        <div class="quick-actions" style="margin-top:8px">
          <button class="btn tiny" id="pdReconcile">↻ Reconcile last 3 days</button>
          <button class="btn tiny" id="pdBackfill">⏪ Backfill July 1 → today</button>
        </div>
        <div id="pdReport"></div>
        <details style="margin-top:10px"><summary class="hint">Commission rates by channel</summary>
          ${pdRates.map(t => `
            <div class="bd-row"><div class="bd-name">${esc(t.label)}
              <span class="hint">${t.category ? '→ ' + esc(t.category.name) : '⚠ no matching sales channel'}</span></div>
              <div class="bd-amt">${t.category ? (t.category.current ?? 0) + '%' : '—'}</div>
              <div class="bd-inv hint">real: ${t.percent}%</div></div>`).join('')}
          <button class="btn primary" id="pdApplyRates" style="margin-top:8px">Set all channels to the real rates</button>
          <div class="hint">Writes the real rates onto your sales channels (editable any time under "Your categories"). After changing rates, use "Recalculate past commissions" above so history matches.</div>
        </details>
        <div class="hint">Orders arriving on the webhook above log themselves (completed orders only; cancellations reverse automatically, retries never double-count). POS orders with a payment method I can't classify (not cash/card/BanRegio) are counted in totals but flagged — never guessed. The reconciler also runs every 6 hours.</div>
      </div>`;
    return `
      <div class="card">
        <div class="card-title">POS webhook (this location)</div>
        <p class="hint">Point your POS (or Zapier/Make) at this URL with a JSON POST and sales log themselves.
          Recognized fields: <code>date</code>, <code>total</code>, and optional <code>channels: [{name, amount}]</code>
          — channel names matched to your sales channels. Anything else still arrives and is stored below so we can add a custom parser for your POS.</p>
        <div class="webhook-url"><code id="whUrl">${esc(info.url)}</code></div>
        <div class="quick-actions">
          <button class="btn" id="whCopy">📋 Copy URL</button>
          <button class="btn" id="whRegen">↻ Regenerate (invalidates old URL)</button>
        </div>
        ${pdBlock}
        ${info.events.length ? `
        <details style="margin-top:10px"><summary class="hint">Recent deliveries (${info.events.length})</summary>
          ${info.events.map(e => `
            <div class="list-row"><div>
              <span class="pill ${badge[e.status] || ''}">${esc(e.status)}</span>
              <span class="hint">${esc(e.received_at)}</span>
              <div class="hint">${esc(e.note || '')}</div>
              <div class="hint" style="word-break:break-all">${esc(e.payload)}</div>
            </div></div>`).join('')}
        </details>` : '<div class="hint">No deliveries yet — send a test POST to see it appear here.</div>'}
      </div>`;
  }

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
        <div style="margin-top:12px">
          <button class="btn tiny" id="recalcComm">↻ Recalculate past commissions with today's rates</button>
          <div class="hint">Rewrites every logged day's commissions using each channel's current % and invoiced setting. Use after fixing rates that were wrong from the start.</div>
        </div>
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

    // loyalty program
    const lf = app.querySelector('#loyaltyForm');
    if (lf) {
      lf.onsubmit = async (e) => {
        e.preventDefault();
        const f = new FormData(lf);
        try {
          await api(`/loyalty/config?${qLoc()}`, { method: 'PUT', body: {
            location_id: state.locationId,
            program_name: f.get('program_name'), stamps_needed: Number(f.get('stamps_needed')),
            reward_text: f.get('reward_text'), active: f.get('active') === 'on' } });
          toast('Program saved'); render();
        } catch (err) { toast(err.message, true); }
      };
      const wf = app.querySelector('#walletForm');
      wf.onsubmit = async (e) => {
        e.preventDefault();
        const f = new FormData(wf);
        const body = {
          pass_type_id: f.get('pass_type_id'), apple_team_id: f.get('apple_team_id'),
          google_issuer_id: f.get('google_issuer_id')
        };
        const p12 = f.get('p12');
        if (p12 && p12.size) {
          const buf = new Uint8Array(await p12.arrayBuffer());
          let bin = ''; buf.forEach(b => bin += String.fromCharCode(b));
          body.p12_base64 = btoa(bin);
          body.p12_password = f.get('p12_password') || '';
        }
        const sa = f.get('sajson');
        if (sa && sa.size) body.service_account_json = await sa.text();
        try {
          const r = await api('/loyalty/wallet-config', { method: 'POST', body });
          toast(`Saved — Apple ${r.appleReady ? 'ACTIVE ✓' : 'still incomplete'} · Google ${r.googleReady ? 'ACTIVE ✓' : 'still incomplete'}`);
          render();
        } catch (err) { toast(err.message, true); }
      };

      // POS webhook
      const whCopy = app.querySelector('#whCopy');
      if (whCopy) {
        whCopy.onclick = async () => {
          await navigator.clipboard.writeText(app.querySelector('#whUrl').textContent);
          toast('URL copied');
        };
        app.querySelector('#whRegen').onclick = async () => {
          if (!confirm('Regenerate? Anything already posting to this URL (your POS, PideDirecto) will STOP working until their team is given the new URL. Are you sure?')) return;
          await api(`/webhooks/pos-regenerate?${qLoc()}`, { method: 'POST', body: { location_id: state.locationId } });
          toast('New URL generated'); render();
        };
        app.querySelector('#pdForm').onsubmit = async (e) => {
          e.preventDefault();
          await api(`/webhooks/pd-config?${qLoc()}`, { method: 'POST', body: {
            location_id: state.locationId, pd_store_id: new FormData(e.target).get('pd_store_id') } });
          toast('PideDirecto store saved'); render();
        };
        const showPdReport = (r) => {
          if (r.skipped) { toast(`Skipped: ${r.reason}`, true); return; }
          const box = app.querySelector('#pdReport');
          box.innerHTML = `<div class="card" style="margin-top:8px">
            <div class="card-title">${r.orders} orders · ${r.daysRebuilt} days rebuilt${r.unclassified ? ` · <span class="pill bad">${r.unclassified} unclassified</span>` : ''}</div>
            ${(r.report || []).map(g => `
              <div class="bd-row"><div class="bd-name ${g.classified ? '' : 'neg'}">${esc(g.group)}</div>
                <div class="bd-amt">${money(g.amount)}</div>
                <div class="bd-inv hint">${g.count} orders</div></div>`).join('')}
            ${r.unclassified ? '<div class="hint">⚠ Unclassified orders count in daily totals but carry no channel/commission. Tell me what those payment methods are and I\'ll map them.</div>' : ''}
          </div>`;
        };
        app.querySelector('#pdReconcile').onclick = async () => {
          try { showPdReport(await api(`/webhooks/pd-reconcile?${qLoc()}`, { method: 'POST', body: { location_id: state.locationId } })); }
          catch (err) { toast(err.message, true); }
        };
        app.querySelector('#pdBackfill').onclick = async () => {
          if (!confirm('Pull every PideDirecto order from July 1 to today and rebuild those days? Existing manual entries on those days will be replaced by order data.')) return;
          try { showPdReport(await api(`/webhooks/pd-backfill?${qLoc()}`, { method: 'POST', body: { location_id: state.locationId, from: '2026-07-01' } })); }
          catch (err) { toast(err.message, true); }
        };
        app.querySelector('#pdApplyRates').onclick = async () => {
          if (!confirm('Set Uber 55%, Rappi 45%, Didi 50%, web 8%, POS card 5%, POS cash 0%, BanRegio 17% on your sales channels?')) return;
          const r = await api(`/webhooks/pd-rates/apply?${qLoc()}`, { method: 'POST', body: { location_id: state.locationId } });
          toast(`Applied: ${r.applied.length} channels${r.unmatched.length ? ` · no match for: ${r.unmatched.join(', ')}` : ''}`);
          render();
        };
      }

      const custBox = app.querySelector('#custList');
      custBox.closest('details').addEventListener('toggle', async function loadOnce(ev) {
        if (!ev.target.open || custBox.dataset.loaded) return;
        custBox.dataset.loaded = '1';
        const rows = await api('/loyalty/customers');
        custBox.innerHTML = rows.length ? rows.map(c => `
          <div class="list-row" data-cust="${c.id}">
            <div><strong>${esc(c.name)}</strong>
              <div class="hint">${esc(c.phone || c.email || '')} · ${c.visits} visits · ${c.redeemed} redeemed · ${esc(c.code)}</div></div>
            <button class="icon-btn danger del-cust" aria-label="Delete">✕</button>
          </div>`).join('') : 'No customers yet.';
        custBox.querySelectorAll('.del-cust').forEach(b => b.onclick = async () => {
          if (!confirm('Delete this customer and all their data?')) return;
          await api(`/loyalty/customers/${b.closest('.list-row').dataset.cust}`, { method: 'DELETE' });
          toast('Deleted'); render();
        });
      });
    }

    // recalc past commissions with current rates
    app.querySelector('#recalcComm').onclick = async () => {
      if (!confirm("Recalculate ALL past days' commissions using each channel's current rate? This replaces what was stored before.")) return;
      try {
        const r = await api(`/admin/recalc-commissions?${qLoc()}`, { method: 'POST', body: { location_id: state.locationId } });
        toast(`${r.updated} entries updated · commissions ${money(r.before)} → ${money(r.after)} (${r.delta >= 0 ? '+' : ''}${money(r.delta)})`);
      } catch (err) { toast(err.message, true); }
    };

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
