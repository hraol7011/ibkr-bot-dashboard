/* FRIDAY voice -- speech out (Web Speech synthesis) and speech in
 * (Web Speech recognition). Both are built into the browser, so there's no
 * API key, no per-word cost and no network hop: a trade fill is spoken the
 * instant the page hears about it, which is the whole point.
 *
 * Three browser quirks are handled here because they are the difference
 * between "demos fine" and "works during a session":
 *   1. getVoices() is populated asynchronously -- we wait for voiceschanged.
 *   2. Chrome silently stops synthesis after ~15s of continuous speech, so
 *      long text is split into sentence-sized utterances and a keep-alive
 *      resume() ping runs while speaking.
 *   3. Synthesis must be kicked off by a user gesture on most browsers --
 *      the enable button is that gesture, and we prime the engine there.
 */
window.FridayVoice = (function () {
  const synth = window.speechSynthesis;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  const state = {
    mode: "alerts",        // "off" | "alerts" | "all"
    voice: null,
    rate: 1.08,
    pitch: 1.0,
    speaking: false,
    queue: [],             // {text, priority}
    listening: false,
    rec: null,
    onTranscript: null,
    onStateChange: null,
    primed: false,
  };

  /* ---------------- pronunciation ----------------
     Raw dashboard text reads badly aloud: tickers get spelled out as words,
     "P&L" becomes "P ampersand L", "m/m" becomes "m slash m". Normalise to
     how a person on a desk would actually say it. */
  const TICKER = {
    AAPL: "Apple", MSFT: "Microsoft", NVDA: "Nvidia", AMZN: "Amazon",
    GOOGL: "Google", META: "Meta", SPY: "S P Y", QQQ: "Q Q Q",
  };
  const PAIR = {
    "EUR.USD": "euro dollar", "GBP.USD": "pound dollar", "USD.JPY": "dollar yen",
    "USD.CHF": "dollar swiss franc", "AUD.USD": "aussie dollar",
    "USD.CAD": "dollar canadian dollar", "NZD.USD": "kiwi dollar",
    "EUR/USD": "euro dollar", "GBP/USD": "pound dollar", "USD/JPY": "dollar yen",
    "USD/CHF": "dollar swiss franc", "AUD/USD": "aussie dollar",
    "USD/CAD": "dollar canadian dollar", "NZD/USD": "kiwi dollar",
  };
  const ABBREV = [
    [/\[\[ACTION:[^\]]*\]\]/gi, ""],
    [/https?:\/\/\S+/g, ""],
    [/[⚠✅⛔📍🌓🔊🎤▶⏸►•·→←↑↓]/g, " "],
    [/\bP&L\b/gi, "P and L"],
    [/\btgt\b/gi, "target"],
    [/\bqty\b/gi, "quantity"],
    [/\bfcst\b/gi, "forecast"],
    [/\bprev\b/gi, "previous"],
    [/\bavg\b/gi, "average"],
    [/\bm\/m\b/gi, "month over month"],
    [/\bq\/q\b/gi, "quarter over quarter"],
    [/\by\/y\b/gi, "year over year"],
    [/\bFX\b/g, "forex"],
    [/\bSTK\b/g, "stock"],
    [/\bCPI\b/g, "C P I"],
    [/\bPCE\b/g, "P C E"],
    [/\bGDP\b/g, "G D P"],
    [/\bPMI\b/g, "P M I"],
    [/\bNFP\b/g, "non farm payrolls"],
    [/\bFOMC\b/g, "F O M C"],
    [/\bECB\b/g, "E C B"],
    [/\bBOJ\b/g, "Bank of Japan"],
    [/\bBOE\b/g, "Bank of England"],
    // no leading \b: these show up glued to a period, as in "50EMA", "14RSI"
    [/(\d*)EMA\b/g, (m, d) => (d ? d + " " : "") + "E M A"],
    [/(\d*)RSI\b/g, (m, d) => (d ? d + " " : "") + "R S I"],
    [/(\d*)ATR\b/g, (m, d) => (d ? d + " " : "") + "A T R"],
    [/\bIBKR\b/g, "Interactive Brokers"],
    [/\bNASDAQ\b/gi, "Nasdaq"],
    [/\bNYSE\b/g, "N Y S E"],
    [/\bpct\b/gi, "percent"],
    [/\s{2,}/g, " "],
  ];

  function speakable(raw) {
    let t = " " + String(raw || "") + " ";
    for (const [k, v] of Object.entries(PAIR)) t = t.split(k).join(v);
    // tickers only when standing alone, so "Meta unveils" isn't mangled twice
    t = t.replace(/\b([A-Z]{2,5})\b/g, (m) => TICKER[m] || m);
    for (const [re, rep] of ABBREV) t = t.replace(re, rep);
    return t.trim();
  }

  /* ---------------- voice selection ---------------- */
  function pickVoice() {
    const all = synth ? synth.getVoices() : [];
    if (!all.length) return null;
    const en = all.filter(v => /^en(-|_|$)/i.test(v.lang));
    const pool = en.length ? en : all;
    // Prefer the natural-sounding platform voices when they exist.
    const preferred = ["samantha", "ava", "allison", "serena", "google us english",
                       "microsoft aria", "microsoft jenny", "karen", "moira", "zira"];
    for (const name of preferred) {
      const hit = pool.find(v => v.name.toLowerCase().includes(name));
      if (hit) return hit;
    }
    return pool.find(v => v.localService) || pool[0];
  }
  function refreshVoices() {
    if (!synth) return;
    const v = pickVoice();
    if (v) state.voice = v;
  }
  if (synth) {
    refreshVoices();
    synth.addEventListener?.("voiceschanged", refreshVoices);
  }

  /* ---------------- speaking ---------------- */
  // Chrome stops synthesising after ~15s; this nudge keeps it alive.
  let keepAlive = null;
  function startKeepAlive() {
    if (keepAlive) return;
    keepAlive = setInterval(() => {
      if (synth && synth.speaking) { try { synth.pause(); synth.resume(); } catch {} }
      else stopKeepAlive();
    }, 9000);
  }
  function stopKeepAlive() { clearInterval(keepAlive); keepAlive = null; }

  // Split long text so each utterance stays comfortably under the cut-off.
  function chunk(text, max = 190) {
    const parts = text.match(/[^.!?;\n]+[.!?;\n]*/g) || [text];
    const out = [];
    let buf = "";
    for (const p of parts) {
      if ((buf + p).length > max && buf) { out.push(buf.trim()); buf = p; }
      else buf += p;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  function drain() {
    if (!synth || state.speaking) return;
    const next = state.queue.shift();
    if (!next) return;
    const pieces = chunk(next.text);
    if (!pieces.length) return drain();
    state.speaking = true;
    state.onStateChange?.();
    startKeepAlive();
    let i = 0;
    const sayNext = () => {
      if (i >= pieces.length) {
        state.speaking = false; stopKeepAlive(); state.onStateChange?.();
        drain();
        return;
      }
      const u = new SpeechSynthesisUtterance(pieces[i++]);
      if (state.voice) u.voice = state.voice;
      u.rate = next.rate || state.rate;
      u.pitch = state.pitch;
      u.onend = sayNext;
      u.onerror = () => { state.speaking = false; stopKeepAlive(); state.onStateChange?.(); drain(); };
      try { synth.speak(u); }
      catch { state.speaking = false; stopKeepAlive(); state.onStateChange?.(); }
    };
    sayNext();
  }

  /* priority: 3 critical (interrupts), 2 trade, 1 reply, 0 routine chatter */
  function speak(raw, { priority = 1, force = false } = {}) {
    if (!synth) return false;
    if (!force) {
      if (state.mode === "off") return false;
      if (state.mode === "alerts" && priority < 2) return false;
    }
    const text = speakable(raw);
    if (!text) return false;
    if (priority >= 3) {                 // critical cuts the line and the current line
      cancel();
      state.queue.unshift({ text, priority, rate: state.rate + 0.06 });
    } else {
      if (state.queue.length > 6) state.queue.splice(0, state.queue.length - 6);
      state.queue.push({ text, priority });
    }
    drain();
    return true;
  }
  function cancel() {
    state.queue.length = 0;
    try { synth && synth.cancel(); } catch {}
    state.speaking = false; stopKeepAlive(); state.onStateChange?.();
  }

  /* ---------------- listening ---------------- */
  function ensureRec() {
    if (!SR || state.rec) return state.rec;
    const r = new SR();
    r.lang = "en-US";
    r.interimResults = true;
    r.continuous = false;          // push-to-talk; press again for the next one
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t; else interim += t;
      }
      state.onTranscript?.({ interim, final: final.trim() });
    };
    r.onstart = () => { state.listening = true; cancel(); state.onStateChange?.(); }; // barge-in
    r.onend = () => { state.listening = false; state.onStateChange?.(); };
    r.onerror = (e) => {
      state.listening = false;
      state.onStateChange?.(e.error);
    };
    state.rec = r;
    return r;
  }
  function listen() {
    const r = ensureRec();
    if (!r) return false;
    if (state.listening) { try { r.stop(); } catch {} return false; }
    try { r.start(); return true; } catch { return false; }
  }
  function stopListening() { try { state.rec && state.rec.stop(); } catch {} }

  return {
    get supported() { return !!synth; },
    get micSupported() { return !!SR; },
    get mode() { return state.mode; },
    get speaking() { return state.speaking; },
    get listening() { return state.listening; },
    get voiceName() { return state.voice ? state.voice.name : "default"; },
    voices: () => (synth ? synth.getVoices().filter(v => /^en(-|_|$)/i.test(v.lang)) : []),
    setVoiceByName(n) { const v = (synth.getVoices() || []).find(x => x.name === n); if (v) state.voice = v; },
    setMode(m) { state.mode = m; if (m === "off") cancel(); },
    setRate(r) { state.rate = r; },
    speak, cancel, listen, stopListening, speakable,
    // Browsers gate synthesis behind a user gesture; call this from a click.
    prime() {
      if (state.primed || !synth) return;
      state.primed = true;
      refreshVoices();
      try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; synth.speak(u); } catch {}
    },
    onTranscript(fn) { state.onTranscript = fn; },
    onStateChange(fn) { state.onStateChange = fn; },
  };
})();
