/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Fleet Telemetry config health. Tesla drops the per-vehicle telemetry config (the GET below
// returns config: null) on car software updates - when it does, the live stream goes silent
// and WattSnatch runs blind on stale state, which is how the dashboard ends up showing a
// charging car as Stopped/0A/0W (observed 2026-09-02). This service checks periodically and
// re-registers the config automatically so a firmware update no longer takes the app offline
// for days without anyone noticing.

const https = require('https');
const db = require('../db');
const logger = require('../utils/logger');
const { decrypt } = require('../utils/crypto');
const tesla = require('./tesla');

// Let's Encrypt E7 intermediate (valid until Mar 2027). Only used when the install has not
// stored its own fleet_telemetry_ca_cert. Kept identical to the setup wizard's default.
const DEFAULT_LE_CA = `-----BEGIN CERTIFICATE-----
MIIEVzCCAj+gAwIBAgIRAKp18eYrjwoiCWbTi7/UuqEwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMjQwMzEzMDAwMDAw
WhcNMjcwMzEyMjM1OTU5WjAyMQswCQYDVQQGEwJVUzEWMBQGA1UEChMNTGV0J3Mg
RW5jcnlwdDELMAkGA1UEAxMCRTcwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAARB6AST
CFh/vjcwDMCgQer+VtqEkz7JANurZxLP+U9TCeioL6sp5Z8VRvRbYk4P1INBmbef
QHJFHCxcSjKmwtvGBWpl/9ra8HW0QDsUaJW2qOJqceJ0ZVFT3hbUHifBM/2jgfgw
gfUwDgYDVR0PAQH/BAQDAgGGMB0GA1UdJQQWMBQGCCsGAQUFBwMCBggrBgEFBQcD
ATASBgNVHRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQWBBSuSJ7chx1EoG/aouVgdAR4
wpwAgDAfBgNVHSMEGDAWgBR5tFnme7bl5AFzgAiIyBpY9umbbjAyBggrBgEFBQcB
AQQmMCQwIgYIKwYBBQUHMAKGFmh0dHA6Ly94MS5pLmxlbmNyLm9yZy8wEwYDVR0g
BAwwCjAIBgZngQwBAgEwJwYDVR0fBCAwHjAcoBqgGIYWaHR0cDovL3gxLmMubGVu
Y3Iub3JnLzANBgkqhkiG9w0BAQsFAAOCAgEAjx66fDdLk5ywFn3CzA1w1qfylHUD
aEf0QZpXcJseddJGSfbUUOvbNR9N/QQ16K1lXl4VFyhmGXDT5Kdfcr0RvIIVrNxF
h4lqHtRRCP6RBRstqbZ2zURgqakn/Xip0iaQL0IdfHBZr396FgknniRYFckKORPG
yM3QKnd66gtMst8I5nkRQlAg/Jb+Gc3egIvuGKWboE1G89NTsN9LTDD3PLj0dUMr
OIuqVjLB8pEC6yk9enrlrqjXQgkLEYhXzq7dLafv5Vkig6Gl0nuuqjqfp0Q1bi1o
yVNAlXe6aUXw92CcghC9bNsKEO1+M52YY5+ofIXlS/SEQbvVYYBLZ5yeiglV6t3S
M6H+vTG0aP9YHzLn/KVOHzGQfXDP7qM5tkf+7diZe7o2fw6O7IvN6fsQXEQQj8TJ
UXJxv2/uJhcuy/tSDgXwHM8Uk34WNbRT7zGTGkQRX0gsbjAea/jYAoWv0ZvQRwpq
Pe79D/i7Cep8qWnA+7AE/3B3S/3dEEYmc0lpe1366A/6GEgk3ktr9PEoQrLChs6I
tu3wnNLB2euC8IKGLQFpGtOO/2/hiAKjyajaBP25w1jF0Wl8Bbqne3uZ2q1GyPFJ
YRmT7/OXpmOH/FVLtwS+8ng1cAmpCujPwteJZNcDG0sF2n/sc0+SQf49fdyUK0ty
+VUwFj9tmWxyR/M=
-----END CERTIFICATE-----`;

function _accessToken() {
  const row = db.getToken('tesla');
  if (!row) return null;
  try { return JSON.parse(decrypt(row.token_data)).access_token || null; }
  catch (_e) { return null; }
}

// GET the car's current telemetry config from Tesla.
// Returns { synced, hasConfig, keyPaired } on success, or null when we could not ask
// (no token/VIN, network error) - a null means "unknown", never "missing", so we never
// re-register on a failed check.
async function getConfigStatus() {
  const vin = db.getSetting('tesla_vin');
  const token = _accessToken();
  if (!vin || !token) return null;
  return new Promise((resolve) => {
    const url = `${tesla.fleetBase()}/api/1/vehicles/${vin}/fleet_telemetry_config`;
    const req = https.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const r = (JSON.parse(b).response) || {};
          resolve({ synced: r.synced === true, hasConfig: r.config != null, keyPaired: r.key_paired === true });
        } catch (_e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// POST the telemetry config to Tesla via the local signing proxy (localhost:4443).
// Returns { ok, status, response } or { ok:false, error }. Shared with the setup wizard.
async function sendConfig() {
  const vin = db.getSetting('tesla_vin');
  if (!vin) return { ok: false, error: 'No VIN stored - complete setup first' };
  const hostname = db.getSetting('fleet_telemetry_hostname');
  if (!hostname) {
    return { ok: false, error: 'fleet_telemetry_hostname not set - enter your telemetry server\'s public hostname in Settings first. See TELEMETRY.md.' };
  }
  const token = _accessToken();
  if (!token) return { ok: false, error: 'No Tesla token stored' };

  const port = parseInt(db.getSetting('fleet_telemetry_port') || '443', 10);
  const caCert = db.getSetting('fleet_telemetry_ca_cert') || DEFAULT_LE_CA;
  const payload = JSON.stringify({
    vins: [vin],
    config: {
      hostname, port, ca: caCert,
      fields: {
        ChargeAmps:          { interval_seconds: 1  },
        DetailedChargeState: { interval_seconds: 1  },
        Soc:                 { interval_seconds: 30 },
        ChargeLimitSoc:      { interval_seconds: 60 },
        ChargerVoltage:      { interval_seconds: 30 },
        ACChargingPower:     { interval_seconds: 5  },
        Location:            { interval_seconds: 30 },
      },
    },
  });

  const agent = new https.Agent({ rejectUnauthorized: false });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'localhost', port: 4443, path: '/api/1/vehicles/fleet_telemetry_config',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      agent, timeout: 30000,
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(b); } catch (_e) { parsed = { raw: b }; }
        logger.logEvent('info', `fleet_telemetry_config: status=${res.statusCode} body=${b.slice(0, 300)}`);
        resolve({ ok: res.statusCode === 200 && parsed.error == null, status: res.statusCode, response: parsed });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Proxy request timed out' }); });
    req.write(payload);
    req.end();
  });
}

let _lastRepairAt = 0;
const REPAIR_MIN_GAP_MS = 30 * 60 * 1000;

// Check the config and re-register it if Tesla has dropped it. Safe to call on a timer:
// a failed check (car unreachable, no token) is a no-op, and repairs are rate-limited so a
// persistent failure cannot storm the proxy.
async function checkAndRepair() {
  const status = await getConfigStatus();
  if (!status) return { checked: false };            // could not ask - try again next cycle
  if (status.hasConfig) return { checked: true, healthy: true };

  if (Date.now() - _lastRepairAt < REPAIR_MIN_GAP_MS) {
    return { checked: true, healthy: false, repaired: false, throttled: true };
  }
  _lastRepairAt = Date.now();
  logger.logEvent('api_error',
    'Fleet Telemetry config missing on Tesla (dropped - usually a car software update) - re-registering automatically');
  const result = await sendConfig();
  if (result.ok) {
    logger.logEvent('command',
      'Fleet Telemetry config re-registered automatically - live streaming should resume within a minute');
  } else {
    logger.logEvent('api_error',
      `Fleet Telemetry auto re-register failed: ${result.error || JSON.stringify(result.response)}`);
  }
  return { checked: true, healthy: false, repaired: result.ok };
}

let _timer = null;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h - a dropped config is rare and not urgent to the minute
const INITIAL_DELAY_MS = 90 * 1000;            // let the signing proxy and token settle after boot

function start() {
  if (_timer) return;
  setTimeout(() => { checkAndRepair().catch(() => {}); }, INITIAL_DELAY_MS);
  _timer = setInterval(() => { checkAndRepair().catch(() => {}); }, CHECK_INTERVAL_MS);
  logger.logEvent('info',
    'Telemetry-config health monitor started (checks every 6h, auto-re-registers if Tesla drops the config)');
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, checkAndRepair, sendConfig, getConfigStatus };
