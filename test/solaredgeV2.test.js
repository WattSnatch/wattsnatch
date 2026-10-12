'use strict';

// SolarEdge API V2 meter provider.
//
// The behaviours worth pinning down are the ones that protect the charging
// decision and the monthly credit allowance:
//
//   - it NEVER substitutes zeroes for missing data. controller.js computes
//     rawExcess = solarW - consumptionW + chargerWatts, so a fabricated
//     {0, 0} while the car is charging reads as several kW of phantom surplus
//     and would hold a grid charge open all night.
//   - it polls once per quarter-hour window and serves a cache in between,
//     because the API returns the same 15-minute average until the next window
//     closes, and the Free tier allows only ~2,000 calls a month.
//   - grid direction comes from importPower - exportPower, not from guesswork.
//
// Runs against a throwaway SQLite file (WATTSNATCH_DB_PATH), never the real one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDbPath = path.join(os.tmpdir(), `wattsnatch-se2-test-${process.pid}-${Date.now()}.db`);
process.env.WATTSNATCH_DB_PATH = tmpDbPath;

const db = require('../src/db');
db.initDb();

const { encrypt } = require('../src/utils/crypto');
const solaredgeV2 = require('../src/services/meters/solaredgeV2');

test.after(() => {
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

/** Configure a credentialled, authorised install with a long-lived token. */
function configure() {
  db.setSetting('solaredge_client_id', 'client-abc');
  db.setSetting('solaredge_client_secret', 'secret-xyz');
  db.setSetting('solaredge_site_id', '3037831');
  db.setSetting('solaredge_monthly_budget', '1900');
  db.setSetting('solaredge_calls_used', '0');
  db.setSetting('solaredge_budget_cycle', new Date().toISOString().slice(0, 7));
  // No coordinates: the daylight gate then never suppresses a poll, so these
  // tests exercise the cadence logic rather than the time of day they run at.
  db.setSetting('home_latitude', '');
  db.setSetting('home_longitude', '');
  db.setToken(
    'solaredge',
    encrypt(JSON.stringify({ access_token: 'tok', refresh_token: 'ref' })),
    Date.now() + 3600 * 1000,
    null,
  );
}

/** A /meters/telemetry envelope whose newest window starts `ageMin` ago. */
function telemetry({ production, consumption, importW = 0, exportW = 0, ageMin = 1 }) {
  const ts = new Date(Date.now() - ageMin * 60 * 1000).toISOString();
  const series = (unit, value) => ({ unit, values: [{ timestamp: ts, value }] });
  return {
    period: {}, resolution: 'QUARTER_HOUR',
    meters: {
      'M-PROD-001': { productionPower: series('W', production) },
      'M-CONS-001': {
        consumptionPower: series('W', consumption),
        importPower: series('W', importW),
        exportPower: series('W', exportW),
      },
    },
  };
}

function stubFetch(body, status = 200) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return calls;
}

test('exporting to the grid yields a negative gridW, importing a positive one', async () => {
  configure();
  stubFetch(telemetry({ production: 4000, consumption: 1500, exportW: 2500 }));
  const r = await solaredgeV2.testConnection();

  assert.equal(r.ok, true);
  assert.equal(r.readings.solarW, 4000);
  assert.equal(r.readings.consumptionW, 1500);
  assert.equal(r.readings.gridW, -2500, 'export must read as negative grid power');

  stubFetch(telemetry({ production: 200, consumption: 1400, importW: 1200 }));
  const r2 = await solaredgeV2.testConnection();
  assert.equal(r2.readings.gridW, 1200, 'import must read as positive grid power');
});

test('a grid-only meter still yields the correct surplus', async () => {
  configure();
  // The shape a site with a single meter at the connection point returns: import
  // and export only, no production or consumption series. Physically
  // production - consumption == export - import, so the surplus is still exact.
  const ts = new Date().toISOString();
  const series = (v) => ({ unit: 'W', values: [{ timestamp: ts, value: v }] });
  stubFetch({ meters: { '606728569': { importPower: series(0), exportPower: series(2500) } } });

  const r = await solaredgeV2.testConnection();
  assert.equal(r.ok, true);
  assert.equal(r.readings.solarW - r.readings.consumptionW, 2500,
    'solarW - consumptionW is what controller.js diverts on; it must equal export - import');
  assert.equal(r.readings.gridW, -2500);
});

test('a site reporting nothing measurable is an error, never an assumed zero', async () => {
  configure();
  // Zeroes here would read as several kW of phantom surplus once chargerWatts is
  // added back in controller.js, holding a grid charge open.
  stubFetch({ meters: { '606728569': {} } });

  const r = await solaredgeV2.testConnection();
  assert.equal(r.ok, false);
  assert.match(r.error, /no usable power metrics/);
});

test('readings older than the staleness limit throw instead of being served', async () => {
  configure();
  // 45 minutes old: past MAX_READING_AGE_MS, i.e. three missed windows.
  stubFetch(telemetry({ production: 5000, consumption: 1000, exportW: 4000, ageMin: 45 }));
  await solaredgeV2.testConnection();               // primes the cache

  await assert.rejects(
    () => solaredgeV2.fetchReadings(),
    /old - treating as no data/,
    'a stale window must fail loudly, not quietly steer the charge rate',
  );
});

test('the stale-data and night errors are absorbed so they do not spam the log', () => {
  assert.equal(solaredgeV2.handleFetchError(new Error('SolarEdge: newest window is 45 min old - treating as no data')), true);
  assert.equal(solaredgeV2.handleFetchError(new Error('SolarEdge: no reading yet (outside solar window or awaiting first poll)')), true);
  assert.equal(solaredgeV2.handleFetchError(new Error('SolarEdge API returned 500')), false,
    'a real API fault must still reach the log');
});

test('a 401 clears the token expiry so the next call refreshes', () => {
  configure();
  assert.ok(db.getToken('solaredge').expires_at > Date.now());

  assert.equal(solaredgeV2.handleFetchError(new Error('401 SolarEdge token rejected')), true);
  assert.equal(db.getToken('solaredge').expires_at, 0, 'expiry must be zeroed to force a refresh');
});

test('spent credit budget stops further polling', async () => {
  configure();
  db.setSetting('solaredge_monthly_budget', '10');
  db.setSetting('solaredge_calls_used', '10');

  const calls = stubFetch(telemetry({ production: 1000, consumption: 500 }));
  // No cache and no budget: it must fail rather than spend a call it hasn't got.
  await assert.rejects(() => solaredgeV2.fetchReadings());
  assert.equal(calls.length, 0, 'no HTTP call may be made once the budget is spent');
});

test('each poll is counted against the monthly budget', async () => {
  configure();
  const before = solaredgeV2.getBudgetStatus().used;
  stubFetch(telemetry({ production: 2000, consumption: 800 }));
  await solaredgeV2.testConnection();

  assert.equal(solaredgeV2.getBudgetStatus().used, before + 1);
});

test('no call is made while the sun is down, whatever time the suite runs', async () => {
  configure();
  // Pick a longitude that is in deep night right now rather than hardcoding one,
  // so this holds whenever the suite happens to run.
  const SunCalc = require('suncalc');
  const now = new Date();
  let nightLon = null;
  for (let lon = -180; lon <= 180 && nightLon === null; lon += 15) {
    if (SunCalc.getPosition(now, 48, lon).altitude < -0.3) nightLon = lon;
  }
  assert.notEqual(nightLon, null, 'somewhere on the planet it is always night');

  db.setSetting('home_latitude', '48');
  db.setSetting('home_longitude', String(nightLon));

  const calls = stubFetch(telemetry({ production: 0, consumption: 900, importW: 900 }));
  // A cache from earlier in the day may still be inside the staleness limit, and
  // serving it is correct - the point being pinned here is purely that darkness
  // costs no credits. Once the cache does age out, fetchReadings throws; that is
  // covered by the staleness test above.
  await solaredgeV2.fetchReadings().catch(() => {});
  assert.equal(calls.length, 0, 'a credit must not be spent on a window the sun was down for');
});

test('isConfigured requires credentials, a site and an actual token', () => {
  configure();
  assert.equal(solaredgeV2.isConfigured(), true);

  db.deleteToken('solaredge');
  assert.equal(solaredgeV2.isConfigured(), false, 'credentials alone are not an authorised install');
});

test('the authorize URL carries the scopes, redirect and a 24-month grant', () => {
  configure();
  const url = new URL(solaredgeV2.buildAuthorizeUrl('http://localhost:3001/auth/solaredge/callback', 'nonce123'));

  assert.equal(url.origin + url.pathname, 'https://connect.solaredge.com/authorize');
  assert.equal(url.searchParams.get('client_id'), 'client-abc');
  assert.equal(url.searchParams.get('scope'), 'SITE_DATA DEVICE_DATA');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3001/auth/solaredge/callback');
  assert.equal(url.searchParams.get('state'), 'nonce123');
  assert.equal(url.searchParams.get('access_duration'), '24');
});
