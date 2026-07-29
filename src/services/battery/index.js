/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Battery provider registry. Mirrors src/services/meters/index.js's shape.
// controller.js reads `battery_brand` from settings (defaults to 'none' so
// existing installs are completely unaffected) and asks this registry for
// the matching provider module.
//
// See ./README.md for the full contract, why the existing solar-excess
// formula needs no changes, and what's genuinely verified vs. best-effort.

const db = require('../../db');

const providers = {
  sigenergy:       require('./sigenergy'),
  sungrow:         require('./sungrow'),
  tesla_powerwall: require('./teslaPowerwall'),
};

function getProvider(id) {
  return providers[id] || null;
}

function getActiveProvider() {
  const id = db.getSetting('battery_brand') || 'none';
  return getProvider(id);
}

function listProviders() {
  return Object.values(providers).map(p => ({
    id: p.id, label: p.label, authType: p.authType, capabilities: p.capabilities,
  }));
}

module.exports = { getProvider, getActiveProvider, listProviders };
