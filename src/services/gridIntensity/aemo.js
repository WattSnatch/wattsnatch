/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

// AEMO (Australian Energy Market Operator) grid-carbon-intensity provider.
// This is a verbatim move of weatherGrid.js's original fetchGridIntensity()
// body - zero behavior change, zero regression risk for existing AU
// installs. See ../../../FEATURES.md for the carbon-intensity model notes.
//
// Uses AEMO's public visualisation API - no API key required.
// ELEC_NEM_SUMMARY gives us TOTALDEMAND, SCHEDULEDGENERATION, SEMISCHEDULEDGENERATION
// for each NEM region every 5 minutes.
//
// QLD semi-scheduled generation is predominantly large-scale solar farms and
// wind farms. Scheduled generation is mostly coal and gas.
//
// Carbon intensity model (approximate, QLD-specific):
//   - Semi-scheduled (solar/wind): 0 gCO2/kWh
//   - Scheduled thermal (coal ~70%, gas ~20%, hydro ~10%):
//       0.70*820 + 0.20*490 + 0.10*4 ≈ 676 gCO2/kWh average
//   - intensity = scheduledMw * THERMAL_INTENSITY / totalDemandMw
//
// Note: rooftop solar reduces TOTALDEMAND (it's net demand) and is NOT
// captured in SEMISCHEDULEDGENERATION, so renewable% will be an undercount.

const FETCH_TIMEOUT_MS = 15 * 1000;
const AEMO_SUMMARY_URL = 'https://visualisations.aemo.com.au/aemo/apps/api/report/ELEC_NEM_SUMMARY';

// Average gCO2/kWh for QLD scheduled (thermal) generation fleet
const QLD_THERMAL_INTENSITY_G = 676;

function isConfigured() {
  return true; // no API key required
}

async function fetchGridIntensity() {
  const res = await fetch(AEMO_SUMMARY_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`AEMO API ${res.status}`);
  const raw = await res.json();

  const summary = raw.ELEC_NEM_SUMMARY || [];
  const qld = summary.find(r => r.REGIONID === 'QLD1');
  if (!qld) throw new Error('QLD1 not found in AEMO NEM summary');

  const totalDemandMw        = qld.TOTALDEMAND           || 0;
  const scheduledMw          = qld.SCHEDULEDGENERATION   || 0;
  const semiScheduledMw      = qld.SEMISCHEDULEDGENERATION || 0;   // large-scale solar + wind
  const spotPriceAuMwh       = qld.PRICE                 ?? null;

  // Renewable% - semi-scheduled / total demand
  // (undercount because rooftop solar reduces demand but isn't in semiScheduled)
  const renewablePct = totalDemandMw > 0
    ? Math.min(100, (semiScheduledMw / totalDemandMw) * 100)
    : 0;

  // Carbon intensity - only scheduled (thermal) generation emits
  const carbonIntensityG = totalDemandMw > 0
    ? (scheduledMw * QLD_THERMAL_INTENSITY_G) / totalDemandMw
    : QLD_THERMAL_INTENSITY_G;

  return {
    renewablePct:      Math.round(renewablePct * 10) / 10,
    carbonIntensityG:  Math.round(carbonIntensityG),
    solarMw:           Math.round(semiScheduledMw),  // large-scale solar + wind (QLD mostly solar)
    windMw:            0,                            // not separately available from this API
    coalMw:            Math.round(scheduledMw * 0.70),
    gasMw:             Math.round(scheduledMw * 0.20),
    hydroMw:           Math.round(scheduledMw * 0.10),
    totalDemandMw:     Math.round(totalDemandMw),
    spotPriceAuMwh:    spotPriceAuMwh != null ? Math.round(spotPriceAuMwh) : null,
    settlementDate:    qld.SETTLEMENTDATE || null,
  };
}

module.exports = { id: 'aemo', label: 'AEMO (Australia)', isConfigured, fetchGridIntensity };
