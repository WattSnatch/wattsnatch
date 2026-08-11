/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const db = require('./db');
const myenergi    = require('./services/myenergi');
const ac = require('./services/ac');
const baseline = require('./services/baseline');
const meters = require('./services/meters');
const battery = require('./services/battery');
const retailerRates = require('./services/retailerRates');
const { wakeVehicle, setChargingAmps, startCharging, stopCharging, getVehicleState, getVehicleData, useBleCommands, getVehicleDataBle, getBodyStateBle } = require('./services/tesla');
const telemetry = require('./services/telemetry');
const notificationMonitor = require('./services/notificationMonitor');
const departureScheduler  = require('./services/departureScheduler');
const { decrypt } = require('./utils/crypto');
const logger = require('./utils/logger');
const mqttPublisher = require('./services/mqttPublisher');

// How stale a charge limit may be before we re-read it from Tesla rather than
// stop charging on it. Short, because this only triggers at the moment we are
// about to stop, which is rare and is exactly when being wrong is costly.
const VERIFY_LIMIT_BEFORE_STOP_MS = 2 * 60 * 1000;

/**
 * Whether a charge_state snapshot's charge_limit_soc can be believed.
 *
 * Tesla reports charge_limit_soc as charge_limit_soc_min while the car is
 * unplugged, and the owner's real limit only once it is plugged in. Observed
 * directly on this vehicle: every plugged-in read returned
 * `limit=80 min=50 std=80`, while unplugged reads return
 * `limit=50 min=50 std=80`.
 *
 * That is the whole "it keeps going back to 50%" bug. An hourly refresh, or a
 * boot reconciliation, that happens to land while the car is unplugged latches
 * 50 as a fresh and supposedly trusted 'api' reading. Fleet Telemetry then never
 * corrects it, because it only pushes ChargeLimitSoc when the value CHANGES and
 * from the car's point of view nothing did. The stale 50 is persisted, survives
 * restarts, and the controller stops charging at 50% on a car set to 80%.
 *
 * Rejecting the reading is deliberately more conservative than substituting
 * charge_limit_soc_std: an unplugged car is not charging, so there is nothing to
 * decide yet, and the next plugged-in refresh supplies a genuine value. If the
 * owner really does set 50, a plugged-in read confirms it normally - this only
 * discards the placeholder, never a limit the owner actually chose while the car
 * was connected.
 */
function isChargeLimitTrustworthy(cs) {
  if (!cs || typeof cs.charge_limit_soc !== 'number') return false;
  // Plugged in (Charging, Stopped, Complete, NoPower): Tesla reports the truth.
  if (cs.charging_state && cs.charging_state !== 'Disconnected') return true;
  // Unplugged AND sitting exactly on the floor while the standard differs - the
  // signature of the placeholder rather than a real setting.
  return !(cs.charge_limit_soc === cs.charge_limit_soc_min
    && typeof cs.charge_limit_soc_std === 'number'
    && cs.charge_limit_soc_std !== cs.charge_limit_soc_min);
}

const STATES = {
  IDLE:       'IDLE',       // No car, or car disconnected
  WAITING:    'WAITING',    // Car plugged in, no solar yet - we stopped any grid charge
  MONITORING: 'MONITORING', // Solar appeared, confirming before starting
  CHARGING:   'CHARGING',   // Actively solar-charging
  HOLDING:    'HOLDING',    // Solar dropped, hold timer running before stopping
  STOPPED:    'STOPPED',    // User pressed STOP - won't auto-restart until AUTO
  OVERRIDE:   'OVERRIDE',   // CHARGE NOW - grid charging at max regardless of solar
  SCHEDULED:  'SCHEDULED',  // Charging on time schedule (e.g., overnight off-peak)
  DEPARTURE:  'DEPARTURE',  // Charging to meet departure SOC target (solar-first, grid top-up)
  ERROR:      'ERROR',
};

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const PLUGGED_IN = new Set(['Stopped', 'NoPower', 'Charging', 'Complete']);
// Narrower than PLUGGED_IN, for battery-priority arbitration only: 'Complete'
// means the EV is at its charge limit and won't draw more, so holding the
// battery back in that state would just dump solar to export for no benefit.
const EV_WANTS_POWER = new Set(['Stopped', 'NoPower', 'Charging']);

class Controller {
  constructor() {
    this.state = STATES.IDLE;
    this.holdTimerStart = null;
    this.smoothingBuffer = [];
    this.lastWakeAttempt = null;
    this._teslaCommandTick = 0;
    this.sseClients = [];
    this.currentSessionId = null;
    this.sessionStartBattery = null;
    this.sessionPeakAmps = 0;
    this.sessionAmpsReadings = [];
    this.sessionStartedAt = null;
    this._interval = null;
    this._lastTelemetry = null;
    this._lastError = null;
    this._gatewayOk = false;
    this._teslaOk = false;
    this._lastLatLng = null;
    this._isAtHome = true;
    this._lastChargeState = null;
    this._vehicleCloudState = null;
    this._scheduleActive = false;
    this._touPeakActive = false;
    this._freePowerActive = false;
    this._lastFallbackAt = 0;
    this._lastCommandedAmps = null;
    this._lastGatewaySuccessAt = Date.now();
    this._teslaTokenRefreshAt = 0;
    this._carSleeping = false;  // true once REST confirms asleep; cleared when ZMQ fires on wake
    // Forces exactly one REST reconciliation of charge_limit_soc (and other
    // fields) shortly after every boot, regardless of how fresh the persisted
    // telemetry snapshot looks. Fixes a real gap: Fleet Telemetry only pushes
    // ChargeLimitSoc on change (no periodic resend of an unchanged value), so
    // if that one push happens to land during a restart - exactly when this
    // app has been restarted repeatedly for deployments - it's lost forever
    // and the stale value silently persists, since every OTHER field (SoC,
    // charging state, amps) keeps updating normally and makes telemetry look
    // perfectly healthy. Cleared once a REST reconciliation actually succeeds.
    this._forceBootReconcile = true;
    // When we last ASKED Tesla to confirm the charge limit (as opposed to when
    // it last answered). Keeps a non-answering API from causing a poll storm -
    // see the chargeLimitStale check in _loop().
    this._lastChargeLimitCheckAt = 0;
    // BLE state-source mode (tesla_state_source === 'ble'): reachability doubles as geofencing
    // (BLE only carries a few metres, so "reachable" means "at home"). Starts false so we never
    // act on the car until a BLE read confirms it is present.
    this._bleReachable = false;
    this._lastBlePollAt = 0;
    this._lastBleSleepCheckAt = 0;
    this._lastZmqEmitAt = 0;   // throttle ZMQ-triggered SSE to once per second
    this._lastFinancialLedgerUpdateDate = null;  // track which date was last updated
  }

  start() {
    if (this._interval) return;

    // Close any sessions left open by a previous server restart, computing
    // their stats from the telemetry_log before new data starts coming in.
    db.closeOrphanedSessions();

    // Seed last-known battery from DB so the dashboard doesn't show 0%
    // immediately after a restart while waiting for fresh telemetry.
    const lastBatteryRow = db.getDb().prepare(
      'SELECT battery_pct, charge_amps FROM telemetry_log WHERE battery_pct > 0 ORDER BY recorded_at DESC LIMIT 1'
    ).get();
    if (lastBatteryRow) {
      this._lastChargeState = {
        charging_state:   null,
        battery_level:    lastBatteryRow.battery_pct,
        charge_limit_soc: 80,
        charge_amps:      lastBatteryRow.charge_amps || 0,
        charger_power:    0,
      };
    }

    // Seed last-known GPS from DB so home/away survives server restarts.
    const lastLat = parseFloat(db.getSetting('last_car_latitude')  || '');
    const lastLon = parseFloat(db.getSetting('last_car_longitude') || '');
    if (!isNaN(lastLat) && !isNaN(lastLon)) {
      this._lastLatLng = { lat: lastLat, lon: lastLon };
    }

    const intervalMs = (parseInt(db.getSetting('polling_interval_seconds') || '15', 10)) * 1000;
    telemetry.startTelemetryListener();

    // Push car-data updates to the dashboard as soon as ZMQ delivers them,
    // rather than waiting for the next Enphase poll cycle.
    telemetry.onVehicleUpdate(() => {
      if (!this._lastTelemetry) return;
      const now = Date.now();
      if (now - this._lastZmqEmitAt < 1000) return; // throttle to once per second
      this._lastZmqEmitAt = now;
      const t  = this._lastTelemetry;
      const ts = telemetry.getState();
      const chargeState = ts.chargingState !== null ? {
        charging_state:   ts.chargingState,
        battery_level:    ts.batteryPct,
        charge_limit_soc: ts.chargeLimit,
        charge_amps:      ts.chargeAmps,
        charger_power:    ts.chargerPowerKw,
      } : this._lastChargeState;
      this._emitTelemetry(
        { solarW: t.solarW, consumptionW: t.consumptionW, gridW: t.gridW },
        chargeState,
        t.smoothedExcess, t.targetAmps, t.solarExcessW, t.evWatts,
      );
    });

    this._interval = setInterval(() => this._loop(), intervalMs);
    logger.logEvent('info', `Controller started (Enphase interval ${intervalMs}ms, Fleet Telemetry active)`);
  }

  stop() {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
    logger.logEvent('info', 'Controller stopped');
  }

  // ── Public commands (called from API routes) ───────────────────────────────

  /** STOP button: halt charging, lock out auto-restart until AUTO is pressed. */
  async commandStop() {
    if (this.currentSessionId) {
      const ts = telemetry.getState();
      this._endSession(ts.batteryPct || 0, 'user_stopped');
    }
    this.holdTimerStart = null;
    this._setState(STATES.STOPPED, 'User commanded STOP');
    db.setSetting('manual_charge_enabled', 'false');
    try {
      const vin = db.getSetting('tesla_vin');
      const token = this._getTeslaToken();
      if (vin && this._canSendCommands(token)) { this._trackApiCall('command'); await stopCharging(vin, token); }
    } catch (err) {
      logger.logEvent('api_error', `STOP command: ${err.message}`);
    }
    logger.logEvent('command', 'User commanded STOP');
  }

  /** AUTO button: resume solar tracking from STOPPED or OVERRIDE. */
  commandAuto() {
    db.setSetting('manual_charge_enabled', 'false');
    this._setState(STATES.IDLE, 'User commanded AUTO - resuming solar control');
    logger.logEvent('command', 'User commanded AUTO');
  }

  /** CHARGE NOW button: charge at max amps from grid immediately. */
  commandChargeNow() {
    db.setSetting('manual_charge_enabled', 'true');
    this._setState(STATES.OVERRIDE, 'User commanded CHARGE NOW');
    logger.logEvent('command', 'User commanded CHARGE NOW');
  }

  /** Charging Control master toggle. */
  setControl(enabled) {
    db.setSetting('charging_control_enabled', enabled ? 'true' : 'false');
    if (!enabled && this.currentSessionId) {
      const ts = telemetry.getState();
      this._endSession(ts.batteryPct || 0, 'control_disabled');
    }
    if (!enabled) {
      this.holdTimerStart = null;
      this._setState(STATES.IDLE, 'Charging control disabled');
    } else {
      this._setState(STATES.IDLE, 'Charging control enabled');
    }
    logger.logEvent('command', `Charging control ${enabled ? 'enabled' : 'disabled'}`);
  }

  addSSEClient(res) {
    this.sseClients.push(res);
    if (this._lastTelemetry) {
      const t    = this._lastTelemetry;
      const eddi = myenergi.getState();
      const { tripPriority, tripWithin18hrs } = this._tripContext();
      const payload = {
        type: 'telemetry', ts: Date.now(),
        solar: t.solarW, consumption: t.consumptionW, grid: t.gridW,
        solarExcess: t.solarExcessW, smoothedExcess: t.smoothedExcess,
        targetAmps: t.targetAmps, evWatts: t.evWatts, evAmps: t.chargeAmps,
        batteryPct: t.batteryPct, chargingState: t.chargingState,
        controllerState: this.state, holdRemaining: null, lastUpdated: Date.now(),
        gatewayOk: this._gatewayOk, teslaOk: this._teslaOk, isAtHome: this._isAtHome,
        manualOverride: db.getSetting('manual_charge_enabled') === 'true',
        controlEnabled: db.getSetting('charging_control_enabled') !== 'false',
        eddiDivertW: eddi.divertW,
        eddiStatus:  eddi.status,
        eddiOk:      eddi.ok,
        eddiTemp1:   eddi.temp1,
        eddiTemp2:   eddi.temp2,
        tripWithin18hrs,
        tripPriority,
      };
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (_e) {}
    }
  }

  removeSSEClient(res) {
    this.sseClients = this.sseClients.filter((c) => c !== res);
  }

  _emitSSE(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of [...this.sseClients]) {
      try { client.write(data); } catch (_e) { this.removeSSEClient(client); }
    }
  }

  _setState(newState, reason) {
    if (this.state === newState) return;
    const oldState = this.state;
    logger.logEvent('state_change', reason || `${oldState} → ${newState}`, oldState, newState);
    this.state = newState;
  }

  /** Tag every real Tesla Fleet API call for cost tracking. category: 'command'|'data'|'wake' */
  _trackApiCall(category) {
    logger.logEvent('api_cost', category);
  }

  _triggerTeslaTokenRefresh() {
    const REFRESH_COOLDOWN = 5 * 60 * 1000;
    if (Date.now() - this._teslaTokenRefreshAt < REFRESH_COOLDOWN) return;
    this._teslaTokenRefreshAt = Date.now();
    const { checkAndRenewTokens } = require('./services/tokens');
    checkAndRenewTokens()
      .then(() => logger.logEvent('token', 'Tesla access token refreshed successfully'))
      .catch(err => logger.logEvent('api_error', `Tesla token refresh failed: ${err.message}`));
  }

  // Whether we can dispatch a vehicle command right now. In BLE mode command delivery
  // authenticates over the paired Bluetooth key and needs no Fleet OAuth token, so a
  // missing/expired token must not block commands (it still blocks the cloud REST fallback,
  // which is correct - that call genuinely needs the token). In Fleet mode a valid token is
  // required exactly as before, so fleet-mode behaviour is unchanged.
  _canSendCommands(token) {
    return useBleCommands() ? true : !!token;
  }

  _getTeslaToken() {
    const row = db.getToken('tesla');
    if (!row) return null;
    let parsed;
    try { parsed = JSON.parse(decrypt(row.token_data)); } catch (_e) { return null; }
    // expires_at is stored as a separate ms-timestamp column in the tokens table
    const expiresAt = row.expires_at || 0;
    const now = Date.now();
    const isExpired    = expiresAt > 0 && expiresAt < now;
    const expiringSoon = expiresAt > 0 && (expiresAt - now) < 10 * 60 * 1000;
    if (isExpired || expiringSoon) {
      this._triggerTeslaTokenRefresh();
      if (isExpired) {
        logger.logEvent('api_error', 'Tesla access token expired - skipping commands until refresh completes');
        return null;
      }
    }
    return parsed.access_token || null;
  }

  // Poll vehicle state over the local BLE proxy (tesla_state_source === 'ble'). Feeds the same
  // telemetry.updateFromApi() the cloud REST fallback uses, so the rest of the controller is
  // unchanged. Uses body_controller_state (cheap, never wakes the car) for reachability + sleep,
  // and only reads charge_state when the car is present and awake. Nothing here can wake the car;
  // waking to start a charge is handled by the normal wake path in the run functions.
  async _blePollState(vin) {
    if (!vin) return;
    const SLEEP_CHECK_INTERVAL = 20 * 1000;
    const DATA_POLL_INTERVAL   = 30 * 1000; // matches the proxy's ~30s vehicle_data cache

    if (Date.now() - this._lastBleSleepCheckAt >= SLEEP_CHECK_INTERVAL) {
      this._lastBleSleepCheckAt = Date.now();
      try {
        const body = await getBodyStateBle(vin);
        this._bleReachable = true;          // got a reply → car is in Bluetooth range (at home)
        this._carSleeping  = body.asleep;
      } catch (_e) {
        // No reply: car is out of range (away) or the proxy is down. Treat as away - control is
        // suspended by _checkAtHome() until it comes back. Not logged as an error; it is expected
        // whenever the car isn't home.
        this._bleReachable = false;
        this._teslaOk = false;
        return;
      }
    }

    if (!this._bleReachable || this._carSleeping) return;      // away or asleep: don't read data
    if (Date.now() - this._lastBlePollAt < DATA_POLL_INTERVAL) return;
    this._lastBlePollAt = Date.now();
    try {
      const d = await getVehicleDataBle(vin);
      telemetry.updateFromApi({
        chargingState:  d.chargingState,
        batteryPct:     d.batteryPct,
        chargeLimit:    d.chargeLimit,
        chargeAmps:     d.chargeAmps,
        chargerPowerKw: d.chargerPowerKw,
        isOnline:       true,
      });
      this._teslaOk = true;
      this._vehicleCloudState = 'online';
    } catch (err) {
      logger.logEvent('api_error', `BLE vehicle_data poll failed: ${err.message}`);
    }
  }

  _checkAtHome() {
    // In BLE state-source mode there is no GPS feed, but Bluetooth only reaches a few metres,
    // so a car the proxy can talk to is a car parked at home. Reachable = home; unreachable
    // (out of range or proxy down) = away, and control is suspended exactly as a GPS geofence would.
    if ((db.getSetting('tesla_state_source') || 'telemetry') === 'ble') {
      return this._bleReachable;
    }

    const homeLat = parseFloat(db.getSetting('home_latitude') || '');
    const homeLon = parseFloat(db.getSetting('home_longitude') || '');
    if (isNaN(homeLat) || isNaN(homeLon)) return true; // No geofence configured
    const radius = parseFloat(db.getSetting('home_radius_km') || '0.5');

    // No GPS fix yet - assume at home so we don't miss solar while car sleeps at home
    if (!this._lastLatLng) return true;

    // Trust the last known position regardless of age:
    // a sleeping car doesn't send GPS but is almost certainly still where it last was
    return haversineKm(homeLat, homeLon, this._lastLatLng.lat, this._lastLatLng.lon) <= radius;
  }

  _timeInWindow(w) {
    const now = new Date();
    const day = now.getDay();
    if (!w.days?.includes(day)) return false;
    const cur = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = w.start.split(':').map(Number);
    const [eh, em] = w.end.split(':').map(Number);
    const s = sh * 60 + sm, e = eh * 60 + em;
    return s > e ? (cur >= s || cur < e) : (cur >= s && cur < e);
  }

  _inScheduleWindow() {
    if (db.getSetting('schedule_enabled') !== 'true') return false;
    try {
      const windows = JSON.parse(db.getSetting('schedule_windows') || '[]');
      return windows.some((w) => this._timeInWindow(w));
    } catch (_e) { return false; }
  }

  _checkTouPeak() {
    if (db.getSetting('tou_enabled') !== 'true') return false;
    try {
      const windows = JSON.parse(db.getSetting('tou_windows') || '[]');
      return windows.some((w) => this._timeInWindow(w));
    } catch (_e) { return false; }
  }

  /**
   * Whether a retailer free power window is running right now, per the
   * connected calendar.
   *
   * Kept behind its own try/catch and returning false on any problem: the
   * calendar is an external dependency, and a fetch failure or malformed event
   * must never be able to take the charging loop down with it.
   */
  _inFreePowerWindow() {
    try {
      // Inline require, matching _tripContext() above - there is no top-level
      // calendar import in this file.
      return require('./services/calendar').isFreePowerActive();
    } catch (_e) { return false; }
  }

  /** The active free power window, for logging and the dashboard. */
  _activeFreePowerWindow() {
    try {
      return require('./services/calendar').getActiveFreePowerWindow();
    } catch (_e) { return null; }
  }

  // ── Battery priority arbitration ─────────────────────────────────────────
  // See src/services/battery/README.md for the full design rationale. In
  // short: 'battery_first' (default) is a no-op, since every supported
  // battery already prioritizes charging itself before allowing export on
  // its own firmware. 'ev_first' only has any effect on brands that expose
  // a charge-power control lever (currently just Sungrow) - it commands the
  // battery to stop charging while the EV is plugged in and wants power, so
  // the existing solarExcessW formula picks up the freed solar on the next
  // tick with no change to that formula itself.
  async _applyBatteryPriority(chargeState) {
    try {
      const provider = battery.getActiveProvider();
      if (!provider || !provider.isConfigured()) return;

      // Local Modbus/HTTPS calls - cheap, but no need to poll/write faster
      // than every ~30s, well away from the 5s solar-meter polling cadence.
      const now = Date.now();
      if (this._lastBatteryCheckAt && (now - this._lastBatteryCheckAt) < 30000) return;
      this._lastBatteryCheckAt = now;

      try {
        this._lastBatteryReadings = await provider.fetchReadings();
      } catch (err) {
        logger.logEvent('api_error', `${provider.label} battery fetch failed: ${err.message}`);
        return;
      }

      const priority = db.getSetting('battery_priority') || 'battery_first';
      if (priority !== 'ev_first' || !(provider.capabilities || []).includes('control')) {
        // battery_first, or ev_first selected on a brand with no control
        // lever (Sigenergy/Tesla Powerwall) - nothing to actively do.
        return;
      }

      const wantsPower = !!(chargeState && EV_WANTS_POWER.has(chargeState.charging_state));
      const batteryCharging = this._lastBatteryReadings.powerW > 50; // deadband against sensor noise
      const desiredMode = (wantsPower && batteryCharging) ? 'hold_for_ev' : 'normal';

      if (this._batteryModeApplied === desiredMode) return;
      await provider.setMode(desiredMode);
      this._batteryModeApplied = desiredMode;
      logger.logEvent('command', `Battery priority: set ${provider.label} to ${desiredMode}`);
    } catch (err) {
      logger.logEvent('api_error', `Battery priority arbitration failed: ${err.message}`);
    }
  }

  // ── Phase 5 - trip-awareness context (read-only) ────────────────────────────

  /** Soonest trip within 18h and whether it needs charge attention. In-memory, no I/O. */
  _tripContext() {
    let upcomingTrip = null;
    try { upcomingTrip = require('./services/tripPlanner').getNextTripRequirement(); } catch (_e) {}
    return {
      upcomingTrip,
      tripWithin18hrs: !!upcomingTrip,
      tripPriority: !!(upcomingTrip && upcomingTrip.status === 'NEEDS_ATTENTION'),
    };
  }

  /**
   * The minimum solar-surplus (in watts) required before we divert to the car.
   * Normal operation returns the configured min_charge_amps × voltage. The ONLY
   * Phase 5 input to the diversion loop: when a trip within 18h still needs charge,
   * lower the threshold slightly so we capture more solar while it's available
   * (still solar-only - we never reach to the grid here).
   */
  _getDiversionThreshold(tripPriority) {
    const minAmps = parseInt(db.getSetting('min_charge_amps') || '5',   10);
    const voltage = parseInt(db.getSetting('charger_voltage') || '240', 10);
    const baseThresholdW = minAmps * voltage;
    if (tripPriority) return Math.max(baseThresholdW * 0.7, 400);
    return baseThresholdW;
  }

  /** Map current controller state + context to a diversion_reason label for the log. */
  _diversionReason({ tripPriority, solarExcessW, targetAmps }) {
    switch (this.state) {
      case STATES.OVERRIDE:   return 'override';
      case STATES.HOLDING:    return 'hold_timer';
      case STATES.CHARGING:   return 'solar_diversion_active';
      default:
        if (solarExcessW > 0 && targetAmps === 0) {
          return tripPriority ? 'trip_priority_mode' : 'below_threshold';
        }
        return 'no_surplus';
    }
  }

  /**
   * Charge at full rate from the grid, ignoring solar, for the duration of a
   * window. Shared by ordinary scheduled charging and retailer free power
   * windows - `freePower` only changes how it is labelled, never what it does,
   * so there is one force-charge implementation rather than two that can drift.
   */
  async _runScheduled({ chargeState, readings, vin, teslaToken, freePower }) {
    const label = freePower ? 'Free power' : 'Schedule';
    if (this.state !== STATES.SCHEDULED) {
      const win = freePower ? this._activeFreePowerWindow() : null;
      this._setState(STATES.SCHEDULED, freePower
        ? `Free power window active${win && win.summary ? ` (${win.summary})` : ''}`
        : 'Scheduled charging window active');
    }

    const maxAmps       = parseInt(db.getSetting('max_charge_amps') || '32', 10);
    const chargingState = chargeState ? chargeState.charging_state   : null;
    const chargeAmps    = chargeState ? (chargeState.charge_amps     || 0)  : 0;
    const batteryPct    = chargeState ? chargeState.battery_level    : 0;
    const chargeLimit   = chargeState ? chargeState.charge_limit_soc : 80;
    const chargerPower  = chargeState ? (chargeState.charger_power   || 0)  : 0;
    const pluggedIn     = PLUGGED_IN.has(chargingState);
    const solarExcessW  = readings ? readings.solarW - readings.consumptionW : 0;

    // Same rule as the solar path in _stateMachine(): never treat an
    // unconfirmed charge limit as a reason to stop. Without this, a stale limit
    // returns early here and scheduled charging silently never starts - the
    // scheduled window looks like it simply did nothing.
    const limitConfirmed = telemetry.getChargeLimitAge() !== Infinity;
    if (!pluggedIn || (limitConfirmed && batteryPct > 0 && batteryPct >= chargeLimit)) {
      if (this.currentSessionId) this._endSession(batteryPct, !pluggedIn ? 'disconnected' : 'charge_complete');
      this._emitTelemetry(readings, chargeState, 0, 0, solarExcessW, 0);
      return;
    }

    if (vin && this._canSendCommands(teslaToken)) {
      try {
        if (!chargeState) {
          const canWake = !this.lastWakeAttempt || (Date.now() - this.lastWakeAttempt > 3 * 60 * 1000);
          if (canWake) {
            this.lastWakeAttempt = Date.now();
            this._trackApiCall('wake'); await wakeVehicle(vin, teslaToken);
            logger.logEvent('command', `${label}: waking vehicle`);
          }
        } else if (chargingState === 'Stopped' || chargingState === 'NoPower') {
          if (!this.currentSessionId) this._startSession(batteryPct);
          this._trackApiCall('command'); await setChargingAmps(vin, maxAmps, teslaToken);
          this._trackApiCall('command'); await startCharging(vin, teslaToken);
          logger.logEvent('command', `${label}: started charging at ${maxAmps}A`);
        } else if (chargingState === 'Charging') {
          if (!this.currentSessionId) this._startSession(batteryPct);
          if (chargeAmps !== maxAmps) {
            this._trackApiCall('command'); await setChargingAmps(vin, maxAmps, teslaToken);
            logger.logEvent('command', `${label}: set amps to ${maxAmps}A`);
          }
        }
      } catch (err) {
        logger.logEvent('api_error', `${label} command failed: ${err.message}`);
      }
    }

    const evWatts = chargingState === 'Charging' ? chargerPower * 1000 : 0;

    if (readings) {
      db.logTelemetry({
        recorded_at: Date.now(),
        solar_w: readings.solarW, consumption_w: readings.consumptionW, grid_w: readings.gridW,
        solar_excess_w: solarExcessW, ev_w: evWatts, eddi_w: myenergi.getState().divertW || 0, charge_amps: chargeAmps,
        battery_pct: batteryPct, controller_state: this.state, session_id: this.currentSessionId,
        trip_within_18hrs: this._tripContext().tripWithin18hrs,
        // Distinct reason so the Data page and logs can tell free-power grid
        // import apart from ordinary scheduled import - they cost very
        // different amounts and conflating them would misreport both.
        diversion_reason: freePower ? 'free_power' : 'scheduled_charging',
      });
      this._lastTelemetry = {
        solarW: readings.solarW, consumptionW: readings.consumptionW, gridW: readings.gridW,
        solarExcessW, smoothedExcess: solarExcessW, targetAmps: maxAmps,
        evWatts, chargeAmps, batteryPct, chargingState,
      };
      if (this.currentSessionId && chargingState === 'Charging') {
        if (chargeAmps > this.sessionPeakAmps) this.sessionPeakAmps = chargeAmps;
        this.sessionAmpsReadings.push(chargeAmps);
      }
    }

    this._emitTelemetry(readings, chargeState, solarExcessW, maxAmps, solarExcessW, evWatts);
  }

  // ── Departure charging ──────────────────────────────────────────────────────
  // Grid top-up to reach a target SOC before a departure time.
  // Mirrors _runScheduled but auto-clears once the target is met.
  async _runDeparture({ departure, chargeState, readings, vin, teslaToken, maxAmps, solarExcessW, evWatts }) {
    if (this.state !== STATES.DEPARTURE) this._setState(STATES.DEPARTURE, `Charging for departure at ${new Date(departure.departureTime).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}`);

    const chargingState = chargeState ? chargeState.charging_state   : null;
    const chargeAmps    = chargeState ? (chargeState.charge_amps     || 0)  : 0;
    const batteryPct    = chargeState ? chargeState.battery_level    : 0;
    const chargeLimit   = chargeState ? chargeState.charge_limit_soc : 80;
    const chargerPower  = chargeState ? (chargeState.charger_power   || 0)  : 0;
    const pluggedIn     = PLUGGED_IN.has(chargingState);

    if (!pluggedIn || (batteryPct > 0 && batteryPct >= departure.targetSoc)) {
      if (this.currentSessionId) this._endSession(batteryPct, !pluggedIn ? 'disconnected' : 'charge_complete');
      if (batteryPct >= departure.targetSoc) {
        departureScheduler.clearDeparture();
        logger.logEvent('info', `Departure target ${departure.targetSoc}% reached - clearing schedule`);
      }
      this._setState(STATES.IDLE, !pluggedIn ? 'Vehicle disconnected' : 'Departure SOC target reached');
      this._emitTelemetry(readings, chargeState, solarExcessW || 0, 0, solarExcessW || 0, 0);
      return;
    }

    if (vin && this._canSendCommands(teslaToken)) {
      try {
        if (!chargeState) {
          const canWake = !this.lastWakeAttempt || (Date.now() - this.lastWakeAttempt > 3 * 60 * 1000);
          if (canWake) {
            this.lastWakeAttempt = Date.now();
            this._trackApiCall('wake'); await wakeVehicle(vin, teslaToken);
            logger.logEvent('command', 'Departure: waking vehicle');
          }
        } else if (chargingState === 'Stopped' || chargingState === 'NoPower') {
          if (!this.currentSessionId) this._startSession(batteryPct);
          this._trackApiCall('command'); await setChargingAmps(vin, maxAmps, teslaToken);
          this._trackApiCall('command'); await startCharging(vin, teslaToken);
          logger.logEvent('command', `Departure: started charging at ${maxAmps}A (target ${departure.targetSoc}%, ${departure.hoursUntil}h until departure)`);
        } else if (chargingState === 'Charging') {
          if (!this.currentSessionId) this._startSession(batteryPct);
          if (chargeAmps !== maxAmps) {
            this._trackApiCall('command'); await setChargingAmps(vin, maxAmps, teslaToken);
            logger.logEvent('command', `Departure: set amps to ${maxAmps}A`);
          }
        }
      } catch (err) {
        logger.logEvent('api_error', `Departure command failed: ${err.message}`);
        // chargeState can be stale from before sleep. If we get "offline or asleep",
        // the cached state tricked us into skipping the outer wake path - wake now.
        if (err.message.includes('offline or asleep') || err.message.includes('vehicle unavailable')) {
          const canWake = !this.lastWakeAttempt || (Date.now() - this.lastWakeAttempt > 3 * 60 * 1000);
          if (canWake) {
            this.lastWakeAttempt = Date.now();
            this._carSleeping = false;
            try {
              this._trackApiCall('wake');
              await wakeVehicle(vin, teslaToken);
              logger.logEvent('command', 'Departure: waking car - chargeState was stale from before sleep');
            } catch (wakeErr) {
              logger.logEvent('api_error', `Departure wake-on-failure: ${wakeErr.message}`);
            }
          }
        }
      }
    }

    const actualEvWatts = chargingState === 'Charging' ? chargerPower * 1000 : 0;

    if (readings) {
      db.logTelemetry({
        recorded_at: Date.now(),
        solar_w: readings.solarW, consumption_w: readings.consumptionW, grid_w: readings.gridW,
        solar_excess_w: solarExcessW, ev_w: actualEvWatts,
        eddi_w: myenergi.getState().divertW || 0,
        charge_amps: chargeAmps, battery_pct: batteryPct,
        controller_state: this.state, session_id: this.currentSessionId,
        trip_within_18hrs: this._tripContext().tripWithin18hrs,
        diversion_reason: 'departure_charging',
      });
      this._lastTelemetry = {
        solarW: readings.solarW, consumptionW: readings.consumptionW, gridW: readings.gridW,
        solarExcessW, smoothedExcess: solarExcessW, targetAmps: maxAmps,
        evWatts: actualEvWatts, chargeAmps, batteryPct, chargingState,
      };
      if (this.currentSessionId && chargingState === 'Charging') {
        if (chargeAmps > this.sessionPeakAmps) this.sessionPeakAmps = chargeAmps;
        this.sessionAmpsReadings.push(chargeAmps);
      }
    }

    this._emitTelemetry(readings, chargeState, solarExcessW || 0, maxAmps, solarExcessW || 0, actualEvWatts);
  }

  async _safeStop(vin, token, reason) {
    try {
      this._trackApiCall('command');
      await stopCharging(vin, token);
      logger.logEvent('command', reason);
    } catch (err) {
      logger.logEvent('api_error', `Stop charging failed: ${err.message}`);
    }
  }

  async _loop() {
    try {
      const provider = meters.getActiveProvider();
      const vin = db.getSetting('tesla_vin');
      if (!provider || !provider.isConfigured() || !vin) return;

      const teslaToken = this._getTeslaToken();

      // --- Meter readings (Enphase / Fronius / SolarEdge / ... - see services/meters) ---
      let readings = null;
      try {
        readings = await provider.fetchReadings();
        this._gatewayOk = true;
        this._lastGatewaySuccessAt = Date.now();

        // ── Track daily solar production baseline using the meter's lifetime accumulator,
        // when the active provider exposes one (not all brands do - see meters/README.md).
        // Setting keys keep their historical "enphase_" prefix even for other providers -
        // this is just "today's production baseline" bookkeeping, renaming would silently
        // reset every existing install's daily-total history for no functional benefit.
        // The IQ Gateway's /api/v1/production wattHoursToday is broken on some firmware.
        // Instead: at midnight, store the current actEnergyDlvd as the day's baseline.
        // Today's production = current − baseline. Accurate regardless of app uptime gaps.
        if (readings.solarActEnergyDlvdWh != null) {
          const todayStr = new Date().toLocaleDateString('en-AU');
          const storedDay = db.getSetting('enphase_energy_baseline_date') || '';
          if (storedDay !== todayStr) {
            // Day rolled over - set new baseline for today
            db.setSetting('enphase_energy_baseline_wh',   String(readings.solarActEnergyDlvdWh));
            db.setSetting('enphase_energy_baseline_date', todayStr);
          }
          db.setSetting('enphase_energy_current_wh', String(readings.solarActEnergyDlvdWh));
        }
      } catch (err) {
        this._gatewayOk = false;
        const handled = provider.handleFetchError(err);
        if (!handled) {
          logger.logEvent('api_error', `${provider.label} fetch failed: ${err.message}`);
        }
        if (this._lastTelemetry) {
          readings = {
            solarW: this._lastTelemetry.solarW,
            consumptionW: this._lastTelemetry.consumptionW,
            gridW: this._lastTelemetry.gridW,
          };
        }
      }

      if (!readings) {
        this._emitSSE({ type: 'error', ts: Date.now(), message: 'No gateway data' });
        return;
      }

      // --- Vehicle state from Fleet Telemetry ---
      const ts = telemetry.getState();
      this._teslaOk = !telemetry.isStale();
      if (ts.isOnline) this._vehicleCloudState = 'online';
      else if (ts.lastUpdated) this._vehicleCloudState = 'offline';

      // --- REST API fallback when telemetry is stale or charging state is unknown ---
      // Also runs when chargingState is null: fleet telemetry only sends DetailedChargeState
      // on change, so after a server restart the field never arrives if the car is already
      // charging. Soc updates keep telemetry "fresh" so isStale() stays false - we need
      // a separate check to fill in the missing charging state via the REST API.
      // When to run a REST fallback:
      //   1. telemetry.isStale() - ZMQ has gone quiet 5+ min (Fleet Telemetry restart etc.)
      //   2. chargingState === null - server just restarted and car hasn't pushed DetailedChargeState yet
      //
      // Once REST confirms the car is asleep, stop polling entirely (_carSleeping = true).
      // Fleet Telemetry fires a ZMQ connectivity event the moment the car wakes - that resets
      // _carSleeping so we're ready to act immediately. No need to ask the REST API every N minutes.
      // Vehicle state comes either from Fleet Telemetry + a cloud REST fallback (default), or
      // entirely from the local BLE proxy (tesla_state_source === 'ble') for a cloud-free setup.
      // The BLE poller feeds the same telemetry.updateFromApi() the REST fallback does, so all
      // downstream decision logic below is identical regardless of source.
      const stateSource = db.getSetting('tesla_state_source') || 'telemetry';
      if (stateSource === 'ble') await this._blePollState(vin);

      if (stateSource !== 'ble' && !telemetry.isStale()) this._carSleeping = false; // ZMQ came back → car awake

      const FALLBACK_INTERVAL = 2 * 60 * 1000;

      // Re-confirm the charge limit from Tesla itself at least this often.
      //
      // Fleet Telemetry only pushes ChargeLimitSoc when it CHANGES, so a value
      // that is wrong stays wrong indefinitely - and because vehicle state is
      // persisted, it survives restarts too. Since the controller stops
      // charging the moment battery >= chargeLimit, a stale low value silently
      // caps the car below what the owner actually set. Nothing else in this
      // loop would ever catch that, so the limit gets its own freshness rule
      // rather than relying on telemetry being stale for the REST path to run.
      const CHARGE_LIMIT_MAX_AGE = 60 * 60 * 1000;

      // Gated on when we last ASKED, not only on how old the answer is. If
      // Tesla returns vehicle data without charge_limit_soc, the age never
      // resets, and keying off age alone would re-poll every FALLBACK_INTERVAL
      // indefinitely - turning a once-an-hour check into ~720 data calls a day
      // against the Fleet API. Asking once an hour and accepting that the
      // answer may not come is the correct behaviour; the controller already
      // refuses to act on an unconfirmed limit, so a missing answer is safe.
      const chargeLimitStale =
        telemetry.getChargeLimitAge() > CHARGE_LIMIT_MAX_AGE &&
        (Date.now() - this._lastChargeLimitCheckAt) > CHARGE_LIMIT_MAX_AGE;

      const needsFallback = stateSource !== 'ble' && !this._carSleeping &&
        (telemetry.isStale() || ts.chargingState === null || this._forceBootReconcile
         || chargeLimitStale);
      if (needsFallback && teslaToken && (Date.now() - this._lastFallbackAt) > FALLBACK_INTERVAL) {
        this._lastFallbackAt = Date.now();
        // Record the attempt up front. Doing it here rather than after a
        // successful parse means a failed call, an offline car, or a response
        // missing charge_limit_soc all still count as "asked", so none of them
        // can turn into a retry loop against the Fleet API.
        if (chargeLimitStale) this._lastChargeLimitCheckAt = Date.now();
        try {
          this._trackApiCall('data');
          const cloudState = await getVehicleState(vin, teslaToken);
          this._vehicleCloudState = cloudState || 'offline';
          logger.logEvent('info', `REST fallback: car is ${this._vehicleCloudState}`);
          if (cloudState === 'online') {
            this._trackApiCall('data');
            const { chargeState: apiCharge, driveState } = await getVehicleData(vin, teslaToken);

            // When this poll happened ONLY to re-confirm the charge limit -
            // i.e. Fleet Telemetry is otherwise healthy - take the limit and
            // nothing else. REST vehicle_data can be minutes behind the live
            // telemetry stream, so injecting the whole snapshot would make the
            // battery percentage and charging state jump backwards once an
            // hour, and could feed one stale control decision into the state
            // machine. The limit is the one field telemetry cannot refresh on
            // its own, which is the entire reason for this poll.
            const limitRefreshOnly = chargeLimitStale && !this._forceBootReconcile
              && !telemetry.isStale() && ts.chargingState !== null;

            // Only accept the limit when the snapshot can carry a real one. An
            // unplugged car reports the floor (50) instead of the owner's limit,
            // and caching that is what used to strand the app at 50%.
            const limitOk = isChargeLimitTrustworthy(apiCharge);
            const apiLimit = limitOk ? apiCharge.charge_limit_soc : undefined;

            telemetry.updateFromApi(limitRefreshOnly ? {
              chargeLimit:    apiLimit,
            } : {
              chargingState:  apiCharge?.charging_state  ?? undefined,
              batteryPct:     apiCharge?.battery_level   ?? undefined,
              chargeLimit:    apiLimit,
              chargeAmps:     apiCharge?.charge_amps     ?? undefined,
              chargerPowerKw: apiCharge?.charger_power   ?? undefined,
              latitude:       driveState?.latitude       ?? undefined,
              longitude:      driveState?.longitude      ?? undefined,
              isOnline:       true,
            });
            if (driveState?.latitude != null) {
              logger.logEvent('info', `REST fallback: got location ${driveState.latitude},${driveState.longitude}`);
            }
            this._teslaOk = true;
            if (!limitOk && apiCharge) {
              // Say so explicitly. Silently skipping the field would leave the
              // dashboard showing a limit with no hint that Tesla just handed
              // back a placeholder, which is what made this hard to pin down.
              logger.logEvent('info',
                `Ignored charge_limit_soc=${apiCharge.charge_limit_soc}% from Tesla: car is `
                + `${apiCharge.charging_state || 'unplugged'} and the value matches `
                + `charge_limit_soc_min (real limit is likely ${apiCharge.charge_limit_soc_std}%). `
                + `Keeping the last confirmed limit.`);
              if (this._forceBootReconcile) this._forceBootReconcile = false;
            } else if (this._forceBootReconcile) {
              logger.logEvent('info', `Boot reconciliation: charge_limit_soc confirmed at ${apiCharge?.charge_limit_soc}%`);
              this._forceBootReconcile = false;
            } else if (chargeLimitStale && apiCharge?.charge_limit_soc != null) {
              // Logged so a limit that changes underneath us is visible in
              // history rather than silently altering charging behaviour.
              logger.logEvent('info',
                `Charge limit re-confirmed from Tesla: ${apiCharge.charge_limit_soc}%`);
            }
          } else {
            // Car confirmed asleep - ZMQ will wake us when it comes online, no need to poll
            // again until then. _forceBootReconcile deliberately stays true - _carSleeping
            // resets to false on the wake connectivity event, so this same check fires again
            // and reconciles as soon as the car is actually reachable, rather than giving up.
            this._carSleeping = true;
          }
        } catch (err) {
          logger.logEvent('api_error', `REST fallback poll failed: ${err.message}`);
          if (err.message && err.message.includes('401')) this._triggerTeslaTokenRefresh();
        }
      }

      // Re-read after potential fallback update
      const ts2 = telemetry.getState();

      let chargeState = null;
      if (ts2.chargingState !== null) {
        chargeState = {
          charging_state:   ts2.chargingState,
          battery_level:    ts2.batteryPct,
          charge_limit_soc: ts2.chargeLimit,
          charge_amps:      ts2.chargeAmps,
          charger_power:    ts2.chargerPowerKw,
        };
        this._lastChargeState = chargeState;
      }
      if (ts2.latitude != null) {
        this._lastLatLng = { lat: ts2.latitude, lon: ts2.longitude };
        db.setSetting('last_car_latitude',  String(ts2.latitude));
        db.setSetting('last_car_longitude', String(ts2.longitude));
      }

      // --- Battery priority arbitration (Sigenergy / Sungrow / Tesla Powerwall) ---
      this._applyBatteryPriority(chargeState).catch(() => {});

      // --- Geofencing ---
      this._isAtHome = this._checkAtHome();

      // --- Tesla command throttle ---
      // Enphase is polled every tick (5s). Tesla commands only run every other tick (10s)
      // to halve API cost without affecting solar responsiveness.
      this._teslaCommandTick++;
      if (this._teslaCommandTick % 2 !== 0) {
        const solarExcessW = readings.solarW - readings.consumptionW;
        const lastT = this._lastTelemetry;
        this._emitTelemetry(readings, chargeState || this._lastChargeState,
          lastT ? lastT.smoothedExcess : 0, lastT ? lastT.targetAmps : 0,
          solarExcessW, lastT ? lastT.evWatts : 0);
        return;
      }

      // --- OVERRIDE (CHARGE NOW) mode - runs regardless of control toggle ---
      const isOverride = this.state === STATES.OVERRIDE || db.getSetting('manual_charge_enabled') === 'true';
      if (isOverride) {
        await this._runOverride({ chargeState, readings, vin, teslaToken });
        return;
      }

      // --- Schedule / TOU / free power ---
      this._scheduleActive  = this._inScheduleWindow();
      this._touPeakActive   = this._checkTouPeak();
      // A retailer free power window behaves exactly like a scheduled window -
      // charge from the grid at full rate, ignore solar - so it reuses that
      // path rather than introducing a second way to force charging. The one
      // difference is that it overrides a TOU peak: a peak-rate window is a
      // reason not to import, and during free power the import costs nothing.
      this._freePowerActive = this._inFreePowerWindow();

      const forceChargeActive = this._scheduleActive || this._freePowerActive;

      // If we were force-charging and the window just ended, reset
      if (!forceChargeActive && this.state === STATES.SCHEDULED) {
        if (this.currentSessionId) this._endSession(ts2.batteryPct || 0, 'schedule_ended');
        this._setState(STATES.IDLE, 'Schedule window ended');
      }

      // Run forced charging if in a window and the user hasn't explicitly stopped.
      // TOU peak still blocks an ordinary scheduled window, but not free power.
      if (forceChargeActive && (this._freePowerActive || !this._touPeakActive)
          && this.state !== STATES.STOPPED) {
        await this._runScheduled({
          chargeState, readings, vin, teslaToken,
          freePower: this._freePowerActive,
        });
        return;
      }

      // --- Charging Control toggle ---
      const controlEnabled = db.getSetting('charging_control_enabled') !== 'false';
      if (!controlEnabled) {
        const solarExcessW = readings.solarW - readings.consumptionW;
        // Grid/solar/house telemetry is whole-house metering, independent of charging
        // control - must keep recording here even though EV control is paused, or the
        // dashboard/history silently loses coverage for as long as control stays off.
        db.logTelemetry({
          recorded_at: Date.now(),
          solar_w: readings.solarW, consumption_w: readings.consumptionW, grid_w: readings.gridW,
          solar_excess_w: solarExcessW, ev_w: 0, eddi_w: myenergi.getState().divertW || 0, charge_amps: 0,
          battery_pct: chargeState ? chargeState.battery_level : null,
          controller_state: this.state, session_id: this.currentSessionId,
          diversion_reason: 'control_disabled',
        });
        this._emitTelemetry(readings, chargeState, 0, 0, solarExcessW, 0);
        return;
      }

      // --- Car away from home ---
      if (!this._isAtHome) {
        if (![STATES.IDLE, STATES.STOPPED].includes(this.state)) {
          if (this.currentSessionId) this._endSession(chargeState?.battery_level || 0, 'left_home');
          this._setState(STATES.IDLE, 'Car away from home - control suspended');
        }
        const solarExcessW = readings.solarW - readings.consumptionW;
        // Same reasoning as the control-disabled branch above: whole-house grid/solar
        // readings must keep recording regardless of where the car physically is, or
        // WattSnatch silently stops tracking real grid import/export (e.g. hot water
        // boost) for however long the car is away - confirmed root cause of a ~2x
        // undercount vs. the gateway's own totals.
        db.logTelemetry({
          recorded_at: Date.now(),
          solar_w: readings.solarW, consumption_w: readings.consumptionW, grid_w: readings.gridW,
          solar_excess_w: solarExcessW, ev_w: 0, eddi_w: myenergi.getState().divertW || 0, charge_amps: 0,
          battery_pct: chargeState ? chargeState.battery_level : null,
          controller_state: this.state, session_id: this.currentSessionId,
          diversion_reason: 'away_from_home',
        });
        this._emitTelemetry(readings, chargeState, 0, 0, solarExcessW, 0);
        return;
      }

      // --- Settings ---
      const minAmps       = parseInt(db.getSetting('min_charge_amps')         || '5',   10);
      const maxAmps       = parseInt(db.getSetting('max_charge_amps')          || '32',  10);
      const holdMinutes   = parseInt(db.getSetting('hold_minutes')             || '3',   10);
      const smoothWin     = parseInt(db.getSetting('smoothing_window')         || '3',   10);
      const chargerVoltage= parseInt(db.getSetting('charger_voltage')          || '240', 10);

      // Phase 5 - trip-aware threshold. The only new input to the diversion loop:
      // an imminent trip that still needs charge lowers the minimum surplus we act on.
      const { tripPriority, tripWithin18hrs } = this._tripContext();
      const thresholdW    = this._getDiversionThreshold(tripPriority);
      const effectiveMinAmps = Math.max(1, Math.floor(thresholdW / chargerVoltage));

      // --- Vehicle state ---
      const chargingState  = chargeState ? chargeState.charging_state  : null;
      const batteryPct     = chargeState ? chargeState.battery_level   : 0;
      const chargeLimit    = chargeState ? chargeState.charge_limit_soc : 80;
      const chargerPower   = chargeState ? (chargeState.charger_power  || 0) : 0;
      const chargeAmps     = chargeState ? (chargeState.charge_amps    || 0) : 0;
      const pluggedIn      = PLUGGED_IN.has(chargingState);
      const currentlyCharging = chargingState === 'Charging';

      // --- Solar target ---
      // Use amps × voltage (not Tesla's ACChargingPower) - ChargeAmps updates every 1s
      // and is more reliable than ACChargingPower which lags by up to 5s and can
      // underestimate due to power factor, causing the target to floor at current amps.
      const GATEWAY_STALE_LIMIT_MS = 2 * 60 * 1000; // 2 min grace period for brief outages
      const gatewayDataExpired = !this._gatewayOk &&
        (Date.now() - this._lastGatewaySuccessAt) > GATEWAY_STALE_LIMIT_MS;
      if (gatewayDataExpired && this.state === STATES.CHARGING) {
        logger.logEvent('api_error', 'Gateway offline >2 min - treating solar as zero to trigger hold timer');
      }
      const chargerWatts = currentlyCharging ? chargeAmps * chargerVoltage : 0;
      const rawExcess = gatewayDataExpired
        ? 0
        : readings.solarW - readings.consumptionW + chargerWatts;
      this.smoothingBuffer.push(rawExcess);
      if (this.smoothingBuffer.length > smoothWin) this.smoothingBuffer.shift();
      const smoothedExcess = this.smoothingBuffer.reduce((a, b) => a + b, 0) / this.smoothingBuffer.length;
      let targetAmps = Math.floor(smoothedExcess / chargerVoltage);
      targetAmps = Math.max(0, Math.min(maxAmps, targetAmps));
      if (targetAmps < effectiveMinAmps) targetAmps = 0;

      const solarExcessW = readings.solarW - readings.consumptionW;
      const evWatts = currentlyCharging ? chargerPower * 1000 : 0;

      // --- Departure scheduler ---------------------------------------------
      // Fires within ACTIVATION_HOURS of departure when SOC is still below target.
      // Solar-first: if the normal solar loop can get us there in time, this won't
      // activate (because missingPct would be 0 by the time we need it).
      const departureDecision = departureScheduler.getDepartureDecision(batteryPct, maxAmps);
      if (departureDecision.active && departureDecision.needsGridCharge && pluggedIn) {
        await this._runDeparture({
          departure:   departureDecision,
          chargeState, readings, vin, teslaToken,
          maxAmps,     solarExcessW, evWatts,
        });
        return;
      }
      // Car may be sleeping but departure charging is needed - force a wake attempt so
      // the next tick can confirm plugged-in and start charging.
      if (departureDecision.active && departureDecision.needsGridCharge && !pluggedIn && !chargeState && vin && teslaToken) {
        const canWake = !this.lastWakeAttempt || (Date.now() - this.lastWakeAttempt > 3 * 60 * 1000);
        if (canWake) {
          this.lastWakeAttempt = Date.now();
          this._carSleeping = false; // force fallback to re-poll on next tick
          try {
            this._trackApiCall('wake');
            await wakeVehicle(vin, teslaToken);
            logger.logEvent('command', `Departure: waking sleeping vehicle (${departureDecision.hoursUntil}h until departure)`);
          } catch (err) {
            logger.logEvent('api_error', `Departure wake attempt failed: ${err.message}`);
          }
        }
      }
      // If DEPARTURE state but scheduler cleared (target reached / time passed), reset to IDLE
      if (this.state === STATES.DEPARTURE && !departureDecision.active) {
        this._setState(STATES.IDLE, 'Departure schedule cleared');
      }

      // Run state machine
      await this._stateMachine({
        targetAmps, smoothedExcess, chargingState, pluggedIn, batteryPct,
        chargeLimit, chargeAmps, chargerPower, holdMinutes, minAmps: effectiveMinAmps, maxAmps,
        vin, teslaToken,
        hasPriorCarData: this._lastChargeState !== null,
      });

      db.logTelemetry({
        recorded_at: Date.now(),
        solar_w: readings.solarW, consumption_w: readings.consumptionW,
        grid_w: readings.gridW, solar_excess_w: solarExcessW,
        ev_w: evWatts, eddi_w: myenergi.getState().divertW || 0, charge_amps: chargeAmps, battery_pct: chargeState ? batteryPct : null,
        controller_state: this.state, session_id: this.currentSessionId,
        trip_within_18hrs: tripWithin18hrs,
        diversion_reason: this._diversionReason({ tripPriority, solarExcessW, targetAmps }),
      });

      this._lastTelemetry = {
        solarW: readings.solarW, consumptionW: readings.consumptionW, gridW: readings.gridW,
        solarExcessW, smoothedExcess, targetAmps, evWatts, chargeAmps, chargingState,
        batteryPct: chargeState ? batteryPct : (this._lastChargeState?.battery_level || 0),
      };

      if (this.currentSessionId && currentlyCharging) {
        if (chargeAmps > this.sessionPeakAmps) this.sessionPeakAmps = chargeAmps;
        this.sessionAmpsReadings.push(chargeAmps);
      }

      // Record load snapshot for baseline learning
      baseline.recordLoadSnapshot(readings).catch(() => {});

      // Daily financial ledger update
      const today = new Date().toISOString().split('T')[0];
      if (this._lastFinancialLedgerUpdateDate !== today) {
        this._updateFinancialLedger().catch((err) => {
          logger.logEvent('api_error', `Financial ledger update failed: ${err.message}`);
        });
        this._lastFinancialLedgerUpdateDate = today;
      }

      // Automatic daily backup (enabled by default; see Settings → Backup & Restore)
      if (db.getSetting('auto_backup_enabled') !== 'false' && !this._autoBackupInProgress) {
        const lastBackupAt = parseInt(db.getSetting('last_auto_backup_at') || '0', 10);
        if (Date.now() - lastBackupAt > 24 * 60 * 60 * 1000) {
          this._autoBackupInProgress = true;
          this._runAutoBackup()
            .catch((err) => {
              // Deliberately does NOT update last_auto_backup_at on failure, so a
              // transient error (e.g. disk full) retries next tick instead of
              // silently going a full day without a backup.
              logger.logEvent('api_error', `Auto-backup failed: ${err.message}`);
            })
            .finally(() => { this._autoBackupInProgress = false; });
        }
      }

      // Live retailer plan rates (AER Consumer Data Right register) - refreshes
      // at most once per day; retailerRates.refreshIfDue() no-ops otherwise.
      if (!this._retailerRatesRefreshInProgress) {
        this._retailerRatesRefreshInProgress = true;
        retailerRates.refreshIfDue()
          .catch((err) => logger.logEvent('api_error', `Retailer live rates refresh failed: ${err.message}`))
          .finally(() => { this._retailerRatesRefreshInProgress = false; });
      }

      this._emitTelemetry(readings, chargeState, smoothedExcess, targetAmps, solarExcessW, evWatts);

      // Check for notifications (anomalies, milestones, etc.)
      notificationMonitor.checkAll().catch(err => {
        console.warn('[controller] Notification check failed:', err.message);
      });
    } catch (err) {
      console.error('[controller] Loop error:', err.message, '\n', err.stack);
      logger.logEvent('api_error', `Controller loop error: ${err.message}`);
    }
  }

  async _updateFinancialLedger() {
    // Update financial ledger for yesterday (since this runs at the start of today)
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const dateStr = yesterday.toISOString().split('T')[0];

    // Check if already updated
    const existing = db.getFinancialLedgerForDate(dateStr);
    if (existing) return;

    // Calculate totals for the day from telemetry_log
    const startOfDay = new Date(yesterday);
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();
    const endMs = startMs + 24 * 60 * 60 * 1000;

    // Per-row rate resolution - a single day can span multiple TOU windows,
    // so import_cost/solar_avoided_cost can't be a single flat-rate multiply.
    const resolveRate = db.createRateResolver();
    const resolveExportRate = db.createExportRateResolver();
    const supplyCfg = db.getTariffAtDate('supply_charge', startMs);

    // Query telemetry for the day
    const rows = db.getDb().prepare(`
      SELECT
        recorded_at, solar_w, consumption_w, grid_w, ev_w,
        COALESCE(eddi_w, 0) as eddi_w,
        MIN(
          COALESCE(LEAD(recorded_at) OVER (ORDER BY recorded_at) - recorded_at, 30000),
          120000
        ) / 3600000.0 AS interval_h
      FROM telemetry_log
      WHERE recorded_at >= ? AND recorded_at < ?
      ORDER BY recorded_at
    `).all(startMs, endMs);

    let kwh_imported = 0, kwh_exported = 0, kwh_solar_self_consumed = 0, kwh_solar_to_tesla = 0, kwh_solar_to_hotwater = 0, kwh_solar_to_house = 0;
    let import_cost = 0, solar_avoided_cost = 0, export_credit = 0;

    for (const row of rows) {
      const interval_h = row.interval_h || 0;
      const solar_w = Math.max(0, row.solar_w || 0);
      const consumption_w = Math.max(0, row.consumption_w || 0);
      const grid_w = row.grid_w || 0;
      const ev_w = Math.max(0, row.ev_w || 0);
      const eddi_w = Math.max(0, row.eddi_w || 0);
      const house_w = Math.max(0, consumption_w - ev_w - eddi_w);
      const rate = resolveRate(row.recorded_at);

      // Import: when grid_w > 0 (drawing from grid)
      if (grid_w > 0) {
        const importKwh = (grid_w / 1000) * interval_h;
        kwh_imported += importKwh;
        import_cost  += importKwh * rate;
      }
      // Export: when grid_w < 0 (exporting to grid). Per-row export rate
      // resolution mirrors import_cost above - needed since a time-varying
      // export rate (e.g. NEM 3.0) can differ wildly within the same day.
      if (grid_w < 0) {
        const exportKwh = (-grid_w / 1000) * interval_h;
        kwh_exported  += exportKwh;
        export_credit += exportKwh * resolveExportRate(row.recorded_at);
      }

      // Solar allocation
      if (solar_w > 0) {
        const solar_kwh = (solar_w / 1000) * interval_h;
        // Allocate solar proportionally to loads
        const total_load = ev_w + eddi_w + house_w;
        if (total_load > 0) {
          kwh_solar_to_tesla += solar_kwh * (ev_w / total_load);
          kwh_solar_to_hotwater += solar_kwh * (eddi_w / total_load);
          kwh_solar_to_house += solar_kwh * (house_w / total_load);
        }
        kwh_solar_self_consumed += solar_kwh;
        solar_avoided_cost      += solar_kwh * rate;
      }
    }

    const supply_charge = supplyCfg;
    const net_cost = import_cost + supply_charge - export_credit;

    db.insertFinancialLedgerEntry({
      date: dateStr,
      kwh_imported: Math.round(kwh_imported * 100) / 100,
      kwh_exported: Math.round(kwh_exported * 100) / 100,
      kwh_solar_self_consumed: Math.round(kwh_solar_self_consumed * 100) / 100,
      kwh_solar_to_tesla: Math.round(kwh_solar_to_tesla * 100) / 100,
      kwh_solar_to_hotwater: Math.round(kwh_solar_to_hotwater * 100) / 100,
      kwh_solar_to_house: Math.round(kwh_solar_to_house * 100) / 100,
      import_cost: Math.round(import_cost * 100) / 100,
      export_credit: Math.round(export_credit * 100) / 100,
      solar_avoided_cost: Math.round(solar_avoided_cost * 100) / 100,
      net_cost: Math.round(net_cost * 100) / 100,
      supply_charge,
    });
  }

  async _runAutoBackup() {
    const backup = require('./services/backup');
    const path = require('path');
    const dest = path.join(backup.AUTO_BACKUP_DIR, backup.backupFilename());
    const { path: written, sizeBytes } = await backup.createBackupZip(dest);

    // Only mark success (and reset the 24h timer) once the zip is actually
    // on disk - see the call site for why this isn't set beforehand.
    db.setSetting('last_auto_backup_at', String(Date.now()));

    const { kept, deleted } = backup.pruneAutoBackups(backup.AUTO_BACKUP_DIR);
    logger.logEvent('info',
      `Auto-backup created: ${path.basename(written)} (${(sizeBytes / 1024 / 1024).toFixed(1)} MB). ` +
      `Retention: ${kept} kept, ${deleted} pruned.`);
  }

  async _stateMachine({ targetAmps, smoothedExcess, chargingState, pluggedIn, batteryPct,
                         chargeLimit, chargeAmps, chargerPower, holdMinutes, minAmps, maxAmps,
                         vin, teslaToken, hasPriorCarData }) {
    const now = Date.now();
    const holdMs = holdMinutes * 60 * 1000;
    const wakeGuardMs = 3 * 60 * 1000;
    const hasSolar = targetAmps >= minAmps;

    // Car disconnected or charge complete → reset to IDLE/WAITING
    // chargingState === null means unknown (car asleep/telemetry gap) - NOT the same as disconnected.
    // Only treat as disconnected when we have a definitive non-plugged-in state.
    const knownDisconnected = chargingState !== null && !pluggedIn;
    // Only act on a charge limit the car has actually confirmed. An
    // unconfirmed limit is either the hardcoded 80 default or a value carried
    // over from the persisted state, and stopping a charge on that guess is
    // how a car whose real limit is 80 ends up capped at 50. The vehicle
    // enforces its own limit natively, so declining to act here cannot
    // overcharge - it only defers to the car until Tesla confirms the number,
    // which the freshness rule above makes happen within a couple of minutes.
    let limitConfirmed = telemetry.getChargeLimitAge() !== Infinity;
    if (!limitConfirmed && !knownDisconnected && batteryPct > 0 && batteryPct >= chargeLimit) {
      logger.logEvent('info',
        `Battery ${batteryPct.toFixed(0)}% is at the unconfirmed charge limit `
        + `(${chargeLimit}%) - deferring to the car until Tesla confirms it`);
    }

    // About to stop charging because we believe the battery has reached the
    // limit? Re-read the limit from Tesla first, unless we only just did.
    //
    // Stopping is the one irreversible-feeling thing a wrong cached limit can
    // do: the car quietly stops well short of where the owner set it, and
    // nothing looks broken. A cached value has been observed disagreeing with
    // what Tesla reports (a cached 50 against Tesla's 80), cause not yet
    // established - so rather than trust the cache at the moment it matters
    // most, confirm it. This costs one API call, only when we are about to
    // stop, and only if the value is older than a couple of minutes.
    if (!knownDisconnected && limitConfirmed && batteryPct > 0 && batteryPct >= chargeLimit
        && vin && teslaToken && telemetry.getChargeLimitAge() > VERIFY_LIMIT_BEFORE_STOP_MS) {
      try {
        this._trackApiCall('data');
        const { chargeState: fresh } = await getVehicleData(vin, teslaToken);
        const freshLimit = fresh?.charge_limit_soc;
        if (typeof freshLimit === 'number' && Number.isFinite(freshLimit)) {
          if (freshLimit !== chargeLimit) {
            logger.logEvent('api_error',
              `Charge limit mismatch caught before stopping: cached ${chargeLimit}%, `
              + `Tesla reports ${freshLimit}%. Using Tesla's value. `
              + `charge_state snapshot: limit=${fresh.charge_limit_soc} `
              + `min=${fresh.charge_limit_soc_min} std=${fresh.charge_limit_soc_std} `
              + `battery=${fresh.battery_level} state=${fresh.charging_state}`);
          }
          telemetry.updateFromApi({ chargeLimit: freshLimit });
          chargeLimit = freshLimit;
          limitConfirmed = true;
        }
      } catch (err) {
        // Could not reach Tesla. Fall through and use what we have rather than
        // leaving the car charging unsupervised.
        logger.logEvent('api_error', `Charge limit re-verify before stop failed: ${err.message}`);
      }
    }

    if (knownDisconnected || (limitConfirmed && batteryPct > 0 && batteryPct >= chargeLimit)) {
      if ([STATES.CHARGING, STATES.HOLDING].includes(this.state)) {
        this._endSession(batteryPct, knownDisconnected ? 'disconnected' : 'charge_complete');
      }
      // If the car is actively charging above its limit (e.g. externally-started scheduled
      // charge or manual charge from the car), stop it before returning - otherwise the
      // controller silently ignores grid charging that violates the user's charge limit.
      if (!knownDisconnected && chargingState === 'Charging') {
        await this._safeStop(vin, teslaToken, 'Battery at/above charge limit - stopping external charging');
      }
      this.holdTimerStart = null;
      this._lastCommandedAmps = null;
      this._setState(STATES.IDLE, knownDisconnected ? 'Vehicle disconnected' : 'Charge limit reached');
      return;
    }

    // STOPPED: user explicitly stopped - don't auto-restart until AUTO is pressed
    if (this.state === STATES.STOPPED) return;

    switch (this.state) {
      case STATES.IDLE:
      case STATES.ERROR: {
        if (!hasSolar) {
          // Car plugged in but no solar - intercept any grid charging Tesla auto-started
          if (chargingState === 'Charging') {
            await this._safeStop(vin, teslaToken, 'Intercepted grid charge on plug-in - waiting for solar');
          }
          if (pluggedIn) this._setState(STATES.WAITING, 'Car plugged in - waiting for solar');
        } else if (pluggedIn) {
          this._setState(STATES.MONITORING, 'Solar excess detected - monitoring');
        } else if (chargingState === null && hasPriorCarData) {
          // Car is asleep (no chargingState from telemetry) but we've seen it before.
          // Move to MONITORING so it can attempt a wake - MONITORING handles !chargingState.
          this._setState(STATES.MONITORING, 'Solar excess - vehicle asleep, attempting wake');
        }
        break;
      }

      case STATES.WAITING: {
        if (hasSolar) {
          this._setState(STATES.MONITORING, 'Solar available - monitoring');
        } else if (chargingState === 'Charging') {
          // Car started charging on its own (e.g., user started from car screen) - stop it
          await this._safeStop(vin, teslaToken, 'Stopped unexpected charging - still waiting for solar');
        } else if (chargingState === null && !hasPriorCarData) {
          // No car present at all - return to IDLE
          this._setState(STATES.IDLE, 'No vehicle data - returning to idle');
        }
        break;
      }

      case STATES.MONITORING: {
        if (!hasSolar) {
          this._setState(pluggedIn ? STATES.WAITING : STATES.IDLE, 'Solar excess dropped');
        } else if (chargingState === 'Charging') {
          this._startSession(batteryPct);
          this._setState(STATES.CHARGING, 'Vehicle already charging - taking control');
        } else if (chargingState === 'Stopped' || chargingState === 'NoPower') {
          try {
            this._trackApiCall('command'); await setChargingAmps(vin, targetAmps, teslaToken);
            this._trackApiCall('command'); await startCharging(vin, teslaToken);
            this._startSession(batteryPct);
            this._setState(STATES.CHARGING, `Started charging at ${targetAmps}A`);
            logger.logEvent('command', `Start charging at ${targetAmps}A`);
          } catch (err) {
            if (err.message && err.message.includes('401')) {
              this._triggerTeslaTokenRefresh();
            } else if (err.message && (err.message.includes('offline') || err.message.includes('asleep') || err.message.includes('unavailable'))) {
              // Car reports Stopped but is actually asleep - send a wake command
              const canWake = !this.lastWakeAttempt || (now - this.lastWakeAttempt > wakeGuardMs);
              if (canWake) {
                this.lastWakeAttempt = now;
                try {
                  this._trackApiCall('wake'); await wakeVehicle(vin, teslaToken);
                  logger.logEvent('command', 'Wake vehicle sent (was asleep despite Stopped state)');
                } catch (wakeErr) {
                  logger.logEvent('api_error', `Wake vehicle failed: ${wakeErr.message}`);
                }
              } else {
                logger.logEvent('api_error', `Start charging failed: ${err.message}`);
              }
            } else {
              logger.logEvent('api_error', `Start charging failed: ${err.message}`);
            }
          }
        } else if (!chargingState) {
          const canWake = !this.lastWakeAttempt || (now - this.lastWakeAttempt > wakeGuardMs);
          if (canWake) {
            this.lastWakeAttempt = now;
            try {
              this._trackApiCall('wake'); await wakeVehicle(vin, teslaToken);
              logger.logEvent('command', 'Wake vehicle sent');
            } catch (err) {
              logger.logEvent('api_error', `Wake vehicle failed: ${err.message}`);
            }
          }
        }
        break;
      }

      case STATES.CHARGING: {
        if (!hasSolar) {
          if (!this.holdTimerStart) {
            this.holdTimerStart = now;
            // Step down to minimum amps immediately - don't keep drawing at the old high rate
            // while waiting to see if solar recovers. The hold timer protects against stop-cycling,
            // but there's no reason to pull from the grid at full speed during the wait.
            if (this._lastCommandedAmps !== minAmps) {
              try {
                this._trackApiCall('command');
                await setChargingAmps(vin, minAmps, teslaToken);
                this._lastCommandedAmps = minAmps;
                logger.logEvent('command', `Solar below minimum - holding at ${minAmps}A`);
              } catch (err) {
                logger.logEvent('api_error', `Hold step-down failed: ${err.message}`);
                if (err.message && err.message.includes('401')) this._triggerTeslaTokenRefresh();
              }
            }
            this._setState(STATES.HOLDING, 'Solar dropped - entering hold period');
          }
        } else {
          if (targetAmps !== this._lastCommandedAmps) {
            try {
              this._trackApiCall('command'); await setChargingAmps(vin, targetAmps, teslaToken);
              this._lastCommandedAmps = targetAmps;
              logger.logEvent('command', `Set charging amps: ${targetAmps}A`);
            } catch (err) {
              logger.logEvent('api_error', `Set amps failed: ${err.message}`);
              if (err.message && err.message.includes('401')) this._triggerTeslaTokenRefresh();
            }
          }
        }
        break;
      }

      case STATES.HOLDING: {
        if (hasSolar) {
          this.holdTimerStart = null;
          this._setState(STATES.CHARGING, 'Solar returned - resuming charge');
          try {
            this._trackApiCall('command'); await setChargingAmps(vin, targetAmps, teslaToken);
          } catch (err) {
            logger.logEvent('api_error', `Set amps on resume failed: ${err.message}`);
            if (err.message && err.message.includes('401')) this._triggerTeslaTokenRefresh();
          }
        } else if (this.holdTimerStart && (now - this.holdTimerStart) >= holdMs) {
          this.holdTimerStart = null;
          this._endSession(batteryPct, 'hold_expired');
          await this._safeStop(vin, teslaToken, 'Hold timer expired - stopped charging');
          // Stay in WAITING (car still plugged in) so we restart when sun returns
          this._setState(STATES.WAITING, 'Hold expired - waiting for solar');
        }
        break;
      }

      // DEPARTURE is handled above the state machine by _runDeparture().
      // If we somehow arrive here in DEPARTURE state (e.g. scheduler just cleared),
      // fall through to IDLE/WAITING logic.
      case STATES.DEPARTURE: {
        if (pluggedIn) {
          this._setState(hasSolar ? STATES.MONITORING : STATES.WAITING, 'Departure schedule cleared - resuming solar control');
        } else {
          this._setState(STATES.IDLE, 'Departure schedule cleared');
        }
        break;
      }
    }
  }

  async _runOverride({ chargeState, readings, vin, teslaToken }) {
    if (this.state !== STATES.OVERRIDE) this._setState(STATES.OVERRIDE, 'CHARGE NOW active');

    const maxAmps = parseInt(db.getSetting('max_charge_amps') || '32', 10);
    const chargingState = chargeState ? chargeState.charging_state : null;
    const chargeAmps    = chargeState ? (chargeState.charge_amps  || 0) : 0;
    const batteryPct    = chargeState ? chargeState.battery_level : 0;
    const chargerPower  = chargeState ? (chargeState.charger_power || 0) : 0;

    if (vin && this._canSendCommands(teslaToken)) {
      try {
        if (!chargeState) {
          const canWake = !this.lastWakeAttempt || (Date.now() - this.lastWakeAttempt > 3 * 60 * 1000);
          if (canWake) {
            this.lastWakeAttempt = Date.now();
            this._trackApiCall('wake'); await wakeVehicle(vin, teslaToken);
            logger.logEvent('command', 'CHARGE NOW: waking vehicle');
          }
        } else if (chargingState === 'Stopped' || chargingState === 'NoPower') {
          this._trackApiCall('command'); await setChargingAmps(vin, maxAmps, teslaToken);
          this._trackApiCall('command'); await startCharging(vin, teslaToken);
          logger.logEvent('command', `CHARGE NOW: started at ${maxAmps}A`);
        } else if (chargingState === 'Charging' && chargeAmps !== maxAmps) {
          this._trackApiCall('command'); await setChargingAmps(vin, maxAmps, teslaToken);
          logger.logEvent('command', `CHARGE NOW: set amps to ${maxAmps}A`);
        }
      } catch (err) {
        logger.logEvent('api_error', `CHARGE NOW command failed: ${err.message}`);
      }
    }

    const evWatts = chargingState === 'Charging' ? chargerPower * 1000 : 0;
    const solarExcessW = readings ? readings.solarW - readings.consumptionW : 0;

    if (readings) {
      db.logTelemetry({
        recorded_at: Date.now(),
        solar_w: readings.solarW, consumption_w: readings.consumptionW, grid_w: readings.gridW,
        solar_excess_w: solarExcessW, ev_w: evWatts, eddi_w: myenergi.getState().divertW || 0, charge_amps: chargeAmps,
        battery_pct: batteryPct, controller_state: this.state, session_id: this.currentSessionId,
        trip_within_18hrs: this._tripContext().tripWithin18hrs,
        diversion_reason: 'override',
      });
      this._lastTelemetry = {
        solarW: readings.solarW, consumptionW: readings.consumptionW, gridW: readings.gridW,
        solarExcessW, smoothedExcess: solarExcessW, targetAmps: maxAmps,
        evWatts, chargeAmps, batteryPct, chargingState,
      };
    }

    this._emitTelemetry(readings, chargeState, solarExcessW, maxAmps, solarExcessW, evWatts);
  }

  _startSession(batteryPct) {
    if (this.currentSessionId) return;
    this.sessionStartBattery = batteryPct;
    this.sessionPeakAmps = 0;
    this.sessionAmpsReadings = [];
    this.sessionStartedAt = Date.now();
    this.currentSessionId = db.startSession(batteryPct);
    logger.logEvent('info', `Session ${this.currentSessionId} started at battery ${batteryPct}%`);
  }

  _endSession(batteryEnd, endReason) {
    if (!this.currentSessionId) return;
    const now = Date.now();

    // Calculate solar vs grid attribution from telemetry for this session,
    // costed per-interval so a session spanning a TOU boundary is correct.
    const energy = db.calcSessionEnergyFromTelemetry(this.currentSessionId);
    const kwhSolar   = energy ? energy.kwhSolar    : 0;
    const kwhFromGrid = energy ? energy.kwhGrid     : 0;
    const avgAmps    = energy ? energy.avgAmps     : 0;
    const durationSecs = this.sessionStartedAt ? Math.round((now - this.sessionStartedAt) / 1000) : 0;
    const estSavings = energy ? energy.estSavings : 0;

    db.endSession(this.currentSessionId, {
      battery_end: batteryEnd, duration_secs: durationSecs,
      kwh_solar: kwhSolar, kwh_from_grid: kwhFromGrid,
      peak_amps: this.sessionPeakAmps, avg_amps: avgAmps,
      est_savings_aud: estSavings, end_reason: endReason,
    });

    // Log to EV charging log for FBT reporting
    const dateStr = new Date(this.sessionStartedAt).toISOString().split('T')[0];
    const costBasis = estSavings + (energy ? energy.gridCost : 0);
    db.insertEvHomeChargingLog({
      date: dateStr,
      kwh_charged: Math.round((kwhSolar + kwhFromGrid) * 100) / 100,
      kwh_from_solar: Math.round(kwhSolar * 100) / 100,
      kwh_from_grid: Math.round(kwhFromGrid * 100) / 100,
      cost_basis: Math.round(costBasis * 100) / 100,
      session_start: this.sessionStartedAt,
      session_end: now,
      charge_session_id: this.currentSessionId,
    });

    logger.logEvent('info', `Session ${this.currentSessionId} ended: ${endReason}, ${kwhSolar.toFixed(2)} kWh`);

    // Notify if session completed on solar only
    if (endReason === 'charge_complete' || endReason === 'disconnected') {
      const completedSession = db.getSession(this.currentSessionId);
      notificationMonitor.notifySessionCompleted(completedSession).catch(() => {});
    }

    this.currentSessionId = null;
    this.sessionStartBattery = null;
    this.sessionPeakAmps = 0;
    this.sessionAmpsReadings = [];
    this.sessionStartedAt = null;
  }

  _emitTelemetry(readings, chargeState, smoothedExcess, targetAmps, solarExcessW, evWatts) {
    const now = Date.now();
    const display = chargeState || this._lastChargeState;
    const chargingState = chargeState
      ? chargeState.charging_state
      : (this._vehicleCloudState
          ? (this._vehicleCloudState.charAt(0).toUpperCase() + this._vehicleCloudState.slice(1))
          : null);
    // Fleet Telemetry only pushes fields on change - charge_amps/charger_power can stay
    // stuck at their last real (non-zero) value even after charging_state correctly moves
    // to Disconnected/Stopped/away-from-home. Gate both on charging_state actually being
    // 'Charging' so the dashboard doesn't show a stale amps/power reading for a car that
    // isn't charging.
    const isActuallyCharging = chargingState === 'Charging';
    const chargeAmps   = isActuallyCharging && chargeState ? (chargeState.charge_amps   || 0) : 0;
    const batteryPct   = display ? display.battery_level  : 0;
    const chargerPower = isActuallyCharging && chargeState ? (chargeState.charger_power  || 0) : 0;
    const chargeLimit  = display ? display.charge_limit_soc : 80;
    const vehicleName  = db.getSetting('tesla_display_name') || 'Tesla';
    const vehicleModel = (() => {
      const vin = db.getSetting('tesla_vin') || '';
      const c = vin[3];
      return { S: 'Model S', X: 'Model X', 3: 'Model 3', Y: 'Model Y', C: 'Cybertruck' }[c] || null;
    })();

    let holdRemaining = null;
    let holdTotal = null;
    if (this.state === STATES.HOLDING && this.holdTimerStart) {
      const holdMs = parseInt(db.getSetting('hold_minutes') || '3', 10) * 60 * 1000;
      holdTotal     = Math.round(holdMs / 1000);
      holdRemaining = Math.max(0, Math.round((holdMs - (now - this.holdTimerStart)) / 1000));
    }

    const eddi = myenergi.getState();
    const acState = ac.getState();
    const acConfigured = ac.isConfigured();
    const { upcomingTrip, tripPriority, tripWithin18hrs } = this._tripContext();

    // Home battery - reuses the same reading the priority-arbitration step
    // already fetches every ~30s (see _applyBatteryPriority above), rather
    // than polling the provider a second time just for display.
    const batteryProvider = battery.getActiveProvider();
    const batteryConfigured = !!(batteryProvider && batteryProvider.isConfigured());
    const batteryReadings = batteryConfigured ? this._lastBatteryReadings : null;

    // Calculate AC load and modes from MELCloud devices
    let acLoadW = 0;
    let acModes = [];
    let acDeviceCount = 0;
    let acRunningCount = 0;
    if (acState.devices && acState.devices.length > 0) {
      acDeviceCount = acState.devices.length;
      acRunningCount = acState.devices.filter(d => d.is_on).length;
      acModes = [...new Set(acState.devices.filter(d => d.is_on).map(d => d.mode))];
      // Estimate load from daily energy consumption (simplified: assume linear consumption over the day)
      // If any unit is on, estimate load from total daily consumption divided by 24 hours
      if (acRunningCount > 0) {
        const totalDailyKwh = acState.devices.reduce((sum, d) => sum + (d.daily_energy_kwh || 0), 0);
        acLoadW = Math.round((totalDailyKwh / 24) * 1000); // rough estimate: ~kWh/day ÷ 24h
      }
    }

    const _solar = readings ? readings.solarW : 0;
    const _grid  = readings ? readings.gridW  : 0;
    const _cons  = readings ? readings.consumptionW : 0;
    const _ev    = evWatts;
    const _eddi  = eddi.divertW || 0;
    mqttPublisher.publish(_solar, _grid, _cons, _ev, _eddi);
    mqttPublisher.publishCar(telemetry.getState(), this._isAtHome);

    // Today's cumulative kWh - included in SSE so the embed doesn't need a separate fetch
    let todayKwh = { solar: 0, gridImport: 0, gridExport: 0, ev: 0, hw: 0, house: 0 };
    try {
      const todayStart = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
      const todayStr   = new Date().toLocaleDateString('en-AU');
      const bDate      = db.getSetting('enphase_energy_baseline_date') || '';
      const bWh        = parseFloat(db.getSetting('enphase_energy_baseline_wh') || '0');
      const cWh        = parseFloat(db.getSetting('enphase_energy_current_wh')  || '0');
      const todayStats = db.getTodayStats();
      const solarKwh   = bDate === todayStr ? Math.max(0, cWh - bWh) / 1000 : (todayStats?.solar?.solar_kwh || 0);
      const evDay      = db.getPeriodStats(todayStart, now);
      const hwDay      = db.getEddiPeriodStats(todayStart, now);
      const houseDay   = db.getHousePeriodStats(todayStart, now);
      todayKwh = {
        solar:      Math.round(solarKwh * 100) / 100,
        gridImport: Math.round((todayStats?.solar?.grid_import_kwh || 0) * 100) / 100,
        gridExport: Math.round((todayStats?.solar?.grid_export_kwh || 0) * 100) / 100,
        ev:         Math.round((evDay.total_kwh    || 0) * 100) / 100,
        hw:         Math.round((hwDay.total_kwh    || 0) * 100) / 100,
        hwBoost:    Math.round((hwDay.boost_kwh    || 0) * 100) / 100,
        house:      Math.round((houseDay.house_kwh || 0) * 100) / 100,
      };
    } catch (_) {}

    mqttPublisher.publishDailyTotals(todayKwh);

    this._emitSSE({
      type: 'telemetry', ts: now,
      solar: readings ? readings.solarW : 0,
      consumption: readings ? readings.consumptionW : 0,
      grid: readings ? readings.gridW : 0,
      solarExcess: solarExcessW || 0, smoothedExcess: smoothedExcess || 0,
      targetAmps, evWatts, evAmps: chargeAmps,
      batteryPct, chargeLimit, chargingState,
      vehicleName, vehicleModel,
      gridRetailerDomain: db.getSetting('grid_retailer_domain') || '',
      controllerState: this.state, holdRemaining, holdTotal, lastUpdated: now,
      gatewayOk: this._gatewayOk, teslaOk: this._teslaOk, isAtHome: this._isAtHome,
      manualOverride: db.getSetting('manual_charge_enabled') === 'true',
      controlEnabled: db.getSetting('charging_control_enabled') !== 'false',
      inSchedule:    this._scheduleActive || false,
      inTouPeak:     this._touPeakActive  || false,
      inFreePower:   this._freePowerActive || false,
      freePowerWindow: this._activeFreePowerWindow(),
      locationKnown: this._lastLatLng !== null,
      vehicleName,
      pollIntervalSecs: parseInt(db.getSetting('polling_interval_seconds') || '15', 10),
      eddiDivertW: eddi.divertW,
      eddiStatus:  eddi.status,
      eddiOk:      eddi.ok,
      eddiTemp1:   eddi.temp1,
      eddiTemp2:   eddi.temp2,
      acLoadW,
      acModes,
      acDeviceCount,
      acRunningCount,
      acDevices: acState.devices || [],
      acOk: acState.ok,
      melcloudConfigured: acConfigured, // field name kept for dashboard backward-compat
      batteryConfigured,
      batterySocPct:  batteryReadings ? batteryReadings.socPct : null,
      batteryPowerW:  batteryReadings ? batteryReadings.powerW : 0,
      batteryBrand:   batteryConfigured ? batteryProvider.label : '',
      tripWithin18hrs,
      tripPriority,
      tripLocation:      upcomingTrip ? (upcomingTrip.location || upcomingTrip.summary || null) : null,
      tripDepartureTime: upcomingTrip ? upcomingTrip.departureTime : null,
      todayKwh,
    });
  }

  getStatus() {
    const t = this._lastTelemetry;
    return {
      controllerState: this.state,
      gatewayOk: this._gatewayOk,
      teslaOk: this._teslaOk,
      controlEnabled: db.getSetting('charging_control_enabled') !== 'false',
      manualOverride: db.getSetting('manual_charge_enabled') === 'true',
      isAtHome:      this._isAtHome,
      locationKnown: this._lastLatLng !== null,
      ...(t || {}),
      lastUpdated: Date.now(),
    };
  }
}

module.exports = new Controller();
