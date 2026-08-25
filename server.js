// FRIDAY -- Research Desk server.
//
// Redesigned 2026-08-24: this used to be a full Bloomberg-style terminal
// (world indices, global news, company financials/DCF, a candlestick chart
// screen) pulling from half a dozen external data sources (FMP, Yahoo,
// stooq, SEC EDGAR, RSS feeds). Per an explicit request to drop all of that
// and focus the whole site on one thing -- showing what the bot itself is
// researching and doing, live -- this rewrite cuts every external dependency
// that isn't load-bearing for that. Financials/fundamentals are intentionally
// NOT fetched here anymore; the user checks those directly in the IBKR
// portal when they want them.
//
// What's left:
//   - The BOT posts a full state snapshot every cycle to  POST /api/report
//     (Bearer REPORT_TOKEN), including `researchLog`: what it looked at
//     this scan, every signal's vote, and the outcome for every instrument
//     -- not just the ones that became trades.
//   - The BOT polls remote commands at  GET /api/commands  (same token).
//   - YOU view the desk at  GET /  (Basic auth DASHBOARD_USER/PASSWORD).
//   - The only external call left is Finnhub, for live quotes -- and only
//     for whatever symbols the bot itself is actually trading/researching
//     right now (learned from its own reports, not a hardcoded watchlist).

const express = require("express");
const basicAuth = require("express-basic-auth");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const REPORT_TOKEN = process.env.REPORT_TOKEN;
const DASHBOARD_USER = process.env.DASHBOARD_USER;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const FINNHUB_KEY = process.env.FINNHUB_KEY || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");

const MAX_EQUITY_POINTS = 3000;
const MAX_TRADES = 500;
const MAX_RESEARCH_HISTORY = 400; // rolling log of past research ticks, beyond just "latest scan"

for (const [name, val] of Object.entries({ REPORT_TOKEN, DASHBOARD_USER, DASHBOARD_PASSWORD })) {
  if (!val) {
    console.error(`Missing required environment variable: ${name}. Refusing to start.`);
    process.exit(1);
  }
}
if (!FINNHUB_KEY) console.warn("FINNHUB_KEY not set -- live price ticks will be degraded (research/trades still work).");

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, "utf8")); }
  catch {
    return {
      latest: null, equityHistory: [], recentTrades: [], researchHistory: [],
      logTail: [], lastReportAt: null, commands: [], activeSymbols: [],
    };
  }
}
let store = loadStore();
if (!Array.isArray(store.commands)) store.commands = [];
if (!Array.isArray(store.researchHistory)) store.researchHistory = [];
if (!Array.isArray(store.activeSymbols)) store.activeSymbols = [];
function saveStore() { fs.writeFileSync(STORE_PATH, JSON.stringify(store)); }

const app = express();
app.use(express.json({ limit: "2mb" }));

// ===========================================================================
// Bot-facing endpoints (Bearer token)
// ===========================================================================
function botAuthed(req) {
  const auth = req.headers.authorization || "";
  return auth.startsWith("Bearer ") && auth.slice(7) === REPORT_TOKEN;
}

app.post("/api/report", (req, res) => {
  if (!botAuthed(req)) return res.status(401).json({ error: "invalid or missing bearer token" });
  const body = req.body || {};
  const now = new Date().toISOString();
  const researchLog = Array.isArray(body.researchLog) ? body.researchLog : [];

  store.latest = {
    receivedAt: now,
    mode: body.mode,
    accountId: body.accountId,
    connected: !!body.connected,
    killSwitchTripped: !!body.killSwitchTripped,
    dailyHalted: !!body.dailyHalted,
    withinStockTradingWindow: !!body.withinStockTradingWindow,
    withinForexTradingWindow: !!body.withinForexTradingWindow,
    scanningPaused: !!body.scanningPaused,
    riskPerTradePct: body.riskPerTradePct ?? null,
    netLiquidation: body.netLiquidation,
    unrealizedPnl: body.unrealizedPnl,
    realizedPnlToday: body.realizedPnlToday,
    positions: Array.isArray(body.positions) ? body.positions : [],
    researchLog,
    botTimestamp: body.timestamp || now,
  };
  store.lastReportAt = now;

  if (typeof body.netLiquidation === "number") {
    store.equityHistory.push({ t: body.timestamp || now, netLiquidation: body.netLiquidation,
      unrealizedPnl: body.unrealizedPnl, realizedPnlToday: body.realizedPnlToday });
    if (store.equityHistory.length > MAX_EQUITY_POINTS) store.equityHistory = store.equityHistory.slice(-MAX_EQUITY_POINTS);
  }
  if (Array.isArray(body.recentTrades) && body.recentTrades.length) {
    const seen = new Set(store.recentTrades.map(t => `${t.t}|${t.symbol}|${t.status}`));
    for (const t of body.recentTrades) {
      const key = `${t.t}|${t.symbol}|${t.status}`;
      if (!seen.has(key)) { store.recentTrades.push(t); seen.add(key); }
    }
    store.recentTrades = store.recentTrades.slice(-MAX_TRADES);
  }
  if (researchLog.length) {
    const stamped = researchLog.map(r => ({ ...r, receivedAt: now }));
    store.researchHistory.push(...stamped);
    store.researchHistory = store.researchHistory.slice(-MAX_RESEARCH_HISTORY);
  }
  if (Array.isArray(body.logTail)) store.logTail = body.logTail.slice(-300);

  // Track whatever symbols the bot is actually touching right now (open
  // positions + this scan's research) so the quote poller below follows the
  // bot's real universe automatically instead of a hardcoded watchlist.
  const symbols = new Set([
    ...(store.latest.positions || []).map(p => p.symbol),
    ...researchLog.map(r => r.symbol),
  ].filter(Boolean));
  if (symbols.size) store.activeSymbols = Array.from(symbols).slice(0, 60);
  wsSyncSubscriptions();

  saveStore();
  res.json({ ok: true });
});

app.get("/api/commands", (req, res) => {
  if (!botAuthed(req)) return res.status(401).json({ error: "unauthorized" });
  res.json({ commands: store.commands.filter(c => c.status === "pending") });
});

app.post("/api/commands/ack", (req, res) => {
  if (!botAuthed(req)) return res.status(401).json({ error: "unauthorized" });
  const { id, status, detail } = req.body || {};
  const cmd = store.commands.find(c => c.id === id);
  if (!cmd) return res.status(404).json({ error: "unknown command id" });
  cmd.status = status === "done" ? "done" : "error";
  cmd.detail = String(detail || "").slice(0, 300);
  cmd.ackAt = new Date().toISOString();
  saveStore();
  res.json({ ok: true });
});

// ===========================================================================
// Live quotes -- Finnhub, scoped to whatever the bot is actually
// trading/researching (store.activeSymbols), learned from its own reports.
// No hardcoded watchlist, no other data sources.
//
// Ticks come off Finnhub's WEBSOCKET (real push, not polling) so price
// moves land in `quotes` the instant a trade prints -- this is what makes
// the position cards feel genuinely live instead of refreshing on a timer.
// A slow REST poll runs alongside it just to backfill prevClose/day-range
// (the websocket only sends trade prints, not those fields) and to give
// every symbol an initial price before its first tick arrives.
// ===========================================================================
const WebSocket = require("ws");

async function finnhub(pathq) {
  if (!FINNHUB_KEY) throw new Error("no FINNHUB_KEY set");
  const res = await fetch(`https://finnhub.io/api/v1${pathq}${pathq.includes("?") ? "&" : "?"}token=${FINNHUB_KEY}`);
  if (!res.ok) throw new Error(`finnhub HTTP ${res.status}`);
  return res.json();
}

// A bot position/research key looks like "AAPL" (stock) or "EUR.USD" (FX,
// see main.py's instrument_key: f"{symbol}.{currency}" for CASH contracts).
function toFinnhubSymbol(key) {
  if (key.includes(".")) {
    const [base, quote] = key.split(".");
    return `OANDA:${base}_${quote}`;
  }
  return key;
}
function fromFinnhubSymbol(fhSym) {
  if (fhSym.startsWith("OANDA:")) {
    const [base, quote] = fhSym.slice(6).split("_");
    return `${base}.${quote}`;
  }
  return fhSym;
}

const quotes = {}; // key -> {price, change, changePct, prevClose, dayHigh, dayLow, t, live, spark: number[]}
const priceHistory = {}; // key -> [{t, price}], rolling -- powers the small inline sparklines only
const MAX_HISTORY_POINTS = 900;
function recordAndSetQuote(key, q, opts = {}) {
  quotes[key] = { ...quotes[key], ...q, t: new Date().toISOString(), live: !!opts.live };
  if (typeof q.price === "number") {
    const arr = priceHistory[key] || (priceHistory[key] = []);
    arr.push({ t: Date.now(), price: q.price });
    if (arr.length > MAX_HISTORY_POINTS) arr.splice(0, arr.length - MAX_HISTORY_POINTS);
    quotes[key].spark = arr.slice(-60).map(p => p.price);
  }
}

let lastQuoteError = null;
let wsTickCount = 0;
let wsConnectedAt = null;

// ---- REST backfill: prevClose/day range + first price for brand-new symbols
async function pollActiveQuotesRest() {
  const symbols = store.activeSymbols || [];
  for (const key of symbols) {
    try {
      const fhSym = toFinnhubSymbol(key);
      const q = await finnhub(`/quote?symbol=${encodeURIComponent(fhSym)}`);
      if (typeof q.c === "number" && q.c > 0) {
        // Don't let a slow REST tick stomp a fresher websocket price -- only
        // set `price` here if the websocket hasn't already primed this key.
        const hasLiveTick = quotes[key] && quotes[key].live;
        recordAndSetQuote(key, {
          ...(hasLiveTick ? {} : { price: q.c }),
          change: q.d, changePct: q.dp, prevClose: q.pc, dayHigh: q.h, dayLow: q.l,
        }, { live: hasLiveTick });
      }
      lastQuoteError = null;
    } catch (e) {
      lastQuoteError = String(e.message || e);
    }
  }
}
setInterval(() => { pollActiveQuotesRest().catch(() => {}); }, 20_000);
pollActiveQuotesRest().catch(() => {});

// ---- Websocket: real-time trade prints, pushed the instant they happen
let ws = null;
let wsSubscribed = new Set();
let wsReconnectDelay = 2000;

function wsSubscribe(fhSym) {
  if (!ws || ws.readyState !== WebSocket.OPEN || wsSubscribed.has(fhSym)) return;
  ws.send(JSON.stringify({ type: "subscribe", symbol: fhSym }));
  wsSubscribed.add(fhSym);
}
function wsUnsubscribe(fhSym) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !wsSubscribed.has(fhSym)) return;
  ws.send(JSON.stringify({ type: "unsubscribe", symbol: fhSym }));
  wsSubscribed.delete(fhSym);
}
// Called whenever store.activeSymbols changes (see /api/report) so the feed
// tracks whatever the bot is trading/researching right now, live.
function wsSyncSubscriptions() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const want = new Set((store.activeSymbols || []).map(toFinnhubSymbol));
  for (const fhSym of want) if (!wsSubscribed.has(fhSym)) wsSubscribe(fhSym);
  for (const fhSym of Array.from(wsSubscribed)) if (!want.has(fhSym)) wsUnsubscribe(fhSym);
}

function connectFinnhubWs() {
  if (!FINNHUB_KEY) return;
  try {
    ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
  } catch (e) {
    lastQuoteError = `ws construct failed: ${e.message || e}`;
    return;
  }
  ws.on("open", () => {
    wsConnectedAt = new Date().toISOString();
    wsReconnectDelay = 2000;
    wsSubscribed = new Set();
    wsSyncSubscriptions();
    console.log("Finnhub websocket connected.");
  });
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== "trade" || !Array.isArray(msg.data)) return;
    for (const tick of msg.data) {
      const key = fromFinnhubSymbol(tick.s);
      if (typeof tick.p === "number") {
        wsTickCount++;
        recordAndSetQuote(key, { price: tick.p }, { live: true });
      }
    }
  });
  ws.on("error", (e) => { lastQuoteError = `ws error: ${e.message || e}`; });
  ws.on("close", () => {
    wsConnectedAt = null;
    ws = null;
    setTimeout(connectFinnhubWs, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.6, 30_000);
  });
}
connectFinnhubWs();
// Belt-and-suspenders resync in case a subscribe call landed while the
// socket was mid-reconnect and got silently dropped.
setInterval(wsSyncSubscriptions, 15_000);

// ===========================================================================
// Viewer-facing endpoints (Basic auth)
// ===========================================================================
app.use(basicAuth({ users: { [DASHBOARD_USER]: DASHBOARD_PASSWORD }, challenge: true, realm: "friday-research-desk" }));

app.get("/api/state", (req, res) => res.json(store));
app.get("/api/quotes", (req, res) => res.json({
  quotes, at: new Date().toISOString(),
  wsConnected: !!(ws && ws.readyState === WebSocket.OPEN),
}));

// Viewer issues a remote-control command for the bot.
const COMMAND_TYPES = new Set(["close_position", "close_all", "halt", "pause_scanning", "resume_scanning", "set_risk"]);
app.post("/api/command", (req, res) => {
  const { type, params } = req.body || {};
  if (!COMMAND_TYPES.has(type)) return res.status(400).json({ error: "unknown command type" });
  const p = params || {};
  if (type === "close_position" && !/^[A-Z0-9.]{1,12}$/.test(String(p.symbol || ""))) return res.status(400).json({ error: "bad symbol" });
  if (type === "set_risk") {
    const v = Number(p.pct);
    // Ceiling matches risk_manager.py's set_risk_pct (raised for the
    // 2026-08-24 max-risk experiment) -- keep these two in sync.
    if (!isFinite(v) || v < 0.05 || v > 15.0) return res.status(400).json({ error: "risk pct must be 0.05-15.0" });
    p.pct = v;
  }
  const cmd = { id: crypto.randomUUID(), type, params: p, status: "pending", createdAt: new Date().toISOString() };
  store.commands.push(cmd);
  store.commands = store.commands.slice(-50);
  saveStore();
  res.json({ ok: true, command: cmd });
});
app.get("/api/command-log", (req, res) => res.json({ commands: store.commands.slice(-30).reverse() }));

// ---- Diagnostics ----------------------------------------------------------
app.get("/api/diag", async (req, res) => {
  const out = { keys: { finnhub: !!FINNHUB_KEY }, sources: {}, notes: [
    "Financials/fundamentals are intentionally not fetched here -- check the IBKR portal directly.",
    "Quotes are scoped to whatever the bot is currently trading/researching, not a hardcoded list.",
  ] };
  try {
    if (!FINNHUB_KEY) throw new Error("no FINNHUB_KEY set");
    await finnhub("/quote?symbol=AAPL");
    out.sources.finnhub = "OK";
  } catch (e) { out.sources.finnhub = String(e.message || e).slice(0, 120); }
  out.lastQuoteError = lastQuoteError;
  out.activeSymbols = store.activeSymbols;
  out.quotesCached = Object.keys(quotes).length;
  out.lastReportAt = store.lastReportAt;
  out.ws = { connectedAt: wsConnectedAt, subscribed: Array.from(wsSubscribed), tickCount: wsTickCount };
  res.json(out);
});

app.use(express.static(path.join(__dirname, "public")));
app.listen(PORT, () => console.log(`FRIDAY research desk listening on port ${PORT}`));
