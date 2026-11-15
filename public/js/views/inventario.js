/* Al Día — Inventario (solo dueño): gasto por insumo, precios, alertas,
   higiene del catálogo, proveedores, accesos de gerentes — y las gráficas de
   composición de costos que se insertan en la página de Costos. */
'use strict';
(() => {
  const { api, state, registerRoute, render, esc, toast, money, money2 } = App;
  const { isOwner, qLoc, modal } = App.ui;

  const ui = { tab: 'resumen', loc: 'current', categoria: '', proveedor: '', from: '', to: '', insumo: null, sel: new Set(), verInactivos: false };
  const chart = { days: 30, mode: 'compras', tipo: 'todo' };
  const dia = d => new Date(d + 'T12:00:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
  const diaL = d => new Date(d + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
  const PALETTE = ['#236448', '#ec562b', '#3b7dd8', '#c9a227', '#8e5bb5', '#2aa198', '#d6457a', '#6b7b3a', '#a0522d', '#5f6b7a', '#e08a00', '#4a4e8c'];
  const pctTxt = v => v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;

  function filterQuery(extra = {}) {
    const q = new URLSearchParams({ location: ui.loc === 'all' ? 'all' : state.locationId });
    if (ui.categoria) q.set('categoria', ui.categoria);
    if (ui.proveedor) q.set('proveedor', ui.proveedor);
    if (ui.from) q.set('from', ui.from);
    if (ui.to) q.set('to', ui.to);
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    return q.toString();
  }

  const TABS = [['resumen', 'Resumen'], ['precios', 'Precios'], ['compras', 'Compras'], ['catalogo', 'Catálogo'], ['proveedores', 'Proveedores'], ['accesos', 'Accesos'], ['ajustes', 'Ajustes']];
  const tabs = pend => `<div class="quick-actions" style="margin-bottom:12px">${TABS.map(([k, l]) =>
    `<button class="btn ${ui.tab === k ? 'primary' : ''} i-tab" data-tab="${k}">${l}${k === 'catalogo' && pend ? ` · ${pend}` : ''}</button>`).join('')}</div>`;

  function filtersHtml(provs, cats) {
    return `<div class="card">
      <div class="row2">
        <label>Sucursal<select id="fLoc"><option value="current" ${ui.loc === 'current' ? 'selected' : ''}>${esc((state.me.locations.find(l => l.id === state.locationId) || {}).name || 'Actual')}</option>
          <option value="all" ${ui.loc === 'all' ? 'selected' : ''}>Todas</option></select></label>
        <label>Categoría<select id="fCat"><option value="">Todas</option>${cats.map(c => `<option ${ui.categoria === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      </div>
      <div class="row2">
        <label>Desde<input type="date" id="fFrom" value="${esc(ui.from)}"></label>
        <label>Hasta<input type="date" id="fTo" value="${esc(ui.to)}"></label>
      </div>
      <label>Proveedor<select id="fProv"><option value="">Todos</option>${provs.map(p => `<option value="${p.id}" ${String(ui.proveedor) === String(p.id) ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}</select></label>
      <button class="btn primary" id="fApply">Aplicar filtros</button>
    </div>`;
  }

  registerRoute('inventario', async () => {
    if (!isOwner()) return '<div class="card">Solo el administrador puede ver Inventario.</div>';
    const cat = await api(`/inventario/insumos${ui.tab === 'catalogo' && ui.verInactivos ? '?inactivos=1' : ''}`);
    let body = '';
    if (ui.tab === 'resumen') {
      const [r, provs] = await Promise.all([api(`/inventario/resumen?${filterQuery()}`), api('/inventario/proveedores')]);
      if (!ui.from) { ui.from = r.filtros.from; ui.to = r.filtros.to; }
      body = filtersHtml(provs, cat.categorias) + resumenHtml(r);
    } else if (ui.tab === 'precios') {
      const provs = await api('/inventario/proveedores');
      const usados = cat.insumos.filter(i => i.compras > 0);
      if (!ui.insumo && usados.length) ui.insumo = usados[0].id;
      const p = ui.insumo ? await api(`/inventario/precio?${filterQuery({ insumo: ui.insumo })}`) : null;
      body = filtersHtml(provs, cat.categorias) + preciosHtml(usados, p);
    } else if (ui.tab === 'compras') {
      const provs = await api('/inventario/proveedores');
      body = filtersHtml(provs, cat.categorias) + comprasHtml(await api(`/inventario/compras?${filterQuery()}`));
    } else if (ui.tab === 'catalogo') body = catalogoHtml(cat);
    else if (ui.tab === 'proveedores') body = proveedoresHtml(await api('/inventario/proveedores'));
    else if (ui.tab === 'accesos') {
      const [links, gs] = await Promise.all([api('/inventario/links'), api('/gerente-admin/gerentes')]);
      body = accesosHtml(links, gs);
    } else body = ajustesHtml(await api(`/inventario/ajustes?${qLoc()}`));
    return `<h2 class="page-title">Inventario</h2>${tabs(cat.pendientes)}${body}`;
  });

  // ---------------------------------------------------------------- html ----
  function resumenHtml(r) {
    const top = r.rows.slice(0, 10), max = top.length ? top[0].gasto : 1;
    const delta = r.total_prev > 0 ? (r.total - r.total_prev) / r.total_prev * 100 : null;
    return `
      <div class="card highlight">
        <div class="be-row"><span>Gasto en insumos · ${dia(ui.from)} – ${dia(ui.to)}</span><strong>${money(r.total)}</strong></div>
        <div class="hint">Periodo anterior (${dia(r.prev.from)} – ${dia(r.prev.to)}): ${money(r.total_prev)} · <span class="${delta > 0 ? 'neg' : ''}">${pctTxt(delta)}</span></div>
      </div>
      <div class="card">
        <div class="card-title">Alertas de precio${r.alertas.length ? ` · ${r.alertas.length}` : ''}</div>
        <p class="hint">Compras cuyo costo por unidad quedó más de ${r.alerta_pct}% arriba del promedio de las últimas ${r.alerta_n} compras de ese insumo en la misma sucursal.</p>
        ${r.alertas.length ? r.alertas.map(a => `<div class="list-row i-ver" data-id="${a.insumo_id}" style="cursor:pointer">
            <div><strong>${esc(a.insumo)}</strong> <span class="pill bad">+${a.sobre_pct.toFixed(1)}%</span>
              <div class="hint">${dia(a.fecha)} · ${esc(a.ubicacion)}${a.proveedor ? ' · ' + esc(a.proveedor) : ''}${a.gerente ? ' · capturó ' + esc(a.gerente) : ''}</div></div>
            <div class="list-right">${money2(a.costo_unitario_base)}/${esc(a.unidad)}<div class="hint">promedio ${money2(a.promedio)}</div></div>
          </div>`).join('') : '<div class="hint">Sin alertas en este periodo.</div>'}
      </div>
      <div class="card">
        <div class="card-title">Top insumos por gasto</div>
        ${top.length ? top.map(x => `<div class="i-ver" data-id="${x.id}" style="cursor:pointer;margin:8px 0">
            <div class="be-row"><span>${esc(x.nombre)}</span><strong>${money(x.gasto)}</strong></div>
            <div style="height:12px;border-radius:6px;background:#e8eae2;overflow:hidden"><div style="height:100%;width:${Math.max(2, Math.round(100 * x.gasto / max))}%;background:#236448"></div></div>
          </div>`).join('') : '<div class="hint">Aún no hay compras capturadas en este periodo.</div>'}
      </div>
      ${r.rows.length ? `<div class="card">
        <div class="card-title">Gasto por insumo vs periodo anterior</div>
        ${r.rows.map(x => `<div class="list-row i-ver" data-id="${x.id}" style="cursor:pointer">
            <div><strong>${esc(x.nombre)}</strong> <span class="pill">${esc(x.categoria)}</span>
              <div class="hint">${x.cantidad_base} ${esc(x.unidad)} · promedio ${x.precio_promedio !== null ? money2(x.precio_promedio) + '/' + esc(x.unidad) : '—'}</div></div>
            <div class="list-right">${money(x.gasto)}<div class="hint">antes ${money(x.gasto_prev)} · <span class="${x.cambio_pct > 0 ? 'neg' : ''}">${pctTxt(x.cambio_pct)}</span></div></div>
          </div>`).join('')}
      </div>` : ''}`;
  }

  // Line chart of the unit cost, one point per purchase, exactly as stored.
  function priceChart(serie) {
    if (!serie.length) return '<div class="hint">Sin compras de este insumo en el periodo.</div>';
    const W = 640, H = 220, L = 52, R = 12, T = 12, B = 28;
    const t = s => Date.parse(s.fecha);
    const t0 = Math.min(...serie.map(t)), t1 = Math.max(...serie.map(t));
    const vs = serie.map(s => s.costo_unitario_base), v0 = Math.min(...vs) * 0.92, v1 = Math.max(...vs) * 1.08;
    const x = s => L + (t1 === t0 ? (W - L - R) / 2 : (t(s) - t0) / (t1 - t0) * (W - L - R));
    const y = v => T + (1 - (v - v0) / ((v1 - v0) || 1)) * (H - T - B);
    // A change of unit breaks the line: $/kg and $/pieza are not one series.
    const groups = [];
    for (const s of serie) { const g = groups[groups.length - 1]; if (g && g[0].unidad === s.unidad) g.push(s); else groups.push([s]); }
    const ticks = [v0 + (v1 - v0) * 0.1, (v0 + v1) / 2, v1 - (v1 - v0) * 0.1];
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Precio por unidad en el tiempo">
      ${ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e3e5dc"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#5d6a63">${money2(v)}</text>`).join('')}
      ${groups.map(g => `<polyline fill="none" stroke="#236448" stroke-width="2.5" points="${g.map(s => `${x(s).toFixed(1)},${y(s.costo_unitario_base).toFixed(1)}`).join(' ')}"/>`).join('')}
      ${serie.map(s => `<circle cx="${x(s).toFixed(1)}" cy="${y(s.costo_unitario_base).toFixed(1)}" r="4.5" fill="#ec562b"><title>${dia(s.fecha)} · ${money2(s.costo_unitario_base)}/${s.unidad}${s.proveedor ? ' · ' + s.proveedor : ''}</title></circle>`).join('')}
      <text x="${L}" y="${H - 8}" font-size="11" fill="#5d6a63">${dia(serie[0].fecha)}</text>
      <text x="${W - R}" y="${H - 8}" font-size="11" fill="#5d6a63" text-anchor="end">${dia(serie[serie.length - 1].fecha)}</text>
    </svg>`;
  }
  function preciosHtml(usados, p) {
    if (!usados.length) return '<div class="card"><div class="hint">Aún no hay compras capturadas.</div></div>';
    return `<div class="card">
        <label>Insumo<select id="pInsumo">${usados.map(i => `<option value="${i.id}" ${ui.insumo === i.id ? 'selected' : ''}>${esc(i.nombre)} (${esc(i.unidad_base)})</option>`).join('')}</select></label>
      </div>
      ${p ? `<div class="card">
        <div class="card-title">${esc(p.insumo.nombre)} · costo por ${esc(p.insumo.unidad_base)}</div>
        ${priceChart(p.serie)}
        ${new Set(p.serie.map(s => s.unidad)).size > 1 ? '<div class="hint">Este insumo cambió de unidad base: la línea se corta donde cambia, porque los precios anteriores se conservan en su unidad original.</div>' : ''}
      </div>
      <div class="card">
        <div class="card-title">Comparación de proveedores</div>
        ${p.proveedores.length ? p.proveedores.map((v, i) => `<div class="list-row"><div><strong>${esc(v.proveedor)}</strong>${i === 0 && p.proveedores.length > 1 ? ' <span class="pill good">más barato</span>' : ''}
            <div class="hint">${v.compras} compra${v.compras === 1 ? '' : 's'} · ${v.cantidad_base} ${esc(v.unidad)} · última ${dia(v.ultima)}</div></div>
            <div class="list-right">${money2(v.costo_promedio)}/${esc(v.unidad)}<div class="hint">${money(v.gasto)}</div></div></div>`).join('') : '<div class="hint">Sin datos.</div>'}
      </div>
      <div class="card">
        <div class="card-title">Compras</div>
        ${[...p.serie].reverse().map(s => `<div class="list-row c-ver" data-id="${s.compra_id}" style="cursor:pointer"><div><strong>${dia(s.fecha)}</strong>
            <div class="hint">${s.presentacion_nombre ? `${s.cantidad} ${esc(s.presentacion_nombre)} = ` : ''}${s.cantidad_base} ${esc(s.unidad)}${s.proveedor ? ' · ' + esc(s.proveedor) : ''} · ${esc(s.ubicacion)}</div></div>
            <div class="list-right">${money2(s.costo_unitario_base)}/${esc(s.unidad)}<div class="hint">${money(s.total_linea)}</div></div></div>`).join('')}
      </div>` : ''}`;
  }

  function comprasHtml(list) {
    return `<div class="card"><div class="card-title">${list.length} compra${list.length === 1 ? '' : 's'}</div>
      ${list.length ? list.map(c => `<div class="list-row c-ver" data-id="${c.id}" style="cursor:pointer">
          <div><strong>${dia(c.fecha)}${c.proveedor ? ' · ' + esc(c.proveedor) : ''}</strong>
            <div class="hint">${c.lineas.map(l => esc(l.insumo)).join(', ')} · ${esc(c.ubicacion)}${c.gerente || c.usuario ? ' · ' + esc(c.gerente || c.usuario) : ''}${c.tiene_foto ? ' · 📎' : ''}</div></div>
          <div class="list-right">${money(c.total)}</div></div>`).join('') : '<div class="hint">Sin compras con estos filtros.</div>'}</div>`;
  }

  function catalogoHtml(cat) {
    const pend = cat.insumos.filter(i => !i.revisado && i.activo);
    const row = i => `<div class="list-row" style="${i.activo ? '' : 'opacity:.55'}">
        <label class="inv-toggle" style="margin:0"><input type="checkbox" class="i-sel" value="${i.id}" ${ui.sel.has(i.id) ? 'checked' : ''}></label>
        <div style="flex:1"><strong>${esc(i.nombre)}</strong> <span class="pill">${esc(i.categoria)}</span> <span class="pill">${esc(i.unidad_base)}</span>${i.activo ? '' : ' <span class="pill">Inactivo</span>'}
          <div class="hint">${i.compras} compra${i.compras === 1 ? '' : 's'}${i.ultima_compra ? ' · última ' + dia(i.ultima_compra) : ''}${i.presentaciones.length ? ' · ' + i.presentaciones.map(p => `${esc(p.nombre)} ${p.factor}`).join(', ') : ''}${i.creado_por ? ' · creó ' + esc(i.creado_por) : ''}</div></div>
        <div class="list-right">${i.revisado ? '' : `<button class="btn tiny i-ok" data-id="${i.id}">✓ Revisado</button>`}
          <button class="btn tiny i-edit" data-i='${esc(JSON.stringify({ id: i.id, nombre: i.nombre, categoria: i.categoria, unidad_base: i.unidad_base, activo: i.activo, revisado: i.revisado, compras: i.compras }))}'>Editar</button></div>
      </div>`;
    return `
      <div class="card">
        <div class="quick-actions">
          <button class="btn primary" id="iMerge" ${ui.sel.size >= 2 ? '' : 'disabled'}>Fusionar seleccionados (${ui.sel.size})</button>
          <button class="btn" id="iNew">+ Nuevo insumo</button>
          <button class="btn" id="iInact">${ui.verInactivos ? 'Ocultar inactivos' : 'Ver inactivos'}</button>
        </div>
        <p class="hint">Para fusionar duplicados marca dos o más y elige cuál se conserva. Todas sus compras pasan al que se conserva; no se borra ni se recalcula ningún precio.</p>
      </div>
      <div class="card">
        <div class="card-title">Pendientes de revisar${pend.length ? ` · ${pend.length}` : ''}</div>
        ${pend.length ? pend.map(row).join('') : '<div class="hint">Nada pendiente. Los insumos que crean los gerentes aparecen aquí.</div>'}
      </div>
      <div class="card">
        <div class="card-title">Catálogo · ${cat.insumos.filter(i => i.revisado || !i.activo).length}</div>
        ${cat.insumos.filter(i => i.revisado || !i.activo).map(row).join('') || '<div class="hint">Vacío.</div>'}
      </div>`;
  }

  function proveedoresHtml(ps) {
    return `<div class="card"><div class="card-title">Proveedores</div>
      ${ps.map(p => `<div class="list-row" style="${p.activo ? '' : 'opacity:.55'}"><div><strong>${esc(p.nombre)}</strong>${p.activo ? '' : ' <span class="pill">Inactivo</span>'}
          <div class="hint">${p.compras} compra${p.compras === 1 ? '' : 's'}${p.notas ? ' · ' + esc(p.notas) : ''}</div></div>
          <div class="list-right"><button class="btn tiny p-edit" data-p='${esc(JSON.stringify({ id: p.id, nombre: p.nombre, notas: p.notas, activo: p.activo }))}'>Editar</button></div></div>`).join('') || '<div class="hint">Aún no hay proveedores. Se crean solos cuando un gerente escribe uno nuevo.</div>'}
      <button class="btn primary" id="pNew" style="margin-top:10px">+ Agregar proveedor</button></div>`;
  }

  function accesosHtml(links, gs) {
    return `<div class="card">
      <div class="card-title">Acceso desde el teléfono del gerente</div>
      <p class="hint">Genera un enlace personal, mándaselo al gerente y que lo abra una vez en su teléfono. Después entra con su PIN. El enlace solo se muestra al crearlo; si se pierde, revócalo y genera otro.</p>
      ${gs.filter(g => g.active).map(g => {
        const mine = links.filter(l => l.gerente_id === g.id);
        return `<div class="list-row"><div><strong>${esc(g.name)}</strong>
            <div class="hint">${mine.length ? mine.map(l => `Enlace activo · último uso: ${l.last_seen_at ? esc(l.last_seen_at.slice(0, 16)) + ' UTC' : 'nunca'}`).join('<br>') : 'Sin enlace'}</div></div>
          <div class="list-right">${mine.map(l => `<button class="btn tiny danger-btn l-revoke" data-id="${l.id}">Revocar</button>`).join('')}
            <button class="btn tiny l-new" data-id="${g.id}">Generar enlace</button></div></div>`;
      }).join('') || '<div class="hint">Primero crea gerentes en Settings → Vista de Gerente.</div>'}
      <div id="linkOut"></div>
    </div>`;
  }

  function ajustesHtml(a) {
    return `<div class="card">
        <div class="card-title">Alertas de precio</div>
        <div class="row2">
          <label>Avisar si sube más de (%)<input type="number" id="aPct" min="1" step="0.5" value="${a.config.alerta_pct}"></label>
          <label>Contra el promedio de las últimas<input type="number" id="aN" min="1" step="1" value="${a.config.alerta_n}"></label>
        </div>
        <button class="btn primary" id="aSave">Guardar</button>
      </div>
      <div class="card">
        <div class="card-title">¿A qué categoría de costo va cada tipo de insumo? · ${esc((state.me.locations.find(l => l.id === state.locationId) || {}).name || '')}</div>
        <p class="hint">Cada línea de compra se registra como un gasto en la categoría que elijas aquí, igual que un gasto del registro rápido. Aplica a las compras nuevas.</p>
        ${a.categorias.map(c => `<label>${esc(c)}<select class="a-map" data-cat="${esc(c)}">
            <option value="">Sin categoría (gasto inusual)</option>
            ${a.costCategories.map(k => `<option value="${k.id}" ${a.mapa[c] === k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}</select></label>`).join('')}
      </div>`;
  }

  // ---------------------------------------------------------------- bind ----
  function compraModal(id) {
    return guard(async () => {
      const c = await api(`/inventario/compras/${id}`);
      modal(`<h3>Compra · ${diaL(c.fecha)}</h3>
        <p class="hint">${esc(c.ubicacion)}${c.proveedor ? ' · ' + esc(c.proveedor) : ''}${c.cuenta ? ' · pagado de ' + esc(c.cuenta) : ''} · capturó ${esc(c.gerente || c.usuario || '—')}
          ${c.tiene_foto && c.lineas.length ? '' : ''}</p>
        ${c.lineas.map(l => `<div class="bd-row"><div class="bd-name">${esc(l.insumo)}<div class="hint">${l.presentacion_nombre ? `${l.cantidad} ${esc(l.presentacion_nombre)} × ${l.factor_snapshot} = ` : ''}${l.cantidad_base} ${esc(l.unidad)}</div></div>
          <div class="bd-amt">${money(l.total_linea)}</div><div class="bd-inv hint">${money2(l.costo_unitario_base)}/${esc(l.unidad)}</div></div>`).join('')}
        <div class="be-row" style="margin-top:8px"><span>Total</span><strong>${money(c.total)}</strong></div>
        ${c.notas ? `<p class="hint">${esc(c.notas)}</p>` : ''}
        <div class="modal-actions"><button class="btn danger-btn" id="cDel">Borrar compra</button><button class="btn primary" data-close>Cerrar</button></div>`,
      (wrap, close) => {
        wrap.querySelector('[data-close]').onclick = close;
        const del = wrap.querySelector('#cDel');
        del.onclick = guard(async () => {
          if (del.dataset.sure !== '1') { del.dataset.sure = '1'; del.textContent = '¿Seguro? Se borran sus gastos'; return; }
          await api(`/inventario/compras/${c.id}`, { method: 'DELETE' });
          close(); toast('Compra borrada'); render();
        });
      });
    });
  }

  registerRoute('inventario_bind', (app) => {
    app.querySelectorAll('.i-tab').forEach(b => b.onclick = () => { ui.tab = b.dataset.tab; render(); });
    const ap = app.querySelector('#fApply');
    if (ap) ap.onclick = () => {
      ui.loc = app.querySelector('#fLoc').value; ui.categoria = app.querySelector('#fCat').value;
      ui.from = app.querySelector('#fFrom').value; ui.to = app.querySelector('#fTo').value; ui.proveedor = app.querySelector('#fProv').value;
      render();
    };
    app.querySelectorAll('.i-ver').forEach(el => el.onclick = () => { ui.insumo = Number(el.dataset.id); ui.tab = 'precios'; render(); });
    const pi = app.querySelector('#pInsumo'); if (pi) pi.onchange = () => { ui.insumo = Number(pi.value); render(); };
    app.querySelectorAll('.c-ver').forEach(el => el.onclick = compraModal(el.dataset.id));

    // ---- catálogo
    app.querySelectorAll('.i-sel').forEach(cb => cb.onchange = () => {
      const id = Number(cb.value); if (cb.checked) ui.sel.add(id); else ui.sel.delete(id);
      const m = app.querySelector('#iMerge'); m.disabled = ui.sel.size < 2; m.textContent = `Fusionar seleccionados (${ui.sel.size})`;
    });
    app.querySelectorAll('.i-ok').forEach(b => b.onclick = guard(async () => {
      await api(`/inventario/insumos/${b.dataset.id}`, { method: 'PUT', body: { revisado: true } }); render();
    }));
    const inact = app.querySelector('#iInact'); if (inact) inact.onclick = () => { ui.verInactivos = !ui.verInactivos; render(); };
    const merge = app.querySelector('#iMerge');
    if (merge) merge.onclick = guard(async () => {
      const all = (await api('/inventario/insumos?inactivos=1')).insumos.filter(i => ui.sel.has(i.id));
      modal(`<h3>Fusionar ${all.length} insumos</h3>
        <p class="hint">Elige el que se conserva. Las compras de los demás pasan a él con sus precios tal como se guardaron.</p>
        <form id="mF">${all.map((i, k) => `<label class="inv-toggle"><input type="radio" name="keep" value="${i.id}" ${k === 0 ? 'checked' : ''}>
          ${esc(i.nombre)} <span class="hint">· ${esc(i.unidad_base)} · ${i.compras} compra${i.compras === 1 ? '' : 's'}</span></label>`).join('')}
          <div class="modal-actions"><button type="button" class="btn" data-close>Cancelar</button><button type="submit" class="btn primary">Fusionar</button></div></form>`,
      (wrap, close) => {
        wrap.querySelector('[data-close]').onclick = close;
        wrap.querySelector('#mF').onsubmit = guard(async e => {
          e.preventDefault();
          const keep = Number(new FormData(e.target).get('keep'));
          const r = await api('/inventario/insumos/merge', { method: 'POST', body: { survivor_id: keep, ids: all.map(i => i.id).filter(id => id !== keep) } });
          ui.sel.clear(); close(); toast(`Fusionados: ${r.lineas_movidas} compras pasaron a “${r.survivor.nombre}”`); render();
        });
      });
    });
    const insumoForm = (it, cats, unidades) => modal(`<h3>${it ? 'Editar insumo' : 'Nuevo insumo'}</h3>
      <form id="iF">
        <label>Nombre<input name="nombre" value="${esc(it ? it.nombre : '')}" required></label>
        <label>Categoría<select name="categoria">${cats.map(c => `<option ${it && it.categoria === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <label>Unidad base<select name="unidad_base">${unidades.map(u => `<option ${it && it.unidad_base === u ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
        ${it ? `<label class="inv-toggle"><input type="checkbox" name="activo" ${it.activo ? 'checked' : ''}>Activo (aparece al capturar)</label>` : ''}
        <div id="iWarn"></div>
        <div class="modal-actions"><button type="button" class="btn" data-close>Cancelar</button><button type="submit" class="btn primary" id="iSave">Guardar</button></div>
      </form>`, (wrap, close) => {
      wrap.querySelector('[data-close]').onclick = close;
      let confirmUnit = false;
      wrap.querySelector('#iF').onsubmit = async e => {
        e.preventDefault();
        const f = new FormData(e.target);
        const body = { nombre: f.get('nombre'), categoria: f.get('categoria'), unidad_base: f.get('unidad_base') };
        try {
          if (it) await api(`/inventario/insumos/${it.id}`, { method: 'PUT', body: { ...body, activo: f.get('activo') === 'on', revisado: true, confirmar_unidad: confirmUnit } });
          else { const r = await api('/inventario/insumos', { method: 'POST', body }); if (!r.created) toast(`Ya existía “${r.insumo.nombre}”.`); }
          close(); render();
        } catch (err) {
          // The server refuses a unit change until it is confirmed explicitly.
          if (/Cambiar la unidad/.test(err.message)) {
            confirmUnit = true;
            wrap.querySelector('#iWarn').innerHTML = `<div class="status-banner warn"><div class="status-sub">${esc(err.message)}</div></div>`;
            wrap.querySelector('#iSave').textContent = 'Confirmar cambio de unidad';
          } else toast(err.message, true);
        }
      };
    });
    const iNew = app.querySelector('#iNew');
    if (iNew) iNew.onclick = guard(async () => { const c = await api('/inventario/insumos?pendientes=1'); insumoForm(null, c.categorias, c.unidades); });
    app.querySelectorAll('.i-edit').forEach(b => b.onclick = guard(async () => {
      const c = await api('/inventario/insumos?pendientes=1'); insumoForm(JSON.parse(b.dataset.i), c.categorias, c.unidades);
    }));

    // ---- proveedores
    const provForm = p => modal(`<h3>${p ? 'Editar proveedor' : 'Nuevo proveedor'}</h3><form id="pF">
        <label>Nombre<input name="nombre" value="${esc(p ? p.nombre : '')}" required></label>
        <label>Notas<input name="notas" value="${esc(p && p.notas ? p.notas : '')}" placeholder="Teléfono, días de entrega…"></label>
        ${p ? `<label class="inv-toggle"><input type="checkbox" name="activo" ${p.activo ? 'checked' : ''}>Activo</label>` : ''}
        <div class="modal-actions"><button type="button" class="btn" data-close>Cancelar</button><button type="submit" class="btn primary">Guardar</button></div></form>`,
    (wrap, close) => {
      wrap.querySelector('[data-close]').onclick = close;
      wrap.querySelector('#pF').onsubmit = guard(async e => {
        e.preventDefault();
        const f = new FormData(e.target), body = { nombre: f.get('nombre'), notas: f.get('notas') };
        if (p) await api(`/inventario/proveedores/${p.id}`, { method: 'PUT', body: { ...body, activo: f.get('activo') === 'on' } });
        else await api('/inventario/proveedores', { method: 'POST', body });
        close(); render();
      });
    });
    const pNew = app.querySelector('#pNew'); if (pNew) pNew.onclick = () => provForm(null);
    app.querySelectorAll('.p-edit').forEach(b => b.onclick = () => provForm(JSON.parse(b.dataset.p)));

    // ---- accesos
    app.querySelectorAll('.l-new').forEach(b => b.onclick = guard(async () => {
      const r = await api('/inventario/links', { method: 'POST', body: { gerente_id: Number(b.dataset.id) } });
      app.querySelector('#linkOut').innerHTML = `<div class="status-banner good" style="margin-top:10px"><div class="status-title">Enlace creado — cópialo ahora, no se vuelve a mostrar</div>
        <div class="webhook-url"><code id="linkUrl">${esc(r.url)}</code></div><button class="btn" id="linkCopy">📋 Copiar</button></div>`;
      app.querySelector('#linkCopy').onclick = async () => { await navigator.clipboard.writeText(r.url); toast('Enlace copiado'); };
    }));
    app.querySelectorAll('.l-revoke').forEach(b => b.onclick = guard(async () => {
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = '¿Seguro?'; return; }
      await api(`/inventario/links/${b.dataset.id}`, { method: 'DELETE' }); toast('Acceso revocado'); render();
    }));

    // ---- ajustes
    const aSave = app.querySelector('#aSave');
    if (aSave) aSave.onclick = guard(async () => {
      await api('/inventario/ajustes', { method: 'PUT', body: { alerta_pct: Number(app.querySelector('#aPct').value), alerta_n: Number(app.querySelector('#aN').value) } });
      toast('Guardado');
    });
    app.querySelectorAll('.a-map').forEach(s => s.onchange = guard(async () => {
      await api('/inventario/ajustes', { method: 'PUT', body: { location_id: state.locationId, categoria: s.dataset.cat, cost_category_id: Number(s.value) || null } });
      toast('Guardado');
    }));
  });

  // ================================================== cost charts (Costos) ==
  // Every number drawn here comes from /costs/composition, which is built on
  // the same summary() the dashboard uses. This file only draws it.
  function buildSeries(data) {
    const all = data.days;
    const keep = s => chart.tipo === 'todo' || (chart.tipo === 'fijos' ? s.tipo === 'fijo' : s.tipo === 'variable');
    const raw = all.map(d => ({ date: d.date, lead: d.lead, revenue: d.revenue,
      seg: Object.fromEntries(d.segments.filter(keep).map(s => [s.key, s])) }));
    const meta = {};
    for (const d of raw) for (const [k, s] of Object.entries(d.seg)) (meta[k] = meta[k] || { label: s.label, tipo: s.tipo, total: 0 }).total += d.lead ? 0 : s.amount;
    const keys = Object.keys(meta).filter(k => meta[k].total > 0.005).sort((a, b) => meta[b].total - meta[a].total);
    const out = [];
    raw.forEach((d, i) => {
      if (d.lead) return;
      // 7-day mode: the average of this day and the six before it.
      const win = chart.mode === 'ma7' ? raw.slice(Math.max(0, i - 6), i + 1) : [d];
      const vals = {}; let total = 0;
      for (const k of keys) { vals[k] = win.reduce((s, x) => s + (x.seg[k] ? x.seg[k].amount : 0), 0) / win.length; total += vals[k]; }
      out.push({ date: d.date, vals, total, revenue: win.reduce((s, x) => s + x.revenue, 0) / win.length });
    });
    return { keys, meta, days: out };
  }

  function chartSvg(sr) {
    const W = 720, H = 300, L = 54, R = 10, T = 10, B = 26, n = sr.days.length;
    const max = Math.max(1, ...sr.days.map(d => Math.max(d.total, d.revenue))) * 1.06;
    const bw = (W - L - R) / n, y = v => T + (1 - v / max) * (H - T - B);
    const color = k => PALETTE[sr.keys.indexOf(k) % PALETTE.length];
    let bars = '';
    sr.days.forEach((d, i) => {
      let acc = 0;
      for (const k of sr.keys) {
        const v = d.vals[k]; if (v <= 0) continue;
        bars += `<rect x="${(L + i * bw + bw * 0.12).toFixed(1)}" y="${y(acc + v).toFixed(1)}" width="${(bw * 0.76).toFixed(1)}" height="${Math.max(0, y(acc) - y(acc + v)).toFixed(1)}" fill="${color(k)}"/>`;
        acc += v;
      }
      // full-height transparent hit area: easy to tap on a phone
      bars += `<rect class="cc-day" data-date="${d.date}" x="${(L + i * bw).toFixed(1)}" y="${T}" width="${bw.toFixed(1)}" height="${H - T - B}" fill="transparent" style="cursor:pointer"><title>${dia(d.date)} · costos ${money(d.total)} · ventas ${money(d.revenue)}</title></rect>`;
    });
    const rev = sr.days.map((d, i) => `${(L + i * bw + bw / 2).toFixed(1)},${y(d.revenue).toFixed(1)}`).join(' ');
    const ticks = [0.25, 0.5, 0.75, 1].map(f => max * f / 1.06);
    const step = Math.ceil(n / 8);
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Composición diaria de costos">
      ${ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e3e5dc"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#5d6a63">${money(v)}</text>`).join('')}
      ${bars}
      <polyline fill="none" stroke="#1d2420" stroke-width="2.5" points="${rev}" pointer-events="none"/>
      ${sr.days.map((d, i) => i % step === 0 ? `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#5d6a63">${dia(d.date)}</text>` : '').join('')}
    </svg>`;
  }
  function pctSvg(sr) {
    const W = 720, H = 120, L = 54, R = 10, T = 10, B = 22, n = sr.days.length;
    const pts = sr.days.map(d => d.revenue > 0 ? d.total / d.revenue * 100 : null);
    const max = Math.max(100, ...pts.filter(v => v !== null)) * 1.05, bw = (W - L - R) / n, y = v => T + (1 - v / max) * (H - T - B);
    const segs = []; let cur = [];
    pts.forEach((v, i) => { if (v === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(`${(L + i * bw + bw / 2).toFixed(1)},${y(v).toFixed(1)}`); });
    if (cur.length) segs.push(cur);
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Costo como porcentaje de ventas">
      <line x1="${L}" x2="${W - R}" y1="${y(100)}" y2="${y(100)}" stroke="#c0271b" stroke-dasharray="4 4"/><text x="${L - 6}" y="${y(100) + 4}" text-anchor="end" font-size="11" fill="#c0271b">100%</text>
      <text x="${L - 6}" y="${y(50) + 4}" text-anchor="end" font-size="11" fill="#5d6a63">50%</text><line x1="${L}" x2="${W - R}" y1="${y(50)}" y2="${y(50)}" stroke="#e3e5dc"/>
      ${segs.map(s => `<polyline fill="none" stroke="#ec562b" stroke-width="2.5" points="${s.join(' ')}"/>`).join('')}
    </svg>`;
  }

  function drawCharts(box, data) {
    const sr = buildSeries(data);
    const sum = sr.days.reduce((s, d) => s + d.total, 0), revSum = sr.days.reduce((s, d) => s + d.revenue, 0);
    const exact = chart.mode === 'compras' && chart.tipo === 'todo';
    const ok = Math.abs(sum - data.period.costs) < 0.01;
    const seg = (name, cur, opts) => opts.map(([v, l]) => `<button class="btn tiny ${cur === v ? 'primary' : ''} cc-opt" data-k="${name}" data-v="${v}">${l}</button>`).join('');
    box.innerHTML = `<div class="card" id="costCharts">
      <div class="card-title">Composición diaria de costos</div>
      <div class="quick-actions">${seg('days', chart.days, [[14, '14 días'], [30, '30 días'], [60, '60 días'], [90, '90 días']])}</div>
      <div class="quick-actions" style="margin-top:6px">${seg('mode', chart.mode, [['compras', 'Compras (salida real)'], ['ma7', 'Promedio móvil 7 días']])}</div>
      <div class="quick-actions" style="margin-top:6px">${seg('tipo', chart.tipo, [['todo', 'Todo'], ['fijos', 'Fijos'], ['variables', 'Variables']])}</div>
      ${chartSvg(sr)}
      <div class="hint" style="margin:6px 0">${sr.keys.map(k => `<span style="display:inline-block;margin-right:10px;white-space:nowrap"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${PALETTE[sr.keys.indexOf(k) % PALETTE.length]}"></span> ${esc(sr.meta[k].label)}</span>`).join('')}
        <span style="white-space:nowrap"><span style="display:inline-block;width:14px;height:3px;background:#1d2420;vertical-align:middle"></span> Ventas</span></div>
      <div class="card-title" style="margin-top:10px">Costo como % de ventas</div>
      ${pctSvg(sr)}
      <div class="be-row"><span>${chart.tipo === 'todo' ? 'Costos' : chart.tipo === 'fijos' ? 'Costos fijos' : 'Costos variables'} del periodo${chart.mode === 'ma7' ? ' (suavizado)' : ''}</span><strong>${money(sum)}</strong></div>
      <div class="be-row"><span>Ventas</span><strong>${money(revSum)}</strong></div>
      <div class="be-row"><span>Costo / ventas</span><strong>${revSum > 0 ? (sum / revSum * 100).toFixed(1) + '%' : '—'}</strong></div>
      ${exact ? `<div class="hint ${ok ? '' : 'neg'}" id="ccCheck">${ok ? `✓ La suma de las barras coincide con el total de costos del periodo (${money2(data.period.costs)}).`
        : `⚠ La suma de las barras (${money2(sum)}) NO coincide con el total del periodo (${money2(data.period.costs)}). Avísame: es un problema en el cálculo compartido, no de la gráfica.`}</div>`
        : '<div class="hint">El promedio móvil y los filtros cambian lo que se muestra; la comprobación exacta contra el total se hace en “Compras · Todo”.</div>'}
      <div class="hint">Toca un día para ver sus gastos.</div>
    </div>`;
    box.querySelectorAll('.cc-opt').forEach(b => b.onclick = () => {
      const v = b.dataset.k === 'days' ? Number(b.dataset.v) : b.dataset.v;
      const reload = b.dataset.k === 'days';
      chart[b.dataset.k] = v;
      if (reload) loadCharts(box); else drawCharts(box, data);
    });
    box.querySelectorAll('.cc-day').forEach(r => r.onclick = guard(async () => dayModal(await api(`/costs/day-lines?${qLoc()}&date=${r.dataset.date}`))));
  }

  function dayModal(d) {
    const row = (name, amt, sub) => `<div class="bd-row"><div class="bd-name">${name}${sub ? `<div class="hint">${sub}</div>` : ''}</div><div class="bd-amt">${money(amt)}</div></div>`;
    modal(`<h3>${diaL(d.date)}</h3>
      <div class="be-row"><span>Costos del día</span><strong>${money(d.total)}</strong></div>
      <div class="be-row"><span>Ventas</span><strong>${money(d.revenue)}</strong></div>
      <div style="max-height:55vh;overflow:auto">
      ${d.compras.map(c => `<div style="margin-top:10px"><strong>🧾 Compra${c.proveedor ? ' · ' + esc(c.proveedor) : ''} · ${money(c.total)}</strong>
          <div class="hint">${c.cuenta ? 'pagado de ' + esc(c.cuenta) + ' · ' : ''}capturó ${esc(c.capturo || '—')}</div>
          ${c.lineas.map(l => row(`${esc(l.insumo)} <span class="pill">${esc(l.categoria)}</span>`, l.total,
            `${l.presentacion_nombre ? `${l.cantidad} ${esc(l.presentacion_nombre)} = ` : ''}${l.cantidad_base} ${esc(l.unidad)} · ${money2(l.costo_unitario_base)}/${esc(l.unidad)}`)).join('')}</div>`).join('')}
      ${d.otros.length ? `<div style="margin-top:10px"><strong>Registro rápido</strong>${d.otros.map(o => row(esc(o.description), o.amount,
        `${esc(o.categoria || 'Sin categoría')}${o.cuenta ? ' · ' + esc(o.cuenta) : ''}${o.capturo ? ' · ' + esc(o.capturo) : ''}`)).join('')}</div>` : ''}
      ${d.diarios.length ? `<div style="margin-top:10px"><strong>Costos del día</strong>${d.diarios.map(o => row(esc(o.categoria), o.amount)).join('')}</div>` : ''}
      ${d.fijos.length ? `<div style="margin-top:10px"><strong>Fijos (parte de este día)</strong>${d.fijos.map(o => row(esc(o.description), o.amount, esc(o.categoria))).join('')}</div>` : ''}
      ${d.nomina ? `<div style="margin-top:10px">${row('<strong>Nómina (horario)</strong>', d.nomina)}</div>` : ''}
      ${d.comisiones ? `<div style="margin-top:10px">${row('<strong>Comisiones</strong>', d.comisiones)}</div>` : ''}
      </div>
      <div class="modal-actions"><button class="btn primary" data-close>Cerrar</button></div>`,
    (wrap, close) => { wrap.querySelector('[data-close]').onclick = close; });
  }

  async function loadCharts(box) {
    try { drawCharts(box, await api(`/costs/composition?${qLoc()}&days=${chart.days}`)); }
    catch (e) { box.innerHTML = `<div class="card"><div class="hint neg">No se pudieron cargar las gráficas: ${esc(e.message)}</div></div>`; }
  }

  // Called by the Costs page once it has rendered.
  App.ui.costCharts = (app) => {
    if (!isOwner()) return;
    const main = app.querySelector('.content') || app;
    const link = document.createElement('div');
    link.className = 'quick-actions'; link.style.marginBottom = '12px';
    link.innerHTML = '<a class="btn" href="#/inventario">📦 Inventario: insumos, precios y alertas</a>';
    const title = main.querySelector('.page-title');
    if (title && title.nextSibling) main.insertBefore(link, title.nextSibling); else main.prepend(link);
    const box = document.createElement('div');
    box.innerHTML = '<div class="card"><div class="hint">Cargando gráficas…</div></div>';
    main.appendChild(box);
    loadCharts(box);
  };
})();
