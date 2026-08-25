// Live status dashboard for the IBKR price-action trading bot.
//
// Two roles, two secrets:
//   - The BOT posts snapshots to  POST /api/report   (Authorization: Bearer <REPORT_TOKEN>)
//   - YOU view the dashboard at   GET  /              (HTTP Basic Auth: DASHBOARD_USER / DASHBOARD_PASSWORD)
//
// All three env vars are required -- the server refuses to start without them,
// on purpose, so a misconfigured deploy can't accidentally serve trading data
// to the open internet with no password.

const express = require("express");
const basicAuth = require("express-basic-auth");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const REPORT_TOKEN = process.env.REPORT_TOKEN;
const DASHBOARD_USER = process.env.DASHBOARD_USER;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");

const MAX_EQUITY_POINTS = 3000;
const MAX_TRADES = 500;

for (const [name, val] of Object.entries({ REPORT_TOKEN, DASHBOARD_USER, DASHBOARD_PASSWORD })) {
  if (!val) {
    console.error(`Missing required environment variable: ${name}. Refusing to start. ` +
      "Set it in Railway's Variables tab (see README.md).");
    process.exit(1);
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {
    return {
      latest: null,          // last full status snapshot from the bot
      equityHistory: [],     // [{t, netLiquidation, unrealizedPnl, realizedPnlToday}]
      recentTrades: [],      // [{t, symbol, direction, status, quantity, entry, stop, target, signals, reason}]
      logTail: [],           // most recent bot.log lines, as sent
      lastReportAt: null,
    };
  }
}

let store = loadStore();

function saveStore() {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store));
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// --- Ingest endpoint: the bot posts here. Bearer token, not basic auth. ---
app.post("/api/report", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== REPORT_TOKEN) {
    return res.status(401).json({ error: "invalid or missing bearer token" });
  }

  const body = req.body || {};
  const now = new Date().toISOString();

  store.latest = {
    receivedAt: now,
    mode: body.mode,
    accountId: body.accountId,
    connected: !!body.connected,
    killSwitchTripped: !!body.killSwitchTripped,
    dailyHalted: !!body.dailyHalted,
    withinTradingWindow: !!body.withinTradingWindow,
    netLiquidation: body.netLiquidation,
    unrealizedPnl: body.unrealizedPnl,
    realizedPnlToday: body.realizedPnlToday,
    positions: Array.isArray(body.positions) ? body.positions : [],
    botTimestamp: body.timestamp || now,
  };
  store.lastReportAt = now;

  if (typeof body.netLiquidation === "number") {
    store.equityHistory.push({
      t: body.timestamp || now,
      netLiquidation: body.netLiquidation,
      unrealizedPnl: body.unrealizedPnl,
      realizedPnlToday: body.realizedPnlToday,
    });
    if (store.equityHistory.length > MAX_EQUITY_POINTS) {
      store.equityHistory = store.equityHistory.slice(-MAX_EQUITY_POINTS);
    }
  }

  if (Array.isArray(body.recentTrades) && body.recentTrades.length) {
    // The bot sends its own recent tail each time (read from trades.csv) --
    // replace rather than append, then cap, so a resent duplicate row never
    // piles up.
    const seen = new Set(store.recentTrades.map(t => `${t.t}|${t.symbol}|${t.status}`));
    for (const t of body.recentTrades) {
      const key = `${t.t}|${t.symbol}|${t.status}`;
      if (!seen.has(key)) {
        store.recentTrades.push(t);
        seen.add(key);
      }
    }
    store.recentTrades = store.recentTrades.slice(-MAX_TRADES);
  }

  if (Array.isArray(body.logTail)) {
    store.logTail = body.logTail.slice(-300);
  }

  saveStore();
  res.json({ ok: true });
});

// --- Everything else requires the viewer password. ---
app.use(basicAuth({
  users: { [DASHBOARD_USER]: DASHBOARD_PASSWORD },
  challenge: true,
  realm: "ibkr-bot-dashboard",
}));

app.get("/api/state", (req, res) => {
  res.json(store);
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Dashboard listening on port ${PORT}`);
});
