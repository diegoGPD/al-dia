/* Al Día — forecast & insights */
'use strict';
(() => {
  const { api, state, registerRoute, nav, render, loadMe,
          money, money2, pct, esc, fmtDate, fmtRange, today, addDays, addMonths, toast } = App;
  const { isOwner, qLoc, modal, periodBar, bindPeriodBar, fetchDashboard, moveDayDialog, trendChart } = App.ui;

  // ======================================================================
  // Forecast & insights
  // ======================================================================
  let fcHorizon = 'week';
  registerRoute('insights', async () => {
    const [f, ins] = await Promise.all([
      api(`/forecast?${qLoc()}`), api(`/insights?${qLoc()}`)
    ]);
    const fx = fcHorizon === 'week' ? f.week : f.month;
    const accs = fcHorizon === 'week' ? f.accountsWeek : f.accountsMonth;
    const confText = { good: `based on ${fx.loggedDays} days of your history`,
      medium: `medium confidence — only ${fx.loggedDays} days logged so far`,
      low: `low confidence — only ${fx.loggedDays} days logged; this sharpens as you log more` }[fx.confidence];
    const beText = { on_track: ['good', '✓ On track to clear break-even'],
      close: ['warn', '≈ Close to break-even — could go either way'],
      off_track: ['bad', 'Trending below break-even'],
      unknown: ['', ''] }[fx.breakEven.status];

    const mtd = ins.monthToDate;
    const goals = Object.fromEntries((ins.goals || []).map(g => [g.type, g.target]));
    const pace = mtd.dayOfMonth > 0 ? mtd.daysInMonth / mtd.dayOfMonth : 1;

    return `
      <h2 class="page-title">Forecast & insights</h2>

      ${ins.enoughData && ins.summary ? `
      <div class="card highlight">
        <div class="card-title">In short</div>
        <p class="summary-text">${esc(ins.summary)}</p>
      </div>` : `
      <div class="card"><div class="card-title">Not much to say yet</div>
        <p class="hint">Only ${ins.loggedDays || 0} days logged. Keep logging daily — patterns, forecasts and flags appear as history builds.</p></div>`}

      <div class="card">
        <div class="card-title">Looking ahead</div>
        <div class="seg" style="margin-bottom:12px">
          <button class="seg-btn ${fcHorizon === 'week' ? 'on' : ''}" data-horizon="week">Next 7 days</button>
          <button class="seg-btn ${fcHorizon === 'month' ? 'on' : ''}" data-horizon="month">Next 30 days</button>
        </div>
        <div class="be-row"><span>Projected sales</span>
          <strong>${money(fx.revenue.low)} – ${money(fx.revenue.high)}</strong></div>
        <div class="be-row"><span>Projected costs <span class="hint">(recurring exact: ${money(fx.costs.recurring)}${fx.costs.labor > 0 ? ` · team ${money(fx.costs.labor)}` : ''})</span></span>
          <strong>≈ ${money(fx.costs.point)}</strong></div>
        <div class="be-row"><span>Projected profit</span>
          <strong class="${fx.profit.point >= 0 ? 'pos' : 'neg'}">${money(fx.profit.low)} – ${money(fx.profit.high)}</strong></div>
        ${fx.breakEven.sales !== null ? `
          <div class="be-row"><span>Break-even for this period</span><strong>${money(fx.breakEven.sales)}</strong></div>
          ${beText[1] ? `<span class="pill ${beText[0]}">${beText[1]}</span>` : ''}` : ''}
        <div class="hint" style="margin-top:8px">
          Uses your weekday patterns (×${fx.trendFactor.toFixed(2)} recent trend) and cost rates learned from
          your last weeks — day-to-day costs at ${pct(fx.ratios.variable)} and commissions at ${pct(fx.ratios.commissions)}
          of sales${fx.ratios.source === 'defaults' ? ' (from category defaults until you have more history)' : ', as your channel mix actually ran'}.
          ${confText}. These are estimates from your own history, not guarantees — and not financial advice.
        </div>
        ${f.holidays.length ? `<div class="hint" style="margin-top:6px">📅 Coming up: ${f.holidays.map(h =>
          `${esc(h.name)} (${fmtDate(h.date, { month: 'short', day: 'numeric' })})`).join(', ')} — holidays often shift restaurant traffic; the forecast doesn't model them yet.</div>` : ''}
      </div>

      <div class="card">
        <div class="card-title">Cash position ahead (rough)</div>
        ${accs.map(a => `
          <div class="be-row"><span>${esc(a.name)} <span class="hint">now ${money(a.balance)}</span></span>
            <strong class="${a.projected < 0 ? 'neg' : ''}">→ ≈ ${money(a.projected)}</strong></div>`).join('')}
        <div class="hint">Projects each account's average daily movement from your last 4 weeks. Rough by nature.</div>
      </div>

      <details class="card" open>
        <summary class="card-title">What-if simulator</summary>
        <div class="whatif" data-rev="${mtd.revenue}" data-var="${mtd.variable}" data-comm="${mtd.commissions}"
          data-rec="${mtd.recurring}" data-one="${mtd.oneoff}" data-dom="${mtd.dayOfMonth}">
          <label>Price change: <strong id="wiPriceVal">0%</strong>
            <input type="range" id="wiPrice" min="-15" max="15" value="0" step="1"></label>
          <label>Day-to-day cost change (food, supplies…): <strong id="wiVarVal">0%</strong>
            <input type="range" id="wiVar" min="-15" max="15" value="0" step="1"></label>
          <label>Extra monthly recurring cost: <strong id="wiRecVal">$0</strong>
            <input type="range" id="wiRec" min="0" max="30000" value="0" step="500"></label>
          <div class="day-rev" id="wiResult"></div>
          <div class="hint">Plays with a copy of this month's numbers — your real data never changes. Assumes sales volume stays the same when prices move.</div>
        </div>
      </details>

      <details class="card">
        <summary class="card-title">Goals</summary>
        <form id="goalForm" class="row2">
          <label>Monthly profit target
            <input type="number" inputmode="decimal" step="any" min="0" name="profit" value="${goals.profit ?? ''}" placeholder="e.g. 40000"></label>
          <label>Net margin target %
            <input type="number" inputmode="decimal" step="any" min="0" max="100" name="margin" value="${goals.margin ?? ''}" placeholder="e.g. 12"></label>
        </form>
        <button class="btn primary" id="saveGoals">Save goals</button>
        ${goals.profit ? (() => {
          const projected = mtd.profit * pace;
          const onPace = projected >= goals.profit;
          return `<div class="be-row" style="margin-top:12px"><span>Profit pace (${mtd.dayOfMonth}/${mtd.daysInMonth} days)</span>
            <strong>${money(mtd.profit)} → ≈ ${money(projected)} <span class="pill ${onPace ? 'good' : 'bad'}">${onPace ? 'On pace' : 'Behind'}</span></strong></div>
            <div class="progress"><div class="progress-fill ${onPace ? 'good' : ''}" style="width:${Math.min(100, goals.profit > 0 ? mtd.profit / goals.profit * 100 : 0)}%"></div></div>`;
        })() : ''}
        ${goals.margin && mtd.netMargin !== null ? `
          <div class="be-row"><span>Net margin now</span>
            <strong>${pct(mtd.netMargin)} vs target ${goals.margin}%
            <span class="pill ${mtd.netMargin * 100 >= goals.margin ? 'good' : 'bad'}">${mtd.netMargin * 100 >= goals.margin ? 'Met' : 'Below'}</span></strong></div>` : ''}
      </details>

      ${ins.channelStats?.channels?.length ? channelSection(ins.channelStats) : ''}

      ${ins.enoughData ? `
      <details class="card">
        <summary class="card-title">Patterns & changes</summary>
        ${ins.weekdays?.length ? `<div class="ins-block"><strong>Your week, ranked</strong>
          ${ins.weekdays.map(w => `<div class="bd-row"><div class="bd-name">${w.day}s</div>
            <div class="bd-amt">${money(w.mean)}</div><div class="bd-inv hint">avg</div></div>`).join('')}</div>` : ''}
        ${ins.channels?.length ? `<div class="ins-block"><strong>Channels, last 4 weeks vs prior 4</strong>
          ${ins.channels.map(c => `<div class="bd-row"><div class="bd-name">${esc(c.name)}</div>
            <div class="bd-amt">${money(c.now)}</div>
            <div class="bd-inv ${c.change > 0 ? 'pos' : c.change < 0 ? 'neg' : ''}">${c.change === null ? 'new' : (c.change > 0 ? '+' : '') + (c.change * 100).toFixed(0) + '%'}</div></div>`).join('')}</div>` : ''}
        ${ins.costCreep?.length ? `<div class="ins-block"><strong>Cost growth vs sales growth (${ins.revGrowth === null ? '—' : (ins.revGrowth > 0 ? '+' : '') + (ins.revGrowth * 100).toFixed(0) + '%'})</strong>
          ${ins.costCreep.map(c => `<div class="bd-row"><div class="bd-name">${esc(c.name)} ${c.creeping ? '<span class="pill bad">creeping</span>' : ''}</div>
            <div class="bd-amt">${money(c.now)}</div>
            <div class="bd-inv ${c.change > 0 ? 'neg' : 'pos'}">${c.change === null ? 'new' : (c.change > 0 ? '+' : '') + (c.change * 100).toFixed(0) + '%'}</div></div>`).join('')}</div>` : ''}
        ${ins.weekly?.length >= 2 ? `<div class="ins-block"><strong>Weekly margin & effective commission rate</strong>
          ${ins.weekly.map(w => `<div class="bd-row"><div class="bd-name">${fmtDate(w.week, { month: 'short', day: 'numeric' })}</div>
            <div class="bd-amt">${w.margin === null ? '—' : pct(w.margin)}</div>
            <div class="bd-inv hint">${w.commissionRate === null ? '—' : pct(w.commissionRate)} comm.</div></div>`).join('')}
          <div class="hint">Margin trend: ${ins.marginTrend}. Commission rate reflects your real channel mix each week.</div></div>` : ''}
        ${ins.outliers?.length ? `<div class="ins-block"><strong>Unusual days (last 4 weeks)</strong>
          ${ins.outliers.map(o => `<div class="bd-row"><div class="bd-name">${fmtDate(o.date)}</div>
            <div class="bd-amt">${money(o.revenue)}</div><div class="bd-inv hint">vs ~${money(o.expected)}</div></div>`).join('')}</div>` : ''}
        ${ins.records?.bestDay ? `<div class="ins-block"><strong>Records</strong>
          <div class="hint">Best day: ${fmtDate(ins.records.bestDay.date)} — ${money(ins.records.bestDay.revenue)}.
          ${ins.records.worstDay ? `Slowest: ${fmtDate(ins.records.worstDay.date)} — ${money(ins.records.worstDay.revenue)}.` : ''}
          ${ins.records.bestWeek ? `Best week: ${fmtDate(ins.records.bestWeek.week)} — ${money(ins.records.bestWeek.revenue)}.` : ''}</div></div>` : ''}
        ${ins.labor ? `<div class="ins-block"><strong>Labor vs revenue</strong>
          <div class="hint">Scheduled labor ${money(ins.labor.thisWeek)} this week (${(ins.labor.laborGrowth * 100).toFixed(0)}% vs last)
          against revenue ${(ins.labor.revGrowth * 100).toFixed(0)}%.
          ${ins.labor.flag ? '<span class="pill bad">Labor climbing faster than sales</span>' : '<span class="pill good">In line</span>'}</div></div>` : ''}
      </details>` : ''}

      <div id="compareSlot"></div>`;
  });

  // ---- sales channels: sold vs actually kept after commissions ----
  function channelSection(cs) {
    const totGross = cs.channels.reduce((s, c) => s + c.gross, 0);
    const totNet = cs.channels.reduce((s, c) => s + c.net, 0);
    return `
      <div class="card">
        <div class="card-title">Sales channels — sold vs kept</div>
        <div class="be-row"><span>Sold (last 8 weeks)</span><strong>${money(totGross)}</strong></div>
        <div class="be-row"><span>Actually kept after commissions</span>
          <strong class="pos">${money(totNet)} <span class="hint">(${totGross > 0 ? Math.round(totNet / totGross * 100) : 100}%)</span></strong></div>
        ${cs.weekly.length >= 2 ? grossNetChart(cs.weekly) + `
        <div class="legend"><span><i class="dot rev"></i>Sold</span><span><i class="dot net"></i>Kept after commissions</span></div>` : ''}
        <div class="ch-list">
          ${cs.channels.map(c => `
            <div class="ch-row">
              <div class="ch-head">
                <div><strong>${esc(c.name)}</strong>
                  <span class="hint">${Math.round(c.share * 100)}% of sales${c.bestDay ? ` · strongest: ${c.bestDay}s` : ''}</span></div>
                <div class="ch-growth ${c.growth === null ? '' : c.growth >= 0 ? 'pos' : 'neg'}">
                  ${c.growth === null ? '' : (c.growth >= 0 ? '▲ +' : '▼ ') + (c.growth * 100).toFixed(0) + '%'}</div>
              </div>
              <div class="ch-bars" title="Sold vs kept">
                <div class="ch-bar gross" style="width:${totGross > 0 ? Math.max(2, c.gross / cs.channels[0].gross * 100) : 0}%"></div>
                <div class="ch-bar net" style="width:${totGross > 0 ? Math.max(1, c.net / cs.channels[0].gross * 100) : 0}%"></div>
              </div>
              <div class="ch-nums">
                <span>Sold <strong>${money(c.gross)}</strong></span>
                <span>− ${(c.rate * 100).toFixed(1)}% comm. (${money(c.commission)})</span>
                <span>Kept <strong class="pos">${money(c.net)}</strong></span>
                ${sparkline(c.weekly)}
              </div>
            </div>`).join('')}
        </div>
        <div class="hint">Growth compares the last 4 weeks to the 4 before. "Kept" is after channel commissions only — food, labor and rent still come out of it.</div>
      </div>`;
  }

  function grossNetChart(weekly) {
    const W = 640, H = 170, PAD = { l: 8, r: 8, t: 12, b: 22 };
    const max = Math.max(...weekly.map(w => w.gross), 1);
    const x = i => PAD.l + i * (W - PAD.l - PAD.r) / Math.max(1, weekly.length - 1);
    const y = v => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
    const line = key => weekly.map((w, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(w[key]).toFixed(1)}`).join('');
    const gapArea = `M${x(0)},${y(weekly[0].gross)} ${weekly.map((w, i) => `L${x(i)},${y(w.gross)}`).join(' ')}
      ${weekly.slice().reverse().map((w, i) => `L${x(weekly.length - 1 - i)},${y(w.net)}`).join(' ')} Z`;
    const labels = [0, weekly.length - 1].map(i =>
      `<text x="${x(i)}" y="${H - 6}" class="ch-label" text-anchor="${i === 0 ? 'start' : 'end'}">${fmtDate(weekly[i].week, { month: 'short', day: 'numeric' })}</text>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="none" role="img" aria-label="Sold vs kept per week">
      <line x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}" class="ch-axis"/>
      <path d="${gapArea}" class="ch-gap"/>
      <path d="${line('gross')}" class="ch-line rev"/>
      <path d="${line('net')}" class="ch-line net"/>
      ${labels}</svg>`;
  }

  function sparkline(weekly) {
    const W = 90, H = 26;
    const max = Math.max(...weekly.map(w => w.gross), 1);
    const bw = W / weekly.length;
    return `<svg viewBox="0 0 ${W} ${H}" class="spark" aria-hidden="true">
      ${weekly.map((w, i) => {
        const h = Math.max(1.5, w.gross / max * (H - 2));
        return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" class="spark-bar"/>`;
      }).join('')}</svg>`;
  }

  registerRoute('insights_bind', (app) => {
    app.querySelectorAll('[data-horizon]').forEach(b => b.onclick = () => {
      fcHorizon = b.dataset.horizon; render();
    });

    // what-if: recompute instantly from month-to-date baseline
    const wi = app.querySelector('.whatif');
    if (wi) {
      const base = {
        rev: Number(wi.dataset.rev), vc: Number(wi.dataset.var), comm: Number(wi.dataset.comm),
        rec: Number(wi.dataset.rec), one: Number(wi.dataset.one)
      };
      const els = ['wiPrice', 'wiVar', 'wiRec'].map(id => app.querySelector('#' + id));
      const calcWi = () => {
        const [priceP, varP, recExtra] = els.map(e => Number(e.value));
        app.querySelector('#wiPriceVal').textContent = (priceP > 0 ? '+' : '') + priceP + '%';
        app.querySelector('#wiVarVal').textContent = (varP > 0 ? '+' : '') + varP + '%';
        app.querySelector('#wiRecVal').textContent = money(recExtra);
        if (base.rev <= 0) { app.querySelector('#wiResult').textContent = 'Log some sales this month first.'; return; }
        const rev2 = base.rev * (1 + priceP / 100);
        const commRatio = base.comm / base.rev;            // commissions scale with sales
        const vc2 = base.vc * (1 + varP / 100);            // food cost change
        // extra monthly recurring, prorated to the days elapsed this month
        const rec2 = base.rec + recExtra * ((Number(wi.dataset.dom) || 30) / 30.4);
        const profit2 = rev2 - vc2 - rev2 * commRatio - rec2 - base.one;
        const margin2 = profit2 / rev2;
        const baseProfit = base.rev - base.vc - base.comm - base.rec - base.one;
        const ratio2 = (vc2 + rev2 * commRatio) / rev2;
        const be2 = ratio2 < 0.99 ? (rec2 + base.one) / (1 - ratio2) : null;
        app.querySelector('#wiResult').innerHTML =
          `Month so far would be: profit <strong>${money(profit2)}</strong> (${money(profit2 - baseProfit) } vs real) ·
           net margin <strong>${pct(margin2)}</strong>${be2 ? ` · break-even sales <strong>${money(be2)}</strong>` : ''}`;
      };
      els.forEach(e => e.oninput = calcWi);
      calcWi();
    }

    // goals
    const gf = app.querySelector('#goalForm');
    app.querySelector('#saveGoals').onclick = async () => {
      const f = new FormData(gf);
      try {
        await api('/goals', { method: 'PUT', body: { location_id: state.locationId, type: 'profit', target: f.get('profit') || null } });
        await api('/goals', { method: 'PUT', body: { location_id: state.locationId, type: 'margin', target: f.get('margin') || null } });
        toast('Goals saved'); render();
      } catch (err) { toast(err.message, true); }
    };

    // location comparison (owner, 2+ locations)
    if (isOwner() && state.me.locations.length > 1) {
      api('/compare').then(rows => {
        const slot = app.querySelector('#compareSlot');
        if (!slot) return;
        slot.innerHTML = `<div class="card">
          <div class="card-title">Your locations this month</div>
          ${rows.map(r => `<div class="bd-row"><div class="bd-name"><strong>${esc(r.name)}</strong></div>
            <div class="bd-amt ${r.profit >= 0 ? 'pos' : 'neg'}">${money(r.profit)}</div>
            <div class="bd-inv hint">${money(r.revenue)} sold · ${r.netMargin === null ? '—' : pct(r.netMargin)}</div></div>`).join('')}
        </div>`;
      }).catch(() => {});
    }
  });

})();
