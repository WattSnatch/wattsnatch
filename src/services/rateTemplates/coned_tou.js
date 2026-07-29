/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Approximated from Con Edison's publicly published residential
// time-of-use rate schedule. New York doesn't have a NEM-3.0-style
// time-varying export credit - Con Ed uses standard net metering - so
// exportWindows is intentionally null (leaves export_rate_mode on flat).
// Not verified against a live Con Edison account - see ../README.md for the
// accuracy disclaimer that applies to every template in this directory.
module.exports = {
  id: 'coned_tou',
  label: 'Con Edison Time-of-Use (residential)',
  country: 'US',
  region: 'NY',
  importDefaultRateAud: 0.12,
  importWindows: [
    { label: 'Peak (8am-10pm weekdays)', rate_aud: 0.28, days: [1, 2, 3, 4, 5], start_time: '08:00', end_time: '22:00' },
  ],
  exportDefaultRateAud: null,
  exportWindows: null,
  sourceNote: 'Approximated from Con Edison\'s publicly published residential TOU rate schedule - not verified against a live account. New York uses standard net metering, not a NEM-3.0-style time-varying export credit, so this template only sets an import TOU schedule. Confirm current rates in your Con Ed bill before relying on this for real cost comparisons.',
};
