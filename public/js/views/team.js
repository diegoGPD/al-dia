/* Al Día — team schedule (turn-based: define turns, drop names in) */
'use strict';
(() => {
  const { api, state, registerRoute, nav, render, loadMe,
          money, money2, pct, esc, fmtDate, fmtRange, today, addDays, addMonths, toast } = App;
  const { isOwner, qLoc, modal, periodBar, bindPeriodBar, fetchDashboard, moveDayDialog, trendChart } = App.ui;

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
  const toHHMM = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DAY_ES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
  const activeOn = (e, date) =>
    (e.start_date || '0000-01-01') <= date && (!e.end_date || e.end_date >= date);
  let showFormer = false;

  // ---- staged (unsaved) assignment edits ----
  // The grid is edited freely in memory; nothing is written until Save.
  let sched = null;                 // last fetched schedule
  let templates_ = [];              // day templates for the current location
  const pending = new Map();        // "turnId:empId" -> 'add' | 'remove'
  const key = (t, e) => `${t}:${e}`;
  const isDirty = () => pending.size > 0;

  function stagePerson(turnId, empId, action) {
    const k = key(turnId, empId);
    // adding then removing the same person cancels out
    if (pending.get(k) && pending.get(k) !== action) pending.delete(k);
    else pending.set(k, action);
    const turn = sched.turns.find(t => t.id === turnId);
    if (!turn) return;
    if (action === 'add' && !turn.employee_ids.includes(empId)) turn.employee_ids.push(empId);
    if (action === 'remove') turn.employee_ids = turn.employee_ids.filter(x => x !== empId);
  }

  async function savePending() {
    if (!isDirty()) return { added: 0, removed: 0 };
    const adds = [], removes = [];
    for (const [k, action] of pending) {
      const [turn_id, employee_id] = k.split(':').map(Number);
      (action === 'add' ? adds : removes).push({ turn_id, employee_id });
    }
    const r = await api(`/schedule/assignments?${qLoc()}`, {
      method: 'POST', body: { location_id: state.locationId, adds, removes } });
    pending.clear();
    return r;
  }

  // Don't lose staged work by navigating away or closing the tab.
  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });
  let guarding = false;
  window.addEventListener('hashchange', () => {
    if (guarding) { guarding = false; return; }
    if (!isDirty()) return;
    if (confirm('You have unsaved schedule changes. Leave without saving?')) { pending.clear(); return; }
    guarding = true;
    location.hash = '#/schedule';
  });

  // Live totals from the in-memory grid, so staged edits show their effect
  // before saving.
  function liveTotals(d) {
    const byEmp = Object.fromEntries(d.employees.map(e => [e.id, { hours: 0, cost: 0 }]));
    for (const t of d.turns) {
      for (const id of t.employee_ids) {
        const e = d.employees.find(x => x.id === id);
        if (!e || !activeOn(e, t.date)) continue;
        byEmp[id].hours += t.hours;
      }
    }
    let hours = 0, cost = 0;
    for (const e of d.employees) {
      const b = byEmp[e.id];
      b.cost = e.pay_type === 'salary' ? (b.hours > 0 ? e.rate : 0) : b.hours * e.rate;
      hours += b.hours; cost += b.cost;
    }
    return { hours, cost, byEmp };
  }

  const ROW_PALETTE = ['#cfe8cf', '#cfe0f5', '#f7d488', '#e8cfe4', '#cfe8e4', '#f5d5cf'];
  const colorFor = (row, i) => row.color || ROW_PALETTE[i % ROW_PALETTE.length];

  // The whole schedule as one spreadsheet: shift rows down the side, days
  // across the top, a name in each cell. Closed days black out entirely.
  function gridHtml(d) {
    const empById = Object.fromEntries(d.employees.map(e => [e.id, e]));
    const closed = new Set(d.closed || []);
    const rows = d.rows || [];

    const cell = (row, date) => {
      if (closed.has(date)) return '<td class="cell closed"></td>';
      const t = row.byDate[date];
      const ids = t ? t.employee_ids : [];
      const names = ids.map(id => {
        const e = empById[id];
        const gone = e && !activeOn(e, date);
        return `<span class="${gone ? 'gone' : ''}">${esc(e ? e.name : '?')}</span>`;
      }).join('<br>');
      return `<td class="cell ${ids.length ? 'filled' : ''}" data-key="${esc(row.key)}" data-date="${date}"
        ${ids.length ? `style="background:${colorFor(row, rows.indexOf(row))}"` : ''}>${names || '<span class="plus">+</span>'}</td>`;
    };

    return `
      <div class="sheet-wrap">
        <table class="sheet">
          <thead>
            <tr>
              <th class="shift-col">Turno</th>
              ${d.days.map((date, i) => `
                <th class="${closed.has(date) ? 'closed' : ''} ${date === today() ? 'today' : ''}">
                  <div>${DAY_ES[i]}</div>
                  <div class="hint">${date.slice(8)}</div>
                  <button class="btn tiny toggle-closed" data-date="${date}"
                    title="${closed.has(date) ? 'Reopen this day' : 'Mark the whole day closed'}">${closed.has(date) ? 'Abrir' : 'Cerrar'}</button>
                </th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${rows.map((row, i) => `
              <tr>
                <th class="shift-col" style="background:${colorFor(row, i)}">
                  <div class="shift-label">${esc(row.label)}</div>
                  <div class="shift-time">${fmtTime(row.start_min)} – ${fmtTime(row.end_min)}</div>
                  <div class="shift-actions">
                    <button class="icon-btn edit-row" data-key="${esc(row.key)}" aria-label="Edit">✎</button>
                    <button class="icon-btn danger del-row" data-key="${esc(row.key)}" aria-label="Delete">✕</button>
                  </div>
                </th>
                ${d.days.map(date => cell(row, date)).join('')}
              </tr>`).join('')}
            ${rows.length ? '' : `<tr><td class="cell" colspan="8">
              <span class="hint">No shifts yet — add one below to start the week.</span></td></tr>`}
          </tbody>
        </table>
      </div>
      <div class="sheet-actions">
        <button class="btn tiny" id="addRow">+ Turno</button>
        <button class="btn tiny" id="copyWeek">⧉ Copiar semana pasada</button>
        <button class="btn tiny" id="exportPng">⬇ Imagen</button>
      </div>`;
  }

  registerRoute('schedule', async () => {
    schedWeek = schedWeek || mondayOf(today());
    const [d, templates, roster] = await Promise.all([
      api(`/schedule?${qLoc()}&week=${schedWeek}`),
      api(`/schedule/templates?${qLoc()}`),
      api(`/employees?${qLoc()}${showFormer ? '&former=1' : ''}`)
    ]);
    schedWeek = d.week;
    sched = d; templates_ = templates;
    pending.clear();
    const empById = Object.fromEntries(d.employees.map(e => [e.id, e]));
    const perEmp = Object.fromEntries(d.perEmployee.map(p => [p.employee_id, p]));
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

      <div class="card">
        <div class="card-title">This week's labor cost</div>
        <div class="be-row"><span>Scheduled (<span id="wkHours">${d.totals.hours.toFixed(1)}</span> h total)</span>
          <strong id="wkCost">${money(d.totals.cost)}</strong></div>
        ${d.budget.amount > 0 ? `
          <div class="be-row"><span>Budgeted payroll</span><strong>${money(d.budget.amount)}</strong></div>
          <div class="be-row"><span>Difference</span>
            <strong>${d.totals.cost >= d.budget.amount ? '+' : ''}${money(d.totals.cost - d.budget.amount)}
            <span class="pill ${budgetPill[0]}">${budgetPill[1]}</span></strong></div>` : ''}
        ${overtime.length ? `<div class="hint">⚠ Over 48 h/week: ${overtime.map(e => esc(e.name)).join(', ')} — heads-up, not legal advice.</div>` : ''}
        ${d.perEmployee.some(p => p.hours > 0) ? `
        <details><summary class="hint">Hours & cost per person</summary>
          ${d.perEmployee.filter(p => p.hours > 0 || empById[p.employee_id]?.pay_type === 'salary').map(p => `
            <div class="bd-row"><div class="bd-name">${esc(empById[p.employee_id]?.name || '?')}</div>
              <div class="bd-amt">${money(p.cost)}</div>
              <div class="bd-inv hint">${p.hours.toFixed(1)}h${empById[p.employee_id]?.pay_type === 'salary' ? ' · salary' : ''}</div></div>`).join('')}
        </details>` : ''}
        <div class="hint">Labor books itself into your numbers day by day — nothing to log elsewhere.</div>
      </div>

      <div id="dayBlocks">${gridHtml(d)}</div>
      <div id="saveBar" class="save-bar" style="display:none">
        <span id="saveCount"></span>
        <div>
          <button class="btn tiny" id="discardBtn">Discard</button>
          <button class="btn primary tiny" id="saveBtn">Save changes</button>
        </div>
      </div>

      <details class="card" id="rosterBox" style="margin-top:14px">
        <summary class="card-title">Manage employees (${roster.filter(e => !e.former).length})</summary>
        ${roster.map(e => `
          <div class="list-row ${e.former ? 'former-row' : ''}" data-emp="${e.id}">
            <div><strong>${esc(e.name)}</strong>${e.former ? ' <span class="pill warn">former</span>' : ''}
              <div class="hint">${esc(e.position || '—')} · ${e.pay_type === 'salary' ? `${money(e.rate)}/week salary` : `${money2(e.rate)}/hour`}
                · since ${e.start_date ? fmtDate(e.start_date, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}${
                e.end_date ? ` until ${fmtDate(e.end_date, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}</div></div>
            <div class="list-right">
              <button class="icon-btn edit-emp" aria-label="Edit">✎</button>
              <button class="icon-btn danger del-emp" aria-label="Remove">✕</button>
            </div>
          </div>`).join('')}
        <label class="inv-toggle big" style="margin-top:10px">
          <input type="checkbox" id="showFormer" ${showFormer ? 'checked' : ''}>Show former employees</label>
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
          <div class="row2">
            <label>Start date<input type="date" name="start_date" value="${today()}" required></label>
            <label>End date <span class="hint">(leave empty if current)</span><input type="date" name="end_date"></label>
          </div>
          <button class="btn primary" type="submit">+ Add employee</button>
        </form>
      </details>`;
  });

  registerRoute('schedule_bind', (app) => {
    const rerender = () => render();

    // Re-paint just the grid from memory — no network, no page reload.
    function repaint() {
      app.querySelector('#dayBlocks').innerHTML = gridHtml(sched);
      bindGrid();
      const totals = liveTotals(sched);
      app.querySelector('#wkHours').textContent = totals.hours.toFixed(1);
      app.querySelector('#wkCost').textContent = money(totals.cost);
      const bar = app.querySelector('#saveBar');
      bar.style.display = isDirty() ? '' : 'none';
      app.querySelector('#saveCount').textContent =
        `${pending.size} unsaved change${pending.size === 1 ? '' : 's'}`;
    }

    // Structural actions write immediately; flush staged edits first so
    // nothing is lost when the grid reloads underneath them.
    const withFlush = fn => async (...args) => {
      if (isDirty()) {
        if (!confirm('Save your staged changes first and continue?')) return;
        try { await savePending(); } catch (e) { toast(e.message, true); return; }
      }
      return fn(...args);
    };

    function bindGrid() {
      // Tap a cell -> pick or clear who works that shift that day.
      app.querySelectorAll('.cell[data-key]').forEach(td => td.onclick = () => {
        const row = sched.rows.find(r => r.key === td.dataset.key);
        if (row) cellDialog(row, td.dataset.date, repaint);
      });
      // Black out (or reopen) a whole day.
      app.querySelectorAll('.toggle-closed').forEach(b => b.onclick = withFlush(async (ev) => {
        ev.stopPropagation();
        const date = b.dataset.date;
        const isClosed = (sched.closed || []).includes(date);
        if (!isClosed && !confirm(`Mark ${fmtDate(date)} as closed? Anyone scheduled that day is removed.`)) return;
        await api(`/schedule/closed?${qLoc()}`, { method: 'POST',
          body: { location_id: state.locationId, date, closed: !isClosed } });
        toast(isClosed ? 'Día abierto' : 'Día cerrado'); rerender();
      }));
      // Shift rows
      app.querySelectorAll('.edit-row').forEach(b => b.onclick = withFlush((ev) => {
        ev.stopPropagation();
        rowDialog(sched.rows.find(r => r.key === b.dataset.key));
      }));
      app.querySelectorAll('.del-row').forEach(b => b.onclick = withFlush(async (ev) => {
        ev.stopPropagation();
        if (!confirm('Delete this shift row for the whole week?')) return;
        await api(`/schedule/rows?${qLoc()}&week=${schedWeek}&key=${encodeURIComponent(b.dataset.key)}`,
          { method: 'DELETE' });
        toast('Turno eliminado'); rerender();
      }));
      const add = app.querySelector('#addRow');
      if (add) add.onclick = withFlush(() => rowDialog(null));
      const cw = app.querySelector('#copyWeek');
      if (cw) cw.onclick = withFlush(async () => {
        if (!confirm('Replace this week with a copy of last week (shifts and people)?')) return;
        try {
          const r = await api('/schedule/copy-last-week', { method: 'POST',
            body: { location_id: state.locationId, week: schedWeek } });
          toast(`Copied ${r.copied} turns`); rerender();
        } catch (err) { toast(err.message, true); }
      });
      const ex = app.querySelector('#exportPng');
      if (ex) ex.onclick = withFlush(() => exportSchedulePng());
    }
    bindGrid();

    // save / discard staged edits
    app.querySelector('#saveBtn').onclick = async () => {
      try {
        const r = await savePending();
        toast(`Saved — ${r.added} added, ${r.removed} removed`);
        rerender();
      } catch (err) { toast(err.message, true); }
    };
    app.querySelector('#discardBtn').onclick = () => {
      if (!confirm('Discard your unsaved changes?')) return;
      pending.clear(); rerender();
    };

    const guard = fn => () => {
      if (isDirty() && !confirm('You have unsaved schedule changes. Leave without saving?')) return;
      pending.clear(); fn();
    };
    app.querySelector('#prevWeek').onclick = guard(() => { schedWeek = addDays(schedWeek, -7); rerender(); });
    app.querySelector('#nextWeek').onclick = guard(() => { schedWeek = addDays(schedWeek, 7); rerender(); });
    const tw = app.querySelector('#thisWeek');
    if (tw) tw.onclick = guard(() => { schedWeek = mondayOf(today()); rerender(); });

    // roster
    const form = app.querySelector('#empForm');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      try {
        await api(`/employees?${qLoc()}`, { method: 'POST', body: {
          location_id: state.locationId, name: f.get('name'), position: f.get('position'),
          pay_type: f.get('pay_type'), rate: Number(f.get('rate')),
          start_date: f.get('start_date'), end_date: f.get('end_date') || null } });
        toast('Employee added'); rerender();
      } catch (err) { toast(err.message, true); }
    };
    app.querySelectorAll('.del-emp').forEach(b => b.onclick = () =>
      deleteEmployeeDialog(b.closest('.list-row').dataset.emp));
    app.querySelectorAll('.edit-emp').forEach(b => b.onclick = () => empDialog(b.closest('.list-row').dataset.emp));
    const sf = app.querySelector('#showFormer');
    if (sf) sf.onchange = () => { showFormer = sf.checked; rerender(); };
  });

  // Tap a cell: choose who works this shift on this day, or clear it.
  function cellDialog(row, date, done) {
    const cur = (row.byDate[date] && row.byDate[date].employee_ids) || [];
    const eligible = sched.employees.filter(e => activeOn(e, date));
    modal(`
      <h3>${esc(row.label)} · ${fmtDate(date)}</h3>
      <p class="hint">${fmtTime(row.start_min)} – ${fmtTime(row.end_min)} · ${row.hours.toFixed(1)} h</p>
      <div class="pick-list">
        ${eligible.map(e => `
          <label class="pick-row">
            <input type="checkbox" value="${e.id}" ${cur.includes(e.id) ? 'checked' : ''}>
            <span>${esc(e.name)}${e.position ? ` <span class="hint">· ${esc(e.position)}</span>` : ''}</span>
          </label>`).join('') || '<p class="hint">Nobody on the roster works on this date.</p>'}
      </div>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="button" class="btn primary" id="pickSave">Listo</button>
      </div>`, (wrap, close) => {
      wrap.querySelector('[data-close]').onclick = close;
      wrap.querySelector('#pickSave').onclick = async () => {
        const picked = [...wrap.querySelectorAll('input[type=checkbox]:checked')].map(x => Number(x.value));
        const turn = row.byDate[date];
        try {
          // Anyone newly added may need the day's turn created first.
          for (const id of picked.filter(id => !cur.includes(id))) {
            await api(`/schedule/cell?${qLoc()}`, { method: 'POST', body: {
              location_id: state.locationId, date, key: row.key, employee_id: id, color: row.color } });
          }
          if (turn) {
            for (const id of cur.filter(id => !picked.includes(id))) {
              await api(`/schedule/turns/${turn.id}/assign/${id}?${qLoc()}`, { method: 'DELETE' });
            }
          }
          close(); render();
        } catch (err) { toast(err.message, true); }
      };
    });
  }

  // Create or edit a shift row (applies across the week).
  function rowDialog(existing) {
    const last = JSON.parse(localStorage.getItem('aldia_last_turn') || '{"label":"Turno","s":"09:20","e":"16:00"}');
    const label = existing ? existing.label : last.label;
    const s = existing ? toHHMM(existing.start_min) : last.s;
    const e = existing ? toHHMM(existing.end_min) : last.e;
    const color = existing ? (existing.color || ROW_PALETTE[0]) : ROW_PALETTE[0];
    modal(`
      <h3>${existing ? 'Editar turno' : 'Nuevo turno'}</h3>
      <form id="rowForm">
        <label>Nombre<input name="label" value="${esc(label)}" required list="turnLabels"></label>
        <datalist id="turnLabels">
          <option value="Mañana"><option value="Tarde"><option value="Noche"><option value="Cierre">
        </datalist>
        <div class="row2">
          <label>Entra<input type="time" name="start" value="${s}" required></label>
          <label>Sale<input type="time" name="end" value="${e}" required></label>
        </div>
        <label>Color</label>
        <div class="swatches">
          ${ROW_PALETTE.map(c => `<button type="button" class="swatch ${c === color ? 'on' : ''}"
            data-color="${c}" style="background:${c}"></button>`).join('')}
        </div>
        <p class="hint">Applies to the whole week — closed days are skipped. Ends past midnight? Set the end
          earlier than the start.</p>
        <div class="modal-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn primary">${existing ? 'Guardar' : 'Agregar'}</button>
        </div>
      </form>`, (wrap, close) => {
      let picked = color;
      wrap.querySelectorAll('.swatch').forEach(b => b.onclick = () => {
        picked = b.dataset.color;
        wrap.querySelectorAll('.swatch').forEach(x => x.classList.toggle('on', x === b));
      });
      wrap.querySelector('[data-close]').onclick = close;
      wrap.querySelector('#rowForm').onsubmit = async ev => {
        ev.preventDefault();
        const f = new FormData(ev.target);
        const body = {
          location_id: state.locationId, week: schedWeek, label: f.get('label'),
          start_min: toMin(f.get('start')), end_min: toMin(f.get('end')), color: picked
        };
        try {
          if (existing) await api(`/schedule/rows?${qLoc()}`, { method: 'PUT', body: { ...body, key: existing.key } });
          else await api(`/schedule/rows?${qLoc()}`, { method: 'POST', body });
          localStorage.setItem('aldia_last_turn',
            JSON.stringify({ label: f.get('label'), s: f.get('start'), e: f.get('end') }));
          close(); render();
        } catch (err) { toast(err.message, true); }
      };
    });
  }

  // Removing someone is two decisions: keep them as history or erase them,
  // and what to do with shifts already on the upcoming schedule.
  async function deleteEmployeeDialog(id) {
    const i = await api(`/employees/${id}/impact?${qLoc()}`);
    const upcoming = i.upcomingCount;
    modal(`
      <h3>Remove ${esc(i.name)}</h3>
      ${upcoming ? `
        <div class="status-banner warn" style="padding:10px;margin-bottom:12px">
          <div class="status-sub">They're on <strong>${upcoming}</strong> upcoming turn${upcoming > 1 ? 's' : ''}
            (${esc(i.upcomingDates[0])}${upcoming > 1 ? ` … ${esc(i.upcomingDates[upcoming - 1])}` : ''}).</div>
        </div>
        <label class="inv-toggle big"><input type="checkbox" id="clearUpcoming" checked>
          Also take them off those upcoming turns</label>`
        : '<p class="hint">They have no upcoming turns.</p>'}
      <div class="del-choice">
        <button class="btn full" id="markFormer">Keep as former employee</button>
        <p class="hint">Sets an end date. Their ${i.pastCount} past shift${i.pastCount === 1 ? '' : 's'} and labor
          history stay exactly as they are; they just stop showing in day-to-day views.
          Reversible — clear the end date to bring them back.</p>
      </div>
      <div class="del-choice danger-zone">
        <button class="btn danger-btn full" id="purgeEmp">Delete permanently</button>
        <p class="hint">Erases the record and <strong>every</strong> shift they ever worked, including past weeks —
          your historical labor costs will change. This cannot be undone.</p>
      </div>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button></div>`,
    (wrap, close) => {
      wrap.querySelector('[data-close]').onclick = close;
      const clear = () => wrap.querySelector('#clearUpcoming')?.checked ? '&clear_upcoming=1' : '';
      wrap.querySelector('#markFormer').onclick = async () => {
        const r = await api(`/employees/${id}?${qLoc()}&mode=former${clear()}`, { method: 'DELETE' });
        close();
        toast(`Marked as former (until ${r.end_date})${r.cleared ? ` · removed from ${r.cleared} upcoming turns` : ''}`);
        render();
      };
      wrap.querySelector('#purgeEmp').onclick = async () => {
        if (!confirm(`Permanently delete ${i.name} and all ${i.pastCount + upcoming} of their shifts? This cannot be undone.`)) return;
        await api(`/employees/${id}?${qLoc()}&mode=purge`, { method: 'DELETE' });
        close(); toast('Deleted permanently'); render();
      };
    });
  }

  async function empDialog(id) {
    const emps = await api(`/employees?${qLoc()}&former=1`);
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
        <div class="row2">
          <label>Start date<input type="date" name="start_date" value="${e.start_date || ''}"></label>
          <label>End date <span class="hint">(empty = current)</span>
            <input type="date" name="end_date" value="${e.end_date || ''}"></label>
        </div>
        <p class="hint">They only count toward labor cost between these dates, whatever the schedule says.</p>
        <div class="modal-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>`, (wrap, close) => {
      wrap.querySelector('[data-close]').onclick = close;
      wrap.querySelector('#empEdit').onsubmit = async ev => {
        ev.preventDefault();
        const f = new FormData(ev.target);
        try {
          await api(`/employees/${e.id}?${qLoc()}`, { method: 'PUT', body: {
            location_id: state.locationId, name: f.get('name'), position: f.get('position'),
            pay_type: f.get('pay_type'), rate: Number(f.get('rate')),
            start_date: f.get('start_date') || undefined, end_date: f.get('end_date') || null } });
          close(); toast('Saved'); render();
        } catch (err) { toast(err.message, true); }
      };
    });
  }

  // PNG export: days × turns with names — no pay information.
  // PNG export mirrors the grid exactly: shift rows, day columns, names only.
  async function exportSchedulePng() {
    const d = await api(`/schedule?${qLoc()}&week=${schedWeek}`);
    const locName = state.me.locations.find(l => l.id === state.locationId)?.name || '';
    const empById = Object.fromEntries(d.employees.map(e => [e.id, e]));
    const rows = d.rows || [];
    const closed = new Set(d.closed || []);

    const shiftW = 150, dayW = 132, headH = 76, dayHeadH = 40, pad = 10;
    const rowH = r => Math.max(46, 22 + Math.max(1, Math.max(...d.days.map(dt =>
      ((r.byDate[dt] || {}).employee_ids || []).length), 1)) * 17);
    const heights = rows.map(rowH);
    const W = shiftW + dayW * 7, H = headH + dayHeadH + heights.reduce((a, b) => a + b, 0) + 12;
    const scale = 2;
    const cv = document.createElement('canvas');
    cv.width = W * scale; cv.height = H * scale;
    const ctx = cv.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);

    // header
    ctx.fillStyle = '#1a7f5a'; ctx.fillRect(0, 0, W, headH);
    ctx.fillStyle = '#fff';
    ctx.font = '700 21px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText(locName, pad, 32);
    ctx.font = '400 14px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText(`Semana: ${fmtRange(d.days[0], d.days[6])}`, pad, 56);

    // day header
    ctx.fillStyle = '#f2f5f4'; ctx.fillRect(0, headH, W, dayHeadH);
    d.days.forEach((date, i) => {
      const x = shiftW + i * dayW;
      if (closed.has(date)) { ctx.fillStyle = '#2d3436'; ctx.fillRect(x, headH, dayW, dayHeadH); }
      ctx.fillStyle = closed.has(date) ? '#fff' : '#1e2a26';
      ctx.font = '700 13px -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.fillText(DAY_ES[i], x + 8, headH + 18);
      ctx.font = '400 11px -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.fillText(date.slice(8) + (closed.has(date) ? ' · CERRADO' : ''), x + 8, headH + 33);
    });

    // rows
    let y = headH + dayHeadH;
    rows.forEach((row, ri) => {
      const h = heights[ri];
      const color = row.color || ROW_PALETTE[ri % ROW_PALETTE.length];
      ctx.fillStyle = color; ctx.fillRect(0, y, shiftW, h);
      ctx.fillStyle = '#1e2a26';
      ctx.font = '700 13px -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.fillText(row.label.slice(0, 18), 8, y + 20);
      ctx.font = '400 11px -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.fillText(`${fmtTime(row.start_min)} – ${fmtTime(row.end_min)}`, 8, y + 36);

      d.days.forEach((date, i) => {
        const x = shiftW + i * dayW;
        const ids = ((row.byDate[date] || {}).employee_ids) || [];
        if (closed.has(date)) { ctx.fillStyle = '#2d3436'; ctx.fillRect(x, y, dayW, h); return; }
        if (ids.length) { ctx.fillStyle = color; ctx.fillRect(x, y, dayW, h); }
        ctx.fillStyle = '#1e2a26';
        ctx.font = '600 13px -apple-system, Segoe UI, Roboto, sans-serif';
        ids.forEach((id, k) => {
          ctx.fillText((empById[id]?.name || '?').slice(0, 16), x + 8, y + 22 + k * 17);
        });
      });
      y += h;
    });

    // grid lines
    ctx.strokeStyle = '#d8e0dc'; ctx.lineWidth = 1;
    for (let i = 0; i <= 7; i++) {
      const x = shiftW + i * dayW;
      ctx.beginPath(); ctx.moveTo(x, headH); ctx.lineTo(x, H - 12); ctx.stroke();
    }
    let ly = headH + dayHeadH;
    ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(W, ly); ctx.stroke();
    heights.forEach(h => {
      ly += h;
      ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(W, ly); ctx.stroke();
    });

    const a = document.createElement('a');
    a.download = `horario-${locName.replace(/\s+/g, '-').toLowerCase()}-${d.week}.png`;
    a.href = cv.toDataURL('image/png');
    a.click();
    toast('Horario descargado');
  }
})();
