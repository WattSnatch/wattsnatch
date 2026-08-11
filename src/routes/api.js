/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db');
const controller = require('../controller');
const billPoller = require('../services/billPoller');
const rateTemplates = require('../services/rateTemplates');
const certMonitor = require('../services/certMonitor');

// ── Shared period-boundary helpers ──────────────────────────────────────────────
// Used by the /api/stats/*periods* and /api/stats/solar-km routes below to extend
// their existing today/week/month/quarter/year boundaries with four "last complete
// period" boundaries (last full calendar week/month/quarter/year, not "to date")
// plus an optional custom [from, to] range from query params. Purely additive -
// none of the existing boundary calculations are touched.
function getLastPeriodBoundaries() {
  const now = new Date();

  const thisWeekStart = new Date(now); thisWeekStart.setHours(0, 0, 0, 0);
  thisWeekStart.setDate(thisWeekStart.getDate() - (thisWeekStart.getDay() + 6) % 7);
  const lastWeekStart = new Date(thisWeekStart); lastWeekStart.setDate(lastWeekStart.getDate() - 7);

  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const thisQuarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  const lastQuarterStart = new Date(thisQuarterStart); lastQuarterStart.setMonth(lastQuarterStart.getMonth() - 3);

  // Calendar halves: Jan-Jun and Jul-Dec. Used by the Wrapped feature (there is
  // no "half" button in the main period picker), added here rather than
  // duplicated in that route so it shares the same boundary math as every
  // other cadence.
  const thisHalfStart = new Date(now.getFullYear(), now.getMonth() < 6 ? 0 : 6, 1);
  const lastHalfStart = new Date(thisHalfStart); lastHalfStart.setMonth(lastHalfStart.getMonth() - 6);

  const thisYearStart = new Date(now.getFullYear(), 0, 1);
  const lastYearStart = new Date(now.getFullYear() - 1, 0, 1);

  return {
    last_week:    { start: lastWeekStart.getTime(),    end: thisWeekStart.getTime() },
    last_month:   { start: lastMonthStart.getTime(),   end: thisMonthStart.getTime() },
    last_quarter: { start: lastQuarterStart.getTime(), end: thisQuarterStart.getTime() },
    last_half:    { start: lastHalfStart.getTime(),    end: thisHalfStart.getTime() },
    last_year:    { start: lastYearStart.getTime(),    end: thisYearStart.getTime() },
  };
}

// Parses ?from=YYYY-MM-DD&to=YYYY-MM-DD into a { start, end } ms range, or null if
// absent/invalid. `to` is inclusive of the whole day.
function getCustomRangeFromQuery(req) {
  const { from, to } = req.query;
  if (!from || !to) return null;
  const start = new Date(from + 'T00:00:00').getTime();
  const end   = new Date(to   + 'T23:59:59.999').getTime();
  if (isNaN(start) || isNaN(end) || end <= start) return null;
  return { start, end };
}

// Merges last_week/month/quarter/year (and custom, if present in the request query)
// into a boundaries map, ready to be looped alongside a route's existing keys.
function getExtendedBoundaries(req) {
  const extra = getLastPeriodBoundaries();
  const custom = getCustomRangeFromQuery(req);
  if (custom) extra.custom = custom;
  return extra;
}

// GET /api/status
router.get('/api/status', (req, res) => {
  try {
    const status = controller.getStatus();
    const lastTelemetry = db.getLastTelemetry();
    // Compact summary only - the dashboard uses this to decide whether to show
    // the certificate banner. Full detail lives at /api/certs/status.
    const cert = certMonitor.getStatus();
    res.json({
      ok: true,
      status,
      lastTelemetry,
      certs: {
        ok: cert.ok,
        severity: cert.severity,
        daysUntilSoonestExpiry: cert.daysUntilSoonestExpiry,
        problemCount: cert.problems.length,
        firstProblem: cert.problems.length ? cert.problems[0].message : null,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/certs/status - full TLS certificate health.
// Separate from /api/status so the detail (per-certificate expiry, issuer
// changes, which renewal tree each lives in) is available without bloating the
// high-frequency status poll.
router.get('/api/certs/status', (req, res) => {
  try {
    res.json({ ok: true, ...certMonitor.getStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/car/location - car home/away for Home Assistant.
// Bypasses session auth (whitelisted in sessionAuth) but self-guards with the
// shared secret in the `ha_link_key` setting. Read-only; exposes only home/away.
router.get('/api/car/location', (req, res) => {
  const key = db.getSetting('ha_link_key');
  if (!key || req.query.key !== key) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const s = controller.getStatus();
  const known = s.locationKnown === true;
  res.json({
    ok: true,
    location_known: known,
    home: s.isAtHome === true,
    state: known ? (s.isAtHome ? 'home' : 'not_home') : 'unknown',
    ts: Date.now(),
  });
});

// POST /api/charge/action - unified charging control
// body: { action: 'stop' | 'auto' | 'charge-now' }
router.post('/api/charge/action', async (req, res) => {
  try {
    const { action } = req.body;
    if (action === 'stop') {
      await controller.commandStop();
    } else if (action === 'auto') {
      controller.commandAuto();
    } else if (action === 'charge-now') {
      controller.commandChargeNow();
    } else {
      return res.status(400).json({ ok: false, error: 'action must be stop|auto|charge-now' });
    }
    res.json({ ok: true, action, state: controller.state });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/charge/control - enable/disable charging control master toggle
router.post('/api/charge/control', (req, res) => {
  try {
    const { enabled } = req.body;
    controller.setControl(!!enabled);
    res.json({ ok: true, controlEnabled: !!enabled });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/charge/limit - set the Tesla charge limit
router.post('/api/charge/limit', async (req, res) => {
  try {
    const { limit } = req.body;
    if (typeof limit !== 'number' || limit < 50 || limit > 100) {
      return res.json({ ok: false, error: 'Limit must be a number between 50 and 100' });
    }
    const { setChargeLimit } = require('../services/tesla');
    const { decrypt } = require('../utils/crypto');
    const vin = db.getSetting('tesla_vin');
    if (!vin) return res.json({ ok: false, error: 'No VIN configured' });
    const tokenRow = db.getToken('tesla');
    if (!tokenRow) return res.json({ ok: false, error: 'Tesla not authenticated' });
    const token = JSON.parse(decrypt(tokenRow.token_data));
    await setChargeLimit(vin, limit, token.access_token);
    // Update our own cache immediately. Tesla has accepted the new value, so
    // continuing to report and enforce the old one is simply wrong - and it
    // left a bad cached limit impossible to correct from the dashboard: the
    // command succeeded every time while the app carried on behaving as though
    // nothing had changed.
    require('../services/telemetry').setChargeLimitLocal(limit, 'command');
    require('../utils/logger').logEvent('command', `Charge limit set to ${limit}% from the dashboard`);
    res.json({ ok: true, limit });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/trips/charge-for-trip - set charge limit to exactly what a trip needs and start charging
router.post('/api/trips/charge-for-trip', async (req, res) => {
  try {
    const { targetSocPct } = req.body;
    const target = Math.ceil(parseFloat(targetSocPct));
    if (!target || target < 20 || target > 100) {
      return res.status(400).json({ ok: false, error: 'Invalid target SoC' });
    }
    const { setChargeLimit } = require('../services/tesla');
    const { decrypt } = require('../utils/crypto');
    const vin = db.getSetting('tesla_vin');
    if (!vin) return res.json({ ok: false, error: 'No VIN configured' });
    const tokenRow = db.getToken('tesla');
    if (!tokenRow) return res.json({ ok: false, error: 'Tesla not authenticated' });
    const token = JSON.parse(decrypt(tokenRow.token_data));
    await setChargeLimit(vin, target, token.access_token);
    // Only start charging immediately if the car is at home - otherwise the limit
    // will take effect automatically when it arrives home and plugs in
    const status = controller.getStatus();
    if (status.isAtHome) controller.commandChargeNow();
    res.json({ ok: true, targetSocPct: target, chargingStarted: !!status.isAtHome });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/stats/monthly?year=YYYY&month=M
router.get('/api/stats/monthly', (req, res) => {
  try {
    const now = new Date();
    const year  = parseInt(req.query.year  || now.getFullYear(),  10);
    const month = parseInt(req.query.month || (now.getMonth() + 1), 10);
    const stats = db.getMonthlyStats(year, month);

    // Merge Eddi daily hot water data into each day
    const eddiDays     = db.getEddiDailyStats(year, month);
    const eddiMap      = new Map(eddiDays.map(d => [d.day, { kwh: d.kwh || 0, boost_kwh: d.boost_kwh || 0 }]));

    // Merge AC daily data into each day (Phase 10.4)
    const acDays = db.getACDailyStats(year, month);
    const acMap  = new Map(acDays.map(d => [d.day, d.kwh || 0]));

    const days = (stats.days || []).map(d => {
      const eddi = eddiMap.get(d.day) || { kwh: 0, boost_kwh: 0 };
      return {
        ...d,
        hw_kwh:       Math.round(eddi.kwh       * 100) / 100,
        hw_boost_kwh: Math.round(eddi.boost_kwh * 100) / 100,
        ac_kwh:       Math.round((acMap.get(d.day) || 0) * 100) / 100,
      };
    });
    // Backfill any days that only have Eddi data (no EV charging)
    for (const [day, eddi] of eddiMap) {
      if (!days.find(d => d.day === day)) {
        days.push({ day, solar_kwh: 0, grid_kwh: 0, hw_kwh: Math.round(eddi.kwh * 100) / 100, hw_boost_kwh: Math.round(eddi.boost_kwh * 100) / 100, ac_kwh: 0 });
      }
    }
    // Backfill any days that only have AC data
    for (const [day, kwh] of acMap) {
      if (!days.find(d => d.day === day)) {
        days.push({ day, solar_kwh: 0, grid_kwh: 0, hw_kwh: 0, ac_kwh: Math.round(kwh * 100) / 100 });
      }
    }
    days.sort((a, b) => a.day - b.day);

    res.json({ ok: true, year, month, ...stats, days });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/location/set-home - save car's current GPS as home location
router.post('/api/location/set-home', async (req, res) => {
  try {
    const { lat, lon, radius_km } = req.body;

    if (lat !== undefined && lon !== undefined) {
      db.setSetting('home_latitude', String(parseFloat(lat)));
      db.setSetting('home_longitude', String(parseFloat(lon)));
      if (radius_km !== undefined) db.setSetting('home_radius_km', String(parseFloat(radius_km)));
      return res.json({ ok: true, lat: parseFloat(lat), lon: parseFloat(lon) });
    }

    const { getVehicleData } = require('../services/tesla');
    const { decrypt } = require('../utils/crypto');
    const tokenRow = db.getToken('tesla');
    if (!tokenRow) return res.json({ ok: false, error: 'Tesla not authenticated' });
    const tokenData = JSON.parse(decrypt(tokenRow.token_data));
    const vin = db.getSetting('tesla_vin');
    if (!vin) return res.json({ ok: false, error: 'No VIN configured' });

    const vehicleData = await getVehicleData(vin, tokenData.access_token);
    const ds = vehicleData.driveState;
    if (!ds || ds.latitude == null || ds.longitude == null) {
      return res.json({ ok: false, error: 'Car GPS unavailable - car may be asleep or GPS not ready' });
    }

    db.setSetting('home_latitude', String(ds.latitude));
    db.setSetting('home_longitude', String(ds.longitude));
    if (radius_km !== undefined) db.setSetting('home_radius_km', String(parseFloat(radius_km)));

    res.json({ ok: true, lat: ds.latitude, lon: ds.longitude });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Secrets that are never sent back to the browser. Declared once and used by
// both GET (to strip them) and POST (to treat '' as "unchanged"), because the
// two lists silently drifting apart would either leak a secret or wipe one.
const MASKED_SECRET_KEYS = [
  'tesla_client_secret',
  'google_calendar_client_secret',
  'outlook_calendar_client_secret',
  'mqtt_password',
  'mqtt_in_password',
  'watttime_password',
  'electricitymaps_api_key',
  'ercot_api_password',
  'powerwall_password',
];

// GET /api/settings
router.get('/api/settings', (req, res) => {
  try {
    const settings = db.getAllSettings();
    const safe = { ...settings };
    // Alongside stripping the value, report whether one is stored. Without
    // this the field just loads blank, which is indistinguishable from "my
    // save didn't work" - and that is exactly how it was read in issue #8,
    // where the key had in fact saved correctly the whole time.
    const isSet = {};
    for (const key of MASKED_SECRET_KEYS) {
      isSet[key] = !!(safe[key] && String(safe[key]).length > 0);
      delete safe[key];
    }
    res.json({ ok: true, settings: safe, secretsSet: isSet });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/settings
router.post('/api/settings', (req, res) => {
  try {
    const body = req.body;
    const allowed = [
      'country', 'grid_retailer_domain', 'retailer_network_distributor',
      'min_charge_amps', 'max_charge_amps', 'hold_minutes',
      'smoothing_window', 'polling_interval_seconds', 'charger_voltage',
      'electricity_rate_aud', 'electricity_rate_mode', 'export_rate_mode', 'auto_backup_enabled', 'gateway_ip', 'tesla_vin',
      'tesla_client_id', 'tesla_client_secret', 'tesla_redirect_uri', 'tesla_region',
      'tesla_command_backend', 'tesla_ble_proxy_url', 'tesla_state_source',
      'enphase_serial', 'enphase_email', 'tesla_display_name',
      'home_latitude', 'home_longitude', 'home_radius_km', 'google_maps_api_key', 'ha_link_key',
      'schedule_enabled', 'schedule_windows',
      'tou_enabled', 'tou_windows',
      'fuel_ev_kwh_per_100km', 'fuel_petrol_l_per_100km',
      'fuel_hybrid_l_per_100km', 'fuel_petrol_price_aud',
      'myenergi_serial', 'myenergi_api_key', 'myenergi_poll_seconds',
      'teslamate_database_url',
      'gemini_api_key', 'cf_worker_url', 'cf_worker_secret', 'bill_email_local', 'bill_email_domain', 'gemini_model',
      'mqtt_broker_url', 'mqtt_username', 'mqtt_password',
      'anthropic_api_key',
      'openrouter_api_key', 'openrouter_model',
      'feed_in_tariff_aud', 'supply_charge_daily_aud', 'solar_install_cost_aud',
      'solcast_api_key', 'solcast_resource_id', 'solcast_configured',
      'ntfy_base_url', 'ntfy_topic', 'notifications_enabled',
      'check_for_updates',
      'app_base_url',
      'tesla_battery_kwh', 'soc_floor_pct',
      'panel_nicknames',
      'fleet_telemetry_hostname', 'fleet_telemetry_port', 'fleet_telemetry_ca_cert',
      'inverter_brand', 'fronius_ip', 'solaredge_api_key', 'solaredge_site_id',
      'mqtt_in_broker_url', 'mqtt_in_username', 'mqtt_in_password',
      'mqtt_in_topic_solar', 'mqtt_in_second_type', 'mqtt_in_topic_second',
      'mqtt_in_grid_sign', 'mqtt_in_scale', 'mqtt_in_stale_seconds',
      'calendar_provider',
      'google_calendar_client_id', 'google_calendar_client_secret', 'google_calendar_redirect_uri',
      'google_calendar_calendar_id',
      'outlook_calendar_client_id', 'outlook_calendar_client_secret', 'outlook_calendar_redirect_uri',
      'outlook_calendar_tenant_id',
      'grid_intensity_provider', 'grid_intensity_region',
      'watttime_username', 'watttime_password', 'electricitymaps_api_key',
      'ercot_pricing_enabled', 'ercot_api_username', 'ercot_api_password', 'ercot_settlement_point',
      'span_host', 'span_access_token', 'span_solar_circuit_id',
      'auto_trip_charging_enabled',
      'free_power_enabled', 'free_power_keywords',
      'ac_brand',
      'battery_brand', 'battery_priority',
      'sigenergy_host', 'sigenergy_port', 'sigenergy_unit_id',
      'sungrow_host', 'sungrow_port', 'sungrow_unit_id',
      'sungrow_max_charge_power_w', 'sungrow_max_discharge_power_w',
      'powerwall_host', 'powerwall_email', 'powerwall_password',
    ];
    const myenergiKeys   = new Set(['myenergi_serial', 'myenergi_api_key', 'myenergi_poll_seconds']);
    const teslaMateKeys  = new Set(['teslamate_database_url']);
    // These are stripped from GET /api/settings responses, so the Settings
    // form can only ever POST them back as '' - treat empty as "unchanged"
    // for exactly these keys, or every Save Settings click silently wipes
    // whatever secret was stored. mqtt_password/mqtt_in_password used to be
    // excluded here (since '' there can legitimately mean "passwordless
    // broker") but now that there's a persistent Settings card for both
    // rather than a one-time wizard, the accidental-wipe risk on every save
    // matters more than that edge case - '' and "never set" both resolve to
    // `undefined` in mqtt.connect() options anyway, so masking them costs
    // nothing functionally. Clearing a previously-set broker password now
    // requires the API directly, not a blank Settings field.
    const maskedSecrets  = new Set(MASKED_SECRET_KEYS);
    let myenergiChanged  = false;
    let teslaMateChanged = false;
    let mqttInChanged    = false;
    let mqttOutChanged   = false;
    for (const key of allowed) {
      if (key in body) {
        if (maskedSecrets.has(key) && body[key] === '') continue;
        db.setSetting(key, body[key]);
        if (myenergiKeys.has(key))  myenergiChanged  = true;
        if (teslaMateKeys.has(key)) teslaMateChanged = true;
        if (key === 'inverter_brand' || key.startsWith('mqtt_in_')) mqttInChanged = true;
        if (key === 'mqtt_broker_url' || key === 'mqtt_username' || key === 'mqtt_password') mqttOutChanged = true;
      }
    }
    if (myenergiChanged) {
      try { require('../services/myenergi').restart(); } catch (_e) {}
    }
    if (teslaMateChanged) {
      try { require('../services/teslamate').invalidateCache(); } catch (_e) {}
    }
    if (mqttInChanged) {
      // Reconnect (or disconnect) the MQTT-input subscription to match the new broker/topics/brand.
      try { require('../services/meters/mqttInput').restart(); } catch (_e) {}
    }
    if (mqttOutChanged) {
      // Reconnect the HA-facing publisher against the new broker/credentials.
      try { require('../services/mqttPublisher').restart(); } catch (_e) {}
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/mqtt/status: connection state for both MQTT directions, for the
// Settings page badges (output: WattSnatch to HA; input: bring your own data).
router.get('/api/mqtt/status', (req, res) => {
  try {
    const mqttPublisher = require('../services/mqttPublisher');
    const mqttInput = require('../services/meters/mqttInput');
    const inState = mqttInput.getState();
    res.json({
      ok: true,
      output: mqttPublisher.getState(),
      input: {
        configured: mqttInput.isConfigured(),
        active: (db.getSetting('inverter_brand') || 'enphase') === 'mqtt',
        connected: inState.connected,
        solarAgeMs: inState.solarAgeMs,
        secondAgeMs: inState.secondAgeMs,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/mqtt/test-output: one-shot connectivity test for the HA-facing
// publisher, using whatever mqtt_broker_url/username/password are currently
// saved (save settings first, same pattern as /api/setup/test-inverter).
router.post('/api/mqtt/test-output', async (req, res) => {
  try {
    const result = await require('../services/mqttPublisher').testConnection();
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/battery/status: current battery reading + priority mode, for the dashboard tile.
// Absent/none brand -> { ok: true, configured: false } so the frontend can hide the tile cleanly.
router.get('/api/battery/status', async (req, res) => {
  try {
    const battery = require('../services/battery');
    const provider = battery.getActiveProvider();
    if (!provider || !provider.isConfigured()) {
      return res.json({ ok: true, configured: false });
    }
    const controller = require('../controller');
    let readings = controller._lastBatteryReadings || null;
    if (!readings) {
      try { readings = await provider.fetchReadings(); } catch (err) {
        return res.json({ ok: true, configured: true, brand: provider.label, error: err.message });
      }
    }
    res.json({
      ok: true,
      configured: true,
      brand: provider.label,
      capabilities: provider.capabilities || [],
      priority: db.getSetting('battery_priority') || 'battery_first',
      ...readings,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/tesla/test-ble: reachability check for the BLE command proxy. Takes an optional
// { url } from the body so it can be tested before saving; falls back to the saved setting.
// Never sends a vehicle command - a plain GET to the proxy root, so it is always safe.
router.post('/api/tesla/test-ble', async (req, res) => {
  try {
    const url = (req.body && req.body.url) || db.getSetting('tesla_ble_proxy_url') || undefined;
    const result = await require('../services/tesla').testBleConnection(url);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/sessions
router.get('/api/sessions', (req, res) => {
  try {
    const page  = parseInt(req.query.page  || '1',  10);
    const limit = parseInt(req.query.limit || '20', 10);
    res.json({ ok: true, ...db.getSessions(page, limit) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/sessions/:id
router.get('/api/sessions/:id', (req, res) => {
  try {
    const session = db.getSession(parseInt(req.params.id, 10));
    if (!session) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, session });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/stats/enphase/today - daily solar production from the meter's lifetime accumulator.
// GET /api/today/node-totals - single call returning today's cumulative kWh for every flow node.
// Used by the dashboard flow diagram to show energy produced/consumed under each icon.
router.get('/api/today/node-totals', (req, res) => {
  try {
    const now        = Date.now();
    const todayStart = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();

    // Solar: Enphase baseline if available, else telemetry sum
    const todayStr   = new Date().toLocaleDateString('en-AU');
    const bDate      = db.getSetting('enphase_energy_baseline_date') || '';
    const bWh        = parseFloat(db.getSetting('enphase_energy_baseline_wh') || '0');
    const cWh        = parseFloat(db.getSetting('enphase_energy_current_wh')  || '0');
    const solarKwh   = bDate === todayStr
      ? Math.max(0, cWh - bWh) / 1000
      : (db.getTodayStats()?.solar?.solar_kwh || 0);

    const todayStats = db.getTodayStats();
    const gridImport = todayStats?.solar?.grid_import_kwh || 0;
    const gridExport = todayStats?.solar?.grid_export_kwh || 0;

    const ev    = db.getPeriodStats(todayStart, now);
    const hw    = db.getEddiPeriodStats(todayStart, now);
    const house = db.getHousePeriodStats(todayStart, now);

    res.json({
      ok: true,
      solar_kwh:       Math.round(solarKwh     * 100) / 100,
      grid_import_kwh: Math.round(gridImport   * 100) / 100,
      grid_export_kwh: Math.round(gridExport   * 100) / 100,
      ev_kwh:          Math.round((ev.total_kwh     || 0) * 100) / 100,
      hw_kwh:          Math.round((hw.total_kwh     || 0) * 100) / 100,
      hw_boost_kwh:    Math.round((hw.boost_kwh     || 0) * 100) / 100,
      house_kwh:       Math.round((house.house_kwh  || 0) * 100) / 100,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// The controller tracks actEnergyDlvd at midnight each day (baseline) and on every poll
// (current). Today's production = current − baseline. No gateway call required at read time.
router.get('/api/stats/enphase/today', (req, res) => {
  try {
    const todayStr    = new Date().toLocaleDateString('en-AU');
    const baselineDate = db.getSetting('enphase_energy_baseline_date') || '';
    const baselineWh   = parseFloat(db.getSetting('enphase_energy_baseline_wh')  || '0');
    const currentWh    = parseFloat(db.getSetting('enphase_energy_current_wh')   || '0');

    if (baselineDate !== todayStr) {
      return res.json({ ok: false, error: 'No baseline yet for today - will be set on next midnight rollover' });
    }

    const whToday = Math.max(0, currentWh - baselineWh);
    res.json({ ok: true, whToday, baselineWh, currentWh, baselineDate });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/telemetry/today
router.get('/api/telemetry/today', (req, res) => {
  try {
    res.json({ ok: true, stats: db.getTodayStats() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/diversion-log - Phase 5: diversion_reason transitions over the last N hours
router.get('/api/diversion-log', (req, res) => {
  try {
    const hours = Math.min(168, Math.max(1, parseInt(req.query.hours || '24', 10)));
    res.json({ ok: true, hours, entries: db.getDiversionLog(hours) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/logs
router.get('/api/logs', (req, res) => {
  try {
    const page  = parseInt(req.query.page  || '1',  10);
    const limit = parseInt(req.query.limit || '50', 10);
    const type  = req.query.type || 'all';
    res.json({ ok: true, ...db.getEvents(page, limit, type) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/logs
router.delete('/api/logs', (req, res) => {
  res.json({ ok: true, message: 'Display cleared' });
});

// GET /api/stats/periods
router.get('/api/stats/periods', (req, res) => {
  try {
    const now = new Date();
    const todayStart   = new Date(now); todayStart.setHours(0,0,0,0);
    const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - (weekStart.getDay() + 6) % 7); weekStart.setHours(0,0,0,0);
    const monthStart   = new Date(now.getFullYear(), now.getMonth(), 1);
    const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const yearStart    = new Date(now.getFullYear(), 0, 1);

    const periods = {
      today:   db.getPeriodStats(todayStart.getTime()),
      week:    db.getPeriodStats(weekStart.getTime()),
      month:   db.getPeriodStats(monthStart.getTime()),
      quarter: db.getPeriodStats(quarterStart.getTime()),
      year:    db.getPeriodStats(yearStart.getTime()),
    };
    for (const [key, { start, end }] of Object.entries(getExtendedBoundaries(req))) {
      periods[key] = db.getPeriodStats(start, end);
    }

    res.json({ ok: true, periods });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/stats/eddi/periods
router.get('/api/stats/eddi/periods', (req, res) => {
  try {
    const now = new Date();
    const todayStart   = new Date(now); todayStart.setHours(0,0,0,0);
    const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - (weekStart.getDay() + 6) % 7); weekStart.setHours(0,0,0,0);
    const monthStart   = new Date(now.getFullYear(), now.getMonth(), 1);
    const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const yearStart    = new Date(now.getFullYear(), 0, 1);

    const periods = {
      today:   db.getEddiPeriodStats(todayStart.getTime(),   now.getTime()),
      week:    db.getEddiPeriodStats(weekStart.getTime(),             now.getTime()),
      month:   db.getEddiPeriodStats(monthStart.getTime(),   now.getTime()),
      quarter: db.getEddiPeriodStats(quarterStart.getTime(), now.getTime()),
      year:    db.getEddiPeriodStats(yearStart.getTime(),    now.getTime()),
    };
    for (const [key, { start, end }] of Object.entries(getExtendedBoundaries(req))) {
      periods[key] = db.getEddiPeriodStats(start, end);
    }

    res.json({ ok: true, periods });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/stats/wrapped?period=month - narrative summary for ONE period
//
// Takes a single period rather than returning all of them like the other stats
// routes. Each one needs a full scan of the window plus a day-by-day rollup, so
// building the whole set would do ten scans to serve the one the page is
// showing. The period names match the Data page's own selector - today, week,
// month, quarter, year, last_week, last_month, last_quarter, last_year, custom -
// so it covers weekly through yearly without a separate concept of its own.
router.get('/api/stats/wrapped', (req, res) => {
  try {
    const now = new Date();
    const nowMs = now.getTime();

    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const weekStart  = new Date(now);
    weekStart.setDate(weekStart.getDate() - (weekStart.getDay() + 6) % 7);
    weekStart.setHours(0, 0, 0, 0);

    const windows = {
      today:   { start: todayStart.getTime(), end: nowMs },
      week:    { start: weekStart.getTime(),  end: nowMs },
      month:   { start: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), end: nowMs },
      quarter: { start: new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1).getTime(), end: nowMs },
      year:    { start: new Date(now.getFullYear(), 0, 1).getTime(), end: nowMs },
      ...getExtendedBoundaries(req),
    };

    const period = String(req.query.period || 'month');
    const win = windows[period];
    if (!win) {
      return res.status(400).json({
        ok: false,
        error: `Unknown period "${period}". Expected one of: ${Object.keys(windows).join(', ')}`,
      });
    }

    res.json({ ok: true, period, wrapped: db.getWrappedForPeriod(win.start, win.end) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/stats/master/periods - combined car + eddi
router.get('/api/stats/master/periods', (req, res) => {
  try {
    const now = new Date();
    const todayStart   = new Date(now); todayStart.setHours(0,0,0,0);
    const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - (weekStart.getDay() + 6) % 7); weekStart.setHours(0,0,0,0);
    const monthStart   = new Date(now.getFullYear(), now.getMonth(), 1);
    const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const yearStart    = new Date(now.getFullYear(), 0, 1);

    const boundaries = {
      today:   todayStart.getTime(),
      week:    weekStart.getTime(),
      month:   monthStart.getTime(),
      quarter: quarterStart.getTime(),
      year:    yearStart.getTime(),
    };

    const combined = {};
    const nowMs = now.getTime();
    // Everything here comes from one reconciled breakdown rather than three
    // independently-modelled ones. The old version summed the car, Eddi and
    // house estimates, each of which split solar from grid on its own
    // incompatible assumption - the house took a proportional share while the
    // car gave the house first refusal - so the same watt could be billed twice.
    // Over July 2026 that summed to 287.02 kWh of grid import against 276.63
    // actually metered. See db.getEnergyBreakdownForPeriod.
    const computeCombined = (startTs, endTs) => {
      const b   = db.getEnergyBreakdownForPeriod(startTs, endTs);
      const cat = (key) => b.categories.find((c) => c.key === key) || {};
      const car   = cat('car');
      const hw    = cat('hot_water');
      const house = cat('house');

      return {
        // Unchanged shape: the managed-load total the period cards and the
        // petrol comparison are built from.
        total_kwh:       Math.round(((car.load_kwh || 0) + (hw.load_kwh || 0) + (house.solar_kwh || 0)) * 100) / 100,
        est_savings_aud: b.est_savings_aud,
        car_kwh:         car.load_kwh   || 0,
        hw_kwh:          hw.load_kwh    || 0,
        house_solar_kwh: house.solar_kwh || 0,

        // The metered import cost, no longer a sum of three estimates.
        grid_cost_aud:   b.grid.import_cost,
        // Priced day-by-day from tariff_history, so a period spanning a supply-rate
        // change isn't charged wholly at today's rate (the frontend previously did
        // days × current setting, overstating any past period after a price rise).
        supply_charge_aud: b.supply_charge_aud,

        // Straight off the grid meter. export_credit has never been surfaced
        // before, which meant the "total spent" figure was a gross cost being
        // compared against a bill that nets the feed-in credit off.
        kwh_imported:      b.grid.kwh_imported,
        kwh_exported:      b.grid.kwh_exported,
        export_credit_aud: b.grid.export_credit,
        net_cost_aud:      b.net_cost_aud,

        // Per-category solar/grid split, reconciled to the totals above.
        categories:        b.categories,
        // Whole-of-home load and the solar that served it. total_load_kwh is the
        // correct denominator for grid reliance: the old frontend built one from
        // house + car + hot water while sourcing the numerator from a different
        // pair of models, so the ratio needed clamping to stay under 100%.
        total_load_kwh:    b.total_load_kwh,
        total_solar_kwh:   b.total_solar_kwh,
        self_pct:          b.self_pct,

        // How much of the period was actually observed. A gap understates
        // import and export at the same time, so without this a coverage
        // problem is indistinguishable from a pricing problem.
        coverage_pct:      b.coverage_pct,
        unrecorded_hours:  b.unrecorded_hours,
        unexplained_kwh:   b.unexplained_kwh,
      };
    };
    for (const [key, startTs] of Object.entries(boundaries)) {
      combined[key] = computeCombined(startTs, nowMs);
    }
    for (const [key, { start, end }] of Object.entries(getExtendedBoundaries(req))) {
      combined[key] = computeCombined(start, end);
    }

    res.json({ ok: true, periods: combined });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/stats/api-cost?year=2026&month=5
router.get('/api/stats/api-cost', (req, res) => {
  try {
    const now = new Date();
    const year  = parseInt(req.query.year  || now.getFullYear(),  10);
    const month = parseInt(req.query.month || (now.getMonth() + 1), 10);
    res.json({ ok: true, ...db.getApiCostStats(year, month) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/rates
router.get('/api/rates', (req, res) => {
  try {
    res.json({ ok: true, rates: db.getRates() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/rates - body: { rate_aud, effective_from (ms timestamp) }
router.post('/api/rates', (req, res) => {
  try {
    const { rate_aud, effective_from } = req.body;
    const rate = parseFloat(rate_aud);
    const ts   = parseInt(effective_from, 10);
    if (isNaN(rate) || rate <= 0) return res.status(400).json({ ok: false, error: 'rate_aud must be a positive number' });
    if (isNaN(ts))                return res.status(400).json({ ok: false, error: 'effective_from must be a timestamp' });
    const id = db.addRate(rate, ts);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/rates/:id
router.delete('/api/rates/:id', (req, res) => {
  try {
    db.deleteRate(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ─── Time-of-use rate configs ─────────────────────────────────────────────────

router.get('/api/tou-rates', (req, res) => {
  try {
    res.json({ ok: true, configs: db.getTouConfigs() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/tou-rates - body: { default_rate_aud, effective_from (ms), windows: [{label, rate_aud, days:[0-6], start_time:"HH:MM", end_time:"HH:MM"}] }
router.post('/api/tou-rates', (req, res) => {
  try {
    const { default_rate_aud, effective_from, windows } = req.body;
    const defaultRate = parseFloat(default_rate_aud);
    const ts = parseInt(effective_from, 10);
    if (isNaN(defaultRate) || defaultRate <= 0) {
      return res.status(400).json({ ok: false, error: 'default_rate_aud must be a positive number' });
    }
    if (isNaN(ts)) return res.status(400).json({ ok: false, error: 'effective_from must be a timestamp' });
    if (!Array.isArray(windows) || windows.length === 0) {
      return res.status(400).json({ ok: false, error: 'At least one time window is required' });
    }
    for (const w of windows) {
      if (!w.label || !Array.isArray(w.days) || w.days.length === 0 || !w.start_time || !w.end_time || isNaN(parseFloat(w.rate_aud))) {
        return res.status(400).json({ ok: false, error: 'Each window needs a label, at least one day, a start/end time, and a rate' });
      }
    }
    const id = db.addTouConfig({
      default_rate_aud: defaultRate,
      effective_from: ts,
      windows: windows.map((w) => ({ ...w, rate_aud: parseFloat(w.rate_aud) })),
    });
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/tou-rates/:id
router.delete('/api/tou-rates/:id', (req, res) => {
  try {
    db.deleteTouConfig(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ─── Time-varying export/feed-in rate configs (mirrors TOU routes above) ──────

router.get('/api/export-rate-configs', (req, res) => {
  try {
    res.json({ ok: true, configs: db.getExportConfigs() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/export-rate-configs - same body shape as POST /api/tou-rates
router.post('/api/export-rate-configs', (req, res) => {
  try {
    const { default_rate_aud, effective_from, windows } = req.body;
    const defaultRate = parseFloat(default_rate_aud);
    const ts = parseInt(effective_from, 10);
    if (isNaN(defaultRate) || defaultRate < 0) {
      return res.status(400).json({ ok: false, error: 'default_rate_aud must be a non-negative number' });
    }
    if (isNaN(ts)) return res.status(400).json({ ok: false, error: 'effective_from must be a timestamp' });
    if (!Array.isArray(windows) || windows.length === 0) {
      return res.status(400).json({ ok: false, error: 'At least one time window is required' });
    }
    for (const w of windows) {
      if (!w.label || !Array.isArray(w.days) || w.days.length === 0 || !w.start_time || !w.end_time || isNaN(parseFloat(w.rate_aud))) {
        return res.status(400).json({ ok: false, error: 'Each window needs a label, at least one day, a start/end time, and a rate' });
      }
    }
    const id = db.addExportConfig({
      default_rate_aud: defaultRate,
      effective_from: ts,
      windows: windows.map((w) => ({ ...w, rate_aud: parseFloat(w.rate_aud) })),
    });
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/export-rate-configs/:id
router.delete('/api/export-rate-configs/:id', (req, res) => {
  try {
    db.deleteExportConfig(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ─── Utility rate plan templates ──────────────────────────────────────────────
// See src/services/rateTemplates/README.md for the accuracy disclaimer that
// applies to every template - approximated from public rate-schedule docs,
// not verified against a live utility account.

router.get('/api/rate-templates', (req, res) => {
  try {
    res.json({ ok: true, templates: rateTemplates.listTemplates({ country: req.query.country, region: req.query.region }) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/rate-templates/:id/apply - inserts a new dated TOU config (and,
// if the template has export windows, a new dated export config too). This
// is a one-time preset, not a live link to the template - the resulting
// windows can be freely hand-edited afterward in the existing TOU editor.
router.post('/api/rate-templates/:id/apply', (req, res) => {
  try {
    const template = rateTemplates.getTemplate(req.params.id);
    if (!template) return res.status(404).json({ ok: false, error: 'Unknown rate template' });

    const effectiveFrom = Date.now();
    const importConfigId = db.addTouConfig({
      default_rate_aud: template.importDefaultRateAud,
      effective_from: effectiveFrom,
      windows: template.importWindows,
    });
    db.setSetting('electricity_rate_mode', 'tou');

    let exportConfigId = null;
    if (template.exportWindows) {
      exportConfigId = db.addExportConfig({
        default_rate_aud: template.exportDefaultRateAud,
        effective_from: effectiveFrom,
        windows: template.exportWindows,
      });
      db.setSetting('export_rate_mode', 'tou');
    }

    res.json({ ok: true, importConfigId, exportConfigId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Tariff history ───────────────────────────────────────────────────────────

router.get('/api/tariffs', (req, res) => {
  try {
    res.json({ ok: true, tariffs: db.getTariffs() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/api/tariffs', (req, res) => {
  try {
    const { type, rate_aud, effective_from } = req.body;
    const rate = parseFloat(rate_aud);
    const ts   = parseInt(effective_from, 10);
    if (!['feed_in', 'supply_charge'].includes(type)) return res.status(400).json({ ok: false, error: 'Invalid type' });
    if (isNaN(rate) || rate < 0) return res.status(400).json({ ok: false, error: 'rate_aud must be a non-negative number' });
    if (isNaN(ts))               return res.status(400).json({ ok: false, error: 'effective_from must be a timestamp' });
    const id = db.addTariff(type, rate, ts);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete('/api/tariffs/:id', (req, res) => {
  try {
    db.deleteTariff(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/import/eddi-csv ────────────────────────────────────────────────
// Accepts { csv: "<raw CSV text>" }, parses hourly Eddi report, imports as daily summaries.
router.post('/api/import/eddi-csv', (req, res) => {
  try {
    const csv = (req.body.csv || '').trim();
    if (!csv) return res.status(400).json({ ok: false, error: 'No CSV data provided' });

    const lines = csv.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return res.status(400).json({ ok: false, error: 'CSV has no data rows' });

    const headers = lines[0].split(',').map(h => h.trim());
    const col = name => headers.findIndex(h => h.toLowerCase().includes(name.toLowerCase()));

    const tsIdx      = col('Timestamp');
    const divL1Idx   = col('Diverter Energy (L1)');
    const divL2Idx   = col('Diverter Energy (L2)');
    const boostL1Idx = col('Boosted Energy (L1)');
    const boostL2Idx = col('Boosted Energy (L2)');

    if (tsIdx < 0 || divL1Idx < 0) {
      return res.status(400).json({ ok: false, error: 'CSV does not look like an Eddi report (missing expected columns)' });
    }

    const TZ = 'Australia/Sydney';
    const dayMap = new Map(); // localDate -> { divertWh, boostWh }

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      if (cols.length <= tsIdx) continue;

      const ts = new Date(cols[tsIdx].trim());
      if (isNaN(ts.getTime())) continue;

      // Group by local calendar date
      const localDate = ts.toLocaleDateString('en-CA', { timeZone: TZ }); // returns YYYY-MM-DD
      const divertWh  = (parseFloat(cols[divL1Idx]   || 0) || 0)
                      + (divL2Idx   >= 0 ? (parseFloat(cols[divL2Idx]   || 0) || 0) : 0);
      const boostWh   = (boostL1Idx >= 0 ? (parseFloat(cols[boostL1Idx] || 0) || 0) : 0)
                      + (boostL2Idx >= 0 ? (parseFloat(cols[boostL2Idx] || 0) || 0) : 0);

      if (!dayMap.has(localDate)) dayMap.set(localDate, { divertWh: 0, boostWh: 0 });
      const day = dayMap.get(localDate);
      day.divertWh += divertWh;
      day.boostWh  += boostWh;
    }

    const dayRecords = Array.from(dayMap.entries()).map(([localDate, v]) => ({
      localDate,
      divertKwh: Math.round((v.divertWh / 1000) * 1000) / 1000,
      boostKwh:  Math.round((v.boostWh  / 1000) * 1000) / 1000,
    }));

    const result = db.importEddiCsvData(dayRecords);
    res.json({ ok: true, ...result, days: dayRecords.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Electricity Bills ────────────────────────────────────────────────────────

// GET /api/bills
router.get('/api/bills', (req, res) => {
  try {
    res.json({ ok: true, bills: db.getBills() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/bills/:id
router.delete('/api/bills/:id', (req, res) => {
  try {
    db.deleteBill(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/bills/upload - manually upload a PDF bill for Gemini analysis
router.post('/api/bills/upload', async (req, res) => {
  try {
    const { pdf, filename } = req.body;
    if (!pdf) return res.status(400).json({ ok: false, error: 'No PDF data provided' });

    const apiKey = db.getSetting('gemini_api_key');
    const model  = db.getSetting('gemini_model') || 'gemini-2.0-flash';
    if (!apiKey) return res.status(400).json({ ok: false, error: 'Gemini API key not configured - add it in Settings' });

    const extracted = await billPoller.analyzeWithGemini(pdf, apiKey, model);

    db.insertBill({
      created_at:                  Date.now(),
      email_id:                    `upload-${Date.now()}-${(filename || 'bill').replace(/[^a-z0-9]/gi, '_')}`,
      billing_period_start:        extracted.billing_period_start ? new Date(extracted.billing_period_start).getTime() : null,
      billing_period_end:          extracted.billing_period_end   ? new Date(extracted.billing_period_end).getTime()   : null,
      retailer:                    extracted.retailer,
      account_number:              extracted.account_number,
      total_amount_aud:            extracted.total_amount_aud,
      gst_aud:                     extracted.gst_aud,
      supply_charge_aud:           extracted.supply_charge_aud,
      usage_charge_aud:            extracted.usage_charge_aud,
      solar_export_credit_aud:     extracted.solar_export_credit_aud ?? 0,
      total_kwh:                   extracted.total_kwh,
      peak_kwh:                    extracted.peak_kwh,
      off_peak_kwh:                extracted.off_peak_kwh,
      shoulder_kwh:                extracted.shoulder_kwh,
      solar_export_kwh:            extracted.solar_export_kwh ?? 0,
      supply_charge_cents_per_day: extracted.supply_charge_cents_per_day,
      peak_rate_cents:             extracted.peak_rate_cents,
      off_peak_rate_cents:         extracted.off_peak_rate_cents,
      shoulder_rate_cents:         extracted.shoulder_rate_cents,
      notes:                       extracted.notes,
      raw_json:                    JSON.stringify(extracted),
    });

    res.json({ ok: true, extracted });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/bills/poll - trigger immediate poll
router.post('/api/bills/poll', async (req, res) => {
  try {
    await billPoller.pollOnce();
    res.json({ ok: true, message: 'Poll complete' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/stats/house/periods - house load grid vs solar breakdown
router.get('/api/stats/house/periods', (req, res) => {
  try {
    const now = Date.now();
    const d   = new Date(); d.setHours(0, 0, 0, 0);
    const weekStart = new Date(d); weekStart.setDate(d.getDate() - (d.getDay() + 6) % 7);
    const startOfMonth   = new Date(d); startOfMonth.setDate(1);
    const startOfQuarter = new Date(startOfMonth); startOfQuarter.setMonth(Math.floor(startOfMonth.getMonth() / 3) * 3);
    const startOfYear    = new Date(d); startOfYear.setMonth(0, 1);

    const periods = {
      today:   db.getHousePeriodStats(d.getTime(),              now),
      week:    db.getHousePeriodStats(weekStart.getTime(),               now),
      month:   db.getHousePeriodStats(startOfMonth.getTime(),       now),
      quarter: db.getHousePeriodStats(startOfQuarter.getTime(),     now),
      year:    db.getHousePeriodStats(startOfYear.getTime(),        now),
    };
    for (const [key, { start, end }] of Object.entries(getExtendedBoundaries(req))) {
      periods[key] = db.getHousePeriodStats(start, end);
    }

    res.json({ ok: true, periods });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/stats/house/monthly?year=YYYY&month=M
router.get('/api/stats/house/monthly', (req, res) => {
  try {
    const now   = new Date();
    const year  = parseInt(req.query.year  || now.getFullYear(),  10);
    const month = parseInt(req.query.month || (now.getMonth() + 1), 10);
    const days  = db.getHouseDailyStats(year, month);
    res.json({ ok: true, year, month, days });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/stats/bills/comparison
router.get('/api/stats/bills/comparison', (req, res) => {
  try {
    const bills = db.getBills();
    const result = bills.map(bill => {
      const start = bill.billing_period_start;
      const end   = bill.billing_period_end;
      const carStats  = start && end ? db.getPeriodStats(start, end)     : { est_savings_aud: 0 };
      const eddiStats = start && end ? db.getEddiPeriodStats(start, end) : { est_savings_aud: 0 };

      // ── Bill-vs-WattSnatch accuracy ─────────────────────────────────────────
      // Sourced from telemetry_log directly (getGridSummaryForPeriod), NOT
      // financial_ledger - the ledger is a once-a-day incremental table that
      // can have permanent gaps on dates it simply never ran for, even when
      // the raw telemetry for that date is intact. Reading straight from
      // telemetry_log matches what the Data page shows and can't have that
      // class of gap.
      let accuracy = null;
      if (start && end) {
        // A bill states local calendar dates ("1 Jul 2026 to 31 Jul 2026") but
        // stores them as UTC midnight of those dates. Energy was being summed
        // over that raw UTC window while the supply charge was priced over local
        // days, so the two halves of this comparison described spans ten hours
        // apart in AEST - and neither matched the Data page, which uses local
        // month boundaries. Over July 2026 that alone moved grid import between
        // 268.23 and 276.63 kWh. Resolve the stated dates back to local
        // midnights once, and use that single window for everything.
        const startStr = new Date(start).toISOString().slice(0, 10);
        const endStr   = new Date(end).toISOString().slice(0, 10);
        const periodStartMs = new Date(startStr + 'T00:00:00').getTime();
        const periodEndMs   = new Date(endStr   + 'T00:00:00').getTime() + 86400000;
        const periodDays    = Math.round((periodEndMs - periodStartMs) / 86400000);

        const b = db.getEnergyBreakdownForPeriod(periodStartMs, periodEndMs);
        if (b.days_recorded > 0) {
          accuracy = {
            days_recorded:   b.days_recorded,
            period_days:     periodDays,
            kwh_imported:    b.grid.kwh_imported,
            kwh_exported:    b.grid.kwh_exported,
            import_cost:     b.grid.import_cost,
            export_credit:   b.grid.export_credit,
            supply_charge:   b.supply_charge_aud,
            estimated_total: b.net_cost_aud,

            // The honest measure of how much of the period was observed.
            // days_recorded counts calendar days that have at least one reading,
            // so a day with a single row counts the same as a complete one - it
            // reported full coverage for July 2026 while 50.7 hours were
            // actually missing, leaving a 94% cost match with nothing to explain
            // it. Energy is integrated over the telemetry that exists, so gaps
            // pull import, export and cost down together.
            coverage_pct:     b.coverage_pct,
            unrecorded_hours: b.unrecorded_hours,
          };
        }
      }
      const car_savings_aud  = Math.round((carStats.est_savings_aud  || 0) * 100) / 100;
      const hw_savings_aud   = Math.round((eddiStats.est_savings_aud || 0) * 100) / 100;
      const wattsnatch_savings_aud = Math.round((car_savings_aud + hw_savings_aud) * 100) / 100;
      const without_wattsnatch_aud = Math.round(((bill.total_amount_aud || 0) + wattsnatch_savings_aud) * 100) / 100;
      const savings_pct = without_wattsnatch_aud > 0
        ? Math.round((wattsnatch_savings_aud / without_wattsnatch_aud) * 1000) / 10
        : 0;
      return {
        ...bill,
        car_savings_aud,
        hw_savings_aud,
        wattsnatch_savings_aud,
        without_wattsnatch_aud,
        savings_pct,
        accuracy,
      };
    });
    res.json({ ok: true, bills: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── TeslaMate ────────────────────────────────────────────────────────────────

const teslamate = require('../services/teslamate');

// GET /api/teslamate/stats - efficiency, battery health, arrival SoC
router.get('/api/teslamate/stats', async (req, res) => {
  try {
    const [efficiency, health, arrivalSoc] = await Promise.all([
      teslamate.getEfficiencyKwhPerKm(),
      teslamate.getBatteryHealthPercent(),
      teslamate.getTypicalArrivalSoc(),
    ]);
    res.json({ ok: true, efficiency, health, arrivalSoc });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/notifications/test - send a connectivity test ping
router.post('/api/notifications/test', async (req, res) => {
  try {
    const notifications = require('../services/notifications');
    const result = await notifications.sendNotification(
      'WattSnatch',
      'Push notifications are working!',
      'default'
    );
    res.json(result);
  } catch (err) {
    res.json({ ok: false, sent: false, error: err.message });
  }
});

// POST /api/notifications/morning-brief - trigger morning brief on demand
router.post('/api/notifications/morning-brief', async (req, res) => {
  try {
    const notifications = require('../services/notifications');
    const result = await notifications.notifyMorningBrief();
    res.json(result);
  } catch (err) {
    res.json({ ok: false, sent: false, error: err.message });
  }
});

// POST /api/notifications/evening-summary - trigger evening summary on demand
router.post('/api/notifications/evening-summary', async (req, res) => {
  try {
    const notifications = require('../services/notifications');
    const result = await notifications.notifyEveningSummary();
    res.json(result);
  } catch (err) {
    res.json({ ok: false, sent: false, error: err.message });
  }
});

// POST /api/teslamate/test - test connection
router.post('/api/teslamate/test', async (req, res) => {
  try {
    const result = await teslamate.testConnection();
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/calendar/free-power - windows detected in the connected calendar
//
// Lets the Settings page show what WattSnatch actually matched, so a typo in an
// event title (or an all-day entry that is deliberately ignored) is visible
// immediately rather than only becoming apparent when the car fails to charge.
router.get('/api/calendar/free-power', (req, res) => {
  try {
    const calendar = require('../services/calendar');
    res.json({
      ok: true,
      enabled: calendar.isFreePowerEnabled(),
      active: calendar.isFreePowerActive(),
      activeWindow: calendar.getActiveFreePowerWindow(),
      windows: calendar.getFreePowerWindows(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/grid-intensity/test - verify the configured carbon-intensity source
//
// Exists because there was previously no way to find out that a source was
// misconfigured except to save, go to the dashboard, notice the figure had not
// changed, and then find the failure in the server log. That is what happened
// in issue #8, where a 401 sat in the log for a day before anyone saw it.
router.post('/api/grid-intensity/test', async (req, res) => {
  try {
    // Inline require to match how the other service lookups in this file work
    // (there is no top-level import for the grid-intensity registry).
    const gridIntensity = require('../services/gridIntensity');
    const provider = gridIntensity.getActiveProvider();
    if (!provider) return res.json({ ok: false, error: 'No grid intensity provider configured' });

    if (typeof provider.isConfigured === 'function' && !provider.isConfigured()) {
      return res.json({
        ok: false,
        provider: provider.label,
        error: `${provider.label} is not fully configured - fill in the fields above and save first.`,
      });
    }

    // Providers may expose a richer testConnection(); otherwise a live fetch is
    // itself the test.
    if (typeof provider.testConnection === 'function') {
      const result = await provider.testConnection();
      return res.json({ ...result, provider: provider.label });
    }

    const payload = await provider.fetchGridIntensity();
    res.json({
      ok: true,
      provider: provider.label,
      carbonIntensityG: payload.carbonIntensityG,
      renewablePct: payload.renewablePct,
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// POST /api/teslamate/sync-sessions - match TeslaMate charge sessions to WattSnatch sessions
router.post('/api/teslamate/sync-sessions', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '90', 10);
    const sessions = await teslamate.getChargeSessions(days);
    if (!sessions) return res.json({ ok: false, error: 'TeslaMate not connected or no sessions' });

    const dbInst = db.getDb();
    // Per-session rate resolution - this can backfill sessions up to 90 days
    // old, so costing them all at today's rate would be wrong for any that
    // happened before a rate change.
    const resolveRate = db.createRateResolver();

    let matched = 0;
    const updateStmt = dbInst.prepare(`
      UPDATE charge_sessions
      SET teslamate_charge_id = ?, kwh_from_grid = ?, cost_grid = ?
      WHERE id = ? AND teslamate_charge_id IS NULL
    `);

    for (const tmSession of sessions) {
      if (!tmSession.start_date || tmSession.charge_energy_added == null) continue;
      const tmStartMs = new Date(tmSession.start_date).getTime();

      // Find the closest WattSnatch session (within 15 minutes)
      const wsSession = dbInst.prepare(`
        SELECT id, kwh_solar FROM charge_sessions
        WHERE ABS(started_at - ?) < 900000
          AND ended_at IS NOT NULL
          AND teslamate_charge_id IS NULL
        ORDER BY ABS(started_at - ?) LIMIT 1
      `).get(tmStartMs, tmStartMs);

      if (!wsSession) continue;

      const totalKwh  = tmSession.charge_energy_added;
      const solarKwh  = wsSession.kwh_solar || 0;
      const gridKwh   = Math.max(0, Math.round((totalKwh - solarKwh) * 100) / 100);
      const gridCost  = Math.round(gridKwh * resolveRate(tmStartMs) * 100) / 100;

      updateStmt.run(tmSession.id, gridKwh, gridCost, wsSession.id);
      matched++;
    }

    res.json({ ok: true, matched, total_tm_sessions: sessions.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Solar provenance ─────────────────────────────────────────────────────────

// GET /api/stats/solar-provenance - lifetime solar charging headline stat
router.get('/api/stats/solar-provenance', (req, res) => {
  try {
    res.json({ ok: true, ...db.getSolarProvenance() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/trips - upcoming trip assessments for the dashboard
router.get('/api/trips', async (req, res) => {
  try {
    const calendar = require('../services/calendar');
    const tripPlanner = require('../services/tripPlanner');

    if (!calendar.isConfigured()) {
      return res.json({ ok: true, trips: [], configured: false });
    }

    const { assessments, lastRun } = tripPlanner.getAssessments();

    const trips = assessments.map(({ trip, assessment }) => ({
      summary:            trip.summary,
      location:           trip.location,
      departureTime:      trip.departureTime,
      hoursAway:          trip.hoursAway,
      eventDurationHours: trip.eventDurationHours,
      distanceKm:         trip.distanceKm,
      status:        assessment.status,
      message:       assessment.message,
      currentSocPct: assessment.currentSocPct,
      required:      assessment.required,
      deficit:       assessment.deficit,
      solarShortfall:assessment.solarShortfall,
      estimatedCost: assessment.estimatedCost,
      expectedSolar: assessment.expectedSolar,
    }));

    res.json({ ok: true, trips, configured: true, lastRun });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/trips/refresh - fire-and-forget calendar re-fetch.
// Responds immediately so the button isn't blocked for ~8s while iCloud responds.
// The client should reload trips after a short delay to pick up fresh data.
router.post('/api/trips/refresh', (req, res) => {
  const calendar    = require('../services/calendar');
  const tripPlanner = require('../services/tripPlanner');
  if (!calendar.isConfigured()) return res.json({ ok: false, error: 'iCloud not configured' });
  res.json({ ok: true, refreshing: true });
  calendar.poll()
    .then(() => tripPlanner.runOnce())
    .catch(err => require('../utils/logger').logEvent('warn', `[calendar] Manual refresh failed: ${err.message}`));
});

// ─── Eddi (myenergi) Controls ────────────────────────────────────────────────

// POST /api/eddi/backfill-boost?days=30
// Fetches myenergi daily history for recent days and writes missing boost_today_kwh.
router.post('/api/eddi/backfill-boost', async (req, res) => {
  try {
    const myenergi = require('../services/myenergi');
    const days     = Math.min(90, Math.max(1, parseInt(req.query.days || '30', 10)));
    const results  = await myenergi.backfillBoostHistory(days);
    const updated  = results.filter(r => !r.skipped && !r.error && r.boostKwh > 0).length;
    res.json({ ok: true, days, processed: results.length, updated, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/eddi/boost  { heater?: 1|2, minutes?: number }
// Start a manual hot-water boost. Defaults: heater 1, 60 minutes.
router.post('/api/eddi/boost', async (req, res) => {
  try {
    const myenergi = require('../services/myenergi');
    if (!myenergi.isConfigured()) return res.status(400).json({ ok: false, error: 'myenergi not configured' });
    const heater  = parseInt(req.body?.heater  || '1', 10);
    const minutes = parseInt(req.body?.minutes || '60', 10);
    const result  = await myenergi.boost(heater, minutes);
    // Force a fresh poll so the UI reflects the new state immediately
    setTimeout(() => myenergi.poll().catch(() => {}), 2000);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/eddi/stop-boost  { heater?: 1|2 }
// Stop an active manual boost and return to solar-divert mode.
router.post('/api/eddi/stop-boost', async (req, res) => {
  try {
    const myenergi = require('../services/myenergi');
    if (!myenergi.isConfigured()) return res.status(400).json({ ok: false, error: 'myenergi not configured' });
    const heater = parseInt(req.body?.heater || '1', 10);
    const result = await myenergi.stopBoost(heater);
    setTimeout(() => myenergi.poll().catch(() => {}), 2000);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/eddi/mode  { mode: 'eco' | 'stop' }
// eco  → mode 1 (solar divert / normal auto operation)
// stop → mode 0 (Eddi fully stopped, no divert or boost)
router.post('/api/eddi/mode', async (req, res) => {
  try {
    const myenergi = require('../services/myenergi');
    if (!myenergi.isConfigured()) return res.status(400).json({ ok: false, error: 'myenergi not configured' });
    const modeStr = req.body?.mode || 'eco';
    const modeNum = modeStr === 'stop' ? 0 : 1;
    const result  = await myenergi.setMode(modeNum);
    setTimeout(() => myenergi.poll().catch(() => {}), 2000);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Solcast Solar Forecasting ────────────────────────────────────────────────

// POST /api/solcast/fetch - manually trigger forecast fetch
router.post('/api/solcast/fetch', async (req, res) => {
  try {
    const solcast = require('../services/solcast');
    if (!solcast.canFetch()) {
      return res.json({ ok: false, error: 'Max 4 forecasts per day reached' });
    }
    const forecasts = await solcast.fetchForecast();
    res.json({ ok: true, forecasts_fetched: forecasts.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/solcast/forecast - get all current 48-hour forecasts
router.get('/api/solcast/forecast', (req, res) => {
  try {
    const solcast = require('../services/solcast');
    const forecasts   = solcast.getAllForecasts();
    const today       = solcast.getRemainingTodayForecast();
    const tomorrow    = solcast.getTomorrowForecast();
    const accuracy    = solcast.calculateForecastAccuracy();
    const dailyTotals = db.getSolcastDailyTotals();

    res.json({
      ok: true,
      forecasts,
      today_remaining_kwh: today,
      tomorrow_kwh: tomorrow,
      daily_totals: dailyTotals,   // [{day:'YYYY-MM-DD', kwh:N}, …] for all remaining days
      accuracy_ratio: accuracy.ratio,
      accuracy_message: accuracy.ratio > 1.15 ? '✨ Better than expected' : accuracy.ratio < 0.85 ? '⛅ Less than expected' : 'On track',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/solcast/tracking - get current intraday forecast tracking
router.get('/api/solcast/tracking', (req, res) => {
  try {
    const solcast = require('../services/solcast');
    const tracking = solcast.trackAndAdjustForecast();
    res.json({ ok: true, ...tracking });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Financial Ledger ─────────────────────────────────────────────────────

// GET /api/financial/dashboard - financial dashboard data
router.get('/api/financial/dashboard', (req, res) => {
  try {
    const month = parseInt(req.query.month, 10) || new Date().getMonth() + 1;
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();

    // Calculate billing period (1st-last of month)
    const start = new Date(year, month - 1, 1).toISOString().split('T')[0];
    const end = new Date(year, month, 0).toISOString().split('T')[0];

    // The current period comes from the same reconciled breakdown as the rest
    // of the Data page, NOT from financial_ledger. The ledger is built
    // incrementally once a night and has permanent holes on days its job never
    // ran (65 of 85 days on the development install), and it allocates solar
    // proportionally - the older method this release replaced. Reading it here
    // put a Bill Estimate card on the same screen as the savings panel,
    // disagreeing with it, both claiming to describe the same month.
    //
    // Running totals below still come from the ledger: they are a lifetime
    // figure with no equivalent single-period query, and the difference matters
    // far less there than it does beside the month it contradicts.
    const monthStartMs = new Date(year, month - 1, 1).getTime();
    const monthEndMs   = new Date(year, month, 1).getTime();
    const breakdown    = db.getEnergyBreakdownForPeriod(monthStartMs, monthEndMs);

    const totalImportCost   = breakdown.grid.import_cost;
    const totalExportCredit = breakdown.grid.export_credit;
    const totalSupplyCharge = breakdown.supply_charge_aud;
    const totalSolarAvoided = breakdown.est_savings_aud;
    const totalImportedKwh  = breakdown.grid.kwh_imported;
    const totalExportedKwh  = breakdown.grid.kwh_exported;
    const totalSolarSelfConsumed = breakdown.total_solar_kwh;

    const estimatedBill = breakdown.net_cost_aud;

    // Get running totals (since earliest ledger entry)
    const allLedger = db.getDb().prepare('SELECT * FROM financial_ledger ORDER BY date ASC').all();
    let cumulativeExportCredit = 0, cumulativeSolarAvoided = 0, cumulativeImportCost = 0, cumulativeSupplyCharge = 0;
    for (const entry of allLedger) {
      cumulativeExportCredit += entry.export_credit || 0;
      cumulativeSolarAvoided += entry.solar_avoided_cost || 0;
      cumulativeImportCost += entry.import_cost || 0;
      cumulativeSupplyCharge += entry.supply_charge || 0;
    }

    res.json({
      ok: true,
      period_start: start,
      period_end: end,
      period_label: new Date(year, month - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }),
      current_period: {
        imported_kwh: Math.round(totalImportedKwh * 100) / 100,
        exported_kwh: Math.round(totalExportedKwh * 100) / 100,
        solar_self_consumed_kwh: Math.round(totalSolarSelfConsumed * 100) / 100,
        import_cost: Math.round(totalImportCost * 100) / 100,
        export_credit: Math.round(totalExportCredit * 100) / 100,
        supply_charge: Math.round(totalSupplyCharge * 100) / 100,
        estimated_bill: Math.round(estimatedBill * 100) / 100,
        solar_avoided_cost: Math.round(totalSolarAvoided * 100) / 100,
      },
      running_totals: {
        total_export_earnings: Math.round(cumulativeExportCredit * 100) / 100,
        total_solar_avoided_cost: Math.round(cumulativeSolarAvoided * 100) / 100,
        total_net_benefit: Math.round((cumulativeExportCredit + cumulativeSolarAvoided) * 100) / 100,
      },
      // Still the raw per-day ledger rows, for anything wanting day-level
      // detail. Known to be incomplete on days its nightly job did not run -
      // which is exactly why the period totals above no longer come from it.
      daily_ledger: db.getFinancialLedgerForPeriod(start, end),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/financial/monthly-trend - savings vs spend, grouped by calendar month
router.get('/api/financial/monthly-trend', (req, res) => {
  try {
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 36);

    const now = new Date();
    const rangeStart = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
    const startDate = rangeStart.toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    const ledger = db.getFinancialLedgerForPeriod(startDate, endDate);

    // Bucket by "YYYY-MM"
    const buckets = new Map();
    for (const entry of ledger) {
      const key = entry.date.slice(0, 7);
      if (!buckets.has(key)) {
        buckets.set(key, { saved: 0, spent: 0, import_cost: 0, export_credit: 0, supply_charge: 0 });
      }
      const b = buckets.get(key);
      b.saved += entry.solar_avoided_cost || 0;
      b.spent += entry.net_cost || 0;
      b.import_cost += entry.import_cost || 0;
      b.export_credit += entry.export_credit || 0;
      b.supply_charge += entry.supply_charge || 0;
    }

    // Build a contiguous list of the last `months` calendar months, even if some have no data
    const trend = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const b = buckets.get(key) || { saved: 0, spent: 0, import_cost: 0, export_credit: 0, supply_charge: 0 };
      trend.push({
        month: key,
        label: d.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' }),
        saved: Math.round(b.saved * 100) / 100,
        spent: Math.round(b.spent * 100) / 100,
        import_cost: Math.round(b.import_cost * 100) / 100,
        export_credit: Math.round(b.export_credit * 100) / 100,
        supply_charge: Math.round(b.supply_charge * 100) / 100,
      });
    }

    res.json({ ok: true, months, trend });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Version check ──────────────────────────────────────────────────────────

let versionCheckCache = { data: null, fetchedAt: 0 };
const VERSION_CHECK_TTL_MS = 12 * 60 * 60 * 1000; // 12h - avoid hammering GitHub

// Compares two "x.y.z" version strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// GET /api/version/check - checks GitHub's public releases API (no auth, no
// personal data sent) for a newer tagged release. Server-side cached for
// VERSION_CHECK_TTL_MS so this never hits GitHub more than a couple of
// times a day regardless of how many browser tabs/pages call it.
router.get('/api/version/check', async (req, res) => {
  const pkg = require('../../package.json');
  try {
    if (db.getSetting('check_for_updates') === 'false') {
      return res.json({ ok: true, current: pkg.version, updateAvailable: false, disabled: true });
    }

    const now = Date.now();
    if (versionCheckCache.data && (now - versionCheckCache.fetchedAt) < VERSION_CHECK_TTL_MS) {
      return res.json({ ok: true, current: pkg.version, ...versionCheckCache.data });
    }

    const response = await fetch('https://api.github.com/repos/WattSnatch/wattsnatch/releases/latest', {
      headers: { 'User-Agent': 'wattsnatch-app', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
    const release = await response.json();
    const latest = String(release.tag_name || '').replace(/^v/, '');
    const updateAvailable = !!latest && compareVersions(latest, pkg.version) > 0;

    versionCheckCache = {
      data: { latest, updateAvailable, releaseUrl: release.html_url, releaseName: release.name || latest },
      fetchedAt: now,
    };
    res.json({ ok: true, current: pkg.version, ...versionCheckCache.data });
  } catch (err) {
    // Offline installs, GitHub outages, etc. should never surface as an error
    // in the UI - just report "no update info available".
    res.json({ ok: true, current: pkg.version, updateAvailable: false, error: err.message });
  }
});

// ─── Backup ───────────────────────────────────────────────────────────────

// GET /api/backup/download - streams a fresh, unencrypted backup zip
// (DB + keys/ + manifest). Kept as a plain GET so the existing <a download>
// link in Settings keeps working unchanged.
router.get('/api/backup/download', async (req, res) => {
  try {
    const { createBackupZipBuffer, backupFilename } = require('../services/backup');
    const buffer = await createBackupZipBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${backupFilename()}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/backup/download - same, but password-encrypts the zip first.
// A password in the body (not the URL) so it never ends up in server logs
// or browser history.
router.post('/api/backup/download', async (req, res) => {
  try {
    const password = (req.body && req.body.password || '').trim();
    if (!password) return res.status(400).json({ ok: false, error: 'Password is required.' });

    const { createBackupZipBuffer, backupFilename } = require('../services/backup');
    const buffer = await createBackupZipBuffer(password);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${backupFilename(new Date(), true)}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/backup/auto-status - summary of automatic backups on disk
router.get('/api/backup/auto-status', (req, res) => {
  try {
    const { getAutoBackupStatus } = require('../services/backup');
    const status = getAutoBackupStatus();
    res.json({
      ok: true,
      enabled: db.getSetting('auto_backup_enabled') !== 'false',
      lastBackupAt: parseInt(db.getSetting('last_auto_backup_at') || '0', 10) || null,
      ...status,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Panel Health (Phase 7) ───────────────────────────────────────────────────

// GET /api/panels/health - per-panel 7-day health status and trend
router.get('/api/panels/health', (req, res) => {
  try {
    const enphasePanels = require('../services/enphase-panels');
    const { panels, last_poll_at } = enphasePanels.getHealthStatus();

    // Apply user-defined nicknames (stored as JSON: { panel_id: "nickname" })
    let nicknames = {};
    try { nicknames = JSON.parse(db.getSetting('panel_nicknames') || '{}'); } catch (_) {}
    panels.forEach(p => { if (nicknames[p.panel_id]) p.label = nicknames[p.panel_id]; });

    const red   = panels.filter(p => p.health === 'red').length;
    const amber = panels.filter(p => p.health === 'amber').length;
    res.json({ ok: true, panels, last_poll_at, summary: { red, amber, total: panels.length } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/panels/poll - manually trigger a poll (useful for testing)
router.post('/api/panels/poll', async (req, res) => {
  try {
    const enphasePanels = require('../services/enphase-panels');
    await enphasePanels.pollAndStore();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/financial/fbt-log - export FBT charging log as CSV
router.get('/api/financial/fbt-log', (req, res) => {
  try {
    // FBT year is April 1 - March 31
    const today = new Date();
    let fbtYear = today.getFullYear();
    const aprilThisYear = new Date(fbtYear, 3, 1); // April 1 of current FY
    if (today < aprilThisYear) {
      fbtYear--; // If before April, we're in the previous FY
    }

    const fbtStart = new Date(fbtYear, 3, 1).toISOString().split('T')[0]; // April 1
    const fbtEnd = new Date(fbtYear + 1, 2, 31).toISOString().split('T')[0]; // March 31 next year

    const logs = db.getEvHomeChargingLogForPeriod(fbtStart, fbtEnd);

    // Generate CSV
    const csvLines = ['Date,kWh Charged,kWh from Solar,kWh from Grid,Cost Basis (AUD),Session Start,Session End'];
    for (const log of logs) {
      const cells = [
        log.date,
        (log.kwh_charged || 0).toFixed(2),
        (log.kwh_from_solar || 0).toFixed(2),
        (log.kwh_from_grid || 0).toFixed(2),
        (log.cost_basis || 0).toFixed(2),
        log.session_start || '',
        log.session_end || '',
      ];
      csvLines.push(cells.join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="FBT-Charging-Log-${fbtYear}-${fbtYear + 1}.csv"`);
    res.send(csvLines.join('\n'));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Phase 8 - Day Replay
router.get('/api/replay/today', async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD local time
    let replay = db.getDayReplayByDate(today);
    if (!replay) {
      // Build on-demand - no need to wait for sunset
      const dayReplay = require('../services/dayReplay');
      await dayReplay.generateDayReplay(today);
      replay = db.getDayReplayByDate(today);
    }
    if (!replay) {
      return res.json({ ok: true, replay: null, message: 'No telemetry data yet for today' });
    }
    res.json({ ok: true, replay: replay.data || JSON.parse(replay.data_json) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/api/replay/date/:date', (req, res) => {
  try {
    const { date } = req.params;
    const replay = db.getDayReplayByDate(date);
    if (!replay) {
      return res.json({ ok: true, replay: null, message: `No replay available for ${date}` });
    }
    res.json({ ok: true, replay: replay.data || JSON.parse(replay.data_json) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/api/replay/latest', (req, res) => {
  try {
    const replay = db.getLatestDayReplay();
    if (!replay) {
      return res.json({ ok: true, replay: null, message: 'No replays available' });
    }
    res.json({ ok: true, replay: replay.data || JSON.parse(replay.data_json) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Manual trigger to generate replay for a specific date (for testing/backfill)
router.post('/api/replay/generate', (req, res) => {
  try {
    const { date } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.json({ ok: false, error: 'Invalid date format, expected YYYY-MM-DD' });
    }

    const dayReplay = require('../services/dayReplay');
    const result = dayReplay.generateDayReplay(date);

    if (!result) {
      return res.json({ ok: true, message: `No data available to generate replay for ${date}` });
    }

    res.json({ ok: true, replay: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/stats/solar-km - solar/grid/public km driven, per period
router.get('/api/stats/solar-km', async (req, res) => {
  try {
    const now          = new Date();
    const todayStart   = new Date(now); todayStart.setHours(0,0,0,0);
    const weekStart    = new Date(now); weekStart.setDate(weekStart.getDate() - (weekStart.getDay() + 6) % 7); weekStart.setHours(0,0,0,0);
    const monthStart   = new Date(now.getFullYear(), now.getMonth(), 1);
    const quarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const yearStart    = new Date(now.getFullYear(), 0, 1);
    const wattsnatchStart = new Date('2026-05-20T00:00:00+10:00').getTime();
    const nowMs        = now.getTime();

    const teslamate   = require('../services/teslamate');
    const effData     = await teslamate.getEfficiencyKwhPerKm();
    const effKwhPerKm = effData?.kwh_per_km || 0.155;
    const kmPerKwh    = effData ? effData.km_per_kwh : Math.round((1 / effKwhPerKm) * 10) / 10;

    const periodBoundaries = [
      { key: 'today',   startMs: todayStart.getTime(),   endMs: nowMs },
      { key: 'week',    startMs: weekStart.getTime(),    endMs: nowMs },
      { key: 'month',   startMs: monthStart.getTime(),   endMs: nowMs },
      { key: 'quarter', startMs: quarterStart.getTime(), endMs: nowMs },
      { key: 'year',    startMs: yearStart.getTime(),    endMs: nowMs },
    ];
    for (const [key, { start, end }] of Object.entries(getExtendedBoundaries(req))) {
      periodBoundaries.push({ key, startMs: start, endMs: end });
    }

    // All-time solar fraction - fallback when no charging happened in the selected period
    const allTimeSolar   = db.getSolarKwhCharged(wattsnatchStart, nowMs);
    const allTimeEv      = db.getPeriodStats(wattsnatchStart, nowMs);
    const allTimeCharged = allTimeSolar + (allTimeEv.grid_kwh || 0);
    const allTimeSolarFrac = allTimeCharged > 0 ? allTimeSolar / allTimeCharged : 0.8;

    // Fetch actual km driven + public kWh in parallel across all periods
    const [drivenKmResults, publicKwhResults] = await Promise.all([
      Promise.all(periodBoundaries.map(p =>
        teslamate.getDrivenKmInPeriod(Math.max(p.startMs, wattsnatchStart), p.endMs)
      )),
      Promise.all(periodBoundaries.map(p =>
        teslamate.getPublicChargeKwh(Math.max(p.startMs, wattsnatchStart), p.endMs)
      )),
    ]);

    const toKm = (kwh) => effKwhPerKm > 0 ? Math.round(kwh / effKwhPerKm) : 0;

    const periods = {};
    for (let i = 0; i < periodBoundaries.length; i++) {
      const { key, startMs, endMs } = periodBoundaries[i];
      const effectiveStart   = Math.max(startMs, wattsnatchStart);

      const solar_kwh    = db.getSolarKwhCharged(effectiveStart, endMs);
      const evStats      = db.getPeriodStats(effectiveStart, endMs);
      const grid_kwh     = Math.round((evStats.grid_kwh || 0) * 100) / 100;
      const public_kwh   = publicKwhResults[i] ?? null;
      const total_km     = drivenKmResults[i] || 0;

      // Solar fraction: use period charge sessions only when > 1 kWh charged (avoids
      // telemetry noise like 0.02 kWh making the fraction 0/0.02 = 0% solar)
      const home_charged = solar_kwh + grid_kwh;
      const solarFrac    = home_charged > 1.0 ? solar_kwh / home_charged : allTimeSolarFrac;

      // Public km from TeslaMate charging processes
      const public_km  = public_kwh != null ? toKm(public_kwh) : null;
      // Home-charged portion of total driven km
      const home_km    = Math.max(0, total_km - (public_km || 0));
      const solar_km   = Math.round(home_km * solarFrac);
      const grid_km    = home_km - solar_km;

      periods[key] = {
        solar_kwh,
        solar_km,
        grid_kwh,
        grid_km,
        public_kwh,
        public_km,
        total_km,
      };
    }

    res.json({
      ok: true,
      efficiency_kwh_per_km: effKwhPerKm,
      km_per_kwh:            kmPerKwh,
      tracking_since:        '20 May 2026',
      periods,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Departure Scheduler ───────────────────────────────────────────────────────

// GET /api/departure - return active departure (or null)
router.get('/api/departure', (req, res) => {
  try {
    const departureScheduler = require('../services/departureScheduler');
    const dep = departureScheduler.getActiveDeparture();
    res.json({ ok: true, departure: dep });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/departure - set a new departure
// body: { departure_time: <ISO string or Unix ms>, target_soc: 80, notes: "optional" }
router.post('/api/departure', (req, res) => {
  try {
    const departureScheduler = require('../services/departureScheduler');
    const { departure_time, target_soc, notes } = req.body;
    if (!departure_time) return res.status(400).json({ ok: false, error: 'departure_time is required' });
    if (!target_soc)     return res.status(400).json({ ok: false, error: 'target_soc is required' });

    const tsMs = typeof departure_time === 'number' ? departure_time : new Date(departure_time).getTime();
    if (isNaN(tsMs)) return res.status(400).json({ ok: false, error: 'Invalid departure_time' });

    departureScheduler.setDeparture(tsMs, parseInt(target_soc, 10), notes || null);
    const dep = departureScheduler.getActiveDeparture();
    res.json({ ok: true, departure: dep });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// DELETE /api/departure - cancel the active departure
router.delete('/api/departure', (req, res) => {
  try {
    const departureScheduler = require('../services/departureScheduler');
    departureScheduler.clearDeparture();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Retailer Comparison ───────────────────────────────────────────────────────

// GET /api/retailer-comparison?days=90
router.get('/api/retailer-comparison', (req, res) => {
  try {
    const retailerComparison = require('../services/retailerComparison');
    const days = Math.min(365, Math.max(7, parseInt(req.query.days || '90', 10)));
    const result = retailerComparison.compareRetailers(days);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/retailer-rates/refresh - manually trigger a live plan-data fetch
// from the AER's Consumer Data Right register. Also runs automatically once
// per day from the controller loop; this exists for "refresh now" in the UI.
let _retailerRefreshInProgress = false;
router.post('/api/retailer-rates/refresh', async (req, res) => {
  if (_retailerRefreshInProgress) {
    return res.status(409).json({ ok: false, error: 'A refresh is already in progress.' });
  }
  _retailerRefreshInProgress = true;
  try {
    const retailerRates = require('../services/retailerRates');
    await retailerRates.refreshLiveRates();
    const live = retailerRates.getLiveRates();
    res.json({ ok: true, retailerCount: live ? live.retailers.length : 0, fetchedAt: live ? live.fetchedAt : null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    _retailerRefreshInProgress = false;
  }
});

// GET /api/stats/hourly-profile?days=30
router.get('/api/stats/hourly-profile', (req, res) => {
  try {
    const days   = Math.min(365, Math.max(7, parseInt(req.query.days || '30', 10)));
    const endMs  = Date.now();
    const startMs = endMs - days * 24 * 60 * 60 * 1000;
    const hours  = db.getHourlyProfile(startMs, endMs);
    res.json({ ok: true, days, hours });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/stats/heatmap?days=30&metric=solar_excess|ev
// Day-of-week x hour-of-day average watts, for the Data page's heatmap chart.
router.get('/api/stats/heatmap', (req, res) => {
  try {
    const metric = req.query.metric === 'ev' ? 'ev' : 'solar_excess';
    const days   = Math.min(365, Math.max(7, parseInt(req.query.days || '30', 10)));
    const endMs  = Date.now();
    const startMs = endMs - days * 24 * 60 * 60 * 1000;
    const cells  = db.getHeatmapProfile(startMs, endMs, metric);
    res.json({ ok: true, days, metric, cells });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Weather & Grid Intelligence ───────────────────────────────────────────────

// GET /api/weather - current weather + forecast
router.get('/api/weather', (req, res) => {
  try {
    const weatherGrid = require('../services/weatherGrid');
    const data = weatherGrid.getWeather();
    res.json({ ok: true, weather: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/carbon-intensity - live QLD1 grid carbon intensity
router.get('/api/carbon-intensity', (req, res) => {
  try {
    const weatherGrid = require('../services/weatherGrid');
    const data = weatherGrid.getGridIntensity();
    // notConfigured is a distinct "nothing to show yet" state, not real data -
    // send null so the dashboard's existing `if (!gi) return` no-ops instead
    // of rendering misleading 0 g/kWh, 0% renewable values.
    res.json({ ok: true, intensity: (data && data.notConfigured) ? null : data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/ercot-price - live Texas real-time wholesale price (supplementary
// signal only, best-effort, off by default - see src/services/ercotPricing.js)
router.get('/api/ercot-price', (req, res) => {
  try {
    const ercotPricing = require('../services/ercotPricing');
    const data = ercotPricing.getCachedPrice();
    res.json({ ok: true, price: (data && data.notConfigured) ? null : data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/weather/refresh - force an immediate weather+grid refresh
router.post('/api/weather/refresh', async (req, res) => {
  try {
    const weatherGrid = require('../services/weatherGrid');
    const [weather, intensity] = await Promise.allSettled([
      weatherGrid.fetchWeather(),
      weatherGrid.fetchGridIntensity(),
    ]);
    res.json({
      ok: true,
      weather:   weather.status   === 'fulfilled' ? weather.value   : { error: weather.reason?.message },
      intensity: intensity.status === 'fulfilled' ? intensity.value : { error: intensity.reason?.message },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/ai-insights - return cached AI insight
router.get('/api/ai-insights', (req, res) => {
  try {
    const aiInsights = require('../services/aiInsights');
    res.json({ ok: true, ...aiInsights.getInsight() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/ai-insights/refresh - trigger immediate regeneration
router.post('/api/ai-insights/refresh', async (req, res) => {
  try {
    const apiKey = db.getSetting('gemini_api_key');
    if (!apiKey) return res.status(400).json({ ok: false, error: 'Gemini API key not configured' });
    const aiInsights = require('../services/aiInsights');
    const text = await aiInsights.generateInsight();
    res.json({ ok: true, text });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
