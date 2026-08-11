#!/usr/bin/env node
/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Prints every charge-limit-related value Tesla reports, next to what
// WattSnatch currently believes, so a disagreement between the two can be
// attributed rather than guessed at.
//
// Tesla's charge_state carries several similar fields - charge_limit_soc,
// charge_limit_soc_std, charge_limit_soc_min, charge_limit_soc_max. The _min
// is typically 50, which is exactly the wrong-looking value to chase, so this
// prints all of them rather than just the one the app reads.
//
// Read-only: fetches vehicle data and prints it. Sends no commands.
//
// Usage: node scripts/diag-charge-limit.js

const db = require('../src/db');
const telemetry = require('../src/services/telemetry');

async function main() {
  // Same pattern as scripts/backup.js - the db module does not self-initialise,
  // that happens in server.js, which is not running in this process.
  db.initDb();

  const { getVehicleData, getVehicleState } = require('../src/services/tesla');
  const { decrypt } = require('../src/utils/crypto');

  const vin = db.getSetting('tesla_vin');
  if (!vin) { console.error('No VIN configured.'); return 1; }
  const tokenRow = db.getToken('tesla');
  if (!tokenRow) { console.error('Tesla not authenticated.'); return 1; }
  const token = JSON.parse(decrypt(tokenRow.token_data)).access_token;

  console.log('\n── What WattSnatch currently believes ──');
  const persisted = db.getSetting('telemetry_last_state');
  let believed = null;
  if (persisted) {
    const p = JSON.parse(persisted);
    believed = p.chargeLimit;
    console.log(`  persisted chargeLimit : ${p.chargeLimit}`);
    console.log(`  persisted batteryPct  : ${Number(p.batteryPct).toFixed(1)}`);
    console.log(`  persisted source      : ${p.source}`);
  }
  // Note: this process has not started the telemetry listener, so the module
  // holds its compiled-in default rather than the persisted value. The
  // persisted figure above is what the running app actually restored.
  console.log('  (in-process telemetry module not started - persisted value above is authoritative)');

  console.log('\n── What Tesla reports right now ──');
  const state = await getVehicleState(vin, token);
  console.log(`  vehicle state: ${state}`);
  if (state !== 'online') {
    console.log('  Car is asleep or offline. Tesla will not return charge_state,');
    console.log('  and waking it costs a little battery - so this diagnostic stops');
    console.log('  here rather than deciding that for you. Re-run when the car is');
    console.log('  awake (plugged in, or just after a drive) for a live comparison.');
    return 2;
  }

  const { chargeState } = await getVehicleData(vin, token);
  if (!chargeState) { console.log('  No charge_state returned.'); return 1; }

  for (const k of Object.keys(chargeState).sort()) {
    if (/limit|soc|battery_level/i.test(k)) {
      console.log(`  ${k.padEnd(28)} = ${JSON.stringify(chargeState[k])}`);
    }
  }

  console.log('\n── Verdict ──');
  const real     = chargeState.charge_limit_soc;
  const min      = chargeState.charge_limit_soc_min;
  const std      = chargeState.charge_limit_soc_std;
  const plugged  = chargeState.charging_state && chargeState.charging_state !== 'Disconnected';

  // Tesla reports charge_limit_soc as charge_limit_soc_min (typically 50) while
  // the car is unplugged, and the true limit only once it is plugged in. So a
  // reading of exactly `min` on an unplugged car is not evidence of anything -
  // say so, rather than presenting it as a disagreement to chase.
  if (!plugged && real === min && std !== min) {
    console.log(`  UNRELIABLE READING. The car is unplugged (charging_state=${chargeState.charging_state}),`);
    console.log(`  and Tesla is reporting charge_limit_soc=${real}, which is exactly`);
    console.log(`  charge_limit_soc_min. The real limit is almost certainly ${std} (the _std value).`);
    console.log('  Plug the car in and re-run to see the true limit. A charge-limit');
    console.log('  reading taken while unplugged should not be trusted or cached.');
  } else if (real === believed) {
    console.log(`  Agree: both say ${real}%.`);
  } else {
    console.log(`  DISAGREE: Tesla says ${real}%, WattSnatch believes ${believed}%.`);
    console.log(`  (min=${min}, std=${std}, plugged in=${plugged ? 'yes' : 'no'})`);
    console.log('  The app will correct itself within an hour (or immediately on');
    console.log('  restart) now that the charge limit has its own freshness rule.');
  }
  console.log('');
  return 0;
}

main().then(c => process.exit(c || 0)).catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
