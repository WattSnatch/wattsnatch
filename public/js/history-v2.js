/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

// ─── Data Tab v2 (Phase 10) ───

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

// ─── Fuel comparison (Car Charging cards) ───
let fuelSettings = {
  evKwhPer100km:    17.0,
  petrolLPer100km:   8.4,
  hybridLPer100km:   4.9,
  petrolPriceAud:    2.05,
};
let supplyChargeDailyAud = 0.9449; // default - overridden by settings

async function loadFuelSettings() {
  try {
    const data = await api('/api/settings');
    if (!data.ok) return;
    const s = data.settings;
    if (s.fuel_ev_kwh_per_100km)    fuelSettings.evKwhPer100km   = parseFloat(s.fuel_ev_kwh_per_100km);
    if (s.fuel_petrol_l_per_100km)  fuelSettings.petrolLPer100km = parseFloat(s.fuel_petrol_l_per_100km);
    if (s.fuel_hybrid_l_per_100km)  fuelSettings.hybridLPer100km = parseFloat(s.fuel_hybrid_l_per_100km);
    if (s.fuel_petrol_price_aud)    fuelSettings.petrolPriceAud  = parseFloat(s.fuel_petrol_price_aud);
    if (s.supply_charge_daily_aud)  supplyChargeDailyAud         = parseFloat(s.supply_charge_daily_aud);
  } catch (_e) {}
}

// How many days have elapsed so far in the given period (used for supply charge)
function getPeriodDays(period) {
  const today = new Date();
  switch (period) {
    case 'today':   return 1;
    case 'week': {
      const dow = (today.getDay() + 6) % 7; // Mon=0 … Sun=6
      return dow + 1;
    }
    case 'month':   return today.getDate();
    case 'quarter': {
      const qStart = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1);
      return Math.floor((today - qStart) / 86400000) + 1;
    }
    case 'year': {
      const yStart = new Date(today.getFullYear(), 0, 1);
      return Math.floor((today - yStart) / 86400000) + 1;
    }
    case 'last_week':    return 7;
    case 'last_month': {
      const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const lastMonthEnd   = new Date(today.getFullYear(), today.getMonth(), 0);
      return lastMonthEnd.getDate() - lastMonthStart.getDate() + 1;
    }
    case 'last_quarter': {
      const qStart = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3 - 3, 1);
      const qEnd   = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 0);
      return Math.floor((qEnd - qStart) / 86400000) + 1;
    }
    case 'last_year': {
      const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      return isLeap(today.getFullYear() - 1) ? 366 : 365;
    }
    case 'custom': {
      if (customRange.from && customRange.to) {
        const start = new Date(customRange.from + 'T00:00:00');
        const end   = new Date(customRange.to   + 'T00:00:00');
        return Math.max(1, Math.floor((end - start) / 86400000) + 1);
      }
      return 1;
    }
    default: return 1;
  }
}

function fuelComparison(totalKwh, gridCostAud) {
  const f = fuelSettings;
  const km = (totalKwh / f.evKwhPer100km) * 100;
  const petrolCost = km * (f.petrolLPer100km / 100) * f.petrolPriceAud;
  const hybridCost = km * (f.hybridLPer100km / 100) * f.petrolPriceAud;
  const evCost = gridCostAud || 0;
  return {
    km: Math.round(km),
    vsPetrol: petrolCost - evCost,
    vsHybrid: hybridCost - evCost,
    petrolCost, hybridCost, evCost,
  };
}

const SERIES_COLORS = {
  solar: 'var(--accent-solar)',
  house: '#63b3ed',
  ev: 'var(--accent-charge)',
  hw: '#fb923c',
  ac: '#38bdf8',
};

// Ripl's canvas charts need resolved color values, not CSS custom-property
// references - `ctx.fillStyle = 'var(--x)'` is not a valid Canvas2D color.
function cssVar(value) {
  const m = /^var\((--[\w-]+)\)$/.exec(value || '');
  if (!m) return value;
  return getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || value;
}

let currentYear  = new Date().getFullYear();
let currentMonth = new Date().getMonth() + 1;
let currentPage  = 1;
let totalPages   = 1;

// Active series for charts
let activeSeries = {
  house: true,
  ev: true,
  hw: true,
  ac: true,
};

// Active heatmap type
let activeHeatmapType = 'solar';

// ─── Energy Score Calculation (Step 10.3) ───

function calculateEnergyScore(dayData) {
  if (!dayData || !dayData.kwh_generated || dayData.kwh_generated === 0) return 0;

  // Component 1 (40%): Self-use - how much of your solar you consumed vs exported.
  // High = you used your own generation rather than sending it to the grid.
  const selfUseScore = Math.min(100, (dayData.kwh_self_consumed / dayData.kwh_generated) * 100);

  // Component 2 (40%): Self-sufficiency - what fraction of ALL consumption came from solar.
  // Uses total consumption (EV + hot water + house), not house-only.
  // Previously only measured house-only load, ignoring 10+ kWh of hot water and EV solar.
  const totalConsumed = dayData.kwh_house_total + (dayData.kwh_ev_total || 0) + (dayData.kwh_hw_total || 0);
  const totalSolar    = dayData.kwh_self_consumed;
  const selfSuffScore = totalConsumed > 0
    ? Math.min(100, (totalSolar / totalConsumed) * 100)
    : 0;

  // Component 3 (20%): Grid penalty - how much of total consumption was from the grid.
  // Gentler than before (150× vs 200×) and uses total consumption as denominator,
  // so hot water and EV solar work in your favour rather than being ignored.
  const noGridScore = dayData.kwh_imported === 0 ? 100
    : Math.max(0, 100 - (dayData.kwh_imported / Math.max(totalConsumed, 1)) * 150);

  return Math.round(selfUseScore * 0.4 + selfSuffScore * 0.4 + noGridScore * 0.2);
}

function updateSelfSuffRing(pct) {
  const circle = document.getElementById('scoreRingCircle');
  if (!circle) return;

  const circumference = 2 * Math.PI * 80;
  circle.style.strokeDashoffset = circumference - (pct / 100) * circumference;
  document.getElementById('energy-score-value').textContent = Math.round(pct);

  const sublabel = document.getElementById('energy-score-sublabel');
  if (sublabel) {
    sublabel.innerHTML = 'running on<br>sunshine ☀️';
  }
}

// ─── Unified period data loader ───
// Drives both the savings hero block AND the 6 kWh stat cards.
// Called on page load (defaults to 'month') and whenever a period toggle is clicked.

let activePeriod = 'month';
let customRange = { from: null, to: null };

const PERIOD_LABELS = {
  today:        'Today',
  week:         'This Week',
  month:        'This Month',
  quarter:      'This Quarter',
  year:         'This Year',
  last_week:    'Last Week',
  last_month:   'Last Month',
  last_quarter: 'Last Quarter',
  last_year:    'Last Year',
  custom:       'Custom Range',
};

async function loadPeriodData(period) {
  activePeriod = period || activePeriod;

  // Custom range needs ?from=&to= on every period-stat call so the backend
  // can populate the `custom` key alongside the fixed periods.
  const qs = (activePeriod === 'custom' && customRange.from && customRange.to)
    ? `?from=${encodeURIComponent(customRange.from)}&to=${encodeURIComponent(customRange.to)}`
    : '';

  const spinner = document.getElementById('savings-loading-spinner');
  if (spinner) spinner.style.display = 'inline-block';

  try {
    const [evRes, hwRes, houseRes, masterRes, solarKmRes] = await Promise.all([
      api('/api/stats/periods' + qs),
      api('/api/stats/eddi/periods' + qs),
      api('/api/stats/house/periods' + qs),
      api('/api/stats/master/periods' + qs),
      api('/api/stats/solar-km' + qs),
    ]);

    const ev     = evRes?.ok     ? evRes.periods[activePeriod]     : {};
    const hw     = hwRes?.ok     ? hwRes.periods[activePeriod]     : {};
    const house  = houseRes?.ok  ? houseRes.periods[activePeriod]  : {};
    const master = masterRes?.ok ? masterRes.periods[activePeriod] : {};

    // ── Solar figure ──────────────────────────────────────────────────────────
    let solarKwh, exportKwh = 0, solarSubtext;
    if (activePeriod === 'today') {
      try {
        const [gwData, telData] = await Promise.all([
          api('/api/stats/enphase/today'),
          api('/api/telemetry/today'),
        ]);
        solarKwh  = (gwData.ok && gwData.whToday > 0)
          ? gwData.whToday / 1000
          : (telData?.stats?.solar?.solar_kwh || 0);
        exportKwh = telData?.stats?.solar?.grid_export_kwh || 0;
      } catch (_e) { solarKwh = 0; }
      solarSubtext = exportKwh > 0.05
        ? exportKwh.toFixed(1) + ' kWh exported'
        : Math.max(0, solarKwh - exportKwh).toFixed(1) + ' kWh self-consumed';
    } else {
      // hw.total_kwh is ALL energy delivered to hot water, including the
      // grid-boosted portion - only the non-boost part is actually solar.
      solarKwh     = (ev.solar_kwh || 0) + Math.max(0, (hw.total_kwh || 0) - (hw.boost_kwh || 0)) + (house.solar_kwh || 0);
      solarSubtext = 'solar self-consumed';
    }

    const selfConsumed  = activePeriod === 'today' ? Math.max(0, solarKwh - exportKwh) : solarKwh;
    const totalGridKwh  = (house.grid_kwh      || 0) + (ev.grid_kwh      || 0);
    const totalGridCost = (house.grid_cost_aud  || 0) + (ev.grid_cost_aud  || 0);
    const totalLoad     = (house.house_kwh      || 0) + (ev.total_kwh      || 0) + (hw.total_kwh || 0);

    // The self-sufficiency ring needs a numerator sourced the same way as
    // totalLoad (both from telemetry_log/eddi_telemetry) so the ratio can't
    // exceed 100%. "Today" uses a live Enphase hardware accumulator for
    // `solarKwh` above (immune to polling gaps, which is correct for the
    // "Today's Solar" production figure) - but that means it isn't
    // comparable to a totalLoad that CAN be undercounted by a polling gap.
    // Reuse the same telemetry-derived formula as other periods here instead.
    const solarForRatio = activePeriod === 'today'
      ? (ev.solar_kwh || 0) + Math.max(0, (hw.total_kwh || 0) - (hw.boost_kwh || 0)) + (house.solar_kwh || 0)
      : selfConsumed;
    const selfSuffPct   = totalLoad > 0 ? Math.min(100, Math.round(solarForRatio / totalLoad * 100)) : 0;
    const label         = PERIOD_LABELS[activePeriod] || activePeriod;
    const isToday       = activePeriod === 'today';
    const fmt           = (v) => '$' + v.toFixed(2);
    const el            = (id) => document.getElementById(id);

    // Solar sub-label
    if (isToday) {
      solarSubtext = exportKwh > 0.05
        ? exportKwh.toFixed(1) + ' kWh back to the grid'
        : selfConsumed.toFixed(1) + ' kWh kept on your property';
    } else {
      solarSubtext = 'off your roof, on your side';
    }

    // ── Savings hero ──────────────────────────────────────────────────────────
    const evSaved    = ev?.est_savings_aud     || 0;
    const hwSaved    = hw?.est_savings_aud     || 0;
    const totalSaved = master?.est_savings_aud  || 0;
    const houseSaved = Math.max(0, totalSaved - evSaved - hwSaved);
    const totalSpent = master?.grid_cost_aud   || 0;
    const evSpent    = ev?.grid_cost_aud       || 0;
    const hwSpent    = hw?.grid_cost_aud       || 0;
    const houseSpent = house?.grid_cost_aud    || 0;

    // Supply charge for this period. The server figure is priced day-by-day
    // from tariff_history, so past periods keep the rate that actually applied
    // then - days × today's setting is only the fallback for older servers.
    const periodDays    = getPeriodDays(activePeriod);
    const supplyCharge  = master?.supply_charge_aud != null
      ? master.supply_charge_aud
      : periodDays * supplyChargeDailyAud;

    el('sh-total-saved').textContent     = fmt(totalSaved);
    el('sh-total-spent').textContent     = fmt(totalSpent);
    el('sh-supply-charge').textContent   = fmt(supplyCharge);
    el('sh-total-all-spent').textContent = fmt(totalSpent + supplyCharge);

    el('sh-ev-saved').textContent    = fmt(evSaved);
    el('sh-hw-saved').textContent    = fmt(hwSaved);
    el('sh-house-saved').textContent = fmt(houseSaved);

    // Spent per category (in red, only show if > $0.00)
    el('sh-ev-spent').textContent    = evSpent    > 0.005 ? fmt(evSpent)    + ' spent' : '';
    el('sh-hw-spent').textContent    = hwSpent    > 0.005 ? fmt(hwSpent)    + ' spent' : '';
    el('sh-house-spent').textContent = houseSpent > 0.005 ? fmt(houseSpent) + ' spent' : '';

    // ── Stat card labels ──────────────────────────────────────────────────────
    if (el('hero-solar-label'))    el('hero-solar-label').textContent    = isToday ? "Today's Solar"  : label + ' Solar';
    if (el('hero-house-label'))    el('hero-house-label').textContent    = 'Total house load powered by sunshine';
    if (el('hero-ev-label'))       el('hero-ev-label').textContent       = 'EV charging powered by sunshine';
    if (el('hero-hw-label'))       el('hero-hw-label').textContent       = 'Hot water powered by sunshine';
    if (el('hero-import-label'))   el('hero-import-label').textContent   = label + ' Grid Import';
    if (el('hero-self-pct-label')) el('hero-self-pct-label').textContent = 'Grid Reliance';

    // ── Stat card values ──────────────────────────────────────────────────────
    el('hero-solar').textContent         = solarKwh.toFixed(1) + ' kWh';
    el('hero-solar-sub').textContent     = solarSubtext;

    // House load: solar % BIG, kWh medium
    el('hero-house').textContent         = (house.self_pct || 0) + '%';
    el('hero-house-sub').innerHTML       = `<span style="font-size:1.1rem;font-weight:700;font-family:'JetBrains Mono',monospace;color:#63b3ed">${(house.house_kwh || 0).toFixed(1)} kWh</span>`;

    // EV: solar % BIG, kWh medium
    el('hero-ev').textContent            = (ev.self_pct || 0) + '%';
    el('hero-ev-sub').innerHTML          = `<span style="font-size:1.1rem;font-weight:700;font-family:'JetBrains Mono',monospace;color:var(--accent-charge)">${(ev.total_kwh || 0).toFixed(1)} kWh</span>`;

    // Hot water: solar % BIG, kWh medium
    const hwSolarPct = (hw.total_kwh || 0) > 0 ? Math.round(((hw.total_kwh - (hw.boost_kwh || 0)) / hw.total_kwh) * 100) : 0;
    el('hero-hw').textContent            = hwSolarPct + '%';
    el('hero-hw-sub').innerHTML          = `<span style="font-size:1.1rem;font-weight:700;font-family:'JetBrains Mono',monospace;color:#fb923c">${(hw.total_kwh || 0).toFixed(1)} kWh</span>`;

    el('hero-import').textContent        = totalGridKwh.toFixed(1) + ' kWh';
    el('hero-import-sub').textContent    = fmt(totalGridCost) + ' in grid costs';

    const gridReliancePct = totalLoad > 0 ? Math.round(totalGridKwh / totalLoad * 100) : 0;
    el('hero-self-pct').textContent      = gridReliancePct + '%';
    el('hero-self-pct-sub').textContent  = totalGridKwh.toFixed(1) + ' kWh from the grid';

    // ── Self-sufficiency ring - same metric for all periods ───────────────────
    updateSelfSuffRing(selfSuffPct);

    // ── km Origins ────────────────────────────────────────────────────────────
    if (solarKmRes?.ok) {
      const skp = solarKmRes.periods[activePeriod];
      const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };

      set('solar-km-value', skp.solar_km.toLocaleString());
      set('solar-km-kwh',   skp.solar_kwh.toFixed(1));
      set('solar-km-eff',   solarKmRes.km_per_kwh);

      set('grid-km-value',  skp.grid_km.toLocaleString());
      set('grid-km-kwh',    skp.grid_kwh.toFixed(1));

      set('public-km-value', skp.public_km != null ? skp.public_km.toLocaleString() : '-');
      set('public-km-kwh',   skp.public_kwh != null ? skp.public_kwh.toFixed(1) : '-');
    }

  } catch (err) {
    console.error('loadPeriodData error:', err);
  } finally {
    if (spinner) spinner.style.display = 'none';
  }
}

function setupPeriodToggles() {
  document.querySelectorAll('.savings-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.savings-period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadPeriodData(btn.dataset.period);
    });
  });

  const applyBtn  = document.getElementById('sh-date-apply');
  const fromInput = document.getElementById('sh-date-from');
  const toInput   = document.getElementById('sh-date-to');
  if (applyBtn && fromInput && toInput) {
    applyBtn.addEventListener('click', () => {
      if (!fromInput.value || !toInput.value) return;
      if (toInput.value < fromInput.value) return;
      customRange = { from: fromInput.value, to: toInput.value };
      document.querySelectorAll('.savings-period-btn').forEach(b => b.classList.remove('active'));
      loadPeriodData('custom');
    });
  }
}

// ─── Load Bill Estimate ───

async function loadBillEstimate() {
  try {
    const data = await api(`/api/financial/dashboard?month=${currentMonth}&year=${currentYear}`);
    if (!data.ok) return;

    const c = data.current_period;
    document.getElementById('bill-usage').textContent = '-';
    document.getElementById('bill-credit').textContent = `-$${c.export_credit.toFixed(2)}`;
    document.getElementById('bill-supply').textContent = `$${c.supply_charge.toFixed(2)}`;
    document.getElementById('bill-estimate').textContent = c.estimated_bill >= 0
      ? `$${c.estimated_bill.toFixed(2)}`
      : `-$${Math.abs(c.estimated_bill).toFixed(2)} CREDIT`;
  } catch (err) {
    console.error('Bill estimate error:', err);
  }
}

// ─── Monthly Stats & Charts ───

async function loadMonthlyStats() {
  document.getElementById('month-label').textContent =
    MONTH_NAMES[currentMonth - 1] + ' ' + currentYear;

  const now = new Date();
  const isCurrentMonth = currentYear === now.getFullYear() && currentMonth === now.getMonth() + 1;
  document.getElementById('next-month').disabled = isCurrentMonth;

  try {
    const [data, houseData] = await Promise.all([
      api(`/api/stats/monthly?year=${currentYear}&month=${currentMonth}`),
      api(`/api/stats/house/monthly?year=${currentYear}&month=${currentMonth}`),
    ]);
    if (!data.ok) return;

    renderDailyChart(data.days, houseData?.days || []);
    renderSolarBreakdown(data.days, houseData?.days || []);
    renderCalendarHeatmap(data.days, houseData?.days || []);
  } catch (err) {
    console.error('Monthly stats error:', err);
  }
}

// Solar/grid split per device (previously shown inline in this chart's tooltip) lives in the
// "Solar Breakdown" card rendered right below this one (renderSolarBreakdown) - not duplicated
// here now that the tooltip is Ripl's shared axis-trigger tooltip (one series list per day).
let _dailyChart = null;
function renderDailyChart(days, houseDays) {
  const container = document.getElementById('daily-chart-area');
  if (!container || !window.Ripl) return;

  const data = days.map(d => {
    const hd = houseDays.find(x => x.day === d.day) || {};
    return {
      day:   d.day,
      house: hd.house_kwh || 0,
      ev:    (d.solar_kwh || 0) + (d.grid_kwh || 0),
      hw:    d.hw_kwh || 0,
      ac:    d.ac_kwh || 0,
    };
  });

  const series = [];
  if (activeSeries.house) series.push({ id: 'house', label: 'House',     value: 'house', color: cssVar(SERIES_COLORS.house) });
  if (activeSeries.ev)    series.push({ id: 'ev',    label: 'EV',        value: 'ev',    color: cssVar(SERIES_COLORS.ev) });
  if (activeSeries.hw)    series.push({ id: 'hw',    label: 'Hot Water', value: 'hw',    color: cssVar(SERIES_COLORS.hw) });
  if (activeSeries.ac)    series.push({ id: 'ac',    label: 'AC',        value: 'ac',    color: cssVar(SERIES_COLORS.ac) });

  container.innerHTML = '';
  _dailyChart = window.Ripl.createBarChart(container, {
    theme: 'dark',
    data,
    key: 'day',
    series,
    stacked: true,
    tooltip: { trigger: 'axis' },
    format: (v) => v.toFixed(1) + ' kWh',
    legend: false, // the series toggle buttons above the chart already act as the legend
  });
  _dailyChart.render();
}

function renderSolarBreakdown(days, houseDays) {
  const card = document.getElementById('solar-breakdown-card');
  const body = document.getElementById('solar-breakdown-body');
  if (!card || !body) return;

  // Sum up solar vs grid per device across the month
  let houseSolar = 0, houseGrid = 0;
  let evSolar    = 0, evGrid    = 0;
  let hwSolar    = 0, hwGrid    = 0;
  let acTotal    = 0;

  for (const hd of houseDays) {
    houseSolar += hd.house_solar_kwh || 0;
    houseGrid  += hd.house_grid_kwh  || 0;
  }
  for (const d of days) {
    evSolar += d.solar_kwh     || 0;
    evGrid  += d.grid_kwh      || 0;
    hwSolar += d.hw_kwh        || 0;
    hwGrid  += d.hw_boost_kwh  || 0;
    acTotal += d.ac_kwh        || 0;
  }

  const totalSolar = houseSolar + evSolar + hwSolar;
  const totalGrid  = houseGrid  + evGrid  + hwGrid;
  const grandTotal = totalSolar + totalGrid;
  if (grandTotal < 0.1) { card.style.display = 'none'; return; }

  card.style.display = 'block';
  const solarPct = Math.round((totalSolar / grandTotal) * 100);
  const gridPct  = 100 - solarPct;

  const fmt = v => v.toFixed(1);

  const devices = [
    { name: 'House',     solar: houseSolar, grid: houseGrid, color: '#63b3ed' },
    { name: 'EV',        solar: evSolar,    grid: evGrid,    color: 'var(--accent-charge)' },
    { name: 'Hot Water', solar: hwSolar,    grid: hwGrid,    color: '#fb923c' },
  ];
  if (acTotal > 0.1) devices.push({ name: 'AC', solar: 0, grid: acTotal, color: '#38bdf8' });

  body.innerHTML = `
    <div class="breakdown-summary">
      <div class="breakdown-summary-item">
        <span class="breakdown-summary-value solar">${fmt(totalSolar)} kWh</span>
        <span class="breakdown-summary-label">☀ Solar consumed (${solarPct}%)</span>
      </div>
      <div class="breakdown-summary-item">
        <span class="breakdown-summary-value grid">${fmt(totalGrid)} kWh</span>
        <span class="breakdown-summary-label">⚡ Grid imported (${gridPct}%)</span>
      </div>
    </div>
    <div class="breakdown-total-bar">
      <div class="seg-solar" style="width:${solarPct}%"></div>
      <div class="seg-grid"  style="width:${gridPct}%"></div>
    </div>
    <div class="breakdown-devices">
      ${devices.map(dev => {
        const total    = dev.solar + dev.grid;
        if (total < 0.05) return '';
        const sPct     = total > 0 ? Math.round((dev.solar / total) * 100) : 0;
        const gPct     = 100 - sPct;
        const detail   = dev.grid > 0
          ? `${fmt(dev.solar)} kWh solar · ${fmt(dev.grid)} kWh grid`
          : `${fmt(dev.solar)} kWh - 100% solar`;
        return `
          <div class="breakdown-device-row">
            <div class="breakdown-device-header">
              <span class="breakdown-device-name" style="color:${dev.color}">${dev.name}</span>
              <span class="breakdown-device-stats">${detail}</span>
            </div>
            <div class="breakdown-device-bar">
              <div class="seg-solar" style="width:${sPct}%"></div>
              <div class="seg-grid"  style="width:${gPct}%"></div>
            </div>
          </div>`;
      }).join('')}
    </div>`;
}

// ─── Period Summary Cards ───

const PERIOD_DEFS = [
  { key: 'today',   label: 'Today' },
  { key: 'week',    label: 'This Week' },
  { key: 'month',   label: 'This Month' },
  { key: 'quarter', label: 'This Quarter' },
  { key: 'year',    label: 'This Year' },
];

async function loadMasterPeriodStats() {
  try {
    const data = await api('/api/stats/master/periods');
    if (!data.ok) return;
    const grid = document.getElementById('master-period-grid');
    if (!grid) return;
    grid.innerHTML = '';

    for (const def of PERIOD_DEFS) {
      const p = data.periods[def.key];
      const card = document.createElement('div');
      card.className = 'period-card master';
      card.innerHTML = `
        <div class="period-card-label">${def.label}</div>
        <div class="period-card-total">${p.total_kwh.toFixed(1)} <span style="font-size:0.7rem;color:var(--text-secondary);font-weight:500">kWh solar</span></div>
        <div style="display:flex;flex-direction:column;gap:0.1rem;margin-top:0.2rem">
          <div style="display:flex;justify-content:space-between;font-size:0.62rem">
            <span style="color:var(--accent-charge);font-weight:600">🚗 EV</span>
            <span style="color:var(--accent-charge);font-family:'JetBrains Mono',monospace;font-weight:600">${(p.car_kwh||0).toFixed(1)} kWh</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:0.62rem">
            <span style="color:#fb923c;font-weight:600">💧 Hot Water</span>
            <span style="color:#fb923c;font-family:'JetBrains Mono',monospace;font-weight:600">${(p.hw_kwh||0).toFixed(1)} kWh</span>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:0.62rem">
            <span style="color:var(--accent-solar);font-weight:600">🏠 House</span>
            <span style="color:var(--accent-solar);font-family:'JetBrains Mono',monospace;font-weight:600">${(p.house_solar_kwh||0).toFixed(1)} kWh</span>
          </div>
        </div>
        <div class="period-footer-row" style="margin-top:0.2rem">
          <span></span>
          <span class="period-savings" title="Combined estimated savings vs full grid usage">$${p.est_savings_aud.toFixed(2)} saved</span>
        </div>
        ${p.grid_cost_aud > 0 ? `
        <div class="period-footer-row" style="margin-top:0.05rem">
          <span></span>
          <span style="color:var(--accent-import);font-family:'JetBrains Mono',monospace;font-size:0.67rem;font-weight:600">$${p.grid_cost_aud.toFixed(2)} spent</span>
        </div>` : ''}
      `;
      grid.appendChild(card);
    }
  } catch (err) { console.error('Master period stats error:', err); }
}

async function loadEVPeriodStats() {
  try {
    const data = await api('/api/stats/periods');
    if (!data.ok) return;
    const grid = document.getElementById('ev-period-grid');
    if (!grid) return;
    grid.innerHTML = '';

    for (const def of PERIOD_DEFS) {
      const p = data.periods[def.key];
      const solarPct = p.total_kwh > 0 ? (p.solar_kwh / p.total_kwh) * 100 : 0;
      const gridPct  = p.total_kwh > 0 ? (p.grid_kwh  / p.total_kwh) * 100 : 0;
      const fuel = fuelComparison(p.total_kwh, p.grid_cost_aud);
      const fuelTip = `~${fuel.km} km · RAV4 petrol $${fuel.petrolCost.toFixed(2)}, hybrid $${fuel.hybridCost.toFixed(2)}, EV $${fuel.evCost.toFixed(2)}`;

      const card = document.createElement('div');
      card.className = 'period-card';
      card.innerHTML = `
        <div class="period-card-label">${def.label}</div>
        <div class="period-card-total">${p.total_kwh.toFixed(1)} <span style="font-size:0.7rem;color:var(--text-secondary);font-weight:500">kWh</span></div>
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
        <div class="period-footer-row" style="margin-top:0.05rem">
          <span></span>
          <span style="color:var(--accent-import);font-family:'JetBrains Mono',monospace;font-size:0.67rem;font-weight:600">$${p.grid_cost_aud.toFixed(2)} spent</span>
        </div>` : ''}
        ${p.total_kwh > 0 ? `
        <div class="period-fuel-compare" title="${fuelTip}">
          <div class="period-fuel-row">
            <span class="period-fuel-label">⛽ vs RAV4 petrol</span>
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
  } catch (err) { console.error('EV period stats error:', err); }
}

async function loadHWPeriodStats() {
  try {
    const data = await api('/api/stats/eddi/periods');
    if (!data.ok) return;
    const grid = document.getElementById('hw-period-grid');
    if (!grid) return;
    grid.innerHTML = '';

    for (const def of PERIOD_DEFS) {
      const p        = data.periods[def.key];
      const solarKwh = Math.max(0, (p.total_kwh || 0) - (p.boost_kwh || 0));
      const boostKwh = p.boost_kwh || 0;
      const totalKwh = solarKwh + boostKwh;
      const solarPct = totalKwh > 0 ? (solarKwh / totalKwh) * 100 : 100;
      const boostPct = totalKwh > 0 ? (boostKwh / totalKwh) * 100 : 0;

      const card = document.createElement('div');
      card.className = 'period-card';
      card.innerHTML = `
        <div class="period-card-label">${def.label}</div>
        <div class="period-card-total">${totalKwh.toFixed(1)} <span style="font-size:0.7rem;color:var(--text-secondary);font-weight:500">kWh</span></div>
        ${totalKwh > 0 ? `
        <div class="period-split-bar">
          <div class="period-split-solar" style="width:${solarPct.toFixed(1)}%"></div>
          <div class="period-split-grid"  style="width:${boostPct.toFixed(1)}%"></div>
        </div>
        <div class="period-detail-row">
          <span class="period-solar-label">☀ ${solarKwh.toFixed(1)} kWh</span>
          ${boostKwh > 0 ? `<span class="period-grid-label">⚡ ${boostKwh.toFixed(1)} kWh</span>` : ''}
        </div>` : ''}
        <div class="period-footer-row" style="margin-top:0.3rem">
          <span class="period-savings" title="Estimated savings vs heating from grid">$${(p.est_savings_aud || 0).toFixed(2)} saved</span>
          ${p.grid_cost_aud > 0 ? `<span style="color:var(--accent-import);font-family:'JetBrains Mono',monospace;font-size:0.67rem;font-weight:600" title="Grid boost cost">$${p.grid_cost_aud.toFixed(2)} spent</span>` : ''}
        </div>
      `;
      grid.appendChild(card);
    }
  } catch (err) { console.error('HW period stats error:', err); }
}

async function loadHousePeriodStats() {
  try {
    const data = await api('/api/stats/house/periods');
    if (!data.ok) return;
    const grid = document.getElementById('house-period-grid');
    if (!grid) return;
    grid.innerHTML = '';

    for (const def of PERIOD_DEFS) {
      const p = data.periods[def.key];
      const solarPct = p.house_kwh > 0 ? (p.solar_kwh / p.house_kwh) * 100 : 0;
      const gridPct  = p.house_kwh > 0 ? (p.grid_kwh  / p.house_kwh) * 100 : 0;

      const card = document.createElement('div');
      card.className = 'period-card';
      card.innerHTML = `
        <div class="period-card-label">${def.label}</div>
        <div class="period-card-total">${p.house_kwh.toFixed(1)} <span style="font-size:0.7rem;color:var(--text-secondary);font-weight:500">kWh</span></div>
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
          <span style="color:var(--accent-import);font-family:'JetBrains Mono',monospace;font-size:0.7rem;font-weight:700"
                title="Estimated grid electricity cost for house load">$${p.grid_cost_aud.toFixed(2)} spent</span>
        </div>
      `;
      grid.appendChild(card);
    }
  } catch (err) { console.error('House period stats error:', err); }
}

// Weeks are positional 7-day chunks starting from day 1 of the month (not aligned to real
// weekdays) - matches the original grid's semantics exactly, just re-rendered via Ripl.
function _calendarHeatmapValue(d, houseDays) {
  switch (activeHeatmapType) {
    case 'solar': {
      const hd = houseDays.find(x => x.day === d.day);
      return (hd?.house_solar_kwh || 0) + (d.solar_kwh || 0) + (d.hw_kwh || 0);
    }
    case 'house': {
      const hd = houseDays.find(x => x.day === d.day);
      return hd ? (hd.house_kwh || 0) : 0;
    }
    case 'ev': return (d.solar_kwh || 0) + (d.grid_kwh || 0);
    case 'hw': return d.hw_kwh || 0;
    case 'ac': return d.ac_kwh || 0;
    default:   return 0;
  }
}

let _calendarHeatmapChart = null;
function renderCalendarHeatmap(days, houseDays) {
  const container = document.getElementById('calendar-heatmap');
  if (!container || !window.Ripl) return;

  const weeks = [];
  let currentWeek = [];
  for (const d of days) {
    currentWeek.push(d);
    if (currentWeek.length === 7) { weeks.push(currentWeek); currentWeek = []; }
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);

  const xCategories = ['1', '2', '3', '4', '5', '6', '7'];
  // Short labels ("W1") rather than "Week 1 (1-7)" keep the y-axis label column
  // narrow and predictable, which matters for the square-cell sizing below -
  // the full date range is still in the tooltip via the data below.
  const yCategories = weeks.map((_, i) => `W${i + 1}`);

  const data = [];
  weeks.forEach((week, wi) => {
    week.forEach((d, di) => {
      data.push({ x: xCategories[di], y: yCategories[wi], value: _calendarHeatmapValue(d, houseDays), day: d.day });
    });
  });

  const colors = activeHeatmapType === 'ev'
    ? ['#12241a', cssVar(SERIES_COLORS.ev)]
    : ['#2a1f10', cssVar(SERIES_COLORS.solar)];

  // Ripl sizes cells to fill whatever container height it's given, so a fixed
  // CSS height (unlike the old CSS `aspect-ratio: 1` cells) stretches them
  // into rectangles. Approximate square cells by deriving the container's
  // height from its actual width, minus a rough estimate of the axis/legend
  // chrome Ripl reserves around the plot area.
  const AXIS_Y_WIDTH = 30;   // "W1".."W5" label column
  const AXIS_X_HEIGHT = 24;  // "1".."7" label row
  const LEGEND_HEIGHT = 56;  // color-scale legend below the plot
  const plotWidth = Math.max(container.clientWidth - AXIS_Y_WIDTH, 100);
  const cellSize = plotWidth / xCategories.length;
  container.style.height = Math.round(cellSize * weeks.length + AXIS_X_HEIGHT + LEGEND_HEIGHT) + 'px';

  container.innerHTML = '';
  _calendarHeatmapChart = window.Ripl.createHeatmapChart(container, {
    theme: 'dark',
    data,
    keyX: 'x', keyY: 'y', value: 'value',
    xCategories, yCategories,
    colors,
    format: (v) => v.toFixed(1) + ' kWh',
  });
  _calendarHeatmapChart.render();
}

// ─── Chart Toggle Handlers ───

function setupChartToggles() {
  const toggles = document.querySelectorAll('#chart-toggles .chart-toggle-btn');
  toggles.forEach(btn => {
    btn.addEventListener('click', async () => {
      const series = btn.dataset.series;
      activeSeries[series] = !activeSeries[series];
      btn.classList.toggle('active');

      // Re-render chart
      try {
        const data = await api(`/api/stats/monthly?year=${currentYear}&month=${currentMonth}`);
        const houseData = await api(`/api/stats/house/monthly?year=${currentYear}&month=${currentMonth}`);
        if (data.ok) {
          renderDailyChart(data.days, houseData?.days || []);
          renderSolarBreakdown(data.days, houseData?.days || []);
        }
      } catch (err) {
        console.error('Chart toggle error:', err);
      }
    });
  });
}

function setupHeatmapToggles() {
  const toggles = document.querySelectorAll('#heatmap-toggles .calendar-toggle-btn');
  toggles.forEach(btn => {
    btn.addEventListener('click', async () => {
      activeHeatmapType = btn.dataset.type;
      toggles.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Re-render heatmap
      try {
        const data = await api(`/api/stats/monthly?year=${currentYear}&month=${currentMonth}`);
        const houseData = await api(`/api/stats/house/monthly?year=${currentYear}&month=${currentMonth}`);
        if (data.ok) {
          renderCalendarHeatmap(data.days, houseData?.days || []);
        }
      } catch (err) {
        console.error('Heatmap toggle error:', err);
      }
    });
  });
}

// ─── Month Navigation ───

function prevMonth() {
  currentMonth--;
  if (currentMonth < 1) { currentMonth = 12; currentYear--; }
  loadMonthlyStats();
  loadBillEstimate();
  currentPage = 1;
  loadSessions(1);
}

function nextMonth() {
  const now = new Date();
  if (currentYear === now.getFullYear() && currentMonth === now.getMonth() + 1) return;
  currentMonth++;
  if (currentMonth > 12) { currentMonth = 1; currentYear++; }
  loadMonthlyStats();
  loadBillEstimate();
  currentPage = 1;
  loadSessions(1);
}

// ─── Sessions Table ───

async function loadSessions(page = 1) {
  const tbody = document.getElementById('sessions-tbody');
  if (!tbody) return;

  try {
    const data = await api(`/api/sessions?page=${page}&limit=20`);
    if (!data.ok) return;

    totalPages = Math.ceil(data.total / data.limit);
    currentPage = page;

    tbody.innerHTML = '';
    if (!data.sessions.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--text-secondary)">No sessions this month</td></tr>';
      renderPagination(document.getElementById('pagination'));
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
      tbody.appendChild(tr);
    }

    renderPagination(document.getElementById('pagination'));
  } catch (err) {
    console.error('Load sessions error:', err);
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
  const end = Math.min(totalPages, start + 4);
  for (let i = start; i <= end; i++) {
    el.appendChild(makeBtn(i, i, false, i === currentPage));
  }

  el.appendChild(makeBtn('›', currentPage + 1, currentPage === totalPages, false));
  el.appendChild(makeBtn('»', totalPages, currentPage === totalPages, false));
}

// ─── Diversion Log ───

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
    const DIVERSION_REASONS = {
      solar_diversion_active: { label: 'Solar diversion active', color: '#4ade80' },
      trip_priority_mode:     { label: 'Trip priority mode',     color: 'var(--accent-solar)' },
      below_threshold:        { label: 'Below threshold',        color: 'var(--text-secondary)' },
      hold_timer:             { label: 'Hold timer',             color: 'var(--accent-solar)' },
      override:               { label: 'Charge Now override',    color: '#63b3ed' },
      scheduled_charging:     { label: 'Scheduled charging',     color: '#63b3ed' },
      no_surplus:             { label: 'No surplus',             color: 'var(--text-secondary)' },
    };
    tbody.innerHTML = entries.map((e) => {
      const r = DIVERSION_REASONS[e.diversion_reason] || { label: e.diversion_reason || '-', color: 'var(--text-secondary)' };
      const d = new Date(e.recorded_at);
      const time = d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `<tr>
        <td style="white-space:nowrap">${time}</td>
        <td><span style="color:${r.color};font-weight:600">${r.label}</span></td>
        <td>${e.controller_state || '-'}</td>
        <td>${kw(e.solar_w)}</td>
        <td>${kw(e.ev_w)}</td>
        <td>${kw(e.eddi_w)}</td>
        <td>${e.trip_within_18hrs ? 'Yes' : '-'}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--text-secondary)">Error: ${err.message}</td></tr>`;
  }
}

// ─── Additional Sections (Phase 10.2) ───

async function loadAdditionalSections() {
  // Solar Forecast (Phase 4)
  try {
    const forecast = await api('/api/solcast/forecast');
    if (forecast.ok && forecast.forecasts && forecast.forecasts.length > 0) {
      document.getElementById('solcast-widget').style.display = 'block';
      renderSolcastChart(forecast.forecasts);
    }
  } catch (e) { /* silently skip */ }

  // Upcoming Trips (Phase 3)
  try {
    const trips = await api('/api/trips');
    if (trips.ok && trips.trips && trips.trips.length > 0) {
      const upcoming = trips.trips.filter(t => t.status === 'located' || t.status === 'scheduled');
      if (upcoming.length > 0) {
        document.getElementById('upcoming-trips').style.display = 'block';
        renderUpcomingTrips(upcoming);
      }
    }
  } catch (e) { /* silently skip */ }

  // Financial Summary (Phase 6)
  try {
    const financial = await api(`/api/financial/dashboard?month=${currentMonth}&year=${currentYear}`);
    if (financial.ok) {
      document.getElementById('financial-summary').style.display = 'block';
      document.getElementById('financial-total-export').textContent = `$${financial.running_totals.total_export_earnings.toFixed(2)}`;
      document.getElementById('financial-total-solar-avoided').textContent = `$${financial.running_totals.total_solar_avoided_cost.toFixed(2)}`;
      document.getElementById('financial-total-net-benefit').textContent = `$${financial.running_totals.total_net_benefit.toFixed(2)}`;
    }
  } catch (e) { /* silently skip */ }

  // Savings vs Spend - monthly trend
  try {
    const trend = await api('/api/financial/monthly-trend?months=12');
    if (trend.ok && trend.trend && trend.trend.length > 0) {
      document.getElementById('monthly-trend-card').style.display = 'block';
      renderMonthlyTrendChart(trend.trend);
    }
  } catch (e) { /* silently skip */ }

  // Solar Provenance (Phase 2)
  // NOTE: the API spreads its fields at the top level (solar_pct, total_solar_kwh,
  // est_savings_aud, first_session_at) - matching dashboard.js. An earlier version
  // read a non-existent nested `.provenance` object with different field names, so the
  // card never displayed. Reading the real fields here is what makes it appear.
  try {
    const p = await api('/api/stats/solar-provenance');
    if (p.ok && p.first_session_at) {
      const since = new Date(p.first_session_at).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });
      document.getElementById('solar-provenance').style.display = 'block';
      document.getElementById('provenance-text').innerHTML =
        `<strong>${p.solar_pct || 0}%</strong> of all your EV charging since <strong>${since}</strong> came directly from your own rooftop solar.`;
      document.getElementById('provenance-kwh').textContent = `${(p.total_solar_kwh || 0).toFixed(1)} kWh`;
      document.getElementById('provenance-savings').textContent = `$${(p.est_savings_aud || 0).toFixed(2)}`;
    }
  } catch (e) { /* silently skip */ }
}

function renderSolcastChart(forecasts) {
  const chart = document.getElementById('solcast-chart');
  if (!chart) return;
  chart.innerHTML = '';

  const maxVal = Math.max(...forecasts.map(f => f.pv_estimate || 0), 1);
  for (const f of forecasts) {
    const h = (f.pv_estimate / maxVal) * 80;
    const bar = document.createElement('div');
    bar.style.cssText = `flex:1;height:${h}px;background:var(--accent-solar);border-radius:2px 2px 0 0;opacity:0.8`;
    chart.appendChild(bar);
  }

  // Calculate remaining + tomorrow
  const today = forecasts[0]?.period_end || new Date();
  const todayEnd = new Date(today);
  todayEnd.setHours(23, 59, 59);

  const todayRemaining = forecasts
    .filter(f => new Date(f.period_end) < todayEnd)
    .reduce((s, f) => s + (f.pv_estimate || 0), 0);

  const tomorrowTotal = forecasts
    .filter(f => new Date(f.period_end) >= todayEnd)
    .reduce((s, f) => s + (f.pv_estimate || 0), 0);

  document.getElementById('solcast-today-remaining').textContent = todayRemaining.toFixed(1) + ' kWh';
  document.getElementById('solcast-tomorrow-total').textContent = tomorrowTotal.toFixed(1) + ' kWh';
}

let _monthlyTrendChart = null;
function renderMonthlyTrendChart(trend) {
  const container = document.getElementById('monthly-trend-chart');
  if (!container || !window.Ripl) return;

  // Legend is the static swatch row already in the card's HTML above this container.
  const data = trend.map(m => {
    const [monthAbbrev, year] = m.label.split(' ');
    return { label: `${monthAbbrev} '${(year || '').slice(2)}`, saved: m.saved, spent: m.spent };
  });

  container.innerHTML = '';
  _monthlyTrendChart = window.Ripl.createBarChart(container, {
    theme: 'dark',
    data,
    key: 'label',
    series: [
      { id: 'saved', label: 'Saved', value: 'saved', color: '#4ade80' },
      { id: 'spent', label: 'Spent', value: 'spent', color: cssVar('var(--accent-import)') },
    ],
    tooltip: { trigger: 'axis' },
    // Blank out near-zero values rather than "$0.00" - format doubles as both the
    // bar's value label and its tooltip text, and most months in a young install
    // are $0, so labelling every one of them clutters the baseline.
    format: (v) => v <= 0.005 ? '' : '$' + v.toFixed(2),
    // Ripl doesn't do label collision avoidance, and a young install's non-zero
    // months cluster together in a 12-month-wide chart - a smaller font reduces
    // (but doesn't eliminate) overlap between adjacent months' labels. This
    // resolves naturally as more months of data spread the bars out.
    // fontColor must be set explicitly - Ripl's per-chart `theme: 'dark'` option
    // doesn't reach the data-label color default, which otherwise falls back to
    // the library's global default theme (still light, i.e. near-black text)
    // regardless of what an individual chart's own theme is set to.
    labels: { visible: true, font: '9px sans-serif', fontColor: '#e5e7eb' },
    legend: false,
  });
  _monthlyTrendChart.render();
}

function renderUpcomingTrips(trips) {
  const content = document.getElementById('trips-content');
  if (!content) return;

  content.innerHTML = trips.slice(0, 3).map(t => {
    const status = t.status === 'located' && t.distance_km !== undefined
      ? `${t.distance_km.toFixed(0)} km away`
      : t.status === 'scheduled'
      ? `Scheduled for ${formatDate(t.departure_time)}`
      : 'Unknown status';

    const coverage = t.range_km !== undefined && t.distance_km !== undefined
      ? (t.range_km / t.distance_km * 100).toFixed(0)
      : '-';

    const coverageColor = coverage === '-' ? 'var(--text-secondary)' :
                          coverage >= 100 ? 'var(--accent-charge)' :
                          coverage >= 80 ? 'var(--accent-solar)' : 'var(--accent-import)';

    return `
      <div style="background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-md);padding:0.75rem;margin-bottom:0.5rem">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem">
          <div>
            <div style="font-weight:600;margin-bottom:0.25rem">${t.destination || 'Unknown'}</div>
            <div style="font-size:0.8rem;color:var(--text-secondary)">${status}</div>
          </div>
          <div style="text-align:right">
            <div style="font-weight:600;color:${coverageColor}">${coverage}%</div>
            <div style="font-size:0.7rem;color:var(--text-secondary)">Range coverage</div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ─── Init ───

document.addEventListener('DOMContentLoaded', async () => {
  // Month navigation
  document.getElementById('prev-month')?.addEventListener('click', prevMonth);
  document.getElementById('next-month')?.addEventListener('click', nextMonth);

  // Setup toggles
  setupChartToggles();
  setupHeatmapToggles();
  setupPeriodToggles();

  // Eddi grid boost backfill button
  const backfillBtn = document.getElementById('eddi-backfill-btn');
  if (backfillBtn) {
    backfillBtn.addEventListener('click', async () => {
      backfillBtn.disabled = true;
      backfillBtn.textContent = 'Syncing…';
      try {
        const res = await api('/api/eddi/backfill-boost?days=90', { method: 'POST' });
        if (res.ok) {
          backfillBtn.textContent = `✓ ${res.updated} day${res.updated !== 1 ? 's' : ''} updated`;
          if (res.updated > 0) {
            loadHWPeriodStats();
            loadMasterPeriodStats();
            loadMonthlyStats();
          }
        } else {
          backfillBtn.textContent = 'Error - try again';
          backfillBtn.disabled = false;
        }
      } catch (_) {
        backfillBtn.textContent = 'Error - try again';
        backfillBtn.disabled = false;
      }
    });
  }

  // ─── Daily Energy Shape ───────────────────────────────────────────────────
  let _touDays = 30;

  let _touGenChart = null;
  let _touUseChart = null;

  function _touHourLabel(h) {
    return h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p';
  }

  function renderHourlyProfile(hours) {
    const genEl = document.getElementById('tou-gen-chart');
    const useEl = document.getElementById('tou-use-chart');
    if (!genEl || !useEl || !window.Ripl) return;

    // Shared scale (explicit axis min/max on both charts) so they stay directly comparable,
    // same intent as the old charts' shared hand-computed Y axis.
    const maxGen    = Math.max(...hours.map(h => h.solar_w), 1);
    const maxUse    = Math.max(...hours.map(h => h.total_w), 1);
    const sharedMax = Math.max(maxGen, maxUse, 1);

    const data = hours.map(h => ({ ...h, label: _touHourLabel(h.hour) }));
    const format = (v) => Math.round(v) + 'W';

    genEl.innerHTML = '';
    _touGenChart = window.Ripl.createBarChart(genEl, {
      theme: 'dark',
      data,
      key: 'label',
      series: [
        { id: 'solar', label: 'Solar', value: 'solar_w', color: cssVar(SERIES_COLORS.solar) },
      ],
      axis: { y: { min: 0, max: sharedMax }, x: { ticks: 8 } },
      tooltip: { trigger: 'axis' },
      format,
      legend: false,
    });
    _touGenChart.render();

    useEl.innerHTML = '';
    _touUseChart = window.Ripl.createBarChart(useEl, {
      theme: 'dark',
      data,
      key: 'label',
      series: [
        { id: 'house', label: 'House',     value: 'house_w', color: '#63b3ed' },
        { id: 'ev',    label: 'EV',        value: 'ev_w',    color: cssVar(SERIES_COLORS.ev) },
        { id: 'eddi',  label: 'Hot Water', value: 'eddi_w',  color: '#fb923c' },
      ],
      stacked: true,
      axis: { y: { min: 0, max: sharedMax }, x: { ticks: 8 } },
      tooltip: { trigger: 'axis' },
      format,
      legend: false,
    });
    _touUseChart.render();
  }

  async function loadHourlyProfile() {
    try {
      const res  = await fetch('/api/stats/hourly-profile?days=' + _touDays);
      const data = await res.json();
      if (data.ok) renderHourlyProfile(data.hours);
    } catch (_) {}
  }

  // Period toggle
  const touToggle = document.getElementById('tou-period-toggle');
  if (touToggle) {
    touToggle.addEventListener('click', e => {
      const btn = e.target.closest('.tou-period-btn');
      if (!btn) return;
      touToggle.querySelectorAll('.tou-period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _touDays = parseInt(btn.dataset.days, 10);
      loadHourlyProfile();
    });
  }

  // ─── Time-of-Day Pattern heatmap (Ripl, see public/vendor/ripl/) ──────────
  let _riplHeatmapDays   = 30;
  let _riplHeatmapMetric = 'solar_excess';
  let _riplHeatmapChart  = null;

  const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DOW_TO_LABEL = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 0: 'Sun' };
  const HOUR_LABELS = Array.from({ length: 24 }, (_, h) =>
    h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p');

  function renderRiplHeatmap(cells) {
    const el = document.getElementById('riplheatmap-chart');
    if (!el || !window.Ripl) return;

    const data = cells.map(c => ({
      day:   DOW_TO_LABEL[c.dow],
      hour:  HOUR_LABELS[c.hour],
      value: c.avg_w,
    }));

    const colors = _riplHeatmapMetric === 'ev'
      ? ['#12241a', '#4ade80']   // dark -> var(--accent-charge)
      : ['#2a1f10', '#f5a623'];  // dark -> var(--accent-solar)

    const options = {
      theme: 'dark',
      data,
      keyX: 'hour',
      keyY: 'day',
      value: 'value',
      xCategories: HOUR_LABELS,
      yCategories: DAY_LABELS,
      colors,
      format: (v) => Math.round(v) + 'W',
    };

    // The heatmap redraws its own canvas each call, but a fresh HeatmapChart
    // instance per metric/period switch is simpler and cheap enough here
    // than reconciling one instance's category axes across re-renders.
    el.innerHTML = '';
    _riplHeatmapChart = window.Ripl.createHeatmapChart(el, options);
    _riplHeatmapChart.render();
  }

  async function loadRiplHeatmap() {
    try {
      const res  = await fetch(`/api/stats/heatmap?days=${_riplHeatmapDays}&metric=${_riplHeatmapMetric}`);
      const data = await res.json();
      if (data.ok) renderRiplHeatmap(data.cells);
    } catch (_) {}
  }

  const riplMetricToggle = document.getElementById('riplheatmap-metric-toggle');
  if (riplMetricToggle) {
    riplMetricToggle.addEventListener('click', e => {
      const btn = e.target.closest('.calendar-toggle-btn');
      if (!btn) return;
      riplMetricToggle.querySelectorAll('.calendar-toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _riplHeatmapMetric = btn.dataset.metric;
      loadRiplHeatmap();
    });
  }

  const riplPeriodToggle = document.getElementById('riplheatmap-period-toggle');
  if (riplPeriodToggle) {
    riplPeriodToggle.addEventListener('click', e => {
      const btn = e.target.closest('.tou-period-btn');
      if (!btn) return;
      riplPeriodToggle.querySelectorAll('.tou-period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _riplHeatmapDays = parseInt(btn.dataset.days, 10);
      loadRiplHeatmap();
    });
  }

  // Load data - period defaults to 'month' on page load
  await loadFuelSettings();
  await loadPeriodData('today');
  loadMasterPeriodStats();
  loadEVPeriodStats();
  loadHWPeriodStats();
  loadHousePeriodStats();
  loadMonthlyStats();
  loadBillEstimate();
  loadSessions(1);
  loadDiversionLog();
  loadAdditionalSections();
  loadHourlyProfile();
  loadRiplHeatmap();
});
