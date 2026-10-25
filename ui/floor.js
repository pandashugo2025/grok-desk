/**
 * Desk Floor — isometric 2D office for GROK DESK SWARM GRID (mind34).
 * FloorViz.start(canvas) / stop() / setState(s) / onSelect(cb)
 */
(function (global) {
  'use strict';
  const AGENTS = [
    { id: 'EDGE',    color: '#ff4dcf', desk: [1.05, 0.90], phase: 0.2 },
    { id: 'CLOSER',  color: '#ff8a3d', desk: [3.25, 0.90], phase: 1.1 },
    { id: 'PRIOR',   color: '#c9a227', desk: [5.45, 0.90], phase: 2.0 },
    { id: 'TAKER',   color: '#4d8cff', desk: [1.05, 3.20], phase: 2.9 },
    { id: 'SPOTTER', color: '#2dd4bf', desk: [3.25, 3.20], phase: 3.8 },
    { id: 'KELLY',   color: '#a855f7', desk: [5.45, 3.20], phase: 4.7 },
  ];

  let canvas, ctx, raf = 0, dpr = 1, fit = 1, t0 = performance.now();
  let state = { agents: {}, signal: {}, portfolio: {}, handoffs: [], market: {} };
  let hits = [];
  let labelSlots = [];
  let selectCb = null;
  let TW = 52, TH = 26, TZ = 23;
  let candleBuf = null;

  const rgba = (r, g, b, a) => `rgba(${r},${g},${b},${a})`;
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const hexA = (h, a) => { const c = hex(h); return rgba(c[0], c[1], c[2], a); };
  function i18n(key, fallback) {
    try {
      if (global.DeskI18n && typeof global.DeskI18n.t === 'function') {
        const v = global.DeskI18n.t(key);
        if (v && v !== key) return v;
      }
    } catch (_) {}
    return fallback;
  }
  function isZh() { return !(global.DeskI18n && global.DeskI18n.lang === 'en'); }

  function iso(x, y, z) {
    return { x: (x - y) * TW, y: (x + y) * TH - (z || 0) * TZ };
  }
  function worldToScreen(x, y, z) {
    const o = origin();
    const p = iso(x, y, z);
    return { x: o.x + p.x, y: o.y + p.y };
  }
  function origin() {
    // Room spans x in [-6*TW .. +8*TW] (midpoint +1*TW) and y in [-2.55*TZ .. +14*TH]
    const hudTop = 28 * dpr;
    const capBot = 22 * dpr;
    const availH = Math.max(160 * dpr, canvas.height - hudTop - capBot);
    const roomH = 2.55 * TZ + 14 * TH;
    const topPad = hudTop + Math.max(0, (availH - roomH) * 0.48);
    return {
      x: canvas.width * 0.5 - TW,
      y: topPad + 2.55 * TZ,
    };
  }

  function resize() {
    if (!canvas) return;
    let r = canvas.getBoundingClientRect();
    if ((r.width < 40 || r.height < 40) && canvas.parentElement)
      r = canvas.parentElement.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(320, (Math.max(r.width, 320) * dpr) | 0);
    const h = Math.max(220, (Math.max(r.height, 220) * dpr) | 0);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const availW = Math.max(260 * dpr, w - 36 * dpr);
    const availH = Math.max(160 * dpr, h - 50 * dpr);
    // 14*52 = 728 horiz span; 14*26 + 2.55*23 = 422.65 vert span
    fit = Math.min(availW / 748, availH / 436);
    TW = 52 * fit;
    TH = 26 * fit;
    TZ = 23 * fit;
  }

  function setState(s) { if (s) state = s; }
  function onSelect(cb) { selectCb = cb; }

  // ---- primitives ----
  function drawTile(x, y, fill, stroke) {
    const a = worldToScreen(x, y, 0);
    const b = worldToScreen(x + 1, y, 0);
    const c = worldToScreen(x + 1, y + 1, 0);
    const d = worldToScreen(x, y + 1, 0);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1 * dpr; ctx.stroke(); }
  }

  function box(x, y, w, d, h, top, left, right, edge) {
    const p000 = worldToScreen(x, y, 0);
    const p100 = worldToScreen(x + w, y, 0);
    const p010 = worldToScreen(x, y + d, 0);
    const p110 = worldToScreen(x + w, y + d, 0);
    const p001 = worldToScreen(x, y, h);
    const p101 = worldToScreen(x + w, y, h);
    const p011 = worldToScreen(x, y + d, h);
    const p111 = worldToScreen(x + w, y + d, h);
    // left face (y+ front-left)
    ctx.beginPath(); ctx.moveTo(p011.x, p011.y); ctx.lineTo(p111.x, p111.y); ctx.lineTo(p110.x, p110.y); ctx.lineTo(p010.x, p010.y); ctx.closePath();
    ctx.fillStyle = left; ctx.fill();
    // right face (x+ front-right)
    ctx.beginPath(); ctx.moveTo(p101.x, p101.y); ctx.lineTo(p111.x, p111.y); ctx.lineTo(p110.x, p110.y); ctx.lineTo(p100.x, p100.y); ctx.closePath();
    ctx.fillStyle = right; ctx.fill();
    // top face
    ctx.beginPath(); ctx.moveTo(p001.x, p001.y); ctx.lineTo(p101.x, p101.y); ctx.lineTo(p111.x, p111.y); ctx.lineTo(p011.x, p011.y); ctx.closePath();
    ctx.fillStyle = top; ctx.fill();
    ctx.strokeStyle = edge || 'rgba(57,255,135,0.16)'; ctx.lineWidth = 1 * dpr;
    ctx.stroke();
    return { p001, p101, p011, p111, p000, p100, p010, p110 };
  }

  function ensureCandles() {
    if (candleBuf && candleBuf.length) return candleBuf;
    candleBuf = [];
    let p = 0.5;
    for (let i = 0; i < 24; i++) {
      const drift = (Math.random() - 0.48) * 0.06;
      const o = p, c = Math.max(0.14, Math.min(0.86, p + drift));
      const hi = Math.max(o, c) + Math.random() * 0.04;
      const lo = Math.min(o, c) - Math.random() * 0.04;
      candleBuf.push({ o, c, hi, lo });
      p = c;
    }
    return candleBuf;
  }

  function drawRoom() {
    const neon = 'rgba(57,255,135,0.34)';
    for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) {
      const shade = ((x + y) & 1) ? 'rgba(14,18,24,0.96)' : 'rgba(9,12,17,0.96)';
      drawTile(x, y, shade, 'rgba(57,255,135,0.055)');
    }
    const a = worldToScreen(0, 0, 0), b = worldToScreen(8, 0, 0);
    const a2 = worldToScreen(0, 0, 2.55), b2 = worldToScreen(8, 0, 2.55);
    const c = worldToScreen(0, 6, 0), c2 = worldToScreen(0, 6, 2.55);
    const d = worldToScreen(8, 6, 0);

    // back wall (y=0, x=0..8, z=0..2.55)
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(b2.x, b2.y); ctx.lineTo(a2.x, a2.y); ctx.closePath();
    const wg = ctx.createLinearGradient(a.x, a2.y, a.x, b.y);
    wg.addColorStop(0, 'rgba(13,18,26,0.97)'); wg.addColorStop(1, 'rgba(7,10,15,0.95)');
    ctx.fillStyle = wg; ctx.fill();
    ctx.strokeStyle = neon; ctx.lineWidth = 1.4 * dpr; ctx.stroke();

    // left wall (x=0, y=0..6, z=0..2.55)
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.lineTo(c2.x, c2.y); ctx.lineTo(a2.x, a2.y); ctx.closePath();
    ctx.fillStyle = 'rgba(6,9,14,0.94)'; ctx.fill();
    ctx.strokeStyle = 'rgba(57,255,135,0.22)'; ctx.lineWidth = 1.2 * dpr; ctx.stroke();

    // subtle front floor rim
    ctx.strokeStyle = 'rgba(57,255,135,0.20)';
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.lineTo(b.x, b.y);
    ctx.stroke();

    // left wall subtle watermark sheared onto left wall plane
    const wl0 = worldToScreen(0.04, 1.0, 2.15);
    const wl1 = worldToScreen(0.04, 3.6, 2.15);
    const dx = wl1.x - wl0.x, dy = wl1.y - wl0.y;
    if (Math.abs(dx) > 20 * dpr) {
      ctx.save();
      ctx.translate(wl0.x, wl0.y);
      ctx.transform(-1, -dy / dx, 0, 1, 0, 0);
      // Wait: keep text left-to-right along left wall going down-left:
      ctx.restore();
      ctx.save();
      const wlStart = worldToScreen(0.04, 3.8, 1.95);
      ctx.translate(wlStart.x, wlStart.y);
      ctx.transform(1, -TH / TW, 0, 1, 0, 0);
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#39ff87';
      ctx.font = `800 ${Math.max(6, 7.5 * fit)}px monospace`;
      ctx.textAlign = 'left';
      ctx.fillText('THE_GROK_FLOOR', 0, 0);
      ctx.font = `600 ${Math.max(5, 5.5 * fit)}px monospace`;
      ctx.fillText(isZh() ? '紙上 · 六桌線上' : 'PAPER · 6 DESKS LIVE', 0, 10 * fit);
      ctx.restore();
    }
  }

  /**
   * Helper to render a screen mounted on the back wall (y=0.05) with proper isometric shear + strict clip.
   */
  function drawBackWallScreen(x0, x1, z0, z1, borderCol, drawInner) {
    const sy = 0.05;
    const bl = worldToScreen(x0, sy, z0);
    const br = worldToScreen(x1, sy, z0);
    const tl = worldToScreen(x0, sy, z1);
    const tr = worldToScreen(x1, sy, z1);
    const W = tr.x - tl.x;
    const H = bl.y - tl.y;
    if (W < 8 || H < 8) return;

    // bezel shadow / frame
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.fillStyle = '#040810';
    ctx.fill();
    ctx.strokeStyle = borderCol;
    ctx.lineWidth = 1.4 * dpr;
    ctx.stroke();

    // clip to inner screen and shear to back wall plane
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.clip();
    const slope = (tr.y - tl.y) / W;
    ctx.transform(1, slope, 0, 1, tl.x, tl.y);
    drawInner(W, H);
    ctx.restore();
  }

  function drawWallScreens(t) {
    const slug = ((state.market || {}).slug || 'BTC-UPDOWN-5M').toString().slice(0, 16).toUpperCase();
    const pnl = Number((state.portfolio || {}).pnl_total || 0);
    const eq = Number((state.portfolio || {}).equity || 10000);
    const pct = eq ? (pnl / Math.max(1, eq - pnl)) * 100 : 0;

    // 1) Left back-wall screen: SCAN
    drawBackWallScreen(0.38, 1.98, 0.58, 2.18, hexA('#39ff87', 0.55), (W, H) => {
      ctx.fillStyle = '#39ff87';
      ctx.font = `700 ${Math.max(6, 6.8 * fit)}px monospace`;
      ctx.textAlign = 'left';
      ctx.fillText('SCAN', 5 * fit, 10 * fit);
      const nBars = 9;
      const bw = Math.max(2 * fit, (W - 12 * fit) / (nBars * 1.55));
      for (let k = 0; k < nBars; k++) {
        const u = (k + 0.5) / nBars;
        const x = 6 * fit + (W - 12 * fit) * u;
        const hgt = (0.22 + 0.52 * (0.5 + 0.5 * Math.sin(t * 1.8 + k * 0.7))) * (H - 16 * fit);
        ctx.fillStyle = Math.sin(t + k) >= 0 ? '#39ff87' : '#ff5d7a';
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x - bw * 0.5, H - 4 * fit - hgt, bw, hgt);
      }
      ctx.globalAlpha = 1;
    });

    // 2) Center main back-wall screen: Candles + PnL
    drawBackWallScreen(2.22, 5.48, 0.42, 2.32, 'rgba(57,255,135,0.72)', (W, H) => {
      const candles = ensureCandles();
      const n = candles.length;
      const cw = W / (n + 2);
      const up = Number((state.signal || {}).up_price || 0.5);
      const last = candles[n - 1];
      const liveC = Math.max(0.14, Math.min(0.86, last.o + (up - 0.5) * 0.32 + Math.sin(t * 1.6) * 0.015));

      for (let i = 0; i < n; i++) {
        const cndl = candles[i];
        const o = cndl.o, c = (i === n - 1) ? liveC : cndl.c;
        const hi = Math.max(o, c, cndl.hi), lo = Math.min(o, c, cndl.lo);
        const x = (i + 1.2) * cw;
        const yHi = (1 - hi) * H * 0.72 + H * 0.20;
        const yLo = (1 - lo) * H * 0.72 + H * 0.20;
        const yO = (1 - o) * H * 0.72 + H * 0.20;
        const yC = (1 - c) * H * 0.72 + H * 0.20;
        const bull = c >= o;
        ctx.strokeStyle = bull ? '#39ff87' : '#ff5d7a';
        ctx.lineWidth = Math.max(1, 1 * fit);
        ctx.beginPath(); ctx.moveTo(x, yHi); ctx.lineTo(x, yLo); ctx.stroke();
        const bodyTop = Math.min(yO, yC), bodyH = Math.max(1.8 * fit, Math.abs(yC - yO));
        ctx.fillStyle = bull ? '#39ff87' : '#ff5d7a';
        ctx.fillRect(x - cw * 0.28, bodyTop, cw * 0.56, bodyH);
      }

      // clean backdrop behind top-left text so candles never make text muddy
      ctx.fillStyle = 'rgba(3,6,11,0.78)';
      ctx.fillRect(3 * fit, 3 * fit, Math.min(W - 6 * fit, 98 * fit), Math.min(H - 6 * fit, 32 * fit));

      ctx.fillStyle = '#e8fff4';
      ctx.font = `800 ${Math.max(6.5, 7.8 * fit)}px monospace`;
      ctx.textAlign = 'left';
      ctx.fillText(slug, 6 * fit, 11.5 * fit);

      ctx.fillStyle = pnl >= 0 ? '#39ff87' : '#ff5d7a';
      ctx.font = `800 ${Math.max(7.5, 9.5 * fit)}px monospace`;
      const pnlTxt = (pnl >= 0 ? '+' : '') + pct.toFixed(2) + '%';
      ctx.fillText(pnlTxt, 6 * fit, 22 * fit);

      ctx.fillStyle = 'rgba(190,210,230,0.82)';
      ctx.font = `600 ${Math.max(5.5, 6.4 * fit)}px monospace`;
      ctx.fillText((pnl >= 0 ? '+' : '-') + '$' + Math.abs(pnl).toFixed(2) + ' PAPER', 6 * fit, 31 * fit);
    });

    // 3) Right back-wall screen: FLOW + PAPER rules (unified so nothing clips or overlaps)
    drawBackWallScreen(5.72, 7.62, 0.58, 2.18, hexA('#ff4dcf', 0.60), (W, H) => {
      ctx.fillStyle = '#ff4dcf';
      ctx.font = `700 ${Math.max(6, 6.8 * fit)}px monospace`;
      ctx.textAlign = 'left';
      ctx.fillText('FLOW', 5 * fit, 10 * fit);

      // left half: flow bars
      const flowW = W * 0.46;
      const nBars = 6;
      const bw = Math.max(2 * fit, (flowW - 8 * fit) / (nBars * 1.55));
      for (let k = 0; k < nBars; k++) {
        const u = (k + 0.5) / nBars;
        const x = 5 * fit + (flowW - 8 * fit) * u;
        const hgt = (0.22 + 0.52 * (0.5 + 0.5 * Math.sin(t * 1.9 + k * 0.8 + 1))) * (H - 16 * fit);
        ctx.fillStyle = Math.sin(t + k + 1) >= 0 ? '#ff4dcf' : '#4de0ff';
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x - bw * 0.5, H - 4 * fit - hgt, bw, hgt);
      }
      ctx.globalAlpha = 1;

      // divider
      ctx.strokeStyle = 'rgba(57,255,135,0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(W * 0.50, 4 * fit);
      ctx.lineTo(W * 0.50, H - 4 * fit);
      ctx.stroke();

      // right half: paper rules
      const rules = isZh()
        ? ['紙上規則', '僅模擬', '無金鑰', '無下單']
        : ['6 RULES', 'PAPER', 'NO KEYS', 'NO CLOB'];
      ctx.font = `700 ${Math.max(5.2, 5.8 * fit)}px monospace`;
      rules.forEach((line, idx) => {
        ctx.fillStyle = idx === 0 ? '#39ff87' : 'rgba(200,216,234,0.82)';
        ctx.fillText(line, W * 0.54, (10 + idx * 7.2) * fit);
      });
    });
  }

  function drawDesk(ax, ay, col, id) {
    // legs
    box(ax + 0.08, ay + 0.08, 0.16, 0.16, 0.46, '#1a2230', '#10161e', '#0c1218', 'rgba(0,0,0,0)');
    box(ax + 1.24, ay + 0.08, 0.16, 0.16, 0.46, '#1a2230', '#10161e', '#0c1218', 'rgba(0,0,0,0)');
    // desk surface
    box(ax, ay, 1.50, 0.90, 0.50, '#2a3648', '#171e2a', '#111722', hexA(col, 0.32));
    // keyboard
    box(ax + 0.34, ay + 0.44, 0.66, 0.28, 0.54, '#1a222e', '#121820', '#0e141c', 'rgba(255,255,255,0.06)');
    // glowing mouse
    const mp = worldToScreen(ax + 1.16, ay + 0.58, 0.54);
    ctx.fillStyle = hexA(col, 0.92);
    ctx.beginPath(); ctx.ellipse(mp.x, mp.y, 3.2 * fit, 2.0 * fit, 0.3, 0, 7); ctx.fill();

    // monitor housing on desk
    box(ax + 0.22, ay + 0.10, 0.92, 0.12, 1.12, '#0c121c', '#070b12', '#090e16', hexA(col, 0.38));
    const s0 = worldToScreen(ax + 0.28, ay + 0.23, 0.58);
    const s1 = worldToScreen(ax + 1.08, ay + 0.23, 0.58);
    const s2 = worldToScreen(ax + 1.08, ay + 0.23, 1.08);
    const s3 = worldToScreen(ax + 0.28, ay + 0.23, 1.08);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(s3.x, s3.y); ctx.lineTo(s2.x, s2.y); ctx.lineTo(s1.x, s1.y); ctx.lineTo(s0.x, s0.y);
    ctx.closePath();
    ctx.fillStyle = '#050a10'; ctx.fill();
    ctx.strokeStyle = hexA(col, 0.72); ctx.lineWidth = 1 * dpr; ctx.stroke();
    ctx.clip();

    // screen wave interpolated along isometric monitor slope
    const ag = (state.agents || {})[id] || {};
    const active = String(ag.status || '').toUpperCase() === 'RUNNING';
    const mH = s0.y - s3.y;
    ctx.strokeStyle = active ? col : '#cfe8ff';
    ctx.lineWidth = Math.max(1, 1.2 * fit);
    ctx.beginPath();
    for (let i = 0; i < 12; i++) {
      const u = i / 11;
      const x = s3.x + (s2.x - s3.x) * u;
      const topY = s3.y + (s2.y - s3.y) * u;
      const y = topY + mH * (0.52 + 0.26 * Math.sin(performance.now() / 380 + i * 0.55 + ax * 2));
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    // chair in front of desk
    box(ax + 0.46, ay + 1.02, 0.52, 0.44, 0.36, '#222a36', '#141a24', '#0e131c');
    box(ax + 0.46, ay + 1.02, 0.52, 0.12, 0.62, '#2a3342', '#181e28', '#121820');

    const c = worldToScreen(ax + 0.75, ay + 0.55, 0.8);
    hits.push({ id, x: c.x, y: c.y, r: 42 * fit });
  }

  function drawPlant(x, y) {
    box(x, y, 0.32, 0.32, 0.28, '#3a2a18', '#241810', '#1a120c', 'rgba(255,200,100,0.15)');
    const p = worldToScreen(x + 0.16, y + 0.16, 0.28);
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i - 2.5) * 0.38;
      const g = ctx.createLinearGradient(p.x, p.y, p.x, p.y - 15 * fit);
      g.addColorStop(0, '#1a5c34'); g.addColorStop(1, '#3dff8a');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(p.x + Math.cos(a) * 5.5 * fit, p.y - 9.5 * fit + Math.sin(a) * 1.8 * fit, 3.6 * fit, 8.8 * fit, a, 0, 7);
      ctx.fill();
    }
  }

  function drawSofa(x, y) {
    box(x, y, 1.75, 0.68, 0.34, '#1e2530', '#131820', '#0e131a');
    box(x + 0.08, y + 0.08, 0.78, 0.50, 0.42, '#2a3340', '#1a222c', '#141a22', 'rgba(100,120,150,0.2)');
    box(x + 0.90, y + 0.08, 0.78, 0.50, 0.42, '#2a3340', '#1a222c', '#141a22', 'rgba(100,120,150,0.2)');
    box(x, y, 1.75, 0.16, 0.68, '#262e3a', '#161c26', '#10151c');
    box(x + 0.48, y + 0.96, 0.75, 0.44, 0.24, '#3a2c1e', '#241810', '#1a120c', 'rgba(255,180,80,0.15)');
    const mug = worldToScreen(x + 0.78, y + 1.15, 0.28);
    ctx.fillStyle = '#e8eef5';
    ctx.beginPath(); ctx.ellipse(mug.x, mug.y, 2.8 * fit, 1.8 * fit, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#39ff87';
    ctx.beginPath(); ctx.ellipse(mug.x, mug.y, 1.6 * fit, 1.0 * fit, 0, 0, 7); ctx.fill();
  }

  function drawRocket(x, y, t) {
    box(x, y, 0.50, 0.50, 0.20, '#2a3038', '#161a20', '#0e1216');
    const ring = worldToScreen(x + 0.25, y + 0.25, 0.22);
    ctx.strokeStyle = 'rgba(255,138,61,0.55)'; ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath(); ctx.ellipse(ring.x, ring.y, 9.5 * fit, 4 * fit, 0, 0, 7); ctx.stroke();
    const bob = 0.05 * Math.sin(t * 2.2);
    const tip = worldToScreen(x + 0.25, y + 0.25, 1.28 + bob);
    const mid = worldToScreen(x + 0.25, y + 0.25, 0.36);
    const bodyG = ctx.createLinearGradient(mid.x, tip.y, mid.x, mid.y);
    bodyG.addColorStop(0, '#ffffff'); bodyG.addColorStop(1, '#9aa8bc');
    ctx.fillStyle = bodyG;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(mid.x - 7 * fit, mid.y);
    ctx.lineTo(mid.x + 7 * fit, mid.y);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#4de0ff';
    ctx.beginPath(); ctx.arc(mid.x, (tip.y + mid.y) * 0.55, 2.4 * fit, 0, 7); ctx.fill();
    ctx.fillStyle = '#ff4d6d';
    ctx.beginPath(); ctx.moveTo(mid.x - 7 * fit, mid.y); ctx.lineTo(mid.x - 11 * fit, mid.y + 9 * fit); ctx.lineTo(mid.x - 2 * fit, mid.y); ctx.fill();
    ctx.beginPath(); ctx.moveTo(mid.x + 7 * fit, mid.y); ctx.lineTo(mid.x + 11 * fit, mid.y + 9 * fit); ctx.lineTo(mid.x + 2 * fit, mid.y); ctx.fill();
    const flick = 3 * Math.sin(t * 14) * fit;
    ctx.fillStyle = rgba(255, 180, 40, 0.75 + 0.25 * Math.sin(t * 10));
    ctx.beginPath();
    ctx.moveTo(mid.x - 4 * fit, mid.y + 1.5 * fit);
    ctx.lineTo(mid.x, mid.y + 11 * fit + flick);
    ctx.lineTo(mid.x + 4 * fit, mid.y + 1.5 * fit);
    ctx.fill();
  }

  function drawRadar(x, y, t) {
    box(x, y, 0.52, 0.52, 0.26, '#1c2430', '#10161e', '#0c1218');
    const pole = worldToScreen(x + 0.26, y + 0.26, 0.72);
    ctx.strokeStyle = 'rgba(160,180,200,0.7)'; ctx.lineWidth = 1.6 * dpr;
    ctx.beginPath(); ctx.moveTo(pole.x, pole.y + 7 * fit); ctx.lineTo(pole.x, pole.y - 3 * fit); ctx.stroke();
    ctx.save();
    ctx.translate(pole.x, pole.y - 2 * fit);
    ctx.rotate(t * 1.35);
    ctx.fillStyle = 'rgba(210,225,240,0.9)';
    ctx.beginPath(); ctx.ellipse(0, 0, 12.5 * fit, 5.5 * fit, 0.15, 0, 7); ctx.fill();
    ctx.strokeStyle = '#4de0ff'; ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath(); ctx.ellipse(0, 0, 12.5 * fit, 5.5 * fit, 0.15, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(15 * fit, -1.5 * fit); ctx.stroke();
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 15 * fit);
    g.addColorStop(0, 'rgba(77,224,255,0.38)'); g.addColorStop(1, 'rgba(77,224,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 15 * fit, -0.45, 0.45); ctx.fill();
    ctx.restore();
  }

  function drawTrash(x, y) {
    box(x, y, 0.38, 0.38, 0.48, '#323842', '#1e242c', '#151a20', 'rgba(255,200,87,0.25)');
    const rim = worldToScreen(x + 0.19, y + 0.19, 0.48);
    ctx.strokeStyle = '#ffc857'; ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath(); ctx.ellipse(rim.x, rim.y, 7 * fit, 3.2 * fit, 0, 0, 7); ctx.stroke();
  }

  function drawServer(x, y, t) {
    box(x, y, 0.66, 0.56, 1.18, '#1c2230', '#10161e', '#0c1218');
    for (let row = 0; row < 5; row++) {
      const zy = 0.22 + row * 0.18;
      const pL = worldToScreen(x + 0.08, y + 0.56, zy);
      const pR = worldToScreen(x + 0.58, y + 0.56, zy);
      for (let i = 0; i < 4; i++) {
        const u = (i + 0.5) / 4;
        const lx = pL.x + (pR.x - pL.x) * u;
        const ly = pL.y + (pR.y - pL.y) * u;
        const on = Math.sin(t * 4 + row * 1.3 + i * 2.1) > 0.15;
        ctx.fillStyle = on ? (i % 2 ? '#39ff87' : '#4de0ff') : '#1a2430';
        ctx.fillRect(lx - 1.8 * fit, ly - 1.2 * fit, 3.6 * fit, 2.2 * fit);
      }
    }
  }

  function drawHeadOfFloor(x, y, t) {
    box(x, y, 0.95, 0.72, 0.46, '#1e2836', '#121820', '#0e141c');
    box(x + 0.14, y + 0.10, 0.45, 0.10, 0.86, '#0c121c', '#070b12', '#090e16');
    const p = worldToScreen(x + 0.65, y + 0.42, 0.92);
    const hw = 11 * fit, hh = 9.5 * fit;
    ctx.fillStyle = '#eef2f8';
    ctx.beginPath(); ctx.roundRect(p.x - hw, p.y - hh, hw * 2, hh * 1.85, 3.8 * fit); ctx.fill();
    ctx.fillStyle = '#06080e';
    ctx.fillRect(p.x - hw * 0.74, p.y - hh * 0.65, hw * 1.48, hh * 0.98);
    const blink = ((t * 0.7) % 5) < 0.12 ? 0.2 : 1;
    ctx.fillStyle = '#39ff87';
    ctx.beginPath(); ctx.ellipse(p.x - 3.6 * fit, p.y - 2.2 * fit, 1.7 * fit, 2.3 * fit * blink, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(p.x + 3.6 * fit, p.y - 2.2 * fit, 1.7 * fit, 2.3 * fit * blink, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(190,210,230,0.85)'; ctx.lineWidth = 1.6 * dpr;
    ctx.beginPath(); ctx.arc(p.x, p.y - 3 * fit, 12.5 * fit, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
  }

  function drawGhost(agent, t) {
    const ag = (state.agents || {})[agent.id] || {};
    const st = (ag.status || 'QUEUED').toUpperCase();
    const detail = String(ag.detail || '').trim();
    const active = st === 'RUNNING';
    const bob = Math.sin(t * 2.2 + agent.phase) * 0.08 + Math.sin(t * 3.5 + agent.phase * 1.3) * 0.03;
    const gx = agent.desk[0] + 0.75 + Math.sin(t * 0.4 + agent.phase) * 0.05;
    const gy = agent.desk[1] + 1.38;
    const gz = 0.78 + bob + (active ? 0.06 : 0);
    const p = worldToScreen(gx, gy, gz);
    const s = (active ? 13.5 : 12) * fit;

    const sh = worldToScreen(gx, gy, 0.02);
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.beginPath(); ctx.ellipse(sh.x, sh.y, s * 0.72, s * 0.28, 0, 0, 7); ctx.fill();

    ctx.globalCompositeOperation = 'lighter';
    const glowR = s * 1.45;
    const g = ctx.createRadialGradient(p.x, p.y, s * 0.2, p.x, p.y, glowR);
    g.addColorStop(0, hexA(agent.color, active ? 0.38 : 0.20));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, glowR, 0, 7); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    const c = hex(agent.color);
    const bg = ctx.createLinearGradient(p.x, p.y - s, p.x, p.y + s);
    bg.addColorStop(0, rgba(Math.min(255, c[0] + 55), Math.min(255, c[1] + 55), Math.min(255, c[2] + 55), 1));
    bg.addColorStop(1, agent.color);
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.moveTo(p.x - s, p.y);
    ctx.bezierCurveTo(p.x - s, p.y - s * 1.35, p.x + s, p.y - s * 1.35, p.x + s, p.y);
    const feetY = p.y + s * 0.95;
    const nFeet = 4;
    for (let i = nFeet; i >= 0; i--) {
      const u = i / nFeet;
      const fx = p.x - s + u * (s * 2);
      const fy = feetY - (i % 2 === 0 ? 0 : s * 0.28);
      ctx.lineTo(fx, fy);
    }
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = rgba(255, 255, 255, 0.24); ctx.lineWidth = 1 * dpr; ctx.stroke();

    ctx.strokeStyle = 'rgba(230,240,255,0.78)'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.arc(p.x, p.y - s * 0.15, s * 0.95, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    ctx.fillStyle = 'rgba(220,230,245,0.88)';
    ctx.beginPath(); ctx.ellipse(p.x - s * 0.95, p.y + s * 0.05, s * 0.22, s * 0.28, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(p.x + s * 0.95, p.y + s * 0.05, s * 0.22, s * 0.28, 0, 0, 7); ctx.fill();

    const blink = ((t + agent.phase) % 4.5) < 0.12 ? 0.18 : 1;
    ctx.fillStyle = '#07090f';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(p.x + side * s * 0.28, p.y - s * 0.05, s * 0.13, s * 0.28 * blink, side * -0.2, 0, 7);
      ctx.fill();
    }

    let bubble = detail ? detail.slice(0, 14) : '';
    if (!bubble) {
      if (st === 'RUNNING') bubble = i18n('bubble_trade', 'LIVE');
      else if (st === 'DONE') bubble = i18n('bubble_holding', 'READY');
      else bubble = i18n('bubble_standby', 'STANDBY');
    }
    bubble = isZh() ? bubble : bubble.toUpperCase();
    const prio = st === 'RUNNING' ? 3 : (st === 'DONE' ? 2 : 1);
    const primary = `${agent.id} · ${bubble}`.slice(0, 20);
    labelSlots.push({
      id: agent.id,
      color: agent.color,
      prio,
      primary,
      secondary: agent.id,
      ax: p.x,
      ay: p.y - s * 1.68,
      ghostR: s,
    });

    hits.push({ id: agent.id, x: p.x, y: p.y, r: Math.max(s * 1.8, 28 * dpr) });
  }

  function rectsOverlap(a, b, pad) {
    return !(a.x + a.w + pad < b.x || b.x + b.w + pad < a.x || a.y + a.h + pad < b.y || b.y + b.h + pad < a.y);
  }

  function drawGhostLabels() {
    // One crisp badge per agent ghost (all 6 shown, zero duplicate desk/prop pills)
    const slots = labelSlots.slice().sort((a, b) => b.prio - a.prio || a.id.localeCompare(b.id));
    const placed = [];
    const phone = canvas.width < 520 * dpr;
    const fs = Math.max(6.2 * dpr, Math.min(8.2 * dpr, 6.8 * fit));
    const padX = 5.5 * dpr, padY = 2.8 * dpr;
    const th = fs + padY * 2;
    const hudReserve = 26 * dpr;
    const offsets = [
      [0, 0],
      [0, -12 * dpr],
      [-18 * dpr, -6 * dpr],
      [18 * dpr, -6 * dpr],
      [0, -24 * dpr],
    ];

    for (const slot of slots) {
      let text = phone ? slot.secondary : slot.primary;
      ctx.font = `700 ${fs}px monospace`;
      ctx.textAlign = 'center';
      const maxW = (phone ? 86 : 132) * dpr;
      const tryPlace = (t) => {
        const tw = Math.min(ctx.measureText(t).width + padX * 2, maxW);
        for (const [dx, dy] of offsets) {
          const x = slot.ax + dx - tw / 2;
          const y = slot.ay + dy - th / 2;
          if (y < hudReserve) continue;
          if (x < 6 * dpr || x + tw > canvas.width - 6 * dpr) continue;
          const rect = { x, y, w: tw, h: th };
          let hit = false;
          for (const p of placed) {
            if (rectsOverlap(rect, p, 4 * dpr)) { hit = true; break; }
          }
          if (!hit) return { rect, text: t, cx: slot.ax + dx, cy: slot.ay + dy };
        }
        return null;
      };
      let chosen = tryPlace(text);
      if (!chosen && text !== slot.secondary) {
        chosen = tryPlace(slot.secondary);
      }
      if (!chosen) {
        const tw = Math.min(ctx.measureText(slot.secondary).width + padX * 2, 72 * dpr);
        const fy = Math.max(hudReserve + th / 2, slot.ay);
        chosen = {
          rect: { x: slot.ax - tw / 2, y: fy - th / 2, w: tw, h: th },
          text: slot.secondary,
          cx: slot.ax,
          cy: fy,
        };
      }
      placed.push(chosen.rect);
      const bx = chosen.rect.x, by = chosen.rect.y;
      ctx.fillStyle = 'rgba(5,8,14,0.92)';
      ctx.strokeStyle = hexA(slot.color, slot.prio >= 3 ? 0.95 : 0.78);
      ctx.lineWidth = 1.1 * dpr;
      ctx.beginPath(); ctx.roundRect(bx, by, chosen.rect.w, th, 3 * dpr); ctx.fill(); ctx.stroke();
      if (Math.abs(chosen.cx - slot.ax) < 6 * dpr && Math.abs(chosen.cy - slot.ay) < 8 * dpr) {
        ctx.beginPath();
        ctx.moveTo(slot.ax - 3.5 * dpr, by + th);
        ctx.lineTo(slot.ax, by + th + 4.5 * dpr);
        ctx.lineTo(slot.ax + 3.5 * dpr, by + th);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      ctx.fillStyle = '#eef4ff';
      ctx.fillText(chosen.text, chosen.cx, by + th * 0.71);
    }
  }

  function drawStageHud(t) {
    const w = canvas.width;
    const barH = 18 * dpr;
    const y0 = 5 * dpr;
    const slug = ((state.market || {}).slug || 'BTC-UPDOWN').toString().slice(0, 18).toUpperCase();
    const pnl = Number((state.portfolio || {}).pnl_total || 0);
    const eq = Number((state.portfolio || {}).equity || 10000);
    const pct = eq ? (pnl / Math.max(1, eq - pnl)) * 100 : 0;
    const liveN = i18n('floor_live_n', isZh() ? '6 桌線上' : '6 DESKS LIVE');
    const tick = `DESK · ${(pct >= 0 ? '+' : '')}${pct.toFixed(2)}% · ${liveN} · COINBASE LIVE · PAPER ONLY · ${slug} · `;
    const verTxt = 'UI mind34';
    const verW = 58 * dpr;

    ctx.save();
    ctx.fillStyle = 'rgba(4,7,12,0.90)';
    ctx.fillRect(8 * dpr, y0, w - 16 * dpr, barH);
    ctx.strokeStyle = 'rgba(57,255,135,0.28)';
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(8 * dpr, y0, w - 16 * dpr, barH);

    // scrolling ticker on left
    ctx.save();
    ctx.beginPath();
    ctx.rect(10 * dpr, y0 + 1 * dpr, Math.max(40 * dpr, w - 22 * dpr - verW), barH - 2 * dpr);
    ctx.clip();
    ctx.fillStyle = '#39ff87';
    ctx.font = `700 ${7.5 * dpr}px monospace`;
    ctx.textAlign = 'left';
    const scroll = ((t * 36) % 340);
    ctx.fillText(tick + tick + tick, 14 * dpr - scroll, y0 + barH * 0.71);
    ctx.restore();

    // pinned version badge on right of HUD strip
    const vx = w - 8 * dpr - verW;
    ctx.fillStyle = 'rgba(10,16,26,0.96)';
    ctx.fillRect(vx, y0 + 1 * dpr, verW - 1 * dpr, barH - 2 * dpr);
    ctx.strokeStyle = 'rgba(77,224,255,0.35)';
    ctx.beginPath();
    ctx.moveTo(vx, y0); ctx.lineTo(vx, y0 + barH);
    ctx.stroke();
    ctx.fillStyle = '#4de0ff';
    ctx.font = `700 ${7.2 * dpr}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(verTxt, vx + verW * 0.5, y0 + barH * 0.71);
    ctx.restore();
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!canvas || !ctx) return;
    resize();
    const t = (now - t0) / 1000;
    const w = canvas.width, h = canvas.height;
    hits = [];
    labelSlots = [];
    ctx.clearRect(0, 0, w, h);
    const bg = ctx.createRadialGradient(w * 0.5, h * 0.34, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
    bg.addColorStop(0, '#0b121a'); bg.addColorStop(1, '#030406');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);

    drawRoom();
    drawWallScreens(t);

    drawPlant(0.30, 0.45);
    drawPlant(7.32, 0.35);
    drawRadar(0.24, 2.15, t);
    drawSofa(0.26, 4.00);
    drawPlant(0.30, 5.10);
    drawHeadOfFloor(6.82, 0.78, t);
    drawRocket(7.12, 2.50, t);
    drawTrash(7.05, 3.55);
    drawServer(7.02, 4.45, t);

    AGENTS.forEach(a => drawDesk(a.desk[0], a.desk[1], a.color, a.id));
    const order = AGENTS.slice().sort((a, b) => (a.desk[0] + a.desk[1]) - (b.desk[0] + b.desk[1]));
    order.forEach(a => drawGhost(a, t));
    drawGhostLabels();
    drawStageHud(t);

    ctx.fillStyle = 'rgba(120,138,168,0.82)';
    ctx.font = `600 ${7.8 * dpr}px monospace`; ctx.textAlign = 'center';
    ctx.fillText(i18n('floor_cap', 'DESK FLOOR · CLICK A BOT / DESK → THE MIND · PAPER ONLY'), w / 2, h - 8 * dpr);
  }

  function hitTest(ev) {
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const x = (ev.clientX - r.left) * (canvas.width / r.width);
    const y = (ev.clientY - r.top) * (canvas.height / r.height);
    let best = null, bestD = 1e9;
    for (const ht of hits) {
      const d = Math.hypot(ht.x - x, ht.y - y);
      if (d < ht.r && d < bestD) { best = ht; bestD = d; }
    }
    if (best && selectCb) selectCb(best.id);
  }

  function start(el) {
    canvas = el || document.getElementById('floorCanvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    resize();
    if (raf) cancelAnimationFrame(raf);
    t0 = performance.now();
    candleBuf = null;
    raf = requestAnimationFrame(frame);
    window.addEventListener('resize', resize);
    canvas.addEventListener('click', hitTest);
    let _touchX0 = 0, _touchY0 = 0;
    canvas.addEventListener('touchstart', function (ev) {
      if (!ev.changedTouches || !ev.changedTouches[0]) return;
      _touchX0 = ev.changedTouches[0].clientX;
      _touchY0 = ev.changedTouches[0].clientY;
    }, { passive: true });
    canvas.addEventListener('touchend', function (ev) {
      if (!ev.changedTouches || !ev.changedTouches[0]) return;
      const touch = ev.changedTouches[0];
      const dx = touch.clientX - _touchX0, dy = touch.clientY - _touchY0;
      if (Math.hypot(dx, dy) > 14) return;
      hitTest({ clientX: touch.clientX, clientY: touch.clientY });
      ev.preventDefault();
    }, { passive: false });
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf); raf = 0;
    if (canvas) {
      canvas.removeEventListener('click', hitTest);
    }
  }

  global.FloorViz = { start, stop, setState, onSelect };
})(window);
