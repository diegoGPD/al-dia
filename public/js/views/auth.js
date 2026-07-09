/* Al Día — login & first-run setup */
'use strict';
(() => {
  const { api, state, registerRoute, nav, render, loadMe,
          money, money2, pct, esc, fmtDate, fmtRange, today, addDays, addMonths, toast } = App;
  const { isOwner, qLoc, modal, periodBar, bindPeriodBar, fetchDashboard, moveDayDialog, trendChart } = App.ui;

  // ======================================================================
  // Login & first-run setup
  // ======================================================================
  registerRoute('_login', () => `
    <div class="auth-wrap"><div class="auth-card">
      <h1 class="auth-logo">Al Día</h1>
      <p class="auth-sub">Your restaurant's money, at a glance</p>
      <form id="loginForm">
        <label>Email<input type="email" name="email" required autocomplete="email"></label>
        <label>Password<input type="password" name="password" required autocomplete="current-password"></label>
        <button class="btn primary full" type="submit">Sign in</button>
        <p class="form-error" id="authErr"></p>
        <p class="hint center"><a href="#" id="forgotPw">Forgot your password?</a></p>
      </form>
    </div></div>`);

  registerRoute('_login_bind', (app) => {
    app.querySelector('#loginForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
        await loadMe(); nav('dashboard'); render();
      } catch (err) { app.querySelector('#authErr').textContent = err.message; }
    };
    app.querySelector('#forgotPw').onclick = (e) => {
      e.preventDefault();
      app.querySelector('#authErr').textContent =
        'Managers: ask the owner to reset it (Settings → People). Owner: run the reset command on the server — see the README ("Password reset").';
    };
  });

  registerRoute('_setup', (status) => `
    <div class="auth-wrap"><div class="auth-card">
      <h1 class="auth-logo">Al Día</h1>
      <p class="auth-sub">Welcome! Let's set up your account — takes 30 seconds.</p>
      <form id="setupForm">
        <label>Your name<input name="name" required placeholder="Diego"></label>
        <label>Email<input type="email" name="email" required autocomplete="email"></label>
        <label>Password <span class="hint">(at least 8 characters)</span>
          <input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
        <label>Your restaurant's name<input name="locationName" required placeholder="La Cocina Centro"></label>
        ${App.state.setupCodeRequired ? `<label>Setup code <span class="hint">(set by whoever deployed this)</span>
          <input name="setup_code" required autocomplete="off"></label>` : ''}
        <button class="btn primary full" type="submit">Create my account</button>
        <p class="form-error" id="authErr"></p>
      </form>
    </div></div>`);

  registerRoute('_setup_bind', (app) => {
    app.querySelector('#setupForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('/setup', { method: 'POST', body: {
          name: f.get('name'), email: f.get('email'),
          password: f.get('password'), locationName: f.get('locationName'),
          setup_code: f.get('setup_code') || undefined } });
        await loadMe(); nav('dashboard'); render();
      } catch (err) { app.querySelector('#authErr').textContent = err.message; }
    };
  });

})();
