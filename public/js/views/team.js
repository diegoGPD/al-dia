/* Al Día — team schedule */
'use strict';
(() => {
  const { api, state, registerRoute, nav, render, loadMe,
          money, money2, pct, esc, fmtDate, fmtRange, today, addDays, addMonths, toast } = App;
  const { isOwner, qLoc, modal, periodBar, bindPeriodBar, fetchDashboard, moveDayDialog, trendChart } = App.ui;

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

})();
