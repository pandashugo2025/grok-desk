/**
 * THE MIND — GROK DESK reference imitation:
 * plexus (random-node network) sphere, glowing white ghost core with eyes,
 * single thick cyan equator ring, six blob-shaped agents with eyes orbiting in 3D.
 * API: MindViz.start(canvas) / stop() / setState(apiState)
 */
(function (global) {
  'use strict';
  const AGENTS = [
    { id: 'EDGE',    color: '#ff2f9a', shape: 'tri',    inc: 0.35, phase: 0.2, speed: 0.55, rr: 1.30, ecc: 0.28, tilt: 0.3 },
    { id: 'CLOSER',  color: '#ff3b3b', shape: 'shield', inc: -0.5, phase: 1.3, speed: 0.36, rr: 1.42, ecc: 0.18, tilt: -0.4 },
    { id: 'PRIOR',   color: '#ff9a1f', shape: 'drop',   inc: 0.75, phase: 2.4, speed: 0.48, rr: 1.10, ecc: 0.10, tilt: 0.9 },
    { id: 'TAKER',   color: '#2f6bff', shape: 'squircle', inc: -0.2, phase: 3.3, speed: 0.44, rr: 1.48, ecc: 0.32, tilt: 0.1 },
    { id: 'SPOTTER', color: '#19e08a', shape: 'circle', inc: 0.15, phase: 4.3, speed: 0.31, rr: 1.22, ecc: 0.22, tilt: -0.8 },
    { id: 'KELLY',   color: '#9b4dff', shape: 'shield', inc: -0.45, phase: 5.3, speed: 0.40, rr: 0.95, ecc: 0.15, tilt: 0.5 },
  ];
  let canvas, ctx, raf = 0, dpr = 1, t0 = performance.now();
  let state = { signal: {}, agents: {}, handoffs: [] };
  let lastKey = ''; let placed = [];
  const sparks = [];
  function i18n(key, fallback) {
    try {
      if (global.DeskI18n && typeof global.DeskI18n.t === 'function') {
        const v = global.DeskI18n.t(key);
        if (v && v !== key) return v;
      }
    } catch (_) {}
    return fallback;
  }


  // ---- plexus nodes: fibonacci sphere + jitter, edges to k nearest ----
  const N = 420, nodes = [], edges = [];
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < N; i++) {
    const y = 1 - (i + 0.5) * 2 / N, r = Math.sqrt(1 - y * y), th = i * 2.39996 + rnd() * 0.5;
    const v = [Math.cos(th) * r, y + (rnd() - 0.5) * 0.04, Math.sin(th) * r];
    const l = Math.hypot(...v); nodes.push({ p: v.map(c => c / l), hot: rnd() < 0.16, tw: rnd() * 6 });
  }
  const seen = new Set();
  nodes.forEach((a, i) => {
    const d = nodes.map((b, j) => [j, (a.p[0]-b.p[0])**2 + (a.p[1]-b.p[1])**2 + (a.p[2]-b.p[2])**2]).sort((x, y) => x[1] - y[1]);
    const k = 4 + (i % 3);
    for (let n = 1; n <= k; n++) { const j = d[n][0], key = i < j ? i + '_' + j : j + '_' + i;
      if (!seen.has(key)) { seen.add(key); edges.push({ a: i, b: j, hue: rnd(), gold: rnd() < 0.05 }); } }
  });
  // a few long chords (the "spikes" crossing the sphere)
  for (let i = 0; i < 90; i++) edges.push({ a: (rnd() * N) | 0, b: (rnd() * N) | 0, hue: rnd(), gold: false, long: true });

  const bots = AGENTS.map(a => ({ ...a, pulse: 0, trail: [] }));

  function setState(s) {
    if (!s) return; state = s;
    const h = (s.handoffs || [])[0];
    if (h) { const k = h.ts + '|' + h.from + '|' + h.to;
      if (k !== lastKey) { lastKey = k;
        const f = bots.find(b => b.id === h.from), to = bots.find(b => b.id === h.to);
        if (f) f.pulse = 1; if (to) to.pulse = 1;
        for (let i = 0; i < 16; i++) sparks.push({ from: h.from, to: h.to, u: -i * 0.05, col: f ? f.color : '#4de0ff' });
      } }
  }
  function resize() {
    if (!canvas) return;
    let r = canvas.getBoundingClientRect();
    if ((r.width < 40 || r.height < 40) && canvas.parentElement) r = canvas.parentElement.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(220, (Math.max(r.width, 220) * dpr) | 0), h = Math.max(220, (Math.max(r.height, 220) * dpr) | 0);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  const rgba = (r, g, b, a) => `rgba(${r},${g},${b},${a})`;
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const hexA = (h, a) => { const c = hex(h); return rgba(c[0], c[1], c[2], a); };
  function rot(v, yaw, pitch) {
    const x1 = v[0] * Math.cos(yaw) - v[2] * Math.sin(yaw), z1 = v[0] * Math.sin(yaw) + v[2] * Math.cos(yaw);
    return [x1, v[1] * Math.cos(pitch) - z1 * Math.sin(pitch), v[1] * Math.sin(pitch) + z1 * Math.cos(pitch)];
  }
  function proj(v, cx, cy, R) { const p = 2.6 / (2.6 + v[2]); return { x: cx + v[0] * R * p, y: cy + v[1] * R * p, z: v[2], s: p }; }
  function actionColor(a) { return a === 'BUY_UP' ? '#3dffa0' : a === 'BUY_DOWN' ? '#ff4d6d' : '#ffc857'; }
  function edgeCol(hu, a) { // purple/pink/blue palette
    if (hu < 0.3) return rgba(200, 120, 255, a); if (hu < 0.72) return rgba(255, 110, 215, a);
    if (hu < 0.9) return rgba(120, 170, 255, a); return rgba(120, 240, 255, a);
  }

  function drawPlexus(cx, cy, R, yaw, pitch, I, t) {
    const P = nodes.map(n => proj(rot(n.p, yaw, pitch), cx, cy, R));
    ctx.globalCompositeOperation = 'lighter';
    // rim halo
    const g = ctx.createRadialGradient(cx, cy, R * 0.85, cx, cy, R * 1.12);
    g.addColorStop(0, 'rgba(120,80,255,0)'); g.addColorStop(0.75, rgba(120, 90, 255, 0.10 + I * 0.08)); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R * 1.12, 0, 7); ctx.fill();
    for (const e of edges) {
      const a = P[e.a], b = P[e.b], z = (a.z + b.z) / 2, front = z < 0;
      let al = (front ? 0.72 : 0.24) * (0.75 + I * 0.5); if (e.long) al *= 0.45;
      ctx.strokeStyle = e.gold ? rgba(255, 200, 60, al * 1.3) : edgeCol(e.hue, al);
      ctx.lineWidth = (front ? 1.1 : 0.6) * dpr * (e.gold ? 1.6 : 1);
      if (e.hue > 0.55 && !e.gold) { // fragmented dashes
        ctx.beginPath(); for (let k = 0; k < 3; k++) { const u0 = k / 3, u1 = u0 + 0.22;
          ctx.moveTo(a.x + (b.x - a.x) * u0, a.y + (b.y - a.y) * u0); ctx.lineTo(a.x + (b.x - a.x) * u1, a.y + (b.y - a.y) * u1); } ctx.stroke();
      } else { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
    nodes.forEach((n, i) => {
      const p = P[i], front = p.z < 0, tw = 0.6 + 0.4 * Math.sin(t * 2 + n.tw);
      const r = (n.hot ? 2.6 : 1.3) * dpr * p.s;
      ctx.fillStyle = n.hot ? rgba(255, 220, 255, 0.9 * tw) : rgba(230, 210, 255, (front ? 0.85 : 0.3) * tw);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill();
      if (n.hot && front) { const h = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 10 * dpr);
        h.addColorStop(0, rgba(255, 120, 230, 0.5 * tw)); h.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = h; ctx.fillRect(p.x - 10 * dpr, p.y - 10 * dpr, 20 * dpr, 20 * dpr); }
    });
    // faint outline + a meridian ellipse
    ctx.strokeStyle = rgba(150, 140, 255, 0.25); ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.99, 0, 7); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }

  // thick glowing cyan equator band (drawn as back half / front half)
  function ringPts(cx, cy, R, yaw, pitch, rr, tilt) {
    const pts = [];
    for (let i = 0; i <= 160; i++) { const a = i / 160 * Math.PI * 2;
      let v = [Math.cos(a) * rr, 0, Math.sin(a) * rr];
      v = [v[0] * Math.cos(tilt) - v[1] * Math.sin(tilt), v[0] * Math.sin(tilt) + v[1] * Math.cos(tilt), v[2]];
      pts.push(proj(rot(v, yaw, pitch), cx, cy, R)); }
    return pts;
  }
  function drawRing(pts, front, I, t, coreCol) {
    ctx.globalCompositeOperation = 'lighter';
    const passes = [[14, 0.06], [7, 0.16], [3.2, 0.55], [1.4, 0.95]];
    for (const [w, a] of passes) {
      ctx.lineWidth = w * dpr; ctx.lineCap = 'round';
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1]; if ((p.z < 0) !== front) continue;
        const f = front ? 1 : 0.35;
        ctx.strokeStyle = w < 2 ? rgba(220, 255, 255, a * f) : rgba(40, 230, 255, a * f * (0.8 + I * 0.4));
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      }
    }
    // travelling bright pulse
    if (front) { const k = Math.floor(((t * 0.18) % 1) * (pts.length - 1)), p = pts[k];
      if (p.z < 0) { const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 16 * dpr);
        g.addColorStop(0, 'rgba(220,255,255,0.9)'); g.addColorStop(1, 'rgba(0,200,255,0)'); ctx.fillStyle = g; ctx.fillRect(p.x - 16 * dpr, p.y - 16 * dpr, 32 * dpr, 32 * dpr); } }
    ctx.globalCompositeOperation = 'source-over';
  }

  const FUR = []; { let sd = 11; const r2 = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 420; i++) FUR.push({ a: r2() * 6.283, l: 0.03 + r2() * 0.06, d: 0.86 + r2() * 0.14, w: r2() }); }
  function drawCore(cx0, cy0, R, col, I, t) {
    const cx = cx0 - R * 0.10, cy = cy0 + R * 0.08;
    const r = R * (0.30 + 0.01 * Math.sin(t * 2.2) + I * 0.02), c = hex(col);
    ctx.globalCompositeOperation = 'lighter';
    let g = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, r * 1.9);
    g.addColorStop(0, 'rgba(255,255,255,0.28)'); g.addColorStop(0.5, 'rgba(255,255,255,0.05)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * 1.9, 0, 7); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // thin action-color outer line
    ctx.strokeStyle = rgba(c[0], c[1], c[2], 0.5 + I * 0.35); ctx.lineWidth = 1.1 * dpr;
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.08, 0, 7); ctx.stroke();
    g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.7, '#f1f2f6'); g.addColorStop(1, '#d6dae3');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * 0.94, 0, 7); ctx.fill();
    // fur strands around rim + over surface
    ctx.lineCap = 'round';
    for (const f of FUR) { const a = f.a + Math.sin(t * 0.8 + f.w * 6) * 0.03, r0 = r * f.d, r1 = r0 + r * f.l;
      const sh = 0.5 + 0.5 * Math.cos(a + 2.3);
      ctx.strokeStyle = `rgba(${215 + sh * 40 | 0},${218 + sh * 37 | 0},${228 + sh * 27 | 0},${0.55 + f.w * 0.4})`;
      ctx.lineWidth = (1.2 + f.w * 1.6) * dpr; ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.quadraticCurveTo(cx + Math.cos(a + 0.05) * (r0 + r1) / 2, cy + Math.sin(a + 0.05) * (r0 + r1) / 2, cx + Math.cos(a + 0.09) * r1, cy + Math.sin(a + 0.09) * r1); ctx.stroke(); }
    // eyes lower-left
    const blink = (t % 5) < 0.12 ? 0.15 : 1, ex = r * 0.17, ey = cy + r * 0.22;
    ctx.fillStyle = '#05060a';
    for (const s of [-1, 1]) { ctx.save(); ctx.translate(cx + s * ex - r * 0.25, ey); ctx.rotate(s * -0.18);
      ctx.beginPath(); ctx.ellipse(0, 0, r * 0.075, r * 0.2 * blink, 0, 0, 7); ctx.fill(); ctx.restore(); }
  }

  function shapePath(shape, s) {
    ctx.beginPath();
    if (shape === 'tri') { ctx.moveTo(0, -s * 1.05); ctx.quadraticCurveTo(s * 0.2, -s, s * 1.0, s * 0.6); ctx.quadraticCurveTo(s, s * 0.85, s * 0.7, s * 0.85); ctx.lineTo(-s * 0.7, s * 0.85); ctx.quadraticCurveTo(-s, s * 0.85, -s * 1.0, s * 0.6); ctx.quadraticCurveTo(-s * 0.2, -s, 0, -s * 1.05); }
    else if (shape === 'shield') { ctx.moveTo(-s * 0.9, -s * 0.7); ctx.quadraticCurveTo(0, -s * 1.1, s * 0.9, -s * 0.7); ctx.quadraticCurveTo(s * 0.95, s * 0.5, 0, s * 1.0); ctx.quadraticCurveTo(-s * 0.95, s * 0.5, -s * 0.9, -s * 0.7); }
    else if (shape === 'drop') { ctx.ellipse(0, 0, s * 0.62, s * 1.1, 0, 0, 7); }
    else if (shape === 'squircle') { ctx.roundRect(-s * 1.15, -s * 0.75, s * 2.3, s * 1.5, s * 0.6); }
    else ctx.arc(0, 0, s, 0, 7);
  }
  function bubbleText(b, active) {
    const ag = (state.agents || {})[b.id] || {};
    const st = (ag.status || '').toUpperCase();
    const detail = String(ag.detail || '').trim();
    // denser bubbles: short status lines like the desk-floor ref
    if (detail) {
      const d = detail.length > 26 ? detail.slice(0, 26) : detail;
      return d.toUpperCase();
    }
    if (st === 'RUNNING') return active ? i18n('bubble_trade', 'IN A TRADE') : i18n('bubble_live', 'LIVE');
    if (st === 'DONE') return i18n('bubble_hold', 'FILLED · HOLDING');
    if (st === 'QUEUED') return i18n('bubble_standby', 'STANDBY');
    return b.id;
  }
  function drawSpeech(p, text, col, dim) {
    if (!text) return;
    ctx.font = `600 ${7 * dpr}px monospace`; ctx.textAlign = 'center';
    const tw = Math.min(ctx.measureText(text).width + 10 * dpr, 130 * dpr);
    let bx = p.x - tw / 2, by = p.y - 34 * dpr * p.s;
    for (let k = 0; k < 5; k++) {
      const hit = placed.some(q => Math.abs(q.x - (bx + tw / 2)) < (q.w + tw) / 2 && Math.abs(q.y - by) < 12 * dpr);
      if (!hit) break; by -= 12 * dpr;
    }
    placed.push({ x: bx + tw / 2, y: by, w: tw });
    ctx.fillStyle = 'rgba(8,10,18,0.88)'; ctx.strokeStyle = hexA(col, 0.85 * dim); ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.roundRect(bx, by - 8 * dpr, tw, 12 * dpr, 3 * dpr); ctx.fill(); ctx.stroke();
    // tiny pointer
    ctx.beginPath(); ctx.moveTo(p.x - 3 * dpr, by + 4 * dpr); ctx.lineTo(p.x, by + 9 * dpr); ctx.lineTo(p.x + 3 * dpr, by + 4 * dpr);
    ctx.fillStyle = 'rgba(8,10,18,0.88)'; ctx.fill(); ctx.strokeStyle = hexA(col, 0.7 * dim); ctx.stroke();
    ctx.fillStyle = '#e8f0ff'; ctx.fillText(text, bx + tw / 2, by + 1 * dpr);
  }
  function drawBot(b, p, I, active) {
    const s = (19 + (active ? 3 : 0)) * dpr * p.s * (1 + b.pulse * 0.25);
    const dim = p.z > 0.2 ? 0.55 : 1;
    ctx.save(); ctx.translate(p.x, p.y);
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(0, 0, s * 0.5, 0, 0, s * 2.6);
    g.addColorStop(0, hexA(b.color, (0.45 + b.pulse * 0.4 + I * 0.15) * dim)); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, s * 2.6, 0, 7); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = dim;
    const c = hex(b.color), bg = ctx.createLinearGradient(0, -s, 0, s);
    bg.addColorStop(0, rgba(Math.min(255, c[0] + 60), Math.min(255, c[1] + 60), Math.min(255, c[2] + 60), 1)); bg.addColorStop(1, b.color);
    // Pac-Man ghost silhouette with scalloped skirt
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.moveTo(-s * 0.95, 0);
    ctx.bezierCurveTo(-s * 0.95, -s * 1.15, s * 0.95, -s * 1.15, s * 0.95, 0);
    const feet = 5;
    for (let i = feet; i >= 0; i--) {
      const u = i / feet;
      const fx = -s * 0.95 + u * (s * 1.9);
      const fy = s * 0.92 - ((i % 2 === 0) ? 0 : s * 0.32);
      ctx.lineTo(fx, fy);
    }
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = rgba(255,255,255,0.22 * dim); ctx.lineWidth = 1 * dpr; ctx.stroke();
    // headset
    ctx.strokeStyle = rgba(230,240,255,0.7 * dim); ctx.lineWidth = 1.6 * dpr;
    ctx.beginPath(); ctx.arc(0, -s * 0.1, s * 0.9, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    ctx.fillStyle = rgba(220,230,245,0.85 * dim);
    ctx.beginPath(); ctx.ellipse(-s * 0.92, s * 0.05, s * 0.18, s * 0.24, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(s * 0.92, s * 0.05, s * 0.18, s * 0.24, 0, 0, 7); ctx.fill();
    // eyes
    const blink = ((performance.now()/1000 + (b.phase||0)) % 4.6) < 0.12 ? 0.15 : 1;
    ctx.fillStyle = '#07090f';
    for (const k of [-1, 1]) { ctx.save(); ctx.translate(k * s * 0.26, s * 0.02); ctx.rotate(k * -0.25);
      ctx.beginPath(); ctx.ellipse(0, 0, s * 0.11, s * 0.26 * blink, 0, 0, 7); ctx.fill(); ctx.restore(); }
    ctx.globalAlpha = 1; ctx.restore();
    // speech bubble (status) above, name chip below
    drawSpeech(p, bubbleText(b, active), b.color, dim);
    ctx.font = `600 ${7.5 * dpr}px monospace`; ctx.textAlign = 'center';
    const tw = ctx.measureText(b.id).width + 8 * dpr; let ly = p.y + s * 1.25 + 9 * dpr;
    for (let k = 0; k < 6; k++) { const hit = placed.some(q => Math.abs(q.x - p.x) < (q.w + tw) / 2 && Math.abs(q.y - ly) < 12 * dpr); if (!hit) break; ly += 12 * dpr; }
    placed.push({ x: p.x, y: ly, w: tw });
    ctx.fillStyle = 'rgba(4,6,14,0.75)'; ctx.strokeStyle = hexA(b.color, 0.7 * dim); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(p.x - tw / 2, ly - 8 * dpr, tw, 11 * dpr, 2 * dpr); ctx.fill(); ctx.stroke();
    ctx.fillStyle = hexA(b.color, dim); ctx.fillText(b.id, p.x, ly);
  }

  function fmt(v, f) { return (v == null || v === '' || !isFinite(Number(v))) ? null : f(Number(v)); }
  function card(x, y, ax, ay, title, rows, col) {
    rows = rows.filter(r => r[1] != null); if (!rows.length) return;
    const fs = 7.5 * dpr, lh = 10 * dpr, wd = 92 * dpr, ht = (rows.length + 1) * lh + 6 * dpr;
    ctx.strokeStyle = hexA(col, 0.6); ctx.lineWidth = 1 * dpr; ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(x + (x < ax ? wd : 0), y + ht / 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = hexA(col, 1); ctx.beginPath(); ctx.arc(ax, ay, 2 * dpr, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(5,7,16,0.82)'; ctx.strokeStyle = hexA(col, 0.8);
    ctx.beginPath(); ctx.roundRect(x, y, wd, ht, 3 * dpr); ctx.fill(); ctx.stroke();
    ctx.font = `600 ${fs}px monospace`; ctx.textAlign = 'left'; ctx.fillStyle = hexA(col, 1); ctx.fillText(title, x + 5 * dpr, y + lh);
    rows.forEach((r, i) => { ctx.fillStyle = 'rgba(170,180,200,0.85)'; ctx.textAlign = 'left'; ctx.fillText(r[0], x + 5 * dpr, y + lh * (i + 2));
      ctx.fillStyle = r[2] || '#e8f6ff'; ctx.textAlign = 'right'; ctx.fillText(r[1], x + wd - 5 * dpr, y + lh * (i + 2)); });
  }
  function drawCards(cx, cy, R, w, h, sig, coreCol) {
    const m = state.market || {}, up = sig.up_price != null ? sig.up_price : m.up_price, dn = sig.down_price != null ? sig.down_price : m.down_price;
    const sgn = v => (v >= 0 ? '+' : '') ;
    const L_MODEL = i18n('card_model', 'MODEL');
    const L_MARKET = i18n('card_market', 'MARKET');
    const L_SIGNAL = i18n('card_signal', 'SIGNAL');
    const L_SPOT = i18n('card_spot', 'SPOT');
    card(cx + R * 0.80, cy + R * 0.58, cx + R * 0.80, cy + R * 0.30, (sig.model_up_cents != null ? L_MODEL + ' ' + Number(sig.model_up_cents).toFixed(1) + '¢' : L_MARKET), [
      ['UP', fmt(up, v => (v * 100).toFixed(1) + '¢')], ['DOWN', fmt(dn, v => (v * 100).toFixed(1) + '¢')],
      [L_MODEL, fmt(sig.model_up_cents, v => v.toFixed(1) + '¢'), '#ffc857'],
      ['M-MKT', fmt(sig.model_edge_up_cents, v => sgn(v) + v.toFixed(1) + '¢'), sig.model_edge_up_cents >= 0 ? '#3dffa0' : '#ff4d6d'],
      ['EDGE', fmt(sig.price_edge, v => sgn(v) + (v * 100).toFixed(1) + '¢'), '#3dffa0']], '#ffc857');
    card(cx - R * 1.02 - 92 * dpr * 0, cy - R * 0.92, cx - R * 0.62, cy - R * 0.62, L_SIGNAL, [
      ['λ', fmt(sig.intensity_n, v => v.toFixed(2))], ['CONF', fmt(sig.confidence, v => (v * 100).toFixed(0) + '%')],
      ['ACT', sig.action || null, coreCol]], '#3ce6ff');
    card(cx + R * 0.62, cy - R * 0.98, cx + R * 0.55, cy - R * 0.75, L_SPOT, [
      ['Δ OPEN', fmt(sig.spot_vs_open, v => sgn(v) + v.toFixed(1)), sig.spot_vs_open >= 0 ? '#3dffa0' : '#ff4d6d'],
      ['T-', fmt(sig.seconds_to_resolution != null ? sig.seconds_to_resolution : state.seconds_to_resolution, v => Math.floor(v / 60) + ':' + String(Math.floor(v % 60)).padStart(2, '0'))]], '#ff6fd8');
  }
  function drawHandoffTags(BP, cx, cy, R) {
    const now = (state.ts || (Date.now() / 1000));
    const recent = (state.handoffs || []).filter(h => !h.ts || (now - h.ts) < 18).slice(0, 3);
    const list = recent.length ? recent : (state.handoffs || []).slice(0, 2);
    list.forEach((hf, i) => {
      const A = BP.find(o => o.b.id === hf.from), B = BP.find(o => o.b.id === hf.to); if (!A || !B) return;
      let mx = (A.p.x + B.p.x) / 2, my = Math.min(A.p.y, B.p.y) - R * 0.28 - i * 14 * dpr;
      if (Math.abs(mx - cx) < R * 0.35 && Math.abs(my - cy) < R * 0.35) { my = cy - R * 0.55 - i * 14 * dpr; }
      const txt = hf.from + ' → ' + hf.to + (hf.note ? ' · ' + String(hf.note).toUpperCase() : '');
      ctx.font = `700 ${7.5 * dpr}px monospace`; const tw = ctx.measureText(txt).width + 10 * dpr;
      const tx = Math.max(4 * dpr, Math.min(canvas.width - tw - 4 * dpr, mx - tw / 2)), ty = my;
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = hexA(A.b.color, 0.75); ctx.lineWidth = 1.4 * dpr;
      ctx.beginPath(); ctx.moveTo(A.p.x, A.p.y); ctx.quadraticCurveTo(tx + tw / 2, ty + 8 * dpr, B.p.x, B.p.y); ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(5,7,16,0.92)'; ctx.strokeStyle = hexA(B.b.color, 1);
      ctx.lineWidth = 1.2 * dpr;
      ctx.beginPath(); ctx.roundRect(tx, ty - 8 * dpr, tw, 13 * dpr, 3 * dpr); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left'; ctx.fillText(txt, tx + 5 * dpr, ty + 2 * dpr);
    });
  }
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!canvas || !ctx) return;
    resize();
    const w = canvas.width, h = canvas.height, t = (now - t0) / 1000;
    const sig = state.signal || {};
    const I = Math.max(0, Math.min(1, Number(sig.intensity_n != null ? sig.intensity_n : 0.35)));
    const coreCol = actionColor(sig.action || 'HOLD'), sp = 0.5 + I * 1.2;
    const cx = w / 2, cy = h * 0.5, R = Math.min(w * 0.40, h * 0.49);
    ctx.clearRect(0, 0, w, h); placed = [];
    // deep space bg + dust
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.7);
    bg.addColorStop(0, '#0b0820'); bg.addColorStop(1, '#020309'); ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 70; i++) { ctx.fillStyle = `rgba(160,190,255,${0.08 + (i % 5) * 0.05})`;
      ctx.fillRect(((Math.sin(i * 12.9) * 0.5 + 0.5) * w) | 0, ((Math.cos(i * 7.3) * 0.5 + 0.5) * h) | 0, dpr, dpr); }

    const yaw = t * 0.12 * sp, pitch = 0.32 + 0.03 * Math.sin(t * 0.3) + Number(sig.bias || 0) * 0.08;
    const ring = ringPts(cx, cy, R, -t * 0.25 * sp, 0.30, 1.12, -0.08);

    // bots in 3D orbit
    const ag = state.agents || {};
    const BP = bots.map(b => {
      const active = (ag[b.id] && ag[b.id].status) === 'RUNNING';
      b.pulse = Math.max(0, b.pulse - 0.015); if (active) b.pulse = Math.min(1, b.pulse + 0.05);
      const a = b.phase + t * b.speed * 0.35 * sp;
      const rr = b.rr * (1 + b.ecc * Math.cos(a + b.tilt * 2)) ;
      let v0 = [Math.cos(a) * rr, Math.sin(a) * rr * Math.sin(b.inc), Math.sin(a) * rr * Math.cos(b.inc)];
      let v = [v0[0] * Math.cos(b.tilt * 0.4) - v0[1] * Math.sin(b.tilt * 0.4), v0[0] * Math.sin(b.tilt * 0.4) + v0[1] * Math.cos(b.tilt * 0.4), v0[2]];
      const p = proj(rot(v, 0, 0.18), cx, cy, R);
      // gentle vertical bob (desk-floor ghost hover)
      const bob = Math.sin(t * 2.1 + b.phase * 1.7) * (5.5 * dpr) + Math.sin(t * 3.4 + b.phase) * (2.2 * dpr);
      p.y += bob;
      const lim = h * 0.70; if (p.y > lim) p.y = lim - (p.y - lim) * 0.15; return { b, p, active };
    });

    drawRing(ring, false, I, t, coreCol);
    BP.filter(o => o.p.z >= 0).forEach(o => drawBot(o.b, o.p, I, o.active));
    drawPlexus(cx, cy, R, yaw, pitch, I, t);
    // connectors: bot -> core (cyan/pink curves), plus incoming feed lines from left edge
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 6; i++) { const y = h * (0.15 + i * 0.14), ex = cx - R * 0.95, ey = cy + (y - cy) * 0.6;
      ctx.strokeStyle = i % 2 ? rgba(255, 80, 200, 0.35) : rgba(60, 220, 255, 0.35); ctx.lineWidth = 1 * dpr;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.bezierCurveTo(w * 0.12, y, ex - R * 0.3, ey, ex, ey); ctx.stroke();
      const u = (t * 0.4 + i * 0.17) % 1; ctx.fillStyle = 'rgba(220,250,255,0.9)';
      ctx.beginPath(); ctx.arc(u * ex, y + (ey - y) * u * u, 1.6 * dpr, 0, 7); ctx.fill(); }
    BP.forEach(({ b, p, active }) => {
      ctx.strokeStyle = hexA(b.color, active || b.pulse > 0.3 ? 0.6 : 0.2); ctx.lineWidth = (active ? 1.6 : 0.9) * dpr;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.quadraticCurveTo((p.x + cx) / 2, (p.y + cy) / 2 - R * 0.15, cx, cy); ctx.stroke(); });
    // handoff sparks
    for (let i = sparks.length - 1; i >= 0; i--) { const s = sparks[i]; s.u += 0.02;
      const A = BP.find(o => o.b.id === s.from), B = BP.find(o => o.b.id === s.to);
      if (!A || !B || s.u > 1) { sparks.splice(i, 1); continue; } if (s.u < 0) continue;
      const x = A.p.x + (B.p.x - A.p.x) * s.u, y = A.p.y + (B.p.y - A.p.y) * s.u - Math.sin(s.u * Math.PI) * R * 0.25;
      ctx.fillStyle = hexA(s.col, 1 - s.u * 0.5); ctx.beginPath(); ctx.arc(x, y, 2.4 * dpr, 0, 7); ctx.fill(); }
    ctx.globalCompositeOperation = 'source-over';
    drawCore(cx, cy, R, coreCol, I, t);
    drawRing(ring, true, I, t, coreCol);
    { const ax = cx + R * 0.86, ay = cy + R * 0.10; ctx.globalCompositeOperation = 'lighter';
      for (const [lw, al] of [[9, 0.10], [4, 0.3], [1.8, 0.95]]) { ctx.strokeStyle = rgba(255, 190, 40, al); ctx.lineWidth = lw * dpr;
        ctx.beginPath(); ctx.ellipse(ax - R * 0.12, ay + R * 0.05, R * 0.16, R * 0.42, 0, -0.9, 1.25); ctx.stroke(); }
      ctx.globalCompositeOperation = 'source-over'; }
    BP.filter(o => o.p.z < 0).sort((a, b) => b.p.z - a.p.z).forEach(o => drawBot(o.b, o.p, I, o.active));
    drawCards(cx, cy, R, w, h, sig, coreCol);
    drawHandoffTags(BP, cx, cy, R);
  }
  function start(el) {
    canvas = el || document.getElementById('armillary'); if (!canvas) return;
    ctx = canvas.getContext('2d'); resize(); if (raf) cancelAnimationFrame(raf);
    t0 = performance.now(); raf = requestAnimationFrame(frame); window.addEventListener('resize', resize);
  }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
  global.MindViz = { start, stop, setState };
})(window);
