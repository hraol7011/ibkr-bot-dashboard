# IBKR Bot Dashboard

A tiny always-on web app that shows what your trading bot is doing, live:
connection status, kill-switch/halt state, P&L, an equity curve, recent
trade decisions (with which price-action signals agreed), and a tail of
the bot's own log. The bot (running on your Mac) pushes a snapshot to this
app every scan cycle; this app just stores the latest state and serves a
page that polls for it.

## Two secrets, two roles

- **`REPORT_TOKEN`** — the password the *bot* uses to push updates in. Put
  the same value in the bot's `config.yaml` under `dashboard.token`.
- **`DASHBOARD_USER`** / **`DASHBOARD_PASSWORD`** — the login *you* use to
  view the page in a browser (plain HTTP Basic Auth — good enough for a
  personal dashboard, not meant for anything more sensitive than this).

All three are required environment variables. The server refuses to start
without them, on purpose — there's no way to accidentally deploy this
with your account's P&L visible to the whole internet with no password.

## Deploying to Render (free tier)

Render's free web service plan is genuinely $0/month. Two tradeoffs worth
knowing upfront: Render asks for a card on signup for a $1 verification
charge that's immediately refunded (identity/anti-abuse check, not a
subscription charge), and free services "spin down" after about 15
minutes with no incoming requests — the first request after a gap takes
30-60 seconds to wake back up. Fine for a personal status dashboard you
check periodically; annoying if you wanted it instantly responsive at
all times. There's also no persistent disk on the free plan, so the
dashboard's history resets on redeploys/restarts -- not a real problem,
since the bot repopulates it within one scan cycle.

**1. Push this folder to a GitHub repo** (Render deploys from git, not
a local folder upload):
```bash
cd ~/PYTHON/ibkr_bot_dashboard
git init
git add .
git commit -m "Initial dashboard"
git branch -M main
```
Then create a new (private is fine) repository on github.com, and:
```bash
git remote add origin https://github.com/<your-username>/ibkr-bot-dashboard.git
git push -u origin main
```
If `git push` asks for a password: GitHub no longer accepts your account
password there. Use a Personal Access Token instead (GitHub -> Settings
-> Developer settings -> Personal access tokens -> Generate new token,
"repo" scope) and paste that in as the password when prompted.

**2. Deploy on Render:**
1. Sign up at [render.com](https://render.com) — signing up with your
   GitHub account is easiest since it can see your repos immediately.
2. Click **New +** -> **Blueprint**.
3. Select the `ibkr-bot-dashboard` repo you just pushed. Render will
   detect the `render.yaml` file in this project automatically.
4. It'll prompt you for the three environment variables it's marked as
   secret: `REPORT_TOKEN` (generate one with `openssl rand -hex 24` in
   Terminal), `DASHBOARD_USER` (pick a username), `DASHBOARD_PASSWORD`
   (pick a strong password).
5. Click **Apply** / **Create Web Service** — Render builds and deploys.
6. Once live, Render shows you the public URL (looks like
   `https://ibkr-bot-dashboard.onrender.com`).

Take that URL and the `REPORT_TOKEN` you set, and put them into the
bot's `config.yaml`:

```yaml
dashboard:
  enabled: true
  url: "https://ibkr-bot-dashboard.onrender.com/api/report"
  token: "<the-same-REPORT_TOKEN-you-set-in-render>"
```

Then visit the Render URL in a browser and log in with
`DASHBOARD_USER` / `DASHBOARD_PASSWORD` to watch it live. Remember the
first load after a quiet period will be slow (~30-60s) while the free
instance wakes up — that's expected, not broken.

## Running locally first (optional, recommended)

Before deploying, sanity-check it on your own machine:

```bash
npm install
REPORT_TOKEN=test DASHBOARD_USER=admin DASHBOARD_PASSWORD=test123 npm start
```

Then in another terminal, simulate a bot report:

```bash
curl -X POST http://localhost:3000/api/report \
  -H "Authorization: Bearer test" -H "Content-Type: application/json" \
  -d '{"mode":"paper","accountId":"DUR984127","connected":true,"netLiquidation":1000000,"unrealizedPnl":0,"realizedPnlToday":0,"positions":[],"recentTrades":[],"logTail":["hello from the bot"]}'
```

Visit `http://localhost:3000` (login `admin` / `test123`) and you should
see the dashboard populated.
