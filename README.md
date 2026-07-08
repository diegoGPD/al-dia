# Al Día — Restaurant profitability tracker

A hosted web app that answers three questions at a glance:

1. **How much did I make and spend** in a given day, week, or month?
2. **Where is my break-even point** — the sales level where I stop losing money?
3. **How much profit am I actually keeping** once all costs are counted?

Multi-location, multi-user (owner + managers), fully configurable categories, invoiced/not-invoiced tracking on every cost, MXN formatting, mobile-first UI.

## Stack (and why)

- **Node.js 22 + Express** — one small server, no build step, easy to keep running.
- **SQLite** (Node's built-in `node:sqlite`) — a real server-side database with zero native dependencies. Your data lives in one file on a persistent volume; backups are a file copy. More than enough for this workload, and there's nothing extra to pay for or administer.
- **Vanilla JS frontend** served by the same server — no framework churn, loads fast on a phone during service.
- **Auth** — bcrypt-hashed passwords, HMAC-signed httpOnly session cookies. Owner sees everything; managers can log sales/costs and view the dashboard for their assigned locations only.

## Deploy to Railway (~10 minutes, ~US$5/mo)

1. **Put this folder on GitHub.** Create a new repository at github.com/new, then from this folder:
   ```
   git init && git add . && git commit -m "Al Día"
   git remote add origin https://github.com/YOURNAME/al-dia.git
   git push -u origin main
   ```
2. **Create the Railway project.** At railway.app → *New Project* → *Deploy from GitHub repo* → pick `al-dia`. Railway detects the Dockerfile and builds it.
3. **Add the persistent volume (important).** On the project canvas, right-click empty space → *Volume* (or press ⌘K / Ctrl+K → "Create Volume"). Attach it to the al-dia service and set the mount path to `/data`. Without this, the database resets on every deploy.
4. **Set one variable.** Service → *Variables* → add `SESSION_SECRET` = any long random string (e.g. from https://generate-secret.vercel.app/32). Optional but recommended: `NODE_ENV` = `production` (already set by the Dockerfile).
5. **Expose it.** Service → *Settings* → *Networking* → *Generate domain*. You'll get `something.up.railway.app` over HTTPS.
6. **Open the URL.** The first visit shows a 30-second setup screen where you create your owner account and first location. There are no default passwords.

Pushing new commits to GitHub redeploys automatically. The volume keeps your data across deploys.

### Other hosts
The Dockerfile runs anywhere (Render, Fly.io, a VPS). Requirements: Node 22+, a persistent directory for `DATA_DIR` (defaults to `./data`), and `PORT`/`SESSION_SECRET` env vars.

### Run locally
```
npm install
npm start        # http://localhost:3000
```

## Using it

- **Home** — pick Day/Week/Month, arrow between periods. You get a status banner (Profitable / At break-even / Below break-even), money in/out, what you kept, break-even progress, a 30-day trend, and comparisons vs the previous period. For a period still in progress, costs accrue only up to today and the previous-period comparison covers the same number of days — so mid-month numbers are honest.
- **Log → Sales** — date + total, under a minute. Break it down by sales channel (Uber Eats, Rappi, card in store, cash…) and each channel's commission is calculated automatically and counted as a cost — with its own invoiced (facturado) status. Commission percentages live on each channel in Settings; changing a % only affects sales logged from then on, so history stays exact.
- **Log → Daily costs** — one row per cost category, with the day's sales shown for reference. Percent-based categories suggest an amount from that day's sales; tap to accept or type your own. Invoiced toggles are pre-set from each category's default.
- **Log → One-off cost** — date, description, amount, invoiced yes/no.
- **Log → Recurring costs** (owner) — add rent, payroll, etc. once with how often you pay it (weekly / every 2 weeks / monthly). They spread into a daily equivalent automatically. Deleting one ends it from today so past numbers stay correct.
- **Costs** — the breakdown view: recurring vs day-to-day vs channel commissions vs one-offs, by category and by channel, and invoiced (facturado) vs not — totals and per-category.
- **Settings** (owner) — manage categories in all three groups (add/rename/delete; categories with history are archived, not destroyed), locations, managers, and CSV import.

### CSV import
- **Sales:** columns `date,total` — or `date,category,amount` to import with a category breakdown.
- **Costs:** columns `date,category,amount,invoiced`. Rows matching one of your day-to-day cost categories land there; anything else becomes a one-off cost.
- Dates as `YYYY-MM-DD`. Re-importing the same date overwrites it (safe to re-run).

### Benchmarks
The dashboard compares your food, labor, prime, occupancy and net-margin percentages against **general industry ranges** (clearly labeled — they're not your targets) and flags anything well outside them. Tag categories in Settings ("counts as food / labor / occupancy") to keep these accurate.

## Break-even math
Break-even sales = fixed costs ÷ (1 − variable-cost ratio). Fixed costs are your recurring costs (daily equivalents) plus one-offs for the period; the variable ratio comes from your actual logged data, falling back to category defaults until you have real numbers.

## Backups
Your entire database is one file on the volume: `/data/aldia.db`. Railway CLI: `railway ssh` then copy it out, or add any scheduled backup you like.
