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

  function create(canvas, opts = {}) {
    const ctx = canvas.getContext("2d");
    const state = {
      rotY: -1.4, rotX: 0.38, zoom: 1,
      autoSpin: true, spinSpeed: 0.055,   // radians/sec
      dragging: false, lastX: 0, lastY: 0, moved: 0,
      resumeAt: 0,
      markers: [], arcs: [], hover: null,
      placing: false,
      cx: 0, cy: 0, R: 10, dpr: 1,
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
        // hover hit-test against markers
        let best = null, bestD = 16;
        for (const m of state.markers) {
          const p = project(m.vec);
          if (p.depth <= 0) continue;
          const d = Math.hypot(p.x - mx, p.y - my);
          if (d < bestD) { bestD = d; best = m; }
        }
        state.hover = best;
        canvas.style.cursor = best ? "pointer" : (state.placing ? "crosshair" : "grab");
      }
    });
    const endDrag = e => {
      if (!state.dragging) return;
      state.dragging = false;
      if (state.moved < 5) {                      // a click, not a drag
        const r = canvas.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        let best = null, bestD = 16;
        for (const m of state.markers) {
          const p = project(m.vec);
          if (p.depth <= 0) continue;
          const d = Math.hypot(p.x - mx, p.y - my);
          if (d < bestD) { bestD = d; best = m; }
        }
        if (best) emit("markerclick", best);
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

    function drawSphere() {
      const R = state.R * state.zoom;
      const g = ctx.createRadialGradient(state.cx - R * 0.35, state.cy - R * 0.4, R * 0.05, state.cx, state.cy, R);
      g.addColorStop(0, "#12304a");
      g.addColorStop(0.55, "#0a1a2b");
      g.addColorStop(1, "#050a12");
      ctx.beginPath(); ctx.arc(state.cx, state.cy, R, 0, 7); ctx.fillStyle = g; ctx.fill();
      // atmosphere rim
      ctx.save();
      ctx.beginPath(); ctx.arc(state.cx, state.cy, R, 0, 7);
      ctx.strokeStyle = "rgba(63,200,255,0.55)"; ctx.lineWidth = 1.5;
      ctx.shadowColor = "rgba(63,200,255,0.9)"; ctx.shadowBlur = 22; ctx.stroke();
      ctx.restore();
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

      const w = canvas.clientWidth, h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      drawSphere();
      drawLand();
      drawGraticule();
      drawArcs(now);
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
      focus(lat, lon) {                     // spin the globe to face a point
        state.rotY = -lon * DEG - Math.PI / 2;
        state.rotX = Math.max(-1.2, Math.min(1.2, lat * DEG));
        state.autoSpin = false; state.resumeAt = performance.now() + 4000;
      },
      setPlacing(v) { state.placing = !!v; canvas.style.cursor = v ? "crosshair" : "grab"; },
      get arcCount() { return state.arcs.length; },
    };
  }

  return { create };
})();
