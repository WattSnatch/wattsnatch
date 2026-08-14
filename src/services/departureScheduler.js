/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

/**
 * Departure Scheduler - "I need X% by 8am"
 *
 * Stores a single active departure in the DB.
 * The controller queries getDepartureDecision() each tick; if it returns
 * needsGridCharge=true the controller forces grid charging at max amps
 * until targetSoc is reached or the departure window expires.
 *
 * Solar-first: if there is enough solar excess to reach the target before
 * departure, the controller's normal solar logic handles it.  Grid top-up
 * only kicks in when the gap can't be closed on solar alone in the
 * remaining time (ACTIVATION_HOURS before departure).
 */

const db = require('../db');
const ercotPricing = require('./ercotPricing');

// Start forcing grid charge this many hours before departure if SOC is short
const ACTIVATION_HOURS = 6;

// If ERCOT real-time pricing is enabled and spiking, delay a non-urgent grid
// top-up - but only while there's still this much margin before departure,
// so a price spike can never cause a missed deadline. Off by default
// (ercotPricing.isPriceSpiking() is always false unless the user has
// explicitly enabled + configured ERCOT pricing), so this is a no-op for
// every existing install.
const PRICE_SPIKE_MIN_MARGIN_HOURS = 2;

const NO_SOC_MESSAGE =
  'Departure scheduling needs the vehicle\'s battery percentage, which the OCPP '
  + 'backend cannot read on typical home AC chargers (it requires ISO 15118 '
  + '"Plug and Charge" between the car and the charger). Use a scheduled charging '
  + 'window instead, which is time-based and works on any backend.';

/**
 * Whether the active charging backend can report a real battery percentage.
 *
 * This whole feature is "get me to X% by time T", so without a real SoC there
 * is no question to answer. The OCPP backend reports batteryPct as a permanent
 * 0, which made `missingPct` permanently equal to the full target: it could
 * never reach 0, so the auto-clear never fired and `needsGridCharge` latched
 * true for the entire ACTIVATION_HOURS window before every departure - hours of
 * full-rate GRID charging, the exact opposite of what this app is for, ending
 * only when the departure time passed.
 *
 * Refusing to answer is correct here; guessing is what caused the bug.
 */
function socAvailable() {
  return db.getSetting('charging_backend') !== 'ocpp';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Persist a departure schedule.
 * @param {number} departureTimeMs  Unix epoch milliseconds (must be in the future)
 * @param {number} targetSoc        Target battery % (20–100)
 * @param {string} [notes]          Optional free-text label
 */
function setDeparture(departureTimeMs, targetSoc, notes) {
  if (!socAvailable()) {
    throw new Error(NO_SOC_MESSAGE);
  }
  if (!departureTimeMs || departureTimeMs <= Date.now()) {
    throw new Error('Departure time must be in the future');
  }
  if (targetSoc < 20 || targetSoc > 100) {
    throw new Error('Target SOC must be between 20 and 100');
  }
  db.setDeparture(departureTimeMs, Math.round(targetSoc), notes);
}

/**
 * Return the active departure (with computed hours-until), or null.
 */
function getActiveDeparture() {
  const dep = db.getActiveDeparture();
  if (!dep) return null;

  const hoursUntil = (dep.departure_time - Date.now()) / (1000 * 60 * 60);
  if (hoursUntil <= 0) {
    db.clearDeparture();
    return null;
  }

  return {
    id:            dep.id,
    departureTime: dep.departure_time,
    targetSoc:     dep.target_soc,
    notes:         dep.notes,
    createdAt:     dep.created_at,
    hoursUntil:    Math.round(hoursUntil * 10) / 10,
  };
}

/**
 * Cancel the active departure.
 */
function clearDeparture() {
  db.clearDeparture();
}

/**
 * Called every controller tick.
 *
 * Returns an object the controller can act on:
 *   active         - there is a departure stored and it's in the future
 *   needsGridCharge - within ACTIVATION_HOURS AND SOC is below target
 *   targetSoc       - goal %
 *   departureTime   - Unix ms
 *   hoursUntil      - hours remaining
 *   missingPct      - how many % points still needed
 *   suggestedAmps   - just passes through maxAmps for convenience
 *   autoCleared     - true when this call auto-expired a past departure
 *
 * @param {number} currentSoc  Current battery %
 * @param {number} maxAmps     Max charge amps from settings
 */
function getDepartureDecision(currentSoc, maxAmps) {
  const dep = db.getActiveDeparture();
  if (!dep) return { active: false };

  // Defence in depth: setDeparture() already refuses on a no-SoC backend, but a
  // departure stored earlier (e.g. set under Tesla, then switched to OCPP)
  // would otherwise still be acted on with a permanently-0 SoC.
  if (!socAvailable()) {
    return { active: false, unsupported: true, unsupportedReason: NO_SOC_MESSAGE };
  }

  const now = Date.now();
  const hoursUntil = (dep.departure_time - now) / (1000 * 60 * 60);

  if (hoursUntil <= 0) {
    db.clearDeparture();
    return { active: false, autoCleared: true };
  }

  const missingPct = Math.max(0, dep.target_soc - (currentSoc || 0));

  // Auto-clear when target reached
  if (missingPct === 0) {
    db.clearDeparture();
    return { active: false, autoCleared: true };
  }

  let needsGridCharge = missingPct > 0 && hoursUntil <= ACTIVATION_HOURS;

  const priceSpike = ercotPricing.isPriceSpiking();
  if (needsGridCharge && priceSpike && hoursUntil > PRICE_SPIKE_MIN_MARGIN_HOURS) {
    needsGridCharge = false; // delay - still comfortably ahead of the deadline
  }

  return {
    active:         true,
    needsGridCharge,
    priceSpikeDelayed: priceSpike && hoursUntil > PRICE_SPIKE_MIN_MARGIN_HOURS,
    targetSoc:      dep.target_soc,
    departureTime:  dep.departure_time,
    hoursUntil:     Math.round(hoursUntil * 10) / 10,
    missingPct,
    suggestedAmps:  maxAmps,
    notes:          dep.notes,
  };
}

module.exports = {
  setDeparture, getActiveDeparture, clearDeparture, getDepartureDecision,
  socAvailable, NO_SOC_MESSAGE,
};
