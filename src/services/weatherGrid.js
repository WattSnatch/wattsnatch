/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

/**
 * Weather & Grid Intelligence Service
 *
 * Polls two free APIs on a schedule:
 *   1. Open-Meteo  (no API key) - weather forecast every 30 min
 *   2. OpenNEM     (no API key) - QLD1 grid carbon intensity every 5 min
 *
 * Results are cached in the DB and exposed via getWeather() / getGridIntensity().
 */

const db     = require('../db');
const logger = require('../utils/logger');
const gridIntensity = require('./gridIntensity');

// ── Config ────────────────────────────────────────────────────────────────────

const WEATHER_INTERVAL_MS  = 30 * 60 * 1000;   // 30 min
const GRID_INTERVAL_MS     =  5 * 60 * 1000;   //  5 min
const FETCH_TIMEOUT_MS     = 15 * 1000;

// Carbon intensity factors gCO2eq/kWh (lifecycle, IEA estimates)
const INTENSITY_FACTORS = {
  coal_black:           820,
  coal_brown:          1050,
  gas_ccgt:             490,
  gas_ocgt:             650,
  gas_recip:            650,
  gas_steam:            650,
  gas_wcmg:             650,
  solar_utility:          0,
  solar_rooftop:          0,
  wind:                   0,
  hydro:                  4,
  pumps:                  4,
  battery_discharging:    0,   // charged from renewables
  battery_charging:       0,
  distillate:           830,
  bioenergy_biogas:     230,
  bioenergy_biomass:    230,
  imports:              500,   // rough average for interstate (NSW/VIC)
};

const RENEWABLE_FUELS = new Set([
  'solar_utility', 'solar_rooftop', 'wind', 'hydro', 'pumps',
  'battery_discharging', 'bioenergy_biogas', 'bioenergy_biomass',
]);

// WMO weather code → emoji + description
const WMO_DESCRIPTIONS = {
  0:  { emoji: '☀️',  label: 'Clear sky' },
  1:  { emoji: '🌤️', label: 'Mainly clear' },
  2:  { emoji: '⛅',  label: 'Partly cloudy' },
  3:  { emoji: '☁️',  label: 'Overcast' },
  45: { emoji: '🌫️', label: 'Foggy' },
  48: { emoji: '🌫️', label: 'Icy fog' },
  51: { emoji: '🌦️', label: 'Light drizzle' },
  53: { emoji: '🌦️', label: 'Drizzle' },
  55: { emoji: '🌧️', label: 'Heavy drizzle' },
  61: { emoji: '🌧️', label: 'Slight rain' },
  63: { emoji: '🌧️', label: 'Rain' },
  65: { emoji: '🌧️', label: 'Heavy rain' },
  71: { emoji: '🌨️', label: 'Slight snow' },
  73: { emoji: '🌨️', label: 'Snow' },
  75: { emoji: '❄️',  label: 'Heavy snow' },
  80: { emoji: '🌦️', label: 'Showers' },
  81: { emoji: '🌧️', label: 'Rain showers' },
  82: { emoji: '⛈️',  label: 'Violent showers' },
  95: { emoji: '⛈️',  label: 'Thunderstorm' },
  96: { emoji: '⛈️',  label: 'Thunderstorm + hail' },
  99: { emoji: '⛈️',  label: 'Thunderstorm + heavy hail' },
};

function wmoLabel(code) {
  return WMO_DESCRIPTIONS[code] || { emoji: '🌡️', label: `Code ${code}` };
}

// ── State ─────────────────────────────────────────────────────────────────────

let _weatherTimer  = null;
let _gridTimer     = null;
let _started       = false;

// In-memory cache (avoids DB read on every SSE tick)
let _weatherCache  = null;
let _gridCache     = null;

// ── Weather fetch ─────────────────────────────────────────────────────────────

async function fetchWeather() {
  // Use home lat/lng from DB settings; fall back to Brisbane CBD
  const lat = parseFloat(db.getSetting('home_latitude')  || '-27.4698');
  const lng = parseFloat(db.getSetting('home_longitude') || '153.0251');

  const params = new URLSearchParams({
    latitude:    lat,
    longitude:   lng,
    current:     'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,cloud_cover',
    hourly:      'temperature_2m,precipitation_probability,weather_code,cloud_cover',
    daily:       'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,sunrise,sunset',
    // 'auto' = Open-Meteo infers the timezone from the coordinates, so daily
    // boundaries and sunrise/sunset match the site's local time wherever the
    // install is - previously hardcoded to Australia/Brisbane, which skewed
    // forecasts for any site outside that timezone.
    timezone:    'auto',
    forecast_days: 7,
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const raw = await res.json();

  // Parse current conditions
  const c = raw.current;
  const wmo = wmoLabel(c.weather_code);

  // Build next-7-day daily forecast
  const daily = [];
  for (let i = 0; i < (raw.daily?.time?.length || 0); i++) {
    const d = wmoLabel(raw.daily.weather_code[i]);
    daily.push({
      date:      raw.daily.time[i],
      weatherCode: raw.daily.weather_code[i],
      emoji:     d.emoji,
      label:     d.label,
      tempMax:   raw.daily.temperature_2m_max[i],
      tempMin:   raw.daily.temperature_2m_min[i],
      rainMm:    raw.daily.precipitation_sum[i],
      sunrise:   raw.daily.sunrise[i],
      sunset:    raw.daily.sunset[i],
    });
  }

  // Next-24h hourly (solar relevance: cloud_cover + precip_probability)
  const now = Date.now();
  const hourly = [];
  for (let i = 0; i < (raw.hourly?.time?.length || 0); i++) {
    const t = new Date(raw.hourly.time[i]).getTime();
    if (t >= now && hourly.length < 24) {
      hourly.push({
        time:     raw.hourly.time[i],
        temp:     raw.hourly.temperature_2m[i],
        precipPct: raw.hourly.precipitation_probability[i],
        cloudCover: raw.hourly.cloud_cover[i],
        weatherCode: raw.hourly.weather_code[i],
      });
    }
  }

  const data = {
    current: {
      temp:       c.temperature_2m,
      feelsLike:  c.apparent_temperature,
      humidity:   c.relative_humidity_2m,
      windKmh:    c.wind_speed_10m,
      cloudCover: c.cloud_cover,
      weatherCode: c.weather_code,
      emoji:      wmo.emoji,
      label:      wmo.label,
    },
    daily,
    hourly,
    lat, lng,
  };

  db.upsertWeatherCache(data);
  _weatherCache = { fetchedAt: Date.now(), data };
  return data;
}

// ── Grid intensity fetch ──────────────────────────────────────────────────────
// Delegates to the active provider in src/services/gridIntensity/ (AEMO by
// default - existing AU installs see zero behavior change - or WattTime/
// ElectricityMaps once a US user configures one). This wrapper only owns the
// caching/persistence, not the fetch logic itself - see gridIntensity/*.js.

async function fetchGridIntensity() {
  const provider = gridIntensity.getActiveProvider();
  if (!provider.isConfigured()) {
    // Distinct from a fetch failure - nothing to poll yet, not an error.
    _gridCache = { recordedAt: Date.now(), notConfigured: true, provider: provider.id };
    return null;
  }

  const payload = await provider.fetchGridIntensity();
  db.insertGridIntensity(payload);
  _gridCache = { recordedAt: Date.now(), ...payload };
  return payload;
}

// ── Service lifecycle ─────────────────────────────────────────────────────────

async function _pollWeather() {
  try {
    await fetchWeather();
  } catch (err) {
    logger.logEvent('api_error', `[weatherGrid] Weather fetch failed: ${err.message}`);
  }
}

async function _pollGrid() {
  try {
    await fetchGridIntensity();
  } catch (err) {
    logger.logEvent('api_error', `[weatherGrid] Grid intensity fetch failed: ${err.message}`);
  }
}

function start() {
  if (_started) return;
  _started = true;

  // Restore from DB cache immediately so the dashboard has data before the first poll
  const wc = db.getWeatherCache();
  if (wc) _weatherCache = wc;
  const gc = db.getLatestGridIntensity();
  if (gc) {
    _gridCache = {
      recordedAt:       gc.recorded_at,
      renewablePct:     gc.renewable_pct,
      carbonIntensityG: gc.carbon_intensity_g,
      solarMw:          gc.solar_mw,
      windMw:           gc.wind_mw,
      coalMw:           gc.coal_mw,
      gasMw:            gc.gas_mw,
      hydroMw:          gc.hydro_mw,
      totalDemandMw:    gc.total_demand_mw,
    };
  }

  // Kick off immediately, then on intervals
  _pollWeather();
  _pollGrid();
  _weatherTimer = setInterval(_pollWeather, WEATHER_INTERVAL_MS);
  _gridTimer    = setInterval(_pollGrid,    GRID_INTERVAL_MS);
  logger.logEvent('info', '[weatherGrid] Service started (weather 30 min, grid 5 min)');
}

function stop() {
  if (_weatherTimer) { clearInterval(_weatherTimer); _weatherTimer = null; }
  if (_gridTimer)    { clearInterval(_gridTimer);    _gridTimer    = null; }
  _started = false;
}

// ── Getters ───────────────────────────────────────────────────────────────────

function getWeather() {
  return _weatherCache;
}

function getGridIntensity() {
  return _gridCache;
}

module.exports = { start, stop, getWeather, getGridIntensity, fetchWeather, fetchGridIntensity };
