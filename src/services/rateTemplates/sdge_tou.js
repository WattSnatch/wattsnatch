/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Approximated from SDG&E's publicly published TOU-DR1 residential rate
// schedule and the NEM 3.0 Avoided Cost Calculator export structure. Not
// verified against a live SDG&E account - see ../README.md for the accuracy
// disclaimer that applies to every template in this directory.
module.exports = {
  id: 'sdge_tou',
  label: 'SDG&E TOU-DR1 (residential TOU)',
  country: 'US',
  region: 'CA',
  importDefaultRateAud: 0.35,
  importWindows: [
    { label: 'Peak (4pm-9pm)', rate_aud: 0.47, days: [0, 1, 2, 3, 4, 5, 6], start_time: '16:00', end_time: '21:00' },
  ],
  exportDefaultRateAud: 0.09,
  exportWindows: [
    { label: 'Midday (NEM 3.0 near-zero)', rate_aud: 0.03, days: [0, 1, 2, 3, 4, 5, 6], start_time: '10:00', end_time: '16:00' },
    { label: 'Evening peak export', rate_aud: 0.28, days: [0, 1, 2, 3, 4, 5, 6], start_time: '16:00', end_time: '21:00' },
  ],
  sourceNote: 'Approximated from SDG&E\'s publicly published TOU-DR1 rate schedule and NEM 3.0 Avoided Cost Calculator structure - not verified against a live account. Confirm current rates in your SDG&E bill before relying on this for real cost comparisons.',
};
