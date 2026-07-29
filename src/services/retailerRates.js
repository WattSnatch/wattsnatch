/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

/**
 * Live retailer plan rates via the Australian Energy Regulator's Consumer
 * Data Right (CDR) "Energy Product Reference Data" APIs.
 *
 * These are the same public, government-run, unauthenticated endpoints that
 * power the "Energy Made Easy" comparison site. No API key, no registration.
 * Coverage is limited to states on the National Energy Customer Framework
 * (QLD, NSW, VIC, SA, TAS, ACT) - WA and NT retailers are not on the CDR.
 *
 * Flow:
 *   1. Fetch the ACCC's data-holder brand register once per refresh, to
 *      resolve each known retailer's current productBaseUri.
 *   2. Per retailer, page the "Get Generic Plans" list filtered to the
 *      user's distributor, then fetch "Get Generic Plan Detail" for a
 *      bounded number of candidates.
 *   3. Cost each candidate plan against the user's own real half-hourly
 *      usage (reusing the same window-matching approach as the app's own
 *      TOU rate resolver), and keep the cheapest plan per retailer.
 *   4. Cache the result as JSON in settings; refreshed at most once daily.
 *
 * Every network call is wrapped so a single retailer/plan failure never
 * aborts the whole refresh, and a failed refresh always leaves the previous
 * cache (or the static estimate fallback in retailerComparison.js) in place.
 */

const db = require('../db');
const logger = require('../utils/logger');

const ACCC_REGISTER_URL = 'https://api.cdr.gov.au/cdr-register/v1/all/data-holders/brands/summary';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_CANDIDATE_PLANS_PER_RETAILER = 20; // bounds detail-fetch calls per retailer per refresh
const REQUEST_STAGGER_MS = 150; // be a polite citizen of a free government API

// Our internal retailer ids -> the CDR brand name(s) to match (case-insensitive substring).
// One entry per retailer we want to show; a retailer can match multiple brand
// names if they've been known by more than one over time.
const KNOWN_RETAILERS = [
  { id: 'origin',       name: 'Origin Energy',   brandMatch: ['origin energy'] },
  { id: 'agl',          name: 'AGL',             brandMatch: ['agl'] },
  { id: 'energy_aus',   name: 'Energy Australia',brandMatch: ['energyaustralia', 'energy australia'] },
  { id: 'red_energy',   name: 'Red Energy',      brandMatch: ['red energy'] },
  { id: 'alinta',       name: 'Alinta Energy',   brandMatch: ['alinta'] },
  { id: 'simply',       name: 'Simply Energy',   brandMatch: ['simply energy'] },
  { id: 'ergon',        name: 'Ergon Energy',    brandMatch: ['ergon'] },
];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * Fetch a CDR endpoint, automatically retrying with the version the server
 * reports it actually supports. Every retailer's CDR gateway independently
 * negotiates its own x-v range, so a single hardcoded version doesn't work
 * across all of them.
 */
async function cdrFetch(url, { timeoutMs = 15000, startVersion = 1 } = {}) {
  let version = startVersion;
  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { headers: { 'x-v': String(version), 'Accept': 'application/json' }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return res.json();

    if (res.status === 406) {
      const body = await res.json().catch(() => null);
      const detail = body?.errors?.[0]?.detail || '';
      const maxMatch = detail.match(/max[=:]\s*(\d+)/i);
      const minMatch = detail.match(/min[=:]\s*(\d+)/i);
      if (maxMatch && version > parseInt(maxMatch[1], 10)) { version = parseInt(maxMatch[1], 10); continue; }
      if (minMatch && version < parseInt(minMatch[1], 10)) { version = parseInt(minMatch[1], 10); continue; }
    }
    throw new Error(`CDR fetch failed (${res.status}) for ${url}`);
  }
  throw new Error(`CDR fetch: could not negotiate a supported version for ${url}`);
}

let _brandRegistryCache = null;
async function getBrandRegistry() {
  if (_brandRegistryCache) return _brandRegistryCache;
  // v1 of this endpoint returns 200 but omits productBaseUri entirely (it was
  // added in v2) - request v2 directly rather than relying on 406 negotiation,
  // since a 200 response never triggers the version-bump retry in cdrFetch().
  const json = await cdrFetch(ACCC_REGISTER_URL, { startVersion: 2 });
  const brands = (json.data || []).filter((b) => (b.industries || []).includes('energy') && b.productBaseUri);
  _brandRegistryCache = brands;
  return brands;
}

function resolveProductBaseUri(brands, brandMatchers) {
  const lower = brandMatchers.map((m) => m.toLowerCase());
  const hit = brands.find((b) => lower.some((m) => b.brandName.toLowerCase().includes(m)));
  return hit ? hit.productBaseUri : null;
}

/** Page through Get Generic Plans, filtering client-side to the given distributor. */
async function listDistributorPlans(productBaseUri, distributor) {
  const matches = [];
  let page = 1;
  const maxPages = 5; // 5x1000 = 5000 plans is far more than any single retailer publishes nationally
  while (page <= maxPages) {
    const url = `${productBaseUri}/cds-au/v1/energy/plans?type=ALL&fuelType=ELECTRICITY&effective=CURRENT&page=${page}&page-size=1000`;
    const json = await cdrFetch(url);
    const plans = json?.data?.plans || [];
    for (const p of plans) {
      if ((p.geography?.distributors || []).includes(distributor)) matches.push(p);
    }
    const totalPages = json?.meta?.totalPages || 1;
    if (page >= totalPages || matches.length >= MAX_CANDIDATE_PLANS_PER_RETAILER * 3) break;
    page++;
    await sleep(REQUEST_STAGGER_MS);
  }
  return matches.slice(0, MAX_CANDIDATE_PLANS_PER_RETAILER);
}

async function getPlanDetail(productBaseUri, planId) {
  const url = `${productBaseUri}/cds-au/v1/energy/plans/${encodeURIComponent(planId)}`;
  const json = await cdrFetch(url);
  return json?.data || null;
}

/** CDR day codes -> JS Date.getDay() */
const DAY_MAP = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function slotMatchesWindow(dow, minuteOfDay, window) {
  if (!(window.days || []).some((d) => DAY_MAP[d] === dow)) return false;
  const s = timeToMinutes(window.startTime);
  const e = timeToMinutes(window.endTime);
  return s <= e ? (minuteOfDay >= s && minuteOfDay <= e) : (minuteOfDay >= s || minuteOfDay <= e);
}

/**
 * Normalize a raw CDR plan-detail response into the flat shape
 * retailerComparison.js already knows how to cost and render, plus a raw
 * `windows` array (for TOU plans) used to bin the user's own usage.
 */
function normalizePlanDetail(retailerId, retailerName, planSummary, detail) {
  const ec = detail.electricityContract;
  if (!ec || !ec.tariffPeriod || ec.tariffPeriod.length === 0) return null;

  // Multiple tariffPeriod entries usually represent different seasons/anniversary
  // years of the same ongoing plan; take the first, which is always the current one.
  const period = ec.tariffPeriod[0];

  // Demand tariffs charge extra per kW of peak demand in specific windows, on
  // top of the usage rate - a real, sometimes large cost that lives in a
  // sibling `demandCharges` array we don't otherwise touch. Properly costing
  // it needs the user's actual peak kW per billing period, which we don't
  // compute. Silently ignoring it made demand plans look artificially cheap
  // (caught in review: a plan with a real demand charge was ranked #1
  // "cheapest" while actually being more expensive on Energy Made Easy) -
  // skip these plans entirely rather than misrepresent their true cost.
  if (period.demandCharges && period.demandCharges.length > 0) return null;

  // Usage and supply-charge unitPrice fields in the CDR schema are GST-exclusive
  // (confirmed empirically: Alinta's raw dailySupplyCharge of $1.5361 x 1.1 =
  // $1.6897, matching the ~168c/day the user independently saw on Energy Made
  // Easy for the same plan - EME, like the app's own settings, displays
  // GST-inclusive prices). Every downstream cost figure needs the same
  // treatment as the user's own settings, or "cheaper" comparisons are
  // meaningless.
  const GST = 1.1;
  const supplyAud = parseFloat(period.dailySupplyCharge || '0') * GST;

  // Feed-in tariff GST treatment is NOT consistent across retailers - unlike
  // usage/supply, each retailer states in the FiT's own `description` text
  // whether its figure already includes GST (seen in real responses: Origin
  // and Red Energy publish GST-inclusive FiT numbers; AGL, EnergyAustralia
  // and Alinta explicitly publish theirs "ex GST"/"excl GST"). Must be
  // detected per-plan from that text rather than assumed.
  const fitEntries = ec.solarFeedInTariff || [];
  let exportRateAud = null;
  if (fitEntries.length) {
    const fit = fitEntries[0];
    const raw = parseFloat(fit?.singleTariff?.rates?.[0]?.unitPrice ?? fit?.tieredTariff?.rates?.[0]?.rates?.[0]?.unitPrice ?? '0');
    const desc = (fit.description || '').toLowerCase();
    const alreadyIncludesGst = /gst[\s-]*incl|incl[\s.]*gst|included\s+if\s+any/.test(desc);
    exportRateAud = alreadyIncludesGst ? raw : raw * GST;
  }

  if (period.rateBlockUType === 'singleRate') {
    const rateAud = parseFloat(period.singleRate?.rates?.[0]?.unitPrice || '0') * GST;
    if (!rateAud) return null;
    return {
      id: `${retailerId}_${planSummary.planId}`, name: retailerName, plan: detail.displayName || planSummary.planId,
      type: 'flat', rateAud, supplyAud, exportRateAud,
      source: `Live CDR data, fetched ${new Date().toISOString().split('T')[0]}`,
      url: `https://www.energymadeeasy.gov.au`,
      planId: planSummary.planId, windows: null,
    };
  }

  if (period.rateBlockUType === 'timeOfUseRates') {
    const windows = [];
    for (const block of period.timeOfUseRates || []) {
      const rateAud = parseFloat(block.rates?.[0]?.unitPrice || '0') * GST;
      for (const tou of block.timeOfUse || []) {
        windows.push({ days: tou.days || [], startTime: tou.startTime, endTime: tou.endTime, rateAud, label: block.displayName || block.type });
      }
    }
    if (windows.length === 0) return null;
    return {
      id: `${retailerId}_${planSummary.planId}`, name: retailerName, plan: detail.displayName || planSummary.planId,
      type: 'tou', supplyAud, exportRateAud, windows,
      source: `Live CDR data, fetched ${new Date().toISOString().split('T')[0]}`,
      url: `https://www.energymadeeasy.gov.au`,
      planId: planSummary.planId,
    };
  }

  return null; // controlled-load / other exotic rate structures: skip rather than misrepresent
}

/**
 * Cost a normalized plan against the user's real half-hourly usage.
 * Returns the full breakdown so callers can render usage/supply/export/total
 * the same way the app already does for the static fallback list.
 */
function costPlan(plan, slots, numDays, fallbackFitAud) {
  let usageCost = 0;
  const fitRate = plan.exportRateAud ?? fallbackFitAud;
  let totalExported = 0;

  if (plan.type === 'flat') {
    for (const s of slots) { usageCost += s.kwhImported * plan.rateAud; totalExported += s.kwhExported; }
  } else {
    for (const s of slots) {
      const d = new Date(s.slotMs);
      const dow = d.getDay();
      const minuteOfDay = d.getHours() * 60 + d.getMinutes();
      const win = plan.windows.find((w) => slotMatchesWindow(dow, minuteOfDay, w));
      // No matching window (gap in the plan's published windows): cost at the
      // cheapest known window rather than silently giving away free energy.
      const rate = win ? win.rateAud : Math.min(...plan.windows.map((w) => w.rateAud));
      usageCost += s.kwhImported * rate;
      totalExported += s.kwhExported;
    }
  }

  const supplyCost = numDays * plan.supplyAud;
  const exportCredit = totalExported * fitRate;
  const totalCost = Math.max(0, usageCost + supplyCost - exportCredit);
  return { usageCost, supplyCost, exportCredit, totalCost };
}

/**
 * Runs the full refresh: resolve retailers, fetch+cost candidate plans,
 * keep the cheapest per retailer, cache the result. Never throws - always
 * logs and leaves the previous cache untouched on failure.
 */
async function refreshLiveRates() {
  const distributor = db.getSetting('retailer_network_distributor') || 'Energex';
  const slots = db.getHalfHourlyEnergyData(90);
  const fallbackFitAud = parseFloat(db.getSetting('feed_in_tariff_aud') || '0.05');
  const uniqueDays = new Set(slots.map((s) => Math.floor(s.slotMs / 86400000)));
  const numDays = uniqueDays.size || 90;

  let brands;
  try {
    brands = await getBrandRegistry();
  } catch (err) {
    logger.logEvent('api_error', `Retailer live rates: ACCC brand registry fetch failed: ${err.message}`);
    return;
  }

  const results = [];
  for (const retailer of KNOWN_RETAILERS) {
    try {
      const productBaseUri = resolveProductBaseUri(brands, retailer.brandMatch);
      if (!productBaseUri) {
        logger.logEvent('api_error', `Retailer live rates: ${retailer.name} not found in CDR register`);
        continue;
      }

      const candidates = await listDistributorPlans(productBaseUri, distributor);
      let cheapest = null;
      for (const summary of candidates) {
        await sleep(REQUEST_STAGGER_MS);
        let detail;
        try {
          detail = await getPlanDetail(productBaseUri, summary.planId);
        } catch (err) {
          continue; // one bad plan shouldn't sink the whole retailer
        }
        if (detail?.customerType && detail.customerType !== 'RESIDENTIAL') continue;
        const plan = normalizePlanDetail(retailer.id, retailer.name, summary, detail);
        if (!plan) continue;
        const cost = slots.length ? costPlan(plan, slots, numDays, fallbackFitAud).totalCost : null;
        if (cheapest === null || (cost !== null && cost < cheapest.cost)) cheapest = { ...plan, cost };
      }

      if (cheapest) {
        delete cheapest.cost;
        // `windows` (TOU plans only) is kept in the cache - retailerComparison.js
        // re-costs it per-request against whatever period the user has selected,
        // rather than being locked to the 90-day window used to pick "cheapest".
        results.push(cheapest);
      } else {
        logger.logEvent('api_error', `Retailer live rates: no ${distributor} residential plan found for ${retailer.name}`);
      }
    } catch (err) {
      logger.logEvent('api_error', `Retailer live rates: ${retailer.name} refresh failed: ${err.message}`);
    }
  }

  if (results.length === 0) {
    logger.logEvent('api_error', 'Retailer live rates: refresh produced zero usable plans, keeping previous cache');
    return;
  }

  db.setSetting('retailer_live_rates_json', JSON.stringify(results));
  db.setSetting('retailer_live_rates_fetched_at', String(Date.now()));
  db.setSetting('retailer_live_rates_distributor', distributor);
  logger.logEvent('info', `Retailer live rates: refreshed ${results.length}/${KNOWN_RETAILERS.length} retailers for ${distributor}`);
}

function getLiveRates() {
  const json = db.getSetting('retailer_live_rates_json');
  if (!json) return null;
  try {
    return {
      retailers: JSON.parse(json),
      fetchedAt: parseInt(db.getSetting('retailer_live_rates_fetched_at') || '0', 10),
      distributor: db.getSetting('retailer_live_rates_distributor') || null,
    };
  } catch (_e) { return null; }
}

/** Called from the controller's daily tick; refreshes at most once per day. */
async function refreshIfDue() {
  const lastFetchedAt = parseInt(db.getSetting('retailer_live_rates_fetched_at') || '0', 10);
  if (Date.now() - lastFetchedAt < REFRESH_INTERVAL_MS) return;
  await refreshLiveRates();
}

module.exports = { refreshLiveRates, refreshIfDue, getLiveRates, costPlan, KNOWN_RETAILERS };
