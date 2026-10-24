/**
 * Desk Floor — isometric 2D office for GROK DESK SWARM GRID (v3 polish).
 * FloorViz.start(canvas) / stop() / setState(s) / onSelect(cb)
 * Target: denser furniture + wall monitor like refs/floor-frame-*.png, ~60fps.
 */
(function (global) {
  'use strict';
  const AGENTS = [
    { id: 'EDGE',    color: '#ff4dcf', desk: [1.15, 0.95], phase: 0.2 },
    { id: 'CLOSER',  color: '#ff8a3d', desk: [3.35, 0.95], phase: 1.1 },
    { id: 'PRIOR',   color: '#c9a227', desk: [5.55, 0.95], phase: 2.0 },
    { id: 'TAKER',   color: '#4d8cff', desk: [1.15, 3.15], phase: 2.9 },
    { id: 'SPOTTER', color: '#2dd4bf', desk: [3.35, 3.15], phase: 3.8 },
    { id: 'KELLY',   color: '#a855f7', desk: [5.55, 3.15], phase: 4.7 },
  ];

  let canvas, ctx, raf = 0, dpr = 1, t0 = performance.now();
  let state = { agents: {}, signal: {}, portfolio: {}, handoffs: [], market: {} };
  let hits = [];
  let labelSlots = []; // mind31: ghost bubble collision slots (screen space)
  let selectCb = null;
  let TW = 54, TH = 27;
  let candleBuf = null; // cached pseudo-candles seeded once

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
    return { x: (x - y) * TW, y: (x + y) * TH - (z || 0) };
  }
  function worldToScreen(x, y, z) {
    const o = origin();
    const p = iso(x, y, z);
    return { x: o.x + p.x, y: o.y + p.y };
  }
  function origin() {
    const phone = canvas.width < 520 * dpr;
    return { x: canvas.width * (phone ? 0.50 : 0.52), y: canvas.height * (phone ? 0.14 : 0.16) };
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
    // phone: prefer filling width; desktop: classic fit
    const phone = w < 520 * dpr;
    const fit = Math.min(w / (phone ? 700 : 780), h / (phone ? 460 : 420));
    TW = 52 * fit; TH = 26 * fit;
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
    ctx.beginPath(); ctx.moveTo(p001.x, p001.y); ctx.lineTo(p101.x, p101.y); ctx.lineTo(p111.x, p111.y); ctx.lineTo(p011.x, p011.y); ctx.closePath();
    ctx.fillStyle = top; ctx.fill();
    ctx.beginPath(); ctx.moveTo(p011.x, p011.y); ctx.lineTo(p111.x, p111.y); ctx.lineTo(p110.x, p110.y); ctx.lineTo(p010.x, p010.y); ctx.closePath();
    ctx.fillStyle = left; ctx.fill();
    ctx.beginPath(); ctx.moveTo(p101.x, p101.y); ctx.lineTo(p111.x, p111.y); ctx.lineTo(p110.x, p110.y); ctx.lineTo(p100.x, p100.y); ctx.closePath();
    ctx.fillStyle = right; ctx.fill();
    ctx.strokeStyle = edge || 'rgba(57,255,135,0.16)'; ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); ctx.moveTo(p001.x, p001.y); ctx.lineTo(p101.x, p101.y); ctx.lineTo(p111.x, p111.y); ctx.lineTo(p011.x, p011.y); ctx.closePath(); ctx.stroke();
    return { p001, p101, p011, p111, p000, p100, p010, p110 };
  }

  function chip(sx, sy, text, col, opts) {
    opts = opts || {};
    const fs = (opts.size || 7.5) * dpr;
    ctx.font = `700 ${fs}px monospace`; ctx.textAlign = 'center';
    const padX = 6 * dpr, padY = 3.5 * dpr;
    const tw = ctx.measureText(text).width + padX * 2;
    const th = fs + padY * 2;
    ctx.fillStyle = opts.bg || 'rgba(4,8,14,0.88)';
    ctx.strokeStyle = hexA(col || '#39ff87', opts.alpha || 0.75);
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.roundRect(sx - tw / 2, sy - th / 2, tw, th, 2.5 * dpr);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = col || '#39ff87';
    ctx.fillText(text, sx, sy + fs * 0.32);
  }

  function label(x, y, z, text, col, opts) {
    const p = worldToScreen(x, y, z);
    chip(p.x, p.y, text, col, opts);
  }

  function ensureCandles() {
    if (candleBuf && candleBuf.length) return candleBuf;
    candleBuf = [];
    let p = 0.5;
    for (let i = 0; i < 28; i++) {
      const drift = (Math.random() - 0.48) * 0.06;
      const o = p, c = Math.max(0.12, Math.min(0.88, p + drift));
      const hi = Math.max(o, c) + Math.random() * 0.04;
      const lo = Math.min(o, c) - Math.random() * 0.04;
      candleBuf.push({ o, c, hi, lo });
      p = c;
    }
    return candleBuf;
  }

  function drawRoom() {
    const neon = 'rgba(57,255,135,0.32)';
    for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) {
      const shade = ((x + y) & 1) ? 'rgba(14,18,24,0.96)' : 'rgba(9,12,17,0.96)';
      drawTile(x, y, shade, 'rgba(57,255,135,0.055)');
    }
    // subtle floor glow strip
    for (let x = 0; x < 8; x++) {
      const a = worldToScreen(x, 0, 0.02), b = worldToScreen(x + 1, 0, 0.02);
      ctx.strokeStyle = 'rgba(57,255,135,0.12)'; ctx.lineWidth = 1 * dpr;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    const a = worldToScreen(0, 0, 0), b = worldToScreen(8, 0, 0);
    const a2 = worldToScreen(0, 0, 2.55), b2 = worldToScreen(8, 0, 2.55);
    const c = worldToScreen(0, 6, 0), c2 = worldToScreen(0, 6, 2.55);
    // back wall
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(b2.x, b2.y); ctx.lineTo(a2.x, a2.y); ctx.closePath();
    const wg = ctx.createLinearGradient(a.x, a2.y, a.x, a.y);
    wg.addColorStop(0, 'rgba(12,16,22,0.96)'); wg.addColorStop(1, 'rgba(7,10,14,0.94)');
    ctx.fillStyle = wg; ctx.fill();
    ctx.strokeStyle = neon; ctx.lineWidth = 1.6 * dpr; ctx.stroke();
    // left wall
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.lineTo(c2.x, c2.y); ctx.lineTo(a2.x, a2.y); ctx.closePath();
    ctx.fillStyle = 'rgba(5,8,12,0.92)'; ctx.fill();
    ctx.strokeStyle = 'rgba(57,255,135,0.2)'; ctx.stroke();

    // left wall brand — mind31: quieter + higher so it doesn't eat ghost labels
    const brand = worldToScreen(0.08, 0.85, 2.15);
    ctx.save();
    ctx.translate(brand.x, brand.y);
    ctx.rotate(-0.55);
    ctx.globalAlpha = 0.38;
    ctx.fillStyle = 'rgba(57,255,135,0.95)';
    ctx.font = `800 ${8.5 * dpr}px monospace`;
    ctx.textAlign = 'left';
    ctx.fillText('THE_GROK_FLOOR', 0, 0);
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = 'rgba(57,255,135,0.9)';
    ctx.font = `600 ${5.5 * dpr}px monospace`;
    ctx.fillText(isZh() ? '紙上 · 六桌線上' : 'PAPER · 6 DESKS LIVE', 0, 10 * dpr);
    ctx.restore();
  }

  function drawWallScreens(t) {
    // scrolling ticker strip above main monitor
    const tickY = 2.25;
    const t0p = worldToScreen(1.8, 0.05, tickY);
    const t1p = worldToScreen(6.4, 0.05, tickY);
    ctx.fillStyle = 'rgba(4,8,12,0.92)';
    ctx.fillRect(t0p.x, t0p.y - 8 * dpr, t1p.x - t0p.x, 14 * dpr);
    ctx.strokeStyle = 'rgba(57,255,135,0.35)'; ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(t0p.x, t0p.y - 8 * dpr, t1p.x - t0p.x, 14 * dpr);
    const slug = ((state.market || {}).slug || 'BTC-UPDOWN').toString().slice(0, 18).toUpperCase();
    const pnl = Number((state.portfolio || {}).pnl_total || 0);
    const eq = Number((state.portfolio || {}).equity || 10000);
    const pct = eq ? (pnl / Math.max(1, eq - pnl)) * 100 : 0;
    const tick = `${slug} DESK · ${(pct >= 0 ? '+' : '')}${pct.toFixed(2)}% · ${i18n('floor_live_n', '6 桌線上')} · COINBASE LIVE · PAPER ONLY · `;
    ctx.save();
    ctx.beginPath();
    ctx.rect(t0p.x + 2 * dpr, t0p.y - 7 * dpr, t1p.x - t0p.x - 4 * dpr, 12 * dpr);
    ctx.clip();
    ctx.fillStyle = '#39ff87';
    ctx.font = `700 ${8 * dpr}px monospace`;
    ctx.textAlign = 'left';
    const scroll = ((t * 42) % 280);
    ctx.fillText(tick + tick, t0p.x + 6 * dpr - scroll, t0p.y + 2 * dpr);
    ctx.restore();

    // main wall monitor bezel
    const mx = 2.35, my = 0.04, mw = 3.5, mh = 1.72;
    const z0 = 0.48, z1 = 0.48 + mh;
    const bl = worldToScreen(mx, my, z0);
    const br = worldToScreen(mx + mw, my, z0);
    const tl = worldToScreen(mx, my, z1);
    const tr = worldToScreen(mx + mw, my, z1);
    // outer bezel
    ctx.beginPath(); ctx.moveTo(tl.x - 3 * dpr, tl.y - 3 * dpr); ctx.lineTo(tr.x + 3 * dpr, tr.y - 3 * dpr);
    ctx.lineTo(br.x + 3 * dpr, br.y + 3 * dpr); ctx.lineTo(bl.x - 3 * dpr, bl.y + 3 * dpr); ctx.closePath();
    ctx.fillStyle = '#0a1018'; ctx.fill();
    ctx.strokeStyle = 'rgba(57,255,135,0.65)'; ctx.lineWidth = 1.8 * dpr; ctx.stroke();
    // screen
    ctx.beginPath(); ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y); ctx.closePath();
    ctx.fillStyle = '#03060b'; ctx.fill();

    const W = br.x - bl.x, H = bl.y - tl.y;
    const candles = ensureCandles();
    const n = candles.length;
    const cw = W / (n + 2);
    // animate last candle with signal bias
    const up = Number((state.signal || {}).up_price || 0.5);
    const last = candles[n - 1];
    const liveC = Math.max(0.1, Math.min(0.9, last.o + (up - 0.5) * 0.35 + Math.sin(t * 1.6) * 0.015));

    for (let i = 0; i < n; i++) {
      const cndl = candles[i];
      const o = cndl.o, c = (i === n - 1) ? liveC : cndl.c;
      const hi = Math.max(o, c, cndl.hi), lo = Math.min(o, c, cndl.lo);
      const x = bl.x + (i + 1.2) * cw;
      const yHi = tl.y + (1 - hi) * H * 0.78 + H * 0.16;
      const yLo = tl.y + (1 - lo) * H * 0.78 + H * 0.16;
      const yO = tl.y + (1 - o) * H * 0.78 + H * 0.16;
      const yC = tl.y + (1 - c) * H * 0.78 + H * 0.16;
      const bull = c >= o;
      ctx.strokeStyle = bull ? '#39ff87' : '#ff5d7a';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath(); ctx.moveTo(x, yHi); ctx.lineTo(x, yLo); ctx.stroke();
      const bodyTop = Math.min(yO, yC), bodyH = Math.max(2 * dpr, Math.abs(yC - yO));
      ctx.fillStyle = bull ? '#39ff87' : '#ff5d7a';
      ctx.fillRect(x - cw * 0.28, bodyTop, cw * 0.56, bodyH);
    }

    // PnL overlay
    ctx.fillStyle = '#e8fff4';
    ctx.font = `800 ${10 * dpr}px monospace`;
    ctx.textAlign = 'left';
    const title = slug.slice(0, 16);
    ctx.fillText(title, tl.x + 8 * dpr, tl.y + 14 * dpr);
    ctx.fillStyle = pnl >= 0 ? '#39ff87' : '#ff5d7a';
    ctx.font = `800 ${13 * dpr}px monospace`;
    const pnlTxt = (pnl >= 0 ? '+' : '') + pct.toFixed(2) + '%';
    ctx.fillText(pnlTxt, tl.x + 8 * dpr, tl.y + 30 * dpr);
    ctx.fillStyle = 'rgba(180,200,220,0.7)';
    ctx.font = `600 ${7.5 * dpr}px monospace`;
    ctx.fillText((pnl >= 0 ? '+' : '-') + '$' + Math.abs(pnl).toFixed(2) + ' PAPER', tl.x + 8 * dpr, tl.y + 42 * dpr);

    // side wall screens (left + right of main)
    [[0.25, 0.05, 1.7, '#39ff87'], [6.15, 0.05, 1.55, '#ff4dcf']].forEach((sc, i) => {
      const [sx, sy, sw, col] = sc;
      const p0 = worldToScreen(sx, sy, 0.85);
      const p1 = worldToScreen(sx + sw, sy, 0.85);
      const p2 = worldToScreen(sx + sw, sy, 2.05);
      const p3 = worldToScreen(sx, sy, 2.05);
      ctx.beginPath(); ctx.moveTo(p3.x, p3.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p1.x, p1.y); ctx.lineTo(p0.x, p0.y); ctx.closePath();
      ctx.fillStyle = '#04070c'; ctx.fill();
      ctx.strokeStyle = hexA(col, 0.55); ctx.lineWidth = 1.2 * dpr; ctx.stroke();
      // mini candles / bars
      const ww = p1.x - p0.x, hh = p0.y - p3.y;
      for (let k = 0; k < 10; k++) {
        const u = (k + 0.5) / 10;
        const x = p3.x + ww * u;
        const hgt = (0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * 1.8 + k * 0.7 + i))) * hh * 0.7;
        ctx.fillStyle = Math.sin(t + k + i) > 0 ? col : '#ff5d7a';
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x - 2.5 * dpr, p0.y - hgt - hh * 0.12, 5 * dpr, hgt);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = col;
      ctx.font = `700 ${7 * dpr}px monospace`;
      ctx.textAlign = 'left';
      ctx.fillText(i ? 'FLOW' : 'SCAN', p3.x + 5 * dpr, p3.y + 11 * dpr);
    });

    // right rules board
    const rx = 7.15, ry = 0.08;
    const r0 = worldToScreen(rx, ry, 1.1);
    const r1 = worldToScreen(rx + 0.75, ry, 1.1);
    const r2 = worldToScreen(rx + 0.75, ry, 2.2);
    const r3 = worldToScreen(rx, ry, 2.2);
    ctx.beginPath(); ctx.moveTo(r3.x, r3.y); ctx.lineTo(r2.x, r2.y); ctx.lineTo(r1.x, r1.y); ctx.lineTo(r0.x, r0.y); ctx.closePath();
    ctx.fillStyle = 'rgba(8,12,18,0.92)'; ctx.fill();
    ctx.strokeStyle = 'rgba(57,255,135,0.4)'; ctx.stroke();
    const rules = isZh()
      ? ['DAY · 6 規則', '2 損 = 出局', '僅紙上', '無金鑰', '無真實下單']
      : ['DAY · 6 RULES', '2 losses = out', 'PAPER ONLY', 'NO KEYS', 'NO LIVE CLOB'];
    ctx.font = `700 ${6.5 * dpr}px monospace`;
    ctx.textAlign = 'left';
    rules.forEach((line, i) => {
      ctx.fillStyle = i === 0 ? '#39ff87' : 'rgba(180,200,220,0.75)';
      ctx.fillText(line, r3.x + 5 * dpr, r3.y + (12 + i * 11) * dpr);
    });
  }

  function drawDesk(ax, ay, col, id) {
    // legs hint
    box(ax + 0.08, ay + 0.08, 0.18, 0.18, 0.52, '#1a2230', '#10161e', '#0c1218', 'rgba(0,0,0,0)');
    box(ax + 1.25, ay + 0.08, 0.18, 0.18, 0.52, '#1a2230', '#10161e', '#0c1218', 'rgba(0,0,0,0)');
    // desk top
    box(ax, ay, 1.55, 0.95, 0.55, '#2a3648', '#171e2a', '#111722', hexA(col, 0.28));
    // keyboard
    box(ax + 0.35, ay + 0.45, 0.7, 0.32, 0.04, '#1a222e', '#121820', '#0e141c', 'rgba(255,255,255,0.05)');
    // glowing mouse
    const mp = worldToScreen(ax + 1.2, ay + 0.62, 0.58);
    ctx.fillStyle = hexA(col, 0.9);
    ctx.beginPath(); ctx.ellipse(mp.x, mp.y, 4 * dpr, 2.5 * dpr, 0.3, 0, 7); ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = hexA(col, 0.25);
    ctx.beginPath(); ctx.arc(mp.x, mp.y, 8 * dpr, 0, 7); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    // dual-ish monitor (main + thin secondary)
    box(ax + 0.22, ay + 0.1, 0.95, 0.12, 0.98, '#0c121c', '#070b12', '#090e16', hexA(col, 0.35));
    const s0 = worldToScreen(ax + 0.3, ay + 0.14, 0.65);
    const s1 = worldToScreen(ax + 1.08, ay + 0.14, 0.65);
    const s2 = worldToScreen(ax + 1.08, ay + 0.14, 1.4);
    const s3 = worldToScreen(ax + 0.3, ay + 0.14, 1.4);
    ctx.beginPath(); ctx.moveTo(s3.x, s3.y); ctx.lineTo(s2.x, s2.y); ctx.lineTo(s1.x, s1.y); ctx.lineTo(s0.x, s0.y); ctx.closePath();
    ctx.fillStyle = '#050a10'; ctx.fill();
    ctx.strokeStyle = hexA(col, 0.7); ctx.lineWidth = 1 * dpr; ctx.stroke();
    // screen content: bars + line
    const ag = (state.agents || {})[id] || {};
    const active = String(ag.status || '').toUpperCase() === 'RUNNING';
    ctx.strokeStyle = active ? col : '#cfe8ff';
    ctx.lineWidth = 1.3 * dpr; ctx.beginPath();
    for (let i = 0; i < 14; i++) {
      const u = i / 13;
      const x = s3.x + (s2.x - s3.x) * u;
      const y = s3.y + (s0.y - s3.y) * (0.5 + 0.28 * Math.sin(performance.now() / 380 + i * 0.55 + ax * 2));
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    for (let i = 0; i < 6; i++) {
      const u = (i + 0.5) / 6;
      const x = s3.x + (s2.x - s3.x) * u;
      const bh = (s0.y - s3.y) * (0.15 + 0.25 * Math.abs(Math.sin(performance.now() / 500 + i + ay)));
      ctx.fillStyle = hexA(col, 0.45);
      ctx.fillRect(x - 2 * dpr, s0.y - bh - 4 * dpr, 4 * dpr, bh);
    }
    // role chip on screen
    ctx.fillStyle = col;
    ctx.font = `700 ${6.5 * dpr}px monospace`;
    ctx.textAlign = 'left';
    ctx.fillText(id, s3.x + 4 * dpr, s3.y + 10 * dpr);

    // chair
    box(ax + 0.48, ay + 1.12, 0.55, 0.48, 0.42, '#222a36', '#141a24', '#0e131c');
    box(ax + 0.48, ay + 1.12, 0.55, 0.12, 0.72, '#2a3342', '#181e28', '#121820'); // back

    // name plate on desk front
    label(ax + 0.75, ay + 0.55, 0.62, id, col, { size: 7 });

    const c = worldToScreen(ax + 0.75, ay + 0.55, 1.0);
    hits.push({ id, x: c.x, y: c.y, r: 46 * dpr });
  }

  function drawPlant(x, y) {
    box(x, y, 0.32, 0.32, 0.28, '#3a2a18', '#241810', '#1a120c', 'rgba(255,200,100,0.15)');
    const p = worldToScreen(x + 0.16, y + 0.16, 0.28);
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i - 2.5) * 0.38;
      const g = ctx.createLinearGradient(p.x, p.y, p.x, p.y - 18 * dpr);
      g.addColorStop(0, '#1a5c34'); g.addColorStop(1, '#3dff8a');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(p.x + Math.cos(a) * 7 * dpr, p.y - 12 * dpr + Math.sin(a) * 2 * dpr, 4.5 * dpr, 11 * dpr, a, 0, 7);
      ctx.fill();
    }
  }

  function drawSofa(x, y) {
    // base
    box(x, y, 1.9, 0.75, 0.38, '#1e2530', '#131820', '#0e131a');
    // seat cushions
    box(x + 0.08, y + 0.08, 0.85, 0.55, 0.48, '#2a3340', '#1a222c', '#141a22', 'rgba(100,120,150,0.2)');
    box(x + 0.98, y + 0.08, 0.85, 0.55, 0.48, '#2a3340', '#1a222c', '#141a22', 'rgba(100,120,150,0.2)');
    // back
    box(x, y, 1.9, 0.18, 0.78, '#262e3a', '#161c26', '#10151c');
    // arms
    box(x - 0.08, y, 0.14, 0.75, 0.55, '#222833', '#141a22', '#10151c');
    box(x + 1.84, y, 0.14, 0.75, 0.55, '#222833', '#141a22', '#10151c');
    // coffee table
    box(x + 0.55, y + 1.05, 0.8, 0.5, 0.26, '#3a2c1e', '#241810', '#1a120c', 'rgba(255,180,80,0.15)');
    // mug
    const mug = worldToScreen(x + 0.85, y + 1.25, 0.32);
    ctx.fillStyle = '#e8eef5';
    ctx.beginPath(); ctx.ellipse(mug.x, mug.y, 3.5 * dpr, 2.2 * dpr, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#39ff87';
    ctx.beginPath(); ctx.ellipse(mug.x, mug.y, 2 * dpr, 1.2 * dpr, 0, 0, 7); ctx.fill();
  }

  function drawRocket(x, y, t) {
    box(x, y, 0.55, 0.55, 0.22, '#2a3038', '#161a20', '#0e1216');
    // pedestal ring
    const ring = worldToScreen(x + 0.27, y + 0.27, 0.24);
    ctx.strokeStyle = 'rgba(255,138,61,0.55)'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.ellipse(ring.x, ring.y, 12 * dpr, 5 * dpr, 0, 0, 7); ctx.stroke();
    const bob = 0.06 * Math.sin(t * 2.2);
    const tip = worldToScreen(x + 0.27, y + 0.27, 1.65 + bob);
    const mid = worldToScreen(x + 0.27, y + 0.27, 0.42);
    const bodyG = ctx.createLinearGradient(mid.x, tip.y, mid.x, mid.y);
    bodyG.addColorStop(0, '#ffffff'); bodyG.addColorStop(1, '#9aa8bc');
    ctx.fillStyle = bodyG;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(mid.x - 9 * dpr, mid.y);
    ctx.lineTo(mid.x + 9 * dpr, mid.y);
    ctx.closePath(); ctx.fill();
    // window
    ctx.fillStyle = '#4de0ff';
    ctx.beginPath(); ctx.arc(mid.x, (tip.y + mid.y) * 0.55, 3 * dpr, 0, 7); ctx.fill();
    // fins
    ctx.fillStyle = '#ff4d6d';
    ctx.beginPath(); ctx.moveTo(mid.x - 9 * dpr, mid.y); ctx.lineTo(mid.x - 14 * dpr, mid.y + 12 * dpr); ctx.lineTo(mid.x - 2 * dpr, mid.y); ctx.fill();
    ctx.beginPath(); ctx.moveTo(mid.x + 9 * dpr, mid.y); ctx.lineTo(mid.x + 14 * dpr, mid.y + 12 * dpr); ctx.lineTo(mid.x + 2 * dpr, mid.y); ctx.fill();
    // flame
    const flick = 4 * Math.sin(t * 14) * dpr;
    ctx.fillStyle = rgba(255, 180, 40, 0.75 + 0.25 * Math.sin(t * 10));
    ctx.beginPath();
    ctx.moveTo(mid.x - 5 * dpr, mid.y + 2 * dpr);
    ctx.lineTo(mid.x, mid.y + 16 * dpr + flick);
    ctx.lineTo(mid.x + 5 * dpr, mid.y + 2 * dpr);
    ctx.fill();
    label(x + 0.27, y + 0.27, 1.95 + bob, isZh() ? '頂尖跑者' : 'TOP RUNNER', '#ff8a3d', { size: 6.5 });
  }

  function drawRadar(x, y, t) {
    box(x, y, 0.58, 0.58, 0.28, '#1c2430', '#10161e', '#0c1218');
    const pole = worldToScreen(x + 0.29, y + 0.29, 0.9);
    ctx.strokeStyle = 'rgba(160,180,200,0.7)'; ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.moveTo(pole.x, pole.y + 8 * dpr); ctx.lineTo(pole.x, pole.y - 4 * dpr); ctx.stroke();
    ctx.save();
    ctx.translate(pole.x, pole.y - 2 * dpr);
    ctx.rotate(t * 1.35);
    // dish
    ctx.fillStyle = 'rgba(210,225,240,0.9)';
    ctx.beginPath(); ctx.ellipse(0, 0, 16 * dpr, 7 * dpr, 0.15, 0, 7); ctx.fill();
    ctx.strokeStyle = '#4de0ff'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.ellipse(0, 0, 16 * dpr, 7 * dpr, 0.15, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(20 * dpr, -2 * dpr); ctx.stroke();
    // sweep
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 20 * dpr);
    g.addColorStop(0, 'rgba(77,224,255,0.4)'); g.addColorStop(1, 'rgba(77,224,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 20 * dpr, -0.45, 0.45); ctx.fill();
    ctx.restore();
    // range rings on floor projection
    ctx.strokeStyle = 'rgba(77,224,255,0.22)'; ctx.lineWidth = 1 * dpr;
    for (const r of [10, 16]) {
      ctx.beginPath(); ctx.ellipse(pole.x, pole.y + 14 * dpr, r * dpr, r * 0.35 * dpr, 0, 0, 7); ctx.stroke();
    }
    label(x + 0.29, y + 0.29, 1.4, isZh() ? '巨鯨雷達' : 'WHALE RADAR', '#4de0ff', { size: 6.5 });
  }

  function drawTrash(x, y) {
    box(x, y, 0.42, 0.42, 0.58, '#323842', '#1e242c', '#151a20', 'rgba(255,200,87,0.25)');
    // rim
    const rim = worldToScreen(x + 0.21, y + 0.21, 0.58);
    ctx.strokeStyle = '#ffc857'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.ellipse(rim.x, rim.y, 9 * dpr, 4 * dpr, 0, 0, 7); ctx.stroke();
    label(x + 0.21, y + 0.21, 0.9, isZh() ? '紙手' : 'PAPER HANDS', '#ffc857', { size: 6 });
  }

  function drawServer(x, y, t) {
    box(x, y, 0.72, 0.62, 1.45, '#1c2230', '#10161e', '#0c1218');
    for (let row = 0; row < 6; row++) {
      const zy = 0.25 + row * 0.2;
      const pL = worldToScreen(x + 0.08, y + 0.08, zy);
      const pR = worldToScreen(x + 0.64, y + 0.08, zy);
      ctx.fillStyle = 'rgba(20,28,40,0.9)';
      ctx.fillRect(pL.x, pL.y - 3 * dpr, pR.x - pL.x, 6 * dpr);
      for (let i = 0; i < 4; i++) {
        const on = Math.sin(t * 4 + row * 1.3 + i * 2.1) > 0.15;
        ctx.fillStyle = on ? (i % 2 ? '#39ff87' : '#4de0ff') : '#1a2430';
        ctx.fillRect(pL.x + 4 * dpr + i * 7 * dpr, pL.y - 2 * dpr, 5 * dpr, 3 * dpr);
      }
    }
    label(x + 0.36, y + 0.3, 1.6, 'pump.fun', '#39ff87', { size: 6.5 });
  }

  function drawHeadOfFloor(x, y, t) {
    box(x, y, 1.25, 0.85, 0.52, '#1e2836', '#121820', '#0e141c');
    // mini monitor on desk
    box(x + 0.15, y + 0.1, 0.55, 0.1, 0.55, '#0c121c', '#070b12', '#090e16');
    const p = worldToScreen(x + 0.85, y + 0.45, 1.15);
    // TV / sphere head
    ctx.fillStyle = '#eef2f8';
    ctx.beginPath(); ctx.roundRect(p.x - 15 * dpr, p.y - 18 * dpr, 30 * dpr, 26 * dpr, 5 * dpr); ctx.fill();
    ctx.fillStyle = '#06080e';
    ctx.fillRect(p.x - 11 * dpr, p.y - 12 * dpr, 22 * dpr, 13 * dpr);
    const blink = ((t * 0.7) % 5) < 0.12 ? 0.2 : 1;
    ctx.fillStyle = '#39ff87';
    ctx.beginPath(); ctx.ellipse(p.x - 5 * dpr, p.y - 6 * dpr, 2.2 * dpr, 3 * dpr * blink, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(p.x + 5 * dpr, p.y - 6 * dpr, 2.2 * dpr, 3 * dpr * blink, 0, 0, 7); ctx.fill();
    // headset
    ctx.strokeStyle = 'rgba(190,210,230,0.85)'; ctx.lineWidth = 2.2 * dpr;
    ctx.beginPath(); ctx.arc(p.x, p.y - 8 * dpr, 17 * dpr, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    ctx.fillStyle = 'rgba(200,215,230,0.9)';
    ctx.beginPath(); ctx.ellipse(p.x - 16 * dpr, p.y - 2 * dpr, 4 * dpr, 5 * dpr, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(p.x + 16 * dpr, p.y - 2 * dpr, 4 * dpr, 5 * dpr, 0, 0, 7); ctx.fill();
    // local clock
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    label(x + 0.6, y + 0.4, 1.65, isZh() ? '場地板手' : 'HEAD OF FLOOR', '#9ab0c4', { size: 6.2 });
    chip(p.x, p.y + 18 * dpr, hh + ':' + mm + ' UTC', '#39ff87', { size: 6.5 });
  }

  function drawGhost(agent, t) {
    const ag = (state.agents || {})[agent.id] || {};
    const st = (ag.status || 'QUEUED').toUpperCase();
    const detail = String(ag.detail || '').trim();
    const active = st === 'RUNNING';
    const bob = Math.sin(t * 2.2 + agent.phase) * 0.18 + Math.sin(t * 3.5 + agent.phase * 1.3) * 0.06;
    const gx = agent.desk[0] + 0.75 + Math.sin(t * 0.4 + agent.phase) * 0.08;
    const gy = agent.desk[1] + 1.55;
    const gz = 0.95 + bob + (active ? 0.08 : 0);
    const p = worldToScreen(gx, gy, gz);
    const s = (active ? 15 : 13) * dpr;

    const sh = worldToScreen(gx, gy, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(sh.x, sh.y, s * 0.7, s * 0.28, 0, 0, 7); ctx.fill();

    ctx.globalCompositeOperation = 'lighter';
    /* mind30: smaller aura — stay inside floor-stage clip, no chrome wash */
    const glowR = s * 1.55;
    const g = ctx.createRadialGradient(p.x, p.y, s * 0.2, p.x, p.y, glowR);
    g.addColorStop(0, hexA(agent.color, active ? 0.42 : 0.22));
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
    ctx.strokeStyle = rgba(255, 255, 255, 0.22); ctx.lineWidth = 1 * dpr; ctx.stroke();

    ctx.strokeStyle = 'rgba(230,240,255,0.75)'; ctx.lineWidth = 1.8 * dpr;
    ctx.beginPath(); ctx.arc(p.x, p.y - s * 0.15, s * 0.95, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    ctx.fillStyle = 'rgba(220,230,245,0.85)';
    ctx.beginPath(); ctx.ellipse(p.x - s * 0.95, p.y + s * 0.05, s * 0.22, s * 0.28, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(p.x + s * 0.95, p.y + s * 0.05, s * 0.22, s * 0.28, 0, 0, 7); ctx.fill();

    const blink = ((t + agent.phase) % 4.5) < 0.12 ? 0.18 : 1;
    ctx.fillStyle = '#07090f';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(p.x + side * s * 0.28, p.y - s * 0.05, s * 0.13, s * 0.28 * blink, side * -0.2, 0, 7);
      ctx.fill();
    }

    let bubble = detail ? detail.slice(0, 18) : '';
    if (!bubble) {
      if (st === 'RUNNING') bubble = i18n('bubble_trade', 'in a trade');
      else if (st === 'DONE') bubble = i18n('bubble_holding', 'holding');
      else bubble = i18n('bubble_standby', 'standby');
    }
    bubble = isZh() ? bubble : bubble.toUpperCase();
    /* mind31: shorter primary tag; name only for RUNNING to cut clutter */
    const prio = st === 'RUNNING' ? 3 : (st === 'DONE' ? 2 : 1);
    const primary = (prio >= 2 ? (agent.id + ' · ' + bubble) : bubble).slice(0, 22);
    const secondary = bubble.slice(0, 14);
    labelSlots.push({
      id: agent.id,
      color: agent.color,
      prio,
      primary,
      secondary,
      ax: p.x,
      ay: p.y - s * 1.85,
      ghostR: s,
    });

    hits.push({ id: agent.id, x: p.x, y: p.y, r: Math.max(s * 1.7, 28 * dpr) });
  }

  function rectsOverlap(a, b, pad) {
    return !(a.x + a.w + pad < b.x || b.x + b.w + pad < a.x || a.y + a.h + pad < b.y || b.y + b.h + pad < a.y);
  }

  function drawGhostLabels() {
    /* mind31: place smaller bubbles with collision avoid / priority hide */
    const slots = labelSlots.slice().sort((a, b) => b.prio - a.prio || a.id.localeCompare(b.id));
    const placed = [];
    const phone = canvas.width < 520 * dpr;
    const fs = (phone ? 5.4 : 5.8) * dpr;
    const padX = 5 * dpr, padY = 2.6 * dpr;
    const th = fs + padY * 2;
    const offsets = [
      [0, 0], [0, -16 * dpr], [0, 14 * dpr],
      [-22 * dpr, -10 * dpr], [22 * dpr, -10 * dpr],
      [0, -28 * dpr], [-30 * dpr, 6 * dpr], [30 * dpr, 6 * dpr],
    ];

    for (const slot of slots) {
      let text = slot.primary;
      ctx.font = `700 ${fs}px monospace`;
      ctx.textAlign = 'center';
      let tw = Math.min(ctx.measureText(text).width + padX * 2, (phone ? 110 : 128) * dpr);
      let chosen = null;
      const tryPlace = (t) => {
        tw = Math.min(ctx.measureText(t).width + padX * 2, (phone ? 110 : 128) * dpr);
        for (const [dx, dy] of offsets) {
          const x = slot.ax + dx - tw / 2;
          const y = slot.ay + dy - th / 2;
          const rect = { x, y, w: tw, h: th };
          let hit = false;
          for (const p of placed) {
            if (rectsOverlap(rect, p, 3 * dpr)) { hit = true; break; }
          }
          /* also keep off ghost bodies a bit when offset sideways */
          if (!hit) return { rect, text: t, cx: slot.ax + dx, cy: slot.ay + dy };
        }
        return null;
      };
      chosen = tryPlace(text);
      if (!chosen && slot.secondary !== text) {
        text = slot.secondary;
        chosen = tryPlace(text);
      }
      if (!chosen) {
        /* low-priority: drop; high: force short above ghost */
        if (slot.prio < 2) continue;
        text = slot.id;
        tw = Math.min(ctx.measureText(text).width + padX * 2, 72 * dpr);
        chosen = {
          rect: { x: slot.ax - tw / 2, y: slot.ay - th / 2 - 10 * dpr, w: tw, h: th },
          text,
          cx: slot.ax,
          cy: slot.ay - 10 * dpr,
        };
      }
      placed.push(chosen.rect);
      const bx = chosen.rect.x, by = chosen.rect.y;
      ctx.fillStyle = 'rgba(6,8,14,0.88)';
      ctx.strokeStyle = hexA(slot.color, slot.prio >= 3 ? 0.9 : 0.65);
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath(); ctx.roundRect(bx, by, chosen.rect.w, th, 2.5 * dpr); ctx.fill(); ctx.stroke();
      /* pointer only when near default slot */
      if (Math.abs(chosen.cx - slot.ax) < 4 * dpr && Math.abs(chosen.cy - slot.ay) < 6 * dpr) {
        ctx.beginPath();
        ctx.moveTo(slot.ax - 3.5 * dpr, by + th);
        ctx.lineTo(slot.ax, by + th + 5 * dpr);
        ctx.lineTo(slot.ax + 3.5 * dpr, by + th);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      ctx.fillStyle = '#e8eefc';
      ctx.fillText(chosen.text, chosen.cx, by + th * 0.72);
    }
  }

  function drawFloatingHints(t) {
    // mind31: sparse ambient chips — don't compete with ghost labels
    const coarse = (typeof matchMedia === 'function') && matchMedia('(pointer: coarse)').matches;
    if (coarse && Math.sin(t * 0.35) < 0.55) return;
    if (canvas.width < 520 * dpr && Math.sin(t * 0.5) < 0.35) return;
    const hints = isZh()
      ? [
          [7.15, 4.55, 1.15, '紙上成交', '#ffc857'],
          [3.9, 0.3, 2.35, '主螢幕', '#39ff87'],
        ]
      : [
          [7.15, 4.55, 1.15, 'PAPER FILLS', '#ffc857'],
          [3.9, 0.3, 2.35, 'MAIN SCREEN', '#39ff87'],
        ];
    hints.forEach((h, i) => {
      if (Math.sin(t * 0.45 + i) < -0.15) return;
      label(h[0], h[1], h[2], h[3], h[4], { size: 5.4, alpha: 0.4 });
    });
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
    const bg = ctx.createRadialGradient(w * 0.5, h * 0.28, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
    bg.addColorStop(0, '#0b121a'); bg.addColorStop(1, '#030406');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);

    drawRoom();
    drawWallScreens(t);

    drawPlant(0.28, 4.85);
    drawPlant(7.35, 0.35);
    drawSofa(0.25, 4.05);
    drawServer(7.0, 4.45, t);
    drawRocket(7.1, 2.55, t);
    drawRadar(0.22, 2.15, t);
    drawTrash(6.95, 3.55);
    drawHeadOfFloor(6.75, 0.75, t);
    drawPlant(0.32, 0.45);

    AGENTS.forEach(a => drawDesk(a.desk[0], a.desk[1], a.color, a.id));
    const order = AGENTS.slice().sort((a, b) => (a.desk[0] + a.desk[1]) - (b.desk[0] + b.desk[1]));
    order.forEach(a => drawGhost(a, t));
    drawGhostLabels();
    drawFloatingHints(t);

    ctx.fillStyle = 'rgba(107,122,150,0.78)';
    ctx.font = `600 ${8 * dpr}px monospace`; ctx.textAlign = 'center';
    ctx.fillText(i18n('floor_cap', 'DESK FLOOR · CLICK A BOT / DESK → THE MIND · PAPER ONLY'), w / 2, h - 10 * dpr);
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
    // better mobile tap — ignore scroll gestures so page can pan-y
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
      if (Math.hypot(dx, dy) > 14) return; // was a scroll / drag, don't steal
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
