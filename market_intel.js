/* FRIDAY -- market intelligence ("god's eye").
 *
 * Two streams, both ranked against what THIS desk is actually exposed to:
 *
 *   1. ECONOMIC CALENDAR -- Forex Factory's public weekly JSON feed, which is
 *      where the High/Medium/Low impact grading everyone quotes comes from.
 *   2. HEADLINE NEWS -- Finnhub general + per-symbol company news, with an
 *      RSS fallback so the panel still fills if Finnhub is rate-limited.
 *
 * Nothing here is allowed to throw into the request path: every fetch is
 * wrapped, every parse is defensive, and a dead source degrades to an empty
 * list rather than taking the dashboard down.
 *
 * NOTE ON SCHEMAS: the Forex Factory feed's field names have drifted over the
 * years (title/event, country/currency, impact/importance). The normaliser
 * below accepts all the variants I know of rather than assuming one shape,
 * and /api/intel/diag reports exactly what came back so a drift is visible
 * instead of silent.
 */

// Financial centre per currency -- deliberately the trading city rather than
// the political capital, so calendar events land on the same globe markers the
// order-routing arcs already use.
const CCY_CENTRE = {
  USD: { lat: 40.7069, lon: -74.0113, city: "New York" },
  EUR: { lat: 50.1109, lon: 8.6821, city: "Frankfurt" },
  GBP: { lat: 51.5074, lon: -0.1278, city: "London" },
  JPY: { lat: 35.6762, lon: 139.6503, city: "Tokyo" },
  CHF: { lat: 47.3769, lon: 8.5417, city: "Zurich" },
  AUD: { lat: -33.8688, lon: 151.2093, city: "Sydney" },
  CAD: { lat: 43.6532, lon: -79.3832, city: "Toronto" },
  NZD: { lat: -41.2866, lon: 174.7756, city: "Wellington" },
  CNY: { lat: 31.2304, lon: 121.4737, city: "Shanghai" },
  ALL: { lat: 40.7069, lon: -74.0113, city: "Global" },
};

// Headlines carry no impact grade, so classify them. Ordered most severe
// first -- the first hit wins.
const HIGH_TERMS = [
  "fomc", "federal reserve", "fed chair", "powell", "rate decision", "interest rate decision",
  "rate hike", "rate cut", "cpi", "inflation report", "core pce", "nonfarm", "non-farm",
  "payrolls", "jobs report", "unemployment rate", "gdp", "ecb", "boj", "bank of japan",
  "bank of england", "boe ", "recession", "default", "war", "invasion", "tariff",
  "sanction", "emergency", "circuit breaker", "credit rating", "downgrade of u.s",
  "treasury yield", "yield curve", "bank failure", "bailout", "shutdown",
];
const MED_TERMS = [
  "earnings", "guidance", "revenue", "profit warning", "downgrade", "upgrade",
  "pmi", "retail sales", "consumer confidence", "jobless claims", "housing starts",
  "oil price", "opec", "merger", "acquisition", "ipo", "buyback", "dividend",
  "layoff", "lawsuit", "antitrust", "regulator", "china", "election",
];

function classifyHeadline(text) {
  const t = (text || "").toLowerCase();
  for (const w of HIGH_TERMS) if (t.includes(w)) return "High";
  for (const w of MED_TERMS) if (t.includes(w)) return "Medium";
  return "Low";
}

const IMPACT_WEIGHT = { High: 100, Medium: 45, Low: 14, Holiday: 8 };

function normImpact(v) {
  const s = String(v || "").toLowerCase();
  if (s.startsWith("high") || s === "3") return "High";
  if (s.startsWith("med") || s === "2") return "Medium";
  if (s.startsWith("holiday")) return "Holiday";
  if (s.startsWith("low") || s === "1") return "Low";
  return "Low";
}

// Currencies a symbol exposes you to. "EUR.USD" -> both legs; a US stock -> USD.
function currenciesForSymbol(sym) {
  if (!sym) return [];
  if (sym.includes(".")) return sym.split(".").slice(0, 2);
  return ["USD"];
}

/* --------------------------------------------------------------------- */
/* Fetch helpers                                                          */
/* --------------------------------------------------------------------- */
async function getJson(url, ms = 9000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "user-agent": "friday-desk/1.0" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(to); }
}
async function getText(url, ms = 9000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "user-agent": "friday-desk/1.0" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(to); }
}

// Minimal RSS reader. A full XML parser would be another dependency for a job
// this small; feeds here are well-formed and we only want four fields.
function parseRss(xml, sourceName) {
  const out = [];
  const items = xml.split(/<item[\s>]/i).slice(1);
  for (const chunk of items.slice(0, 40)) {
    const pick = (tag) => {
      const m = chunk.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      if (!m) return "";
      return m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim();
    };
    const title = pick("title");
    if (!title) continue;
    const dt = Date.parse(pick("pubDate") || pick("date")) || Date.now();
    out.push({ headline: title, url: pick("link"), summary: pick("description").slice(0, 300),
               datetime: Math.floor(dt / 1000), source: sourceName });
  }
  return out;
}

/* --------------------------------------------------------------------- */
/* The engine                                                             */
/* --------------------------------------------------------------------- */
function createMarketIntel({ finnhub, getActiveSymbols, getHeldSymbols, log = console }) {
  const state = {
    calendar: [],        // normalised upcoming/recent economic events
    news: [],            // normalised, scored headlines
    lastCalendarAt: null,
    lastNewsAt: null,
    errors: {},          // source -> last error string, surfaced in /api/intel/diag
    rawSample: {},       // first object from each source, for schema debugging
  };

  /* ---- economic calendar ---- */
  const FF_URLS = [
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
    "https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json",
  ];

  function normaliseCalendarRow(r) {
    const title = r.title || r.event || r.name || "";
    const ccy = String(r.country || r.currency || r.ccy || "").toUpperCase().slice(0, 3);
    const impact = normImpact(r.impact ?? r.importance ?? r.impactTitle);
    // The feed has used ISO strings with offsets, and separately date+time
    // pairs. Accept either; drop anything we can't place in time.
    let ts = null;
    const raw = r.date || r.datetime || r.timestamp || r.time;
    if (typeof raw === "number") ts = raw > 1e11 ? raw : raw * 1000;
    else if (raw) {
      const p = Date.parse(raw);
      if (!isNaN(p)) ts = p;
      else if (r.date && r.time) { const p2 = Date.parse(`${r.date} ${r.time}`); if (!isNaN(p2)) ts = p2; }
    }
    if (!title || !ts) return null;
    return {
      kind: "event", title, currency: ccy || "ALL", impact, at: ts,
      forecast: r.forecast ?? null, previous: r.previous ?? r.prev ?? null,
      actual: r.actual ?? null,
    };
  }

  async function refreshCalendar() {
    for (const url of FF_URLS) {
      try {
        const raw = await getJson(url, 12000);
        const rows = Array.isArray(raw) ? raw : (raw.events || raw.data || []);
        if (!Array.isArray(rows) || !rows.length) throw new Error("empty or unrecognised payload");
        state.rawSample.calendar = rows[0];
        const norm = rows.map(normaliseCalendarRow).filter(Boolean);
        if (!norm.length) throw new Error(`parsed 0 of ${rows.length} rows -- field names may have changed`);
        norm.sort((a, b) => a.at - b.at);
        state.calendar = norm;
        state.lastCalendarAt = new Date().toISOString();
        delete state.errors.calendar;
        return;
      } catch (e) {
        state.errors.calendar = `${url.split("/")[2]}: ${e.message || e}`;
      }
    }
    log.warn?.("market-intel: economic calendar unavailable --", state.errors.calendar);
  }

  /* ---- headlines ---- */
  const RSS_FALLBACKS = [
    ["https://www.cnbc.com/id/100003114/device/rss/rss.html", "CNBC"],
    ["https://feeds.marketwatch.com/marketwatch/topstories/", "MarketWatch"],
  ];

  async function refreshNews() {
    const collected = [];
    // 1) Finnhub general market news -- best signal-to-noise of the free feeds
    try {
      const gen = await finnhub("/news?category=general");
      if (Array.isArray(gen) && gen.length) {
        state.rawSample.news = gen[0];
        for (const n of gen.slice(0, 60)) {
          if (!n.headline) continue;
          collected.push({ headline: n.headline, url: n.url, summary: (n.summary || "").slice(0, 400),
                           datetime: n.datetime, source: n.source || "Finnhub", related: n.related || "" });
        }
        delete state.errors.news;
      }
    } catch (e) { state.errors.news = String(e.message || e); }

    // 2) Company news for the symbols this desk actually trades
    const stocks = (getActiveSymbols() || []).filter(s => !s.includes(".")).slice(0, 8);
    if (stocks.length) {
      const today = new Date(), from = new Date(Date.now() - 3 * 864e5);
      const iso = d => d.toISOString().slice(0, 10);
      for (const sym of stocks) {
        try {
          const cn = await finnhub(`/company-news?symbol=${encodeURIComponent(sym)}&from=${iso(from)}&to=${iso(today)}`);
          if (Array.isArray(cn)) {
            for (const n of cn.slice(0, 6)) {
              if (!n.headline) continue;
              collected.push({ headline: n.headline, url: n.url, summary: (n.summary || "").slice(0, 400),
                               datetime: n.datetime, source: n.source || "Finnhub", related: sym });
            }
          }
        } catch { /* one symbol failing must not kill the batch */ }
      }
    }

    // 3) RSS fallback, only if the above produced nothing usable
    if (!collected.length) {
      for (const [url, name] of RSS_FALLBACKS) {
        try {
          const xml = await getText(url, 10000);
          collected.push(...parseRss(xml, name));
          if (collected.length) { delete state.errors.news; break; }
        } catch (e) { state.errors.news = `${name}: ${e.message || e}`; }
      }
    }

    // de-duplicate on headline; keep the earliest sighting
    const byKey = new Map();
    for (const n of collected) {
      const k = n.headline.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80);
      if (!byKey.has(k)) byKey.set(k, n);
    }
    state.news = Array.from(byKey.values());
    state.lastNewsAt = new Date().toISOString();
  }

  /* ---- ranking: this is what makes it *this desk's* god's eye ---- */
  function score(item, now, held, universe) {
    const base = IMPACT_WEIGHT[item.impact] || 10;

    // Exposure multiplier: an event on a currency you're actually holding
    // matters far more than the same event on one you don't touch.
    let exposure = 1;
    const ccys = item.currency && item.currency !== "ALL" ? [item.currency] : [];
    const sym = item.related;
    if (sym && held.has(sym)) exposure = 3.0;
    else if (sym && universe.has(sym)) exposure = 2.0;
    else if (ccys.length) {
      const heldCcy = new Set([...held].flatMap(currenciesForSymbol));
      const uniCcy = new Set([...universe].flatMap(currenciesForSymbol));
      if (ccys.some(c => heldCcy.has(c))) exposure = 3.0;
      else if (ccys.some(c => uniCcy.has(c))) exposure = 2.0;
    }

    // Time weighting differs for scheduled events vs published news.
    let timeW;
    if (item.kind === "event") {
      const mins = (item.at - now) / 60000;
      if (mins >= 0) {
        // imminent events dominate; fades out over ~2 days
        timeW = mins < 15 ? 2.4 : mins < 60 ? 2.0 : mins < 240 ? 1.5 : mins < 1440 ? 1.0 : 0.55;
      } else {
        // just-released numbers stay hot briefly (the actual print matters)
        const agoMin = -mins;
        timeW = agoMin < 30 ? 1.8 : agoMin < 180 ? 1.0 : agoMin < 720 ? 0.5 : 0.15;
      }
    } else {
      const hrs = (now - item.at) / 3600000;
      timeW = hrs < 1 ? 1.9 : hrs < 3 ? 1.4 : hrs < 8 ? 1.0 : hrs < 24 ? 0.55 : 0.2;
    }
    return Math.round(base * exposure * timeW);
  }

  function ranked() {
    const now = Date.now();
    const universe = new Set(getActiveSymbols() || []);
    const held = new Set(getHeldSymbols() || []);

    const events = state.calendar
      .filter(e => e.at > now - 12 * 3600e3 && e.at < now + 5 * 864e5)
      .map(e => ({ ...e, where: CCY_CENTRE[e.currency] || CCY_CENTRE.ALL }));

    const news = state.news.map(n => {
      const impact = classifyHeadline(n.headline + " " + (n.summary || ""));
      // a headline naming one of our symbols is upgraded a grade
      const rel = String(n.related || "").split(",")[0].trim().toUpperCase();
      const bumped = (rel && universe.has(rel) && impact === "Low") ? "Medium" : impact;
      return {
        kind: "news", title: n.headline, url: n.url, summary: n.summary,
        source: n.source, at: (n.datetime || 0) * 1000 || now,
        impact: bumped, related: rel || null,
        currency: rel && rel.includes(".") ? rel.split(".")[0] : (rel ? "USD" : "ALL"),
      };
    }).map(n => ({ ...n, where: CCY_CENTRE[n.currency] || CCY_CENTRE.ALL }));

    const all = [...events, ...news].map(i => ({ ...i, score: score(i, now, held, universe) }));
    all.sort((a, b) => b.score - a.score);

    const upcoming = events.filter(e => e.at >= now).sort((a, b) => a.at - b.at);
    const nextHigh = upcoming.find(e => e.impact === "High") || null;

    return {
      top: all.slice(0, 60),
      events: events.sort((a, b) => a.at - b.at).slice(0, 60),
      news: all.filter(i => i.kind === "news").slice(0, 40),
      nextHigh,
      // globe pins: strongest item per financial centre
      pins: (() => {
        const best = new Map();
        for (const i of all) {
          if (!i.where) continue;
          const k = i.currency;
          if (!best.has(k) || best.get(k).score < i.score) best.set(k, i);
        }
        return Array.from(best.entries()).map(([ccy, i]) => ({
          currency: ccy, lat: i.where.lat, lon: i.where.lon, city: i.where.city,
          impact: i.impact, score: i.score, title: i.title, at: i.at, kind: i.kind,
        }));
      })(),
      meta: { lastCalendarAt: state.lastCalendarAt, lastNewsAt: state.lastNewsAt, errors: state.errors },
    };
  }

  return {
    ranked,
    diag: () => ({ ...state, calendarCount: state.calendar.length, newsCount: state.news.length }),
    async refreshAll() { await Promise.allSettled([refreshCalendar(), refreshNews()]); },
    refreshCalendar, refreshNews,
  };
}

module.exports = { createMarketIntel, CCY_CENTRE, classifyHeadline, currenciesForSymbol, normImpact, parseRss };
