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
let lastHeldKey = null;           // held-position fingerprint; drives intel re-ranking (see /api/report)

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

  // News relevance is scored against what's actually held, so a change in the
  // book has to re-rank immediately -- otherwise a fresh position waits up to
  // a minute before its currency's events get their exposure weighting. Keyed
  // on the held set so the common case (unchanged positions, a report every
  // few seconds) costs one string compare.
  const heldKey = (store.latest.positions || []).map(p => p.symbol).sort().join(",");
  if (heldKey !== lastHeldKey) {
    lastHeldKey = heldKey;
    refreshIntelCache();
    if (intelCache) sseBroadcast("intel", intelCache);
  }

  saveStore();
  // Push the fresh snapshot straight out to every open dashboard rather than
  // making them wait for their next poll.
  sseBroadcast("state", store);
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
let quotesDirty = false; // set on every tick; drained by the SSE push loop below
function recordAndSetQuote(key, q, opts = {}) {
  quotes[key] = { ...quotes[key], ...q, t: new Date().toISOString(), live: !!opts.live };
  if (typeof q.price === "number") {
    const arr = priceHistory[key] || (priceHistory[key] = []);
    arr.push({ t: Date.now(), price: q.price });
    if (arr.length > MAX_HISTORY_POINTS) arr.splice(0, arr.length - MAX_HISTORY_POINTS);
    quotes[key].spark = arr.slice(-60).map(p => p.price);
  }
  quotesDirty = true;
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

// ---- Server-Sent Events: push, don't poll -------------------------------
// The browser used to poll /api/state and /api/quotes on a timer, which puts
// a floor under how stale the numbers can be. This streams instead: a new
// bot report or a new Finnhub tick is written to every open browser the
// moment it lands, so position P&L moves as fast as the data actually
// arrives rather than as fast as a setInterval fires.
const sseClients = new Set();

function sseSend(client, event, data) {
  try { client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  catch { sseClients.delete(client); }
}
function sseBroadcast(event, data) {
  for (const c of Array.from(sseClients)) sseSend(c, event, data);
}
function quotesPayload() {
  return { quotes, at: new Date().toISOString(), wsConnected: !!(ws && ws.readyState === WebSocket.OPEN) };
}

app.get("/api/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // stop any proxy from buffering the stream
  });
  res.flushHeaders();
  res.write("retry: 3000\n\n");

  const client = { res };
  sseClients.add(client);
  // Prime the new connection so it renders immediately instead of waiting
  // for the next report/tick.
  sseSend(client, "state", store);
  sseSend(client, "quotes", quotesPayload());
  if (intelCache) sseSend(client, "intel", intelCache);

  const hb = setInterval(() => {
    try { res.write(": hb\n\n"); } catch { /* closed */ }
  }, 25_000);

  req.on("close", () => { clearInterval(hb); sseClients.delete(client); });
});

// Quote ticks can arrive many times a second per symbol; coalesce them into
// at most one push every 200ms so a busy market can't flood the browser.
setInterval(() => {
  if (!quotesDirty || !sseClients.size) return;
  quotesDirty = false;
  sseBroadcast("quotes", quotesPayload());
}, 200);

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

// ===========================================================================
// FRIDAY -- the conversational layer over the bot's live state.
//
// Two paths on purpose:
//   * With ANTHROPIC_API_KEY set, questions go to Claude with a full live
//     snapshot of the desk as context -- that's what handles slang, follow-ups
//     and open-ended "what are you thinking" style questions.
//   * Without a key, a deterministic responder answers the factual questions
//     (positions, stops, targets, P&L, why nothing is trading). Those answers
//     are read straight off the same state the screen is drawing, so they're
//     exact -- worth keeping even when the model is available as the fallback
//     if the API call fails.
// ===========================================================================
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const FRIDAY_MODEL = process.env.FRIDAY_MODEL || "claude-sonnet-4-5";

const SYMBOL_VENUE = {
  AAPL: "NASDAQ (New York)", MSFT: "NASDAQ (New York)", NVDA: "NASDAQ (New York)",
  AMZN: "NASDAQ (New York)", GOOGL: "NASDAQ (New York)", META: "NASDAQ (New York)",
  QQQ: "NASDAQ (New York)", SPY: "NYSE Arca (New York)",
  "EUR.USD": "Frankfurt", "GBP.USD": "London", "USD.JPY": "Tokyo",
  "USD.CHF": "Zurich", "AUD.USD": "Sydney", "USD.CAD": "Toronto", "NZD.USD": "Wellington",
};

function livePriceFor(sym) {
  const q = quotes[sym];
  return q && typeof q.price === "number" ? q.price : null;
}

// One structured view of the desk, shared by both the model path and the
// deterministic path so they can never describe different worlds.
function buildDeskState() {
  const l = store.latest || {};
  const trades = store.recentTrades || [];
  const lastOpened = {};
  for (const t of trades) {
    if (t.status !== "opened") continue;
    const prev = lastOpened[t.symbol];
    if (!prev || new Date(t.t) > new Date(prev.t)) lastOpened[t.symbol] = t;
  }

  let totalUnrealized = 0, haveAny = false;
  const positions = (l.positions || []).map(p => {
    const last = livePriceFor(p.symbol) ?? p.marketPrice;
    const qty = p.quantity, absQty = Math.abs(qty);
    const pnl = (typeof p.avgCost === "number" && typeof last === "number")
      ? (last - p.avgCost) * qty : p.unrealizedPnl;
    if (typeof pnl === "number" && isFinite(pnl)) { totalUnrealized += pnl; haveAny = true; }
    const o = lastOpened[p.symbol] || {};
    const cost = typeof p.avgCost === "number" ? p.avgCost * absQty : null;
    return {
      symbol: p.symbol, name: p.display || p.symbol,
      side: qty >= 0 ? "LONG" : "SHORT", quantity: absQty,
      avgCost: p.avgCost, lastPrice: last,
      unrealizedPnl: pnl,
      unrealizedPct: cost ? (pnl / cost) * 100 : null,
      stopLoss: o.stop ?? null, target: o.target ?? null,
      entryPrice: o.entry ?? null, openedAt: o.t ?? null,
      venue: SYMBOL_VENUE[p.symbol] || "SMART routing",
      assetClass: p.secType === "CASH" ? "forex" : "equity",
    };
  });

  const research = (l.researchLog || []).map(r => ({
    symbol: r.symbol, decision: r.decision, reason: r.reason,
    price: r.price ?? null,
    signals: (r.signals || []).map(s => `${s.name}=${s.direction} (${s.reason})`),
  }));
  const decisionCounts = research.reduce((acc, r) => {
    acc[r.decision] = (acc[r.decision] || 0) + 1; return acc;
  }, {});

  return {
    account: {
      id: l.accountId, mode: l.mode, connected: !!l.connected,
      equity: l.netLiquidation ?? null,
      unrealizedPnlLive: haveAny ? totalUnrealized : (l.unrealizedPnl ?? null),
      realizedPnlToday: l.realizedPnlToday ?? null,
      riskPerTradePct: l.riskPerTradePct ?? null,
      scanningPaused: !!l.scanningPaused,
      killSwitchTripped: !!l.killSwitchTripped,
      dailyHalted: !!l.dailyHalted,
      stockMarketOpen: !!l.withinStockTradingWindow,
      forexMarketOpen: !!l.withinForexTradingWindow,
      lastReportAt: store.lastReportAt,
    },
    positions,
    positionCount: positions.length,
    lastScan: { at: l.botTimestamp || l.receivedAt || null, instruments: research.length, decisionCounts },
    research,
    recentTrades: trades.slice(-15).reverse().map(t => ({
      time: t.t, symbol: t.symbol, direction: t.direction, status: t.status,
      quantity: t.quantity, entry: t.entry, stop: t.stop, target: t.target, reason: t.reason,
    })),
    marketIntel: (() => {
      const c = intelCache;
      if (!c) return { available: false };
      const fmtWhen = ms => {
        const d = (ms - Date.now()) / 60000;
        if (d >= 0) return d < 60 ? `in ${Math.round(d)}m` : `in ${(d/60).toFixed(1)}h`;
        return -d < 60 ? `${Math.round(-d)}m ago` : `${(-d/60).toFixed(1)}h ago`;
      };
      return {
        available: true,
        nextHighImpactEvent: c.nextHigh ? {
          title: c.nextHigh.title, currency: c.nextHigh.currency,
          when: fmtWhen(c.nextHigh.at), forecast: c.nextHigh.forecast, previous: c.nextHigh.previous,
        } : null,
        upcomingEvents: c.events.filter(e => e.at >= Date.now()).slice(0, 10).map(e => ({
          title: e.title, currency: e.currency, impact: e.impact, when: fmtWhen(e.at),
          forecast: e.forecast, previous: e.previous, actual: e.actual,
        })),
        topHeadlines: c.news.slice(0, 12).map(n => ({
          title: n.title, impact: n.impact, source: n.source,
          when: fmtWhen(n.at), relevanceScore: n.score, about: n.related || null,
        })),
      };
    })(),
  };
}

const money = n => (typeof n === "number" && isFinite(n))
  ? (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : "n/a";

// Deterministic answers, straight off buildDeskState(). Intentionally keyword
// driven rather than clever -- it only has to cover the factual questions.
function fridayFallback(question, d) {
  const q = (question || "").toLowerCase();
  const has = (...ws) => ws.some(w => q.includes(w));
  const a = d.account;

  if (!store.latest) return "I haven't had a report from the bot yet, so I can't see the desk. Check that it's running.";

  if (has("stop", "target", "tp", "sl")) {
    if (!d.positions.length) return "Nothing is open right now, so there are no stops or targets working.";
    return "Working stops and targets:\n" + d.positions.map(p =>
      `• ${p.name} ${p.side} ${p.quantity} — stop ${p.stopLoss ?? "n/a"}, target ${p.target ?? "n/a"} (last ${p.lastPrice ?? "n/a"})`
    ).join("\n");
  }
  if (has("position", "holding", "open", "what am i in", "portfolio")) {
    if (!d.positions.length) return "Flat — no open positions.";
    return `${d.positionCount} open:\n` + d.positions.map(p =>
      `• ${p.name} ${p.side} ${p.quantity} @ ${p.avgCost?.toFixed?.(4) ?? "?"} — now ${p.lastPrice ?? "?"}, P&L ${money(p.unrealizedPnl)} (${p.unrealizedPct != null ? p.unrealizedPct.toFixed(2) + "%" : "?"}) via ${p.venue}`
    ).join("\n");
  }
  if (has("p&l", "pnl", "profit", "loss", "how am i doing", "made", "up or down", "money")) {
    return `Equity ${money(a.equity)}. Unrealized ${money(a.unrealizedPnlLive)}, realized today ${money(a.realizedPnlToday)}, across ${d.positionCount} positions.`;
  }
  if (has("why", "no trade", "not trading", "nothing happening", "idle")) {
    const held = d.lastScan.decisionCounts.holding || 0;
    if (a.killSwitchTripped) return "Kill-switch is tripped — max drawdown was hit. No new trades until the bot is restarted.";
    if (a.dailyHalted) return "Daily loss limit was hit, so no new entries until tomorrow.";
    if (a.scanningPaused) return "Scanning is paused — hit RESUME SCANNING and it'll start looking again.";
    if (held && held === d.lastScan.instruments) return `Every one of the ${held} instruments in the universe already has a position, so there's nothing left to buy. A stop or target has to close something before it can open anything new.`;
    if (!a.stockMarketOpen && !a.forexMarketOpen) return "Both the stock and forex windows are closed right now, so it's only monitoring.";
    return `Last scan looked at ${d.lastScan.instruments} instruments: ${JSON.stringify(d.lastScan.decisionCounts)}. Nothing cleared the confluence threshold.`;
  }
  if (has("risk", "size", "how much")) {
    return `Risking ${a.riskPerTradePct}% of equity per trade. Kill-switch ${a.killSwitchTripped ? "TRIPPED" : "clear"}, daily halt ${a.dailyHalted ? "ON" : "off"}, scanning ${a.scanningPaused ? "PAUSED" : "running"}.`;
  }
  if (has("thinking", "doing", "research", "scan", "signal", "looking")) {
    const top = d.research.slice(0, 6).map(r => `• ${r.symbol}: ${r.decision} — ${r.reason}`).join("\n");
    return `Last scan covered ${d.lastScan.instruments} instruments.\n${top}`;
  }
  if (has("trade", "bought", "sold", "recent", "fill")) {
    if (!d.recentTrades.length) return "No trades logged yet.";
    return "Most recent:\n" + d.recentTrades.slice(0, 6).map(t =>
      `• ${t.status} ${t.direction || ""} ${t.symbol} qty ${t.quantity ?? "?"} @ ${t.entry ?? "?"} (stop ${t.stop ?? "?"} / tgt ${t.target ?? "?"})`
    ).join("\n");
  }
  if (has("news", "headline", "calendar", "event", "data release", "happening", "cpi", "fomc", "nfp", "payroll")) {
    const mi = d.marketIntel || {};
    if (!mi.available) return "The news feed hasn't loaded yet — give it a minute.";
    const parts = [];
    if (mi.nextHighImpactEvent) {
      const e = mi.nextHighImpactEvent;
      parts.push(`Next high-impact: ${e.currency} ${e.title} ${e.when}` +
        (e.forecast ? ` (forecast ${e.forecast}, prev ${e.previous ?? "n/a"})` : ""));
    }
    if (mi.upcomingEvents?.length) {
      parts.push("Coming up:\n" + mi.upcomingEvents.slice(0, 5).map(e =>
        `• [${e.impact}] ${e.currency} ${e.title} — ${e.when}`).join("\n"));
    }
    if (mi.topHeadlines?.length) {
      parts.push("Top headlines by relevance to your book:\n" + mi.topHeadlines.slice(0, 5).map(n =>
        `• [${n.impact}] ${n.title}${n.about ? ` (${n.about})` : ""} — ${n.when}`).join("\n"));
    }
    return parts.join("\n\n") || "Nothing notable on the wire right now.";
  }
  if (has("hi", "hey", "hello", "yo", "sup", "you there")) {
    return `Here. ${a.connected ? "Connected" : "Disconnected"}, ${d.positionCount} positions open, equity ${money(a.equity)}, unrealized ${money(a.unrealizedPnlLive)}. What do you want to know?`;
  }
  return `I can tell you about positions, stops and targets, P&L, recent trades, what the last scan found, or why nothing is trading. Right now: ${d.positionCount} open, equity ${money(a.equity)}, unrealized ${money(a.unrealizedPnlLive)}.`;
}

const FRIDAY_SYSTEM = `You are FRIDAY, the operator of an automated trading desk. You are talking to the desk's owner through a live dashboard.

You will be given a JSON snapshot of the desk's real current state before each question. Answer ONLY from that snapshot. Never invent a number, a position, a stop, or a fill. If something isn't in the snapshot, say you can't see it.

Voice: sharp, warm, concise. Like a trusted colleague on the desk, not a chatbot. Understand casual speech and slang and reply in kind. Skip pleasantries unless greeted. Never use bullet lists longer than the answer needs. Use plain numbers with $ and % - the owner reads them at a glance.

Important context:
- This is a PAPER trading account. Nothing here is real money.
- You describe and explain what the bot is doing. You do NOT give investment advice or opinions on whether something is a good trade. If asked for a market call or advice, say plainly that's not your job and redirect to what the bot is actually doing.
- The strategy is a confluence-of-signals engine: several signals vote bull/bear/neutral per instrument, and a trade only fires when enough agree. Signals include market structure, support/resistance, candlestick patterns, volume, a trend filter, RSI momentum, and a long-term historical regime read.
- Every entry goes out as a bracket order, so each position carries its own stop and target from the moment it opens.
- The snapshot includes marketIntel: the economic calendar (Forex Factory High/Medium/Low impact grading) and ranked headlines. Relevance scores are computed against this desk's actual exposure, so a high-scoring item is one that touches a currency or symbol currently held. When asked about news or what's coming, lead with the highest-impact item that touches the book, and say plainly when something does NOT affect current positions.
- The bot itself does NOT read news; it trades purely off price-action signals. If asked whether it will react to a headline, be clear that it won't - news context is for the owner's judgement, not an input to the strategy.

If the owner asks you to DO something (pause scanning, resume, halt the bot, close a position, close everything, change risk %), do not claim you did it. Instead end your reply with a directive on its own final line, exactly:
[[ACTION:pause_scanning]] or [[ACTION:resume_scanning]] or [[ACTION:halt]] or [[ACTION:close_all]] or [[ACTION:close_position:SYMBOL]] or [[ACTION:set_risk:NUMBER]]
The dashboard turns that into a confirm button the owner must click. Mention that they'll need to confirm it.`;

app.post("/api/friday/chat", async (req, res) => {
  const { messages } = req.body || {};
  const history = Array.isArray(messages) ? messages.slice(-12) : [];
  const question = history.length ? String(history[history.length - 1].content || "") : "";
  const desk = buildDeskState();

  if (!ANTHROPIC_API_KEY) {
    return res.json({ reply: fridayFallback(question, desk), engine: "builtin" });
  }
  try {
    const convo = history.map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 4000),
    }));
    // Attach the live snapshot to the newest user turn so the model always
    // reasons over current numbers rather than whatever was true earlier.
    if (convo.length) {
      const i = convo.length - 1;
      convo[i] = { ...convo[i],
        content: `<desk_state>\n${JSON.stringify(desk)}\n</desk_state>\n\n${convo[i].content}` };
    }
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: FRIDAY_MODEL, max_tokens: 900,
        system: FRIDAY_SYSTEM, messages: convo,
      }),
    });
    const j = await r.json();
    if (!r.ok) {
      const detail = j?.error?.message || `HTTP ${r.status}`;
      return res.json({ reply: fridayFallback(question, desk), engine: "builtin", warning: `Claude API: ${detail}` });
    }
    const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
    res.json({ reply: text || fridayFallback(question, desk), engine: "claude" });
  } catch (e) {
    res.json({ reply: fridayFallback(question, desk), engine: "builtin", warning: String(e.message || e) });
  }
});

// Everything FRIDAY knows, also exposed directly (handy for debugging).
app.get("/api/friday/state", (req, res) => res.json(buildDeskState()));

// ===========================================================================
// Market intelligence -- economic calendar + ranked news, scored against
// this desk's real exposure. See market_intel.js.
// ===========================================================================
const { createMarketIntel } = require("./market_intel");
const intel = createMarketIntel({
  finnhub,
  getActiveSymbols: () => store.activeSymbols || [],
  getHeldSymbols: () => ((store.latest && store.latest.positions) || []).map(p => p.symbol),
  log: console,
});

let intelCache = null;
function refreshIntelCache() {
  try { intelCache = intel.ranked(); } catch (e) { console.warn("intel rank failed:", e.message); }
}
async function intelCycle(which) {
  try {
    if (which === "calendar") await intel.refreshCalendar();
    else if (which === "news") await intel.refreshNews();
    else await intel.refreshAll();
  } catch (e) { console.warn("intel refresh failed:", e.message); }
  refreshIntelCache();
  sseBroadcast("intel", intelCache);
}
// The calendar is a weekly file -- no point hammering it. News moves faster.
setInterval(() => intelCycle("calendar"), 15 * 60_000);
setInterval(() => intelCycle("news"), 3 * 60_000);
// Re-rank on a shorter beat even without new data: scores are time-weighted,
// so an event's urgency climbs as it approaches.
setInterval(() => { refreshIntelCache(); sseBroadcast("intel", intelCache); }, 60_000);
setTimeout(() => intelCycle("all"), 2500);

app.get("/api/intel", (req, res) => {
  if (!intelCache) refreshIntelCache();
  res.json(intelCache || { top: [], events: [], news: [], pins: [], nextHigh: null, meta: {} });
});
app.get("/api/intel/diag", (req, res) => res.json(intel.diag()));
app.post("/api/intel/refresh", async (req, res) => { await intelCycle("all"); res.json({ ok: true, meta: intelCache?.meta }); });

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
