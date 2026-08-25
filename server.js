// FRIDAY terminal server.
//
// Roles & secrets:
//   - The BOT posts snapshots to  POST /api/report    (Bearer REPORT_TOKEN)
//     and polls commands at       GET  /api/commands  (Bearer REPORT_TOKEN)
//   - YOU view the terminal at    GET  /              (Basic auth DASHBOARD_USER/PASSWORD)
//
// Market data comes from several sources, each fail-soft with caching and
// rate budgeting. Set FINNHUB_KEY and FMP_KEY in the environment to unlock
// the good stuff (quotes, company news, fundamentals, candles, valuation);
// without them the terminal degrades to the keyless fallbacks.
//   Finnhub  (free: 60 req/min)  -> stock/ETF/FX quotes, company news,
//                                    metrics, analyst recs, profiles
//   FMP      (free: 250 req/day) -> candles, DCF valuation, treasury yields
//   Coinbase (keyless)           -> crypto quotes + candles
//   SEC EDGAR (keyless)          -> real filings (10-K, 10-Q, 8-K...)
//   Yahoo/stooq (keyless, flaky from datacenters) -> indices, commodities

const express = require("express");
const basicAuth = require("express-basic-auth");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Parser = require("rss-parser");

const PORT = process.env.PORT || 3000;
const REPORT_TOKEN = process.env.REPORT_TOKEN;
const DASHBOARD_USER = process.env.DASHBOARD_USER;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const FINNHUB_KEY = process.env.FINNHUB_KEY || "";
const FMP_KEY = process.env.FMP_KEY || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");

const MAX_EQUITY_POINTS = 3000;
const MAX_TRADES = 500;

for (const [name, val] of Object.entries({ REPORT_TOKEN, DASHBOARD_USER, DASHBOARD_PASSWORD })) {
  if (!val) {
    console.error(`Missing required environment variable: ${name}. Refusing to start.`);
    process.exit(1);
  }
}
if (!FINNHUB_KEY) console.warn("FINNHUB_KEY not set -- stock/FX quotes and company data will be degraded.");
if (!FMP_KEY) console.warn("FMP_KEY not set -- charts, valuation and yields will be degraded.");

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, "utf8")); }
  catch {
    return { latest: null, equityHistory: [], recentTrades: [], logTail: [], lastReportAt: null, commands: [] };
  }
}
let store = loadStore();
if (!Array.isArray(store.commands)) store.commands = [];
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
  if (Array.isArray(body.logTail)) store.logTail = body.logTail.slice(-300);
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
// News aggregation (server-side, cached)
// ===========================================================================
const NEWS_FEEDS = [
  { source: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex" },
  { source: "MarketWatch", url: "http://feeds.marketwatch.com/marketwatch/topstories/" },
  { source: "CNBC Top News", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
  { source: "CNBC Markets", url: "https://www.cnbc.com/id/15839069/device/rss/rss.html" },
  { source: "Google News · Markets", url: "https://news.google.com/rss/search?q=stock%20market%20OR%20federal%20reserve%20OR%20forex&hl=en-US&gl=US&ceid=US:en" },
  { source: "Google News · Commodities", url: "https://news.google.com/rss/search?q=oil%20prices%20OR%20gold%20price%20OR%20OPEC&hl=en-US&gl=US&ceid=US:en" },
];
let newsCache = [];
let newsUpdatedAt = null;
const newsParser = new Parser({ timeout: 9000 });
async function pollNews() {
  const results = await Promise.allSettled(NEWS_FEEDS.map(f => newsParser.parseURL(f.url)));
  const items = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    for (const e of (r.value.items || []).slice(0, 15)) {
      items.push({ source: NEWS_FEEDS[i].source, title: e.title || "", link: e.link || "",
        publishedAt: e.isoDate || e.pubDate || null });
    }
  });
  items.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  if (items.length) { newsCache = items.slice(0, 80); newsUpdatedAt = new Date().toISOString(); }
}
pollNews().catch(() => {});
setInterval(() => { pollNews().catch(() => {}); }, 150_000);

// ===========================================================================
// Data sources: rate-limited fetch helpers
// ===========================================================================
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "Accept": "application/json,text/*,*/*" };
const EDGAR_UA = { "User-Agent": "FRIDAY personal dashboard admin@example.com" };

// Finnhub: cap ~50/min
let fhWindow = [], fhBlockedUntil = 0;
async function finnhub(pathq) {
  if (!FINNHUB_KEY) throw new Error("no FINNHUB_KEY");
  const now = Date.now();
  if (now < fhBlockedUntil) throw new Error("finnhub cooling down (429)");
  fhWindow = fhWindow.filter(t => now - t < 60_000);
  if (fhWindow.length >= 50) throw new Error("finnhub local rate cap");
  fhWindow.push(now);
  const r = await fetch(`https://finnhub.io/api/v1${pathq}${pathq.includes("?") ? "&" : "?"}token=${FINNHUB_KEY}`,
    { headers: UA, signal: AbortSignal.timeout(7000) });
  if (r.status === 429) { fhBlockedUntil = Date.now() + 30_000; throw new Error("finnhub 429"); }
  if (!r.ok) throw new Error(`finnhub HTTP ${r.status}`);
  return r.json();
}

// FMP: budget ~220/day
let fmpCount = 0, fmpDay = new Date().toDateString();
let fmpIntradayBlocked = false; // set true after the first confirmed 403 on historical-chart (free plan is gated)
async function fmp(pathq) {
  if (!FMP_KEY) throw new Error("no FMP_KEY");
  const today = new Date().toDateString();
  if (today !== fmpDay) { fmpDay = today; fmpCount = 0; }
  if (fmpCount >= 220) throw new Error("fmp daily budget spent");
  fmpCount++;
  const r = await fetch(`https://financialmodelingprep.com/api${pathq}${pathq.includes("?") ? "&" : "?"}apikey=${FMP_KEY}`,
    { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`fmp HTTP ${r.status}`);
  return r.json();
}

// Coinbase Exchange (keyless, datacenter-friendly)
async function coinbase(pathq) {
  const r = await fetch(`https://api.exchange.coinbase.com${pathq}`, { headers: UA, signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error(`coinbase HTTP ${r.status}`);
  return r.json();
}

// Yahoo (flaky from datacenters -- cookie handshake + host fallback)
let yfAuth = { cookie: null, crumb: null, ts: 0 };
let lastYfErrLog = 0;
function logSrcError(src, msg) {
  if (Date.now() - lastYfErrLog > 60_000) { lastYfErrLog = Date.now(); console.error(`[${src}]`, msg); }
}
async function getYfAuth(force = false) {
  if (!force && yfAuth.cookie && Date.now() - yfAuth.ts < 4 * 3600_000) return yfAuth;
  const r1 = await fetch("https://fc.yahoo.com/", { headers: UA, redirect: "manual", signal: AbortSignal.timeout(7000) }).catch(() => null);
  let cookie = "";
  if (r1) {
    const sc = (typeof r1.headers.getSetCookie === "function") ? r1.headers.getSetCookie() : [r1.headers.get("set-cookie")].filter(Boolean);
    cookie = sc.map(c => String(c).split(";")[0]).join("; ");
  }
  if (!cookie) throw new Error("no yahoo cookie");
  let crumb = null;
  try {
    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb",
      { headers: { ...UA, Cookie: cookie }, signal: AbortSignal.timeout(7000) });
    const t = (await r2.text()).trim();
    if (r2.ok && t && !t.includes("<")) crumb = t;
  } catch {}
  yfAuth = { cookie, crumb, ts: Date.now() };
  return yfAuth;
}
async function yfChart(symbol, range, interval) {
  const p = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  let auth = null; try { auth = await getYfAuth(); } catch {}
  let lastErr = null;
  for (const attempt of [0, 1, 2]) {
    const host = attempt === 1 ? "query2.finance.yahoo.com" : "query1.finance.yahoo.com";
    const headers = { ...UA }; if (auth?.cookie) headers.Cookie = auth.cookie;
    let url = `https://${host}${p}`; if (auth?.crumb) url += `&crumb=${encodeURIComponent(auth.crumb)}`;
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(7000) });
      if ([401, 403, 429].includes(r.status)) {
        lastErr = new Error(`yahoo ${symbol}: HTTP ${r.status}`);
        if (attempt < 2) { try { auth = await getYfAuth(true); } catch {} continue; }
        throw lastErr;
      }
      if (!r.ok) throw new Error(`yahoo ${symbol}: HTTP ${r.status}`);
      const j = await r.json();
      const result = j?.chart?.result?.[0];
      if (!result) throw new Error(`yahoo ${symbol}: empty`);
      return result;
    } catch (e) { lastErr = e; if (attempt === 2) break; }
  }
  logSrcError("yahoo", String(lastErr?.message || lastErr));
  throw lastErr;
}

// stooq CSV (keyless, delayed, datacenter-friendly)
async function stooqQuote(sym) {
  const r = await fetch(`https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`,
    { headers: UA, signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error(`stooq HTTP ${r.status}`);
  const lines = (await r.text()).trim().split("\n");
  if (lines.length < 2) throw new Error("stooq empty");
  const f = lines[1].split(",");
  const open = parseFloat(f[3]), close = parseFloat(f[6]);
  if (!isFinite(close)) throw new Error("stooq n/d");
  return { price: close, prevClose: isFinite(open) ? open : null };
}

// ===========================================================================
// Quote engine: server-side pollers fill one cache; clients read the cache.
// ===========================================================================
// Broad, sector-diversified default watchlist. This is deliberately NOT
// "every US-listed equity" (6000+ tickers) -- there is no free quote feed
// that can poll that many names live without blowing through rate limits.
// Instead: a large curated set covering every major sector polls in the
// background (below), AND the command bar / GP / DES screens accept ANY
// valid ticker typed in and fetch it on demand (see runCommand() in
// index.html + classify() below) -- exactly how Bloomberg itself works:
// a bounded default monitor plus universal lookup-by-symbol.
const STOCKS = [
  // Technology
  "AAPL","MSFT","NVDA","GOOGL","AMZN","META","AVGO","ORCL","CRM","ADBE","AMD","INTC","CSCO","IBM","QCOM",
  // Financials
  "JPM","BAC","WFC","C","GS","MS","V","MA","AXP","BRK.B",
  // Healthcare
  "UNH","JNJ","LLY","PFE","ABBV","MRK","TMO","ABT",
  // Consumer discretionary
  "TSLA","HD","NKE","MCD","SBUX","BKNG","LOW","TGT",
  // Consumer staples
  "WMT","PG","KO","PEP","COST","PM",
  // Industrials
  "BA","CAT","GE","HON","UPS","RTX","DE",
  // Energy
  "XOM","CVX","COP","SLB","EOG",
  // Communication services
  "NFLX","DIS","CMCSA","T","VZ",
  // Materials / Utilities / Real estate
  "LIN","FCX","NEM","NEE","DUK","PLD","AMT",
  // Broad index ETFs
  "SPY","QQQ","DIA","IWM","VTI",
];
// Majors + the common retail cross pairs -- effectively "all forex" for a
// spot-FX terminal (exotics are on-demand via the command bar).
const FX = [
  ["EURUSD","OANDA:EUR_USD","EURUSD=X"], ["GBPUSD","OANDA:GBP_USD","GBPUSD=X"],
  ["USDJPY","OANDA:USD_JPY","USDJPY=X"], ["USDCHF","OANDA:USD_CHF","USDCHF=X"],
  ["AUDUSD","OANDA:AUD_USD","AUDUSD=X"], ["USDCAD","OANDA:USD_CAD","USDCAD=X"],
  ["NZDUSD","OANDA:NZD_USD","NZDUSD=X"],
  ["EURGBP","OANDA:EUR_GBP","EURGBP=X"], ["EURJPY","OANDA:EUR_JPY","EURJPY=X"],
  ["EURCHF","OANDA:EUR_CHF","EURCHF=X"], ["EURAUD","OANDA:EUR_AUD","EURAUD=X"],
  ["EURCAD","OANDA:EUR_CAD","EURCAD=X"], ["EURNZD","OANDA:EUR_NZD","EURNZD=X"],
  ["GBPJPY","OANDA:GBP_JPY","GBPJPY=X"], ["GBPCHF","OANDA:GBP_CHF","GBPCHF=X"],
  ["GBPAUD","OANDA:GBP_AUD","GBPAUD=X"], ["GBPCAD","OANDA:GBP_CAD","GBPCAD=X"],
  ["GBPNZD","OANDA:GBP_NZD","GBPNZD=X"], ["AUDJPY","OANDA:AUD_JPY","AUDJPY=X"],
  ["AUDNZD","OANDA:AUD_NZD","AUDNZD=X"], ["AUDCAD","OANDA:AUD_CAD","AUDCAD=X"],
  ["AUDCHF","OANDA:AUD_CHF","AUDCHF=X"], ["CADJPY","OANDA:CAD_JPY","CADJPY=X"],
  ["CHFJPY","OANDA:CHF_JPY","CHFJPY=X"],
];
const CRYPTO = [["BTC","BTC-USD"],["ETH","ETH-USD"],["SOL","SOL-USD"],["XRP","XRP-USD"],["DOGE","DOGE-USD"],["ADA","ADA-USD"]];
const YAHOO_MISC = [
  // US indices
  ["SPX","^GSPC","S&P 500"], ["NDX","^IXIC","NASDAQ Comp"], ["NDX100","^NDX","NASDAQ 100"],
  ["DJI","^DJI","Dow Jones"], ["RUT","^RUT","Russell 2000"], ["SOX","^SOX","Philly Semiconductor"],
  ["VIX","^VIX","CBOE Volatility"], ["DXY","DX-Y.NYB","US Dollar Index"],
  // Global indices
  ["FTSE","^FTSE","FTSE 100"], ["DAX","^GDAXI","DAX"], ["CAC","^FCHI","CAC 40"],
  ["NIKKEI","^N225","Nikkei 225"], ["HSI","^HSI","Hang Seng"], ["SSEC","000001.SS","Shanghai Comp"],
  ["SENSEX","^BSESN","BSE Sensex"],
  // Commodities
  ["WTI","CL=F","Crude Oil WTI"], ["BRENT","BZ=F","Brent Crude"], ["GOLD","GC=F","Gold"],
  ["SILVER","SI=F","Silver"], ["NATGAS","NG=F","Natural Gas"], ["COPPER","HG=F","Copper"],
];
const STOOQ_FALLBACK = { SPX: "^spx", DJI: "^dji", NDX: "^ndq", WTI: "cl.f", BRENT: "cb.f", GOLD: "gc.f", SILVER: "si.f", NATGAS: "ng.f", DXY: "dx.f" };

const quotes = {};   // id -> {price, change, changePct, prevClose, spark, name, t, src}
function setQuote(id, q) { quotes[id] = { ...quotes[id], ...q, t: new Date().toISOString() }; }

// Both watchlists are now too large to poll in full every tick without
// blowing Finnhub's free 60/min limit, so each poller only advances through
// a rotating batch per call -- the full list still cycles every couple of
// minutes, it's just spread out instead of firing 90+ requests at once.
function makeCursor(size) { let i = 0; return () => { const s = i; i = (i + 1) % size; return s; }; }
const stockCursor = makeCursor(STOCKS.length);
const fxCursor = makeCursor(FX.length);
const STOCK_BATCH = 6, FX_BATCH = 5;

async function pollFinnhubStocks() {
  const start = stockCursor();
  for (let k = 0; k < Math.min(STOCK_BATCH, STOCKS.length); k++) {
    const sym = STOCKS[(start + k) % STOCKS.length];
    try {
      const q = await finnhub(`/quote?symbol=${sym}`);
      if (typeof q.c === "number" && q.c > 0)
        setQuote(sym, { price: q.c, change: q.d, changePct: q.dp, prevClose: q.pc, dayHigh: q.h, dayLow: q.l, src: "finnhub" });
    } catch (e) { logSrcError("finnhub", String(e.message || e)); }
  }
}
async function pollFinnhubFx() {
  const start = fxCursor();
  for (let k = 0; k < Math.min(FX_BATCH, FX.length); k++) {
    const [id, fhSym] = FX[(start + k) % FX.length];
    try {
      const q = await finnhub(`/quote?symbol=${encodeURIComponent(fhSym)}`);
      if (typeof q.c === "number" && q.c > 0)
        setQuote(id, { price: q.c, change: q.d, changePct: q.dp, prevClose: q.pc, src: "finnhub" });
    } catch { /* fall through to yahoo poller */ }
  }
}
async function pollCoinbase() {
  for (const [id, product] of CRYPTO) {
    try {
      const [tick, stats] = await Promise.all([coinbase(`/products/${product}/ticker`), coinbase(`/products/${product}/stats`)]);
      const price = parseFloat(tick.price), open = parseFloat(stats.open);
      if (isFinite(price))
        setQuote(id, { price, prevClose: isFinite(open) ? open : null,
          change: isFinite(open) ? price - open : null,
          changePct: isFinite(open) && open ? (price - open) / open * 100 : null,
          dayHigh: parseFloat(stats.high) || null, dayLow: parseFloat(stats.low) || null, src: "coinbase" });
    } catch (e) { logSrcError("coinbase", String(e.message || e)); }
  }
}
async function pollYahooMisc() {
  for (const [id, ysym, name] of YAHOO_MISC) {
    try {
      const result = await yfChart(ysym, "1d", "5m");
      const meta = result.meta || {};
      const closes = (result.indicators?.quote?.[0]?.close || []).filter(v => typeof v === "number");
      const prev = meta.chartPreviousClose ?? meta.previousClose;
      if (typeof meta.regularMarketPrice === "number")
        setQuote(id, { price: meta.regularMarketPrice, prevClose: prev,
          change: typeof prev === "number" ? meta.regularMarketPrice - prev : null,
          changePct: typeof prev === "number" && prev ? (meta.regularMarketPrice - prev) / prev * 100 : null,
          spark: closes.slice(-64), name, src: "yahoo" });
    } catch {
      const st = STOOQ_FALLBACK[id];
      if (st) {
        try {
          const q = await stooqQuote(st);
          setQuote(id, { price: q.price, prevClose: q.prevClose,
            change: q.prevClose ? q.price - q.prevClose : null,
            changePct: q.prevClose ? (q.price - q.prevClose) / q.prevClose * 100 : null, name, src: "stooq" });
        } catch (e2) { logSrcError("stooq", String(e2.message || e2)); }
      }
    }
    // also seed FX from yahoo if finnhub hasn't filled them
  }
  for (const [id, , ysym] of FX) {
    if (quotes[id] && Date.now() - new Date(quotes[id].t).getTime() < 120_000) continue;
    try {
      const result = await yfChart(ysym, "1d", "5m");
      const meta = result.meta || {};
      const prev = meta.chartPreviousClose ?? meta.previousClose;
      if (typeof meta.regularMarketPrice === "number")
        setQuote(id, { price: meta.regularMarketPrice, prevClose: prev,
          change: typeof prev === "number" ? meta.regularMarketPrice - prev : null,
          changePct: typeof prev === "number" && prev ? (meta.regularMarketPrice - prev) / prev * 100 : null, src: "yahoo" });
    } catch {}
  }
}
// Yahoo's chart API and the stooq CSV fallback both fail persistently from
// Render's datacenter IP for cash-index symbols (^GSPC, ^DJI, etc. -- 429s),
// even though the same code works fine for futures/ETF tickers. Rather than
// leave these permanently blank, fall back to a highly-liquid, US-listed ETF
// that tracks the same market and is reachable via Finnhub (which is
// reliable). We deliberately do NOT scale the ETF's price into a fake index
// level -- that would fabricate a number that looks like the real index but
// isn't, which is dangerous on a live trading terminal. Instead we show the
// ETF's own price/change/%change (the %change is what actually matters for
// a terminal and tracks the real index closely) and mark the source as
// "proxy:<ETF>" so the UI can flag it as approximate rather than authoritative.
const INDEX_PROXY = {
  SPX: "SPY", NDX: "QQQ", NDX100: "QQQ", DJI: "DIA", RUT: "IWM", SOX: "SOXX", DXY: "UUP",
  FTSE: "EWU", DAX: "EWG", CAC: "EWQ", NIKKEI: "EWJ", HSI: "EWH", SSEC: "MCHI", SENSEX: "INDA",
};
async function pollIndexProxies() {
  const now = Date.now();
  for (const [id, etf] of Object.entries(INDEX_PROXY)) {
    const q = quotes[id];
    // Skip if we already have a fresh REAL (non-proxy) quote for this id --
    // never let the approximate proxy clobber a working Yahoo/stooq value.
    if (q && !String(q.src || "").startsWith("proxy:") && now - new Date(q.t).getTime() < 10 * 60_000) continue;
    try {
      const fq = await finnhub(`/quote?symbol=${etf}`);
      if (typeof fq.c === "number" && fq.c > 0)
        setQuote(id, { price: fq.c, change: fq.d, changePct: fq.dp, prevClose: fq.pc, dayHigh: fq.h, dayLow: fq.l, src: `proxy:${etf}` });
    } catch (e) { logSrcError("finnhub", String(e.message || e)); }
  }
}
async function pollTreasury() {
  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    const j = await fmp(`/v4/treasury?from=${from}&to=${to}`);
    const row = Array.isArray(j) ? j[0] : null;
    if (row) {
      const prevRow = Array.isArray(j) && j[1] ? j[1] : null;
      const mk = (id, cur, prev, name) => {
        if (typeof cur !== "number") return;
        setQuote(id, { price: cur, prevClose: prev ?? null, change: typeof prev === "number" ? cur - prev : null,
          changePct: typeof prev === "number" && prev ? (cur - prev) / prev * 100 : null, name, src: "fmp", unit: "%" });
      };
      mk("US10Y", row.year10, prevRow?.year10, "US 10Y Yield");
      mk("US02Y", row.year2, prevRow?.year2, "US 2Y Yield");
      mk("US30Y", row.year30, prevRow?.year30, "US 30Y Yield");
    }
  } catch (e) { logSrcError("fmp", String(e.message || e)); }
}

setInterval(() => { pollFinnhubStocks().catch(() => {}); }, 15_000);
setInterval(() => { pollFinnhubFx().catch(() => {}); }, 20_000);
setInterval(() => { pollCoinbase().catch(() => {}); }, 15_000);
setInterval(() => { pollYahooMisc().catch(() => {}); }, 60_000);
setInterval(() => { pollIndexProxies().catch(() => {}); }, 30_000);
setInterval(() => { pollTreasury().catch(() => {}); }, 3600_000);
pollFinnhubStocks().catch(() => {}); pollFinnhubFx().catch(() => {});
pollCoinbase().catch(() => {}); pollYahooMisc().catch(() => {}); pollTreasury().catch(() => {});
pollIndexProxies().catch(() => {});

// ===========================================================================
// Analysis helpers (bias engine)
// ===========================================================================
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  if (g + l === 0) return 50;
  const rs = (g / period) / ((l / period) || 1e-9);
  return 100 - 100 / (1 + rs);
}
function biasFromCloses(closes) {
  if (!closes || closes.length < 25) return { dir: "neutral", score: 0, notes: ["not enough data"] };
  const last = closes[closes.length - 1];
  const e20 = ema(closes, 20), e50 = ema(closes, Math.min(50, closes.length - 1));
  const r = rsi(closes);
  const lookback = Math.min(20, closes.length - 1);
  const prior = closes[closes.length - 1 - lookback];
  let score = 0; const notes = [];
  if (e20 && last > e20) { score += 25; notes.push("price above EMA20"); } else if (e20) { score -= 25; notes.push("price below EMA20"); }
  if (e50 && last > e50) { score += 25; notes.push("price above EMA50"); } else if (e50) { score -= 25; notes.push("price below EMA50"); }
  if (r != null) { if (r >= 55) { score += 25; notes.push(`RSI ${r.toFixed(0)} bullish`); } else if (r <= 45) { score -= 25; notes.push(`RSI ${r.toFixed(0)} bearish`); } else notes.push(`RSI ${r.toFixed(0)} neutral`); }
  const chg = (last - prior) / prior * 100;
  if (chg > 0.5) { score += 25; notes.push(`+${chg.toFixed(1)}% over period`); } else if (chg < -0.5) { score -= 25; notes.push(`${chg.toFixed(1)}% over period`); }
  const dir = score >= 25 ? "bullish" : score <= -25 ? "bearish" : "neutral";
  return { dir, score, notes };
}

// ===========================================================================
// Viewer-facing API (behind basic auth)
// ===========================================================================
app.use(basicAuth({ users: { [DASHBOARD_USER]: DASHBOARD_PASSWORD }, challenge: true, realm: "friday-terminal" }));

app.get("/api/state", (req, res) => res.json(store));
app.get("/api/news", (req, res) => res.json({ items: newsCache, updatedAt: newsUpdatedAt }));
app.get("/api/quotes", (req, res) => res.json({ quotes, at: new Date().toISOString() }));

// Viewer issues a remote-control command for the bot.
const COMMAND_TYPES = new Set(["close_position", "close_all", "halt", "pause_scanning", "resume_scanning", "set_risk"]);
app.post("/api/command", (req, res) => {
  const { type, params } = req.body || {};
  if (!COMMAND_TYPES.has(type)) return res.status(400).json({ error: "unknown command type" });
  const p = params || {};
  if (type === "close_position" && !/^[A-Z0-9.]{1,12}$/.test(String(p.symbol || ""))) return res.status(400).json({ error: "bad symbol" });
  if (type === "set_risk") {
    const v = Number(p.pct);
    if (!isFinite(v) || v < 0.05 || v > 2.0) return res.status(400).json({ error: "risk pct must be 0.05-2.0" });
    p.pct = v;
  }
  const cmd = { id: crypto.randomUUID(), type, params: p, status: "pending", createdAt: new Date().toISOString() };
  store.commands.push(cmd);
  store.commands = store.commands.slice(-50);
  saveStore();
  res.json({ ok: true, command: cmd });
});
app.get("/api/command-log", (req, res) => res.json({ commands: store.commands.slice(-30).reverse() }));

// ---- Charts -------------------------------------------------------------
const chartCache = new Map();
const CHART_TTL_INTRADAY = 45_000, CHART_TTL_DAILY = 15 * 60_000;
const CB_GRAN = { "1d": 300, "5d": 3600, "1mo": 21600, "6mo": 86400, "1y": 86400, "5y": 86400 };
const FMP_INTERVAL = { "1d": "5min", "5d": "30min", "1mo": "4hour" };
const YR = { "1d": ["1d", "5m"], "5d": ["5d", "15m"], "1mo": ["1mo", "1h"], "6mo": ["6mo", "1d"], "1y": ["1y", "1d"], "5y": ["5y", "1wk"] };

function classify(id) {
  if (CRYPTO.some(c => c[0] === id)) return "crypto";
  if (FX.some(f => f[0] === id)) return "fx";
  if (STOCKS.includes(id)) return "stock";
  if (YAHOO_MISC.some(y => y[0] === id)) return "misc";
  if (["US10Y", "US02Y", "US30Y"].includes(id)) return "yield";
  return "stock"; // free-typed tickers
}

app.get("/api/chart", async (req, res) => {
  const id = String(req.query.id || "").toUpperCase();
  const range = String(req.query.range || "1d");
  if (!/^[A-Z0-9.^=\-]{1,12}$/.test(id) || !YR[range]) return res.status(400).json({ error: "bad id/range" });
  const key = id + "|" + range;
  const hit = chartCache.get(key);
  const ttl = ["1d", "5d"].includes(range) ? CHART_TTL_INTRADAY : CHART_TTL_DAILY;
  if (hit && Date.now() - hit.ts < ttl) return res.json(hit.data);

  const cls = classify(id);
  let candles = [];
  try {
    if (cls === "crypto") {
      const product = (CRYPTO.find(c => c[0] === id) || [])[1] || `${id}-USD`;
      const gran = CB_GRAN[range];
      const rows = await coinbase(`/products/${product}/candles?granularity=${gran}`);
      candles = rows.map(r => ({ t: r[0], o: r[3], h: r[2], l: r[1], c: r[4], v: r[5] })).reverse();
      if (range === "5y" || range === "1y" || range === "6mo") candles = candles.slice(-300);
    } else if (cls === "stock" || cls === "fx") {
      const fmpSym = cls === "fx" ? id : id;
      try {
        // The intraday historical-chart endpoint is gated on FMP's paid
        // plans -- once we've confirmed that with a real 403, stop wasting
        // daily-budget calls on it and go straight to the Yahoo fallback.
        if (FMP_INTERVAL[range] && fmpIntradayBlocked) {
          throw new Error("fmp intraday plan-gated, skipping to yahoo");
        } else if (FMP_INTERVAL[range]) {
          let rows;
          try {
            rows = await fmp(`/v3/historical-chart/${FMP_INTERVAL[range]}/${fmpSym}`);
          } catch (e) {
            if (String(e.message || e).includes("HTTP 403")) fmpIntradayBlocked = true;
            throw e;
          }
          candles = (rows || []).map(r => ({ t: Math.floor(new Date(r.date).getTime() / 1000), o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume || 0 })).reverse();
          if (range === "1d") {
            const cutoff = Date.now() / 1000 - 36 * 3600;
            const recent = candles.filter(c => c.t >= cutoff);
            if (recent.length > 10) candles = recent;
          }
        } else {
          const rows = await fmp(`/v3/historical-price-full/${fmpSym}?serietype=candle&timeseries=${range === "6mo" ? 130 : range === "1y" ? 260 : 1300}`);
          candles = ((rows || {}).historical || []).map(r => ({ t: Math.floor(new Date(r.date).getTime() / 1000), o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume || 0 })).reverse();
        }
        if (!candles.length) throw new Error("fmp empty");
      } catch {
        const [yr, yi] = YR[range];
        const ysym = cls === "fx" ? (FX.find(f => f[0] === id) || [])[2] : id;
        const result = await yfChart(ysym || id, yr, yi);
        const ts = result.timestamp || [], q = result.indicators?.quote?.[0] || {};
        for (let i = 0; i < ts.length; i++) {
          if ([q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]].some(v => typeof v !== "number")) continue;
          candles.push({ t: ts[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] ?? 0 });
        }
      }
    } else { // misc (indices/commodities) and yields -> yahoo only
      const ysym = (YAHOO_MISC.find(y => y[0] === id) || [])[1] || id;
      const [yr, yi] = YR[range];
      const result = await yfChart(ysym, yr, yi);
      const ts = result.timestamp || [], q = result.indicators?.quote?.[0] || {};
      for (let i = 0; i < ts.length; i++) {
        if ([q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]].some(v => typeof v !== "number")) continue;
        candles.push({ t: ts[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] ?? 0 });
      }
    }
    const data = { id, range, candles };
    chartCache.set(key, { ts: Date.now(), data });
    res.json(data);
  } catch (e) {
    if (hit) return res.json(hit.data);
    res.status(502).json({ error: String(e.message || e) });
  }
});

// ---- Instrument deep-dive ----------------------------------------------
const instCache = new Map();
const edgarTickers = { map: null, ts: 0 };
async function getCik(ticker) {
  if (!edgarTickers.map || Date.now() - edgarTickers.ts > 86400_000) {
    const r = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: EDGAR_UA, signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error(`edgar tickers HTTP ${r.status}`);
    const j = await r.json();
    const map = {};
    for (const k of Object.keys(j)) map[j[k].ticker.toUpperCase()] = { cik: j[k].cik_str, title: j[k].title };
    edgarTickers.map = map; edgarTickers.ts = Date.now();
  }
  return edgarTickers.map[ticker.toUpperCase()] || null;
}
async function edgarFilings(ticker) {
  const ent = await getCik(ticker);
  if (!ent) return [];
  const cik10 = String(ent.cik).padStart(10, "0");
  const r = await fetch(`https://data.sec.gov/submissions/CIK${cik10}.json`, { headers: EDGAR_UA, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error(`edgar submissions HTTP ${r.status}`);
  const j = await r.json();
  const rec = j.filings?.recent || {};
  const out = [];
  const want = new Set(["10-K", "10-Q", "8-K", "DEF 14A", "S-1", "20-F", "6-K"]);
  for (let i = 0; i < (rec.form || []).length && out.length < 12; i++) {
    if (!want.has(rec.form[i])) continue;
    const acc = String(rec.accessionNumber[i]).replace(/-/g, "");
    out.push({
      form: rec.form[i], date: rec.filingDate[i],
      title: rec.primaryDocDescription?.[i] || rec.form[i],
      url: `https://www.sec.gov/Archives/edgar/data/${ent.cik}/${acc}/${rec.primaryDocument[i]}`,
    });
  }
  return out;
}

app.get("/api/instrument", async (req, res) => {
  const id = String(req.query.id || "").toUpperCase();
  if (!/^[A-Z0-9.^=\-]{1,12}$/.test(id)) return res.status(400).json({ error: "bad id" });
  const hit = instCache.get(id);
  if (hit && Date.now() - hit.ts < 5 * 60_000) return res.json(hit.data);
  const cls = classify(id);
  const out = { id, cls, profile: null, metrics: null, recs: null, news: [], filings: [], dcf: null, valuation: null, bias: {} };

  const tasks = [];
  if (cls === "stock" && !["SPY", "QQQ", "DIA"].includes(id)) {
    tasks.push(finnhub(`/stock/profile2?symbol=${id}`).then(p => { if (p?.name) out.profile = p; }).catch(() => {}));
    tasks.push(finnhub(`/stock/metric?symbol=${id}&metric=all`).then(m => { out.metrics = m?.metric || null; }).catch(() => {}));
    tasks.push(finnhub(`/stock/recommendation?symbol=${id}`).then(r => { out.recs = Array.isArray(r) ? r[0] : null; }).catch(() => {}));
    tasks.push(edgarFilings(id).then(f => { out.filings = f; }).catch(() => {}));
    tasks.push(fmp(`/v3/discounted-cash-flow/${id}`).then(d => {
      const row = Array.isArray(d) ? d[0] : d;
      if (row?.dcf && row?.["Stock Price"]) {
        out.dcf = { dcf: row.dcf, price: row["Stock Price"] };
        const diff = (row["Stock Price"] - row.dcf) / row.dcf * 100;
        out.valuation = {
          verdict: diff > 15 ? "overvalued" : diff < -15 ? "undervalued" : "fairly valued",
          pctVsDcf: diff,
          note: "DCF model estimate (FMP) vs market price — a model, not advice",
        };
      }
    }).catch(() => {}));
  }
  if (cls === "stock" || (cls === "misc" && ["SPX", "NDX", "DJI"].includes(id))) {
    const from = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const newsSym = cls === "stock" ? id : { SPX: "SPY", NDX: "QQQ", DJI: "DIA" }[id];
    tasks.push(finnhub(`/company-news?symbol=${newsSym}&from=${from}&to=${to}`).then(n => {
      out.news = (Array.isArray(n) ? n : []).slice(0, 12).map(x => ({
        title: x.headline, link: x.url, source: x.source, publishedAt: x.datetime ? new Date(x.datetime * 1000).toISOString() : null,
      }));
    }).catch(() => {}));
  }
  // bias: day (intraday), week + month (daily closes)
  tasks.push((async () => {
    try {
      let intraday = [], daily = [];
      if (cls === "crypto") {
        const product = (CRYPTO.find(c => c[0] === id) || [])[1] || `${id}-USD`;
        const rows5 = await coinbase(`/products/${product}/candles?granularity=900`);
        intraday = rows5.map(r => r[4]).reverse().slice(-96);
        const rowsD = await coinbase(`/products/${product}/candles?granularity=86400`);
        daily = rowsD.map(r => r[4]).reverse();
      } else {
        try {
          const rows = await fmp(`/v3/historical-chart/15min/${id}`);
          intraday = (rows || []).map(r => r.close).reverse().slice(-96);
          const rowsD = await fmp(`/v3/historical-price-full/${id}?timeseries=60`);
          daily = ((rowsD || {}).historical || []).map(r => r.close).reverse();
        } catch {
          const ysym = cls === "fx" ? (FX.find(f => f[0] === id) || [])[2] :
                        cls === "misc" ? (YAHOO_MISC.find(y => y[0] === id) || [])[1] : id;
          const r1 = await yfChart(ysym || id, "5d", "15m");
          intraday = (r1.indicators?.quote?.[0]?.close || []).filter(v => typeof v === "number").slice(-96);
          const r2 = await yfChart(ysym || id, "3mo", "1d");
          daily = (r2.indicators?.quote?.[0]?.close || []).filter(v => typeof v === "number");
        }
      }
      if (intraday.length) out.bias.day = biasFromCloses(intraday.slice(-40));
      if (daily.length >= 6) out.bias.week = biasFromCloses(daily.slice(-10));
      if (daily.length >= 22) out.bias.month = biasFromCloses(daily.slice(-30));
    } catch {}
  })());

  await Promise.allSettled(tasks);
  instCache.set(id, { ts: Date.now(), data: out });
  res.json(out);
});

// ---- Calendar -----------------------------------------------------------
let calCache = { ts: 0, data: { earnings: [], economic: [] } };
app.get("/api/calendar", async (req, res) => {
  if (Date.now() - calCache.ts < 6 * 3600_000) return res.json(calCache.data);
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
  const data = { earnings: [], economic: [] };
  const uni = new Set(STOCKS);
  // FMP's earning_calendar / economic_calendar are gated on paid plans for
  // many free keys -- try Finnhub's calendar endpoints too and merge, so
  // the ECO screen still populates when FMP 403s on these.
  try {
    const e = await fmp(`/v3/earning_calendar?from=${from}&to=${to}`);
    data.earnings = (Array.isArray(e) ? e : []).filter(x => uni.has(x.symbol)).slice(0, 20)
      .map(x => ({ symbol: x.symbol, date: x.date, epsEstimated: x.epsEstimated, time: x.time }));
  } catch {}
  if (!data.earnings.length) {
    try {
      const e = await finnhub(`/calendar/earnings?from=${from}&to=${to}`);
      const rows = e?.earningsCalendar || [];
      data.earnings = rows.filter(x => uni.has(x.symbol)).slice(0, 20)
        .map(x => ({ symbol: x.symbol, date: x.date, epsEstimated: x.epsEstimate, time: x.hour }));
    } catch {}
  }
  try {
    const ec = await fmp(`/v3/economic_calendar?from=${from}&to=${to}`);
    data.economic = (Array.isArray(ec) ? ec : []).filter(x => x.country === "US" && (x.impact === "High" || x.importance === "High" || x.impact === "Medium")).slice(0, 25)
      .map(x => ({ event: x.event, date: x.date, impact: x.impact || x.importance, estimate: x.estimate, previous: x.previous }));
  } catch {}
  if (!data.economic.length) {
    try {
      const ec = await finnhub(`/calendar/economic?from=${from}&to=${to}`);
      const rows = ec?.economicCalendar || [];
      data.economic = rows.filter(x => x.country === "US" && (x.impact === "high" || x.impact === "medium")).slice(0, 25)
        .map(x => ({ event: x.event, date: x.time, impact: x.impact, estimate: x.estimate, previous: x.prev }));
    } catch {}
  }
  calCache = { ts: Date.now(), data };
  res.json(data);
});

// ---- Diagnostics --------------------------------------------------------
app.get("/api/diag", async (req, res) => {
  const out = { keys: { finnhub: !!FINNHUB_KEY, fmp: !!FMP_KEY }, sources: {} };
  const test = async (name, fn) => {
    try { await fn(); out.sources[name] = "OK"; }
    catch (e) { out.sources[name] = String(e.message || e).slice(0, 120); }
  };
  await Promise.allSettled([
    test("finnhub", () => finnhub("/quote?symbol=AAPL")),
    test("fmp", () => fmp("/v3/quote/AAPL")),
    test("coinbase", () => coinbase("/products/BTC-USD/ticker")),
    test("yahoo", () => yfChart("AAPL", "1d", "5m")),
    test("stooq", () => stooqQuote("cl.f")),
    test("edgar", () => getCik("AAPL")),
  ]);
  out.quotesCached = Object.keys(quotes).length;
  out.newsItems = newsCache.length;
  out.newsUpdatedAt = newsUpdatedAt;
  res.json(out);
});

app.use(express.static(path.join(__dirname, "public")));
app.listen(PORT, () => console.log(`FRIDAY terminal listening on port ${PORT}`));
