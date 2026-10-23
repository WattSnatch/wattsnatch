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

// ── Finishing just before departure ────────────────────────────────────────────────────────
//
// Charging used to run at full rate from the moment the window opened, so it finished hours
// early and the car sat at a high charge until it left. Now the rate is planned to finish
// FINISH_BUFFER_MS before departure: enough margin for a car that is slow to wake or charges a
// little slower than expected, without leaving it parked full all morning. Recomputed every
// tick, so a car that falls behind is sped up and one that gets ahead (solar) can ease off.
const FINISH_BUFFER_MS = 30 * 60 * 1000;
// Energy reaching the battery per unit drawn. Errs low on purpose: a lower figure plans a
// faster rate, so the error is finishing a little early, never late.
const CHARGE_EFFICIENCY = 0.9;
// Below roughly this current the car's fixed charging overhead wastes a much bigger share of
// the energy, so rather than trickle, the start is delayed until it can run at least this.
const EFFICIENT_MIN_AMPS = 16;
// Used only if the owner has not entered their battery size. Larger is the safe direction:
// it plans more energy, so finishes earlier rather than later.
const DEFAULT_CAPACITY_KWH = 82;

function _capacityKwh() {
  const v = parseFloat(db.getSetting('tesla_battery_kwh'));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_CAPACITY_KWH;
}

// Same rule as the controller's _wattsPerAmp(): voltage times phases, strictly validated.
function _wattsPerAmp() {
  const phases  = ({ 1: 1, 2: 2, 3: 3 })[String(db.getSetting('charger_phases') || '').trim()] || 1;
  const voltage = Number(db.getSetting('charger_voltage'));
  return (Number.isFinite(voltage) && voltage > 0 ? voltage : 240) * phases;
}

function _peakWindowsConfigured() {
  if (db.getSetting('tou_enabled') !== 'true') return false;
  try { return (JSON.parse(db.getSetting('tou_windows') || '[]') || []).length > 0; } catch (_e) { return false; }
}

/**
 * Plan the charge rate that finishes just before departure. Pure, so it can be tested.
 *
 * Returns { start, amps, reason }:
 *   start - grid charging should be running now
 *   amps  - the rate to run at (0 when not starting)
 */
function planCharge({ missingPct, capacityKwh, msUntilDeparture, wattsPerAmp, minAmps, maxAmps,
                      inProgress = false, peakWindowsConfigured = false }) {
  if (!(missingPct > 0)) return { start: false, amps: 0, reason: 'target reached' };
  // Blocked peak-tariff windows would make "as late as possible" land in the most expensive
  // hours, and this planner does not know the prices. Keep the old behaviour there: full rate
  // as soon as the window opens.
  if (peakWindowsConfigured) {
    return { start: true, amps: maxAmps, reason: 'peak-tariff windows are configured, so charging at full rate' };
  }
  const kwhNeeded = (missingPct / 100) * capacityKwh;
  const hoursToFinish = (msUntilDeparture - FINISH_BUFFER_MS) / 3600000;
  if (hoursToFinish <= 0) return { start: true, amps: maxAmps, reason: 'inside the finishing margin, so full rate' };
  const ampsNeeded = Math.ceil(((kwhNeeded / CHARGE_EFFICIENCY) / hoursToFinish) * 1000 / wattsPerAmp);
  if (ampsNeeded >= maxAmps) return { start: true, amps: maxAmps, reason: 'needs full rate to finish in time' };
  const floor = Math.min(maxAmps, Math.max(minAmps || 0, EFFICIENT_MIN_AMPS));
  if (ampsNeeded < floor && !inProgress) {
    return { start: false, amps: 0,
      reason: `not needed yet: ${ampsNeeded} A would finish on time; will start once it needs ${floor} A or more` };
  }
  const amps = Math.max(ampsNeeded, floor);
  return { start: true, amps, reason: `${amps} A finishes about 30 minutes before departure` };
}

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
function getDepartureDecision(currentSoc, maxAmps, opts = {}) {
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

  // Target reached - reported, deliberately NOT cleared here.
  //
  // Clearing at this instant used to make the controller's own stop
  // unreachable. This returned {active:false}, so _runDeparture was never
  // called on the tick the target was hit, and control fell through to the
  // ordinary state machine - which stops on the Tesla charge limit (80%), not
  // on our target. The car sailed straight past the number the entire feature
  // exists to hit.
  //
  // The controller clears it once it has actually stopped the car.
  if (missingPct === 0) {
    return {
      active:          true,
      targetReached:   true,
      needsGridCharge: false,
      targetSoc:       dep.target_soc,
      departureTime:   dep.departure_time,
      hoursUntil:      Math.round(hoursUntil * 10) / 10,
      missingPct:      0,
      suggestedAmps:   maxAmps,
      notes:           dep.notes,
    };
  }

  const maxA = Number(maxAmps) > 0 ? Number(maxAmps) : parseInt(db.getSetting('max_charge_amps') || '32', 10);
  const plan = planCharge({
    missingPct,
    capacityKwh:      _capacityKwh(),
    msUntilDeparture: dep.departure_time - now,
    wattsPerAmp:      opts.wattsPerAmp || _wattsPerAmp(),
    minAmps:          parseInt(db.getSetting('min_charge_amps') || '5', 10),
    maxAmps:          maxA,
    inProgress:       !!opts.inProgress,
    peakWindowsConfigured: _peakWindowsConfigured(),
  });
  // Grid charging still waits for the window to open, unless even full rate from now only just
  // finishes in time, in which case starting later would miss the target.
  const fullRateNeeded = plan.start && plan.amps >= maxA && !plan.reason.startsWith('peak');
  let needsGridCharge = missingPct > 0 && plan.start && (hoursUntil <= ACTIVATION_HOURS || fullRateNeeded);

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
    suggestedAmps:  plan.start ? plan.amps : maxA,
    planReason:     plan.reason,
    notes:          dep.notes,
  };
}

module.exports = {
  setDeparture, getActiveDeparture, clearDeparture, getDepartureDecision,
  socAvailable, NO_SOC_MESSAGE, planCharge,
  FINISH_BUFFER_MS, EFFICIENT_MIN_AMPS, CHARGE_EFFICIENCY, ACTIVATION_HOURS,
};
