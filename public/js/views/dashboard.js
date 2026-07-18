/* Al Día — dashboard */
'use strict';
(() => {
  const { api, state, registerRoute, nav, render, loadMe,
          money, money2, pct, esc, fmtDate, fmtRange, today, addDays, addMonths, toast } = App;
  const { isOwner, qLoc, modal, periodBar, bindPeriodBar, fetchDashboard, moveDayDialog, trendChart } = App.ui;

  // ======================================================================
  // Dashboard
  // ======================================================================
  registerRoute('dashboard', async () => {
    const d = await fetchDashboard();
    const c = d.current, p = d.previous, be = d.breakEven;
    const hasData = c.revenue > 0 || c.costs.total > 0;

    // status banner
    let banner;
    if (!hasData) {
      banner = `<div class="status-banner neutral"><div class="status-title">No data yet for this period</div>
        <div class="status-sub">Log your sales and costs to see how you're doing.</div></div>`;
    } else if (be.status === 'above') {
      banner = `<div class="status-banner good"><div class="status-title">✓ Profitable</div>
        <div class="status-sub">You're ${money(be.gap)} above your break-even point.</div></div>`;
    } else if (be.status === 'at') {
      banner = `<div class="status-banner warn"><div class="status-title">≈ At break-even</div>
        <div class="status-sub">You're covering your costs, but not keeping much yet.</div></div>`;
    } else {
      banner = `<div class="status-banner bad"><div class="status-title">Below break-even</div>
        <div class="status-sub">You need ${money(Math.abs(be.gap || 0))} more in sales to cover your costs.</div></div>`;
    }

    // goodWhenDown: for costs, a drop is good news
    const delta = (cur, prev, goodWhenDown) => {
      if (!prev) return '';
      const diff = cur - prev;
      const good = goodWhenDown ? diff <= 0 : diff >= 0;
      return `<span class="delta ${good ? 'up' : 'down'}">${diff >= 0 ? '+' : ''}${money(diff)} vs previous</span>`;
    };

    const beCard = be.salesNeeded !== null && be.salesNeeded > 0 ? `
      <div class="card">
        <div class="card-title">Break-even point</div>
        <div class="be-row"><span>Sales needed to cover all costs</span><strong>${money(be.salesNeeded)}</strong></div>
        <div class="be-row"><span>Your sales so far</span><strong>${money(c.revenue)}</strong></div>
        <div class="be-row hint-row"><span class="hint">Same thing net of commissions</span>
          <span class="hint">${money(c.revenue - c.costs.commissions)} of ${money(be.salesNeeded * (1 - be.commRatio))} needed — same ${be.salesNeeded > 0 ? Math.round(c.revenue / be.salesNeeded * 100) : 0}% either way</span></div>
        <div class="progress"><div class="progress-fill ${c.revenue >= be.salesNeeded ? 'good' : ''}"
          style="width:${Math.min(100, be.salesNeeded > 0 ? c.revenue / be.salesNeeded * 100 : 0)}%"></div></div>
        ${c.revenueByCategory.length ? `
        <details><summary class="hint">What each $100 sold really contributes, by channel</summary>
          ${c.revenueByCategory.filter(r => r.amount > 0).map(r => {
            const commRate = r.amount > 0 ? r.commission / r.amount : 0;
            const contrib = 100 * (1 - commRate - be.varRatio);
            return `<div class="bd-row"><div class="bd-name">${esc(r.name)}</div>
              <div class="bd-amt ${contrib <= 0 ? 'neg' : ''}">${money(contrib)}</div>
              <div class="bd-inv hint">− ${pct(commRate)} comm.</div></div>`;
          }).join('')}
          <div class="hint">After that channel's commission and your day-to-day cost rate (${pct(be.varRatio)}). What's left pays rent, payroll and one-offs — a channel is only truly losing money if this goes negative.</div>
        </details>` : ''}
        <div class="hint">Both figures are <strong>gross sales</strong> (what your POS reports); the target is
          grossed-up to already cover your fixed costs of ${money(be.fixed)} plus the ${pct(be.ratio)} of every
          sale that leaves as day-to-day costs (${pct(be.varRatio)}) and channel commissions
          (${pct(be.commRatio)} — your per-channel rates weighted by the actual channel mix)${
          be.ratioSource === 'actual' ? '' : be.ratioSource === 'mixed'
            ? '. Partly from recent history until this period has all its costs logged'
            : '. Estimated from recent history and channel settings for now'}.</div>
      </div>` : '';

    const bmCard = d.benchmarks.length ? `
      <div class="card">
        <div class="card-title">How you compare to typical restaurants</div>
        ${d.benchmarks.map(b => {
          const flagText = { high: 'Above typical', low: 'Below typical', great: 'Above typical', low_note: 'Below typical', ok: 'In range' }[b.flag];
          const flagCls = { high: 'bad', low: 'bad', great: 'good', low_note: 'warn', ok: 'good' }[b.flag];
          return `<div class="bm-row">
            <div class="bm-name">${b.label}<span class="hint"> · typical ${(b.low * 100).toFixed(0)}–${(b.high * 100).toFixed(0)}%</span></div>
            <div class="bm-val"><strong>${pct(b.value)}</strong> <span class="pill ${flagCls}">${flagText}</span></div>
          </div>`;
        }).join('')}
        <div class="hint">General industry benchmarks, not your targets. Set category tags in Settings so these stay accurate.</div>
      </div>` : '';

    return `
      ${periodBar(d)}
      ${banner}
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-label">Money in</div>
          <div class="stat-value">${money(c.revenue)}</div>${delta(c.revenue, p.revenue)}</div>
        <div class="stat-card tappable" id="moneyOutCard"><div class="stat-label">Money out ▾</div>
          <div class="stat-value">${money(c.costs.total)}</div>${delta(c.costs.total, p.costs.total, true)}</div>
        <div class="stat-card wide" id="moneyOutDetail" style="display:none">
          <div class="stat-label">Where the money went</div>
          ${(() => {
            const parts = [
              ['Recurring (rent, subscriptions…)', c.costs.recurring, 'rec'],
              ['Team (scheduled labor)', c.costs.labor, 'labor'],
              ['Day-to-day (food, supplies…)', c.costs.variable, 'var'],
              ['Channel commissions', c.costs.commissions, 'comm'],
              ['One-offs', c.costs.oneoff, 'one']
            ].filter(x => x[1] > 0.005);
            return parts.map(([label, amount, cls]) => `
              <div class="type-row"><span>${label}</span><strong>${money(amount)}
                <span class="hint">${c.costs.total > 0 ? Math.round(amount / c.costs.total * 100) : 0}%</span></strong></div>
              <div class="progress slim"><div class="progress-fill ${cls}"
                style="width:${c.costs.total > 0 ? amount / c.costs.total * 100 : 0}%"></div></div>`).join('')
              || '<div class="hint">No costs in this period.</div>';
          })()}
          <a class="hint" href="#/breakdown">Full breakdown by category →</a>
        </div>
        <div class="stat-card"><div class="stat-label">Commissions</div>
          <div class="stat-value">${money(c.costs.commissions)}</div>
          <div class="stat-sub">${c.revenue > 0 ? pct(c.costs.commissions / c.revenue) + ' of sales' : ''}</div>
          ${delta(c.costs.commissions, p.costs.commissions, true)}</div>
        <div class="stat-card"><div class="stat-label">Kept after commissions</div>
          <div class="stat-value">${money(c.revenue - c.costs.commissions)}</div>
          ${delta(c.revenue - c.costs.commissions, p.revenue - p.costs.commissions)}</div>
        <div class="stat-card wide ${c.profit >= 0 ? 'profit' : 'loss'}">
          <div class="stat-label">What you kept</div>
          <div class="stat-value">${money(c.profit)}</div>
          <div class="stat-sub">${c.revenue > 0 ? `Net margin ${pct(c.netMargin)} · Gross margin ${pct(c.grossMargin)}` : ''} ${delta(c.profit, p.profit)}</div>
        </div>
      </div>
      ${beCard}
      <div class="card">
        <div class="card-title">Last 30 days</div>
        ${trendChart(d.trend)}
        <div class="legend">
          <span><i class="dot rev"></i>Money in</span>
          <span><i class="dot cost"></i>Money out</span>
        </div>
      </div>
      ${bmCard}
      <div class="quick-actions">
        <a class="btn primary" href="#/log-revenue">+ Log sales</a>
        <a class="btn" href="#/log-costs">+ Log costs</a>
      </div>
      <a class="log-tile" href="#/insights"><span class="log-icon">🔮</span>
        <div><strong>Forecast & insights</strong>
        <div class="hint">Where you're headed, what's changing, and why</div></div></a>`;
  });
  registerRoute('dashboard_bind', (app) => {
    bindPeriodBar(app);
    const card = app.querySelector('#moneyOutCard');
    const detail = app.querySelector('#moneyOutDetail');
    if (card && detail) card.onclick = () => {
      detail.style.display = detail.style.display === 'none' ? '' : 'none';
    };
  });

})();
