/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Meter provider registry. controller.js reads `inverter_brand` from settings
// (defaults to 'enphase' so existing installs are unaffected on upgrade) and
// asks this registry for the matching provider module.
//
// Every provider module exposes:
//   id, label, authType, supportsPanelHealth
//   isConfigured()            -> boolean
//   fetchReadings()           -> { solarW, consumptionW, gridW, solarActEnergyDlvdWh, timestamp }
//   testConnection()          -> { ok, error?, readings? }
//   handleFetchError(err)     -> boolean (true if it handled a provider-specific auth error)
//
// See ./README.md for the full contract and rationale.

const db = require('../../db');

const providers = {
  enphase:   require('./enphase'),
  fronius:   require('./fronius'),
  solaredge: require('./solaredge'),
  span:      require('./span'),
  mqtt:      require('./mqttInput'),
};

function getProvider(id) {
  return providers[id] || null;
}

function getActiveProvider() {
  const id = db.getSetting('inverter_brand') || 'enphase';
  return getProvider(id);
}

function listProviders() {
  return Object.values(providers).map(p => ({
    id: p.id, label: p.label, authType: p.authType, supportsPanelHealth: !!p.supportsPanelHealth,
  }));
}

module.exports = { getProvider, getActiveProvider, listProviders };
