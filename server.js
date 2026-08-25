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
const Parser = require("rss-parser");

const PORT = process.env.PORT || 3000;
const REPORT_TOKEN = process.env.REPORT_TOKEN;
const DASHBOARD_USER = process.env.DASHBOARD_USER;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");

const MAX_EQUITY_POINTS = 3000;
const MAX_TRADES = 500;

// --- Live market news ticker: polled server-side from free, no-key-required
// public financial RSS feeds, cached in memory, served to the dashboard via
// GET /api/news. This is a nice-to-have, same fire-and-forget philosophy as
// the bot's own dashboard reporter -- a feed timing out never breaks the app.
const NEWS_FEEDS = [
  { source: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex" },
  { source: "MarketWatch", url: "http://feeds.marketwatch.com/marketwatch/topstories/" },
  { source: "CNBC Top News", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
  { source: "CNBC Markets", url: "https://www.cnbc.com/id/15839069/device/rss/rss.html" },
];
const NEWS_POLL_MS = 4 * 60 * 1000;
let newsCache = [];
const newsParser = new Parser({ timeout: 8000 });

async function pollNews() {
  const results = await Promise.allSettled(NEWS_FEEDS.map(f => newsParser.parseURL(f.url)));
  const items = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    for (const entry of (r.value.items || []).slice(0, 12)) {
      items.push({
        source: NEWS_FEEDS[i].source,
        title: entry.title || "",
        link: entry.link || "",
        publishedAt: entry.isoDate || entry.pubDate || null,
      });
    }
  });
  items.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  if (items.length) newsCache = items.slice(0, 40);
}
pollNews().catch(() => {});
setInterval(() => { pollNews().catch(() => {}); }, NEWS_POLL_MS);

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
    withinStockTradingWindow: !!body.withinStockTradingWindow,
    withinForexTradingWindow: !!body.withinForexTradingWindow,
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

app.get("/api/news", (req, res) => {
  res.json({ items: newsCache });
});

// ---------------------------------------------------------------------------
// Market data proxy (Yahoo Finance public endpoints, no API key).
// Why a proxy instead of the browser fetching Yahoo directly: CORS blocks
// browser->Yahoo requests, and caching here means 5 open dashboard tabs cost
// one upstream request, not five. All routes below sit behind basic auth.
// Prices are near-live (typically seconds to ~1 min behind the exchange) --
// good for watching, NOT an execution feed. The bot itself always trades on
// IBKR's own data, never on anything served here.
// ---------------------------------------------------------------------------
const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "application/json,text/html,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};
const quoteCache = new Map();   // symbol -> {ts, data}
const chartCache = new Map();   // symbol|range -> {ts, data}
const fundCache = new Map();    // symbol -> {ts, data}
const QUOTE_TTL = 8_000, CHART_TTL = 30_000, FUND_TTL = 6 * 3600_000;

const SYMBOL_RE = /^[A-Za-z0-9^.\-=]{1,12}$/;

// Yahoo increasingly rejects bare requests from datacenter IPs (401/403/429)
// unless they carry a session cookie (+ crumb for some endpoints). We do the
// cookie handshake once, reuse it everywhere, refresh it when a request gets
// bounced, and fall back between query1/query2 hosts. Failures are logged
// (throttled) so Render's log view shows WHY quotes are empty, not just that
// they are.
let yfAuth = { cookie: null, crumb: null, ts: 0 };
let lastYfErrLog = 0;
function logYfError(msg) {
  if (Date.now() - lastYfErrLog > 60_000) {
    lastYfErrLog = Date.now();
    console.error("[yahoo]", msg);
  }
}
async function getYfAuth(force = false) {
  if (!force && yfAuth.cookie && Date.now() - yfAuth.ts < 4 * 3600_000) return yfAuth;
  const r1 = await fetch("https://fc.yahoo.com/", { headers: YF_HEADERS, redirect: "manual", signal: AbortSignal.timeout(7000) }).catch(() => null);
  let cookie = "";
  if (r1) {
    const sc = (typeof r1.headers.getSetCookie === "function") ? r1.headers.getSetCookie() : [r1.headers.get("set-cookie")].filter(Boolean);
    cookie = sc.map(c => String(c).split(";")[0]).join("; ");
  }
  if (!cookie) throw new Error("no yahoo cookie");
  let crumb = null;
  try {
    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { ...YF_HEADERS, Cookie: cookie }, signal: AbortSignal.timeout(7000) });
    const t = (await r2.text()).trim();
    if (r2.ok && t && !t.includes("<")) crumb = t;
  } catch {}
  yfAuth = { cookie, crumb, ts: Date.now() };
  return yfAuth;
}

async function yfChart(symbol, range, interval) {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplit`;
  let auth = null;
  try { auth = await getYfAuth(); } catch {}
  let lastErr = null;
  for (const attempt of [0, 1, 2]) {
    const host = attempt === 1 ? "query2.finance.yahoo.com" : "query1.finance.yahoo.com";
    const headers = { ...YF_HEADERS };
    if (auth?.cookie) headers.Cookie = auth.cookie;
    let url = `https://${host}${path}`;
    if (auth?.crumb) url += `&crumb=${encodeURIComponent(auth.crumb)}`;
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(7000) });
      if (r.status === 401 || r.status === 403 || r.status === 429) {
        lastErr = new Error(`yahoo chart ${symbol}: HTTP ${r.status}`);
        if (attempt < 2) { try { auth = await getYfAuth(true); } catch {} continue; }
        throw lastErr;
      }
      if (!r.ok) throw new Error(`yahoo chart ${symbol}: HTTP ${r.status}`);
      const j = await r.json();
      const result = j?.chart?.result?.[0];
      if (!result) throw new Error(`yahoo chart ${symbol}: empty result`);
      return result;
    } catch (e) {
      lastErr = e;
      if (attempt === 2) break;
    }
  }
  logYfError(String(lastErr?.message || lastErr));
  throw lastErr;
}

function shapeQuote(result) {
  const meta = result.meta || {};
  const closes = result.indicators?.quote?.[0]?.close || [];
  const spark = closes.filter(v => typeof v === "number");
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose ?? meta.previousClose;
  return {
    symbol: meta.symbol,
    name: meta.longName || meta.shortName || meta.symbol,
    currency: meta.currency,
    exchange: meta.exchangeName,
    type: meta.instrumentType,
    price,
    prevClose: prev,
    change: (typeof price === "number" && typeof prev === "number") ? price - prev : null,
    changePct: (typeof price === "number" && typeof prev === "number" && prev) ? (price - prev) / prev * 100 : null,
    dayHigh: meta.regularMarketDayHigh ?? null,
    dayLow: meta.regularMarketDayLow ?? null,
    volume: meta.regularMarketVolume ?? null,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
    marketState: meta.marketState || null,
    spark: spark.slice(-64),
  };
}

app.get("/api/quotes", async (req, res) => {
  const symbols = String(req.query.symbols || "").split(",").map(s => s.trim()).filter(s => SYMBOL_RE.test(s)).slice(0, 40);
  if (!symbols.length) return res.json({ quotes: {} });
  const now = Date.now();
  const out = {};
  await Promise.allSettled(symbols.map(async sym => {
    const hit = quoteCache.get(sym);
    if (hit && now - hit.ts < QUOTE_TTL) { out[sym] = hit.data; return; }
    try {
      const data = shapeQuote(await yfChart(sym, "1d", "5m"));
      quoteCache.set(sym, { ts: Date.now(), data });
      out[sym] = data;
    } catch (e) {
      if (hit) out[sym] = hit.data; // serve stale over nothing
    }
  }));
  res.json({ quotes: out, at: new Date().toISOString() });
});

const CHART_RANGES = { "1d": "5m", "5d": "15m", "1mo": "1h", "3mo": "1d", "6mo": "1d", "1y": "1d", "5y": "1wk" };
app.get("/api/chart", async (req, res) => {
  const symbol = String(req.query.symbol || "");
  const range = String(req.query.range || "1d");
  if (!SYMBOL_RE.test(symbol) || !CHART_RANGES[range]) return res.status(400).json({ error: "bad symbol/range" });
  const key = symbol + "|" + range;
  const hit = chartCache.get(key);
  if (hit && Date.now() - hit.ts < CHART_TTL) return res.json(hit.data);
  try {
    const result = await yfChart(symbol, range, CHART_RANGES[range]);
    const ts = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if ([q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]].some(v => typeof v !== "number")) continue;
      candles.push({ t: ts[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] ?? 0 });
    }
    const data = { symbol, range, interval: CHART_RANGES[range], candles, meta: shapeQuote(result) };
    chartCache.set(key, { ts: Date.now(), data });
    res.json(data);
  } catch (e) {
    if (hit) return res.json(hit.data);
    res.status(502).json({ error: String(e.message || e) });
  }
});

// --- Fundamentals reuse the same cookie+crumb session as yfChart. Fail
// soft: the panel just shows fewer rows if Yahoo changes the handshake.
const num = (x) => (x && typeof x === "object" ? x.raw : x);
app.get("/api/fundamentals", async (req, res) => {
  const symbol = String(req.query.symbol || "");
  if (!SYMBOL_RE.test(symbol)) return res.status(400).json({ error: "bad symbol" });
  const hit = fundCache.get(symbol);
  if (hit && Date.now() - hit.ts < FUND_TTL) return res.json(hit.data);
  try {
    const { cookie, crumb } = await getYfAuth();
    if (!crumb) throw new Error("no yahoo crumb available");
    const modules = "price,summaryDetail,defaultKeyStatistics,financialData,assetProfile,calendarEvents";
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
      `?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
    const r = await fetch(url, { headers: { ...YF_HEADERS, Cookie: cookie }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`quoteSummary HTTP ${r.status}`);
    const j = await r.json();
    const s = j?.quoteSummary?.result?.[0] || {};
    const sd = s.summaryDetail || {}, ks = s.defaultKeyStatistics || {}, fd = s.financialData || {},
          ap = s.assetProfile || {}, pr = s.price || {}, ce = s.calendarEvents || {};
    const data = {
      symbol,
      name: pr.longName || pr.shortName || symbol,
      sector: ap.sector || null,
      industry: ap.industry || null,
      website: ap.website || null,
      summary: ap.longBusinessSummary ? String(ap.longBusinessSummary).slice(0, 420) : null,
      marketCap: num(pr.marketCap) ?? num(sd.marketCap) ?? null,
      trailingPE: num(sd.trailingPE) ?? null,
      forwardPE: num(sd.forwardPE) ?? num(ks.forwardPE) ?? null,
      eps: num(ks.trailingEps) ?? null,
      dividendYield: num(sd.dividendYield) ?? null,
      beta: num(sd.beta) ?? null,
      profitMargin: num(fd.profitMargins) ?? null,
      grossMargin: num(fd.grossMargins) ?? null,
      revenue: num(fd.totalRevenue) ?? null,
      revenueGrowth: num(fd.revenueGrowth) ?? null,
      freeCashflow: num(fd.freeCashflow) ?? null,
      debtToEquity: num(fd.debtToEquity) ?? null,
      returnOnEquity: num(fd.returnOnEquity) ?? null,
      targetMeanPrice: num(fd.targetMeanPrice) ?? null,
      recommendation: fd.recommendationKey || null,
      analystCount: num(fd.numberOfAnalystOpinions) ?? null,
      nextEarnings: ce.earnings?.earningsDate?.length ? num(ce.earnings.earningsDate[0]) : null,
    };
    fundCache.set(symbol, { ts: Date.now(), data });
    res.json(data);
  } catch (e) {
    if (hit) return res.json(hit.data);
    res.json({ symbol, error: String(e.message || e) });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Dashboard listening on port ${PORT}`);
});
