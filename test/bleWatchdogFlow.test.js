/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Runs the whole watchdog script, not just its classification, against a fake proxy, with
// docker, sudo and hciconfig replaced by stubs that only record what they were asked to do.
// Nothing here can reach a real container or Bluetooth adapter.
//
// What it pins is the decision to act, because that is where the damage was. On 2026-10-12 the
// log showed this script resetting the proxy 10 to 50 times a day, every time the car was away,
// because a read for an absent car outlasts the 12s probe. The resets used up the hourly cap,
// the adapter wedged right after one of them as the car came home, and the cap then held it
// wedged for 18 minutes while the car charged from the grid.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'teslable-watchdog.sh');

const WEDGE = '{"response":{"result":false,"reason":"failed to connect to vehicle (A): ble: failed to scan for 5YJ3E1EA0JF000001: Command Disallowed"}}';
const AWAY = '{"response":{"result":false,"reason":"Vehicle is not in range: ble: failed to scan for 5YJ3E1EA0JF000001: context canceled"}}';

// mode: 'healthy' | 'busy' (Bluetooth slower than the probe, web root fine) | 'wedge'
let mode = 'healthy';
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(404); res.end('404 page not found'); return; }
  if (mode === 'healthy') { res.writeHead(200); res.end('{"response":{"result":true}}'); return; }
  if (mode === 'wedge') { res.writeHead(503); res.end(WEDGE); return; }
  // busy: answers "not in range" eventually, but well after the probe has given up
  const t = setTimeout(() => { res.writeHead(503); res.end(AWAY); }, 2500);
  res.on('close', () => clearTimeout(t));
});
let base;

function makeEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-wd-flow-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(dir, 'calls.log');
  const stub = (name, body) => {
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  };
  stub('docker', `echo "docker $*" >> "${calls}"; echo tesla-ble-http-proxy`);
  stub('sudo', `echo "sudo $*" >> "${calls}"`);
  stub('hciconfig', `printf 'hci3:\\tType: Primary  Bus: USB\\n\\tBD Address: 00:11:22:33:44:55  ACL MTU: 1021:8\\n'`);
  stub('sleep', 'exit 0');
  return {
    dir, calls,
    log: path.join(dir, 'watchdog.log'),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TESLABLE_WD_PROXY_BASE: extra.base || base,
      TESLABLE_WD_LOG: path.join(dir, 'watchdog.log'),
      TESLABLE_WD_STATE_DIR: dir,
      TESLABLE_WD_PROBE_TIMEOUT: '1',
      TESLABLE_WD_LONG_BUSY_SECS: extra.longBusy || '10800',
      TESLABLE_WD_ADAPTER_MAC: '00:11:22:33:44:55',
    },
  };
}

function run(ctx) {
  return new Promise((resolve, reject) => {
    execFile('bash', [SCRIPT], { env: ctx.env, timeout: 20000 }, (err) => (err && err.killed ? reject(err) : resolve()));
  });
}
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const dockerCalls = (ctx) => read(ctx.calls).split('\n').filter((l) => l.startsWith('docker'));

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => { mode = 'healthy'; });

test('the car being away for a whole run of checks never touches the proxy', async () => {
  const ctx = makeEnv();
  mode = 'busy';
  for (let i = 0; i < 6; i++) await run(ctx);
  assert.deepEqual(dockerCalls(ctx), [], 'the old script would have reset the proxy after the second check');
  const lines = read(ctx.log).trim().split('\n');
  assert.equal(lines.length, 1, 'one line when the busy spell starts, not one per check');
  assert.match(lines[0], /proxy is up \(web root HTTP 404\) - car away or proxy busy, not a fault/);
  assert.equal(read(path.join(ctx.dir, 'teslable_wd_strikes')).trim(), '0');
});

test('a proxy that does not answer at all, web root included, is still restarted', async () => {
  const ctx = makeEnv({ base: 'http://127.0.0.1:1' });
  await run(ctx);
  assert.deepEqual(dockerCalls(ctx), [], 'one strike is not enough');
  await run(ctx);
  assert.deepEqual(dockerCalls(ctx), ['docker restart tesla-ble-http-proxy']);
  assert.match(read(ctx.log), /fault 'no-response' confirmed over 2 checks - restarting proxy/);
});

test('a firmware wedge still escalates straight to an adapter reset', async () => {
  const ctx = makeEnv();
  mode = 'wedge';
  await run(ctx);
  await run(ctx);
  assert.deepEqual(dockerCalls(ctx), ['docker stop tesla-ble-http-proxy', 'docker start tesla-ble-http-proxy']);
  const sudo = read(ctx.calls).split('\n').filter((l) => l.startsWith('sudo'));
  assert.deepEqual(sudo, ['sudo /usr/bin/hciconfig hci3 down', 'sudo /usr/bin/hciconfig hci3 up'],
    'and only with the container stopped, per THE ONE RULE');
});

test('busy without a break for the long-stop is acted on, in case Bluetooth has hung', async () => {
  const ctx = makeEnv({ longBusy: '0' });
  mode = 'busy';
  await run(ctx);
  assert.deepEqual(dockerCalls(ctx), [], 'confirmation still applies');
  await run(ctx);
  assert.deepEqual(dockerCalls(ctx), ['docker restart tesla-ble-http-proxy']);
  assert.match(read(ctx.log), /fault 'busy-too-long' confirmed over 2 checks/);
  assert.equal(read(path.join(ctx.dir, 'teslable_wd_busy_since')).trim(), '', 'the long-stop window starts again');
});

test('the long-stop does not fire early: a normal day out stays quiet', async () => {
  const ctx = makeEnv({ longBusy: '10800' });
  mode = 'busy';
  for (let i = 0; i < 4; i++) await run(ctx);
  assert.deepEqual(dockerCalls(ctx), []);
});

test('the car coming home ends the busy spell and says so', async () => {
  const ctx = makeEnv();
  mode = 'busy';
  await run(ctx);
  mode = 'healthy';
  await run(ctx);
  assert.match(read(ctx.log), /Bluetooth answering again \(HTTP 200\) after 0 min busy/);
  assert.equal(read(path.join(ctx.dir, 'teslable_wd_busy_since')).trim(), '');
  assert.deepEqual(dockerCalls(ctx), []);
});

test('a busy spell that turns into a real fault is reported as the fault, not as recovery', async () => {
  const ctx = makeEnv();
  mode = 'busy';
  await run(ctx);
  mode = 'wedge';
  await run(ctx);
  assert.match(read(ctx.log), /busy spell ended after 0 min, now 'firmware-wedge' \(HTTP 503\)/);
  assert.doesNotMatch(read(ctx.log), /answering again/);
});

test('busy checks clear an earlier strike, so they cannot add up to a reset', async () => {
  const ctx = makeEnv({ base: 'http://127.0.0.1:1' });
  await run(ctx);                                            // dead: strike 1
  ctx.env.TESLABLE_WD_PROXY_BASE = base;
  mode = 'busy';
  await run(ctx);                                            // alive but busy
  ctx.env.TESLABLE_WD_PROXY_BASE = 'http://127.0.0.1:1';
  await run(ctx);                                            // dead again: strike 1, not 2
  assert.deepEqual(dockerCalls(ctx), []);
});
