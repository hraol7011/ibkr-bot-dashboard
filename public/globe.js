/* FRIDAY order-flow globe.
 *
 * Hand-rolled canvas 2D renderer rather than three.js/globe.gl on a CDN:
 * this dashboard already had one chart silently fail to render because a
 * CDN script didn't load in the browser, and a blank globe would be a much
 * bigger hole. Everything here is self-contained -- the only external data
 * is world.js, served from this same origin.
 *
 * Coordinate convention: unit sphere, camera looking down +Z at the origin.
 *   x = cos(lat)cos(lon),  y = sin(lat),  z = cos(lat)sin(lon)
 * A point is on the visible hemisphere when its rotated z > 0.
 */
window.FridayGlobe = (function () {
  const DEG = Math.PI / 180;

  function latLonToVec(lat, lon) {
    const a = lat * DEG, b = lon * DEG, ca = Math.cos(a);
    return { x: ca * Math.cos(b), y: Math.sin(a), z: ca * Math.sin(b) };
  }

  // Great-circle interpolation, so an arc follows the real shortest path over
  // the surface instead of a straight line through the sphere.
  function slerp(v0, v1, t) {
    let dot = v0.x * v1.x + v0.y * v1.y + v0.z * v1.z;
    dot = Math.max(-1, Math.min(1, dot));
    const theta = Math.acos(dot);
    if (theta < 1e-6) return { ...v0 };
    const s = Math.sin(theta);
    const a = Math.sin((1 - t) * theta) / s, b = Math.sin(t * theta) / s;
    return { x: v0.x * a + v1.x * b, y: v0.y * a + v1.y * b, z: v0.z * a + v1.z * b };
  }
  function angleBetween(v0, v1) {
    let d = v0.x * v1.x + v0.y * v1.y + v0.z * v1.z;
    return Math.acos(Math.max(-1, Math.min(1, d)));
  }

  // Sub-solar point: the lat/lon where the sun is directly overhead right now.
  // Standard low-precision solar position -- accurate to a fraction of a
  // degree, which is far more than a globe this size can show. This is what
  // makes the day/night terminator line up with the real world.
  function subsolarPoint(date) {
    const d = date || new Date();
    const start = Date.UTC(d.getUTCFullYear(), 0, 0);
    const dayOfYear = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 864e5;
    const utcHours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    // declination of the sun
    const g = (2 * Math.PI / 365) * (dayOfYear - 1 + (utcHours - 12) / 24);
    const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
      - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
      - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    // equation of time (minutes) -> longitude correction
    const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
      - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const lon = -15 * (utcHours - 12 + eqTime / 60);
    return { lat: decl / DEG, lon: ((lon + 180) % 360 + 360) % 360 - 180 };
  }

  function create(canvas, opts = {}) {
    const ctx = canvas.getContext("2d");
    const state = {
      rotY: -1.4, rotX: 0.38, zoom: 1,
      autoSpin: true, spinSpeed: 0.055,   // radians/sec
      dragging: false, lastX: 0, lastY: 0, moved: 0,
      resumeAt: 0,
      markers: [], arcs: [], hover: null, pins: [],
      placing: false, showNight: true,
      cx: 0, cy: 0, R: 10, dpr: 1,
      stars: Array.from({ length: 220 }, () => ({
        // fixed star field in screen space; regenerated on resize
        u: Math.random(), v: Math.random(), r: Math.random() * 1.1 + 0.2, a: Math.random() * 0.5 + 0.2,
        tw: Math.random() * Math.PI * 2,
      })),
    };
    const listeners = { markerclick: [], surfaceclick: [] };
    const on = (ev, fn) => { (listeners[ev] || (listeners[ev] = [])).push(fn); };
    const emit = (ev, arg) => (listeners[ev] || []).forEach(f => { try { f(arg); } catch (e) {} });

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth || 600, h = canvas.clientHeight || 400;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      state.dpr = dpr; state.cx = w / 2; state.cy = h / 2;
      state.R = Math.min(w, h) * 0.42;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    new ResizeObserver(resize).observe(canvas);
    resize();

    // Rotate a unit vector into view space and project it to screen pixels.
    function project(v) {
      const cy_ = Math.cos(state.rotY), sy = Math.sin(state.rotY);
      const x1 = v.x * cy_ - v.z * sy, z1 = v.x * sy + v.z * cy_;
      const cx_ = Math.cos(state.rotX), sx = Math.sin(state.rotX);
      const y2 = v.y * cx_ - z1 * sx, z2 = v.y * sx + z1 * cx_;
      const R = state.R * state.zoom;
      return { x: state.cx + x1 * R, y: state.cy - y2 * R, depth: z2 };
    }
    // Screen point -> lat/lon on the front hemisphere (inverse orthographic).
    function unproject(px, py) {
      const R = state.R * state.zoom;
      const x1 = (px - state.cx) / R, y2 = -(py - state.cy) / R;
      const r2 = x1 * x1 + y2 * y2;
      if (r2 > 1) return null;                  // clicked off the globe
      const z2 = Math.sqrt(1 - r2);
      const cx_ = Math.cos(-state.rotX), sx = Math.sin(-state.rotX);
      const y1 = y2 * cx_ - z2 * sx, z1 = y2 * sx + z2 * cx_;
      const cy_ = Math.cos(-state.rotY), sy = Math.sin(-state.rotY);
      const x0 = x1 * cy_ - z1 * sy, z0 = x1 * sy + z1 * cy_;
      const lat = Math.asin(Math.max(-1, Math.min(1, y1))) / DEG;
      const lon = Math.atan2(z0, x0) / DEG;
      return { lat, lon };
    }

    /* ---------------- interaction ---------------- */
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", e => {
      state.dragging = true; state.moved = 0;
      state.lastX = e.clientX; state.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", e => {
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      if (state.dragging) {
        const dx = e.clientX - state.lastX, dy = e.clientY - state.lastY;
        state.moved += Math.abs(dx) + Math.abs(dy);
        state.rotY += dx * 0.006;
        state.rotX = Math.max(-1.2, Math.min(1.2, state.rotX + dy * 0.006));
        state.lastX = e.clientX; state.lastY = e.clientY;
        state.autoSpin = false; state.resumeAt = performance.now() + 2500;
      } else {
        const hit = hitTest(mx, my);
        state.hover = hit && hit.type === "marker" ? hit.item : null;
        canvas.style.cursor = hit ? "pointer" : (state.placing ? "crosshair" : "grab");
      }
    });
    // Markers win ties over pins: the venue is the thing you act on, the pin
    // is context sitting at the same city.
    function hitTest(mx, my) {
      let best = null, bestD = 16, type = null;
      for (const m of state.markers) {
        const p = project(m.vec);
        if (p.depth <= 0) continue;
        const d = Math.hypot(p.x - mx, p.y - my);
        if (d < bestD) { bestD = d; best = m; type = "marker"; }
      }
      if (best) return { type, item: best };
      for (const pin of state.pins) {
        const p = project(pin.vec);
        if (p.depth <= 0) continue;
        const d = Math.hypot(p.x - mx, p.y - my);
        if (d < bestD) { bestD = d; best = pin; type = "pin"; }
      }
      return best ? { type, item: best } : null;
    }

    const endDrag = e => {
      if (!state.dragging) return;
      state.dragging = false;
      if (state.moved < 5) {                      // a click, not a drag
        const r = canvas.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        const hit = hitTest(mx, my);
        if (hit && hit.type === "marker") emit("markerclick", hit.item);
        else if (hit && hit.type === "pin") emit("pinclick", hit.item);
        else {
          const ll = unproject(mx, my);
          if (ll) emit("surfaceclick", ll);
        }
      }
      state.resumeAt = performance.now() + 2500;
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", () => { state.dragging = false; });
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      state.zoom = Math.max(0.6, Math.min(3.2, state.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
    }, { passive: false });

    /* ---------------- drawing helpers ---------------- */
    // Draws a lat/lon path, breaking it wherever it crosses behind the limb so
    // back-facing geometry never bleeds across the front of the globe.
    function strokePath(points, style, width, backStyle) {
      let run = [];
      const flush = (front) => {
        if (run.length > 1) {
          ctx.beginPath();
          ctx.moveTo(run[0].x, run[0].y);
          for (let i = 1; i < run.length; i++) ctx.lineTo(run[i].x, run[i].y);
          ctx.strokeStyle = front ? style : backStyle;
          ctx.lineWidth = width;
          ctx.stroke();
        }
        run = [];
      };
      let curFront = null;
      for (const pt of points) {
        const p = project(pt);
        const front = p.depth > 0;
        if (curFront === null) curFront = front;
        if (front !== curFront) { flush(curFront); curFront = front; }
        if (front || backStyle) run.push(p);
      }
      flush(curFront);
    }

    function drawGraticule() {
      const step = 6;
      for (let lon = -180; lon < 180; lon += 20) {
        const pts = [];
        for (let lat = -90; lat <= 90; lat += step) pts.push(latLonToVec(lat, lon));
        strokePath(pts, "rgba(63,200,255,0.16)", 1, "rgba(63,200,255,0.05)");
      }
      for (let lat = -60; lat <= 60; lat += 20) {
        const pts = [];
        for (let lon = -180; lon <= 180; lon += step) pts.push(latLonToVec(lat, lon));
        strokePath(pts, "rgba(63,200,255,0.16)", 1, "rgba(63,200,255,0.05)");
      }
    }

    let landCache = null;
    function drawLand() {
      const rings = window.WORLD_LAND;
      if (!rings) return;
      if (!landCache) landCache = rings.map(r => r.map(c => latLonToVec(c[1], c[0])));
      for (const ring of landCache) {
        // fill only when the whole ring faces us, so partial rings can't
        // produce a polygon that wraps the wrong way across the disc
        let allFront = true;
        const proj = ring.map(v => { const p = project(v); if (p.depth <= 0) allFront = false; return p; });
        if (allFront && proj.length > 2) {
          ctx.beginPath();
          ctx.moveTo(proj[0].x, proj[0].y);
          for (let i = 1; i < proj.length; i++) ctx.lineTo(proj[i].x, proj[i].y);
          ctx.closePath();
          ctx.fillStyle = "rgba(38,86,120,0.40)";
          ctx.fill();
        }
        strokePath(ring, "rgba(120,200,240,0.75)", 1, "rgba(120,200,240,0.10)");
      }
    }

    function drawStars(now) {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      for (const s of state.stars) {
        const tw = 0.65 + 0.35 * Math.sin(now / 900 + s.tw);
        ctx.globalAlpha = s.a * tw;
        ctx.beginPath(); ctx.arc(s.u * w, s.v * h, s.r, 0, 7);
        ctx.fillStyle = "#cfe6ff"; ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function drawSphere() {
      const R = state.R * state.zoom;
      // Base ocean, lit from the direction of the sun rather than a fixed
      // corner, so the shading agrees with the terminator drawn below.
      const sun = project(latLonToVec(state.sunLL.lat, state.sunLL.lon));
      const lx = sun.depth > 0 ? sun.x : state.cx - R * 0.4;
      const ly = sun.depth > 0 ? sun.y : state.cy - R * 0.4;
      const g = ctx.createRadialGradient(lx, ly, R * 0.05, state.cx, state.cy, R * 1.15);
      g.addColorStop(0, "#1b4a6b");
      g.addColorStop(0.45, "#0d2438");
      g.addColorStop(1, "#050a12");
      ctx.beginPath(); ctx.arc(state.cx, state.cy, R, 0, 7); ctx.fillStyle = g; ctx.fill();
      // outer atmosphere halo
      ctx.save();
      const halo = ctx.createRadialGradient(state.cx, state.cy, R * 0.97, state.cx, state.cy, R * 1.16);
      halo.addColorStop(0, "rgba(63,200,255,0.30)");
      halo.addColorStop(1, "rgba(63,200,255,0)");
      ctx.beginPath(); ctx.arc(state.cx, state.cy, R * 1.16, 0, 7); ctx.fillStyle = halo; ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.beginPath(); ctx.arc(state.cx, state.cy, R, 0, 7);
      ctx.strokeStyle = "rgba(120,215,255,0.6)"; ctx.lineWidth = 1.4;
      ctx.shadowColor = "rgba(63,200,255,0.9)"; ctx.shadowBlur = 20; ctx.stroke();
      ctx.restore();
    }

    // Night side: shade every visible point whose sun elevation is below the
    // horizon. Drawn as a coarse dot mesh clipped to the globe -- cheap, and
    // it reads as a proper terminator with a soft twilight band.
    // Rendered into a small offscreen buffer and scaled up with smoothing:
    // computing the shadow at ~110x110 and letting the GPU interpolate gives a
    // soft, continuous terminator for a fraction of the per-pixel work, and
    // avoids the visible grid a coarse fillRect mesh leaves behind.
    const nightBuf = document.createElement("canvas");
    nightBuf.width = nightBuf.height = 110;
    const nctx = nightBuf.getContext("2d");
    const nimg = nctx.createImageData(110, 110);

    function drawNight() {
      if (!state.showNight) return;
      const R = state.R * state.zoom;
      const sunVec = latLonToVec(state.sunLL.lat, state.sunLL.lon);
      const N = 110, d = nimg.data;
      const cxr = Math.cos(-state.rotX), sxr = Math.sin(-state.rotX);
      const cyr = Math.cos(-state.rotY), syr = Math.sin(-state.rotY);
      for (let j = 0; j < N; j++) {
        const dy = 1 - (2 * (j + 0.5)) / N;          // +1 top .. -1 bottom
        for (let i = 0; i < N; i++) {
          const dx = (2 * (i + 0.5)) / N - 1;
          const o = (j * N + i) * 4;
          const r2 = dx * dx + dy * dy;
          if (r2 > 1) { d[o + 3] = 0; continue; }
          const dz = Math.sqrt(1 - r2);
          // screen point -> world vector (inverse of project())
          const y1 = dy * cxr - dz * sxr, z1 = dy * sxr + dz * cxr;
          const x0 = dx * cyr - z1 * syr, z0 = dx * syr + z1 * cyr;
          const elev = x0 * sunVec.x + y1 * sunVec.y + z0 * sunVec.z; // cos(sun zenith)
          // day above +0.10, full night below -0.10, twilight ramp between
          let a;
          if (elev >= 0.10) a = 0;
          else if (elev <= -0.10) a = 0.66;
          else a = 0.66 * ((0.10 - elev) / 0.20);
          d[o] = 1; d[o + 1] = 4; d[o + 2] = 12; d[o + 3] = Math.round(a * 255);
        }
      }
      nctx.putImageData(nimg, 0, 0);
      ctx.save();
      ctx.beginPath(); ctx.arc(state.cx, state.cy, R, 0, 7); ctx.clip();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(nightBuf, state.cx - R, state.cy - R, R * 2, R * 2);
      ctx.restore();
    }

    // Warm pinpricks on the dark side, at the financial centres -- the
    // "cities are awake" cue that makes a night side read as Earth.
    function drawCityLights() {
      if (!state.showNight) return;
      const sunVec = latLonToVec(state.sunLL.lat, state.sunLL.lon);
      for (const m of state.markers) {
        const elev = m.vec.x * sunVec.x + m.vec.y * sunVec.y + m.vec.z * sunVec.z;
        if (elev > 0.02) continue;
        const p = project(m.vec);
        if (p.depth <= 0) continue;
        ctx.save();
        ctx.globalAlpha = Math.min(0.85, (0.02 - elev) * 3);
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.2, 0, 7);
        ctx.fillStyle = "#ffd9a0"; ctx.shadowColor = "#ffb74d"; ctx.shadowBlur = 10; ctx.fill();
        ctx.restore();
      }
    }

    // News / economic-event pins, sized and coloured by impact.
    function drawPins(now) {
      const COL = { High: "#ff4d4d", Medium: "#f0a93b", Low: "#7c8698", Holiday: "#7c8698" };
      for (const pin of state.pins) {
        const p = project(pin.vec);
        if (p.depth <= 0) continue;
        const col = COL[pin.impact] || COL.Low;
        const big = pin.impact === "High";
        if (big || pin.impact === "Medium") {
          const t = ((now / (big ? 900 : 1600)) % 1);
          ctx.save();
          ctx.globalAlpha = (1 - t) * (big ? 0.8 : 0.45);
          ctx.beginPath(); ctx.arc(p.x, p.y, 3 + t * (big ? 26 : 15), 0, 7);
          ctx.strokeStyle = col; ctx.lineWidth = big ? 2 : 1.2; ctx.stroke();
          ctx.restore();
        }
        // upward beacon so a hot market is visible even at small scale
        if (big) {
          ctx.save();
          const up = project({ x: pin.vec.x * 1.16, y: pin.vec.y * 1.16, z: pin.vec.z * 1.16 });
          ctx.globalAlpha = 0.5 + 0.3 * Math.sin(now / 300);
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(up.x, up.y);
          ctx.strokeStyle = col; ctx.lineWidth = 1.5;
          ctx.shadowColor = col; ctx.shadowBlur = 10; ctx.stroke();
          ctx.restore();
        }
        ctx.save();
        ctx.beginPath(); ctx.arc(p.x, p.y, big ? 4 : 3, 0, 7);
        ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 12; ctx.fill();
        ctx.restore();
      }
    }

    function drawArcs(now) {
      for (let i = state.arcs.length - 1; i >= 0; i--) {
        const a = state.arcs[i];
        const age = now - a.t0;
        if (age > a.dur + a.hold) { state.arcs.splice(i, 1); continue; }
        const p = Math.min(1, age / a.dur);
        const fade = age > a.dur ? 1 - (age - a.dur) / a.hold : 1;
        const N = 64;
        const lift = 0.14 + a.span * 0.22;
        const pts = [];
        for (let k = 0; k <= N * p; k++) {
          const t = k / N;
          const v = slerp(a.from, a.to, t);
          const r = 1 + lift * Math.sin(Math.PI * t);
          pts.push({ x: v.x * r, y: v.y * r, z: v.z * r });
        }
        if (pts.length > 1) {
          ctx.save();
          ctx.globalAlpha = 0.85 * fade;
          ctx.shadowColor = a.color; ctx.shadowBlur = 8;
          strokePath(pts, a.color, 2, null);
          ctx.restore();
          // travelling head
          const head = project(pts[pts.length - 1]);
          if (head.depth > 0) {
            ctx.save();
            ctx.globalAlpha = fade;
            ctx.beginPath(); ctx.arc(head.x, head.y, 3.5, 0, 7);
            ctx.fillStyle = "#fff"; ctx.shadowColor = a.color; ctx.shadowBlur = 14; ctx.fill();
            ctx.restore();
          }
        }
      }
    }

    function drawMarkers(now) {
      for (const m of state.markers) {
        const p = project(m.vec);
        if (p.depth <= 0) continue;
        const isHome = m.kind === "home";
        const col = isHome ? "#f0a93b" : (m.active ? "#1fdb85" : "#3fc8ff");
        // pulse ring for venues with live activity
        if (m.active || isHome) {
          const t = ((now / 1000) % 2) / 2;
          ctx.save();
          ctx.globalAlpha = (1 - t) * 0.6;
          ctx.beginPath(); ctx.arc(p.x, p.y, 4 + t * 16, 0, 7);
          ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.restore();
        }
        ctx.save();
        ctx.beginPath(); ctx.arc(p.x, p.y, isHome ? 5 : 3.6, 0, 7);
        ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 12; ctx.fill();
        ctx.restore();

        const showLabel = state.hover === m || isHome || m.active || state.zoom > 1.25;
        if (showLabel) {
          ctx.save();
          ctx.font = "600 10px 'JetBrains Mono', monospace";
          const label = m.label;
          const w = ctx.measureText(label).width;
          // Home sits on top of a venue whenever the owner is in a market city
          // (New York by default), so drop its label below the dot instead of
          // stacking two labels in the same place.
          const dy = isHome ? 20 : -13;
          ctx.globalAlpha = 0.92;
          ctx.fillStyle = "rgba(5,8,14,0.82)";
          ctx.fillRect(p.x + 8, p.y + dy, w + 8, 15);
          ctx.fillStyle = col;
          ctx.fillText(label, p.x + 12, p.y + dy + 11);
          ctx.restore();
        }
      }
    }

    /* ---------------- main loop ---------------- */
    let last = performance.now();
    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (!state.dragging && !state.autoSpin && now > state.resumeAt) state.autoSpin = true;
      if (state.autoSpin && !state.dragging) state.rotY += state.spinSpeed * dt;

      // recompute the sun every few seconds; it moves 15 deg/hour
      if (!state.sunLL || now - (state.sunAt || 0) > 5000) {
        state.sunLL = subsolarPoint(new Date()); state.sunAt = now;
      }
      const w = canvas.clientWidth, h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      drawStars(now);
      drawSphere();
      drawLand();
      drawGraticule();
      drawNight();
      drawCityLights();
      drawArcs(now);
      drawPins(now);
      drawMarkers(now);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    /* ---------------- public API ---------------- */
    return {
      on,
      setMarkers(list) {
        state.markers = list.map(m => ({ ...m, vec: latLonToVec(m.lat, m.lon) }));
      },
      setActive(keys) {
        const s = new Set(keys || []);
        for (const m of state.markers) m.active = s.has(m.key);
      },
      // Fires one animated order-flow arc from `from` to `to` (both {lat,lon}).
      addArc(from, to, { color = "#1fdb85", dur = 1500, hold = 2600 } = {}) {
        const a = latLonToVec(from.lat, from.lon), b = latLonToVec(to.lat, to.lon);
        state.arcs.push({ from: a, to: b, color, dur, hold,
                          t0: performance.now(), span: angleBetween(a, b) / Math.PI });
        if (state.arcs.length > 40) state.arcs.shift();
      },
      focus(lat, lon) {
        // After the Y rotation a point's depth is cos(lat)*sin(lon + rotY),
        // which peaks when lon + rotY = pi/2 -- so rotY = pi/2 - lon. (An
        // earlier sign slip here pointed the globe a quarter-turn away, at
        // ~106E instead of New York.) The X rotation then centres it
        // vertically at rotX = lat.
        state.rotY = Math.PI / 2 - lon * DEG;
        state.rotX = Math.max(-1.2, Math.min(1.2, lat * DEG));
        state.autoSpin = false; state.resumeAt = performance.now() + 4000;
      },
      setPlacing(v) { state.placing = !!v; canvas.style.cursor = v ? "crosshair" : "grab"; },
      setPins(list) { state.pins = (list || []).map(p => ({ ...p, vec: latLonToVec(p.lat, p.lon) })); },
      setNight(v) { state.showNight = !!v; },
      get nightOn() { return state.showNight; },
      get sun() { return state.sunLL; },
      get arcCount() { return state.arcs.length; },
    };
  }

  return { create };
})();
