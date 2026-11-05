/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// The house view of the Energy Flow card: an isometric house with solar on the roof, the car in
// the garage, the hot water cylinder and the street supply, with animated lines for power that is
// moving. Switched on in Settings -> Dashboard; off, the dashboard shows the classic node diagram.
//
// render(state) is pure: it takes watts, today's kWh and a few flags and returns the SVG markup.
// Everything is drawn from geometry, so it scales without blurring and needs no image files.
//
// state: { solarW, homeW, evW, hwW, gridW (positive = importing), batteryPct, carHome, night,
//          today: { solar, home, ev, hw, gridImport, gridExport } in kWh, any of them null,
//          nowMs (keeps the animation in phase when the markup is replaced on the next tick),
//          compact (narrow screens: crops the margins so the text is larger) }

(function (root) {
  const FLOW_PERIOD_S = 0.9;           // one dash cycle of the flow animation
  const FLOWING_KW = 0.05;             // below 50 W a line is not drawn
  const SOLAR_FULL_KW = 8;             // the panels' sheen is brightest at this output

  // ── Formatting ────────────────────────────────────────────────────────────────────────────
  const f = (n) => n.toFixed(1);
  const fmtK = (v) => v == null ? '' : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const pw = (kw) => {
    const a = Math.abs(kw);
    if (a < FLOWING_KW) return ['0', 'W'];
    if (a < 1) return [String(Math.round(a * 1000)), 'W'];
    return [a.toFixed(1), 'kW'];
  };
  const flowing = (kw) => Math.abs(kw) > FLOWING_KW;
  const kw = (w) => { const n = Number(w); return isFinite(n) ? n / 1000 : 0; };
  const num = (v) => { const n = Number(v); return v == null || v === '' || !isFinite(n) ? null : n; };

  // ── Isometric projection (fixed aspect, never stretched) ──────────────────────────────────
  const K = 13, C = 0.8660254 * K, Sn = 0.5 * K, OX = 232, OY = 104;
  const P = (x, y, z) => [OX + (x - y) * C, OY + (x + y) * Sn - z * K];
  const poly = (...a) => a.map((q) => { const p = P(...q); return f(p[0]) + ',' + f(p[1]); }).join(' ');
  const path = (...a) => a.map((q, i) => { const p = P(...q); return (i ? 'L' : 'M') + f(p[0]) + ' ' + f(p[1]); }).join(' ');
  // Draw in a wall's own 2D coords. Front wall (y = yv): u = x, v = height. Side wall (x = xv): u = y.
  const onFront = (yv) => `matrix(${f(C)},${f(Sn)},0,${-K},${f(OX - C * yv)},${f(OY + Sn * yv)})`;
  const onSide = (xv) => `matrix(${f(-C)},${f(Sn)},0,${-K},${f(OX + C * xv)},${f(OY + Sn * xv)})`;
  // A roof slope's 2D coords: u = x, t = 0 at the eave to 1 at the ridge.
  const onSlope = (ye, yr, ze, zr) =>
    `matrix(${f(C)},${f(Sn)},${f(C * (ye - yr))},${f(-Sn * (ye - yr) - (zr - ze) * K)},${f(OX - C * ye)},${f(OY + Sn * ye - ze * K)})`;
  const NS = 'vector-effect="non-scaling-stroke"';

  // House: x 0..10, y 0..7, eave 4, ridge 6.6. Garage: x -5.2..0, y 2.6..7, eave 3, ridge 4.3.
  const W = 10, D = 7, H = 4, R = 6.6;
  const GX = -5.2, GY = 2.6, GH = 3, GR = 4.3, GRY = 4.8;

  const COL = { solar: '#fbbf24', home: '#60a5fa', car: '#a78bfa', hw: '#fb923c', grid: '#f1f5f9' };

  // Flow paths. The grid one runs street to meter (import) and is reversed while exporting.
  const PATHS = {
    solar: path([8.8, 6.45, 4.41], [10, 6.45, 4.0], [10, 6.45, 2.15]),
    home:  path([10, 6.0, 1.8], [10, 5.1, 1.8]),
    car:   path([10, 6.55, 1.3], [10, 6.55, 1.0], [10, 7, 1.0], [0.1, 7, 1.0], [0.1, 7, 0.6], [-1.25, 7, 0.6]),
    hw:    path([10, 6.1, 1.3], [10, 6.1, 0.7], [10, 2.1, 0.7], [10.25, 1.75, 0.9]),
    grid:  path([11.8, -19, 0], [11.8, 6.3, 0], [10, 6.3, 0], [10, 6.3, 1.3]),
  };

  function render(state) {
    const s = state || {};
    const solar = kw(s.solarW), home = kw(s.homeW), car = kw(s.evW), hw = kw(s.hwW), net = kw(s.gridW);
    const exporting = net < -FLOWING_KW;
    const batt = num(s.batteryPct) == null ? null : Math.round(num(s.batteryPct));
    const carHome = s.carHome !== false;
    const night = !!s.night;
    const solarFrac = Math.max(0, Math.min(1, solar / SOLAR_FULL_KW));
    const t = s.today || {};
    const tSolar = num(t.solar), tHome = num(t.home), tCar = num(t.ev), tHw = num(t.hw);
    const tImp = num(t.gridImport), tExp = num(t.gridExport);
    // Replacing the markup restarts CSS animations; offsetting each by the wall clock keeps the
    // dots moving smoothly across ticks instead of jumping back to the start.
    const phase = ((s.nowMs == null ? Date.now() : s.nowMs) % (FLOW_PERIOD_S * 1000)) / 1000;

    const winFill = night ? 'url(#hfWin)' : 'url(#hfWinDay)';
    const win = (u0, u1, v0, v1) => `
      <rect x="${u0}" y="${v0}" width="${f(u1 - u0)}" height="${f(v1 - v0)}" fill="${winFill}" stroke="rgba(0,0,0,0.55)" stroke-width="1.2" ${NS}/>
      <line x1="${(u0 + u1) / 2}" y1="${v0}" x2="${(u0 + u1) / 2}" y2="${v1}" stroke="rgba(20,16,10,0.7)" stroke-width="1" ${NS}/>
      <line x1="${u0}" y1="${(v0 + v1) / 2}" x2="${u1}" y2="${(v0 + v1) / 2}" stroke="rgba(20,16,10,0.7)" stroke-width="1" ${NS}/>`;

    // Solar panels: a 6 x 3 grid on the front roof slope, brighter the more they produce.
    const cellStroke = `rgba(150,180,255,${f(0.18 + 0.2 * solarFrac)})`;
    let cells = '';
    for (let i = 0; i <= 6; i++) {
      const u = 0.6 + i * (8.8 / 6);
      cells += `<line x1="${f(u)}" y1="0.1" x2="${f(u)}" y2="0.92" stroke="${cellStroke}" stroke-width="0.8" ${NS}/>`;
    }
    for (let j = 0; j <= 3; j++) {
      const v = 0.1 + j * (0.82 / 3);
      cells += `<line x1="0.6" y1="${f(v)}" x2="9.4" y2="${f(v)}" stroke="${cellStroke}" stroke-width="0.8" ${NS}/>`;
    }

    const carSvg = carHome ? `
      <rect x="-3.95" y="0.28" width="2.7" height="0.9" rx="0.32" fill="${night ? '#e6e8ec' : '#c9ccd2'}"/>
      <path d="M -3.55 1.12 L -1.65 1.12 L -1.95 1.72 L -3.25 1.72 Z" fill="#1c2230"/>
      <rect x="-3.85" y="0.9" width="2.5" height="0.09" fill="#ef4444" opacity="0.9"/>
      <rect x="-2.85" y="0.48" width="0.5" height="0.18" fill="#f8fafc" opacity="0.6"/>
      <rect x="-3.88" y="0.04" width="0.38" height="0.3" rx="0.08" fill="#0b0c10"/>
      <rect x="-1.70" y="0.04" width="0.38" height="0.3" rx="0.08" fill="#0b0c10"/>` : '';
    const charging = flowing(car);

    const flow = (key, reverse, delay) => `
      <path class="hf-flow-track" d="${PATHS[key]}" fill="none" stroke="${COL[key]}" stroke-opacity="0.16" stroke-width="1.2" stroke-linejoin="round"/>
      <path class="hf-flow hf-flow-${key}" d="${PATHS[key]}" fill="none" stroke="${COL[key]}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="0.01 6.5" style="animation-direction:${reverse ? 'reverse' : 'normal'};animation-delay:${(delay - phase).toFixed(3)}s"/>`;

    const callout = (lx, ly, tx, ty, color, name, val, extra, today, below) => {
      const top = below ? ly + 12 : ly - 35;
      return `
      <line x1="${f(lx)}" y1="${f(ly)}" x2="${f(tx)}" y2="${f(ty)}" stroke="rgba(255,255,255,0.32)" stroke-width="0.8"/>
      <circle cx="${f(tx)}" cy="${f(ty)}" r="2.2" fill="#ffffff" opacity="0.85"/>
      <circle cx="${f(lx + 8)}" cy="${f(top)}" r="2.4" fill="${color}"/>
      <text x="${f(lx + 14)}" y="${f(top + 3)}" font-size="9.5" fill="rgba(240,242,245,0.55)">${name}</text>
      <text x="${f(lx + 6)}" y="${f(top + 21)}" font-size="17" font-weight="600" fill="#f5f7fa">${val[0]}<tspan font-size="9" font-weight="500" fill="rgba(240,242,245,0.55)" dx="2">${val[1]}</tspan>${extra}</text>
      ${today ? `<text x="${f(lx + 6)}" y="${f(top + 32)}" font-size="8" fill="rgba(240,242,245,0.32)">${today}</text>` : ''}`;
    };
    const carT = P(-2.6, 7, 1.1), solT = P(3.3, 5.25, 5.3), homeT = P(10, 4.4, 2.1), hwT = P(10.75, 1.4, 2.5), gridT = P(11.8, -6, 0);
    const battTxt = batt !== null ? `<tspan font-size="10" font-weight="600" fill="#34d399" dx="4">${batt}%</tspan>` : '';
    const gridName = flowing(net) ? (exporting ? 'Grid · export' : 'Grid · import') : 'Grid';
    const gridToday = (tImp != null || tExp != null) ? `↓${fmtK(tImp == null ? 0 : tImp)} · ↑${fmtK(tExp == null ? 0 : tExp)} kWh today` : '';
    const today = (v) => v != null ? fmtK(v) + ' kWh today' : '';
    const tank = P(10.75, 1.4, 0), tankTop = P(10.75, 1.4, 2.5);

    // Compact (narrow screens): crop the empty margins so the labels draw about a quarter larger.
    const viewBox = s.compact ? '84 2 446 222' : '0 0 560 232';

    return `<svg class="hf-svg" viewBox="${viewBox}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Energy flow: solar ${pw(solar).join(' ')}, home ${pw(home).join(' ')}, car ${pw(car).join(' ')}, hot water ${pw(hw).join(' ')}, ${gridName.toLowerCase()} ${pw(net).join(' ')}">
    <defs>
      <radialGradient id="hfGround" gradientUnits="userSpaceOnUse" cx="${f(P(3, 6, 0)[0])}" cy="${f(P(3, 6, 0)[1])}" r="230">
        <stop offset="0" stop-color="#252a38"/><stop offset="0.6" class="hf-fade-stop"/><stop offset="1" class="hf-fade-stop"/>
      </radialGradient>
      <radialGradient id="hfSpill" gradientUnits="userSpaceOnUse" cx="${f(P(-2.6, 9.4, 0)[0])}" cy="${f(P(-2.6, 9.4, 0)[1])}" r="78">
        <stop offset="0" stop-color="#f6b55a" stop-opacity="${night ? 0.38 : 0.12}"/><stop offset="1" stop-color="#f6b55a" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="hfFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="hf-fade-stop" stop-opacity="0"/><stop offset="1" class="hf-fade-stop"/></linearGradient>
      <linearGradient id="hfWin" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#f8cf7a"/><stop offset="1" stop-color="#e3922f"/></linearGradient>
      <linearGradient id="hfWinDay" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#3a4558"/><stop offset="1" stop-color="#1e2533"/></linearGradient>
      <linearGradient id="hfGarage" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${night ? '#3a2a17' : '#1c1b1a'}"/><stop offset="1" stop-color="${night ? '#7a5528' : '#2a2724'}"/></linearGradient>
      <linearGradient id="hfPanel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1a2b5c"/><stop offset="1" stop-color="#0f1834"/></linearGradient>
      <linearGradient id="hfSheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9cc0ff" stop-opacity="${f(0.05 + 0.35 * solarFrac)}"/><stop offset="0.6" stop-color="#9cc0ff" stop-opacity="0"/></linearGradient>
    </defs>

    <polygon points="${poly([-40, -30, 0], [50, -30, 0], [50, 40, 0], [-40, 40, 0])}" fill="url(#hfGround)"/>
    <rect x="0" y="196" width="560" height="36" fill="url(#hfFade)"/>
    <ellipse cx="${f(P(-2.6, 9.4, 0)[0])}" cy="${f(P(-2.6, 9.4, 0)[1])}" rx="78" ry="30" fill="url(#hfSpill)"/>

    <!-- garage -->
    <polygon points="${poly([GX, GY, GH], [0, GY, GH], [0, GRY, GR], [GX, GRY, GR])}" fill="#232631"/>
    <polygon points="${poly([GX, D, 0], [0, D, 0], [0, D, GH], [GX, D, GH])}" fill="#16181f"/>
    <g transform="${onFront(D)}">
      <rect x="-4.7" y="0" width="4.2" height="2.3" fill="url(#hfGarage)"/>
      <rect x="-4.6" y="1.0" width="0.3" height="0.65" rx="0.06" fill="#d9dde3"/>
      <circle cx="-4.45" cy="1.48" r="0.06" fill="${charging ? '#34d399' : '#6b7280'}"/>
      ${carHome ? `<path d="M -4.45 1.0 C -4.4 0.4, -4.1 0.35, -3.9 0.6" fill="none" stroke="#2b2f38" stroke-width="1.4" ${NS}/>` : ''}
      ${carSvg}
      <rect x="-4.7" y="2.3" width="4.2" height="0.18" fill="#0d0f14"/>
      <circle cx="-4.95" cy="2.55" r="0.09" fill="#ffd28a" opacity="${night ? 1 : 0.4}"/>
      <circle cx="-0.25" cy="2.55" r="0.09" fill="#ffd28a" opacity="${night ? 1 : 0.4}"/>
    </g>
    <polygon points="${poly([GX, D, GH], [0, D, GH], [0, GRY, GR], [GX, GRY, GR])}" fill="#1c1f28"/>

    <!-- house -->
    <polygon points="${poly([0, 0, H], [W, 0, H], [W, D / 2, R], [0, D / 2, R])}" fill="#23262f"/>
    <polygon points="${poly([W, 0, 0], [W, D, 0], [W, D, H], [W, 0, H])}" fill="#0f1117"/>
    <polygon points="${poly([W, 0, H], [W, D, H], [W, D / 2, R])}" fill="#12141a"/>
    <polygon points="${poly([0, D, 0], [W, D, 0], [W, D, H], [0, D, H])}" fill="#181b23"/>
    <g transform="${onSide(W)}">${win(3.7, 5.1, 1.3, 2.9)}
      <rect x="6.0" y="1.3" width="0.6" height="0.85" rx="0.05" fill="#3b3f48" stroke="rgba(255,255,255,0.14)" stroke-width="0.8" ${NS}/>
      <circle cx="6.3" cy="1.95" r="0.06" fill="#34d399"/>
    </g>
    <g transform="${onFront(D)}">${win(3.0, 4.6, 1.3, 2.9)}${win(5.6, 7.2, 1.3, 2.9)}</g>
    <polygon points="${poly([0, D, H], [W, D, H], [W, D / 2, R], [0, D / 2, R])}" fill="#1d2029"/>
    <g transform="${onSlope(D, D / 2, H, R)}">
      <rect x="0.6" y="0.1" width="8.8" height="0.82" fill="url(#hfPanel)"/>
      <rect x="0.6" y="0.1" width="8.8" height="0.82" fill="url(#hfSheen)"/>
      ${cells}
    </g>
    <line x1="${f(P(0, D, H)[0])}" y1="${f(P(0, D, H)[1])}" x2="${f(P(W, D, H)[0])}" y2="${f(P(W, D, H)[1])}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
    <line x1="${f(P(0, D / 2, R)[0])}" y1="${f(P(0, D / 2, R)[1])}" x2="${f(P(W, D / 2, R)[0])}" y2="${f(P(W, D / 2, R)[1])}" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>

    <!-- hot water cylinder -->
    <rect x="${f(tank[0] - 7.5)}" y="${f(tankTop[1])}" width="15" height="${f(2.5 * K)}" fill="#c7cbd3"/>
    <rect x="${f(tank[0] - 6.5)}" y="${f(tankTop[1])}" width="4" height="${f(2.5 * K)}" fill="#e5e7eb" opacity="0.6"/>
    <ellipse cx="${f(tankTop[0])}" cy="${f(tankTop[1])}" rx="7.5" ry="3.4" fill="#e5e7eb"/>
    <ellipse cx="${f(tank[0])}" cy="${f(tank[1])}" rx="7.5" ry="3.4" fill="#9ca3af"/>

    <!-- flows: only drawn while power is moving -->
    ${flowing(solar) ? flow('solar', false, 0) : ''}
    ${flowing(home) ? flow('home', false, -0.3) : ''}
    ${flowing(car) ? flow('car', false, -0.15) : ''}
    ${flowing(hw) ? flow('hw', false, -0.45) : ''}
    ${flowing(net) ? flow('grid', exporting, -0.6) : ''}

    <!-- callouts -->
    ${callout(carT[0], 44, carT[0], carT[1], COL.car, carHome ? 'Car' : 'Car · away', pw(car), battTxt, today(tCar))}
    ${callout(solT[0], 44, solT[0], solT[1], COL.solar, 'Solar', pw(solar), '', today(tSolar))}
    ${callout(homeT[0], 44, homeT[0], homeT[1], COL.home, 'Home', pw(home), '', today(tHome))}
    ${callout(390, 96, hwT[0], hwT[1], COL.hw, 'Hot water', pw(hw), '', today(tHw))}
    ${callout(gridT[0], 168, gridT[0], gridT[1], COL.grid, gridName, pw(net), '', gridToday, true)}
  </svg>`;
  }

  const api = { render, FLOW_PERIOD_S };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HouseFlow = api;
})(typeof window !== 'undefined' ? window : this);
