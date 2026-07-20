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

  registerRoute('schedule', async () => {
    schedWeek = schedWeek || mondayOf(today());
    const [d, templates] = await Promise.all([
      api(`/schedule?${qLoc()}&week=${schedWeek}`),
      api(`/schedule/templates?${qLoc()}`)
    ]);
    schedWeek = d.week;
    const empById = Object.fromEntries(d.employees.map(e => [e.id, e]));
    const perEmp = Object.fromEntries(d.perEmployee.map(p => [p.employee_id, p]));
    const budgetPill = { over: ['bad', 'Over budget'], under: ['warn', 'Under budget'], ok: ['good', 'On budget'], na: ['', ''] }[d.budget.flag];
    const overtime = d.employees.filter(e => perEmp[e.id]?.overtime);

    const dayBlock = (date, i) => {
      const turns = d.turns.filter(t => t.date === date);
      return `
      <details class="day-block" ${date === today() ? 'open' : ''}>
        <summary><strong>${DAY_NAMES[i]} ${date.slice(8)}</strong>
          <span class="hint">${turns.length ? `${turns.length} turn${turns.length > 1 ? 's' : ''} · ${turns.reduce((s, t) => s + t.employee_ids.length, 0)} people` : 'no turns yet'}</span>
        </summary>
        ${turns.map(t => `
          <div class="turn-card">
            <div class="turn-head">
              <div><strong>${esc(t.label)}</strong>
                <span class="hint">${fmtTime(t.start_min)} – ${fmtTime(t.end_min)} · ${t.hours.toFixed(1)}h</span></div>
              <div>
                <button class="icon-btn edit-turn" data-turn="${t.id}" aria-label="Edit">✎</button>
                <button class="icon-btn danger del-turn" data-turn="${t.id}" aria-label="Delete">✕</button>
              </div>
            </div>
            <div class="turn-people">
              ${t.employee_ids.map(id => `
                <span class="person-chip">${esc(empById[id]?.name || '?')}
                  <button class="chip-x" data-turn="${t.id}" data-emp="${id}" aria-label="Remove">✕</button></span>`).join('')}
              ${(() => {
                const free = d.employees.filter(e => !t.employee_ids.includes(e.id));
                return free.length ? `
                  <select class="add-person" data-turn="${t.id}">
                    <option value="">+ Add…</option>
                    ${free.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}
                  </select>` : '';
              })()}
            </div>
          </div>`).join('')}
        <div class="day-actions">
          <button class="btn tiny add-turn" data-date="${date}">+ Turn</button>
          ${templates.length ? `
            <select class="apply-tpl" data-date="${date}">
              <option value="">Apply template…</option>
              ${templates.map(t => `<option value="${t.id}">${esc(t.name)} (${t.turns.length})</option>`).join('')}
            </select>` : ''}
          ${turns.length ? `<button class="btn tiny save-tpl" data-date="${date}">💾 Save as template</button>` : ''}
        </div>
      </details>`;
    };

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
        <div class="be-row"><span>Scheduled (${d.totals.hours.toFixed(1)} h total)</span><strong>${money(d.totals.cost)}</strong></div>
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
        <div class="sched-actions">
          <button class="btn tiny" id="copyWeek">⧉ Copy last week</button>
          <button class="btn tiny" id="exportPng">⬇ Export as image</button>
        </div>
      </div>

      ${d.days.map((date, i) => dayBlock(date, i)).join('')}

      <details class="card" id="rosterBox" style="margin-top:14px">
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

    // turns
    app.querySelectorAll('.add-turn').forEach(b => b.onclick = () => turnDialog(b.dataset.date, null));
    app.querySelectorAll('.edit-turn').forEach(b => b.onclick = async () => {
      const d = await api(`/schedule?${qLoc()}&week=${schedWeek}`);
      const t = d.turns.find(x => x.id === Number(b.dataset.turn));
      if (t) turnDialog(t.date, t);
    });
    app.querySelectorAll('.del-turn').forEach(b => b.onclick = async () => {
      if (!confirm('Delete this turn (and its assignments)?')) return;
      await api(`/schedule/turns/${b.dataset.turn}?${qLoc()}`, { method: 'DELETE' });
      toast('Turn deleted'); rerender();
    });

    // people in / out of turns
    app.querySelectorAll('.add-person').forEach(sel => sel.onchange = async () => {
      if (!sel.value) return;
      await api(`/schedule/turns/${sel.dataset.turn}/assign?${qLoc()}`, {
        method: 'POST', body: { location_id: state.locationId, employee_id: Number(sel.value) } });
      rerender();
    });
    app.querySelectorAll('.chip-x').forEach(x => x.onclick = async () => {
      await api(`/schedule/turns/${x.dataset.turn}/assign/${x.dataset.emp}?${qLoc()}`, { method: 'DELETE' });
      rerender();
    });

    // templates
    app.querySelectorAll('.apply-tpl').forEach(sel => sel.onchange = async () => {
      if (!sel.value) return;
      if (!confirm("Replace this day's turns with the template? (People are not copied.)")) { sel.value = ''; return; }
      await api(`/schedule/templates/${sel.value}/apply?${qLoc()}`, {
        method: 'POST', body: { location_id: state.locationId, date: sel.dataset.date } });
      toast('Template applied'); rerender();
    });
    app.querySelectorAll('.save-tpl').forEach(b => b.onclick = async () => {
      const name = prompt('Template name (e.g. "Weekday", "Weekend"):');
      if (!name) return;
      await api(`/schedule/templates?${qLoc()}`, {
        method: 'POST', body: { location_id: state.locationId, name, date: b.dataset.date } });
      toast('Template saved'); rerender();
    });

    // copy last week / export
    app.querySelector('#copyWeek').onclick = async () => {
      if (!confirm('Replace this week with a copy of last week (turns and people)?')) return;
      try {
        const r = await api('/schedule/copy-last-week', { method: 'POST',
          body: { location_id: state.locationId, week: schedWeek } });
        toast(`Copied ${r.copied} turns`); rerender();
      } catch (err) { toast(err.message, true); }
    };
    app.querySelector('#exportPng').onclick = () => exportSchedulePng();

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

  // Fast turn creation: remembers your last label + times as defaults.
  function turnDialog(date, existing) {
    const last = JSON.parse(localStorage.getItem('aldia_last_turn') || '{"label":"Turno","s":"09:00","e":"17:00"}');
    const label = existing ? existing.label : last.label;
    const s = existing ? toHHMM(existing.start_min) : last.s;
    const e = existing ? toHHMM(existing.end_min) : last.e;
    modal(`
      <h3>${existing ? 'Edit turn' : 'New turn'} — ${fmtDate(date)}</h3>
      <form id="turnForm">
        <label>Label<input name="label" value="${esc(label)}" required list="turnLabels"></label>
        <datalist id="turnLabels">
          <option value="Mañana"><option value="Tarde"><option value="Noche">
          <option value="Cierre"><option value="Fin de semana">
        </datalist>
        <div class="row2">
          <label>Starts<input type="time" name="start" value="${s}" required></label>
          <label>Ends<input type="time" name="end" value="${e}" required></label>
        </div>
        <p class="hint">Ends past midnight? Set the end earlier than the start — it counts into the next day. Turns may overlap for handoffs.</p>
        <div class="modal-actions">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn primary">${existing ? 'Save' : 'Add turn'}</button>
        </div>
      </form>`, (wrap, close) => {
      wrap.querySelector('[data-close]').onclick = close;
      wrap.querySelector('#turnForm').onsubmit = async ev => {
        ev.preventDefault();
        const f = new FormData(ev.target);
        const body = {
          location_id: state.locationId, date,
          label: f.get('label'), start_min: toMin(f.get('start')), end_min: toMin(f.get('end'))
        };
        try {
          if (existing) await api(`/schedule/turns/${existing.id}?${qLoc()}`, { method: 'PUT', body });
          else await api(`/schedule/turns?${qLoc()}`, { method: 'POST', body });
          localStorage.setItem('aldia_last_turn',
            JSON.stringify({ label: f.get('label'), s: f.get('start'), e: f.get('end') }));
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

  // PNG export: days × turns with names — no pay information.
  async function exportSchedulePng() {
    const d = await api(`/schedule?${qLoc()}&week=${schedWeek}`);
    const locName = state.me.locations.find(l => l.id === state.locationId)?.name || '';
    const empById = Object.fromEntries(d.employees.map(e => [e.id, e]));

    const colW = 165, headH = 84, dayHeadH = 34, pad = 8;
    const blockH = t => 40 + t.employee_ids.length * 16 + 8;
    const colHeights = d.days.map(date =>
      d.turns.filter(t => t.date === date).reduce((s, t) => s + blockH(t) + 6, 0));
    const bodyH = Math.max(120, ...colHeights) + 16;
    const W = colW * 7 + 2, H = headH + dayHeadH + bodyH;
    const scale = 2;
    const cv = document.createElement('canvas');
    cv.width = W * scale; cv.height = H * scale;
    const ctx = cv.getContext('2d');
    ctx.scale(scale, scale);

    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#1a7f5a'; ctx.fillRect(0, 0, W, headH);
    ctx.fillStyle = '#fff';
    ctx.font = '700 22px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText(locName, 16, 34);
    ctx.font = '400 15px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText(`Semana: ${fmtRange(d.days[0], d.days[6])}`, 16, 60);

    ctx.fillStyle = '#f5f7f6'; ctx.fillRect(0, headH, W, dayHeadH);
    d.days.forEach((date, i) => {
      ctx.fillStyle = '#1e2a26';
      ctx.font = '700 13px -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.fillText(`${DAY_NAMES[i]} ${date.slice(8)}`, i * colW + pad, headH + 22);
    });

    d.days.forEach((date, i) => {
      let y = headH + dayHeadH + 8;
      const x = i * colW + pad;
      for (const t of d.turns.filter(t => t.date === date)) {
        const h = blockH(t);
        ctx.fillStyle = '#e6f4ee';
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, colW - pad * 2, h, 8); ctx.fill(); }
        else ctx.fillRect(x, y, colW - pad * 2, h);
        ctx.fillStyle = '#14684a';
        ctx.font = '700 12px -apple-system, Segoe UI, Roboto, sans-serif';
        ctx.fillText(t.label.slice(0, 18), x + 8, y + 16);
        ctx.font = '600 11px -apple-system, Segoe UI, Roboto, sans-serif';
        ctx.fillText(`${fmtTime(t.start_min)} – ${fmtTime(t.end_min)}`, x + 8, y + 31);
        ctx.fillStyle = '#1e2a26';
        ctx.font = '400 11px -apple-system, Segoe UI, Roboto, sans-serif';
        t.employee_ids.forEach((id, k) => {
          ctx.fillText('· ' + (empById[id]?.name || '?').slice(0, 20), x + 8, y + 46 + k * 16);
        });
        y += h + 6;
      }
    });

    ctx.strokeStyle = '#e3e9e6';
    for (let i = 0; i <= 7; i++) {
      ctx.beginPath(); ctx.moveTo(i * colW, headH); ctx.lineTo(i * colW, H); ctx.stroke();
    }

    const a = document.createElement('a');
    a.download = `horario-${locName.replace(/\s+/g, '-').toLowerCase()}-${d.week}.png`;
    a.href = cv.toDataURL('image/png');
    a.click();
    toast('Schedule image downloaded');
  }
})();
