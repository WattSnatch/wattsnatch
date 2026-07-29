/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Grid-carbon-intensity provider registry, mirroring the pattern used by
// src/services/meters/ and src/services/calendar/. `grid_intensity_provider`
// defaults to 'aemo' so existing installs are completely unaffected on
// upgrade - only a user who explicitly switches provider (and configures the
// relevant API key) leaves AEMO's behavior.
//
// watttime/electricitymaps are best-effort - implemented from public API
// docs without a live account to test against. See their own files for the
// specific caveats.

const db = require('../../db');

const providers = {
  aemo:            require('./aemo'),
  watttime:        require('./watttime'),
  electricitymaps: require('./electricitymaps'),
};

function getProvider(id) {
  return providers[id] || null;
}

function getActiveProvider() {
  const id = db.getSetting('grid_intensity_provider') || 'aemo';
  return getProvider(id) || providers.aemo;
}

function listProviders() {
  return Object.values(providers).map(p => ({ id: p.id, label: p.label }));
}

module.exports = { getProvider, getActiveProvider, listProviders };
