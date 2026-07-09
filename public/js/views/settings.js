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
