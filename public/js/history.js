/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

// ─── History / Stats ───

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

// ─── Fuel comparison settings (loaded from API, fall back to sensible defaults) ───
let fuelSettings = {
  evKwhPer100km:     17.0,   // Model Y RWD real-world AU average
  petrolLPer100km:    8.4,   // Toyota RAV4 2.5L combined
  hybridLPer100km:    4.9,   // Toyota RAV4 Hybrid combined
  petrolPriceAud:     2.05,  // AUD/litre ULP ~2026
  country:            'AU',
};

// The comparison math itself is unit-agnostic ("per 100 units of distance") -
// this only controls what the distance/volume/price are LABELLED as. See
// settings.js FUEL_FIELD_CONFIG for the matching Settings-page labels.
const FUEL_UNIT_LABELS = {
  AU: { distance: 'km', volume: 'L',   priceUnit: 'L' },
  US: { distance: 'mi', volume: 'gal', priceUnit: 'gal' },
};
function fuelUnitLabels() {
  return FUEL_UNIT_LABELS[fuelSettings.country] || FUEL_UNIT_LABELS.AU;
}

async function loadFuelSettings() {
  try {
    const data = await api('/api/settings');
    if (!data.ok) return;
    const s = data.settings;
    if (s.fuel_ev_kwh_per_100km)    fuelSettings.evKwhPer100km    = parseFloat(s.fuel_ev_kwh_per_100km);
    if (s.fuel_petrol_l_per_100km)  fuelSettings.petrolLPer100km  = parseFloat(s.fuel_petrol_l_per_100km);
    if (s.fuel_hybrid_l_per_100km)  fuelSettings.hybridLPer100km  = parseFloat(s.fuel_hybrid_l_per_100km);
    if (s.fuel_petrol_price_aud)    fuelSettings.petrolPriceAud   = parseFloat(s.fuel_petrol_price_aud);
    if (s.country)                  fuelSettings.country          = s.country;
  } catch (_e) {}
}

function fuelComparison(totalKwh, gridCostAud) {
  const f          = fuelSettings;
  const kmDriven   = (totalKwh / f.evKwhPer100km) * 100;
  const petrolCost = kmDriven * (f.petrolLPer100km / 100) * f.petrolPriceAud;
  const hybridCost = kmDriven * (f.hybridLPer100km / 100) * f.petrolPriceAud;
  const evCost     = gridCostAud || 0;
  return {
    kmDriven:   Math.round(kmDriven),
    vsPetrol:   petrolCost - evCost,
    vsHybrid:   hybridCost - evCost,
    petrolCost: petrolCost,
    hybridCost: hybridCost,
    evCost:     evCost,
  };
}

let currentYear  = new Date().getFullYear();
let currentMonth = new Date().getMonth() + 1;
let currentPage  = 1;
let totalPages   = 1;

// ─── Monthly stats + chart ───

async function loadMonthlyStats() {
  document.getElementById('month-label').textContent =
    MONTH_NAMES[currentMonth - 1] + ' ' + currentYear;

  // Disable next-month button if we're at current month
  const now = new Date();
  const isCurrentMonth = currentYear === now.getFullYear() && currentMonth === now.getMonth() + 1;
  const nextBtn = document.getElementById('next-month');
  if (nextBtn) nextBtn.disabled = isCurrentMonth;

  try {
    const [data, houseData] = await Promise.all([
      api(`/api/stats/monthly?year=${currentYear}&month=${currentMonth}`),
      api(`/api/stats/house/monthly?year=${currentYear}&month=${currentMonth}`),
    ]);
    if (!data.ok) return;

    const t = data.totals;
    document.getElementById('tile-total').textContent  = t.total_kwh.toFixed(1) + ' kWh';
    document.getElementById('tile-pct').textContent    = t.self_powered_pct + '%';
    document.getElementById('tile-solar').textContent  = t.solar_kwh.toFixed(1) + ' kWh';
    document.getElementById('tile-grid').textContent   = t.grid_kwh.toFixed(1) + ' kWh';

    renderEVChart(data.days);
    renderHWChart(data.days);
    if (houseData.ok) renderHouseChart(houseData.days);
  } catch (err) {
    console.error('[history] Monthly stats error:', err);
  }
}

function renderEVChart(days) {
  const area     = document.getElementById('chart-area');
  const labelRow = document.getElementById('chart-label-row');
  if (!area) return;
  area.innerHTML = '';
  if (labelRow) labelRow.innerHTML = '';

  const maxVal  = Math.max(...days.map(d => d.solar_kwh + d.grid_kwh), 0.1);
  const CHART_H = 120;
  const showLabel = new Set([1, 5, 10, 15, 20, 25]);
  if (days.length) showLabel.add(days.length);

  for (const d of days) {
    const evTotal = d.solar_kwh + d.grid_kwh;
    const solarH  = evTotal > 0 ? Math.max(1, Math.round((d.solar_kwh / maxVal) * CHART_H)) : 0;
    const gridH   = evTotal > 0 && d.grid_kwh > 0 ? Math.max(1, Math.round((d.grid_kwh / maxVal) * CHART_H)) : 0;

    const col = document.createElement('div');
    col.className = 'chart-col';

    if (evTotal > 0) {
      const tip = document.createElement('div');
      tip.className = 'chart-tooltip';
      tip.innerHTML =
        `<strong>Day ${d.day}</strong><br>` +
        `Solar: ${d.solar_kwh.toFixed(2)} kWh<br>` +
        `Grid: ${d.grid_kwh.toFixed(2)} kWh<br>` +
        `Total: ${evTotal.toFixed(2)} kWh`;
      col.appendChild(tip);

      if (solarH > 0) {
        const bar = document.createElement('div');
        bar.className = 'chart-bar solar';
        bar.style.height = solarH + 'px';
        col.appendChild(bar);
      }
      if (gridH > 0) {
        const bar = document.createElement('div');
        bar.className = 'chart-bar grid';
        bar.style.height = gridH + 'px';
        col.appendChild(bar);
      }
    }

    area.appendChild(col);

    if (labelRow) {
      const lbl = document.createElement('div');
      lbl.className = 'chart-day-label';
      lbl.textContent = showLabel.has(d.day) ? d.day : '';
      labelRow.appendChild(lbl);
    }
  }
}

function renderHWChart(days) {
  const area     = document.getElementById('hw-chart-area');
  const labelRow = document.getElementById('hw-chart-label-row');
  if (!area) return;
  area.innerHTML = '';
  if (labelRow) labelRow.innerHTML = '';

  const maxVal  = Math.max(...days.map(d => d.hw_kwh || 0), 0.1);
  const CHART_H = 120;
  const showLabel = new Set([1, 5, 10, 15, 20, 25]);
  if (days.length) showLabel.add(days.length);

  for (const d of days) {
    const hwKwh = d.hw_kwh || 0;
    const hwH   = hwKwh > 0 ? Math.max(1, Math.round((hwKwh / maxVal) * CHART_H)) : 0;

    const col = document.createElement('div');
    col.className = 'chart-col';

    if (hwKwh > 0) {
      const tip = document.createElement('div');
      tip.className = 'chart-tooltip';
      tip.innerHTML = `<strong>Day ${d.day}</strong><br>Hot Water: ${hwKwh.toFixed(2)} kWh`;
      col.appendChild(tip);

      const bar = document.createElement('div');
      bar.className = 'chart-bar hw';
      bar.style.height = hwH + 'px';
      col.appendChild(bar);
    }

    area.appendChild(col);

    if (labelRow) {
      const lbl = document.createElement('div');
      lbl.className = 'chart-day-label';
      lbl.textContent = showLabel.has(d.day) ? d.day : '';
      labelRow.appendChild(lbl);
    }
  }
}

function renderHouseChart(days) {
  const area     = document.getElementById('house-chart-area');
  const labelRow = document.getElementById('house-chart-label-row');
  if (!area) return;
  area.innerHTML = '';
  if (labelRow) labelRow.innerHTML = '';

  const N = days.length;
  if (!N) return;

  const CHART_H = 120;
  const SVG_H   = 100;
  const maxVal  = Math.max(...days.map(d => d.house_kwh || 0), 0.1);

  const ptStr = pts => pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' L ');
  const totalPts = days.map((d, i) => [i + 0.5, SVG_H - ((d.house_kwh       || 0) / maxVal) * SVG_H]);
  const solarPts = days.map((d, i) => [i + 0.5, SVG_H - ((d.house_solar_kwh || 0) / maxVal) * SVG_H]);

  const x0 = 0.5, xN = N - 0.5;
  const totalPath = `M ${x0},${SVG_H} L ${ptStr(totalPts)} L ${xN},${SVG_H} Z`;
  const solarPath = `M ${x0},${SVG_H} L ${ptStr(solarPts)} L ${xN},${SVG_H} Z`;

  // SVG area sits as absolute background; chart-cols float on top for hover
  const svgWrap = document.createElement('div');
  svgWrap.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none';
  svgWrap.innerHTML = `
    <svg width="100%" height="100%" viewBox="0 0 ${N} ${SVG_H}" preserveAspectRatio="none">
      <path d="${totalPath}" fill="#63b3ed" opacity="0.75"/>
      <path d="${solarPath}" fill="var(--accent-solar)" opacity="0.80"/>
    </svg>`;
  area.appendChild(svgWrap);

  const showLabel = new Set([1, 5, 10, 15, 20, 25]);
  if (N) showLabel.add(N);

  for (const d of days) {
    const houseKwh      = d.house_kwh || 0;
    const houseSolarKwh = d.house_solar_kwh || 0;
    const houseGridKwh  = d.house_grid_kwh  || 0;

    const col = document.createElement('div');
    col.className = 'chart-col';

    if (houseKwh > 0) {
      const tip = document.createElement('div');
      tip.className = 'chart-tooltip';
      tip.innerHTML =
        `<strong>Day ${d.day}</strong><br>` +
        `House: ${houseKwh.toFixed(2)} kWh<br>` +
        `Solar: ${houseSolarKwh.toFixed(2)} kWh<br>` +
        `Grid: ${houseGridKwh.toFixed(2)} kWh`;
      col.appendChild(tip);
    }

    area.appendChild(col);

    if (labelRow) {
      const lbl = document.createElement('div');
      lbl.className = 'chart-day-label';
      lbl.textContent = showLabel.has(d.day) ? d.day : '';
      labelRow.appendChild(lbl);
    }
  }
}

// ─── Month navigation ───

function prevMonth() {
  currentMonth--;
  if (currentMonth < 1) { currentMonth = 12; currentYear--; }
  loadMonthlyStats();
  loadPeriodStats();
  loadEddiPeriodStats();
  loadHousePeriodStats();
  loadFinancialDashboard();
  currentPage = 1;
  loadSessions(1);
}

function nextMonth() {
  const now = new Date();
  if (currentYear === now.getFullYear() && currentMonth === now.getMonth() + 1) return;
  currentMonth++;
  if (currentMonth > 12) { currentMonth = 1; currentYear++; }
  loadMonthlyStats();
  loadPeriodStats();
  loadEddiPeriodStats();
  loadHousePeriodStats();
  loadFinancialDashboard();
  currentPage = 1;
  loadSessions(1);
}

// ─── Sessions table ───

async function loadSessions(page = 1) {
  const tbody       = document.getElementById('sessions-tbody');
  const paginationEl = document.getElementById('pagination');
  if (!tbody) return;

  try {
    const data = await api(`/api/sessions?page=${page}&limit=20`);
    if (!data.ok) return;

    totalPages  = Math.ceil(data.total / data.limit);
    currentPage = page;

    tbody.innerHTML = '';
    if (!data.sessions.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--text-secondary)">No sessions this month</td></tr>';
      renderPagination(paginationEl);
      return;
    }

    for (const s of data.sessions) {
      const tr = document.createElement('tr');
      tr.dataset.id = s.id;
      tr.innerHTML = `
        <td>${formatDate(s.started_at)}</td>
        <td>${formatTime(s.started_at)}</td>
        <td>${formatDuration(s.duration_secs)}</td>
        <td>${(s.kwh_solar || 0).toFixed(2)} kWh</td>
        <td>${s.battery_start ?? '-'}% → ${s.battery_end ?? '-'}%</td>
        <td>${(s.avg_amps || 0).toFixed(1)} A</td>
        <td>$${(s.est_savings_aud || 0).toFixed(2)}</td>
      `;
      tr.addEventListener('click', () => expandSession(s.id, tr));
      tbody.appendChild(tr);
    }

    renderPagination(paginationEl);
  } catch (err) {
    console.error('[history] Load sessions error:', err);
  }
}

function renderPagination(el) {
  if (!el) return;
  el.innerHTML = '';
  if (totalPages <= 1) return;

  const makeBtn = (label, page, disabled, active) => {
    const btn = document.createElement('button');
    btn.className = 'page-btn' + (active ? ' active' : '');
    btn.textContent = label;
    btn.disabled = disabled;
    if (!disabled) btn.addEventListener('click', () => loadSessions(page));
    return btn;
  };

  el.appendChild(makeBtn('«', 1, currentPage === 1, false));
  el.appendChild(makeBtn('‹', currentPage - 1, currentPage === 1, false));

  const start = Math.max(1, currentPage - 2);
  const end   = Math.min(totalPages, start + 4);
  for (let i = start; i <= end; i++) {
    el.appendChild(makeBtn(i, i, false, i === currentPage));
  }

  el.appendChild(makeBtn('›', currentPage + 1, currentPage === totalPages, false));
  el.appendChild(makeBtn('»', totalPages, currentPage === totalPages, false));
}

// ─── Session expand / detail ───

let expandedId  = null;
let expandedRow = null;

async function expandSession(id, tr) {
  if (expandedId === id) {
    const existing = tr.nextElementSibling;
    if (existing?.classList.contains('session-detail-row')) existing.remove();
    expandedId  = null;
    expandedRow = null;
    return;
  }

  if (expandedRow) {
    const prev = expandedRow.nextElementSibling;
    if (prev?.classList.contains('session-detail-row')) prev.remove();
  }

  expandedId  = id;
  expandedRow = tr;

  try {
    const data = await api(`/api/sessions/${id}`);
    if (!data.ok || !data.session) return;

    const s = data.session;
    const detailRow = document.createElement('tr');
    detailRow.className = 'session-detail-row';
    detailRow.innerHTML = `
      <td colspan="7" style="padding:0">
        <div style="padding:1rem 1.25rem;background:var(--bg-base);border-bottom:1px solid var(--border)">
          <div style="display:flex;gap:1.5rem;margin-bottom:0.875rem;font-size:0.8rem;color:var(--text-secondary)">
            <span>Peak: <strong style="color:var(--text-primary)">${s.peak_amps || 0} A</strong></span>
            <span>Avg: <strong style="color:var(--text-primary)">${(s.avg_amps || 0).toFixed(1)} A</strong></span>
            <span>End reason: <strong style="color:var(--text-primary)">${s.end_reason || '-'}</strong></span>
          </div>
          <div id="telemetry-chart-${id}" style="height:80px;display:flex;align-items:flex-end;gap:2px;overflow-x:auto"></div>
        </div>
      </td>
    `;
    tr.insertAdjacentElement('afterend', detailRow);

    const chartEl = document.getElementById(`telemetry-chart-${id}`);
    if (chartEl && s.telemetry?.length) {
      const maxAmp = Math.max(...s.telemetry.map(t => t.charge_amps || 0), 1);
      for (const t of s.telemetry) {
        const bar = document.createElement('div');
        const h   = Math.max(2, Math.round(((t.charge_amps || 0) / maxAmp) * 76));
        bar.style.cssText = `flex-shrink:0;width:4px;height:${h}px;background:var(--accent-solar);border-radius:2px 2px 0 0;opacity:0.8`;
        bar.title = `${t.charge_amps}A at ${formatTime(t.recorded_at)}`;
        chartEl.appendChild(bar);
      }
    }
  } catch (err) {
    console.error('[history] Expand session error:', err);
  }
}

// ─── Period savings summary ───

async function loadPeriodStats() {
  try {
    const data = await api('/api/stats/periods');
    if (!data.ok) return;
    const grid = document.getElementById('period-grid');
    if (!grid) return;

    const defs = [
      { key: 'today',   label: 'Today' },
      { key: 'week',    label: 'This Week' },
      { key: 'month',   label: 'This Month' },
      { key: 'quarter', label: 'This Quarter' },
      { key: 'year',    label: 'This Year' },
    ];

    grid.innerHTML = '';
    for (const def of defs) {
      const p = data.periods[def.key];
      const solarPct = p.total_kwh > 0 ? (p.solar_kwh / p.total_kwh) * 100 : 0;
      const gridPct  = p.total_kwh > 0 ? (p.grid_kwh  / p.total_kwh) * 100 : 0;

      const fuel = fuelComparison(p.total_kwh, p.grid_cost_aud);
      const units = fuelUnitLabels();
      const fuelTip = `~${fuel.kmDriven} ${units.distance} · RAV4 petrol $${fuel.petrolCost.toFixed(2)}, hybrid $${fuel.hybridCost.toFixed(2)}, EV $${fuel.evCost.toFixed(2)} · $${fuelSettings.petrolPriceAud.toFixed(2)}/${units.priceUnit}`;

      const card = document.createElement('div');
      card.className = 'period-card';
      card.innerHTML = `
        <div class="period-card-label">${def.label}</div>
        <div class="period-card-total">${p.total_kwh.toFixed(1)} <span style="font-size:0.75rem;color:var(--text-secondary);font-weight:500">kWh</span></div>
        <div class="period-split-bar">
          <div class="period-split-solar" style="width:${solarPct.toFixed(1)}%"></div>
          <div class="period-split-grid"  style="width:${gridPct.toFixed(1)}%"></div>
        </div>
        <div class="period-detail-row">
          <span class="period-solar-label">☀ ${p.solar_kwh.toFixed(1)} kWh</span>
          <span class="period-grid-label">⚡ ${p.grid_kwh.toFixed(1)} kWh</span>
        </div>
        <div class="period-footer-row">
          <span class="period-self-pct">${p.self_pct}% solar</span>
          <span class="period-savings" title="Estimated savings vs buying from grid">$${p.est_savings_aud.toFixed(2)} saved</span>
        </div>
        ${p.grid_cost_aud > 0 ? `
        <div class="period-footer-row" style="margin-top:0.1rem">
          <span></span>
          <span style="color:var(--accent-import);font-family:'JetBrains Mono',monospace;font-size:0.72rem;font-weight:600">$${p.grid_cost_aud.toFixed(2)} spent</span>
        </div>` : ''}
        ${p.total_kwh > 0 ? `
        <div class="period-fuel-compare" title="${fuelTip}">
          <div class="period-fuel-row">
            <span class="period-fuel-label">⛽ vs RAV4</span>
            <span class="period-fuel-saving">$${fuel.vsPetrol.toFixed(2)}</span>
          </div>
          <div class="period-fuel-row">
            <span class="period-fuel-label">🔋 vs RAV4 Hybrid</span>
            <span class="period-fuel-saving">$${fuel.vsHybrid.toFixed(2)}</span>
          </div>
        </div>` : ''}
      `;
      grid.appendChild(card);
    }
  } catch (err) {
    console.error('[history] Period stats error:', err);
  }
}

// ─── Eddi period stats ───

async function loadEddiPeriodStats() {
  try {
    const data = await api('/api/stats/eddi/periods');
    if (!data.ok) return;
    const grid = document.getElementById('eddi-period-grid');
    if (!grid) return;

    const defs = [
      { key: 'today',   label: 'Today' },
      { key: 'week',    label: 'This Week' },
      { key: 'month',   label: 'This Month' },
      { key: 'quarter', label: 'This Quarter' },
      { key: 'year',    label: 'This Year' },
    ];

    grid.innerHTML = '';
    for (const def of defs) {
      const p    = data.periods[def.key];
      const card = document.createElement('div');
      card.className = 'period-card';
      card.innerHTML = `
        <div class="period-card-label">${def.label}</div>
        <div class="period-card-total">${p.total_kwh.toFixed(1)} <span style="font-size:0.75rem;color:var(--text-secondary);font-weight:500">kWh</span></div>
        <div class="period-footer-row" style="margin-top:0.3rem">
          <span style="font-size:0.68rem;color:#fb923c;font-weight:600">💧 Hot Water</span>
          <span class="period-savings" title="Estimated savings vs heating from grid">$${p.est_savings_aud.toFixed(2)} saved</span>
        </div>
        ${p.grid_cost_aud > 0 ? `
        <div class="period-footer-row" style="margin-top:0.1rem">
          <span></span>
          <span style="color:var(--accent-import);font-family:'JetBrains Mono',monospace;font-size:0.72rem;font-weight:600" title="Grid boost energy cost">$${p.grid_cost_aud.toFixed(2)} spent</span>
        </div>` : ''}
      `;
      grid.appendChild(card);
    }
  } catch (err) {
    console.error('[history] Eddi period stats error:', err);
  }
}

// ─── Master (combined) period stats ───

async function loadMasterPeriodStats() {
  try {
    const data = await api('/api/stats/master/periods');
    if (!data.ok) return;
    const grid = document.getElementById('master-period-grid');
    if (!grid) return;

    const defs = [
      { key: 'today',   label: 'Today' },
      { key: 'week',    label: 'This Week' },
      { key: 'month',   label: 'This Month' },
      { key: 'quarter', label: 'This Quarter' },
      { key: 'year',    label: 'This Year' },
    ];

    grid.innerHTML = '';
    for (const def of defs) {
      const p    = data.periods[def.key];
      const card = document.createElement('div');
      card.className = 'master-card';
      card.innerHTML = `
        <div class="period-card-label">${def.label}</div>
        <div class="period-card-total">${p.total_kwh.toFixed(1)} <span style="font-size:0.75rem;color:var(--text-secondary);font-weight:500">kWh solar</span></div>
        <div style="display:flex;flex-direction:column;gap:0.15rem;margin-top:0.2rem">
          <div style="display:flex;justify-content:space-between;font-size:0.63rem">
            <span style="color:var(--accent-charge);font-weight:600">🚗 EV</span>
            <span style="color:var(--accent-charge);font-family:'JetBrains Mono',monospace;font-weight:600">${(p.car_kwh || 0).toFixed(1)} kWh</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:0.63rem">
            <span style="color:#fb923c;font-weight:600">💧 Hot Water</span>
            <span style="color:#fb923c;font-family:'JetBrains Mono',monospace;font-weight:600">${(p.hw_kwh || 0).toFixed(1)} kWh</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:0.63rem">
            <span style="color:var(--accent-solar);font-weight:600">🏠 House</span>
            <span style="color:var(--accent-solar);font-family:'JetBrains Mono',monospace;font-weight:600">${(p.house_solar_kwh || 0).toFixed(1)} kWh</span>
          </div>
        </div>
        <div class="period-footer-row" style="margin-top:0.2rem">
          <span></span>
          <span class="period-savings" title="Combined estimated savings vs full grid usage">$${p.est_savings_aud.toFixed(2)} saved</span>
        </div>
        ${p.grid_cost_aud > 0 ? `
        <div class="period-footer-row" style="margin-top:0.1rem">
          <span></span>
          <span style="color:var(--accent-import);font-family:'JetBrains Mono',monospace;font-size:0.72rem;font-weight:600">$${p.grid_cost_aud.toFixed(2)} spent</span>
        </div>` : ''}
      `;
      grid.appendChild(card);
    }
  } catch (err) {
    console.error('[history] Master period stats error:', err);
  }
}

// ─── House load period stats ─────────────────────────────────────────────────

async function loadHousePeriodStats() {
  try {
    const data = await api('/api/stats/house/periods');
    if (!data.ok) return;
    const grid = document.getElementById('house-period-grid');
    if (!grid) return;

    const defs = [
      { key: 'today',   label: 'Today' },
      { key: 'week',    label: 'This Week' },
      { key: 'month',   label: 'This Month' },
      { key: 'quarter', label: 'This Quarter' },
      { key: 'year',    label: 'This Year' },
    ];

    grid.innerHTML = '';
    for (const def of defs) {
      const p = data.periods[def.key];
      const solarPct = p.house_kwh > 0 ? (p.solar_kwh / p.house_kwh) * 100 : 0;
      const gridPct  = p.house_kwh > 0 ? (p.grid_kwh  / p.house_kwh) * 100 : 0;

      const card = document.createElement('div');
      card.className = 'period-card';
      card.innerHTML = `
        <div class="period-card-label">${def.label}</div>
        <div class="period-card-total">${p.house_kwh.toFixed(1)} <span style="font-size:0.75rem;color:var(--text-secondary);font-weight:500">kWh</span></div>
        <div class="period-split-bar">
          <div class="period-split-solar" style="width:${solarPct.toFixed(1)}%"></div>
          <div class="period-split-grid"  style="width:${gridPct.toFixed(1)}%"></div>
        </div>
        <div class="period-detail-row">
          <span class="period-solar-label">☀ ${p.solar_kwh.toFixed(1)} kWh</span>
          <span class="period-grid-label">⚡ ${p.grid_kwh.toFixed(1)} kWh</span>
        </div>
        <div class="period-footer-row">
          <span class="period-self-pct">${p.self_pct}% solar</span>
          <span style="color:var(--accent-import);font-family:'JetBrains Mono',monospace;font-size:0.75rem;font-weight:700"
                title="Estimated grid electricity cost for house load">$${p.grid_cost_aud.toFixed(2)} spent</span>
        </div>
      `;
      grid.appendChild(card);
    }
  } catch (err) {
    console.error('[history] House period stats error:', err);
  }
}

// ─── Bills section (embedded in Data page) ───────────────────────────────────

function formatBillPeriod(startMs, endMs) {
  if (!startMs) return '-';
  const fmt = { month: 'short', year: 'numeric' };
  const s = new Date(startMs).toLocaleDateString('en-AU', fmt);
  if (!endMs) return s;
  const e = new Date(endMs).toLocaleDateString('en-AU', fmt);
  if (s === e) return s;
  const sy = new Date(startMs).getFullYear(), ey = new Date(endMs).getFullYear();
  return sy === ey
    ? `${new Date(startMs).toLocaleDateString('en-AU', { month: 'short' })} – ${e}`
    : `${s} – ${e}`;
}

async function loadDataBills() {
  const tbody = document.getElementById('data-bills-tbody');
  if (!tbody) return;
  try {
    const data = await api('/api/stats/bills/comparison');
    if (!data.ok) { tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--text-secondary)">Error loading bills</td></tr>`; return; }
    const bills = data.bills || [];
    if (!bills.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--text-secondary)">No bills yet - upload a PDF, or forward one to the address shown under Settings &rarr; Bill Analysis</td></tr>`;
      return;
    }
    tbody.innerHTML = '';
    for (const b of bills) {
      const tr = document.createElement('tr');
      tr.style.borderBottom = 'none';
      tr.innerHTML = `
        <td style="padding:0.65rem 0.75rem 0.4rem">${formatBillPeriod(b.billing_period_start, b.billing_period_end)}</td>
        <td style="padding:0.65rem 0.75rem 0.4rem;color:var(--text-secondary)">${b.retailer || '-'}</td>
        <td style="padding:0.65rem 0.75rem 0.4rem;font-family:'JetBrains Mono',monospace;font-weight:600">${b.total_kwh != null ? b.total_kwh.toFixed(1) + ' kWh' : '-'}</td>
        <td style="padding:0.65rem 0.75rem 0.4rem;font-family:'JetBrains Mono',monospace;font-weight:600">${b.total_amount_aud != null ? '$' + b.total_amount_aud.toFixed(2) : '-'}</td>
        <td style="padding:0.65rem 0.75rem 0.4rem;font-family:'JetBrains Mono',monospace;font-weight:700;color:#4ade80">${b.wattsnatch_savings_aud > 0 ? '$' + b.wattsnatch_savings_aud.toFixed(2) : '-'}</td>
        <td style="padding:0.65rem 0.75rem 0.4rem;font-family:'JetBrains Mono',monospace;color:#fc814a;opacity:0.8">${b.without_wattsnatch_aud > 0 ? '$' + b.without_wattsnatch_aud.toFixed(2) : '-'}</td>
        <td style="padding:0.65rem 0.75rem 0.4rem">
          <button onclick="deleteDataBill(${b.id})" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:0.25rem 0.4rem" title="Delete">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </td>`;
      tbody.appendChild(tr);
      // Breakdown sub-row
      const breakdown = billBreakdownRow(b, 7);
      if (breakdown) {
        const tmp = document.createElement('tbody');
        tmp.innerHTML = breakdown;
        tbody.appendChild(tmp.firstElementChild);
      }
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--text-secondary)">Error: ${err.message}</td></tr>`;
  }
}

async function deleteDataBill(id) {
  if (!confirm('Delete this bill?')) return;
  const data = await api(`/api/bills/${id}`, { method: 'DELETE' }).catch(() => ({ ok: false }));
  if (data.ok) loadDataBills();
}

function setDataUploadStatus(type, msg) {
  const el = document.getElementById('data-upload-status');
  if (!el) return;
  el.style.display = msg ? 'block' : 'none';
  el.style.background = type === 'ok' ? 'rgba(74,222,128,0.1)' : type === 'error' ? 'rgba(248,113,113,0.1)' : 'rgba(245,166,35,0.08)';
  el.style.color = type === 'ok' ? '#4ade80' : type === 'error' ? '#f87171' : 'var(--accent-solar)';
  el.style.border = `1px solid ${type === 'ok' ? 'rgba(74,222,128,0.25)' : type === 'error' ? 'rgba(248,113,113,0.25)' : 'rgba(245,166,35,0.2)'}`;
  el.textContent = msg;
}

async function uploadDataBill(file) {
  if (!file) return;
  const looksLikePdf = file.type === 'application/pdf' || file.type === '' || file.name?.toLowerCase().endsWith('.pdf');
  if (!looksLikePdf) { setDataUploadStatus('error', 'Please choose a PDF file.'); return; }
  setDataUploadStatus('info', `Analysing ${file.name} with Gemini…`);
  const label = document.getElementById('data-upload-label');
  if (label) label.style.pointerEvents = 'none';
  try {
    const base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload  = e => res(e.target.result.split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    const data = await api('/api/bills/upload', { method: 'POST', body: { pdf: base64, filename: file.name } });
    if (data.ok) {
      const x = data.extracted;
      const period = x.billing_period_start ? `${x.billing_period_start} – ${x.billing_period_end || '?'}` : 'unknown period';
      setDataUploadStatus('ok', `✓ ${x.retailer || 'Bill'} imported - ${period}, $${(x.total_amount_aud || 0).toFixed(2)}`);
      loadDataBills();
    } else {
      setDataUploadStatus('error', 'Import failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    setDataUploadStatus('error', 'Error: ' + err.message);
  } finally {
    if (label) label.style.pointerEvents = '';
    try { const inp = document.getElementById('data-bill-input'); if (inp) inp.value = ''; } catch (_) {}
  }
}

// ─── Init ───

// ─── Diversion Log (Phase 5) ───

const DIVERSION_REASONS = {
  solar_diversion_active: { label: 'Solar diversion active', color: '#4ade80' },
  trip_priority_mode:     { label: 'Trip priority mode',     color: 'var(--accent-solar)' },
  below_threshold:        { label: 'Below threshold',        color: 'var(--text-secondary)' },
  hold_timer:             { label: 'Hold timer',             color: 'var(--accent-solar)' },
  override:               { label: 'Charge Now override',    color: '#63b3ed' },
  scheduled_charging:     { label: 'Scheduled charging',     color: '#63b3ed' },
  no_surplus:             { label: 'No surplus',             color: 'var(--text-secondary)' },
};

function formatLogTime(ms) {
  const d = new Date(ms);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function loadDiversionLog() {
  const tbody = document.getElementById('diversion-log-tbody');
  if (!tbody) return;
  try {
    const data = await api('/api/diversion-log?hours=24');
    const entries = (data && data.ok) ? data.entries : [];
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--text-secondary)">No diversion activity in the last 24 hours.</td></tr>';
      return;
    }
    const kw = (w) => ((w || 0) / 1000).toFixed(1) + ' kW';
    tbody.innerHTML = entries.map((e) => {
      const r = DIVERSION_REASONS[e.diversion_reason] || { label: e.diversion_reason || '-', color: 'var(--text-secondary)' };
      return `<tr>
        <td style="white-space:nowrap">${formatLogTime(e.recorded_at)}</td>
        <td><span style="color:${r.color};font-weight:600">${r.label}</span></td>
        <td>${e.controller_state || '-'}</td>
        <td>${kw(e.solar_w)}</td>
        <td>${kw(e.ev_w)}</td>
        <td>${kw(e.eddi_w)}</td>
        <td>${e.trip_within_18hrs ? 'Yes' : '-'}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--text-secondary)">Failed to load diversion log: ${err.message}</td></tr>`;
  }
}

// ─── Financial Dashboard (Phase 6) ───

async function loadFinancialDashboard() {
  try {
    const data = await api(`/api/financial/dashboard?month=${currentMonth}&year=${currentYear}`);
    if (!data.ok) {
      console.warn('Financial dashboard data unavailable');
      return;
    }

    const c = data.current_period;
    const r = data.running_totals;

    document.getElementById('financial-period-label').textContent = data.period_label;
    document.getElementById('financial-import-cost').textContent = `$${c.import_cost.toFixed(2)}`;
    document.getElementById('financial-export-credit').textContent = `-$${c.export_credit.toFixed(2)}`;
    document.getElementById('financial-supply-charge').textContent = `$${c.supply_charge.toFixed(2)}`;
    document.getElementById('financial-solar-avoided').textContent = `$${c.solar_avoided_cost.toFixed(2)}`;
    document.getElementById('financial-estimated-bill').textContent = c.estimated_bill >= 0 ? `$${c.estimated_bill.toFixed(2)}` : `-$${Math.abs(c.estimated_bill).toFixed(2)} CREDIT`;
    document.getElementById('financial-total-export').textContent = `$${r.total_export_earnings.toFixed(2)}`;
    document.getElementById('financial-total-solar-avoided').textContent = `$${r.total_solar_avoided_cost.toFixed(2)}`;
    document.getElementById('financial-total-net-benefit').textContent = `$${r.total_net_benefit.toFixed(2)}`;
  } catch (err) {
    console.warn('Failed to load financial dashboard:', err.message);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('prev-month')?.addEventListener('click', prevMonth);
  document.getElementById('next-month')?.addEventListener('click', nextMonth);
  await loadFuelSettings();   // load before rendering cards so comparison uses saved values
  loadMasterPeriodStats();
  loadPeriodStats();
  loadEddiPeriodStats();
  loadHousePeriodStats();
  loadMonthlyStats();
  loadSessions(1);
  loadDataBills();
  loadDiversionLog();
  loadFinancialDashboard();

  // If linked from the dashboard's "View diversion log", scroll the log into view
  if (window.location.hash === '#diversion-log') {
    setTimeout(() => document.getElementById('diversion-log')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
  }

  // Bill upload input
  document.getElementById('data-bill-input')?.addEventListener('change', e => {
    if (e.target.files[0]) uploadDataBill(e.target.files[0]);
  });

  // Check email button
  document.getElementById('data-poll-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('data-poll-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    setDataUploadStatus('info', 'Polling for new bills…');
    try {
      const data = await api('/api/bills/poll', { method: 'POST', body: {} });
      if (data.ok) { setDataUploadStatus('ok', 'Done - inbox checked.'); loadDataBills(); }
      else setDataUploadStatus('error', data.error || 'Poll failed');
    } catch (err) { setDataUploadStatus('error', err.message); }
    finally { if (btn) { btn.disabled = false; btn.textContent = 'Check email'; } }
  });
});
