/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const mqtt = require('mqtt');
const db = require('../db');

let _client = null;
let _connected = false;
let _lastError = null;

// One entry per published power topic. Used to publish Home Assistant MQTT
// Discovery configs so sensors auto-create without any manual HA-side setup
// (and survive a full HA rebuild, since the discovery payload is retained on
// the broker, not in HA's own state).
const SENSORS = [
  { key: 'solar',       name: 'Solar Power',       topic: 'wattsnatch/power/solar' },
  { key: 'grid',        name: 'Grid Power',        topic: 'wattsnatch/power/grid' },
  { key: 'consumption', name: 'Consumption Power', topic: 'wattsnatch/power/consumption' },
  { key: 'ev',          name: 'EV Power',          topic: 'wattsnatch/power/ev' },
  { key: 'eddi',        name: 'Eddi Power',        topic: 'wattsnatch/power/eddi' },
  { key: 'house',       name: 'House Power',       topic: 'wattsnatch/power/house' },
];

// Daily energy totals (kWh), reusing the exact same todayKwh object the
// controller already computes every tick for the dashboard/embed SSE feed -
// no separate query, so this adds no DB load. state_class 'total_increasing'
// (not 'measurement') is what tells Home Assistant's own Energy Dashboard
// this is a resettable daily counter: HA watches for the value dropping back
// toward 0 at midnight as the signal of a new accounting period, which is
// exactly how todayKwh already behaves (see controller.js's baseline logic).
const DAILY_ENERGY_SENSORS = [
  { key: 'energy_today_solar',        name: 'Solar Generated Today',    topic: 'wattsnatch/energy_today/solar',        field: 'solar' },
  { key: 'energy_today_grid_import',  name: 'Grid Import Today',        topic: 'wattsnatch/energy_today/grid_import',  field: 'gridImport' },
  { key: 'energy_today_grid_export',  name: 'Grid Export Today',        topic: 'wattsnatch/energy_today/grid_export',  field: 'gridExport' },
  { key: 'energy_today_ev',           name: 'EV Charged Today',         topic: 'wattsnatch/energy_today/ev',           field: 'ev' },
  { key: 'energy_today_hot_water',    name: 'Hot Water Today',          topic: 'wattsnatch/energy_today/hot_water',    field: 'hw' },
  { key: 'energy_today_hw_boost',     name: 'Hot Water Boost Today',    topic: 'wattsnatch/energy_today/hw_boost',     field: 'hwBoost' },
  { key: 'energy_today_house',        name: 'House Usage Today',        topic: 'wattsnatch/energy_today/house',        field: 'house' },
];

// Car entities - grouped under their own HA device ("WattSnatch Car") rather
// than the power-flow device above, since they represent the vehicle itself
// rather than the household's energy flow. Sourced from src/services/telemetry.js
// (Fleet Telemetry, the same source the controller already uses for every
// charge decision) plus the controller's own home/away geofence result - no
// separate Tesla API polling, so this doesn't add any load or new credentials.
const CAR_NUMERIC_SENSORS = [
  { key: 'car_battery',       name: 'Battery Level',  topic: 'wattsnatch/car/battery',       unit: '%',   deviceClass: 'battery',    stateClass: 'measurement' },
  { key: 'car_charge_limit',  name: 'Charge Limit',   topic: 'wattsnatch/car/charge_limit',  unit: '%',   deviceClass: null,         stateClass: 'measurement' },
  { key: 'car_charge_amps',   name: 'Charge Amps',    topic: 'wattsnatch/car/charge_amps',   unit: 'A',   deviceClass: 'current',    stateClass: 'measurement' },
  { key: 'car_charger_power', name: 'Charger Power',  topic: 'wattsnatch/car/charger_power', unit: 'kW',  deviceClass: 'power',      stateClass: 'measurement' },
];
const CAR_TEXT_SENSORS = [
  { key: 'car_charging_state', name: 'Charging State', topic: 'wattsnatch/car/charging_state' },
];
const CAR_BINARY_SENSORS = [
  { key: 'car_online', name: 'Online',    topic: 'wattsnatch/car/online', deviceClass: 'connectivity' },
  { key: 'car_home',   name: 'Home',      topic: 'wattsnatch/car/home',   deviceClass: 'presence' },
];
const CAR_DEVICE_TRACKER_TOPIC       = 'wattsnatch/car/tracker/state';
const CAR_DEVICE_TRACKER_ATTRS_TOPIC = 'wattsnatch/car/tracker/attributes';

// Money - what each load cost from the grid and what solar saved it, for today, this month
// and this year, grouped under their own HA device ("WattSnatch Costs"). Every figure comes
// from db.getEnergyBreakdownForPeriod, the same reconciled breakdown the Data page's
// Saved/Spent panel reads, so HA shows the same numbers to the cent, and the per-load spend
// adds up to the metered import cost rather than to three separate estimates.
//
// One retained JSON message per period carries every figure plus the period start; each
// sensor picks its field out with a value_template. state_class 'total' with a last_reset is
// what HA requires for a monetary counter that starts again each day, month or year (it does
// not accept 'total_increasing' for money, and net cost can go negative on a sunny day).
//
// The year takes about 0.6 s to work out on a year of 10-second readings, during which the
// charging loop waits, so it is refreshed every 15 minutes; today and this month take
// milliseconds and are refreshed every minute.
const COST_PERIODS = [
  { key: 'today', label: 'Today',      refreshMs: 60 * 1000,      start: (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()) },
  { key: 'month', label: 'This Month', refreshMs: 60 * 1000,      start: (d) => new Date(d.getFullYear(), d.getMonth(), 1) },
  { key: 'year',  label: 'This Year',  refreshMs: 15 * 60 * 1000, start: (d) => new Date(d.getFullYear(), 0, 1) },
];
const COST_FIGURES = [
  { key: 'car_spent',       name: 'Car Spent' },
  { key: 'car_saved',       name: 'Car Saved' },
  { key: 'hot_water_spent', name: 'Hot Water Spent' },
  { key: 'hot_water_saved', name: 'Hot Water Saved' },
  { key: 'house_spent',     name: 'House Spent' },
  { key: 'house_saved',     name: 'House Saved' },
  { key: 'total_spent',     name: 'Total Spent' },      // grid import cost, all loads
  { key: 'total_saved',     name: 'Total Saved' },      // solar used on site, at the import rate
  { key: 'export_credit',   name: 'Export Credit' },
  { key: 'supply_charge',   name: 'Supply Charge' },
  { key: 'net_cost',        name: 'Net Cost' },         // import + supply - export credit: the bill
];
const COST_CHECK_MS = 60 * 1000;
const costTopic = (period) => `wattsnatch/costs/${period}`;

let _costTimer = null;
let _costPublished = {};   // period key -> { start, at }
let _lastCostError = null;

function _publishDiscovery() {
  const device = {
    identifiers: ['wattsnatch'],
    name: 'WattSnatch',
    manufacturer: 'WattSnatch',
  };
  for (const s of SENSORS) {
    const config = {
      name: s.name,
      unique_id: `wattsnatch_${s.key}`,
      state_topic: s.topic,
      unit_of_measurement: 'W',
      device_class: 'power',
      state_class: 'measurement',
      device,
    };
    _client.publish(
      `homeassistant/sensor/wattsnatch_${s.key}/config`,
      JSON.stringify(config),
      { retain: true }
    );
  }
  for (const s of DAILY_ENERGY_SENSORS) {
    const config = {
      name: s.name,
      unique_id: `wattsnatch_${s.key}`,
      state_topic: s.topic,
      unit_of_measurement: 'kWh',
      device_class: 'energy',
      state_class: 'total_increasing',
      device,
    };
    _client.publish(`homeassistant/sensor/wattsnatch_${s.key}/config`, JSON.stringify(config), { retain: true });
  }

  const carDevice = {
    identifiers: ['wattsnatch_car'],
    name: 'WattSnatch Car',
    manufacturer: 'WattSnatch',
  };
  for (const s of CAR_NUMERIC_SENSORS) {
    const config = {
      name: s.name,
      unique_id: `wattsnatch_${s.key}`,
      state_topic: s.topic,
      unit_of_measurement: s.unit,
      state_class: s.stateClass,
      device: carDevice,
    };
    if (s.deviceClass) config.device_class = s.deviceClass;
    _client.publish(`homeassistant/sensor/wattsnatch_${s.key}/config`, JSON.stringify(config), { retain: true });
  }
  for (const s of CAR_TEXT_SENSORS) {
    const config = {
      name: s.name,
      unique_id: `wattsnatch_${s.key}`,
      state_topic: s.topic,
      device: carDevice,
    };
    _client.publish(`homeassistant/sensor/wattsnatch_${s.key}/config`, JSON.stringify(config), { retain: true });
  }
  for (const s of CAR_BINARY_SENSORS) {
    const config = {
      name: s.name,
      unique_id: `wattsnatch_${s.key}`,
      state_topic: s.topic,
      device_class: s.deviceClass,
      payload_on: 'ON',
      payload_off: 'OFF',
      device: carDevice,
    };
    _client.publish(`homeassistant/binary_sensor/wattsnatch_${s.key}/config`, JSON.stringify(config), { retain: true });
  }
  // device_tracker: shows the car on HA's map (when lat/lon are known) and
  // drives zone-based automations the same way a native Tesla integration's
  // device_tracker would.
  _client.publish('homeassistant/device_tracker/wattsnatch_car/config', JSON.stringify({
    name: 'Location',
    unique_id: 'wattsnatch_car_tracker',
    state_topic: CAR_DEVICE_TRACKER_TOPIC,
    json_attributes_topic: CAR_DEVICE_TRACKER_ATTRS_TOPIC,
    source_type: 'gps',
    device: carDevice,
  }), { retain: true });

  const costDevice = {
    identifiers: ['wattsnatch_costs'],
    name: 'WattSnatch Costs',
    manufacturer: 'WattSnatch',
  };
  for (const p of COST_PERIODS) {
    for (const f of COST_FIGURES) {
      _client.publish(`homeassistant/sensor/wattsnatch_cost_${p.key}_${f.key}/config`,
        JSON.stringify(_costDiscoveryConfig(p, f, costDevice)), { retain: true });
    }
  }
}

function _currencyCode() {
  return db.getSetting('country') === 'US' ? 'USD' : 'AUD';
}

function _costDiscoveryConfig(period, figure, device) {
  return {
    name: `${figure.name} ${period.label}`,
    unique_id: `wattsnatch_cost_${period.key}_${figure.key}`,
    state_topic: costTopic(period.key),
    value_template: `{{ value_json.${figure.key} }}`,
    last_reset_value_template: '{{ value_json.last_reset }}',
    unit_of_measurement: _currencyCode(),
    device_class: 'monetary',
    state_class: 'total',
    suggested_display_precision: 2,
    device,
  };
}

// The message for one period, from a getEnergyBreakdownForPeriod result. Pure, for testing.
// A load with nothing recorded in the period (no Eddi, or the car never charged) is absent
// from the breakdown's categories and reads 0 here rather than leaving the sensor unknown.
function _costPayload(b, startMs) {
  const cat = (key) => b.categories.find((c) => c.key === key) || {};
  const car = cat('car');
  const hw = cat('hot_water');
  const house = cat('house');
  return {
    last_reset:      new Date(startMs).toISOString(),
    car_spent:       car.grid_cost_aud     || 0,
    car_saved:       car.est_savings_aud   || 0,
    hot_water_spent: hw.grid_cost_aud      || 0,
    hot_water_saved: hw.est_savings_aud    || 0,
    house_spent:     house.grid_cost_aud   || 0,
    house_saved:     house.est_savings_aud || 0,
    total_spent:     b.grid.import_cost,
    total_saved:     b.est_savings_aud,
    export_credit:   b.grid.export_credit,
    supply_charge:   b.supply_charge_aud,
    net_cost:        b.net_cost_aud,
  };
}

// Publishes each period that is due: on its refresh interval, or straight away when the period
// itself has rolled over (midnight, the 1st, 1 January). `force` republishes everything, used
// on (re)connect so HA never waits for the next interval.
function publishCosts({ force = false, now = new Date() } = {}) {
  if (!_connected) return;
  for (const p of COST_PERIODS) {
    const startMs = p.start(now).getTime();
    const last = _costPublished[p.key];
    const due = force || !last || last.start !== startMs || (now.getTime() - last.at) >= p.refreshMs;
    if (!due) continue;
    try {
      const b = db.getEnergyBreakdownForPeriod(startMs, now.getTime());
      _client.publish(costTopic(p.key), JSON.stringify(_costPayload(b, startMs)), { retain: true });
      _costPublished[p.key] = { start: startMs, at: now.getTime() };
      _lastCostError = null;
    } catch (err) {
      // Best effort, like every other publish here: a failed calculation must never touch
      // charging. Kept for getState() so it is visible, and retried on the next check.
      _lastCostError = err.message;
    }
  }
}

function _getClient() {
  if (_client) return _client;
  const brokerUrl = db.getSetting('mqtt_broker_url');
  if (!brokerUrl) return null;
  _client = mqtt.connect(brokerUrl, {
    username: db.getSetting('mqtt_username') || undefined,
    password: db.getSetting('mqtt_password') || undefined,
    clientId: 'wattsnatch-' + Math.random().toString(16).slice(2, 8),
    reconnectPeriod: 5000,
    connectTimeout: 10000,
  });
  _client.on('connect', () => { _connected = true; _lastError = null; _publishDiscovery(); publishCosts({ force: true }); });
  _client.on('close',   () => { _connected = false; });
  // Publishing stays best-effort (a broker outage must never affect charging),
  // but the error itself is now kept for getState() rather than discarded,
  // otherwise a typo'd broker URL fails completely silently forever.
  _client.on('error',   (err) => { _lastError = err.message; });
  return _client;
}

// Call once at startup to establish the connection proactively.
function start() {
  _getClient();
  if (!_costTimer) {
    _costTimer = setInterval(() => publishCosts(), COST_CHECK_MS);
    _costTimer.unref();
  }
}

// Tear down and reconnect against whatever mqtt_broker_url/username/password
// currently say, called after a settings change so editing these in Settings
// takes effect immediately, without needing a full app restart.
function restart() {
  stop();
  start();
}

// Status for the Settings UI. Never exposes the password.
function getState() {
  return {
    configured: !!db.getSetting('mqtt_broker_url'),
    connected:  _connected,
    brokerUrl:  db.getSetting('mqtt_broker_url') || null,
    lastError:  _lastError,
    costError:  _lastCostError,
  };
}

// Isolated one-shot connectivity test for the Settings UI. Uses its own
// short-lived client so it works even before the persistent publisher is
// configured/connected, and never disturbs the real connection.
async function testConnection() {
  const brokerUrl = db.getSetting('mqtt_broker_url');
  if (!brokerUrl) return { ok: false, error: 'Enter the broker URL first' };

  return new Promise((resolve) => {
    let done = false;
    let client;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (client) client.end(true); } catch (_) {}
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'Timed out waiting to connect. Check the broker URL and that it is reachable from this machine.' });
    }, 8000);

    try {
      client = mqtt.connect(brokerUrl, {
        username: db.getSetting('mqtt_username') || undefined,
        password: db.getSetting('mqtt_password') || undefined,
        clientId: 'wattsnatch-outtest-' + Math.random().toString(16).slice(2, 8),
        reconnectPeriod: 0,
        connectTimeout: 8000,
      });
    } catch (err) {
      return finish({ ok: false, error: `Invalid broker URL: ${err.message}` });
    }

    client.on('connect', () => finish({ ok: true }));
    client.on('error', (err) => finish({ ok: false, error: `Broker error: ${err.message}` }));
  });
}

function publish(solar, grid, consumption, ev, eddi) {
  if (!_connected) return;
  const house = Math.max(0, consumption - ev - eddi);
  const topics = {
    'wattsnatch/power/solar':       Math.round(solar),
    'wattsnatch/power/grid':        Math.round(grid),
    'wattsnatch/power/consumption': Math.round(consumption),
    'wattsnatch/power/ev':          Math.round(ev),
    'wattsnatch/power/eddi':        Math.round(eddi),
    'wattsnatch/power/house':       Math.round(house),
  };
  for (const [topic, value] of Object.entries(topics)) {
    _client.publish(topic, String(value), { retain: true });
  }
}

// Publishes the car's current state to MQTT/HA. `state` is exactly the
// shape returned by src/services/telemetry.js's getState() (the same data
// every charge decision already reads - no separate Tesla API polling here).
// `isAtHome` is the controller's own geofence result, since that already
// accounts for the configured home radius rather than reinventing it.
function publishCar(state, isAtHome) {
  if (!_connected || !state) return;

  const online = !!state.isOnline;
  _client.publish('wattsnatch/car/online', online ? 'ON' : 'OFF', { retain: true });

  // Everything else is only meaningful while the car has reported in at
  // least once - publishing 0/"unknown" over real stale data would be worse
  // than just not updating, so skip rather than guess.
  if (!state.lastUpdated) return;

  _client.publish('wattsnatch/car/battery',        String(Math.round(state.batteryPct ?? 0)), { retain: true });
  _client.publish('wattsnatch/car/charge_limit',   String(Math.round(state.chargeLimit ?? 0)), { retain: true });
  _client.publish('wattsnatch/car/charge_amps',    String(Math.round(state.chargeAmps ?? 0)), { retain: true });
  _client.publish('wattsnatch/car/charger_power',  String(Math.round((state.chargerPowerKw ?? 0) * 100) / 100), { retain: true });
  _client.publish('wattsnatch/car/charging_state', state.chargingState || 'Unknown', { retain: true });
  _client.publish('wattsnatch/car/home', isAtHome ? 'ON' : 'OFF', { retain: true });

  _client.publish(CAR_DEVICE_TRACKER_TOPIC, isAtHome ? 'home' : 'not_home', { retain: true });
  if (state.latitude != null && state.longitude != null) {
    _client.publish(CAR_DEVICE_TRACKER_ATTRS_TOPIC, JSON.stringify({
      latitude: state.latitude,
      longitude: state.longitude,
    }), { retain: true });
  }
}

// Publishes today's cumulative energy totals (kWh). `todayKwh` is exactly the
// object the controller already builds every tick for the dashboard/embed SSE
// feed (see controller.js's _emitSSE call) - passed straight through here
// rather than recomputed, so this stays free: no extra DB query, and the HA
// numbers can never drift from what WattSnatch's own UI shows for the same day.
function publishDailyTotals(todayKwh) {
  if (!_connected || !todayKwh) return;
  for (const s of DAILY_ENERGY_SENSORS) {
    const value = todayKwh[s.field];
    if (value == null) continue;
    _client.publish(s.topic, String(value), { retain: true });
  }
}

function stop() {
  if (_costTimer) {
    clearInterval(_costTimer);
    _costTimer = null;
  }
  _costPublished = {};
  if (_client) {
    _client.end();
    _client = null;
    _connected = false;
  }
}

module.exports = {
  start, stop, restart, publish, publishCar, publishDailyTotals, publishCosts, getState, testConnection,
  COST_PERIODS, COST_FIGURES, _costPayload, _costDiscoveryConfig,
  _setClientForTests: (client) => { _client = client; _connected = !!client; _costPublished = {}; },
};
