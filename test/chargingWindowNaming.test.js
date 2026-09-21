/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Three settings sections deal in time windows and only two of them affect charging.
//
// Issue #14. "Electricity Rate" records tariff windows for cost tracking and never
// influences a charging decision. "Scheduled Charging" permitted grid charging in its
// windows. "Time-of-Use (Peak Tariff)" blocked it. Nothing on the page said which was
// which, so the reporter reasonably assumed entering his tariff would change behaviour,
// and asked why he was entering the same times twice.
//
// The two control sections are now named for what they do, and the rate section states
// plainly that it does not control charging. The times deliberately stay independent: a
// demand-charge period or an EV-only tariff can legitimately differ from billing windows,
// so copying one into the other would be wrong as often as it was right.
//
// This is a labelling change only. The assertions below exist mostly to pin that: the
// element ids and settings keys behind these controls must not move, because a rename
// that quietly changed behaviour would be far worse than the confusion it fixes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'settings.html'), 'utf8');
const js   = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'settings.js'), 'utf8');

test('the two control sections are named for what they do', () => {
  assert.match(html, /<div class="card-label">Allowed Grid Charging Windows<\/div>/,
    'the permitting section must say it permits');
  assert.match(html, /<div class="card-label">Blocked Grid Charging \(Peak Tariff\)<\/div>/,
    'the blocking section must say it blocks');
});

test('the old names are gone from the page', () => {
  assert.ok(!/<div class="card-label">Scheduled Charging<\/div>/.test(html),
    'the old ambiguous label must not remain');
  assert.ok(!/<div class="card-label">Time-of-Use \(Peak Tariff\)<\/div>/.test(html),
    'the old label named the tariff, not the effect');
});

test('each section still says which one wins where they overlap', () => {
  // Peak blocking takes priority. Losing that sentence would leave the rename a downgrade.
  assert.match(html, /blocked windows below win|take priority over the allowed windows/,
    'the precedence between the two must remain stated');
});

test('the rate section says plainly that it does not control charging', () => {
  const card = html.slice(html.indexOf('<div class="card-label">Electricity Rate</div>'),
                          html.indexOf('<div class="card-label">Electricity Rate</div>') + 1400);
  assert.ok(card.length > 0, 'the rate card must be found');
  assert.match(card, /never decide when the car charges/,
    'the confusion this issue reported is exactly this omission');
  assert.match(card, /Allowed Grid Charging Windows/,
    'it should point at the sections that do control charging');
  assert.match(card, /do not have to match/,
    'and explain why the times are allowed to differ');
});

test('the controls behind the renamed sections are unchanged', () => {
  // A labelling change must not move a setting. These ids drive the saved windows.
  assert.match(html, /id="schedule_enabled"/, 'the schedule toggle id must not move');
  assert.match(html, /id="tou_enabled"/, 'the peak toggle id must not move');
  assert.match(html, /id="schedule-windows-list"/, 'the schedule window list id must not move');
  assert.match(html, /id="tou-windows-list"/, 'the peak window list id must not move');
  assert.match(js, /schedule_enabled/, 'the saved setting key must not move');
  assert.match(js, /tou_enabled/, 'the saved setting key must not move');
});

test('the toggles describe the effect rather than the feature name', () => {
  assert.match(html, /Allow grid charging in these windows/, 'the permitting toggle');
  assert.match(html, /Block grid charging in these windows/, 'the blocking toggle');
});
