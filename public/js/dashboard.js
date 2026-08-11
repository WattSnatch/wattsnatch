/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

// ─── Dashboard ───

let lastTs = null;
let tickInterval = null;
let pollingCountdown = null;
let pollInterval = 15;

// Hold timer client-side countdown
let holdSecondsRemaining = 0;  // last value from SSE
let holdReceivedAt = 0;        // performance.now() when SSE arrived
let holdTotalSeconds = 180;    // full hold period in seconds (from SSE holdTotal)
let holdCountdownInterval = null;

const HOLD_RING_CIRC = 150.8; // matches stroke-dasharray on #hold-ring (r=24, 2π×24≈150.8)

function startHoldCountdown(seconds, total) {
  holdSecondsRemaining = seconds;
  holdReceivedAt = performance.now();
  if (total != null) holdTotalSeconds = total;
  if (holdCountdownInterval) return; // already ticking - variables updated above, interval keeps running
  holdCountdownInterval = setInterval(() => {
    const elapsed = Math.floor((performance.now() - holdReceivedAt) / 1000);
    const remaining = Math.max(0, holdSecondsRemaining - elapsed);
    if (elHoldTimer) elHoldTimer.textContent = formatDuration(remaining);
    const ring = document.getElementById('hold-ring');
    if (ring) {
      const frac = holdTotalSeconds > 0 ? Math.max(0, Math.min(1, remaining / holdTotalSeconds)) : 0;
      ring.style.strokeDashoffset = HOLD_RING_CIRC * (1 - frac);
    }
    if (remaining === 0) stopHoldCountdown();
  }, 1000);
}

function stopHoldCountdown() {
  if (holdCountdownInterval) { clearInterval(holdCountdownInterval); holdCountdownInterval = null; }
  holdSecondsRemaining = 0;
}

// DOM refs
const elSolar          = document.getElementById('solar-watts');
const elHome           = document.getElementById('home-watts');
const elGridExport     = document.getElementById('grid-export-watts');
const elGridImport     = document.getElementById('grid-import-watts');
const elEvWatts        = document.getElementById('ev-watts');
const elEvAmps         = document.getElementById('ev-amps');
const elBatteryPct     = document.getElementById('battery-pct');
const elBatteryBar     = document.getElementById('battery-bar');
const elBatteryLimit   = document.getElementById('battery-limit');
const elEvName         = document.getElementById('ev-name');
const elChargingState  = document.getElementById('charging-state');
const elControllerBadge= document.getElementById('controller-badge');
const elExcess         = document.getElementById('excess-watts');
const elSmoothed       = document.getElementById('smoothed-watts');
const elTargetAmps     = document.getElementById('target-amps');
const elPollCountdown  = document.getElementById('poll-countdown');
const elUpdatedAgo     = document.getElementById('updated-ago');
const elGatewayPill    = document.getElementById('gateway-pill');
const elTeslaPill      = document.getElementById('tesla-pill');
const elTodayKwh       = document.getElementById('today-kwh');
const elTodaySessions  = document.getElementById('today-sessions');
const elTodayDuration  = document.getElementById('today-duration');
const elTodaySavings   = document.getElementById('today-savings');
const elHwNodeVal      = document.getElementById('hw-node-val');
const elAcNodeVal      = document.getElementById('ac-node-val');

// Banners
const elHoldingBanner   = document.getElementById('holding-banner');
const elHoldTimer       = document.getElementById('hold-timer');
const elWaitingBanner   = document.getElementById('waiting-banner');
const elOverrideBanner  = document.getElementById('override-banner');
const elStoppedBanner   = document.getElementById('stopped-banner');
const elAwayBanner      = document.getElementById('away-banner');
const elControlOffBanner= document.getElementById('control-off-banner');
const elScheduledBanner  = document.getElementById('scheduled-banner');
const elTouPeakBanner    = document.getElementById('tou-peak-banner');
const elDepartureBanner  = document.getElementById('departure-banner');
const elDepartureBannerDesc = document.getElementById('departure-banner-desc');
const elFreePowerBanner  = document.getElementById('free-power-banner');
const elFreePowerBannerDesc = document.getElementById('free-power-banner-desc');
const elCertBanner       = document.getElementById('cert-banner');
const elCertBannerDesc   = document.getElementById('cert-banner-desc');

// Certificate health is independent of charging state, so this banner sits
// outside the mutually-exclusive set above - a cert about to expire matters
// whether or not the car is home, charging, or overridden.
function updateCertBanner(certs) {
  if (!elCertBanner) return;
  if (!certs || certs.ok !== false) {
    elCertBanner.classList.remove('cert-critical');
    hide(elCertBanner);
    return;
  }

  const days = certs.daysUntilSoonestExpiry;
  let text = certs.firstProblem || 'A TLS certificate needs attention.';
  if (certs.problemCount > 1) {
    text += ` (+${certs.problemCount - 1} more)`;
  } else if (typeof days === 'number' && !text.includes(`${days} day`)) {
    // Only add the expiry when the problem text does not already state it -
    // otherwise a message like "Expires in 19 days" gains a redundant
    // "Soonest expiry: 19 days" immediately after it.
    text += ` Soonest expiry: ${days} days.`;
  }

  if (elCertBannerDesc) elCertBannerDesc.textContent = text;
  elCertBanner.classList.toggle('cert-critical', certs.severity === 'critical');
  show(elCertBanner);
}

// Controls
const elControlToggle   = document.getElementById('control-toggle');
const elControlDesc     = document.getElementById('control-toggle-desc');
const elBtnStop         = document.getElementById('btn-stop');
const elBtnAuto         = document.getElementById('btn-auto');
const elBtnChargeNow    = document.getElementById('btn-charge-now');
const elChargeLimitSlider   = document.getElementById('charge-limit-slider');
const elChargeLimitSliderVal= document.getElementById('charge-limit-slider-val');
const elChargeLimitStatus   = document.getElementById('charge-limit-status');

let chargeLimitDebounce = null;
let sliderDragging = false;
let currentControllerState = 'IDLE';
let currentControlEnabled = true;

// ─── SSE ─────────────────────────────────────────────────────────────────────

function connectSSE() {
  const source = new EventSource('/api/events');
  source.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'telemetry') handleTelemetry(data);
    } catch (_e) {}
  };
  source.onerror = () => { setTimeout(connectSSE, 5000); source.close(); };
}

// ─── Main telemetry handler ───────────────────────────────────────────────────

// Swaps the Grid node's icon for the configured retailer's favicon (Settings ->
// Region -> Grid icon), same domain-favicon trick already used for the EV node's
// Tesla logo. Only touches the DOM when the domain actually changes, since this
// runs on every telemetry tick. Falls back to a generic plug icon when unset,
// rather than defaulting to any specific retailer.
let _lastGridRetailerDomain;
function applyGridRetailerIcon(domain) {
  domain = domain || '';
  if (domain === _lastGridRetailerDomain) return;
  _lastGridRetailerDomain = domain;
  const container = document.getElementById('grid-node');
  if (!container) return;
  container.innerHTML = domain
    ? `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64" alt="" style="width:32px;height:32px;object-fit:cover;border-radius:50%">`
    : `<svg id="grid-node-default-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v3a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>`;
}

function handleTelemetry(d) {
  lastTs = d.ts;
  currentControllerState = d.controllerState || 'IDLE';
  currentControlEnabled = d.controlEnabled !== false;
  applyGridRetailerIcon(d.gridRetailerDomain);

  // Energy values - subtract EV and Eddi from total consumption so Home shows pure house load
  const houseW = Math.max(0, (d.consumption || 0) - (d.evWatts || 0) - (d.eddiDivertW || 0));
  if (elSolar) updateEl(elSolar, formatWatts(d.solar));
  if (elHome)  updateEl(elHome,  formatWatts(houseW));

  const gridW = d.grid || 0;
  const exporting = gridW < -50, importing = gridW > 50;
  if (elGridExport) {
    elGridExport.textContent = exporting ? formatWatts(-gridW) : '0 W';
    elGridExport.style.opacity = exporting ? '1' : '0.3';
  }
  if (elGridImport) {
    elGridImport.textContent = importing ? formatWatts(gridW) : '0 W';
    elGridImport.style.opacity = importing ? '1' : '0.3';
  }
  const gridNode = document.getElementById('grid-node');
  if (gridNode) gridNode.className = 'flow-node-icon grid' + (importing ? ' importing' : '');

  if (elEvWatts) updateEl(elEvWatts, formatWatts(d.evWatts));
  if (elEvAmps)  updateEl(elEvAmps,  formatAmps(d.evAmps));

  // Battery
  if (elBatteryPct) elBatteryPct.textContent = formatPercent(d.batteryPct);
  if (elBatteryBar) elBatteryBar.style.width = Math.min(100, d.batteryPct || 0) + '%';
  if (elBatteryLimit && d.chargeLimit) {
    elBatteryLimit.style.left = Math.min(100, d.chargeLimit) + '%';
    const lbl = document.getElementById('charge-limit-label');
    if (lbl) lbl.textContent = d.chargeLimit + '% limit';
    if (elChargeLimitSlider && !sliderDragging) {
      elChargeLimitSlider.value = d.chargeLimit;
      if (elChargeLimitSliderVal) elChargeLimitSliderVal.textContent = d.chargeLimit + '%';
    }
  }

  if (elEvName && d.vehicleName) elEvName.textContent = d.vehicleName;
  const elEvFlowLabel = document.getElementById('ev-flow-label');
  if (elEvFlowLabel && d.vehicleModel) elEvFlowLabel.textContent = d.vehicleModel;

  // Charging state label
  if (elChargingState) {
    const cs = d.chargingState || 'Unknown';
    elChargingState.textContent = cs;
    elChargingState.className = 'ev-state-label';
    if (cs === 'Charging') elChargingState.classList.add('text-charge');
    else if (['Asleep','Offline'].includes(cs)) elChargingState.classList.add('text-secondary');
    else if (['Stopped','NoPower'].includes(cs)) elChargingState.classList.add('text-idle');
  }

  // Controller badge
  if (elControllerBadge) elControllerBadge.innerHTML = stateBadge(d.controllerState);

  // Status strip
  updateStatusStrip(d);

  // Show "Replay Today" button after 6 PM
  const elReplayBtn = document.getElementById('btn-replay-today');
  if (elReplayBtn) {
    const hour = new Date().getHours();
    elReplayBtn.style.display = hour >= 18 ? 'inline-flex' : 'none';
  }

  // Excess
  if (elExcess)    updateEl(elExcess,    formatWatts(d.solarExcess));
  if (elSmoothed)  updateEl(elSmoothed,  formatWatts(d.smoothedExcess));
  if (elTargetAmps)updateEl(elTargetAmps,formatAmps(d.targetAmps));

  // Banners (mutually exclusive - show most relevant one)
  const state = d.controllerState;
  const ctrl  = d.controlEnabled !== false;

  hide(elHoldingBanner); stopHoldCountdown();
  hide(elWaitingBanner);   hide(elOverrideBanner);
  hide(elStoppedBanner); hide(elAwayBanner);      hide(elControlOffBanner);
  hide(elScheduledBanner); hide(elTouPeakBanner);
  if (elDepartureBanner) hide(elDepartureBanner);
  if (elFreePowerBanner) hide(elFreePowerBanner);

  if (!d.isAtHome) {
    show(elAwayBanner);
  } else if (!ctrl) {
    show(elControlOffBanner);
  } else if (state === 'OVERRIDE') {
    show(elOverrideBanner);
  } else if (state === 'DEPARTURE') {
    if (elDepartureBanner) show(elDepartureBanner);
  } else if (state === 'SCHEDULED') {
    // Free power reuses the SCHEDULED state, so the flag is what distinguishes
    // them. Deliberately does not raise the TOU-peak warning alongside it: that
    // banner exists to flag expensive import, and during a free window the
    // import is free, so showing it would be alarming and wrong.
    if (d.inFreePower && elFreePowerBanner) {
      show(elFreePowerBanner);
      if (elFreePowerBannerDesc) {
        const w = d.freePowerWindow;
        const until = w && w.endMs
          ? new Date(w.endMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
          : null;
        elFreePowerBannerDesc.textContent =
          `Charging at maximum amps - grid power is free`
          + (until ? ` until ${until}` : ' right now')
          + (w && w.summary ? ` (${w.summary})` : '');
      }
    } else {
      show(elScheduledBanner);
      if (d.inTouPeak) show(elTouPeakBanner);
    }
  } else if (state === 'STOPPED') {
    show(elStoppedBanner);
  } else if (state === 'HOLDING') {
    show(elHoldingBanner);
    if (d.holdRemaining != null) startHoldCountdown(d.holdRemaining, d.holdTotal);
  } else if (state === 'WAITING') {
    show(elWaitingBanner);
    if (d.inTouPeak) show(elTouPeakBanner);
  } else if (d.inTouPeak) {
    show(elTouPeakBanner);
  }

  // Charging Control toggle
  if (elControlToggle) elControlToggle.checked = ctrl;
  if (elControlDesc) {
    elControlDesc.textContent = ctrl ? 'Solar tracking active' : 'Control disabled - car manages itself';
  }

  // STOP / AUTO / CHARGE NOW active states
  setActionActive('stop',       state === 'STOPPED');
  setActionActive('auto',       ctrl && !['STOPPED','OVERRIDE','SCHEDULED','DEPARTURE'].includes(state));
  setActionActive('charge-now', state === 'OVERRIDE' || state === 'SCHEDULED' || state === 'DEPARTURE');

  // Home / away badge in ev-actions (keep for reference if still in HTML)
  const elHomeBadge = document.getElementById('home-badge');
  if (elHomeBadge) {
    elHomeBadge.classList.remove('hidden');
    if (!d.locationKnown) {
      elHomeBadge.innerHTML = '<span class="status-dot status-dot-grey"></span>Location unknown';
      elHomeBadge.className = 'pill pill-idle';
    } else if (d.isAtHome !== false) {
      elHomeBadge.innerHTML = '<span class="status-dot status-dot-green"></span>At home';
      elHomeBadge.className = 'pill pill-ok';
    } else {
      elHomeBadge.innerHTML = '<span class="status-dot status-dot-red"></span>Away';
      elHomeBadge.className = 'pill pill-error';
    }
  }

  // Hot water (Eddi)
  if (elHwNodeVal) updateEl(elHwNodeVal, formatWatts(d.eddiDivertW));
  const hwNode = document.getElementById('hw-node');
  if (hwNode) hwNode.classList.toggle('active', (d.eddiDivertW || 0) > 50);
  // Update Eddi control card with status + temps from SSE telemetry
  if (typeof window._updateEddiCard === 'function' && d.eddiStatus) {
    window._updateEddiCard(d.eddiStatus, d.eddiTemp1 ?? null, d.eddiTemp2 ?? null);
  }

  // AC (MELCloud) - branch hidden entirely when MELCloud isn't configured, rather
  // than just showing a permanently-idle icon for a feature the user doesn't have
  const acBranch = document.getElementById('branch-ac');
  if (acBranch) {
    const wasHidden = acBranch.style.display === 'none';
    acBranch.style.display = d.melcloudConfigured ? '' : 'none';
    if (wasHidden !== (acBranch.style.display === 'none')) drawFlowCurves();
  }
  if (elAcNodeVal) updateEl(elAcNodeVal, formatWatts(d.acLoadW || 0));
  const acNode = document.getElementById('ac-node');
  if (acNode) {
    acNode.classList.remove('active', 'cooling', 'heating');
    const acActive = (d.acRunningCount || 0) > 0;
    let acMode = null;
    if (acActive) {
      if (d.acModes && d.acModes.includes('Cool'))       { acNode.classList.add('cooling'); acMode = 'cooling'; }
      else if (d.acModes && d.acModes.includes('Heat'))  { acNode.classList.add('heating'); acMode = 'heating'; }
      else                                               { acNode.classList.add('active'); }
    }
    setFlowCurveActive('ac', acActive, acMode);
  }

  // Home Battery - branch hidden entirely when no battery provider is configured
  const batteryBranch = document.getElementById('branch-battery');
  if (batteryBranch) {
    const wasHidden = batteryBranch.style.display === 'none';
    batteryBranch.style.display = d.batteryConfigured ? '' : 'none';
    if (wasHidden !== (batteryBranch.style.display === 'none')) drawFlowCurves();
  }
  const batteryPowerW = d.batteryPowerW || 0;
  updateEl(document.getElementById('battery-flow-node-val'), formatWatts(Math.abs(batteryPowerW)));
  const batteryNode = document.getElementById('battery-flow-node');
  if (batteryNode) {
    batteryNode.classList.remove('charging', 'discharging');
    let batteryMode = null;
    if (batteryPowerW > 50)       { batteryNode.classList.add('charging');    batteryMode = 'charging'; }
    else if (batteryPowerW < -50) { batteryNode.classList.add('discharging'); batteryMode = 'discharging'; }
    setFlowCurveActive('battery', !!batteryMode, batteryMode);
  }

  updatePill(elGatewayPill, d.gatewayOk, 'Gateway');
  updateTeslaPill(d);
  updateFlowDiagram(d);


  pollInterval = d.pollIntervalSecs || 15;
  if (pollingCountdown !== null) clearInterval(pollingCountdown);
  startPollCountdown();
}

function setActionActive(name, active) {
  const el = document.getElementById('btn-' + name);
  if (!el) return;
  if (active) el.classList.add('ev-action-btn-active');
  else        el.classList.remove('ev-action-btn-active');
}

function show(el) { if (el) el.classList.remove('hidden'); }
function hide(el) { if (el) el.classList.add('hidden');    }

function updateStatusStrip(d) {
  const strip = document.getElementById('status-strip');
  if (!strip) return;
  const name = d.vehicleName || 'car';
  const kw = (w) => (w / 1000).toFixed(1) + ' kW';
  let msg = '-', cls = 'idle';
  const ctrl = d.controlEnabled !== false;

  if (!d.isAtHome) {
    msg = `${name} is away from home - solar control suspended`;
  } else if (!ctrl) {
    msg = `Charging control is disabled - ${name} manages its own charging`;
  } else if (d.controllerState === 'STOPPED') {
    msg = `Charging stopped by user - press Auto to resume solar tracking`;
  } else if (d.controllerState === 'OVERRIDE') {
    msg = `Charging ${name} at maximum rate from grid`; cls = 'override';
  } else if (d.controllerState === 'DEPARTURE') {
    msg = `Charging ${name} for upcoming departure`; cls = 'charging';
  } else if (d.controllerState === 'SCHEDULED') {
    msg = `Scheduled window active - charging ${name} at maximum rate`; cls = 'charging';
  } else if (d.chargingState === 'Disconnected') {
    msg = `${name} is not plugged in`;
  } else if (d.controllerState === 'WAITING') {
    msg = `${name} is plugged in - waiting for solar before charging`;
  } else if (['Asleep','Offline'].includes(d.chargingState)) {
    msg = `${name} is sleeping - will wake when there's enough solar`;
  } else if (d.controllerState === 'CHARGING') {
    msg = `Diverting ${kw(d.evWatts)} of solar to ${name}`; cls = 'charging';
  } else if (d.controllerState === 'HOLDING') {
    const s = d.holdRemaining != null ? ` (${d.holdRemaining}s)` : '';
    msg = `Solar dropped - holding before stopping${s}`; cls = 'warning';
  } else if (d.controllerState === 'MONITORING') {
    if (!d.chargingState || ['Asleep','Offline'].includes(d.chargingState)) {
      msg = `${kw(d.smoothedExcess)} excess solar - waking ${name} to start charging`;
    } else {
      msg = `${kw(d.smoothedExcess)} excess solar - starting charge…`;
    }
    cls = 'warning';
  } else if (d.solarExcess > 0 && d.targetAmps === 0) {
    msg = d.tripPriority
      ? `Standby - surplus below threshold (trip priority mode)`
      : `Solar available (${kw(d.solarExcess)}) but below minimum charging threshold`;
  } else if (d.solar <= 50) {
    msg = `Idle - no surplus available`;
  } else {
    msg = `Monitoring - ${kw(d.solar)} solar, ${kw(Math.max(0, (d.consumption || 0) - (d.evWatts || 0) - (d.eddiDivertW || 0)))} home load`;
  }

  strip.textContent = msg;
  strip.className = `status-strip ${cls}`;

  // Phase 5 - trip-awareness context line. Appended beneath the main status
  // message whenever a trip is departing within the next 18 hours.
  if (d.tripWithin18hrs) {
    const line = document.createElement('div');
    line.className = `status-strip-trip${d.tripPriority ? ' priority' : ''}`;
    const dep = d.tripDepartureTime ? new Date(d.tripDepartureTime) : null;
    const when = dep
      ? dep.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
      : 'soon';
    const where = d.tripLocation ? ` to ${d.tripLocation}` : '';
    line.textContent = d.tripPriority
      ? `⚡ Trip${where} ${when} still needs charge - lowering threshold while solar is available`
      : `🚗 Trip${where} ${when} - on track for charge`;
    strip.appendChild(line);
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function sendAction(action) {
  try { await api('/api/charge/action', { method: 'POST', body: { action } }); } catch (_e) {}
}

async function setControlEnabled(enabled) {
  try { await api('/api/charge/control', { method: 'POST', body: { enabled } }); } catch (_e) {}
}

async function submitChargeLimit(limit) {
  if (!elChargeLimitStatus) return;
  elChargeLimitStatus.textContent = 'Setting…';
  elChargeLimitStatus.className = 'charge-limit-status';
  try {
    const data = await api('/api/charge/limit', { method: 'POST', body: { limit } });
    elChargeLimitStatus.textContent = data.ok ? '✓ Set' : 'Error';
    elChargeLimitStatus.className = 'charge-limit-status ' + (data.ok ? 'ok' : 'err');
  } catch (_e) {
    elChargeLimitStatus.textContent = 'Error';
    elChargeLimitStatus.className = 'charge-limit-status err';
  }
  setTimeout(() => {
    if (elChargeLimitStatus) { elChargeLimitStatus.textContent = ''; elChargeLimitStatus.className = 'charge-limit-status'; }
  }, 3000);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function updatePill(el, ok, label) {
  if (!el) return;
  el.innerHTML = `<span class="status-dot ${ok ? 'status-dot-green' : 'status-dot-red'}"></span>${label}: ${ok ? 'OK' : 'Error'}`;
  el.className = `pill ${ok ? 'pill-ok' : 'pill-error'}`;
}

function updateTeslaPill(d) {
  const el = elTeslaPill;
  if (!el) return;
  if (d.teslaOk) {
    el.innerHTML = `<span class="status-dot status-dot-green"></span>Tesla: OK`;
    el.className = 'pill pill-ok';
  } else {
    const cs = d.chargingState;
    const asleep = !cs || cs === 'Asleep' || cs === 'Offline';
    const label  = asleep ? 'Asleep' : 'Offline';
    el.innerHTML = `<span class="status-dot status-dot-grey"></span>Tesla: ${label}`;
    el.className = 'pill pill-idle';
  }
}

function updateFlowDiagram(d) {
  updatePipe('.pipe-solar-home', d.solar > 50, false);
  const exporting = d.grid < -50, importing = d.grid > 50;
  const pipeEl = document.querySelector('.pipe-home-grid');
  if (pipeEl) {
    if (exporting)       pipeEl.className = 'flow-pipe pipe-home-grid home-grid active';
    else if (importing)  pipeEl.className = 'flow-pipe pipe-home-grid home-grid importing reverse active';
    else                 pipeEl.className = 'flow-pipe pipe-home-grid home-grid';
  }
  // EV curve
  setFlowCurveActive('ev', d.evWatts > 100);
  const evNode = document.getElementById('ev-node');
  if (evNode) evNode.classList.toggle('active', d.chargingState === 'Charging');

  // Hot water curve
  setFlowCurveActive('hw', (d.eddiDivertW || 0) > 50);
  const hwNodeFlow = document.getElementById('hw-node');
  if (hwNodeFlow) hwNodeFlow.classList.toggle('active', (d.eddiDivertW || 0) > 50);

  // Battery charging power is folded into consumptionW by the meter (same
  // reasoning as EV/HW/AC - see src/services/battery/README.md), so it's
  // subtracted here too to avoid double-counting it as house load. Discharging
  // (negative) is NOT added back in - it's power the battery is supplying, not
  // something the house consumed.
  const houseNodeW = Math.max(0, (d.consumption || 0) - (d.evWatts || 0) - (d.eddiDivertW || 0) - (d.acLoadW || 0) - Math.max(0, d.batteryPowerW || 0));
  setNodeVal('solar-node-val',  formatWatts(d.solar));
  setNodeVal('home-node-val',   formatWatts(houseNodeW));
  setNodeVal('grid-node-val',   formatWatts(Math.abs(d.grid)));
  setNodeVal('ev-node-val',     formatWatts(d.evWatts));
  setNodeVal('ac-node-val',     (d.acLoadW || 0) > 0 ? '~' + formatWatts(d.acLoadW) : formatWatts(0));
}

// ─── Flow Curves - SVG bezier lines from Home to each bottom branch ───────────

// Stores { active, mode } per curve key, so drawFlowCurves can re-apply the
// right color/direction on resize without waiting for the next telemetry tick.
let _flowCurveActive = {};

function _dotColorFor(key, mode) {
  if (mode === 'cooling')      return 'rgba(59,130,246,0.9)';
  if (mode === 'heating')      return 'rgba(249,115,22,0.9)';
  if (mode === 'charging')     return 'rgba(59,130,246,0.9)';
  if (mode === 'discharging')  return 'rgba(167,139,250,0.9)';
  return null; // fall back to the branch's own default color
}

function _strokeFor(active, mode) {
  if (!active)                 return 'rgba(148,163,184,0.15)';
  if (mode === 'cooling')      return 'rgba(59,130,246,0.35)';
  if (mode === 'heating')      return 'rgba(249,115,22,0.35)';
  if (mode === 'charging')     return 'rgba(59,130,246,0.35)';
  if (mode === 'discharging')  return 'rgba(167,139,250,0.35)';
  return 'rgba(148,163,184,0.35)';
}

function drawFlowCurves() {
  const svg      = document.getElementById('flow-curves-svg');
  const section  = document.querySelector('.flow-section');
  const homeIcon = document.querySelector('.flow-node-icon.home');
  if (!svg || !section || !homeIcon) return;

  const sRect = section.getBoundingClientRect();
  const hRect = homeIcon.getBoundingClientRect();

  // Convergence point: bottom of the entire home flow-node (below the kWh text), centred on the icon
  const homeNode = homeIcon.closest('.flow-node') || homeIcon;
  const hy = homeNode.getBoundingClientRect().bottom - sRect.top;
  const hx = hRect.left + hRect.width / 2 - sRect.left;

  const branches = [
    { id: 'branch-ev',      key: 'ev',      color: 'rgba(74,222,128,0.9)'  },
    { id: 'branch-hw',      key: 'hw',      color: 'rgba(251,146,60,0.9)'  },
    { id: 'branch-battery', key: 'battery', color: 'rgba(167,139,250,0.9)' },
    { id: 'branch-ac',      key: 'ac',      color: 'rgba(156,163,175,0.9)' },
  ];

  svg.innerHTML = '';

  branches.forEach(b => {
    const branchEl = document.getElementById(b.id);
    if (!branchEl || branchEl.style.display === 'none') return;

    const iconEl = branchEl.querySelector('.flow-node-icon');
    if (!iconEl) return;

    const iRect = iconEl.getBoundingClientRect();
    const bx = iRect.left + iRect.width  / 2 - sRect.left;
    const by = iRect.top                      - sRect.top;

    const dy = by - hy;
    // Cubic bezier: leave house straight down, arrive at icon straight up (0.35 = flatter arc)
    const d  = `M ${hx} ${hy} C ${hx} ${hy + dy * 0.35} ${bx} ${by - dy * 0.35} ${bx} ${by}`;
    const pathId = `fc-${b.key}`;
    const state  = _flowCurveActive[b.key] || {};
    const active = !!state.active;
    const mode   = state.mode;
    // Battery only: discharging means power flows FROM the battery TO the
    // house, the reverse of every other branch (which always flows Home ->
    // appliance) - reversed by traversing the same path backwards rather than
    // building a second geometry.
    const reversed = b.key === 'battery' && mode === 'discharging';

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.id = pathId;
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', _strokeFor(active, mode));
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);

    // Animated dot group - 3 dots staggered 0.6 s apart
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.id = `fcd-${b.key}`;
    g.setAttribute('visibility', active ? 'visible' : 'hidden');

    const dotColor = _dotColorFor(b.key, mode) || b.color;

    for (let i = 0; i < 3; i++) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('r', '3');
      dot.setAttribute('fill', dotColor);

      const motion = document.createElementNS('http://www.w3.org/2000/svg', 'animateMotion');
      motion.setAttribute('dur', '1.8s');
      motion.setAttribute('repeatCount', 'indefinite');
      motion.setAttribute('begin', `${i * 0.6}s`);
      if (reversed) {
        motion.setAttribute('calcMode', 'linear');
        motion.setAttribute('keyPoints', '1;0');
        motion.setAttribute('keyTimes', '0;1');
      }
      const mpath = document.createElementNS('http://www.w3.org/2000/svg', 'mpath');
      mpath.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `#${pathId}`);
      motion.appendChild(mpath);

      const fade = document.createElementNS('http://www.w3.org/2000/svg', 'animate');
      fade.setAttribute('attributeName', 'opacity');
      fade.setAttribute('dur', '1.8s');
      fade.setAttribute('repeatCount', 'indefinite');
      fade.setAttribute('begin', `${i * 0.6}s`);
      fade.setAttribute('values', '0;1;1;0');
      fade.setAttribute('keyTimes', '0;0.1;0.85;1');

      dot.appendChild(motion);
      dot.appendChild(fade);
      g.appendChild(dot);
    }

    svg.appendChild(g);
  });
}

function setFlowCurveActive(key, active, mode) {
  // Battery only: charging vs discharging isn't just a color change like AC's
  // cooling/heating - it flips which way the dots travel along the path,
  // which is baked into each dot's animateMotion at build time (see
  // drawFlowCurves' `reversed` handling). A plain attribute tweak here can't
  // reverse that, so force a full rebuild whenever the direction flips.
  const prevReversed = key === 'battery' && _flowCurveActive[key] && _flowCurveActive[key].mode === 'discharging';
  const nextReversed  = key === 'battery' && mode === 'discharging';

  _flowCurveActive[key] = { active, mode };

  if (prevReversed !== nextReversed) { drawFlowCurves(); return; }

  const dotsEl = document.getElementById(`fcd-${key}`);
  const pathEl = document.getElementById(`fc-${key}`);

  if (dotsEl) {
    dotsEl.setAttribute('visibility', active ? 'visible' : 'hidden');
    const col = _dotColorFor(key, mode);
    if (active && col) dotsEl.querySelectorAll('circle').forEach(c => c.setAttribute('fill', col));
  }

  if (pathEl) pathEl.setAttribute('stroke', _strokeFor(active, mode));
}

function updatePipe(selector, active, reverse) {
  const el = document.querySelector(selector);
  if (!el) return;
  let cls = 'flow-pipe ' + selector.replace('.', '');
  if (active) cls += ' active';
  if (reverse) cls += ' reverse';
  el.className = cls;
}

function setNodeVal(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function startPollCountdown() {
  let secs = pollInterval;
  if (elPollCountdown) elPollCountdown.textContent = secs + 's';
  pollingCountdown = setInterval(() => {
    secs = Math.max(0, secs - 1);
    if (elPollCountdown) elPollCountdown.textContent = secs + 's';
    if (secs <= 0) clearInterval(pollingCountdown);
  }, 1000);
}

function startUpdatedTicker() {
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(() => {
    if (elUpdatedAgo && lastTs) elUpdatedAgo.textContent = 'Updated ' + timeAgo(lastTs);
  }, 1000);
}

// Formats a kWh value: show as Wh if < 1 kWh, otherwise kWh
function fmtEnergy(kwh) {
  if (kwh === null || kwh === undefined || isNaN(kwh)) return '-';
  if (kwh < 0.01) return '0 Wh';
  if (kwh < 1)    return Math.round(kwh * 1000) + ' Wh';
  return kwh.toFixed(1) + ' kWh';
}

async function loadFlowTotals() {
  try {
    const data = await api('/api/today/node-totals');
    if (!data.ok) return;

    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };

    set('solar-node-today',  fmtEnergy(data.solar_kwh)  + ' today');
    set('home-node-today',   fmtEnergy(data.house_kwh)  + ' today');
    set('ev-node-today',     fmtEnergy(data.ev_kwh)     + ' today');

    // Hot water: show combined solar+boost total; append boost note if grid was used
    const hwTotal = (data.hw_kwh || 0) + (data.hw_boost_kwh || 0);
    const hwLabel = hwTotal > 0 && (data.hw_boost_kwh || 0) > 0
      ? fmtEnergy(hwTotal) + ' today (' + fmtEnergy(data.hw_boost_kwh) + ' grid)'
      : fmtEnergy(hwTotal) + ' today';
    set('hw-node-today', hwLabel);

    // Grid: show export (↑) and import (↓) separately
    const exp = fmtEnergy(data.grid_export_kwh);
    const imp = fmtEnergy(data.grid_import_kwh);
    set('grid-node-today', `↑${exp}  ↓${imp}`);

    // AC and Battery: not tracked by db, leave as dash
    set('ac-node-today', '-');
    set('battery-flow-node-today', '-');
  } catch (_e) {}
}

async function loadTodayStats() {
  try {
    const data = await api('/api/telemetry/today');
    if (!data.ok) return;
    const s = data.stats;
    if (elTodayKwh)      elTodayKwh.textContent      = (s.sessions?.total_kwh  || 0).toFixed(2) + ' kWh';
    if (elTodaySessions) elTodaySessions.textContent  = (s.sessions?.count      || 0) + ' sessions';
    if (elTodayDuration) elTodayDuration.textContent  = formatDuration(s.sessions?.total_secs || 0);
    if (elTodaySavings)  elTodaySavings.textContent   = '$' + (s.sessions?.total_savings || 0).toFixed(2);
  } catch (_e) {}
}

async function loadTeslamateStats() {
  try {
    const data = await api('/api/teslamate/stats');
    if (!data.ok) return;

    const insights = document.getElementById('teslamate-insights');
    let anyData = false;

    const effRow = document.getElementById('tm-efficiency-row');
    const effEl  = document.getElementById('tm-efficiency');
    if (data.efficiency && data.efficiency.kwh_per_km != null) {
      const whPerKm = Math.round(data.efficiency.kwh_per_km * 1000);
      effEl.textContent = whPerKm + ' Wh/km (real-world, last 90 days)';
      if (effRow) effRow.style.display = 'flex';
      anyData = true;
    }

    const healthRow = document.getElementById('tm-health-row');
    const healthEl  = document.getElementById('tm-health');
    if (data.health && data.health.health_pct != null) {
      healthEl.textContent = data.health.health_pct + '% health (' + data.health.usable_kwh + ' kWh usable)';
      if (healthRow) healthRow.style.display = 'flex';
      anyData = true;
    }

    const arrivalRow = document.getElementById('tm-arrival-row');
    const arrivalEl  = document.getElementById('tm-arrival');
    if (data.arrivalSoc && data.arrivalSoc.median_soc != null) {
      arrivalEl.textContent = 'typically ' + data.arrivalSoc.median_soc + '% (median)';
      if (arrivalRow) arrivalRow.style.display = 'flex';
      anyData = true;
    }

    if (insights) {
      if (anyData) insights.classList.remove('hidden');
      else         insights.classList.add('hidden');
    }
  } catch (_e) {}
}

// ─── Upcoming Trips ───────────────────────────────────────────────────────────

let _currentTripModal = null;

function formatTripDate(ts) {
  const now  = new Date();
  const date = new Date(ts);

  // Compare calendar days in local time - NOT hours elapsed (avoids "Today" for events tomorrow evening)
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateMidnight  = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDiff = Math.round((dateMidnight - todayMidnight) / 86400000);

  const timeStr = date.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true });
  if (dayDiff === 0) return `Today · ${timeStr}`;
  if (dayDiff === 1) return `Tomorrow · ${timeStr}`;
  return date.toLocaleDateString('en-AU', { weekday: 'long' }) + ` · ${timeStr}`;
}

function buildTripModal(trip) {
  const r = trip.required || {};
  const isLong = trip.distanceKm > 400;

  const rows = [
    { label: 'Drive out',      val: r.driveOut   != null ? r.driveOut.toFixed(1)   + ' kWh' : '-' },
    { label: 'Drive home',     val: r.driveHome  != null ? r.driveHome.toFixed(1)  + ' kWh' : '-' },
    { label: `Sentry (${Math.round(trip.hoursAway)}h)`, val: r.sentry != null ? r.sentry.toFixed(2) + ' kWh' : '-' },
    { label: '5% buffer',      val: r.buffer     != null ? r.buffer.toFixed(2)     + ' kWh' : '-' },
  ];

  const rowsHtml = rows.map((rw) => `
    <div class="trip-breakdown-row">
      <span class="trip-breakdown-label">${rw.label}</span>
      <span class="trip-breakdown-val">${rw.val}</span>
    </div>`).join('');

  const totalHtml = `
    <div class="trip-breakdown-total">
      <span>Total required</span>
      <span>${r.total != null ? r.total.toFixed(1) + ' kWh' : '-'}</span>
    </div>`;

  const socHtml = `
    <div class="trip-breakdown-row" style="margin-top:0.75rem">
      <span class="trip-breakdown-label">Current SoC</span>
      <span class="trip-breakdown-val">${trip.currentSocPct != null ? trip.currentSocPct.toFixed(0) + '%' : '-'}</span>
    </div>
    <div class="trip-breakdown-row">
      <span class="trip-breakdown-label">Minimum SoC needed</span>
      <span class="trip-breakdown-val">${r.minimumSocRequired != null ? r.minimumSocRequired.toFixed(0) + '%' : '-'}</span>
    </div>`;

  const solarHtml = trip.expectedSolar > 0 ? `
    <div class="trip-breakdown-row">
      <span class="trip-breakdown-label">Expected solar before departure</span>
      <span class="trip-breakdown-val" style="color:var(--accent-solar)">${trip.expectedSolar.toFixed(1)} kWh</span>
    </div>` : '';

  const alertHtml = trip.status === 'NEEDS_ATTENTION' ? `
    <div class="trip-alert-banner">
      ${trip.message || ''}
    </div>` : '';

  const longTripNote = isLong ? `
    <div style="margin-top:0.75rem;font-size:0.78rem;color:var(--text-secondary)">
      Long-distance trip - destination charging will be required along the route.
    </div>` : '';

  return `
    <div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:1rem">
      ${trip.location} · ${trip.distanceKm.toFixed(0)} km each way
    </div>
    ${rowsHtml}${totalHtml}${socHtml}${solarHtml}${alertHtml}${longTripNote}`;
}

function openTripModal(trip) {
  const overlay = document.getElementById('trip-modal');
  const titleEl = document.getElementById('trip-modal-title');
  const bodyEl  = document.getElementById('trip-modal-body');
  if (!overlay || !titleEl || !bodyEl) return;

  _currentTripModal = trip;
  titleEl.textContent = `${formatTripDate(trip.departureTime)} - ${trip.summary || trip.location}`;
  bodyEl.innerHTML = buildTripModal(trip);
  overlay.style.display = 'flex';
}

function closeTripModal() {
  const overlay = document.getElementById('trip-modal');
  if (overlay) overlay.style.display = 'none';
  _currentTripModal = null;
}

function renderTrips(trips) {
  const card = document.getElementById('trips-card');
  const list = document.getElementById('trips-list');
  if (!card || !list) return;

  if (!trips || trips.length === 0) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  list.innerHTML = '';

  for (const trip of trips.slice(0, 3)) {
    const isLong = trip.distanceKm > 400;
    let iconChar, iconClass, detailText;

    const returnKm = Math.round(trip.distanceKm * 2);
    if (isLong) {
      iconChar = '⚠';
      iconClass = 'warning';
      detailText = `${trip.distanceKm.toFixed(0)} km each way · Destination charging required`;
    } else if (trip.status === 'NEEDS_ATTENTION') {
      iconChar = '⚠';
      iconClass = 'warning';
      detailText = `Need ${(trip.solarShortfall || trip.deficit || 0).toFixed(1)} kWh from grid (~$${(trip.estimatedCost || 0).toFixed(2)})`;
    } else if (trip.status === 'SOLAR_WILL_COVER') {
      iconChar = '☀';
      iconClass = 'solar';
      detailText = `Solar will cover - ${returnKm} km return`;
    } else {
      iconChar = '✓';
      iconClass = 'ok';
      detailText = `${returnKm} km return · Current SoC covers this`;
    }

    const r = trip.required || {};
    const distKm    = trip.distanceKm != null ? Math.round(trip.distanceKm) : null;
    const usesKwh   = r.total != null ? r.total.toFixed(1) : null;
    // % of battery the trip actually consumes (not the floor minimum)
    const usesPct   = (r.total != null && r.usableCapacity > 0)
      ? Math.round((r.total / r.usableCapacity) * 100) : null;
    const minSocPct = r.minimumSocRequired != null ? Math.round(r.minimumSocRequired) : null;

    const energyRow = (usesKwh || minSocPct || distKm) ? `
      <div class="trip-energy-row">
        ${distKm    != null ? `<span class="trip-energy-badge dist">${distKm} km each way</span>` : ''}
        ${usesKwh   != null ? `<span class="trip-energy-badge kwh">uses ${usesKwh} kWh${usesPct != null ? ` (${usesPct}%)` : ''}</span>` : ''}
        ${minSocPct != null ? `<span class="trip-energy-badge pct">need ${minSocPct}% to depart</span>` : ''}
      </div>` : '';

    const needsGrid = trip.status === 'NEEDS_ATTENTION' && minSocPct != null;
    const gridBtnHtml = needsGrid ? `
      <button class="trip-grid-charge-btn" data-target-soc="${minSocPct}" title="Charge to exactly ${minSocPct}% - just enough for this trip">
        ⚡ Charge to ${minSocPct}% for this trip
      </button>` : '';

    const item = document.createElement('div');
    item.className = 'trip-item';
    item.innerHTML = `
      <span class="trip-icon ${iconClass}">${iconChar}</span>
      <div class="trip-info">
        <div class="trip-when">${formatTripDate(trip.departureTime)}</div>
        <div class="trip-name">${trip.summary || trip.location}</div>
        ${energyRow}
        <div class="trip-detail${needsGrid ? ' warning' : ''}">${detailText}</div>
        ${gridBtnHtml}
      </div>`;

    if (needsGrid) {
      item.querySelector('.trip-grid-charge-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        const target = parseInt(btn.dataset.targetSoc, 10);
        btn.disabled = true;
        btn.textContent = `Setting charge limit to ${target}%…`;
        try {
          const res = await api('/api/trips/charge-for-trip', { method: 'POST', body: { targetSocPct: target } });
          if (res.ok) {
            btn.textContent = `✓ Charging to ${target}%`;
            btn.style.color = 'var(--accent-solar)';
            btn.style.borderColor = 'var(--accent-solar)';
          } else {
            btn.textContent = `Failed: ${res.error || 'unknown error'}`;
            btn.disabled = false;
          }
        } catch (_) {
          btn.textContent = 'Error - try again';
          btn.disabled = false;
        }
      });
    }

    item.addEventListener('click', () => openTripModal(trip));
    list.appendChild(item);
  }
}

let _tripsInitialRetryDone = false;
async function loadTrips() {
  try {
    const data = await api('/api/trips');
    if (!data.ok || !data.configured) return;
    renderTrips(data.trips || []);
    // On first load, if calendar is configured but trips are empty, retry once after 12 s
    // to let the initial CalDAV fetch + trip assessment finish (startup race condition)
    if (!_tripsInitialRetryDone && data.configured && (data.trips || []).length === 0) {
      _tripsInitialRetryDone = true;
      setTimeout(loadTrips, 12000);
    }
  } catch (_e) {}
}

async function loadSolarProvenance() {
  try {
    const data = await api('/api/stats/solar-provenance');
    if (!data.ok || !data.first_session_at) return;

    const group = document.getElementById('provenance-group');
    if (group) group.style.display = '';

    const solarKwh = (data.total_solar_kwh || 0).toFixed(1);
    const pct      = data.solar_pct || 0;
    const savings  = (data.est_savings_aud || 0).toFixed(2);

    const elKwh    = document.getElementById('lifetime-solar-kwh');
    const elPct    = document.getElementById('lifetime-solar-pct');
    const elSav    = document.getElementById('lifetime-savings');
    const elSince  = document.getElementById('lifetime-since');

    if (elKwh)   elKwh.textContent  = solarKwh + ' kWh';
    if (elPct)   elPct.textContent  = pct + '%';
    if (elSav)   elSav.textContent  = '$' + savings;
    if (elSince && data.first_session_at) {
      const d = new Date(data.first_session_at);
      elSince.textContent = d.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });
    }
  } catch (_e) {}
}

// ─── Init ─────────────────────────────────────────────────────────────────────

// ─── Solar Forecast ──────────────────────────────────────────────────────────

async function loadForecast() {
  try {
    const data = await api('/api/solcast/forecast');
    if (!data.ok) return;

    const { forecasts, daily_totals, accuracy_ratio } = data;

    // ── Per-day summary strip ─────────────────────────────────────────────
    const summaryEl = document.getElementById('forecast-daily-summary');
    if (summaryEl && Array.isArray(daily_totals) && daily_totals.length > 0) {
      const today     = new Date();
      const todayStr  = today.toLocaleDateString('en-CA');  // YYYY-MM-DD local time
      const tomorrow  = new Date(today); tomorrow.setDate(today.getDate() + 1);
      const tomStr    = tomorrow.toLocaleDateString('en-CA');

      summaryEl.innerHTML = daily_totals.map(({ day, kwh, remaining_kwh }) => {
        let label;
        let subLabel = '';
        if (day === todayStr) {
          label = 'Today';
          if (remaining_kwh != null && remaining_kwh < kwh) {
            subLabel = `<span class="forecast-summary-sub">${remaining_kwh.toFixed(1)} kWh left</span>`;
          }
        } else if (day === tomStr) {
          label = 'Tomorrow';
        } else {
          const d = new Date(day + 'T12:00:00');
          label = d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
        }
        return `<div class="forecast-summary-item">
          <span class="forecast-summary-label">${label}</span>
          <span class="forecast-summary-value">${kwh.toFixed(1)} kWh</span>
          ${subLabel}
        </div>`;
      }).join('');
    }

    // Draw chart: 48 30-min intervals = 1440 minutes
    if (elChart && forecasts.length > 0) {
      const maxPv = Math.max(...forecasts.map(f => f.pv_estimate_kw), 1);
      const barWidth = 1440 / forecasts.length;
      const chartHeight = 200;
      const padding = 10;
      const chartArea = chartHeight - padding * 2;

      // Clear existing bars
      Array.from(elChart.querySelectorAll('rect')).forEach(r => r.remove());

      for (let i = 0; i < forecasts.length; i++) {
        const f = forecasts[i];
        const height = Math.max(1, (f.pv_estimate_kw / maxPv) * chartArea);
        const x = i * barWidth;
        const y = chartHeight - padding - height;

        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', x);
        rect.setAttribute('y', y);
        rect.setAttribute('width', barWidth - 0.5);
        rect.setAttribute('height', height);
        elChart.appendChild(rect);
      }
    }

    // Show accuracy tracking if available
    if (elAccuracyBanner && accuracy_ratio) {
      if (accuracy_ratio > 1.15) {
        elAccuracyBanner.textContent = `✨ Generating better than expected (${(accuracy_ratio * 100).toFixed(0)}%) - On track for strong day!`;
        elAccuracyBanner.classList.remove('hidden');
      } else if (accuracy_ratio < 0.85) {
        elAccuracyBanner.textContent = `⛅ Generating less than expected (${(accuracy_ratio * 100).toFixed(0)}%) - Adjusted forecast applied.`;
        elAccuracyBanner.classList.remove('hidden');
      } else {
        elAccuracyBanner.classList.add('hidden');
      }
    }
  } catch (err) {
    console.error('[forecast] Load failed:', err);
  }
}

// ─── Panel Health ─────────────────────────────────────────────────────────────

let _panelModalOpen = false;

function openPanelModal(panel) {
  const modal = document.getElementById('panel-modal');
  const title = document.getElementById('panel-modal-title');
  const body  = document.getElementById('panel-modal-body');
  if (!modal || !title || !body) return;

  title.textContent = `${panel.label} - 7-day trend`;

  const healthColor = { green: 'var(--accent-charge)', amber: '#f59e0b', red: 'var(--accent-import)' };
  const maxWatts = Math.max(...panel.trend.map(t => t.avg_watts || 0), 1);

  let html = '';

  // Summary rows
  const healthLabel = panel.health === 'green' ? 'Normal' : panel.health === 'amber' ? 'Slightly below' : 'Underperforming';
  html += `<div class="panel-info-row"><span class="panel-info-label">Serial (last 6)</span><span class="panel-info-val">${panel.serial_short}</span></div>`;
  html += `<div class="panel-info-row"><span class="panel-info-label">Health status</span><span class="panel-info-val" style="color:${healthColor[panel.health] || 'inherit'}">${healthLabel}</span></div>`;
  if (panel.health !== 'green') {
    html += `<div class="panel-info-row"><span class="panel-info-label">Avg % below median</span><span class="panel-info-val" style="color:${healthColor[panel.health]}">${panel.pct_below_median}%</span></div>`;
    html += `<div class="panel-info-row"><span class="panel-info-label">Clear-condition samples</span><span class="panel-info-val">${panel.bad_samples} / ${panel.clear_samples}</span></div>`;
  }
  html += '<div style="margin-top:1rem;margin-bottom:0.5rem;font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-secondary)">Daily average output</div>';

  // 7-day trend bars
  for (const day of panel.trend) {
    const dateStr = day.date ? new Date(day.date + 'T12:00').toLocaleDateString('en-AU', { weekday: 'short', month: 'short', day: 'numeric' }) : '-';
    if (day.avg_watts == null) {
      html += `<div class="panel-trend-bar-row"><span class="panel-trend-date">${dateStr}</span><span class="panel-trend-no-data">No data</span></div>`;
      continue;
    }
    const pct = Math.round((day.avg_watts / maxWatts) * 100);
    const fillClass = day.avg_watts < maxWatts * 0.7 ? 'red' : day.avg_watts < maxWatts * 0.85 ? 'amber' : 'green';
    html += `<div class="panel-trend-bar-row">
      <span class="panel-trend-date">${dateStr}</span>
      <div class="panel-trend-bar-wrap">
        <div class="panel-trend-bar-fill ${fillClass}" style="width:${pct}%"></div>
      </div>
      <span class="panel-trend-val">${day.avg_watts}W</span>
    </div>`;
  }

  body.innerHTML = html;
  modal.style.display = 'flex';
  _panelModalOpen = true;
}

function closePanelModal() {
  const modal = document.getElementById('panel-modal');
  if (modal) modal.style.display = 'none';
  _panelModalOpen = false;
}

async function loadAiInsights() {
  const body = document.getElementById('ai-insights-body');
  const ts   = document.getElementById('ai-insights-timestamp');
  if (!body) return;
  try {
    const data = await api('/api/ai-insights');
    if (!data.ok || !data.text) {
      body.innerHTML = '<span class="ai-insights-loading">No briefing yet - will generate at 6:30 am and 9 pm.</span>';
      return;
    }
    // Render paragraphs
    const paragraphs = data.text.split(/\n\n+/).filter(p => p.trim());
    body.innerHTML = paragraphs.map(p => `<p>${p.trim()}</p>`).join('');
    if (ts && data.generated_at) {
      const d = new Date(data.generated_at);
      ts.textContent = d.toLocaleTimeString('en-AU', {
        timeZone: 'Australia/Brisbane', hour: '2-digit', minute: '2-digit',
      });
    }
  } catch (err) {
    body.innerHTML = `<span class="ai-insights-error">Could not load briefing.</span>`;
  }
}

async function loadPanelHealth() {
  try {
    const data = await api('/api/panels/health');
    if (!data.ok || !data.panels || data.panels.length === 0) return;

    const card = document.getElementById('panel-health-card');
    if (card) card.style.display = '';

    const grid = document.getElementById('panel-health-grid');
    if (!grid) return;
    grid.innerHTML = '';

    data.panels.sort((a, b) => (a.label || a.serial_short).localeCompare(b.label || b.serial_short));
    for (const panel of data.panels) {
      const tile = document.createElement('div');
      tile.className = `panel-tile panel-tile-${panel.health}`;
      tile.title = `${panel.label}\nSerial: …${panel.serial_short}\n${panel.health === 'green' ? 'Normal' : panel.pct_below_median + '% below median'}`;

      const label = document.createElement('span');
      label.className = 'panel-tile-label';
      label.textContent = panel.label || panel.serial_short;
      tile.appendChild(label);

      if (panel.trend && panel.trend.length > 0) {
        const todayEntry = panel.trend[panel.trend.length - 1];
        if (todayEntry && todayEntry.avg_watts != null) {
          const w = document.createElement('span');
          w.className = 'panel-tile-watts';
          w.textContent = todayEntry.avg_watts + 'W';
          tile.appendChild(w);
        }
      }

      tile.addEventListener('click', () => openPanelModal(panel));
      grid.appendChild(tile);
    }

    // Status summary
    const statusEl = document.getElementById('panel-health-status-text');
    if (statusEl) {
      const s = data.summary || {};
      if (s.red > 0) {
        statusEl.textContent = `${s.red} panel${s.red !== 1 ? 's' : ''} need attention`;
        statusEl.className = 'panel-health-status-text error';
      } else if (s.amber > 0) {
        statusEl.textContent = `${s.amber} panel${s.amber !== 1 ? 's' : ''} slightly underperforming`;
        statusEl.className = 'panel-health-status-text warn';
      } else {
        statusEl.textContent = 'All panels normal';
        statusEl.className = 'panel-health-status-text ok';
      }
    }

    // Footer timestamp
    const footer = document.getElementById('panel-health-footer');
    if (footer && data.last_poll_at) {
      const mins = Math.round((Date.now() - data.last_poll_at) / 60000);
      footer.textContent = mins < 120
        ? `Last updated ${mins} min${mins !== 1 ? 's' : ''} ago - tap a panel for 7-day trend`
        : `Last updated ${Math.round(mins / 60)}h ago - tap a panel for 7-day trend`;
    } else if (footer) {
      footer.textContent = 'Tap a panel for 7-day trend';
    }
  } catch (_e) {}
}

async function loadBatteryStatus() {
  try {
    const data = await api('/api/battery/status');
    const card = document.getElementById('battery-card');
    if (!data.ok || !data.configured) {
      if (card) card.style.display = 'none';
      return;
    }
    if (card) card.style.display = '';

    const brandEl = document.getElementById('battery-card-brand');
    if (brandEl) brandEl.textContent = data.brand || '';

    const errorEl = document.getElementById('battery-card-error');
    if (data.error) {
      if (errorEl) { errorEl.textContent = data.error; errorEl.style.display = 'block'; }
      return;
    }
    if (errorEl) errorEl.style.display = 'none';

    const socEl = document.getElementById('battery-card-soc');
    const barEl = document.getElementById('battery-card-bar');
    if (typeof data.socPct === 'number') {
      const pct = Math.max(0, Math.min(100, data.socPct));
      if (socEl) socEl.textContent = `${Math.round(pct)}%`;
      if (barEl) barEl.style.width = `${pct}%`;
    }

    const powerEl = document.getElementById('battery-card-power');
    if (powerEl && typeof data.powerW === 'number') {
      const w = Math.abs(Math.round(data.powerW));
      powerEl.textContent = data.powerW > 20 ? `Charging ${formatWatts(w)}`
        : data.powerW < -20 ? `Discharging ${formatWatts(w)}`
        : 'Idle';
    }

    const priorityEl = document.getElementById('battery-card-priority');
    if (priorityEl) {
      priorityEl.textContent = data.priority === 'ev_first' ? 'Priority: EV first' : 'Priority: Battery first';
    }
  } catch (_e) {}
}

document.addEventListener('DOMContentLoaded', () => {
  // Charging Control toggle
  if (elControlToggle) {
    elControlToggle.addEventListener('change', () => setControlEnabled(elControlToggle.checked));
  }

  // Action buttons
  if (elBtnStop)      elBtnStop.addEventListener('click',      () => sendAction('stop'));
  if (elBtnAuto)      elBtnAuto.addEventListener('click',      () => sendAction('auto'));
  if (elBtnChargeNow) elBtnChargeNow.addEventListener('click', () => sendAction('charge-now'));

  // Charge limit slider
  if (elChargeLimitSlider) {
    elChargeLimitSlider.addEventListener('mousedown',  () => { sliderDragging = true; });
    elChargeLimitSlider.addEventListener('touchstart', () => { sliderDragging = true; });
    elChargeLimitSlider.addEventListener('input', () => {
      const val = parseInt(elChargeLimitSlider.value, 10);
      if (elChargeLimitSliderVal) elChargeLimitSliderVal.textContent = val + '%';
      clearTimeout(chargeLimitDebounce);
      chargeLimitDebounce = setTimeout(() => { sliderDragging = false; submitChargeLimit(val); }, 800);
    });
    elChargeLimitSlider.addEventListener('mouseup',  () => { clearTimeout(chargeLimitDebounce); sliderDragging = false; submitChargeLimit(parseInt(elChargeLimitSlider.value, 10)); });
    elChargeLimitSlider.addEventListener('touchend', () => { clearTimeout(chargeLimitDebounce); sliderDragging = false; submitChargeLimit(parseInt(elChargeLimitSlider.value, 10)); });
  }

  // Trip modal close handlers
  const tripModalClose = document.getElementById('trip-modal-close');
  if (tripModalClose) tripModalClose.addEventListener('click', closeTripModal);
  const tripModalOverlay = document.getElementById('trip-modal');
  if (tripModalOverlay) {
    tripModalOverlay.addEventListener('click', (e) => {
      if (e.target === tripModalOverlay) closeTripModal();
    });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeTripModal(); closePanelModal(); } });

  // Panel modal close handlers
  const panelModalClose = document.getElementById('panel-modal-close');
  if (panelModalClose) panelModalClose.addEventListener('click', closePanelModal);
  const panelModalOverlay = document.getElementById('panel-modal');
  if (panelModalOverlay) {
    panelModalOverlay.addEventListener('click', (e) => {
      if (e.target === panelModalOverlay) closePanelModal();
    });
  }

  // Trips refresh button
  const tripsRefreshBtn = document.getElementById('trips-refresh-btn');
  if (tripsRefreshBtn) {
    let tripsRefreshing = false;
    tripsRefreshBtn.addEventListener('click', async () => {
      if (tripsRefreshing) return;
      tripsRefreshing = true;
      tripsRefreshBtn.style.animation = 'spin 1s linear infinite';
      tripsRefreshBtn.style.opacity   = '0.6';
      try {
        await api('/api/trips/refresh', { method: 'POST' });
        // Server responds immediately; CalDAV fetch runs in background (~8-10s).
        // Reload once now (shows current data), then again after 12s to catch new data.
        await loadTrips();
        setTimeout(async () => { await loadTrips(); }, 12000);
      } catch (_) {}
      tripsRefreshBtn.style.animation = '';
      tripsRefreshBtn.style.opacity   = '';
      tripsRefreshing = false;
    });
  }

  // Forecast refresh button
  const forecastRefreshBtn = document.getElementById('forecast-refresh-btn');
  if (forecastRefreshBtn) {
    forecastRefreshBtn.addEventListener('click', async () => {
      forecastRefreshBtn.style.opacity = '0.4';
      try {
        await api('/api/solcast/fetch', { method: 'POST' });
        await loadForecast();
      } catch (_) {}
      forecastRefreshBtn.style.opacity = '';
    });
  }

  // AI insights refresh button
  const aiRefreshBtn = document.getElementById('ai-insights-refresh-btn');
  if (aiRefreshBtn) {
    aiRefreshBtn.addEventListener('click', async () => {
      aiRefreshBtn.disabled = true;
      const body = document.getElementById('ai-insights-body');
      if (body) body.innerHTML = '<span class="ai-insights-loading">Generating briefing…</span>';
      try {
        await api('/api/ai-insights/refresh', { method: 'POST' });
        await loadAiInsights();
      } catch (_) {
        if (body) body.innerHTML = '<span class="ai-insights-error">Generation failed - check Gemini API key in Settings.</span>';
      }
      aiRefreshBtn.disabled = false;
    });
  }

  // Draw initial bezier curves and keep them in sync with layout changes
  drawFlowCurves();
  let _resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(drawFlowCurves, 80);
  });

  connectSSE();
  startUpdatedTicker();
  loadTodayStats();
  loadFlowTotals();
  loadTeslamateStats();
  loadSolarProvenance();
  loadTrips();
  loadForecast();
  loadPanelHealth();
  loadAiInsights();
  setInterval(loadTodayStats,   60000);
  setInterval(loadFlowTotals, 5 * 60 * 1000);  // refresh node totals every 5 min
  setInterval(loadTeslamateStats, 3600000);    // refresh TeslaMate stats every hour
  setInterval(loadSolarProvenance, 300000);    // refresh provenance every 5 min
  setInterval(loadTrips, 30 * 60 * 1000);     // refresh trips every 30 minutes
  setInterval(loadForecast, 15 * 60 * 1000);  // refresh forecast every 15 minutes
  setInterval(loadPanelHealth, 5 * 60 * 1000); // refresh panel health every 5 minutes
  loadBatteryStatus();
  setInterval(loadBatteryStatus, 60 * 1000); // refresh battery status every 60s
  setInterval(loadAiInsights, 30 * 60 * 1000); // refresh AI insights every 30 min

  // ── Eddi (Hot Water) Controls ──────────────────────────────────────────────
  (function setupEddiControls() {
    const card      = document.getElementById('eddi-card');
    const statusEl  = document.getElementById('eddi-status');
    const tempsEl   = document.getElementById('eddi-temps');
    const actionEl  = document.getElementById('eddi-action-status');
    const BOOST_BTNS = ['eddi-btn-boost-30', 'eddi-btn-boost-60'];
    const ALL_BTNS   = ['eddi-btn-solar', ...BOOST_BTNS, 'eddi-btn-stop-boost', 'eddi-btn-off'];

    function setActive(activeId) {
      ALL_BTNS.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.toggle('active', id === activeId);
      });
    }

    function setMsg(msg, ok = true) {
      if (!actionEl) return;
      actionEl.textContent = msg;
      actionEl.style.color = ok ? 'var(--accent-solar)' : 'var(--accent-import)';
      setTimeout(() => { actionEl.textContent = ''; }, 4000);
    }

    async function eddiCmd(endpoint, body = {}) {
      try {
        const r = await api(endpoint, { method: 'POST', body });
        if (r.ok) setMsg('Command sent ✓');
        else      setMsg(r.error || 'Command failed', false);
      } catch (e) {
        setMsg('Error: ' + e.message, false);
      }
    }

    document.getElementById('eddi-btn-solar')?.addEventListener('click', () => eddiCmd('/api/eddi/mode', { mode: 'eco' }));
    document.getElementById('eddi-btn-boost-30')?.addEventListener('click', () => eddiCmd('/api/eddi/boost', { heater: 1, minutes: 30 }));
    document.getElementById('eddi-btn-boost-60')?.addEventListener('click', () => eddiCmd('/api/eddi/boost', { heater: 1, minutes: 60 }));
    document.getElementById('eddi-btn-stop-boost')?.addEventListener('click', () => eddiCmd('/api/eddi/stop-boost', { heater: 1 }));
    document.getElementById('eddi-btn-off')?.addEventListener('click', () => eddiCmd('/api/eddi/mode', { mode: 'stop' }));

    // Update card from SSE telemetry data
    window._updateEddiCard = function(status, temp1, temp2) {
      if (!card) return;
      card.style.display = 'block';

      const s = (status || '').toLowerCase();
      statusEl.textContent = status || '-';
      statusEl.className   = 'eddi-card-status';
      if (s === 'diverting')          statusEl.classList.add('diverting');
      else if (s === 'boosting')      statusEl.classList.add('boosting');
      else if (s === 'stopped')       statusEl.classList.add('stopped');

      // Highlight active button
      if (s === 'boosting')        setActive('eddi-btn-stop-boost');
      else if (s === 'stopped')    setActive('eddi-btn-off');
      else                         setActive('eddi-btn-solar');

      // Temperature display
      const temps = [];
      if (temp1 != null) temps.push(`T1: ${temp1}°C`);
      if (temp2 != null) temps.push(`T2: ${temp2}°C`);
      if (tempsEl) tempsEl.textContent = temps.join('\n');
    };
  })();

  // ── Weather & Grid Intelligence ─────────────────────────────────────────────
  (function weatherGridModule() {
    const strip = document.getElementById('weather-strip');
    if (!strip) return;

    const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    function renderWeather(w) {
      if (!w || !w.data) return;
      const d = w.data;
      strip.style.display = 'flex';

      document.getElementById('weather-emoji').textContent  = d.current?.emoji   || '🌡️';
      document.getElementById('weather-temp').textContent   = (d.current?.temp != null ? Math.round(d.current.temp) + '°' : '-°');
      document.getElementById('weather-label').textContent  = d.current?.label   || '-';
      document.getElementById('weather-humidity').textContent = (d.current?.humidity != null ? d.current.humidity + '% humidity' : '');
      document.getElementById('weather-wind').textContent   = (d.current?.windKmh != null ? Math.round(d.current.windKmh) + ' km/h wind' : '');

      // 7-day daily forecast (today + 6 more)
      const fc = document.getElementById('weather-forecast-days');
      if (fc && d.daily && d.daily.length > 0) {
        const todayDate = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
        fc.innerHTML = d.daily.slice(0, 7).map(day => {
          const isToday = day.date === todayDate;
          const name = isToday ? 'Today' : DAY_NAMES[new Date(day.date + 'T00:00:00').getDay()];
          return `<div class="weather-day${isToday ? ' weather-day-today' : ''}">
            <div class="weather-day-name">${name}</div>
            <div class="weather-day-emoji">${day.emoji}</div>
            <div class="weather-day-temps">${Math.round(day.tempMax)}°/${Math.round(day.tempMin)}°</div>
          </div>`;
        }).join('');
      }
    }

    function renderGridIntensity(gi) {
      if (!gi) return;
      const badge = document.getElementById('grid-intensity-badge');
      if (!badge) return;
      const ci = Math.round(gi.carbonIntensityG || 0);
      // WattTime/ElectricityMaps return carbon intensity but no renewable % -
      // null there means "not provided", which must not render as "0% renewable"
      const hasRenewable = gi.renewablePct != null;
      const rp = hasRenewable ? Math.round(gi.renewablePct) : null;
      document.getElementById('grid-intensity-val').textContent = ci;
      document.getElementById('grid-renewable-pct').textContent = hasRenewable ? rp + '% renewable' : '';
      badge.className = 'grid-intensity-badge ' +
        (ci < 300 ? 'clean' : ci < 550 ? 'moderate' : 'dirty');

      // Update icon colour (fall back to intensity thresholds when renewable % is unavailable)
      const icon = document.getElementById('grid-intensity-icon');
      if (icon) {
        icon.textContent = hasRenewable
          ? (rp >= 60 ? '🌿' : rp >= 30 ? '⚡' : '🏭')
          : (ci < 300 ? '🌿' : ci < 550 ? '⚡' : '🏭');
      }
    }

    function loadWeatherGrid() {
      api('/api/weather').then(r => { if (r.ok) renderWeather(r.weather); }).catch(() => {});
      api('/api/carbon-intensity').then(r => { if (r.ok) renderGridIntensity(r.intensity); }).catch(() => {});
    }

    loadWeatherGrid();
    setInterval(loadWeatherGrid, 5 * 60 * 1000);  // refresh every 5 min
  })();

  // ── Departure Scheduler card ─────────────────────────────────────────────────
  (function departureModule() {
    const card          = document.getElementById('departure-card');
    const clearBtn      = document.getElementById('departure-clear-btn');
    const activeEl      = document.getElementById('departure-active');
    const formEl        = document.getElementById('departure-form');
    const setBtn        = document.getElementById('departure-set-btn');
    const noteEl        = document.getElementById('departure-form-note');
    const socSlider     = document.getElementById('dep-soc-slider');
    const socValueEl    = document.getElementById('dep-soc-value');
    const timeInput     = document.getElementById('dep-time-input');

    if (!card) return;

    // Set the default datetime to 8am tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(8, 0, 0, 0);
    if (timeInput) {
      const pad = n => String(n).padStart(2, '0');
      const local = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth()+1)}-${pad(tomorrow.getDate())}T08:00`;
      timeInput.value = local;
    }

    // SOC slider live value
    if (socSlider && socValueEl) {
      socSlider.addEventListener('input', () => {
        socValueEl.textContent = socSlider.value + '%';
      });
    }

    function renderDeparture(dep) {
      if (!dep) {
        // No active departure - show form
        if (activeEl) { activeEl.classList.add('hidden'); }
        if (formEl)   { formEl.style.display = ''; }
        if (clearBtn) { clearBtn.classList.add('hidden'); }
        if (elDepartureBanner) hide(elDepartureBanner);
        return;
      }

      // Active departure - show summary
      if (activeEl) { activeEl.classList.remove('hidden'); }
      if (formEl)   { formEl.style.display = 'none'; }
      if (clearBtn) { clearBtn.classList.remove('hidden'); }

      const depDate = new Date(dep.departureTime);
      const timeStr = depDate.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
      const dateStr = depDate.toLocaleDateString('en-AU', { weekday: 'short', month: 'short', day: 'numeric' });

      const depTimeEl = document.getElementById('dep-time-display');
      const depSocEl  = document.getElementById('dep-soc-display');
      const depHrsEl  = document.getElementById('dep-hours-display');
      const depStatEl = document.getElementById('dep-status-text');

      if (depTimeEl) depTimeEl.textContent = `${timeStr} ${dateStr}`;
      if (depSocEl)  depSocEl.textContent  = dep.targetSoc + '%';
      if (depHrsEl)  depHrsEl.textContent  = dep.hoursUntil + 'h';

      const activationHours = 6;
      if (depStatEl) {
        if (dep.hoursUntil <= activationHours) {
          depStatEl.textContent = `Grid charging active - reaching ${dep.targetSoc}% before departure`;
          depStatEl.style.color = 'var(--accent-solar)';
        } else {
          const triggerIn = Math.round((dep.hoursUntil - activationHours) * 10) / 10;
          depStatEl.textContent = `Solar-first charging; grid top-up activates in ${triggerIn}h if needed`;
          depStatEl.style.color = '';
        }
      }

      // Update departure banner in EV card
      if (elDepartureBanner) {
        show(elDepartureBanner);
        if (elDepartureBannerDesc) {
          elDepartureBannerDesc.textContent =
            `Targeting ${dep.targetSoc}% by ${timeStr} - ${dep.hoursUntil}h remaining`;
        }
      }
    }

    async function loadDeparture() {
      try {
        const r = await api('/api/departure');
        if (r.ok) renderDeparture(r.departure);
      } catch (_) {}
    }

    // Set departure
    if (setBtn) {
      setBtn.addEventListener('click', async () => {
        if (noteEl) { noteEl.textContent = ''; noteEl.className = 'departure-form-note'; }
        const rawTime = timeInput ? timeInput.value : '';
        const soc     = socSlider ? parseInt(socSlider.value, 10) : 80;
        const notes   = document.getElementById('dep-notes-input')?.value || '';

        if (!rawTime) {
          if (noteEl) { noteEl.textContent = 'Please enter a departure time.'; noteEl.className = 'departure-form-note error'; }
          return;
        }
        const tsMs = new Date(rawTime).getTime();
        if (isNaN(tsMs) || tsMs <= Date.now()) {
          if (noteEl) { noteEl.textContent = 'Departure time must be in the future.'; noteEl.className = 'departure-form-note error'; }
          return;
        }

        setBtn.disabled = true;
        try {
          const r = await api('/api/departure', { method: 'POST', body: { departure_time: tsMs, target_soc: soc, notes } });
          if (r.ok) {
            renderDeparture(r.departure);
            if (noteEl) { noteEl.textContent = ''; }
          } else {
            if (noteEl) { noteEl.textContent = r.error || 'Failed to set departure.'; noteEl.className = 'departure-form-note error'; }
          }
        } catch (e) {
          if (noteEl) { noteEl.textContent = e.message; noteEl.className = 'departure-form-note error'; }
        } finally {
          setBtn.disabled = false;
        }
      });
    }

    // Clear departure
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        try {
          await api('/api/departure', { method: 'DELETE' });
          renderDeparture(null);
          loadDeparture();
        } catch (_) {}
      });
    }

    // Initial load
    loadDeparture();
    setInterval(loadDeparture, 60 * 1000); // re-check every minute (auto-clears when target reached)
  })();

  // Pre-populate from last known status
  api('/api/status').then((data) => {
    if (!data.ok) return;
    const s  = data.status || {};
    const lt = data.lastTelemetry;
    updateCertBanner(data.certs);
    const base = {
      controllerState: s.controllerState, holdRemaining: null,
      gatewayOk: s.gatewayOk, teslaOk: s.teslaOk,
      isAtHome: s.isAtHome, manualOverride: s.manualOverride,
      controlEnabled: s.controlEnabled,
    };
    if (s.solarW !== undefined) {
      handleTelemetry({ ts: s.lastUpdated || Date.now(), ...base,
        solar: s.solarW, consumption: s.consumptionW, grid: s.gridW,
        solarExcess: s.solarExcessW, smoothedExcess: s.smoothedExcess,
        targetAmps: s.targetAmps, evWatts: s.evWatts, evAmps: s.chargeAmps,
        batteryPct: s.batteryPct, chargingState: s.chargingState,
        vehicleName: s.vehicleName,
      });
    } else if (lt) {
      handleTelemetry({ ts: lt.recorded_at || Date.now(), ...base,
        solar: lt.solar_w, consumption: lt.consumption_w, grid: lt.grid_w,
        solarExcess: lt.solar_excess_w, smoothedExcess: lt.solar_excess_w,
        targetAmps: 0, evWatts: lt.ev_w, evAmps: lt.charge_amps,
        batteryPct: lt.battery_pct, chargingState: null,
      });
    }
  }).catch(() => {});
});
