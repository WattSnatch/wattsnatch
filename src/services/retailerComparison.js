/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

/**
 * Retailer Comparison Engine
 *
 * Processes half-hourly grid-import data from telemetry_log and
 * models what the user would pay on each major SE-QLD retailer vs their
 * current rate stored in the app.
 *
 * Rate structures are approximate for the Energex network area (SE QLD)
 * as of mid-2025.  They are flat unless a TOU flag is set.
 * All rates are in AUD, cents per kWh → converted to $/kWh internally.
 */

const db = require('../db');
const retailerRates = require('./retailerRates');

// ── Retailer definitions ──────────────────────────────────────────────────────

// Each retailer may have:
//   flat:          { rateAud, supplyAud }
//   tou:           { peak, shoulder, offPeak, supplyAud }  (peak = 3pm-9pm weekdays etc.)
//   exportRateAud: feed-in tariff offered (default: use app setting)

const RETAILERS = [
  {
    id:    'origin_flat',
    name:  'Origin Energy',
    plan:  'Basic Plan (flat)',
    type:  'flat',
    rateAud:    0.3010,
    supplyAud:  0.9977,   // $/day
    exportRateAud: 0.05,
    source: 'Origin Energy SE QLD Jun-2025 estimate',
    url: 'https://www.originenergy.com.au/electricity-gas/plans',
  },
  {
    id:    'agl_flat',
    name:  'AGL',
    plan:  'Everyday (flat)',
    type:  'flat',
    rateAud:    0.3190,
    supplyAud:  1.0284,
    exportRateAud: 0.05,
    source: 'AGL SE QLD Jun-2025 estimate',
    url: 'https://www.agl.com.au/residential/electricity',
  },
  {
    id:    'energy_aus_flat',
    name:  'Energy Australia',
    plan:  'Everyday Saver (flat)',
    type:  'flat',
    rateAud:    0.3050,
    supplyAud:  1.0123,
    exportRateAud: 0.05,
    source: 'Energy Australia SE QLD Jun-2025 estimate',
    url: 'https://www.energyaustralia.com.au/home/electricity-and-gas/plans',
  },
  {
    id:    'red_energy_flat',
    name:  'Red Energy',
    plan:  'Living Energy Saver (flat)',
    type:  'flat',
    rateAud:    0.2885,
    supplyAud:  0.9842,
    exportRateAud: 0.055,
    source: 'Red Energy SE QLD Jun-2025 estimate',
    url: 'https://www.redenergy.com.au/electricity-and-gas/plans',
  },
  {
    id:    'alinta_flat',
    name:  'Alinta Energy',
    plan:  'No Frills (flat)',
    type:  'flat',
    rateAud:    0.2942,
    supplyAud:  0.8521,
    exportRateAud: 0.05,
    source: 'Alinta Energy SE QLD Jun-2025 estimate',
    url: 'https://www.alintaenergy.com.au/qld/electricity-plans',
  },
  {
    id:    'simply_flat',
    name:  'Simply Energy',
    plan:  'Simply Saver (flat)',
    type:  'flat',
    rateAud:    0.2960,
    supplyAud:  0.8910,
    exportRateAud: 0.05,
    source: 'Simply Energy SE QLD Jun-2025 estimate',
    url: 'https://www.simplyenergy.com.au',
  },
  {
    id:    'ergon_flat',
    name:  'Ergon / Energy Qld',
    plan:  'Residential (flat)',
    type:  'flat',
    rateAud:    0.3320,
    supplyAud:  1.0000,
    exportRateAud: 0.05,
    source: 'Ergon Energy SE QLD Jun-2025 estimate',
    url: 'https://www.ergon.com.au/retail/homes/electricity-plans',
  },
  {
    id:    'origin_tou',
    name:  'Origin Energy',
    plan:  'Time-of-Use',
    type:  'tou',
    tou: {
      peakAud:     0.4250,   // 3pm–9pm weekdays
      shoulderAud: 0.2750,   // 7am–3pm weekdays + all day weekends
      offPeakAud:  0.1650,   // 9pm–7am daily
    },
    supplyAud:  0.9977,
    exportRateAud: 0.05,
    source: 'Origin Energy SE QLD TOU Jun-2025 estimate',
    url: 'https://www.originenergy.com.au/electricity-gas/plans',
  },
  {
    id:    'amber_variable',
    name:  'Amber Electric',
    plan:  'Wholesale + 7.7¢ margin',
    type:  'info',   // can't model without live wholesale data
    rateAud:    null,
    supplyAud:  0.9000,
    exportRateAud: null,   // wholesale FiT - much higher in solar hours
    source: 'Amber Electric 2025',
    note: 'Amber charges the live wholesale spot price plus a fixed 7.7¢/kWh membership margin. Actual cost varies significantly - very cheap in solar-heavy hours, expensive during evening peak. Cannot be accurately modelled without live AEMO spot data.',
    url: 'https://www.amber.com.au',
  },
];

// ── TOU slot classifier ───────────────────────────────────────────────────────

/**
 * Returns 'peak' | 'shoulder' | 'offpeak' for a given timestamp.
 * QLD TOU periods (typical):
 *   Peak:      3pm–9pm weekdays
 *   Off-peak:  9pm–7am daily
 *   Shoulder:  7am–3pm weekdays + all day weekends
 */
function touSlot(tsMs) {
  const d = new Date(tsMs);
  const h = d.getHours();  // local time (server is Brisbane AEST = UTC+10, no DST)
  const dow = d.getDay(); // 0=Sun, 6=Sat
  const isWeekend = dow === 0 || dow === 6;

  if (h >= 21 || h < 7) return 'offpeak';
  if (!isWeekend && h >= 15 && h < 21) return 'peak';
  return 'shoulder';
}

// ── Core calculation ──────────────────────────────────────────────────────────

/**
 * Main comparison function.
 * @param {number} days  How many days of history to use (e.g. 30, 90)
 * @returns {{ retailers: Array, meta: object }}
 */
function compareRetailers(days = 90) {
  const slots = db.getHalfHourlyEnergyData(days);

  if (slots.length === 0) {
    return { retailers: [], meta: { days, slots: 0, message: 'No telemetry data available for the requested period.' } };
  }

  // Totals across the period
  let totalKwhImported = 0;
  let totalKwhExported = 0;
  let uniqueDays = new Set();

  // TOU breakdown
  const touBreakdown = { peak: 0, shoulder: 0, offpeak: 0 };

  for (const s of slots) {
    totalKwhImported += s.kwhImported;
    totalKwhExported += s.kwhExported;
    uniqueDays.add(Math.floor(s.slotMs / 86400000));
    const slot = touSlot(s.slotMs);
    touBreakdown[slot] += s.kwhImported;
  }

  const numDays = uniqueDays.size || days;

  // Current retailer rate from app settings (respects flat vs TOU mode)
  const currentRateAud  = db.getRateAtTimestamp(Date.now());
  const currentFitAud   = parseFloat(db.getSetting('feed_in_tariff_aud')   || '0.05');
  const supplyDailyAud  = parseFloat(db.getSetting('supply_charge_daily_aud') || '0.95');
  const currentRateMode = db.getSetting('electricity_rate_mode') || 'flat';
  const currentTouConfig = currentRateMode === 'tou' ? db.getTouConfigAtDate(Date.now()) : null;
  const currentTouWindows = currentTouConfig
    ? currentTouConfig.windows.map((w) => ({ label: w.label, rateAud: w.rate_aud, days: w.days, startTime: w.start_time, endTime: w.end_time }))
    : null;

  const currentUsageCost  = totalKwhImported * currentRateAud;
  const currentExportCredit = totalKwhExported * currentFitAud;
  const currentSupplyCost = numDays * supplyDailyAud;
  const currentTotalCost  = Math.max(0, currentUsageCost + currentSupplyCost - currentExportCredit);

  // Prefer a live CDR-fetched plan per retailer (see retailerRates.js) over the
  // static estimates below. Falls back automatically if no live cache exists
  // yet (fresh install, before the first nightly refresh) or a refresh failed.
  const live = retailerRates.getLiveRates();
  const annualisedFactor = 365 / numDays;

  let results;
  let disclaimer;

  if (live && live.retailers.length > 0) {
    results = live.retailers.map((plan) => {
      const { usageCost, supplyCost, exportCredit, totalCost } =
        retailerRates.costPlan(plan, slots, numDays, currentFitAud);
      const saving = currentTotalCost - totalCost;
      return {
        id: plan.id, name: plan.name, plan: plan.plan, type: plan.type,
        rateAud: plan.type === 'flat' ? plan.rateAud : null,
        tou: plan.type === 'tou' ? { windows: plan.windows } : undefined,
        supplyAud: plan.supplyAud, exportRateAud: plan.exportRateAud,
        source: plan.source, url: plan.url,
        usageCost: round2(usageCost), supplyCost: round2(supplyCost),
        exportCredit: round2(exportCredit), totalCost: round2(totalCost),
        annualised: round2(totalCost * annualisedFactor),
        saving: round2(saving), annualisedSaving: round2(saving * annualisedFactor),
      };
    });
    const fetchedDate = new Date(live.fetchedAt).toLocaleDateString('en-AU');
    disclaimer = `Live plan data from the AER's Consumer Data Right register (energymadeeasy.gov.au), fetched ${fetchedDate} for the ${live.distributor} network area. Shows each retailer's cheapest current residential plan for your usage pattern - always verify with the retailer before switching.`;
  } else {
    results = RETAILERS.map(r => {
      if (r.type === 'info') {
        return {
          ...r,
          usageCost: null, supplyCost: null, exportCredit: null, totalCost: null,
          annualised: null, saving: null, annualisedSaving: null, note: r.note,
        };
      }

      let usageCost = 0;
      if (r.type === 'tou') {
        usageCost =
          touBreakdown.peak     * r.tou.peakAud +
          touBreakdown.shoulder * r.tou.shoulderAud +
          touBreakdown.offpeak  * r.tou.offPeakAud;
      } else {
        usageCost = totalKwhImported * r.rateAud;
      }

      const fitRate      = r.exportRateAud ?? currentFitAud;
      const exportCredit = totalKwhExported * fitRate;
      const supplyCost   = numDays * r.supplyAud;
      const totalCost    = Math.max(0, usageCost + supplyCost - exportCredit);
      const saving       = currentTotalCost - totalCost;

      return {
        id: r.id, name: r.name, plan: r.plan, type: r.type,
        rateAud: r.type === 'tou' ? null : r.rateAud,
        tou: r.type === 'tou' ? r.tou : undefined,
        supplyAud: r.supplyAud, exportRateAud: r.exportRateAud,
        source: r.source, url: r.url,
        usageCost: round2(usageCost), supplyCost: round2(supplyCost),
        exportCredit: round2(exportCredit), totalCost: round2(totalCost),
        annualised: round2(totalCost * annualisedFactor),
        saving: round2(saving), annualisedSaving: round2(saving * annualisedFactor),
      };
    });
    disclaimer = 'Rates are approximate estimates for the Energex (SE QLD) network area as of mid-2025, and have not yet been refreshed from live data - always verify with the retailer before switching.';
  }

  // Sort: cheapest first (info type goes last)
  results.sort((a, b) => {
    if (a.totalCost === null) return 1;
    if (b.totalCost === null) return -1;
    return a.totalCost - b.totalCost;
  });

  return {
    retailers: results,
    current: {
      mode:          currentRateMode,
      rateAud:       currentRateMode === 'flat' ? currentRateAud : null,
      touWindows:    currentTouWindows,
      fitAud:        currentFitAud,
      supplyDailyAud,
      usageCost:     round2(currentUsageCost),
      supplyCost:    round2(currentSupplyCost),
      exportCredit:  round2(currentExportCredit),
      totalCost:     round2(currentTotalCost),
      annualised:    round2(currentTotalCost * 365 / numDays),
    },
    meta: {
      days,
      numDays,
      slots:            slots.length,
      totalKwhImported: round2(totalKwhImported),
      totalKwhExported: round2(totalKwhExported),
      touBreakdown: {
        peak:     round2(touBreakdown.peak),
        shoulder: round2(touBreakdown.shoulder),
        offpeak:  round2(touBreakdown.offpeak),
      },
      liveData:    !!(live && live.retailers.length > 0),
      lastFetchedAt: live ? live.fetchedAt : null,
      distributor:  live ? live.distributor : null,
      disclaimer,
    },
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { compareRetailers, RETAILERS };
