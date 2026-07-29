/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// MQTT-input meter provider - "bring your own data."
//
// For anyone whose inverter WattSnatch doesn't natively support yet: publish your
// live solar and grid (or house-consumption) power to any MQTT broker, point this
// provider at those topics, and WattSnatch drives charging from them exactly as it
// would from a native gateway.
//
// It conforms to the same meter contract as enphase/fronius/solaredge:
//   fetchReadings() -> { solarW, consumptionW, gridW, solarActEnergyDlvdWh, timestamp }
//
// Correctness model - the important part:
//   MQTT is push/async, but the controller polls fetchReadings() synchronously every
//   tick. So we hold a persistent subscription, cache the newest value per topic, and
//   serve the cache. Critically, if the feed goes silent (broker down, source device
//   offline, network drop) fetchReadings() THROWS rather than returning a stale value.
//   The controller treats that throw identically to a dead gateway - it will not keep
//   adjusting the charge rate off frozen numbers. Serving stale data would be the one
//   unacceptable bug here, so staleness is a hard failure, not a silent pass.

const mqtt   = require('mqtt');
const db     = require('../../db');
const logger = require('../../utils/logger');

let _client = null;
let _connected = false;
let _subscribedKey = '';                 // "broker|solarTopic|secondTopic" currently wired up
let _solar  = { value: null, at: 0 };    // latest solar reading + arrival time (ms)
let _second = { value: null, at: 0 };    // latest grid-or-consumption reading + arrival time

// ── Config ────────────────────────────────────────────────────────────────────

function _finitePositive(raw, fallback) {
  const n = parseFloat(raw);
  return (Number.isFinite(n) && n > 0) ? n : fallback;
}

function _cfg() {
  return {
    brokerUrl:   db.getSetting('mqtt_in_broker_url')     || '',
    username:    db.getSetting('mqtt_in_username')        || '',
    password:    db.getSetting('mqtt_in_password')        || '',
    topicSolar:  db.getSetting('mqtt_in_topic_solar')     || '',
    secondType: (db.getSetting('mqtt_in_second_type')     || 'grid'),           // 'grid' | 'consumption'
    topicSecond: db.getSetting('mqtt_in_topic_second')    || '',
    gridSign:   (db.getSetting('mqtt_in_grid_sign')       || 'import_positive'), // 'import_positive' | 'export_positive'
    scale:       _finitePositive(db.getSetting('mqtt_in_scale'), 1),            // multiply payload → watts (use 1000 for kW)
    staleMs:     _finitePositive(db.getSetting('mqtt_in_stale_seconds'), 60) * 1000,
  };
}

function isConfigured() {
  const c = _cfg();
  return !!(c.brokerUrl && c.topicSolar && c.topicSecond);
}

function _isActive() {
  return (db.getSetting('inverter_brand') || 'enphase') === 'mqtt';
}

// ── Payload parsing ─────────────────────────────────────────────────────────────
// Topics must publish a plain numeric watt value ("1234", "1234.5", even "1234.5 W").
// Anything non-numeric (JSON objects, "ON", empty) is ignored so it can never corrupt
// the cache - and because a topic that only ever sends garbage will still go stale and
// be caught, rather than silently feeding zeros.

function _parsePayload(buf) {
  const s = buf.toString().trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// ── Connection lifecycle ────────────────────────────────────────────────────────

function _clearCache() {
  _solar  = { value: null, at: 0 };
  _second = { value: null, at: 0 };
}

function _connect(c) {
  const topics = [c.topicSolar, c.topicSecond];
  _client = mqtt.connect(c.brokerUrl, {
    username: c.username || undefined,
    password: c.password || undefined,
    clientId: 'wattsnatch-in-' + Math.random().toString(16).slice(2, 8),
    reconnectPeriod: 5000,
    connectTimeout: 10000,
  });

  // mqtt.js re-emits 'connect' on every (re)connection, so subscribing here also
  // re-subscribes automatically after any drop - no separate reconnect handling needed.
  _client.on('connect', () => {
    _connected = true;
    _client.subscribe(topics, { qos: 0 }, (err) => {
      if (err) logger.logEvent('api_error', `[mqtt-in] subscribe failed: ${err.message}`);
    });
  });
  _client.on('close',   () => { _connected = false; });
  _client.on('offline', () => { _connected = false; });
  _client.on('error',   () => { /* swallow - reconnectPeriod handles retries; fetchReadings surfaces the outage */ });
  _client.on('message', (topic, buf) => {
    const cfg = _cfg();
    const n = _parsePayload(buf);
    if (n === null) return;             // ignore malformed; keep last good value + its timestamp
    const now = Date.now();
    if (topic === cfg.topicSolar)  _solar  = { value: n, at: now };
    if (topic === cfg.topicSecond) _second = { value: n, at: now };
  });

  _subscribedKey = [c.brokerUrl, c.topicSolar, c.topicSecond].join('|');
}

// Reconcile the connection with current settings. Safe to call repeatedly and at boot:
// connects only when MQTT is the active provider AND fully configured; otherwise stays
// (or becomes) disconnected. No-op for every non-MQTT install.
function start() {
  if (!_isActive() || !isConfigured()) { stop(); return; }
  const c = _cfg();
  const wantKey = [c.brokerUrl, c.topicSolar, c.topicSecond].join('|');
  if (_client && _subscribedKey === wantKey) return;  // already wired to the right broker/topics
  stop();                                             // tear down any stale client first
  _clearCache();
  _connect(c);
}

function stop() {
  if (_client) {
    try { _client.end(true); } catch (_) {}
    _client = null;
  }
  _connected = false;
  _subscribedKey = '';
}

function restart() {
  stop();
  start();
}

// ── Meter contract ──────────────────────────────────────────────────────────────

async function fetchReadings() {
  const c = _cfg();
  if (!isConfigured()) throw new Error('MQTT input not configured');

  // Defensive: ensure the subscription is up even if boot order or a settings race
  // left it down. start() no-ops when already correctly connected.
  if (!_client) start();
  if (!_connected) throw new Error('MQTT broker not connected');

  if (_solar.at === 0 || _second.at === 0) {
    throw new Error('Waiting for first MQTT readings');
  }

  const now = Date.now();
  const maxAge = Math.max(now - _solar.at, now - _second.at);
  if (maxAge > c.staleMs) {
    throw new Error(
      `MQTT data stale - last update ${Math.round(maxAge / 1000)}s ago ` +
      `(limit ${Math.round(c.staleMs / 1000)}s)`
    );
  }

  const solarW = Math.max(0, _solar.value * c.scale);

  let gridW, consumptionW;
  if (c.secondType === 'consumption') {
    consumptionW = Math.max(0, _second.value * c.scale);
    gridW = consumptionW - solarW;                    // WattSnatch convention: + = importing
  } else {
    let g = _second.value * c.scale;
    if (c.gridSign === 'export_positive') g = -g;     // normalise to import-positive
    gridW = g;
    consumptionW = Math.max(0, solarW + gridW);
  }

  return {
    solarW,
    consumptionW,
    gridW,
    solarActEnergyDlvdWh: null,   // instantaneous power topics carry no lifetime accumulator
    timestamp: now,
  };
}

// Isolated one-shot connectivity test for the setup wizard. Uses its own short-lived
// client (reconnectPeriod:0) so it works before MQTT is the active provider and never
// disturbs the persistent subscription.
async function testConnection() {
  const c = _cfg();
  if (!c.brokerUrl)  return { ok: false, error: 'Enter the broker URL first' };
  if (!c.topicSolar || !c.topicSecond) return { ok: false, error: 'Map both the solar topic and the grid/consumption topic first' };
  if (c.topicSolar === c.topicSecond)  return { ok: false, error: 'The solar and grid/consumption topics must be different' };

  return new Promise((resolve) => {
    let done = false;
    const got = { solar: null, second: null };
    let client;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (client) client.end(true); } catch (_) {}
      resolve(result);
    };

    const timer = setTimeout(() => {
      const missing = got.solar === null ? c.topicSolar : c.topicSecond;
      finish({ ok: false, error: `Connected to the broker, but no numeric message arrived on "${missing}" within 8s. Check the topic name and that your source is publishing.` });
    }, 8000);

    try {
      client = mqtt.connect(c.brokerUrl, {
        username: c.username || undefined,
        password: c.password || undefined,
        clientId: 'wattsnatch-intest-' + Math.random().toString(16).slice(2, 8),
        reconnectPeriod: 0,
        connectTimeout: 8000,
      });
    } catch (err) {
      return finish({ ok: false, error: `Invalid broker URL: ${err.message}` });
    }

    client.on('connect', () => {
      client.subscribe([c.topicSolar, c.topicSecond], { qos: 0 }, (err) => {
        if (err) finish({ ok: false, error: `Subscribe failed: ${err.message}` });
      });
    });
    client.on('message', (topic, buf) => {
      const n = _parsePayload(buf);
      if (n === null) return;
      if (topic === c.topicSolar)  got.solar  = n;
      if (topic === c.topicSecond) got.second = n;
      if (got.solar !== null && got.second !== null) {
        finish({ ok: true, readings: { solarW: Math.max(0, got.solar * c.scale) } });
      }
    });
    client.on('error', (err) => finish({ ok: false, error: `Broker error: ${err.message}` }));
  });
}

function handleFetchError(_err) {
  return false; // no provider-specific auth-refresh - the broker either has data or it doesn't
}

// Lightweight status for debugging / a future status endpoint.
function getState() {
  const now = Date.now();
  return {
    connected: _connected,
    solarAgeMs:  _solar.at  ? now - _solar.at  : null,
    secondAgeMs: _second.at ? now - _second.at : null,
  };
}

module.exports = {
  id: 'mqtt',
  label: 'MQTT (bring your own data)',
  authType: 'mqtt',
  supportsPanelHealth: false,
  isConfigured,
  fetchReadings,
  testConnection,
  handleFetchError,
  // lifecycle (called by server.js at boot and api.js on settings change)
  start,
  stop,
  restart,
  getState,
};
