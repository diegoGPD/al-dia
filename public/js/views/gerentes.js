/* Al Día — administración de la Vista de Gerente (solo dueño):
   gerentes y PINs, tablets, plantillas de apertura/cierre, historial. */
'use strict';
(() => {
  const { api, state, registerRoute, render, esc, toast, today, addDays } = App;
  const { isOwner, qLoc, modal } = App.ui;

  const ui = { tab: 'historial', type: 'cierre', f: { from: '', to: '', type: '', gerente: '' } };
  const hhmm = iso => iso ? new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '';
  const dia = d => new Date(d + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
  const TIPO = { apertura: '🌅 Apertura', cierre: '🌙 Cierre' };
  const locName = id => (state.me.locations.find(l => l.id === id) || {}).name || '';

  // Dashboard banner: days with no apertura / cierre at the current location.
  App.ui.checklistAlert = async (app) => {
    if (!isOwner()) return;
    try {
      const miss = await api(`/gerente-admin/missing?${qLoc()}`);
      if (!miss.length) return;
      const box = document.createElement('div');
      box.className = 'status-banner warn';
      box.style.cursor = 'pointer';
      box.innerHTML = `<div class="status-title">⚠ ${miss.length} apertura${miss.length === 1 ? '' : 's'}/cierre${miss.length === 1 ? '' : 's'} sin registrar</div>
        <div class="status-sub">${miss.slice(0, 4).map(m => `${m.type} ${dia(m.date)}${m.state === 'sin_finalizar' ? ' (sin finalizar)' : ''}`).join(' · ')}${miss.length > 4 ? ' …' : ''} — toca para ver</div>`;
      box.onclick = () => { ui.tab = 'historial'; location.hash = '#/gerentes'; };
      const main = app.querySelector('.content') || app;
      const title = main.querySelector('.page-title');
      if (title && title.nextSibling) main.insertBefore(box, title.nextSibling); else main.prepend(box);
    } catch { /* never let this break the dashboard */ }
  };

  const tabs = () => `<div class="quick-actions" style="margin-bottom:12px">
    ${[['historial', 'Historial'], ['plantillas', 'Checklists'], ['gerentes', 'Gerentes'], ['tablets', 'Tablets']]
      .map(([k, l]) => `<button class="btn ${ui.tab === k ? 'primary' : ''} g-tab" data-tab="${k}">${l}</button>`).join('')}</div>`;

  registerRoute('gerentes', async () => {
    if (!isOwner()) return '<div class="card">Solo el administrador puede ver esta sección.</div>';
    let body = '';
    if (ui.tab === 'gerentes') body = gerentesHtml(await api('/gerente-admin/gerentes'));
    else if (ui.tab === 'tablets') body = tabletsHtml(await api('/gerente-admin/tablets'));
    else if (ui.tab === 'plantillas') body = plantillaHtml(await api(`/gerente-admin/template?${qLoc()}&type=${ui.type}`));
    else {
      const q = new URLSearchParams({ location: state.locationId });
      for (const k of ['from', 'to', 'type', 'gerente']) if (ui.f[k]) q.set(k, ui.f[k]);
      const [rows, miss, gs] = await Promise.all([
        api(`/gerente-admin/history?${q}`), api(`/gerente-admin/missing?${qLoc()}`), api('/gerente-admin/gerentes')]);
      body = historialHtml(rows, miss, gs);
    }
    return `<h2 class="page-title">Gerentes · Apertura / Cierre</h2>${tabs()}${body}`;
  });

  // ---------------------------------------------------------------- html ----
  function historialHtml(rows, miss, gs) {
    return `
      ${miss.length ? `<div class="status-banner warn"><div class="status-title">⚠ Días sin registro en ${esc(locName(state.locationId))}</div>
        <div class="status-sub">${miss.map(m => `${m.type} ${dia(m.date)}${m.state === 'sin_finalizar' ? ' (iniciado, sin finalizar)' : ''}`).join(' · ')}</div></div>` : ''}
      <div class="card">
        <div class="row2">
          <label>Desde<input type="date" id="hFrom" value="${ui.f.from}"></label>
          <label>Hasta<input type="date" id="hTo" value="${ui.f.to}"></label>
        </div>
        <div class="row2">
          <label>Tipo<select id="hType"><option value="">Todos</option>
            <option value="apertura" ${ui.f.type === 'apertura' ? 'selected' : ''}>Apertura</option>
            <option value="cierre" ${ui.f.type === 'cierre' ? 'selected' : ''}>Cierre</option></select></label>
          <label>Gerente<select id="hGer"><option value="">Todos</option>
            ${gs.map(g => `<option value="${g.id}" ${String(ui.f.gerente) === String(g.id) ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
        </div>
        <button class="btn primary" id="hApply">Filtrar</button>
      </div>
      <div class="card">
        <div class="card-title">${rows.length} registro${rows.length === 1 ? '' : 's'} · ${esc(locName(state.locationId))}</div>
        ${rows.length ? rows.map(r => `
          <div class="list-row h-row" data-id="${r.id}" style="cursor:pointer">
            <div><strong>${TIPO[r.type]} · ${dia(r.business_date)}</strong>
              <div class="hint">${esc(r.gerentes || '—')} · ${hhmm(r.started_at)}${r.finished_at ? ' – ' + hhmm(r.finished_at) : ''}
                ${r.duration_min !== null ? ` · ${r.duration_min} min` : ''}${r.has_comments ? ' · 💬 con comentarios' : ''}</div></div>
            <div class="list-right"><span class="pill ${r.status === 'completed' ? 'good' : 'warn'}">${r.status === 'completed' ? 'Terminado' : `En curso ${r.done}/${r.total}`}</span></div>
          </div>`).join('') : '<div class="hint">Sin registros con estos filtros.</div>'}
      </div>`;
  }

  function gerentesHtml(gs) {
    return `<div class="card">
      <div class="card-title">Gerentes</div>
      <p class="hint">Personas que usan la tablet con su PIN de 4 dígitos. No son usuarios de Al Día: no ven finanzas ni configuración.</p>
      ${gs.map(g => `<div class="list-row ${g.active ? '' : 'muted'}">
          <div><strong>${esc(g.name)}</strong>${g.active ? '' : ' <span class="pill">Inactivo</span>'}
            <div class="hint">${g.location_ids.map(locName).filter(Boolean).map(esc).join(', ') || 'Sin sucursal'}</div></div>
          <div class="list-right"><button class="btn tiny g-edit" data-g='${esc(JSON.stringify(g))}'>Editar</button></div>
        </div>`).join('') || '<div class="hint">Aún no hay gerentes.</div>'}
      <button class="btn primary" id="gAdd" style="margin-top:10px">+ Agregar gerente</button>
    </div>`;
  }

  function tabletsHtml(ts) {
    const url = `${location.origin}/gerente`;
    return `<div class="card">
      <div class="card-title">Tablets registradas</div>
      <p class="hint">Para registrar una tablet: ábrela en <strong>${esc(url)}</strong>, inicia sesión una vez como administrador y elige la sucursal. Desde entonces esa tablet abre directo en la Vista de Gerente.</p>
      ${ts.map(t => `<div class="list-row">
          <div><strong>${esc(t.name)}</strong><div class="hint">${esc(t.location_name)} · última conexión: ${t.last_seen_at ? esc(t.last_seen_at.slice(0, 16)) + ' UTC' : 'nunca'}</div></div>
          <div class="list-right"><button class="btn tiny danger-btn t-revoke" data-id="${t.id}">Revocar</button></div>
        </div>`).join('') || '<div class="hint">Ninguna tablet registrada todavía.</div>'}
    </div>`;
  }

  function plantillaHtml(t) {
    const secs = t.sections;
    return `
      <div class="quick-actions" style="margin-bottom:10px">
        <button class="btn ${ui.type === 'apertura' ? 'primary' : ''} p-type" data-type="apertura">🌅 Apertura</button>
        <button class="btn ${ui.type === 'cierre' ? 'primary' : ''} p-type" data-type="cierre">🌙 Cierre</button>
      </div>
      <div class="card">
        <div class="card-title">Checklist de ${t.type} · ${esc(locName(t.location_id))}</div>
        <p class="hint">Los cambios aplican a los checklists que se inicien a partir de ahora. Los registros ya hechos (y los que están en curso) conservan el texto con el que se iniciaron.</p>
        <label>Nota de encabezado<input id="pHead" value="${esc(t.header_note || '')}"></label>
        <label>Texto de ayuda en comentarios<input id="pPh" value="${esc(t.comments_placeholder || '')}"></label>
        <label>Nota final (en rojo)<input id="pFoot" value="${esc(t.footer_note || '')}"></label>
        <button class="btn" id="pSaveNotes" data-id="${t.id}">Guardar notas</button>
      </div>
      ${secs.map((s, si) => `
        <div class="card ${s.active ? '' : 'muted-card'}" style="${s.active ? '' : 'opacity:.6'}">
          <div class="list-row">
            <div><strong>${si + 1}. ${esc(s.title)}</strong>${s.active ? '' : ' <span class="pill">Desactivada</span>'}
              ${s.warning_note ? `<div class="hint neg">${esc(s.warning_note)}</div>` : ''}</div>
            <div class="list-right">
              <button class="icon-btn p-move" data-kind="sections" data-id="${s.id}" data-dir="-1" ${si === 0 ? 'disabled' : ''} aria-label="Subir">▲</button>
              <button class="icon-btn p-move" data-kind="sections" data-id="${s.id}" data-dir="1" ${si === secs.length - 1 ? 'disabled' : ''} aria-label="Bajar">▼</button>
              <button class="btn tiny p-sec" data-s='${esc(JSON.stringify({ id: s.id, title: s.title, warning_note: s.warning_note, active: s.active }))}'>Editar</button>
            </div>
          </div>
          ${s.items.map((it, ii) => `
            <div class="list-row" style="${it.active ? '' : 'opacity:.5'}">
              <div class="${it.warning ? 'neg' : ''}">${it.warning ? '⚠ ' : ''}${esc(it.text)}${it.active ? '' : ' <span class="pill">Desactivada</span>'}</div>
              <div class="list-right">
                <button class="icon-btn p-move" data-kind="items" data-sec="${s.id}" data-id="${it.id}" data-dir="-1" ${ii === 0 ? 'disabled' : ''} aria-label="Subir">▲</button>
                <button class="icon-btn p-move" data-kind="items" data-sec="${s.id}" data-id="${it.id}" data-dir="1" ${ii === s.items.length - 1 ? 'disabled' : ''} aria-label="Bajar">▼</button>
                <button class="btn tiny p-item" data-i='${esc(JSON.stringify({ id: it.id, text: it.text, warning: it.warning, active: it.active }))}'>Editar</button>
              </div>
            </div>`).join('')}
          <button class="btn tiny p-additem" data-sec="${s.id}" style="margin-top:8px">+ Actividad</button>
        </div>`).join('')}
      ${secs.length ? '' : '<div class="card"><div class="hint">Este checklist está vacío. Agrega la primera sección para que los gerentes puedan usarlo.</div></div>'}
      <button class="btn primary full" id="pAddSec" data-id="${t.id}">+ Agregar sección</button>
      <script type="application/json" id="pData">${JSON.stringify(secs.map(s => ({ id: s.id, items: s.items.map(i => i.id) }))).replace(/</g, '\\u003c')}</script>`;
  }

  // ---------------------------------------------------------------- bind ----
  registerRoute('gerentes_bind', (app) => {
    app.querySelectorAll('.g-tab').forEach(b => b.onclick = () => { ui.tab = b.dataset.tab; render(); });
    const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

    // ---- historial
    const ap = app.querySelector('#hApply');
    if (ap) ap.onclick = () => {
      ui.f = { from: app.querySelector('#hFrom').value, to: app.querySelector('#hTo').value,
        type: app.querySelector('#hType').value, gerente: app.querySelector('#hGer').value };
      render();
    };
    app.querySelectorAll('.h-row').forEach(row => row.onclick = guard(async () => {
      const r = await api(`/gerente-admin/run/${row.dataset.id}`);
      modal(`
        <h3>${TIPO[r.type]} · ${dia(r.business_date)}</h3>
        <p class="hint">${esc(r.location_name)} · ${r.status === 'completed' ? 'Terminado' : `En curso ${r.done}/${r.total}`}<br>
          Inicio ${hhmm(r.started_at)} (${esc(r.started_by_name || '')})${r.finished_at ? ` · Fin ${hhmm(r.finished_at)} (${esc(r.finished_by_name || '')})` : ''}<br>
          Gerentes: ${esc(r.gerentes.map(g => `${g.name} (${hhmm(g.joined_at)})`).join(', '))}</p>
        <div style="max-height:55vh;overflow:auto">
          ${r.sections.map(s => `
            <div style="margin-top:10px"><strong>${esc(s.title)}</strong>
              ${s.note ? `<div class="hint neg">${esc(s.note)}</div>` : ''}
              ${s.items.map(it => `<div class="bd-row"><div class="bd-name ${it.warning ? 'neg' : ''}">${it.checked_at ? '✓' : '☐'} ${esc(it.text)}</div>
                <div class="bd-inv hint">${it.checked_at ? `${hhmm(it.checked_at)} · ${esc(it.checked_by_name || '')}` : 'sin marcar'}</div></div>`).join('')}
            </div>`).join('')}
          <div style="margin-top:12px"><strong>Comentarios / Incidencias</strong><p>${esc(r.comments || 'Sin comentarios.')}</p></div>
        </div>
        <div class="modal-actions"><button class="btn primary" data-close>Cerrar</button></div>`,
      (wrap, close) => { wrap.querySelector('[data-close]').onclick = close; });
    }));

    // ---- gerentes
    const gForm = (g) => modal(`
      <h3>${g ? 'Editar gerente' : 'Nuevo gerente'}</h3>
      <form id="gF">
        <label>Nombre<input name="name" value="${esc(g ? g.name : '')}" required></label>
        <label>PIN de 4 dígitos ${g ? '<span class="hint">(déjalo vacío para no cambiarlo)</span>' : ''}
          <input name="pin" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off" ${g ? '' : 'required'}></label>
        <div class="hint" style="margin:8px 0 4px">Sucursales</div>
        ${state.me.locations.map(l => `<label class="inv-toggle"><input type="checkbox" name="loc" value="${l.id}"
          ${(g ? g.location_ids.includes(l.id) : l.id === state.locationId) ? 'checked' : ''}>${esc(l.name)}</label>`).join('')}
        ${g ? `<label class="inv-toggle"><input type="checkbox" name="active" ${g.active ? 'checked' : ''}>Activo (puede entrar a la tablet)</label>` : ''}
        <div class="modal-actions"><button type="button" class="btn" data-close>Cancelar</button>
          <button type="submit" class="btn primary">Guardar</button></div>
      </form>`, (wrap, close) => {
      wrap.querySelector('[data-close]').onclick = close;
      wrap.querySelector('#gF').onsubmit = guard(async e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const body = { name: f.get('name'), pin: f.get('pin') || '', location_ids: f.getAll('loc').map(Number) };
        if (g) body.active = f.get('active') === 'on';
        await api(g ? `/gerente-admin/gerentes/${g.id}` : '/gerente-admin/gerentes', { method: g ? 'PUT' : 'POST', body });
        close(); toast('Guardado'); render();
      });
    });
    const gAdd = app.querySelector('#gAdd'); if (gAdd) gAdd.onclick = () => gForm(null);
    app.querySelectorAll('.g-edit').forEach(b => b.onclick = () => gForm(JSON.parse(b.dataset.g)));

    // ---- tablets (two taps instead of a browser confirm dialog)
    app.querySelectorAll('.t-revoke').forEach(b => b.onclick = guard(async () => {
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = '¿Seguro? Revocar'; return; }
      await api(`/gerente-admin/tablets/${b.dataset.id}`, { method: 'DELETE' });
      toast('Tablet revocada'); render();
    }));

    // ---- plantillas
    app.querySelectorAll('.p-type').forEach(b => b.onclick = () => { ui.type = b.dataset.type; render(); });
    const notes = app.querySelector('#pSaveNotes');
    if (notes) notes.onclick = guard(async () => {
      await api(`/gerente-admin/template/${notes.dataset.id}`, { method: 'PUT', body: {
        header_note: app.querySelector('#pHead').value, comments_placeholder: app.querySelector('#pPh').value,
        footer_note: app.querySelector('#pFoot').value } });
      toast('Notas guardadas');
    });
    const dataEl = app.querySelector('#pData');
    const order = dataEl ? JSON.parse(dataEl.textContent) : [];
    app.querySelectorAll('.p-move').forEach(b => b.onclick = guard(async () => {
      const dir = Number(b.dataset.dir), id = Number(b.dataset.id);
      const ids = b.dataset.kind === 'sections' ? order.map(s => s.id)
        : [...order.find(s => s.id === Number(b.dataset.sec)).items];
      const i = ids.indexOf(id), j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await api('/gerente-admin/reorder', { method: 'POST', body: { kind: b.dataset.kind, ids } });
      render();
    }));
    const secForm = (s, templateId) => modal(`
      <h3>${s ? 'Editar sección' : 'Nueva sección'}</h3>
      <form id="sF">
        <label>Título<input name="title" value="${esc(s ? s.title : '')}" required></label>
        <label>Nota de advertencia en rojo <span class="hint">(opcional)</span>
          <input name="warning_note" value="${esc(s && s.warning_note ? s.warning_note : '')}" placeholder="IMPORTANTE: …"></label>
        ${s ? `<label class="inv-toggle"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}>Activa</label>` : ''}
        <div class="modal-actions"><button type="button" class="btn" data-close>Cancelar</button>
          <button type="submit" class="btn primary">Guardar</button></div>
      </form>`, (wrap, close) => {
      wrap.querySelector('[data-close]').onclick = close;
      wrap.querySelector('#sF').onsubmit = guard(async e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const body = { title: f.get('title'), warning_note: f.get('warning_note') };
        if (s) { body.active = f.get('active') === 'on'; await api(`/gerente-admin/sections/${s.id}`, { method: 'PUT', body }); }
        else await api('/gerente-admin/sections', { method: 'POST', body: { ...body, template_id: templateId } });
        close(); render();
      });
    });
    const itemForm = (it, sectionId) => modal(`
      <h3>${it ? 'Editar actividad' : 'Nueva actividad'}</h3>
      <form id="iF">
        <label>Texto<input name="text" value="${esc(it ? it.text : '')}" required></label>
        <label class="inv-toggle"><input type="checkbox" name="warning" ${it && it.warning ? 'checked' : ''}>Advertencia (se muestra resaltada en rojo)</label>
        ${it ? `<label class="inv-toggle"><input type="checkbox" name="active" ${it.active ? 'checked' : ''}>Activa</label>` : ''}
        <div class="modal-actions"><button type="button" class="btn" data-close>Cancelar</button>
          <button type="submit" class="btn primary">Guardar</button></div>
      </form>`, (wrap, close) => {
      wrap.querySelector('[data-close]').onclick = close;
      wrap.querySelector('#iF').onsubmit = guard(async e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const body = { text: f.get('text'), warning: f.get('warning') === 'on' };
        if (it) { body.active = f.get('active') === 'on'; await api(`/gerente-admin/items/${it.id}`, { method: 'PUT', body }); }
        else await api('/gerente-admin/items', { method: 'POST', body: { ...body, section_id: sectionId } });
        close(); render();
      });
    });
    const addSec = app.querySelector('#pAddSec'); if (addSec) addSec.onclick = () => secForm(null, Number(addSec.dataset.id));
    app.querySelectorAll('.p-sec').forEach(b => b.onclick = () => secForm(JSON.parse(b.dataset.s)));
    app.querySelectorAll('.p-item').forEach(b => b.onclick = () => itemForm(JSON.parse(b.dataset.i)));
    app.querySelectorAll('.p-additem').forEach(b => b.onclick = () => itemForm(null, Number(b.dataset.sec)));
  });
})();
