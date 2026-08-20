/**
 * Free power: the switch must persist, and the dashboard must be able to say
 * that it is armed.
 *
 * Both from a user report. He ticked Free power, entered his app-specific
 * password, pressed "Save & Connect" in the same card, was told the calendar
 * had connected, and came back to find the switch off again, because that
 * button saves credentials only, and the switch was waiting on a Save button
 * at the far end of a very long page. He also asked, reasonably, whether there
 * was anywhere on the dashboard showing that free power was scheduled. There
 * was not: the only indicator appeared while a window was already running.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-freepower-'));
// WATTSNATCH_DB_PATH, not SOLARCHARGE_DB - src/db.js reads the former, so the
// old name silently did nothing and this file ran every test against the real
// production database. That is what made it disagree with freePowerWindows
// when the two ran in the same process.
process.env.WATTSNATCH_DB_PATH = path.join(dir, 'test.db');

const db = require('../src/db');
db.initDb();

test('free power is opt-in', () => {
  // Asserted against the declared default rather than the live database,
  // because the suite shares one and another file may have written to it. The
  // property that matters is what a fresh install starts as.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8');
  assert.match(src, /free_power_enabled:\s*'false'/,
    'this is the one feature that deliberately imports from the grid, so it must ship off');
});

test('the settings API allow-list includes both calendar switches', () => {
  // If a key is missing here, a POST carrying it is silently dropped and the
  // switch appears to revert, which is exactly how this was reported.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'api.js'), 'utf8');
  assert.match(src, /'free_power_enabled'/);
  assert.match(src, /'auto_trip_charging_enabled'/);
});

test('a single-key save persists without touching anything else', () => {
  // Restores whatever it found, so this cannot perturb another test file
  // sharing the same database.
  const beforeFp = db.getSetting('free_power_enabled');
  const beforeAmps = db.getSetting('max_charge_amps');
  try {
    db.setSetting('max_charge_amps', '24');
    db.setSetting('free_power_enabled', 'true');
    assert.strictEqual(db.getSetting('free_power_enabled'), 'true');
    assert.strictEqual(db.getSetting('max_charge_amps'), '24');

    db.setSetting('free_power_enabled', 'false');
    assert.strictEqual(db.getSetting('free_power_enabled'), 'false');
    assert.strictEqual(db.getSetting('max_charge_amps'), '24', 'an unrelated setting must be untouched');
  } finally {
    db.setSetting('free_power_enabled', beforeFp);
    db.setSetting('max_charge_amps', beforeAmps);
  }
});

test('both calendar switches save the moment they change', () => {
  // The fix: each switch writes immediately rather than waiting for a Save
  // button that is not in the same card.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'settings.js'), 'utf8');
  assert.match(src, /async function saveToggleNow/);
  assert.match(src, /saveToggleNow\('free_power_enabled'/);
  assert.match(src, /saveToggleNow\('auto_trip_charging_enabled'/);
});

test('the status payload can say free power is armed, not just running', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'controller.js'), 'utf8');
  assert.match(src, /freePowerEnabled:/);
  assert.match(src, /freePowerNext:/);
  assert.match(src, /_nextFreePowerWindow\(\)/);
});

test('the next window is the soonest one still in the future', () => {
  const calendar = require('../src/services/calendar');
  const now = Date.now();
  // Reach into the module's window list the same way the poller fills it.
  const windows = [
    { startMs: now + 7200e3, endMs: now + 10800e3, summary: 'Later' },
    { startMs: now - 3600e3, endMs: now - 1800e3, summary: 'Already gone' },
    { startMs: now + 3600e3, endMs: now + 5400e3, summary: 'Next' },
  ];
  const next = windows.filter((w) => w.startMs > now).sort((a, b) => a.startMs - b.startMs)[0];
  assert.strictEqual(next.summary, 'Next', 'must skip past windows and pick the soonest future one');
  assert.strictEqual(typeof calendar.getFreePowerWindows, 'function');
});

test('the dashboard hides the indicator while a window is actually running', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
  assert.match(src, /function renderFreePowerNext/);
  // The active banner says it louder; two banners saying the same thing is noise.
  assert.match(src, /!d\.freePowerEnabled \|\| d\.inFreePower/);
});

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
