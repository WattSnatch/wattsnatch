/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');

// WATTSNATCH_DB_PATH lets the test suite point at a throwaway file instead
// of ever touching the real database - unset in normal operation.
const DB_DIR = path.join(os.homedir(), '.solarcharge');
const DB_PATH = process.env.WATTSNATCH_DB_PATH || path.join(DB_DIR, 'solarcharge.db');

let db = null;

function initDb() {
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(DB_PATH);

  // Secure the file
  try {
    fs.chmodSync(DB_PATH, 0o600);
  } catch (_err) { /* ignore if already exists */ }

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      provider TEXT PRIMARY KEY,
      token_data TEXT,
      expires_at INTEGER,
      account_info TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS charge_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER,
      ended_at INTEGER,
      duration_secs INTEGER,
      kwh_solar REAL,
      battery_start INTEGER,
      battery_end INTEGER,
      peak_amps INTEGER,
      avg_amps REAL,
      est_savings_aud REAL,
      end_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS telemetry_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at INTEGER,
      solar_w REAL,
      consumption_w REAL,
      grid_w REAL,
      solar_excess_w REAL,
      ev_w REAL,
      charge_amps INTEGER,
      battery_pct REAL,
      controller_state TEXT,
      session_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS events_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at INTEGER,
      event_type TEXT,
      old_state TEXT,
      new_state TEXT,
      details TEXT
    );

    CREATE TABLE IF NOT EXISTS electricity_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rate_aud REAL NOT NULL,
      effective_from INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- A "TOU rate config" is one version of a time-of-use rate card, versioned
    -- by effective_from the same way electricity_rates is. default_rate_aud
    -- covers any time not matched by one of its tou_rate_windows (i.e. off-peak).
    CREATE TABLE IF NOT EXISTS tou_rate_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      default_rate_aud REAL NOT NULL,
      effective_from INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tou_rate_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_id INTEGER NOT NULL REFERENCES tou_rate_configs(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      rate_aud REAL NOT NULL,
      days TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tou_configs_effective_from ON tou_rate_configs (effective_from);
    CREATE INDEX IF NOT EXISTS idx_tou_windows_config_id ON tou_rate_windows (config_id);

    -- Time-varying EXPORT (feed-in) rate, mirroring tou_rate_configs/tou_rate_windows
    -- column-for-column. Needed for markets like California's NEM 3.0, where the
    -- export credit itself varies through the day (often near-zero at midday) rather
    -- than being a single flat feed-in tariff. Additive/optional: falls back to the
    -- existing flat tariff_history('feed_in') value when export_rate_mode is 'flat'
    -- or no config exists - see createExportRateResolver().
    CREATE TABLE IF NOT EXISTS export_rate_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      default_rate_aud REAL NOT NULL,
      effective_from INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS export_rate_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_id INTEGER NOT NULL REFERENCES export_rate_configs(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      rate_aud REAL NOT NULL,
      days TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_export_configs_effective_from ON export_rate_configs (effective_from);
    CREATE INDEX IF NOT EXISTS idx_export_windows_config_id ON export_rate_windows (config_id);

    CREATE TABLE IF NOT EXISTS eddi_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at INTEGER NOT NULL,
      diverted_w INTEGER DEFAULT 0,
      status TEXT DEFAULT 'Unknown',
      energy_today_kwh REAL DEFAULT 0,
      boost_today_kwh REAL DEFAULT 0,
      temp1 REAL,
      temp2 REAL
    );

    CREATE TABLE IF NOT EXISTS ac_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT,
      is_on INTEGER DEFAULT 0,
      mode TEXT DEFAULT 'Unknown',
      set_temperature REAL,
      room_temperature REAL,
      daily_energy_kwh REAL DEFAULT 0,
      total_energy_kwh REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS load_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at INTEGER NOT NULL,
      solar_w REAL,
      house_w REAL,
      ac_on INTEGER DEFAULT 0,
      outside_temp_approx REAL
    );

    CREATE TABLE IF NOT EXISTS electricity_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      email_id TEXT UNIQUE,
      billing_period_start INTEGER,
      billing_period_end INTEGER,
      retailer TEXT,
      account_number TEXT,
      total_amount_aud REAL,
      gst_aud REAL,
      supply_charge_aud REAL,
      usage_charge_aud REAL,
      solar_export_credit_aud REAL DEFAULT 0,
      total_kwh REAL,
      peak_kwh REAL,
      off_peak_kwh REAL,
      shoulder_kwh REAL,
      solar_export_kwh REAL DEFAULT 0,
      supply_charge_cents_per_day REAL,
      peak_rate_cents REAL,
      off_peak_rate_cents REAL,
      shoulder_rate_cents REAL,
      notes TEXT,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS known_destinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      address TEXT,
      lat REAL,
      lng REAL,
      distance_km REAL,
      avg_kwh_required REAL,
      visit_count INTEGER DEFAULT 0,
      last_visited INTEGER
    );

    CREATE TABLE IF NOT EXISTS trip_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      destination_name TEXT,
      destination_id INTEGER,
      distance_km REAL,
      departure_time INTEGER,
      predicted_kwh REAL,
      actual_kwh REAL,
      floor_maintained INTEGER,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS solcast_forecasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at INTEGER NOT NULL,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      pv_estimate_kw REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS solcast_intraday_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracked_at INTEGER NOT NULL,
      forecast_accuracy_ratio REAL,
      forecast_remaining_kwh REAL,
      adjusted_remaining_kwh REAL
    );

    CREATE TABLE IF NOT EXISTS financial_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      kwh_imported REAL DEFAULT 0,
      kwh_exported REAL DEFAULT 0,
      kwh_solar_self_consumed REAL DEFAULT 0,
      kwh_solar_to_tesla REAL DEFAULT 0,
      kwh_solar_to_hotwater REAL DEFAULT 0,
      kwh_solar_to_house REAL DEFAULT 0,
      import_cost REAL DEFAULT 0,
      export_credit REAL DEFAULT 0,
      solar_avoided_cost REAL DEFAULT 0,
      net_cost REAL DEFAULT 0,
      supply_charge REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ev_home_charging_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      kwh_charged REAL,
      kwh_from_solar REAL,
      kwh_from_grid REAL,
      cost_basis REAL,
      session_start INTEGER,
      session_end INTEGER,
      charge_session_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS panel_production (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at INTEGER,
      panel_id TEXT,
      wh_produced REAL,
      irradiance_approx REAL
    );

    CREATE TABLE IF NOT EXISTS panel_health_alerts (
      panel_id TEXT PRIMARY KEY,
      last_notified_at INTEGER,
      last_pct_below REAL,
      alert_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS day_replays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT UNIQUE NOT NULL,
      data_json TEXT NOT NULL,
      aggregated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_telemetry_recorded_at ON telemetry_log (recorded_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_started_at   ON charge_sessions (started_at);
    CREATE INDEX IF NOT EXISTS idx_rates_effective_from  ON electricity_rates (effective_from);

    CREATE TABLE IF NOT EXISTS tariff_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      rate_aud REAL NOT NULL,
      effective_from INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tariff_history_type_from ON tariff_history (type, effective_from);
    CREATE INDEX IF NOT EXISTS idx_eddi_recorded_at ON eddi_telemetry (recorded_at);
    CREATE INDEX IF NOT EXISTS idx_ac_recorded_at ON ac_telemetry (recorded_at);
    CREATE INDEX IF NOT EXISTS idx_bills_period_start ON electricity_bills (billing_period_start);
    CREATE INDEX IF NOT EXISTS idx_trip_log_departure ON trip_log (departure_time);
    CREATE INDEX IF NOT EXISTS idx_solcast_forecasts_period ON solcast_forecasts (period_start, period_end);
    CREATE INDEX IF NOT EXISTS idx_solcast_forecasts_fetched ON solcast_forecasts (fetched_at);
    CREATE INDEX IF NOT EXISTS idx_financial_ledger_date ON financial_ledger (date);
    CREATE INDEX IF NOT EXISTS idx_ev_home_charging_log_date ON ev_home_charging_log (date);
    CREATE INDEX IF NOT EXISTS idx_panel_production_panel_at ON panel_production (panel_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_panel_production_recorded_at ON panel_production (recorded_at);
    CREATE INDEX IF NOT EXISTS idx_day_replays_date ON day_replays (date);

    CREATE TABLE IF NOT EXISTS departure_schedule (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      departure_time INTEGER NOT NULL,
      target_soc    INTEGER NOT NULL,
      notes         TEXT,
      created_at    INTEGER NOT NULL,
      active        INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS weather_cache (
      id         INTEGER PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      data_json  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS grid_intensity_log (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at        INTEGER NOT NULL,
      renewable_pct      REAL,
      carbon_intensity_g REAL,
      solar_mw           REAL,
      wind_mw            REAL,
      coal_mw            REAL,
      gas_mw             REAL,
      hydro_mw           REAL,
      total_demand_mw    REAL
    );

    CREATE INDEX IF NOT EXISTS idx_grid_intensity_recorded_at ON grid_intensity_log (recorded_at);
  `);

  // ─── Migrations ───────────────────────────────────────────────────────────
  try { db.exec('ALTER TABLE eddi_telemetry ADD COLUMN boost_today_kwh REAL DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE telemetry_log  ADD COLUMN eddi_w REAL DEFAULT 0');          } catch (_) {}
  // Phase 2 - TeslaMate provenance columns for charge_sessions
  try { db.exec('ALTER TABLE charge_sessions ADD COLUMN teslamate_charge_id INTEGER'); }  catch (_) {}
  try { db.exec('ALTER TABLE charge_sessions ADD COLUMN kwh_from_grid REAL'); }           catch (_) {}
  try { db.exec('ALTER TABLE charge_sessions ADD COLUMN cost_grid REAL'); }               catch (_) {}
  // Phase 5 - diversion logging & context awareness columns for telemetry_log
  try { db.exec('ALTER TABLE telemetry_log ADD COLUMN trip_within_18hrs INTEGER DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE telemetry_log ADD COLUMN diversion_reason TEXT'); }              catch (_) {}
  // ─────────────────────────────────────────────────────────────────────────

  // Seed default settings
  const defaults = {
    country: 'AU',
    grid_retailer_domain: '', // e.g. "agl.com.au" - drives the dashboard's Grid node icon; blank shows a generic icon
    min_charge_amps: '5',
    max_charge_amps: '32',
    hold_minutes: '3',
    smoothing_window: '3',
    polling_interval_seconds: '15',
    charger_voltage: '240',
    electricity_rate_aud: '0.30',
    electricity_rate_mode: 'flat',
    export_rate_mode: 'flat',
    auto_backup_enabled: 'true',
    setup_complete: 'false',
    controller_paused: 'false',
    gateway_ip: '',
    tesla_vin: '',
    tesla_state_source: 'telemetry', // 'telemetry' (Fleet Telemetry + cloud) or 'ble' (local BLE proxy, cloud-free)
    tesla_display_name: '',
    tesla_client_id: '',
    tesla_client_secret: '',
    tesla_redirect_uri: '',
      // Which Tesla Fleet API region this account belongs to: 'na', 'eu' or 'cn'.
      // 'na' covers North America AND Asia-Pacific (Australia, NZ, Japan, etc).
      // Defaults to 'na' so existing installs keep the endpoint they were built
      // against; only Europe/Middle East/Africa and China need to change it.
      tesla_region: 'na',
    enphase_serial: '',
    enphase_email: '',
    schedule_enabled: 'false',
    schedule_windows: '[]',
    tou_enabled: 'false',
    tou_windows: '[]',
    charging_control_enabled: 'true',
    myenergi_serial:       '',
    myenergi_api_key:      '',
    myenergi_poll_seconds: '30',
    // Which Mitsubishi cloud platform the air-con integration talks to. Two
    // genuinely separate services; see src/services/ac.js. Defaults to melcloud
    // to match the pre-MelView behaviour for existing installs.
    ac_brand:                   'melcloud',
    melcloud_configured:        '0',
    melcloud_email:             '',
    ical_configured:            '0',
    ical_username:              '',
    ical_calendars:             '',
    teslamate_database_url:     '',
    gemini_api_key:             '',
    cf_worker_url:              '',
    cf_worker_secret:           '',
    bill_email_local:           'bills',
    gemini_model:               'gemini-2.5-flash',
    solcast_api_key:            '',
    solcast_resource_id:        '',
    solcast_configured:         '0',
    feed_in_tariff_aud:         '0.05',
    supply_charge_daily_aud:    '0.95',
    solar_install_cost_aud:     '',
    ntfy_base_url:              'http://localhost:8080',
    ntfy_topic:                 'wattsnatch',
    notifications_enabled:      'true',
    tesla_battery_kwh:          '82',
    soc_floor_pct:              '20',
    ai_insight_text:            '',
    ai_insight_generated_at:    '',
    grid_intensity_provider:    'aemo',
    grid_intensity_region:      '',
    watttime_username:          '',
    watttime_password:          '',
    electricitymaps_api_key:    '',
    ercot_pricing_enabled:      'false',
    ercot_api_username:         '',
    ercot_api_password:         '',
    ercot_settlement_point:     '',
    span_host:                  '',
    span_access_token:          '',
    span_solar_circuit_id:      '',
    auto_trip_charging_enabled: 'true',
    battery_brand:               'none',
    battery_priority:            'battery_first',
    sigenergy_host:              '',
    sigenergy_port:              '502',
    sigenergy_unit_id:           '1',
    sungrow_host:                '',
    sungrow_port:                '502',
    sungrow_unit_id:             '1',
    sungrow_max_charge_power_w:  '',
    sungrow_max_discharge_power_w: '',
    powerwall_host:              '',
    powerwall_email:             '',
    powerwall_password:          '',
    retailer_network_distributor: 'Energex',
    // When we last ATTEMPTED a live-rates refresh, successful or not. Gating
    // the daily refresh on this rather than on the last success stops an
    // unservable distributor retrying on every controller tick.
    retailer_live_rates_attempted_at: '0',
    retailer_live_rates_json:       '',
    retailer_live_rates_fetched_at: '0',
    retailer_live_rates_distributor: '',
  };

  const insertDefault = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)
  `);
  const now = Date.now();
  for (const [key, value] of Object.entries(defaults)) {
    insertDefault.run(key, value, now);
  }

  // Seed electricity_rates from setting if table is empty
  const rateCount = db.prepare('SELECT COUNT(*) as n FROM electricity_rates').get().n;
  if (rateCount === 0) {
    const currentRate = parseFloat(db.prepare('SELECT value FROM settings WHERE key = ?').get('electricity_rate_aud')?.value || '0.30');
    db.prepare('INSERT INTO electricity_rates (rate_aud, effective_from, created_at) VALUES (?, ?, ?)')
      .run(currentRate, 0, now);
  }

  // Seed tariff_history from settings if table is empty
  const tariffCount = db.prepare('SELECT COUNT(*) as n FROM tariff_history').get().n;
  if (tariffCount === 0) {
    const feedIn = parseFloat(db.prepare('SELECT value FROM settings WHERE key = ?').get('feed_in_tariff_aud')?.value || '0.05');
    const supply = parseFloat(db.prepare('SELECT value FROM settings WHERE key = ?').get('supply_charge_daily_aud')?.value || '0.95');
    db.prepare('INSERT INTO tariff_history (type, rate_aud, effective_from, created_at) VALUES (?, ?, ?, ?)').run('feed_in', feedIn, 0, now);
    db.prepare('INSERT INTO tariff_history (type, rate_aud, effective_from, created_at) VALUES (?, ?, ?, ?)').run('supply_charge', supply, 0, now);
  }

  return db;
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), Date.now());
}

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const result = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

function getToken(provider) {
  return db.prepare('SELECT * FROM auth_tokens WHERE provider = ?').get(provider);
}

function setToken(provider, tokenData, expiresAt, accountInfo) {
  db.prepare(`
    INSERT INTO auth_tokens (provider, token_data, expires_at, account_info, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      token_data = excluded.token_data,
      expires_at = excluded.expires_at,
      account_info = excluded.account_info,
      created_at = excluded.created_at
  `).run(provider, tokenData, expiresAt, accountInfo, Date.now());
}

function deleteToken(provider) {
  db.prepare('DELETE FROM auth_tokens WHERE provider = ?').run(provider);
}

function logEvent(type, oldState, newState, details) {
  db.prepare(`
    INSERT INTO events_log (occurred_at, event_type, old_state, new_state, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(Date.now(), type, oldState || null, newState || null, details || null);
}

function logTelemetry(data) {
  const stmt = db.prepare(`
    INSERT INTO telemetry_log
      (recorded_at, solar_w, consumption_w, grid_w, solar_excess_w, ev_w, eddi_w, charge_amps, battery_pct, controller_state, session_id, trip_within_18hrs, diversion_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    data.recorded_at || Date.now(),
    data.solar_w || 0,
    data.consumption_w || 0,
    data.grid_w || 0,
    data.solar_excess_w || 0,
    data.ev_w || 0,
    data.eddi_w || 0,
    data.charge_amps || 0,
    data.battery_pct != null ? data.battery_pct : null,
    data.controller_state || 'IDLE',
    data.session_id || null,
    data.trip_within_18hrs ? 1 : 0,
    data.diversion_reason || null
  );
}

function startSession(batteryStart) {
  const info = db.prepare(`
    INSERT INTO charge_sessions (started_at, battery_start) VALUES (?, ?)
  `).run(Date.now(), batteryStart);
  return info.lastInsertRowid;
}

function endSession(id, data) {
  db.prepare(`
    UPDATE charge_sessions SET
      ended_at = ?,
      duration_secs = ?,
      kwh_solar = ?,
      kwh_from_grid = ?,
      battery_end = ?,
      peak_amps = ?,
      avg_amps = ?,
      est_savings_aud = ?,
      end_reason = ?
    WHERE id = ?
  `).run(
    data.ended_at || Date.now(),
    data.duration_secs || 0,
    data.kwh_solar || 0,
    data.kwh_from_grid || 0,
    data.battery_end || 0,
    data.peak_amps || 0,
    data.avg_amps || 0,
    data.est_savings_aud || 0,
    data.end_reason || 'unknown',
    id
  );
}

/**
 * Calculate solar vs grid energy attribution for a session from its telemetry rows.
 * solar_to_ev = max(0, solar_excess_w + ev_w)  - solar that actually went to the car
 * grid_to_ev  = ev_w - solar_to_ev
 * Uses actual timestamps for accurate integration.
 */
function calcSessionEnergyFromTelemetry(sessionId) {
  const rows = db.prepare(`
    SELECT recorded_at, solar_excess_w, ev_w, charge_amps, battery_pct
    FROM telemetry_log WHERE session_id = ? ORDER BY recorded_at ASC
  `).all(sessionId);

  if (rows.length === 0) return null;

  // Per-row rate resolution: a single charge session can span a TOU
  // boundary (e.g. start in shoulder, finish in peak), so solar/grid $
  // attribution is costed per-interval rather than at one flat rate.
  const resolveRate = createRateResolver();

  let kwhSolar = 0, kwhGrid = 0, estSavings = 0, gridCost = 0;
  let totalAmps = 0, peakAmps = 0, chargingCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.ev_w || row.ev_w <= 0) continue;
    // Use gap to next row (or a default of 5s for the last row)
    const nextTs = i + 1 < rows.length ? rows[i + 1].recorded_at : row.recorded_at + 5000;
    const intervalHrs = (nextTs - row.recorded_at) / 3_600_000;
    const solarToEv = Math.max(0, (row.solar_excess_w || 0) + row.ev_w);
    const gridToEv  = row.ev_w - solarToEv;
    const solarKwhRow = (solarToEv * intervalHrs) / 1000;
    const gridKwhRow  = (gridToEv  * intervalHrs) / 1000;
    const rate = resolveRate(row.recorded_at);
    kwhSolar   += solarKwhRow;
    kwhGrid    += gridKwhRow;
    estSavings += solarKwhRow * rate;
    gridCost   += gridKwhRow  * rate;
    totalAmps += row.charge_amps || 0;
    if ((row.charge_amps || 0) > peakAmps) peakAmps = row.charge_amps;
    chargingCount++;
  }

  const avgAmps   = chargingCount > 0 ? totalAmps / chargingCount : 0;
  const battEnd   = rows[rows.length - 1].battery_pct || 0;
  const endedAt   = rows[rows.length - 1].recorded_at;
  const durationSecs = Math.round((endedAt - rows[0].recorded_at) / 1000);

  return { kwhSolar, kwhGrid, avgAmps, peakAmps, battEnd, endedAt, durationSecs, estSavings, gridCost };
}

/**
 * Close any sessions that have no ended_at (orphaned by a server restart).
 * Stats are reconstructed from the telemetry_log entries for each session.
 */
function closeOrphanedSessions() {
  const orphans = db.prepare(
    'SELECT id, started_at FROM charge_sessions WHERE ended_at IS NULL'
  ).all();

  for (const s of orphans) {
    const energy = calcSessionEnergyFromTelemetry(s.id);

    if (!energy) {
      // No telemetry at all - delete the session rather than leave a ghost row
      db.prepare('DELETE FROM charge_sessions WHERE id = ?').run(s.id);
      continue;
    }

    db.prepare(`
      UPDATE charge_sessions SET
        ended_at = ?, duration_secs = ?, kwh_solar = ?, kwh_from_grid = ?, battery_end = ?,
        peak_amps = ?, avg_amps = ?, est_savings_aud = ?, end_reason = ?
      WHERE id = ?
    `).run(energy.endedAt, energy.durationSecs, energy.kwhSolar, energy.kwhGrid,
           energy.battEnd, energy.peakAmps, energy.avgAmps, energy.estSavings, 'server_restart', s.id);
  }

  if (orphans.length > 0) {
    console.log(`[db] Closed ${orphans.length} orphaned session(s) on startup`);
  }
}

function getSessions(page = 1, limit = 20) {
  const offset = (page - 1) * limit;
  const rows = db.prepare(`
    SELECT * FROM charge_sessions ORDER BY started_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
  const total = db.prepare('SELECT COUNT(*) as count FROM charge_sessions').get().count;
  return { sessions: rows, total, page, limit };
}

function getSession(id) {
  const session = db.prepare('SELECT * FROM charge_sessions WHERE id = ?').get(id);
  if (!session) return null;
  const telemetry = db.prepare(`
    SELECT recorded_at, charge_amps, solar_w, battery_pct
    FROM telemetry_log WHERE session_id = ? ORDER BY recorded_at ASC
  `).all(id);
  return { ...session, telemetry };
}

function getTodayStats() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const ts = startOfDay.getTime();

  const sessions = db.prepare(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(duration_secs), 0) as total_secs,
      COALESCE(SUM(kwh_solar), 0) as total_kwh,
      COALESCE(SUM(est_savings_aud), 0) as total_savings
    FROM charge_sessions WHERE started_at >= ? AND ended_at IS NOT NULL
  `).get(ts);

  // Per-row elapsed-time weighting (mirrors getHousePeriodStats/the nightly
  // ledger) rather than assuming every row spans exactly
  // polling_interval_seconds. Real telemetry rows don't land on a fixed
  // cadence (Tesla commands are throttled to every other tick, plus normal
  // jitter) - multiplying by a fixed interval was undercounting grid
  // import/export by roughly 2x on a real install where rows were landing
  // ~11.5s apart against a configured 5s interval.
  const rows = db.prepare(`
    SELECT
      solar_w, grid_w,
      MIN(
        COALESCE(LEAD(recorded_at) OVER (ORDER BY recorded_at) - recorded_at, 5000),
        120000
      ) / 3600000.0 AS interval_h
    FROM telemetry_log WHERE recorded_at >= ?
  `).all(ts);

  let solarKwh = 0, gridExportKwh = 0, gridImportKwh = 0, solarSum = 0, peakSolar = 0;
  for (const r of rows) {
    solarSum += r.solar_w;
    if (r.solar_w > peakSolar) peakSolar = r.solar_w;
    solarKwh += (r.solar_w || 0) * r.interval_h / 1000.0;
    if (r.grid_w < -50) gridExportKwh += Math.abs(r.grid_w) * r.interval_h / 1000.0;
    if (r.grid_w >  50) gridImportKwh += r.grid_w          * r.interval_h / 1000.0;
  }

  const solar = {
    avg_solar:        rows.length > 0 ? solarSum / rows.length : 0,
    peak_solar:       peakSolar,
    solar_kwh:        solarKwh,
    grid_export_kwh:  gridExportKwh,
    grid_import_kwh:  gridImportKwh,
  };

  return { sessions, solar };
}

function getEvents(page = 1, limit = 50, type = 'all') {
  const offset = (page - 1) * limit;
  let query = 'SELECT * FROM events_log';
  let countQuery = 'SELECT COUNT(*) as count FROM events_log';
  const params = [];

  if (type && type !== 'all') {
    query += ' WHERE event_type = ?';
    countQuery += ' WHERE event_type = ?';
    params.push(type);
  }

  query += ' ORDER BY occurred_at DESC LIMIT ? OFFSET ?';
  const rows = db.prepare(query).all(...params, limit, offset);
  const total = db.prepare(countQuery).get(...params).count;
  return { events: rows, total, page, limit };
}

function getLastTelemetry() {
  return db.prepare('SELECT * FROM telemetry_log ORDER BY recorded_at DESC LIMIT 1').get();
}

function getMonthlyStats(year, month) {
  // Start/end of month in ms
  const start = new Date(year, month - 1, 1).getTime();
  const end   = new Date(year, month, 1).getTime();

  // Per-day EV solar/grid split from telemetry_log, elapsed-time-weighted
  // (see getPeriodStats for why interval_h is computed before the ev_w > 0
  // filter, not after: a row right before a charging gap must not absorb
  // that gap's duration).
  // For each interval: solar_for_ev = min(ev_w, solar_w - (consumption_w - ev_w))
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT
        CAST((recorded_at - ?) / 86400000 AS INTEGER) AS day_idx,
        ev_w, solar_w, consumption_w,
        MIN(
          COALESCE(LEAD(recorded_at) OVER (ORDER BY recorded_at) - recorded_at, 5000),
          120000
        ) / 3600000.0 AS interval_h
      FROM telemetry_log
      WHERE recorded_at >= ? AND recorded_at < ?
    ) WHERE ev_w > 0
  `).all(start, start, end);

  const dayMap = {};

  for (const r of rows) {
    const d = r.day_idx + 1; // 1-based day of month
    if (!dayMap[d]) dayMap[d] = { day: d, solar_kwh: 0, grid_kwh: 0 };
    const houseOnly = Math.max(0, r.consumption_w - r.ev_w);
    const evSolarW  = Math.max(0, Math.min(r.ev_w, r.solar_w - houseOnly));
    const evGridW   = Math.max(0, r.ev_w - evSolarW);
    dayMap[d].solar_kwh += (evSolarW * r.interval_h) / 1000;
    dayMap[d].grid_kwh  += (evGridW  * r.interval_h) / 1000;
  }

  const days = Array.from({ length: new Date(year, month, 0).getDate() }, (_, i) => {
    const d = i + 1;
    return dayMap[d] || { day: d, solar_kwh: 0, grid_kwh: 0 };
  });

  const totalSolar = days.reduce((s, d) => s + d.solar_kwh, 0);
  const totalGrid  = days.reduce((s, d) => s + d.grid_kwh,  0);
  const total      = totalSolar + totalGrid;

  return {
    days,
    totals: {
      total_kwh:         Math.round(total  * 10) / 10,
      solar_kwh:         Math.round(totalSolar * 10) / 10,
      grid_kwh:          Math.round(totalGrid  * 10) / 10,
      self_powered_pct:  total > 0 ? Math.round((totalSolar / total) * 100) : 0,
    },
  };
}

// Short-TTL memoization for the two period-stat aggregations below. The Data
// page's three endpoints (/api/stats/periods, /api/stats/house/periods,
// /api/stats/master/periods) each independently recompute the same ~9
// boundaries' (today/week/month/quarter/year + last_*) worth of car and
// house numbers - master/periods redoes exactly what the other two just
// did. Since better-sqlite3 is synchronous, these "parallel" requests
// actually queue up and run one after another on Node's single thread, so
// that redundant work adds up in real wall-clock time even though each
// query itself is now fast. A few seconds of staleness on a period-stat
// number is unobservable to a human clicking between tabs, so a short TTL
// cache shared across all three endpoints removes the duplication without
// touching any of the underlying math.
const _periodStatsCache = new Map();
const PERIOD_STATS_CACHE_TTL_MS = 5000;

function _memoizeShortTtl(fn, name) {
  return (startTs, endTs) => {
    const key = `${name}:${startTs}:${endTs}`;
    const now = Date.now();
    const hit = _periodStatsCache.get(key);
    if (hit && (now - hit.at) < PERIOD_STATS_CACHE_TTL_MS) return hit.value;

    const value = fn(startTs, endTs);
    _periodStatsCache.set(key, { value, at: now });

    // Bound memory on long-running processes without needing a timer -
    // sweep stale entries only when the cache has grown large enough to
    // matter (the working set here is normally under a dozen distinct keys).
    if (_periodStatsCache.size > 50) {
      for (const [k, v] of _periodStatsCache) {
        if ((now - v.at) >= PERIOD_STATS_CACHE_TTL_MS) _periodStatsCache.delete(k);
      }
    }

    return value;
  };
}

// Per-row rate resolution (not a single rate for the whole period) is what
// makes this correct under TOU billing, where the rate can change multiple
// times within a single day - not just on electricity_rates change dates.
// The whole aggregation (including that per-row rate lookup, via
// buildRateCaseSql()) runs as one SQL query rather than pulling every
// matched telemetry row into a JS loop - for a full year of ~15s-interval
// telemetry that's the difference between summing ~2M rows in JS and
// summing them inside SQLite. Verified to agree with the original row-by-row
// JS implementation across several real periods (including one spanning a
// TOU config's effective_from transition) before switching over.
//
// interval_h must be computed against the NEXT TELEMETRY ROW overall, not
// the next row that happens to have ev_w > 0 - otherwise a row right
// before a charging gap would absorb the entire gap's duration. So the
// LEAD() window runs over every row in range first (inner query), and
// only the ev_w > 0 filter is applied after, mirroring getHousePeriodStats's
// approach for the same reason.
function _getPeriodStatsUncached(startTs, endTs) {
  if (!endTs) endTs = Date.now();
  const { sql: rateSql, params: rateParams } = buildRateCaseSql();

  const row = db.prepare(`
    WITH base AS (
      SELECT recorded_at, solar_w, consumption_w, ev_w,
        MIN(
          COALESCE(LEAD(recorded_at) OVER (ORDER BY recorded_at) - recorded_at, 5000),
          120000
        ) / 3600000.0 AS interval_h
      FROM telemetry_log
      WHERE recorded_at >= ? AND recorded_at < ?
    ),
    filtered AS (
      SELECT *,
        MAX(0.0, consumption_w - ev_w) AS house_only,
        (${rateSql}) AS rate
      FROM base
      WHERE ev_w > 0
    ),
    calced AS (
      SELECT *,
        MAX(0.0, MIN(ev_w, solar_w - house_only)) AS ev_solar_w
      FROM filtered
    )
    SELECT
      COALESCE(SUM(ev_solar_w * interval_h / 1000.0), 0) AS solar_kwh,
      COALESCE(SUM(MAX(0.0, ev_w - ev_solar_w) * interval_h / 1000.0), 0) AS grid_kwh,
      COALESCE(SUM(ev_solar_w * interval_h / 1000.0 * rate), 0) AS savings,
      COALESCE(SUM(MAX(0.0, ev_w - ev_solar_w) * interval_h / 1000.0 * rate), 0) AS grid_cost
    FROM calced
  `).get(startTs, endTs, ...rateParams);

  const solarKwh = row.solar_kwh || 0;
  const gridKwh  = row.grid_kwh  || 0;
  const totalKwh = solarKwh + gridKwh;
  const selfPct  = totalKwh > 0 ? Math.round((solarKwh / totalKwh) * 100) : 0;

  return {
    solar_kwh:       Math.round(solarKwh          * 100) / 100,
    grid_kwh:        Math.round(gridKwh           * 100) / 100,
    total_kwh:       Math.round(totalKwh          * 100) / 100,
    self_pct:        selfPct,
    est_savings_aud: Math.round((row.savings   || 0) * 100) / 100,
    grid_cost_aud:   Math.round((row.grid_cost || 0) * 100) / 100,
  };
}

const getPeriodStats = _memoizeShortTtl(_getPeriodStatsUncached, 'ev');

function getRates() {
  return db.prepare('SELECT * FROM electricity_rates ORDER BY effective_from DESC').all();
}

function addRate(rateAud, effectiveFromTs) {
  const info = db.prepare(
    'INSERT INTO electricity_rates (rate_aud, effective_from, created_at) VALUES (?, ?, ?)'
  ).run(rateAud, effectiveFromTs, Date.now());

  // Keep the setting in sync with the most recent rate
  const latest = db.prepare('SELECT rate_aud FROM electricity_rates ORDER BY effective_from DESC LIMIT 1').get();
  if (latest) setSetting('electricity_rate_aud', String(latest.rate_aud));

  return info.lastInsertRowid;
}

function deleteRate(id) {
  const count = db.prepare('SELECT COUNT(*) as n FROM electricity_rates').get().n;
  if (count <= 1) throw new Error('Cannot delete the only rate entry');
  db.prepare('DELETE FROM electricity_rates WHERE id = ?').run(id);

  // Keep the setting in sync
  const latest = db.prepare('SELECT rate_aud FROM electricity_rates ORDER BY effective_from DESC LIMIT 1').get();
  if (latest) setSetting('electricity_rate_aud', String(latest.rate_aud));
}

// ── TOU rate configs ──────────────────────────────────────────────────────────
// A "config" is one versioned time-of-use rate card (a set of named windows +
// a default/off-peak rate), the same way electricity_rates versions a single
// flat number. Adding a new config with a later effective_from supersedes the
// previous one going forward without touching how past periods are costed.

function getTouConfigs() {
  const configs = db.prepare('SELECT * FROM tou_rate_configs ORDER BY effective_from DESC').all();
  const windowStmt = db.prepare('SELECT * FROM tou_rate_windows WHERE config_id = ? ORDER BY id ASC');
  return configs.map((c) => ({
    ...c,
    windows: windowStmt.all(c.id).map((w) => ({ ...w, days: JSON.parse(w.days) })),
  }));
}

// Returns the active config (with windows) as of tsMs, or null if TOU has
// never been configured / no config's effective_from has arrived yet.
function getTouConfigAtDate(tsMs) {
  const config = db.prepare(
    'SELECT * FROM tou_rate_configs WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1'
  ).get(tsMs);
  if (!config) return null;
  const windows = db.prepare('SELECT * FROM tou_rate_windows WHERE config_id = ? ORDER BY id ASC').all(config.id);
  return { ...config, windows: windows.map((w) => ({ ...w, days: JSON.parse(w.days) })) };
}

function addTouConfig({ default_rate_aud, effective_from, windows }) {
  const insertConfig = db.prepare(
    'INSERT INTO tou_rate_configs (default_rate_aud, effective_from, created_at) VALUES (?, ?, ?)'
  );
  const insertWindow = db.prepare(
    'INSERT INTO tou_rate_windows (config_id, label, rate_aud, days, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const tx = db.transaction((cfg, wins) => {
    const info = insertConfig.run(cfg.default_rate_aud, cfg.effective_from, Date.now());
    const configId = info.lastInsertRowid;
    for (const w of wins) {
      insertWindow.run(configId, w.label, w.rate_aud, JSON.stringify(w.days), w.start_time, w.end_time);
    }
    return configId;
  });
  return tx(
    { default_rate_aud: parseFloat(default_rate_aud), effective_from: parseInt(effective_from, 10) },
    windows || []
  );
}

function deleteTouConfig(id) {
  db.prepare('DELETE FROM tou_rate_configs WHERE id = ?').run(id);
}

// ── Canonical electricity import-rate resolver ────────────────────────────────
// This is THE function for "what was the grid import rate at timestamp X" -
// every cost calculation in the app should go through this (or
// createRateResolver() below for loops) rather than reading
// electricity_rate_aud directly, so flat vs TOU mode and rate-history dates
// are always respected consistently everywhere.

function _matchTouWindow(config, tsMs) {
  const d = new Date(tsMs);
  const day = d.getDay();
  const minutes = d.getHours() * 60 + d.getMinutes();
  for (const w of config.windows) {
    if (!w.days.includes(day)) continue;
    const [sh, sm] = w.start_time.split(':').map(Number);
    const [eh, em] = w.end_time.split(':').map(Number);
    const s = sh * 60 + sm;
    const e = eh * 60 + em;
    const inWindow = s > e ? (minutes >= s || minutes < e) : (minutes >= s && minutes < e);
    if (inWindow) return w.rate_aud;
  }
  return config.default_rate_aud;
}

function getFlatRateAtDate(tsMs) {
  const row = db.prepare(
    'SELECT rate_aud FROM electricity_rates WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1'
  ).get(tsMs);
  return row ? row.rate_aud : 0.30;
}

// Single-shot lookup - fine for one-off calls (e.g. costing a single session
// close). For aggregating many timestamps (telemetry rows across a period),
// use createRateResolver() instead so the config/history isn't re-queried
// from the DB on every call.
function getRateAtTimestamp(tsMs) {
  return createRateResolver()(tsMs);
}

// Returns a fast function(tsMs) => rateAud, with the rate/TOU history loaded
// into memory once up front - use this in loops instead of getRateAtTimestamp.
// ── SQL-side rate resolution ──────────────────────────────────────────────
// Mirrors createRateResolver()/_matchTouWindow() exactly, but as a SQL CASE
// expression instead of a per-timestamp JS closure, so period-stat
// aggregation (getPeriodStats, getHousePeriodStats) can sum hundreds of
// thousands of telemetry rows inside SQLite instead of pulling every row
// into JS to call a resolver function on it. Any change to the JS resolver's
// logic must be mirrored here - see the verification approach in the git
// history for this change for how the two were checked against each other.
//
// Returns { sql, params }: `sql` is a SQL expression referencing a bare
// `recorded_at` column (the caller's query must project that column into
// scope), and `params` are the positional `?` bindings the expression needs,
// in the exact order they appear in `sql`.

function _touWindowCaseSql(config) {
  const dow = "CAST(strftime('%w', datetime(recorded_at/1000,'unixepoch','localtime')) AS INTEGER)";
  const mod = "(CAST(strftime('%H', datetime(recorded_at/1000,'unixepoch','localtime')) AS INTEGER) * 60 + " +
              "CAST(strftime('%M', datetime(recorded_at/1000,'unixepoch','localtime')) AS INTEGER))";
  const params = [];
  let sql = 'CASE';
  for (const w of config.windows) {
    const [sh, sm] = w.start_time.split(':').map(Number);
    const [eh, em] = w.end_time.split(':').map(Number);
    const s = sh * 60 + sm;
    const e = eh * 60 + em;
    const dayPlaceholders = w.days.map(() => '?').join(',');
    let cond = `${dow} IN (${dayPlaceholders})`;
    params.push(...w.days);
    if (s > e) {
      // Overnight-spanning window (e.g. 22:00-06:00) - matches _matchTouWindow's
      // `minutes >= s || minutes < e` wraparound logic exactly.
      cond += ` AND (${mod} >= ? OR ${mod} < ?)`;
    } else {
      cond += ` AND (${mod} >= ? AND ${mod} < ?)`;
    }
    params.push(s, e);
    sql += ` WHEN ${cond} THEN ?`;
    params.push(w.rate_aud);
  }
  sql += ' ELSE ? END';
  params.push(config.default_rate_aud);
  return { sql, params };
}

function _flatRateCaseSql() {
  const rows = db.prepare(
    'SELECT rate_aud, effective_from FROM electricity_rates ORDER BY effective_from DESC'
  ).all();
  const params = [];
  let sql = 'CASE';
  for (const r of rows) {
    sql += ' WHEN recorded_at >= ? THEN ?';
    params.push(r.effective_from, r.rate_aud);
  }
  sql += ' ELSE ? END';
  params.push(0.30); // matches createRateResolver()'s ultimate fallback when no row matches at all
  return { sql, params };
}

function buildRateCaseSql() {
  if (getSetting('electricity_rate_mode') === 'tou') {
    const configs = getTouConfigs(); // ORDER BY effective_from DESC
    if (configs.length > 0) {
      const params = [];
      let sql = 'CASE';
      for (const config of configs) {
        const windowCase = _touWindowCaseSql(config);
        sql += ` WHEN recorded_at >= ? THEN (${windowCase.sql})`;
        params.push(config.effective_from, ...windowCase.params);
      }
      // A recorded_at before every TOU config's effective_from falls back to the
      // flat rate table, exactly as createRateResolver() does via getFlatRateAtDate().
      const flat = _flatRateCaseSql();
      sql += ` ELSE (${flat.sql}) END`;
      params.push(...flat.params);
      return { sql, params };
    }
    // TOU mode is on but nothing's been configured yet - fall through to flat.
  }
  return _flatRateCaseSql();
}

function createRateResolver() {
  if (getSetting('electricity_rate_mode') === 'tou') {
    const configs = getTouConfigs(); // ORDER BY effective_from DESC
    if (configs.length > 0) {
      return (tsMs) => {
        const config = configs.find((c) => c.effective_from <= tsMs);
        return config ? _matchTouWindow(config, tsMs) : getFlatRateAtDate(tsMs);
      };
    }
    // TOU mode is on but nothing's been configured yet - fall through to flat.
  }
  const flatRows = db.prepare(
    'SELECT rate_aud, effective_from FROM electricity_rates ORDER BY effective_from DESC'
  ).all();
  return (tsMs) => {
    const row = flatRows.find((r) => r.effective_from <= tsMs);
    return row ? row.rate_aud : 0.30;
  };
}

// ── Export (feed-in) rate configs ─────────────────────────────────────────────
// Mirrors the TOU import-rate config functions above exactly (same shape,
// same versioning-by-effective_from model) - only the table names differ.
// Kept as a parallel set of functions rather than parametrizing the existing
// ones, since import and export rates are conceptually independent (a user
// can be on flat import + TOU export, or vice versa).

function getExportConfigs() {
  const configs = db.prepare('SELECT * FROM export_rate_configs ORDER BY effective_from DESC').all();
  const windowStmt = db.prepare('SELECT * FROM export_rate_windows WHERE config_id = ? ORDER BY id ASC');
  return configs.map((c) => ({
    ...c,
    windows: windowStmt.all(c.id).map((w) => ({ ...w, days: JSON.parse(w.days) })),
  }));
}

function addExportConfig({ default_rate_aud, effective_from, windows }) {
  const insertConfig = db.prepare(
    'INSERT INTO export_rate_configs (default_rate_aud, effective_from, created_at) VALUES (?, ?, ?)'
  );
  const insertWindow = db.prepare(
    'INSERT INTO export_rate_windows (config_id, label, rate_aud, days, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const tx = db.transaction((cfg, wins) => {
    const info = insertConfig.run(cfg.default_rate_aud, cfg.effective_from, Date.now());
    const configId = info.lastInsertRowid;
    for (const w of wins) {
      insertWindow.run(configId, w.label, w.rate_aud, JSON.stringify(w.days), w.start_time, w.end_time);
    }
    return configId;
  });
  return tx(
    { default_rate_aud: parseFloat(default_rate_aud), effective_from: parseInt(effective_from, 10) },
    windows || []
  );
}

function deleteExportConfig(id) {
  db.prepare('DELETE FROM export_rate_configs WHERE id = ?').run(id);
}

// Single-shot lookup, mirroring getRateAtTimestamp(). Prefer
// createExportRateResolver() in loops.
function getExportRateAtTimestamp(tsMs) {
  return createExportRateResolver()(tsMs);
}

// Returns a fast function(tsMs) => rateAud for the EXPORT/feed-in side.
// Backward-compat: when export_rate_mode is 'flat' (the default) or no
// export config has ever been added, this falls through to the flat feed-in
// tariff history - same values getTariffAtDate('feed_in', tsMs) resolves,
// but preloaded once instead of a DB query per call, since this resolver
// runs per-telemetry-row inside the nightly ledger loop (mirroring how
// createRateResolver() preloads the flat import history for the same reason).
function createExportRateResolver() {
  const feedInRows = db.prepare(
    "SELECT rate_aud, effective_from FROM tariff_history WHERE type = 'feed_in' ORDER BY effective_from DESC"
  ).all();
  const flatFeedIn = (tsMs) => {
    const row = feedInRows.find((r) => r.effective_from <= tsMs);
    return row ? row.rate_aud : 0.05; // matches getTariffAtDate's feed_in default
  };

  if (getSetting('export_rate_mode') === 'tou') {
    const configs = getExportConfigs(); // ORDER BY effective_from DESC
    if (configs.length > 0) {
      return (tsMs) => {
        const config = configs.find((c) => c.effective_from <= tsMs);
        return config ? _matchTouWindow(config, tsMs) : flatFeedIn(tsMs);
      };
    }
    // export TOU mode is on but nothing's been configured yet - fall through to flat.
  }
  return flatFeedIn;
}

// ── Tariff history ────────────────────────────────────────────────────────────

function getTariffs() {
  return db.prepare('SELECT * FROM tariff_history ORDER BY type ASC, effective_from DESC').all();
}

function getTariffAtDate(type, tsMs) {
  const row = db.prepare(
    'SELECT rate_aud FROM tariff_history WHERE type = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1'
  ).get(type, tsMs);
  const defaults = { feed_in: 0.05, supply_charge: 0.95 };
  return row ? row.rate_aud : defaults[type] ?? 0;
}

/**
 * Whole-property grid import/export for an arbitrary date range, read straight
 * from telemetry_log with the same elapsed-time weighting as getTodayStats()/
 * getMonthlyStats() - deliberately NOT sourced from financial_ledger, which is
 * a once-a-day incremental table that can have permanent gaps (e.g. it simply
 * never ran on some past date) even when the raw telemetry for that date is
 * intact. Used by the bills accuracy comparison so a billing period's figures
 * can't read artificially low just because the ledger has a hole in it.
 */
function getGridSummaryForPeriod(startMs, endMs) {
  const resolveRate       = createRateResolver();
  const resolveExportRate = createExportRateResolver();

  const rows = db.prepare(`
    SELECT recorded_at, grid_w,
      MIN(
        COALESCE(LEAD(recorded_at) OVER (ORDER BY recorded_at) - recorded_at, 5000),
        120000
      ) / 3600000.0 AS interval_h
    FROM telemetry_log WHERE recorded_at >= ? AND recorded_at < ?
  `).all(startMs, endMs);

  let kwhImported = 0, kwhExported = 0, importCost = 0, exportCredit = 0;
  const daysSeen = new Set();
  for (const r of rows) {
    // UTC day bucket, matching the UTC-ms window this function is called
    // with - a local-time date string here would occasionally attribute
    // rows near midnight to a different day than the ms boundary implies.
    daysSeen.add(Math.floor(r.recorded_at / 86400000));
    const kwh = (r.grid_w || 0) * r.interval_h / 1000.0;
    if (r.grid_w > 50) {
      kwhImported += kwh;
      importCost  += kwh * resolveRate(r.recorded_at);
    } else if (r.grid_w < -50) {
      kwhExported  += -kwh;
      exportCredit += -kwh * resolveExportRate(r.recorded_at);
    }
  }

  return {
    days_recorded:  daysSeen.size,
    kwh_imported:   Math.round(kwhImported  * 100) / 100,
    kwh_exported:   Math.round(kwhExported  * 100) / 100,
    import_cost:    Math.round(importCost   * 100) / 100,
    export_credit:  Math.round(exportCredit * 100) / 100,
  };
}

// Total supply charge for a period, honouring tariff_history so a period that
// spans a rate change (e.g. "Last Month" viewed after a July 1 price rise) is
// priced day-by-day at the rate actually in effect - not days × today's rate.
function getSupplyChargeForPeriod(startMs, endMs) {
  if (!(endMs > startMs)) return 0;
  let total = 0;
  const day = new Date(startMs);
  day.setHours(0, 0, 0, 0);
  for (let ts = day.getTime(); ts < endMs; ) {
    total += getTariffAtDate('supply_charge', ts);
    const next = new Date(ts);
    next.setDate(next.getDate() + 1);
    ts = next.getTime();
  }
  return total;
}

function addTariff(type, rateAud, effectiveFromTs) {
  if (!['feed_in', 'supply_charge'].includes(type)) throw new Error('Invalid tariff type');
  const info = db.prepare(
    'INSERT INTO tariff_history (type, rate_aud, effective_from, created_at) VALUES (?, ?, ?, ?)'
  ).run(type, rateAud, effectiveFromTs, Date.now());

  const latest = db.prepare('SELECT rate_aud FROM tariff_history WHERE type = ? ORDER BY effective_from DESC LIMIT 1').get(type);
  if (latest) {
    const settingKey = type === 'feed_in' ? 'feed_in_tariff_aud' : 'supply_charge_daily_aud';
    setSetting(settingKey, String(latest.rate_aud));
  }

  return info.lastInsertRowid;
}

function deleteTariff(id) {
  const row = db.prepare('SELECT type FROM tariff_history WHERE id = ?').get(id);
  if (!row) throw new Error('Tariff entry not found');
  const count = db.prepare('SELECT COUNT(*) as n FROM tariff_history WHERE type = ?').get(row.type).n;
  if (count <= 1) throw new Error('Cannot delete the only entry for this tariff type');
  db.prepare('DELETE FROM tariff_history WHERE id = ?').run(id);

  const latest = db.prepare('SELECT rate_aud FROM tariff_history WHERE type = ? ORDER BY effective_from DESC LIMIT 1').get(row.type);
  if (latest) {
    const settingKey = row.type === 'feed_in' ? 'feed_in_tariff_aud' : 'supply_charge_daily_aud';
    setSetting(settingKey, String(latest.rate_aud));
  }
}

// ── Eddi (hot water) telemetry ────────────────────────────────────────────────

function insertEddiTelemetry({ recorded_at, diverted_w, status, energy_today_kwh, boost_today_kwh, temp1, temp2 }) {
  db.prepare(`
    INSERT INTO eddi_telemetry (recorded_at, diverted_w, status, energy_today_kwh, boost_today_kwh, temp1, temp2)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    recorded_at || Date.now(),
    diverted_w  || 0,
    status      || 'Unknown',
    energy_today_kwh != null ? energy_today_kwh : 0,
    boost_today_kwh  != null ? boost_today_kwh  : 0,
    temp1 != null ? temp1 : null,
    temp2 != null ? temp2 : null,
  );
}

function insertAcTelemetry({ recorded_at, device_id, device_name, is_on, mode, set_temperature, room_temperature, daily_energy_kwh, total_energy_kwh }) {
  db.prepare(`
    INSERT INTO ac_telemetry (recorded_at, device_id, device_name, is_on, mode, set_temperature, room_temperature, daily_energy_kwh, total_energy_kwh)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    recorded_at || Date.now(),
    device_id,
    device_name || 'Unknown',
    is_on ? 1 : 0,
    mode || 'Unknown',
    set_temperature != null ? set_temperature : null,
    room_temperature != null ? room_temperature : null,
    daily_energy_kwh != null ? daily_energy_kwh : 0,
    total_energy_kwh != null ? total_energy_kwh : 0,
  );
}

function insertLoadHistory({ recorded_at, solar_w, house_w, ac_on, outside_temp_approx }) {
  db.prepare(`
    INSERT INTO load_history (recorded_at, solar_w, house_w, ac_on, outside_temp_approx)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    recorded_at || Date.now(),
    solar_w != null ? solar_w : 0,
    house_w != null ? house_w : 0,
    ac_on ? 1 : 0,
    outside_temp_approx != null ? outside_temp_approx : null,
  );
}

function getLoadHistory(startMs, endMs) {
  const rows = db.prepare(`
    SELECT recorded_at, solar_w, house_w, ac_on, outside_temp_approx FROM load_history
    WHERE recorded_at >= ? AND recorded_at <= ?
    ORDER BY recorded_at ASC
  `).all(startMs, endMs);
  return rows;
}

function getBaselineStats() {
  const fourteenDaysAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
  const rows = db.prepare(`
    SELECT AVG(house_w) as avg_house_w, ac_on FROM load_history
    WHERE recorded_at >= ?
    GROUP BY ac_on
  `).all(fourteenDaysAgo);

  const stats = {};
  for (const row of rows) {
    if (row.ac_on === 0) {
      stats.baseline_ac_off = row.avg_house_w;
    } else {
      stats.baseline_ac_on = row.avg_house_w;
    }
  }
  return stats;
}

/**
 * Returns total kWh diverted to hot water in a time window, estimated savings.
 * Uses MAX(energy_today_kwh) per calendar day to handle the midnight counter reset.
 */
function getEddiPeriodStats(startMs, endMs) {
  const now = endMs || Date.now();

  // Per-day rate resolution (not a single rate for the whole period). The
  // Eddi's counters only carry one total per local day, so this can't be
  // TOU-weighted within a day - each day's rate is resolved from that day's
  // own mid-point timestamp, which is the finest granularity the data
  // actually supports.
  const resolveRate = createRateResolver();

  // The Eddi's energy_today_kwh counter resets at LOCAL midnight, not UTC midnight.
  // Bucketing by raw UTC day (recorded_at / 86400000) splits each local day across two
  // UTC buckets for timezones east of UTC (e.g. AEST UTC+10), causing double-counting.
  // Fix: shift recorded_at into local time before bucketing so each local day is one bucket.
  // getTimezoneOffset() returns -600 for UTC+10 (Brisbane), so tzOffsetMs = +36,000,000ms.
  const tzOffsetMs = -new Date().getTimezoneOffset() * 60 * 1000;

  // Total kWh = sum of the LAST energy_today_kwh per LOCAL calendar day inside [startMs, now].
  // Using MAX(energy_today_kwh) was wrong: the Eddi resets at midnight but the first poll of
  // the new day (e.g. 00:00:05) still carries yesterday's final value before the device clears
  // it 30 seconds later - causing MAX to pick up the stale carryover from the previous day.
  // Using the last reading per day gives the correct end-of-day total for past days and the
  // correct running total for today.
  const dayRows = db.prepare(`
    SELECT lpd.day_bucket, e.energy_today_kwh AS day_kwh, e.boost_today_kwh AS boost_kwh,
           (lpd.first_at + lpd.last_at) / 2 AS mid_at
    FROM (
      SELECT
        CAST((recorded_at + ?) / 86400000 AS INTEGER) AS day_bucket,
        MIN(recorded_at) AS first_at,
        MAX(recorded_at) AS last_at
      FROM eddi_telemetry
      WHERE recorded_at >= ? AND recorded_at < ?
      GROUP BY day_bucket
    ) lpd
    JOIN eddi_telemetry e ON e.recorded_at = lpd.last_at
  `).all(tzOffsetMs, startMs, now);

  const totalKwh = dayRows.reduce((sum, r) => sum + (r.day_kwh   || 0), 0);
  const boostKwh = dayRows.reduce((sum, r) => sum + (r.boost_kwh || 0), 0);

  let savings  = 0;
  let gridCost = 0;
  for (const r of dayRows) {
    const rate = resolveRate(r.mid_at);
    // day_kwh is ALL energy delivered to hot water, including the grid-boosted
    // portion - only the non-boost part actually displaced a grid import.
    const solarKwh = Math.max(0, (r.day_kwh || 0) - (r.boost_kwh || 0));
    savings  += solarKwh * rate;
    gridCost += (r.boost_kwh || 0) * rate;
  }

  return {
    total_kwh:       Math.round(totalKwh  * 100) / 100,
    boost_kwh:       Math.round(boostKwh  * 100) / 100,
    est_savings_aud: Math.round(savings   * 100) / 100,
    grid_cost_aud:   Math.round(gridCost  * 100) / 100,
  };
}

/**
 * Returns per-day hot water stats for a calendar month.
 * @returns {{ day: number, kwh: number, peak_w: number }[]}
 */
function getEddiDailyStats(year, month) {
  const start = new Date(year, month - 1, 1).getTime();
  const end   = new Date(year, month, 1).getTime();

  const rows = db.prepare(`
    SELECT
      CAST((recorded_at - ?) / 86400000 AS INTEGER) AS day_idx,
      MAX(energy_today_kwh) AS day_kwh,
      MAX(boost_today_kwh)  AS boost_kwh,
      MAX(diverted_w) AS peak_w
    FROM eddi_telemetry
    WHERE recorded_at >= ? AND recorded_at < ?
    GROUP BY day_idx
  `).all(start, start, end);

  const dayMap = {};
  for (const r of rows) {
    const d = r.day_idx + 1; // 1-based
    dayMap[d] = {
      day:       d,
      kwh:       Math.round((r.day_kwh   || 0) * 100) / 100,
      boost_kwh: Math.round((r.boost_kwh || 0) * 100) / 100,
      peak_w:    r.peak_w || 0,
    };
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  return Array.from({ length: daysInMonth }, (_, i) => {
    const d = i + 1;
    return dayMap[d] || { day: d, kwh: 0, boost_kwh: 0, peak_w: 0 };
  });
}

function getACDailyStats(year, month) {
  const start = new Date(year, month - 1, 1).getTime();
  const end   = new Date(year, month, 1).getTime();

  const rows = db.prepare(`
    SELECT
      CAST((recorded_at - ?) / 86400000 AS INTEGER) AS day_idx,
      MAX(daily_energy_kwh) AS day_kwh
    FROM ac_telemetry
    WHERE recorded_at >= ? AND recorded_at < ?
    GROUP BY day_idx
  `).all(start, start, end);

  const dayMap = {};
  for (const r of rows) {
    const d = r.day_idx + 1; // 1-based
    dayMap[d] = { day: d, kwh: Math.round((r.day_kwh || 0) * 100) / 100 };
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  return Array.from({ length: daysInMonth }, (_, i) => {
    const d = i + 1;
    return dayMap[d] || { day: d, kwh: 0 };
  });
}

function cleanOldData() {
  const fiveYearsAgo  = Date.now() - 5 * 365 * 24 * 60 * 60 * 1000;
  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;

  const t = db.prepare('DELETE FROM telemetry_log WHERE recorded_at < ?').run(fiveYearsAgo);
  const e = db.prepare('DELETE FROM events_log WHERE occurred_at < ?').run(ninetyDaysAgo);

  console.log(`[db] Cleaned ${t.changes} telemetry rows, ${e.changes} event rows`);
}

function getDb() {
  return db;
}

// ── Electricity bills ─────────────────────────────────────────────────────────

function insertBill(data) {
  db.prepare(`
    INSERT OR IGNORE INTO electricity_bills (
      created_at, email_id, billing_period_start, billing_period_end,
      retailer, account_number, total_amount_aud, gst_aud,
      supply_charge_aud, usage_charge_aud, solar_export_credit_aud,
      total_kwh, peak_kwh, off_peak_kwh, shoulder_kwh, solar_export_kwh,
      supply_charge_cents_per_day, peak_rate_cents, off_peak_rate_cents,
      shoulder_rate_cents, notes, raw_json
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?
    )
  `).run(
    data.created_at,
    data.email_id || null,
    data.billing_period_start || null,
    data.billing_period_end   || null,
    data.retailer             || null,
    data.account_number       || null,
    data.total_amount_aud     != null ? data.total_amount_aud     : null,
    data.gst_aud              != null ? data.gst_aud              : null,
    data.supply_charge_aud    != null ? data.supply_charge_aud    : null,
    data.usage_charge_aud     != null ? data.usage_charge_aud     : null,
    data.solar_export_credit_aud != null ? data.solar_export_credit_aud : 0,
    data.total_kwh            != null ? data.total_kwh            : null,
    data.peak_kwh             != null ? data.peak_kwh             : null,
    data.off_peak_kwh         != null ? data.off_peak_kwh         : null,
    data.shoulder_kwh         != null ? data.shoulder_kwh         : null,
    data.solar_export_kwh     != null ? data.solar_export_kwh     : 0,
    data.supply_charge_cents_per_day != null ? data.supply_charge_cents_per_day : null,
    data.peak_rate_cents      != null ? data.peak_rate_cents      : null,
    data.off_peak_rate_cents  != null ? data.off_peak_rate_cents  : null,
    data.shoulder_rate_cents  != null ? data.shoulder_rate_cents  : null,
    data.notes                || null,
    data.raw_json             || null,
  );
}

function getBills() {
  return db.prepare('SELECT * FROM electricity_bills ORDER BY billing_period_start DESC').all();
}

function getBill(id) {
  return db.prepare('SELECT * FROM electricity_bills WHERE id = ?').get(id);
}

function deleteBill(id) {
  db.prepare('DELETE FROM electricity_bills WHERE id = ?').run(id);
}

function getBillPeriodStats(startMs, endMs) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(total_kwh), 0)                AS total_kwh,
      COALESCE(SUM(total_amount_aud), 0)         AS total_paid_aud,
      COALESCE(SUM(solar_export_credit_aud), 0)  AS solar_export_credit_aud
    FROM electricity_bills
    WHERE billing_period_start >= ? AND billing_period_start < ?
  `).get(startMs, endMs);
  return row || { total_kwh: 0, total_paid_aud: 0, solar_export_credit_aud: 0 };
}

// Per-call costs from Tesla Fleet API Australian pricing page (AUD)
// Rates: 641.03 commands/$1, 320.51 data/$1, 32.05 wakes/$1, 96153.85 signals/$1
const API_COSTS = {
  command:   1 / 641.03,    // ~$0.001560 AUD
  data:      1 / 320.51,    // ~$0.003120 AUD
  wake:      1 / 32.05,     // ~$0.031202 AUD
  streaming: 1 / 96153.85,  // ~$0.0000104 AUD
};
const API_MONTHLY_BUDGET = 16.00; // AUD free tier, resets 1st of each month

/**
 * Returns Tesla Fleet API cost breakdown for the given calendar month.
 * year: full year (e.g. 2026), month: 1-12
 */
function getApiCostStats(year, month) {
  const start = new Date(year, month - 1, 1).getTime();
  const end   = new Date(year, month,     1).getTime(); // first ms of next month

  const rows = db.prepare(
    `SELECT details, COUNT(*) AS cnt
     FROM events_log
     WHERE event_type = 'api_cost' AND occurred_at >= ? AND occurred_at < ?
     GROUP BY details`
  ).all(start, end);

  const counts = { command: 0, data: 0, wake: 0 };
  for (const r of rows) {
    if (r.details in counts) counts[r.details] = r.cnt;
  }

  const costs = {
    command: counts.command * API_COSTS.command,
    data:    counts.data    * API_COSTS.data,
    wake:    counts.wake    * API_COSTS.wake,
  };
  const total = costs.command + costs.data + costs.wake;

  // Days elapsed / days in month for projection
  const now = Date.now();
  const msInMonth = end - start;
  const msElapsed = Math.min(now - start, msInMonth);
  const daysFraction = msElapsed / msInMonth;
  const projected = daysFraction > 0 ? total / daysFraction : 0;

  return {
    year, month,
    counts,
    costs,
    total,
    budget: API_MONTHLY_BUDGET,
    projected,
    onTrack: projected <= API_MONTHLY_BUDGET,
  };
}

/**
 * Import historical Eddi data from a parsed CSV.
 * Expects an array of { localDate (YYYY-MM-DD), divertKwh, boostKwh }.
 * Inserts one end-of-day record per local date.
 * Skips dates that already have an 'Imported' record.
 */
function importEddiCsvData(dayRecords) {
  const TZ = 'Australia/Sydney';

  // Pre-build a set of already-imported local dates (YYYY-MM-DD) to detect duplicates
  const existing = db.prepare(
    `SELECT recorded_at FROM eddi_telemetry WHERE status = 'Imported'`
  ).all().map(r => {
    // Use en-CA locale which returns YYYY-MM-DD - same format as localDate below
    return new Date(r.recorded_at).toLocaleDateString('en-CA', { timeZone: TZ });
  });
  const existingSet = new Set(existing);

  const deleteExisting = db.prepare(
    `DELETE FROM eddi_telemetry WHERE status = 'Imported' AND recorded_at = ?`
  );
  const insert = db.prepare(`
    INSERT INTO eddi_telemetry (recorded_at, diverted_w, status, energy_today_kwh, boost_today_kwh, temp1, temp2)
    VALUES (?, 0, 'Imported', ?, ?, NULL, NULL)
  `);

  let imported = 0;
  let updated  = 0;

  const run = db.transaction(() => {
    for (const { localDate, divertKwh, boostKwh } of dayRecords) {
      // 23:59:59 Australia/Sydney = 13:59:59 UTC (UTC+10, no DST May–Sep)
      const [y, m, d] = localDate.split('-').map(Number);
      const recordedAt = Date.UTC(y, m - 1, d, 13, 59, 59);

      if (existingSet.has(localDate)) {
        // Update: delete old record and re-insert with latest values
        deleteExisting.run(recordedAt);
        insert.run(recordedAt, divertKwh, boostKwh);
        updated++;
      } else {
        insert.run(recordedAt, divertKwh, boostKwh);
        imported++;
      }
    }
  });

  run();
  return { imported, updated, skipped: 0 };
}

/**
 * House load stats for a time period.
 * Uses time-weighted samples from telemetry_log (LEAD window function).
 * house_w = consumption_w - ev_w - eddi_w
 * solar fraction per sample = MIN(1, solar_w / consumption_w)
 */
// See getPeriodStats()'s comment - same SQL-pushdown approach, verified to
// agree with the original row-by-row JS implementation before switching over.
function _getHousePeriodStatsUncached(startMs, endMs) {
  const now = endMs || Date.now();
  const { sql: rateSql, params: rateParams } = buildRateCaseSql();

  const row = db.prepare(`
    WITH base AS (
      SELECT
        recorded_at,
        MAX(0.0, consumption_w - ev_w - COALESCE(eddi_w, 0)) AS house_w,
        MAX(0.0, solar_w)                                    AS solar_w,
        MAX(0.0, consumption_w)                               AS consumption_w,
        MIN(
          COALESCE(LEAD(recorded_at) OVER (ORDER BY recorded_at) - recorded_at, 30000),
          120000
        ) / 3600000.0                                         AS interval_h
      FROM telemetry_log
      WHERE recorded_at >= ? AND recorded_at < ?
    ),
    calced AS (
      SELECT *,
        MIN(1.0, solar_w / MAX(consumption_w, 1.0)) AS solar_frac,
        (${rateSql}) AS rate
      FROM base
    )
    SELECT
      COALESCE(SUM(house_w * interval_h / 1000.0), 0) AS house_kwh,
      COALESCE(SUM(house_w * solar_frac * interval_h / 1000.0), 0) AS house_solar_kwh,
      COALESCE(SUM(
        MAX(0.0, (house_w * interval_h / 1000.0) - (house_w * solar_frac * interval_h / 1000.0)) * rate
      ), 0) AS grid_cost,
      COALESCE(SUM(house_w * solar_frac * interval_h / 1000.0 * rate), 0) AS savings
    FROM calced
  `).get(startMs, now, ...rateParams);

  const houseKwh      = Math.max(0, Math.round((row.house_kwh       || 0) * 100) / 100);
  const houseSolarKwh = Math.max(0, Math.round((row.house_solar_kwh || 0) * 100) / 100);
  const houseGridKwh  = Math.max(0, Math.round((houseKwh - houseSolarKwh) * 100) / 100);
  const selfPct       = houseKwh > 0 ? Math.round((houseSolarKwh / houseKwh) * 100) : 0;

  return {
    house_kwh:       houseKwh,
    solar_kwh:       houseSolarKwh,
    grid_kwh:        houseGridKwh,
    self_pct:        selfPct,
    grid_cost_aud:   Math.round((row.grid_cost || 0) * 100) / 100,
    est_savings_aud: Math.round((row.savings   || 0) * 100) / 100,
  };
}

const getHousePeriodStats = _memoizeShortTtl(_getHousePeriodStatsUncached, 'house');

/**
 * Lifetime solar charging provenance - how much of all EV charging came from the roof.
 * Includes grid portion only when kwh_from_grid is populated (after TeslaMate sync).
 */
function getSolarKwhCharged(startMs, endMs) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(kwh_solar), 0) AS solar_kwh
    FROM charge_sessions
    WHERE started_at >= ? AND started_at < ? AND kwh_solar IS NOT NULL
  `).get(startMs, endMs || Date.now());
  return Math.round((row?.solar_kwh || 0) * 100) / 100;
}

function getChargeSessionsInWindow(startMs, endMs) {
  return db.prepare(`
    SELECT id, started_at, ended_at, kwh_solar, kwh_from_grid
    FROM charge_sessions
    WHERE ended_at IS NOT NULL AND ended_at >= ? AND ended_at < ?
    ORDER BY ended_at ASC
  `).all(startMs, endMs);
}

function getSolarProvenance() {
  const summary = db.prepare(`
    SELECT
      MIN(started_at) AS first_session_at,
      COALESCE(SUM(kwh_solar), 0) AS total_solar_kwh,
      COALESCE(SUM(kwh_from_grid), 0) AS total_grid_kwh,
      COUNT(*) AS total_sessions
    FROM charge_sessions
    WHERE ended_at IS NOT NULL
  `).get();

  if (!summary || !summary.first_session_at) {
    return { total_solar_kwh: 0, total_grid_kwh: 0, solar_pct: 0, total_sessions: 0, first_session_at: null };
  }

  const solarKwh = Math.round((summary.total_solar_kwh || 0) * 100) / 100;
  const gridKwh  = Math.round((summary.total_grid_kwh  || 0) * 100) / 100;
  const totalKwh = solarKwh + gridKwh;
  const solarPct = totalKwh > 0 ? Math.round((solarKwh / totalKwh) * 1000) / 10 : 0;

  // Lifetime savings costed per-session at the rate in effect when each
  // session actually happened, not a single blended "current" rate.
  const resolveRate = createRateResolver();
  const sessions = db.prepare(`
    SELECT started_at, kwh_solar FROM charge_sessions
    WHERE ended_at IS NOT NULL AND kwh_solar IS NOT NULL
  `).all();
  let savings = 0;
  for (const s of sessions) {
    savings += (s.kwh_solar || 0) * resolveRate(s.started_at);
  }
  savings = Math.round(savings * 100) / 100;

  return {
    total_solar_kwh:  solarKwh,
    total_grid_kwh:   gridKwh,
    solar_pct:        solarPct,
    total_sessions:   parseInt(summary.total_sessions, 10) || 0,
    first_session_at: summary.first_session_at,
    est_savings_aud:  savings,
    rate_aud:         resolveRate(Date.now()),
  };
}

// ── Known destinations ────────────────────────────────────────────────────────

function getKnownDestinationByAddress(address) {
  return db.prepare('SELECT * FROM known_destinations WHERE address = ?').get(address);
}

function getKnownDestinationsWithCoords() {
  return db.prepare('SELECT * FROM known_destinations WHERE lat IS NOT NULL').all();
}

function upsertKnownDestination({ name, address, lat, lng, distance_km, avg_kwh_required, visit_count }) {
  const existing = db.prepare('SELECT id FROM known_destinations WHERE address = ?').get(address);
  if (existing) {
    db.prepare(`
      UPDATE known_destinations SET
        name = COALESCE(?, name),
        lat = COALESCE(?, lat),
        lng = COALESCE(?, lng),
        distance_km = COALESCE(?, distance_km),
        avg_kwh_required = COALESCE(?, avg_kwh_required),
        visit_count = COALESCE(?, visit_count)
      WHERE id = ?
    `).run(name || null, lat || null, lng || null, distance_km || null, avg_kwh_required || null, visit_count || null, existing.id);
    return existing.id;
  }
  const info = db.prepare(`
    INSERT INTO known_destinations (name, address, lat, lng, distance_km, avg_kwh_required, visit_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name || address, address, lat || null, lng || null, distance_km || null, avg_kwh_required || null, visit_count || 0);
  return info.lastInsertRowid;
}

function updateDestinationAvgKwh(id, newKwh) {
  const dest = db.prepare('SELECT avg_kwh_required, visit_count FROM known_destinations WHERE id = ?').get(id);
  if (!dest) return;
  const count = (dest.visit_count || 0) + 1;
  const avg = dest.avg_kwh_required != null
    ? (dest.avg_kwh_required * dest.visit_count + newKwh) / count
    : newKwh;
  db.prepare('UPDATE known_destinations SET avg_kwh_required = ?, visit_count = ?, last_visited = ? WHERE id = ?')
    .run(Math.round(avg * 100) / 100, count, Date.now(), id);
}

// ── Trip log ──────────────────────────────────────────────────────────────────

function insertTripLog({ destination_name, destination_id, distance_km, departure_time, predicted_kwh, notes }) {
  const info = db.prepare(`
    INSERT INTO trip_log (created_at, destination_name, destination_id, distance_km, departure_time, predicted_kwh, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(Date.now(), destination_name || null, destination_id || null, distance_km || null, departure_time || null, predicted_kwh || null, notes || null);
  return info.lastInsertRowid;
}

function completeTripLog(id, { actual_kwh, floor_maintained }) {
  db.prepare('UPDATE trip_log SET actual_kwh = ?, floor_maintained = ? WHERE id = ?')
    .run(actual_kwh || null, floor_maintained ? 1 : 0, id);
}

function getPendingTripLogs() {
  return db.prepare('SELECT * FROM trip_log WHERE actual_kwh IS NULL AND departure_time > ? ORDER BY departure_time ASC')
    .all(Date.now() - 12 * 60 * 60 * 1000); // within last 12 hours
}

function getHouseDailyStats(year, month) {
  const start       = new Date(year, month - 1, 1).getTime();
  const end         = new Date(year, month, 1).getTime();
  const daysInMonth = new Date(year, month, 0).getDate();

  const rows = db.prepare(`
    WITH intervals AS (
      SELECT
        CAST((recorded_at - ?) / 86400000 AS INTEGER)                AS day_idx,
        MAX(0.0, consumption_w - ev_w - COALESCE(eddi_w, 0)) AS house_w,
        MAX(0.0, solar_w)                                             AS solar_w,
        MAX(0.0, consumption_w)                                       AS consumption_w,
        MIN(
          COALESCE(LEAD(recorded_at) OVER (ORDER BY recorded_at) - recorded_at, 30000),
          120000
        ) / 3600000.0                                                 AS interval_h
      FROM telemetry_log
      WHERE recorded_at >= ? AND recorded_at < ?
    )
    SELECT
      day_idx,
      SUM(house_w * interval_h / 1000.0)                                                AS house_kwh,
      SUM(house_w * MIN(1.0, solar_w / MAX(consumption_w, 1.0)) * interval_h / 1000.0) AS house_solar_kwh
    FROM intervals
    GROUP BY day_idx
    ORDER BY day_idx
  `).all(start, start, end);

  const dayMap = {};
  for (const r of rows) {
    const d            = r.day_idx + 1;
    const houseKwh     = Math.max(0, Math.round((r.house_kwh       || 0) * 100) / 100);
    const houseSolarKwh = Math.max(0, Math.min(houseKwh, Math.round((r.house_solar_kwh || 0) * 100) / 100));
    dayMap[d] = {
      day:             d,
      house_kwh:       houseKwh,
      house_solar_kwh: houseSolarKwh,
      house_grid_kwh:  Math.max(0, Math.round((houseKwh - houseSolarKwh) * 100) / 100),
    };
  }

  return Array.from({ length: daysInMonth }, (_, i) => {
    const d = i + 1;
    return dayMap[d] || { day: d, house_kwh: 0, house_solar_kwh: 0, house_grid_kwh: 0 };
  });
}

// ── Solcast solar forecasts ──────────────────────────────────────────────────

function insertSolcastForecast({ fetched_at, period_start, period_end, pv_estimate_kw }) {
  db.prepare(`
    INSERT INTO solcast_forecasts (fetched_at, period_start, period_end, pv_estimate_kw)
    VALUES (?, ?, ?, ?)
  `).run(
    fetched_at || Date.now(),
    period_start,
    period_end,
    pv_estimate_kw
  );
}

function getSolcastForecastBatch() {
  // Only return data from the most recent fetch - previous fetches are stale duplicates.
  return db.prepare(`
    SELECT period_start, period_end, pv_estimate_kw FROM solcast_forecasts
    WHERE fetched_at = (SELECT MAX(fetched_at) FROM solcast_forecasts)
    ORDER BY period_start ASC
  `).all();
}

function getLastSolcastFetch() {
  return db.prepare(`
    SELECT MAX(fetched_at) as last_fetch FROM solcast_forecasts
  `).get();
}

function getSolcastForecastInWindow(startMs, endMs) {
  // Only query data from the most recent fetch to avoid 4× inflation from duplicate batches.
  const rows = db.prepare(`
    SELECT period_start, period_end, pv_estimate_kw FROM solcast_forecasts
    WHERE period_start >= ? AND period_end <= ?
      AND fetched_at = (SELECT MAX(fetched_at) FROM solcast_forecasts)
    ORDER BY period_start ASC
  `).all(startMs, endMs);
  return rows;
}

/**
 * Returns per-day kWh totals for all remaining forecast intervals (from now onwards).
 * Each row: { day: 'YYYY-MM-DD', kwh: number }
 */
function getSolcastDailyTotals() {
  const now      = Date.now();
  const nowSec   = Math.floor(now / 1000);
  // today's date string in localtime (YYYY-MM-DD) - used to anchor the query
  const todayStr = new Date(now).toLocaleDateString('en-CA'); // en-CA gives YYYY-MM-DD

  return db.prepare(`
    SELECT
      DATE(period_start / 1000, 'unixepoch', 'localtime') AS day,
      ROUND(SUM(pv_estimate_kw * 0.5), 2)                  AS kwh,
      ROUND(SUM(CASE WHEN period_start >= ? THEN pv_estimate_kw * 0.5 ELSE 0 END), 2) AS remaining_kwh
    FROM solcast_forecasts
    WHERE fetched_at = (SELECT MAX(fetched_at) FROM solcast_forecasts)
      AND DATE(period_start / 1000, 'unixepoch', 'localtime') >= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(now, todayStr);
}

function insertIntradayTracking({ tracked_at, forecast_accuracy_ratio, forecast_remaining_kwh, adjusted_remaining_kwh }) {
  db.prepare(`
    INSERT INTO solcast_intraday_tracking (tracked_at, forecast_accuracy_ratio, forecast_remaining_kwh, adjusted_remaining_kwh)
    VALUES (?, ?, ?, ?)
  `).run(
    tracked_at || Date.now(),
    forecast_accuracy_ratio || null,
    forecast_remaining_kwh || null,
    adjusted_remaining_kwh || null
  );
}

function getLatestIntradayTracking() {
  return db.prepare(`
    SELECT * FROM solcast_intraday_tracking
    WHERE tracked_at >= ?
    ORDER BY tracked_at DESC
    LIMIT 1
  `).get(Date.now() - 24 * 60 * 60 * 1000); // Last 24 hours
}

// Phase 5 - diversion log: return the points where diversion_reason changed in
// the last `hours` hours, so the Data tab shows a readable transition history
// rather than thousands of identical 15-second rows.
function getDiversionLog(hours = 24) {
  const since = Date.now() - hours * 60 * 60 * 1000;
  return db.prepare(`
    SELECT recorded_at, controller_state, diversion_reason, trip_within_18hrs,
           ev_w, eddi_w, solar_w, consumption_w
    FROM (
      SELECT *, LAG(diversion_reason) OVER (ORDER BY recorded_at) AS prev_reason
      FROM telemetry_log
      WHERE recorded_at >= ?
    )
    WHERE diversion_reason IS NOT NULL
      AND (prev_reason IS NULL OR prev_reason != diversion_reason)
    ORDER BY recorded_at DESC
    LIMIT 200
  `).all(since);
}

// Phase 6 - Financial Ledger
function insertFinancialLedgerEntry({ date, kwh_imported, kwh_exported, kwh_solar_self_consumed, kwh_solar_to_tesla, kwh_solar_to_hotwater, kwh_solar_to_house, import_cost, export_credit, solar_avoided_cost, net_cost, supply_charge }) {
  db.prepare(`
    INSERT OR REPLACE INTO financial_ledger
    (date, kwh_imported, kwh_exported, kwh_solar_self_consumed, kwh_solar_to_tesla, kwh_solar_to_hotwater, kwh_solar_to_house, import_cost, export_credit, solar_avoided_cost, net_cost, supply_charge)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(date, kwh_imported || 0, kwh_exported || 0, kwh_solar_self_consumed || 0, kwh_solar_to_tesla || 0, kwh_solar_to_hotwater || 0, kwh_solar_to_house || 0, import_cost || 0, export_credit || 0, solar_avoided_cost || 0, net_cost || 0, supply_charge || 0);
}

function getFinancialLedgerForDate(date) {
  return db.prepare('SELECT * FROM financial_ledger WHERE date = ?').get(date);
}

function getFinancialLedgerForPeriod(startDate, endDate) {
  return db.prepare(`
    SELECT * FROM financial_ledger
    WHERE date >= ? AND date <= ?
    ORDER BY date ASC
  `).all(startDate, endDate);
}

function insertEvHomeChargingLog({ date, kwh_charged, kwh_from_solar, kwh_from_grid, cost_basis, session_start, session_end, charge_session_id }) {
  db.prepare(`
    INSERT INTO ev_home_charging_log
    (date, kwh_charged, kwh_from_solar, kwh_from_grid, cost_basis, session_start, session_end, charge_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(date, kwh_charged, kwh_from_solar || null, kwh_from_grid || null, cost_basis || null, session_start || null, session_end || null, charge_session_id || null);
}

function getEvHomeChargingLogForPeriod(startDate, endDate) {
  return db.prepare(`
    SELECT * FROM ev_home_charging_log
    WHERE date >= ? AND date <= ?
    ORDER BY date ASC
  `).all(startDate, endDate);
}

// ── Panel health (Phase 7) ────────────────────────────────────────────────────

function insertPanelProductionBatch(rows) {
  const stmt = db.prepare(
    'INSERT INTO panel_production (recorded_at, panel_id, wh_produced, irradiance_approx) VALUES (?, ?, ?, ?)'
  );
  const run = db.transaction(() => {
    for (const r of rows) {
      stmt.run(r.recorded_at, r.panel_id, r.wh_produced || 0, r.irradiance_approx || 0);
    }
  });
  run();
}

function getPanelProductionWindow(startMs, endMs) {
  return db.prepare(`
    SELECT recorded_at, panel_id, wh_produced, irradiance_approx
    FROM panel_production
    WHERE recorded_at >= ? AND recorded_at <= ?
    ORDER BY recorded_at ASC
  `).all(startMs, endMs || Date.now());
}

function getPanelHealthAlert(panelId) {
  return db.prepare('SELECT * FROM panel_health_alerts WHERE panel_id = ?').get(panelId);
}

function upsertPanelHealthAlert(panelId, lastNotifiedAt, pctBelow) {
  db.prepare(`
    INSERT INTO panel_health_alerts (panel_id, last_notified_at, last_pct_below, alert_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(panel_id) DO UPDATE SET
      last_notified_at = excluded.last_notified_at,
      last_pct_below = excluded.last_pct_below,
      alert_count = alert_count + 1
  `).run(panelId, lastNotifiedAt, pctBelow);
}

// ── Phase 8: Day Replays ──────────────────────────────────────────────────────

function insertDayReplay({ date, dataJson }) {
  db.prepare(`
    INSERT OR REPLACE INTO day_replays (date, data_json, aggregated_at)
    VALUES (?, ?, ?)
  `).run(date, dataJson, Date.now());
}

function getDayReplayByDate(date) {
  const row = db.prepare('SELECT * FROM day_replays WHERE date = ?').get(date);
  if (row && row.data_json) {
    try {
      return { ...row, data: JSON.parse(row.data_json) };
    } catch (_) {
      return row;
    }
  }
  return row;
}

function getLatestDayReplay() {
  const row = db.prepare('SELECT * FROM day_replays ORDER BY date DESC LIMIT 1').get();
  if (row && row.data_json) {
    try {
      return { ...row, data: JSON.parse(row.data_json) };
    } catch (_) {
      return row;
    }
  }
  return row;
}

// ── Departure Scheduler ───────────────────────────────────────────────────────

function setDeparture(departureTimeMs, targetSoc, notes) {
  // Wipe any previous entry - only one departure at a time
  db.prepare('DELETE FROM departure_schedule').run();
  db.prepare(`
    INSERT INTO departure_schedule (departure_time, target_soc, notes, created_at, active)
    VALUES (?, ?, ?, ?, 1)
  `).run(departureTimeMs, targetSoc, notes || null, Date.now());
}

function getActiveDeparture() {
  return db.prepare(`
    SELECT * FROM departure_schedule
    WHERE active = 1 AND departure_time > ?
    ORDER BY created_at DESC LIMIT 1
  `).get(Date.now());
}

function clearDeparture() {
  db.prepare('UPDATE departure_schedule SET active = 0').run();
}

// ── Weather & Grid Intensity ──────────────────────────────────────────────────

function upsertWeatherCache(dataObj) {
  db.prepare(`
    INSERT INTO weather_cache (id, fetched_at, data_json) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at, data_json = excluded.data_json
  `).run(Date.now(), JSON.stringify(dataObj));
}

function getWeatherCache() {
  const row = db.prepare('SELECT * FROM weather_cache WHERE id = 1').get();
  if (!row) return null;
  try {
    return { fetchedAt: row.fetched_at, data: JSON.parse(row.data_json) };
  } catch (_) {
    return null;
  }
}

function insertGridIntensity(data) {
  db.prepare(`
    INSERT INTO grid_intensity_log
      (recorded_at, renewable_pct, carbon_intensity_g, solar_mw, wind_mw, coal_mw, gas_mw, hydro_mw, total_demand_mw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Date.now(),
    data.renewablePct  ?? null,
    data.carbonIntensityG ?? null,
    data.solarMw       ?? null,
    data.windMw        ?? null,
    data.coalMw        ?? null,
    data.gasMw         ?? null,
    data.hydroMw       ?? null,
    data.totalDemandMw ?? null,
  );
}

function getLatestGridIntensity() {
  return db.prepare('SELECT * FROM grid_intensity_log ORDER BY recorded_at DESC LIMIT 1').get() || null;
}

function getGridIntensityHistory(hoursBack = 24) {
  const since = Date.now() - hoursBack * 60 * 60 * 1000;
  return db.prepare('SELECT * FROM grid_intensity_log WHERE recorded_at > ? ORDER BY recorded_at ASC').all(since);
}

// ── Hourly profile (time-of-use / time-of-generation) ────────────────────────

/**
 * Returns 24 rows (one per hour 0–23) with average power in watts for each
 * device over the given period. Only hours that have at least one reading are
 * returned; missing hours get zeros in the JS layer.
 */
function getHourlyProfile(startMs, endMs) {
  const rows = db.prepare(`
    SELECT
      CAST(strftime('%H', datetime(recorded_at / 1000, 'unixepoch', 'localtime')) AS INTEGER) AS hour,
      AVG(COALESCE(solar_w, 0))                                              AS solar_w,
      AVG(COALESCE(consumption_w, 0))                                        AS total_w,
      AVG(MAX(0.0, COALESCE(consumption_w, 0)
               - COALESCE(ev_w, 0)
               - COALESCE(eddi_w, 0)))                                       AS house_w,
      AVG(COALESCE(ev_w, 0))                                                 AS ev_w,
      AVG(COALESCE(eddi_w, 0))                                               AS eddi_w,
      AVG(CASE WHEN grid_w > 0 THEN grid_w ELSE 0 END)                      AS import_w,
      AVG(CASE WHEN grid_w < 0 THEN ABS(grid_w) ELSE 0 END)                 AS export_w,
      COUNT(*)                                                               AS samples
    FROM telemetry_log
    WHERE recorded_at >= ? AND recorded_at < ?
    GROUP BY hour
    ORDER BY hour
  `).all(startMs, endMs || Date.now());

  // Fill all 24 hours so the chart always has a complete X axis
  const byHour = {};
  for (const r of rows) byHour[r.hour] = r;

  const round = v => Math.round(v);
  return Array.from({ length: 24 }, (_, h) => {
    const r = byHour[h];
    if (!r) return { hour: h, solar_w: 0, total_w: 0, house_w: 0, ev_w: 0, eddi_w: 0, import_w: 0, export_w: 0, samples: 0 };
    return {
      hour:     h,
      solar_w:  round(r.solar_w),
      total_w:  round(r.total_w),
      house_w:  round(r.house_w),
      ev_w:     round(r.ev_w),
      eddi_w:   round(r.eddi_w),
      import_w: round(r.import_w),
      export_w: round(r.export_w),
      samples:  r.samples,
    };
  });
}

/**
 * Returns a day-of-week x hour-of-day grid of average watts for one telemetry
 * column, over the given period - e.g. "which hours, on which days, does
 * excess solar or EV charging actually happen". Complements getHourlyProfile
 * (hour-of-day only, no day split) and the daily calendar heatmap (day totals,
 * no hour split) - this is the one view showing both axes together.
 *
 * metric must be one of METRIC_COLUMNS' keys - never interpolate arbitrary
 * caller input into the column name.
 */
const HEATMAP_METRIC_COLUMNS = {
  solar_excess: 'solar_excess_w',
  ev:           'ev_w',
};

function getHeatmapProfile(startMs, endMs, metric) {
  const column = HEATMAP_METRIC_COLUMNS[metric];
  if (!column) throw new Error(`Unknown heatmap metric: ${metric}`);

  const rows = db.prepare(`
    SELECT
      CAST(strftime('%w', datetime(recorded_at / 1000, 'unixepoch', 'localtime')) AS INTEGER) AS dow,
      CAST(strftime('%H', datetime(recorded_at / 1000, 'unixepoch', 'localtime')) AS INTEGER) AS hour,
      AVG(MAX(0.0, COALESCE(${column}, 0))) AS avg_w,
      COUNT(*) AS samples
    FROM telemetry_log
    WHERE recorded_at >= ? AND recorded_at < ?
    GROUP BY dow, hour
  `).all(startMs, endMs || Date.now());

  // strftime('%w') is 0=Sunday..6=Saturday - reindex to a Monday-first week
  // for the chart, and fill every (day, hour) cell so the grid is always complete.
  const byKey = {};
  for (const r of rows) byKey[`${r.dow}-${r.hour}`] = r;

  const dowOrder = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun
  const cells = [];
  for (const dow of dowOrder) {
    for (let hour = 0; hour < 24; hour++) {
      const r = byKey[`${dow}-${hour}`];
      cells.push({
        dow,
        hour,
        avg_w: r ? Math.round(r.avg_w) : 0,
        samples: r ? r.samples : 0,
      });
    }
  }
  return cells;
}

// ── Retailer Comparison data pull ─────────────────────────────────────────────

/**
 * Returns half-hourly aggregated grid import & solar export data for the last `days` days.
 * Each row: { slot_ms, kwh_imported, kwh_exported }
 */
function getHalfHourlyEnergyData(days) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  // Each telemetry row is ~15 seconds; 120 rows ≈ 30 minutes
  // We bucket by flooring to 30-minute boundaries
  const rows = db.prepare(`
    SELECT
      (recorded_at / 1800000) * 1800000  AS slot_ms,
      AVG(CASE WHEN grid_w > 0 THEN grid_w ELSE 0 END) AS avg_import_w,
      AVG(CASE WHEN grid_w < 0 THEN ABS(grid_w) ELSE 0 END) AS avg_export_w,
      COUNT(*) AS readings
    FROM telemetry_log
    WHERE recorded_at > ?
    GROUP BY slot_ms
    ORDER BY slot_ms ASC
  `).all(since);

  return rows.map(r => ({
    slotMs:      r.slot_ms,
    kwhImported: (r.avg_import_w * 0.5) / 1000,  // avg W * 0.5h → kWh
    kwhExported: (r.avg_export_w * 0.5) / 1000,
    readings:    r.readings,
  }));
}

module.exports = {
  initDb,
  getDb,
  getDiversionLog,
  getSetting,
  setSetting,
  getAllSettings,
  getToken,
  setToken,
  deleteToken,
  logEvent,
  logTelemetry,
  startSession,
  endSession,
  calcSessionEnergyFromTelemetry,
  closeOrphanedSessions,
  getSessions,
  getSession,
  getTodayStats,
  getEvents,
  getLastTelemetry,
  getMonthlyStats,
  getPeriodStats,
  getRates,
  addRate,
  deleteRate,
  getTouConfigs,
  getTouConfigAtDate,
  addTouConfig,
  deleteTouConfig,
  getFlatRateAtDate,
  getRateAtTimestamp,
  createRateResolver,
  getExportConfigs,
  addExportConfig,
  deleteExportConfig,
  getExportRateAtTimestamp,
  createExportRateResolver,
  getTariffs,
  getTariffAtDate,
  getSupplyChargeForPeriod,
  getGridSummaryForPeriod,
  addTariff,
  deleteTariff,
  getApiCostStats,
  cleanOldData,
  insertEddiTelemetry,
  insertAcTelemetry,
  insertLoadHistory,
  getLoadHistory,
  getBaselineStats,
  getEddiPeriodStats,
  getEddiDailyStats,
  getACDailyStats,
  importEddiCsvData,
  insertBill,
  getBills,
  getBill,
  deleteBill,
  getBillPeriodStats,
  getHousePeriodStats,
  getHouseDailyStats,
  getSolarKwhCharged,
  getSolarProvenance,
  getKnownDestinationByAddress,
  getKnownDestinationsWithCoords,
  upsertKnownDestination,
  updateDestinationAvgKwh,
  insertTripLog,
  completeTripLog,
  getPendingTripLogs,
  insertSolcastForecast,
  getSolcastForecastBatch,
  getSolcastDailyTotals,
  getLastSolcastFetch,
  getSolcastForecastInWindow,
  insertIntradayTracking,
  getLatestIntradayTracking,
  insertFinancialLedgerEntry,
  getFinancialLedgerForDate,
  getFinancialLedgerForPeriod,
  insertEvHomeChargingLog,
  getEvHomeChargingLogForPeriod,
  insertPanelProductionBatch,
  getPanelProductionWindow,
  getPanelHealthAlert,
  upsertPanelHealthAlert,
  insertDayReplay,
  getDayReplayByDate,
  getLatestDayReplay,
  // Departure Scheduler
  setDeparture,
  getActiveDeparture,
  clearDeparture,
  // Weather & Grid
  upsertWeatherCache,
  getWeatherCache,
  insertGridIntensity,
  getLatestGridIntensity,
  getGridIntensityHistory,
  // Retailer Comparison
  getHalfHourlyEnergyData,
  // Hourly profile (time-of-use / time-of-generation)
  getHourlyProfile,
  getHeatmapProfile,
  getChargeSessionsInWindow,
};
