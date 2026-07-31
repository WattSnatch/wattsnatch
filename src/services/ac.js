/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// Air-conditioning provider registry - mirrors the shape of
// src/services/meters/index.js and src/services/battery/index.js. Mitsubishi
// runs two genuinely separate cloud platforms that both get called "MELCloud"
// casually: MELCloud proper (melcloud.js) and MelView (melview.js, AU/NZ's
// "Wi-Fi Control" app) - different accounts, different APIs, one has no
// energy-consumption field at all. `ac_brand` picks which one is active;
// defaults to 'melcloud' so existing installs (which only ever had MELCloud,
// predating this file) keep working with no migration needed.

const db = require('../db');
const melcloud = require('./melcloud');
const melview = require('./melview');

const providers = { melcloud, melview };

function getActiveProvider() {
  const brand = db.getSetting('ac_brand') || 'melcloud';
  return providers[brand] || melcloud;
}

function start() {
  getActiveProvider().start();
}

function stop() {
  // Stop both, not just the active one - covers the moment right after a
  // user switches brands, where the previously-active provider's interval
  // could otherwise keep running.
  melcloud.stop();
  melview.stop();
}

function restart() {
  stop();
  start();
}

function getState() {
  return getActiveProvider().getState();
}

function isConfigured() {
  return getActiveProvider().isConfigured();
}

module.exports = { start, stop, restart, getState, isConfigured, getActiveProvider, providers };
