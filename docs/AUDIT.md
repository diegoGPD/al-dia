# Spec audit — Al Día

Every requirement from the platform spec, mapped to where it lives. Updated after the 2026-07 restructure.

## Architecture (post-restructure)

```
server.js                  Express entry, static hosting, SPA fallback
src/
  db.js                    Schema, migrations, seeds (never wiped — migrations only add)
  auth.js                  Sessions (HMAC cookie), roles, location access
  calc.js                  All period math: summaries, break-even, labor, accounts, benchmarks
  forecast.js              Forecasting, insights, channel behavior, holidays
  lib/dates.js             One shared date library (was duplicated 3×)
  lib/parse.js             Request parsing helpers
  routes/
    session.js             status / setup (SETUP_CODE-gated) / login / logout
    admin.js               me, locations, users, commission recalc
    categories.js          The four configurable groups
    logs.js                Revenue, day costs, recurring, one-offs, moves, CSV import
    money.js               Accounts view, transfers, PIN balance corrections
    team.js                Roster + weekly schedule
    analytics.js           Dashboard, forecast, insights, goals, compare
public/
  app.js                   SPA core: state, router, API client, MXN formatting
  js/ui.js                 Shared UI: modal, period bar, charts, dialogs
  js/views/                auth, dashboard, log, money, team, insights, settings
scripts/
  smoke-test.sh            25-check end-to-end regression suite
  reset-password.js        Owner password reset (server console)
  recalc-commissions.js    CLI twin of the Settings button
```

## Spec coverage

| Requirement | Status | Where |
|---|---|---|
| Profit/loss per day/week/month, period nav, prev-period comparison | ✅ | Dashboard; previous period clamped to same elapsed days |
| Break-even point + distance from it | ✅ | Always includes day-to-day costs AND commissions (actual → 28-day history → defaults) |
| Gross & net margin | ✅ | Dashboard (current), Insights (weekly series over time) |
| Trend revenue vs costs vs profit | ✅ | 30-day chart on dashboard |
| Status indicator | ✅ | Profitable / At break-even / Below break-even banner |
| Cost breakdown incl. invoiced vs not, by category | ✅ | Costs tab, first-class; includes commissions + scheduled labor lines |
| Industry benchmarks, flagged as general, out-of-range warnings | ✅ | Dashboard card; category benchmark tags keep them accurate |
| Owner + manager roles, per-location scoping | ✅ | Managers: log + view their locations; owner: everything |
| Auth: hashed passwords, persistent session, logout | ✅ | bcrypt, 30-day HMAC cookie, Settings → sign out |
| Password reset | ✅ (placeholder+) | Owner resets managers in-app; owner via server script; login-screen guidance |
| Setup safety on public URL | ✅ | SETUP_CODE env gate |
| 4 configurable groups, seeded, editable, deletable | ✅ | Settings; archive-not-delete when history exists |
| Revenue channels with own commission % + invoiced flag | ✅ | Commissions stored per day (history-proof), recalc tool for corrections |
| Accounts: revenue split, paid-from tags, unassigned bucket | ✅ | Accounts sub-view; totals tie out with dashboard |
| Running balances + opening balance | ✅ | Plus transfers and PIN-protected corrections (beyond spec) |
| Separate fast logging flows | ✅ | Sales / day costs / one-off / recurring; % suggestions from day's sales |
| All log dates editable | ✅ | Move-day for sales/costs; full edit for one-offs, transfers, recurring |
| Roster: name, role, hourly/weekly pay | ✅ | Team tab |
| Weekly grid, copy last week | ✅ | Tap-to-edit cells, overnight shifts supported |
| Auto labor cost vs payroll budget, ±10% flag | ✅ | Also auto-booked into P&L daily (salaries spread across week) |
| 48 h/week soft flag | ✅ | Non-blocking warning, "not legal advice" |
| PNG schedule export (no pay info) | ✅ | Canvas render, phone-legible, location + week header |
| Forecast week/month from own history, ranges + confidence | ✅ | Weekday model × trend; commission/cost ratios learned weekly (drift-aware) |
| Projected break-even + account balances | ✅ | Forecast card |
| Plain-language insights + written summary | ✅ | All spec'd insights incl. outliers, records, labor-vs-revenue |
| Extras: what-if, goals, comparison, holidays | ✅ | All client-safe; what-if never touches real data |
| MXN, plain language, mobile-first, <1-min logging | ✅ | Throughout |
| CSV import | ✅ | Sales + costs, re-import safe |

## Deliberate deviations

- "Delivery / takeout, dine-in" example revenue categories → replaced by the owner's real sales channels (each carrying its own commission), which is strictly more capable.
- Commissions and scheduled labor never tag to money accounts: platforms deduct commissions pre-payout, and labor is booked as an accrual. Both excluded from the accounts tie-out on purpose, stated in the UI.
- Recurring digest → implemented as the always-current written summary rather than scheduled email (no email infrastructure; nothing to configure or break).

## Data

No schema changes were needed for the restructure; the database is untouched. All migrations remain additive (`CREATE TABLE IF NOT EXISTS` + guarded `ALTER TABLE ADD COLUMN`).
