/* Al Día — core: state, API client, router, formatting, shell UI */
'use strict';

const App = (() => {
  const state = {
    me: null,           // { user, locations }
    locationId: null,
    route: 'dashboard',
    // dashboard controls (shared with breakdown view)
    granularity: localStorage.getItem('aldia_gran') || 'day',
    anchor: today()
  };

  // ---------- helpers ----------
  function today() { return new Date().toLocaleDateString('sv-SE'); } // YYYY-MM-DD local
  const mxn = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  const mxn2 = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
  const money = v => mxn.format(Math.round(v || 0));
  const money2 = v => mxn2.format(v || 0);
  const pct = v => (v === null || v === undefined || !isFinite(v)) ? '—' : (v * 100).toFixed(1) + '%';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtDate(d, opts) {
    return new Date(d + 'T12:00:00').toLocaleDateString('en-US',
      opts || { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function fmtRange(start, end) {
    if (start === end) return fmtDate(start);
    return fmtDate(start, { month: 'short', day: 'numeric' }) + ' – ' + fmtDate(end, { month: 'short', day: 'numeric' });
  }
  function addDays(s, n) {
    const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n);
    return d.toLocaleDateString('sv-SE');
  }
  function addMonths(s, n) {
    const d = new Date(s + 'T12:00:00'); d.setDate(1); d.setMonth(d.getMonth() + n);
    return d.toLocaleDateString('sv-SE');
  }

  function toast(msg, isError) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'show' + (isError ? ' error' : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = ''; }, 3000);
  }

  // ---------- API client ----------
  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (res.status === 401 && !path.startsWith('/login') && !path.startsWith('/status') && !path.startsWith('/setup')) {
      state.me = null; render(); throw new Error('Session expired');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // ---------- routing ----------
  const routes = {}; // name -> async render fn, registered by views.js
  function registerRoute(name, fn) { routes[name] = fn; }

  function nav(route) {
    if (location.hash !== '#/' + route) location.hash = '#/' + route;
    else render();
  }

  function currentRoute() {
    const h = location.hash.replace(/^#\//, '');
    return h || 'dashboard';
  }

  // ---------- shell ----------
  const NAV_ITEMS = [
    { route: 'dashboard', icon: '📊', label: 'Home' },
    { route: 'log', icon: '✏️', label: 'Log' },
    { route: 'breakdown', icon: '🧾', label: 'Costs' },
    { route: 'schedule', icon: '👥', label: 'Team' },
    { route: 'settings', icon: '⚙️', label: 'Settings' }
  ];
  const LOG_ROUTES = ['log', 'log-revenue', 'log-costs', 'oneoff', 'recurring'];

  function shell(contentHtml) {
    const locs = state.me.locations;
    const active = currentRoute();
    return `
    <header class="topbar">
      <div class="brand">Al Día</div>
      ${locs.length > 1 ? `
        <select id="locSwitch" class="loc-switch" aria-label="Location">
          ${locs.map(l => `<option value="${l.id}" ${l.id === state.locationId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
        </select>` : `<div class="loc-name">${esc(locs[0]?.name || '')}</div>`}
    </header>
    <main class="content">${contentHtml}</main>
    <nav class="bottombar">
      ${NAV_ITEMS.map(n => {
        const isActive = n.route === active || (n.route === 'log' && LOG_ROUTES.includes(active)) ||
          (n.route === 'breakdown' && active === 'breakdown');
        return `<a href="#/${n.route}" class="nav-item ${isActive ? 'active' : ''}">
          <span class="nav-icon">${n.icon}</span><span>${n.label}</span></a>`;
      }).join('')}
    </nav>`;
  }

  // ---------- render ----------
  let renderToken = 0;
  async function render() {
    const app = document.getElementById('app');
    const token = ++renderToken;

    if (!state.me) {
      const status = await api('/status').catch(() => ({ needsSetup: false }));
      if (token !== renderToken) return;
      app.innerHTML = routes[status.needsSetup ? '_setup' : '_login']();
      routes['_' + (status.needsSetup ? 'setup' : 'login') + '_bind']?.(app);
      return;
    }

    state.route = currentRoute();
    const fn = routes[state.route] || routes.dashboard;
    app.innerHTML = shell('<div class="loading-inline"><div class="spinner"></div></div>');
    bindShell(app);
    try {
      const html = await fn();
      if (token !== renderToken) return;
      app.innerHTML = shell(html);
      bindShell(app);
      routes[state.route + '_bind']?.(app);
      app.querySelector('.content').scrollTop = 0;
    } catch (e) {
      if (token !== renderToken) return;
      app.innerHTML = shell(`<div class="card error-card">${esc(e.message)}</div>`);
      bindShell(app);
    }
  }

  function bindShell(app) {
    const sw = app.querySelector('#locSwitch');
    if (sw) sw.onchange = () => {
      state.locationId = Number(sw.value);
      localStorage.setItem('aldia_loc', sw.value);
      render();
    };
  }

  // ---------- session ----------
  async function loadMe() {
    try {
      state.me = await api('/me');
      const saved = Number(localStorage.getItem('aldia_loc'));
      state.locationId = state.me.locations.some(l => l.id === saved)
        ? saved : (state.me.locations[0]?.id ?? null);
    } catch { state.me = null; }
  }

  async function init() {
    window.addEventListener('hashchange', render);
    await loadMe();
    render();
  }

  return {
    init, state, api, render, nav, registerRoute, loadMe,
    money, money2, pct, esc, fmtDate, fmtRange, today, addDays, addMonths, toast
  };
})();
