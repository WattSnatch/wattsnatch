/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

// ─── Settings page ───

const DAY_LABELS = ['Su','Mo','Tu','We','Th','Fr','Sa'];

// ─── Country-driven UI (currency labels + region-specific card visibility) ───
// Called on load and whenever the Country select changes. Keeps AU/US-only
// UI from showing simultaneously - see currency.js for the display-only
// currency helpers this pairs with (internal settings/columns stay
// _aud-suffixed regardless of country, only what's SHOWN changes here).

const CURRENCY_UNIT_LABELS = {
  'kwh':         { AU: 'Rate (AUD/kWh)',         US: 'Rate (USD/kWh)' },
  'kwh-default': { AU: 'Default rate (AUD/kWh)', US: 'Default rate (USD/kWh)' },
  'day':         { AU: 'Charge (AUD/day)',       US: 'Charge (USD/day)' },
};

// Fuel Cost Comparison card - the underlying math (history.js fuelComparison())
// is genuinely unit-agnostic ("per 100 units of distance"), so this is a pure
// display swap: label/placeholder/help text/range per country. Real-world
// placeholder defaults, not naive unit-converted numbers (e.g. US EPA-rated
// RAV4 combined economy, not an AU L/100km figure run through a conversion
// factor), since these are meant to be sensible starting points to overwrite.
const FUEL_FIELD_CONFIG = {
  fuel_ev_kwh_per_100km: {
    AU: { label: 'EV efficiency (kWh / 100 km)', placeholder: '17.0', help: 'Model Y RWD real-world AU average', min: 5, max: 40 },
    US: { label: 'EV efficiency (kWh / 100 mi)', placeholder: '27.0', help: 'Model Y RWD real-world US average', min: 8, max: 65 },
  },
  fuel_petrol_price_aud: {
    AU: { label: 'Petrol price (AUD / litre)', placeholder: '2.05', help: 'Your local ULP price', min: 0.50, max: 5.00 },
    US: { label: 'Gas price (USD / gallon)', placeholder: '3.50', help: 'Your local regular unleaded price', min: 1.50, max: 8.00 },
  },
  fuel_petrol_l_per_100km: {
    AU: { label: 'Petrol SUV (L / 100 km)', placeholder: '8.4', help: 'e.g. Toyota RAV4 2.5L - 8.4 L/100km', min: 3, max: 25 },
    US: { label: 'Gas SUV (gal / 100 mi)', placeholder: '3.4', help: 'e.g. Toyota RAV4 2.5L - ~30 mpg combined', min: 1, max: 10 },
  },
  fuel_hybrid_l_per_100km: {
    AU: { label: 'Hybrid SUV (L / 100 km)', placeholder: '4.9', help: 'e.g. Toyota RAV4 Hybrid - 4.9 L/100km', min: 2, max: 15 },
    US: { label: 'Hybrid SUV (gal / 100 mi)', placeholder: '2.5', help: 'e.g. Toyota RAV4 Hybrid - ~40 mpg combined', min: 0.5, max: 8 },
  },
};

const GRID_INTENSITY_PROVIDER_LABELS = {
  aemo: 'AEMO (Australia)',
  watttime: 'WattTime',
  electricitymaps: 'ElectricityMaps',
};
const GRID_INTENSITY_PROVIDERS_BY_COUNTRY = {
  AU: ['aemo'],
  US: ['watttime', 'electricitymaps'],
};

function applyCountryUI(country) {
  const c = country === 'US' ? 'US' : 'AU';

  // Currency unit labels on every rate/charge field
  document.querySelectorAll('.currency-unit-label').forEach((el) => {
    const map = CURRENCY_UNIT_LABELS[el.dataset.unit];
    if (map) el.textContent = map[c];
  });

  // ERCOT (Texas) - US only
  const ercotCard = document.getElementById('ercot-pricing-card');
  if (ercotCard) ercotCard.style.display = c === 'US' ? '' : 'none';

  // Export/Feed-in Rate (NEM 3.0-style time-varying export) - only relevant
  // to markets with a time-varying export credit; not a thing in Australia
  const exportRateCard = document.getElementById('export-rate-card');
  if (exportRateCard) exportRateCard.style.display = c === 'US' ? '' : 'none';

  // Fuel Cost Comparison - label/placeholder/help/range per country. The
  // comparison math (history.js fuelComparison()) is unit-agnostic, so this
  // is display-only; existing user-entered values are never touched, only
  // empty fields' placeholders and the static label/help text change.
  for (const [key, byCountry] of Object.entries(FUEL_FIELD_CONFIG)) {
    const cfg = byCountry[c];
    const input = document.getElementById('setting_' + key);
    if (!input || !cfg) continue;
    const label = document.querySelector(`label[for="setting_${key}"]`);
    if (label) label.textContent = cfg.label;
    input.placeholder = cfg.placeholder;
    input.min = cfg.min;
    input.max = cfg.max;
    const help = input.nextElementSibling;
    if (help && help.classList.contains('text-secondary')) help.textContent = cfg.help;
  }

  // Grid Carbon Intensity - provider dropdown filtered by country, and the
  // WattTime/ElectricityMaps fields only shown when a US-side provider is
  // actually selectable
  const gridSelect = document.getElementById('setting_grid_intensity_provider');
  if (gridSelect) {
    const allowed = GRID_INTENSITY_PROVIDERS_BY_COUNTRY[c];
    const previousValue = gridSelect.value;
    gridSelect.innerHTML = allowed.map((id) =>
      `<option value="${id}">${GRID_INTENSITY_PROVIDER_LABELS[id]}</option>`).join('');
    gridSelect.value = allowed.includes(previousValue) ? previousValue : allowed[0];
  }
  const noteAu = document.getElementById('grid-intensity-note-au');
  const noteUs = document.getElementById('grid-intensity-note-us');
  const usFields = document.getElementById('grid-intensity-us-fields');
  if (noteAu) noteAu.style.display = c === 'AU' ? '' : 'none';
  if (noteUs) noteUs.style.display = c === 'US' ? '' : 'none';
  if (usFields) usFields.style.display = c === 'US' ? '' : 'none';
}

// ─── Window row builder ───

function makeWindowRow(w, onRemove) {
  const row = document.createElement('div');
  row.className = 'window-row';

  const daysDiv = document.createElement('div');
  daysDiv.className = 'window-days';
  const dayState = w.days || [];
  for (let i = 0; i < 7; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day-btn' + (dayState.includes(i) ? ' active' : '');
    btn.textContent = DAY_LABELS[i];
    btn.dataset.day = i;
    btn.addEventListener('click', () => btn.classList.toggle('active'));
    daysDiv.appendChild(btn);
  }

  const timeDiv = document.createElement('div');
  timeDiv.className = 'window-time';

  const startInput = document.createElement('input');
  startInput.type = 'time';
  startInput.value = w.start || '22:00';

  const arrow = document.createElement('span');
  arrow.textContent = '→';

  const endInput = document.createElement('input');
  endInput.type = 'time';
  endInput.value = w.end || '07:00';

  timeDiv.appendChild(startInput);
  timeDiv.appendChild(arrow);
  timeDiv.appendChild(endInput);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'window-remove';
  removeBtn.title = 'Remove';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => { row.remove(); });

  row.appendChild(daysDiv);
  row.appendChild(timeDiv);
  row.appendChild(removeBtn);

  row._getWindow = () => ({
    days: [...daysDiv.querySelectorAll('.day-btn.active')].map(b => parseInt(b.dataset.day, 10)),
    start: startInput.value,
    end: endInput.value,
  });

  return row;
}

function getWindows(listId) {
  const list = document.getElementById(listId);
  if (!list) return [];
  return [...list.querySelectorAll('.window-row')].map(r => r._getWindow());
}

function renderWindows(listId, windows) {
  const list = document.getElementById(listId);
  if (!list) return;
  list.innerHTML = '';
  for (const w of (windows || [])) {
    list.appendChild(makeWindowRow(w));
  }
}

const FIELD_IDS = [
  'country', 'grid_retailer_domain', 'retailer_network_distributor',
  'min_charge_amps', 'max_charge_amps', 'hold_minutes',
  'smoothing_window', 'polling_interval_seconds', 'charger_voltage',
  'gateway_ip', 'tesla_vin',
  'tesla_client_id', 'tesla_redirect_uri', 'tesla_region',
  'tesla_command_backend', 'tesla_ble_proxy_url', 'tesla_state_source',
  'enphase_serial', 'enphase_email',
  'home_latitude', 'home_longitude', 'home_radius_km',
  'google_maps_api_key', 'ha_link_key',
  'solar_install_cost_aud',
  'fuel_ev_kwh_per_100km', 'fuel_petrol_l_per_100km',
  'fuel_hybrid_l_per_100km', 'fuel_petrol_price_aud',
  'myenergi_serial', 'myenergi_api_key', 'myenergi_poll_seconds',
  'melcloud_email', 'melcloud_password',
  'teslamate_database_url',
  'gemini_api_key', 'gemini_model', 'cf_worker_url', 'cf_worker_secret', 'bill_email_local', 'bill_email_domain',
  'mqtt_broker_url', 'mqtt_username', 'mqtt_password',
  'inverter_brand',
  'mqtt_in_broker_url', 'mqtt_in_username', 'mqtt_in_password',
  'mqtt_in_topic_solar', 'mqtt_in_second_type', 'mqtt_in_topic_second',
  'mqtt_in_grid_sign', 'mqtt_in_scale', 'mqtt_in_stale_seconds',
  'solcast_api_key', 'solcast_resource_id',
  'ntfy_base_url', 'ntfy_topic',
  'tesla_battery_kwh', 'soc_floor_pct',
  'openrouter_api_key', 'openrouter_model',
  'anthropic_api_key',
  'fleet_telemetry_hostname', 'fleet_telemetry_port', 'fleet_telemetry_ca_cert',
  'google_calendar_client_id', 'google_calendar_client_secret', 'google_calendar_redirect_uri',
  'outlook_calendar_client_id', 'outlook_calendar_client_secret', 'outlook_calendar_tenant_id',
  'outlook_calendar_redirect_uri',
  'grid_intensity_provider', 'grid_intensity_region', 'watttime_username', 'watttime_password', 'electricitymaps_api_key',
  'ercot_api_username', 'ercot_api_password', 'ercot_settlement_point',
  'battery_brand', 'battery_priority',
  'sigenergy_host', 'sigenergy_port', 'sigenergy_unit_id',
  'sungrow_host', 'sungrow_port', 'sungrow_unit_id',
  'sungrow_max_charge_power_w', 'sungrow_max_discharge_power_w',
  'powerwall_host', 'powerwall_email', 'powerwall_password',
];

// Same convention the dashboard's Grid node uses: a favicon lookup by domain,
// with no local logo assets needed for any retailer. Falls back to a plain
// grey circle (matching the generic icon shown on the dashboard) when blank.
function updateGridRetailerIconPreview() {
  const input = document.getElementById('setting_grid_retailer_domain');
  const preview = document.getElementById('grid-retailer-icon-preview');
  if (!input || !preview) return;
  const domain = input.value.trim();
  preview.src = domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64` : '';
  preview.style.visibility = domain ? 'visible' : 'hidden';
}

async function loadInverterBrands() {
  const select = document.getElementById('setting_inverter_brand');
  if (!select) return;
  try {
    const data = await api('/api/setup/inverter-brands');
    if (!data.ok || !Array.isArray(data.brands)) return;
    select.innerHTML = data.brands.map((b) => `<option value="${b.id}">${b.label}</option>`).join('');
  } catch (_e) {}
}

function _mqttAgeText(ms) {
  if (ms == null) return 'no data yet';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

async function loadMqttStatus() {
  try {
    const data = await api('/api/mqtt/status');
    if (!data.ok) return;

    const out = document.getElementById('mqtt-out-status');
    if (out) {
      if (!data.output.configured) {
        out.textContent = 'Not configured';
        out.style.color = 'var(--text-secondary)';
      } else if (data.output.connected) {
        out.textContent = 'Connected ✓';
        out.style.color = 'var(--accent-solar)';
      } else {
        out.textContent = data.output.lastError ? `Not connected: ${data.output.lastError}` : 'Not connected';
        out.style.color = '#fc814a';
      }
    }

    const inp = document.getElementById('mqtt-in-status');
    if (inp) {
      if (!data.input.configured) {
        inp.textContent = 'Not configured';
        inp.style.color = 'var(--text-secondary)';
      } else if (!data.input.active) {
        inp.textContent = 'Configured, but Data source is not set to MQTT';
        inp.style.color = 'var(--text-secondary)';
      } else if (data.input.connected) {
        inp.textContent = `Connected ✓ (solar ${_mqttAgeText(data.input.solarAgeMs)}, second ${_mqttAgeText(data.input.secondAgeMs)})`;
        inp.style.color = 'var(--accent-solar)';
      } else {
        inp.textContent = 'Not connected';
        inp.style.color = '#fc814a';
      }
    }
  } catch (_e) {}
}

// Saves only the fields relevant to one MQTT direction (not the whole form),
// then runs the corresponding connection test. Mirrors the setup wizard's
// "save first, test-inverter reads from settings" pattern.
async function testMqttOutput() {
  const btn = document.getElementById('mqtt-out-test-btn');
  const result = document.getElementById('mqtt-out-test-result');
  if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
  if (result) { result.textContent = ''; result.style.color = ''; }
  try {
    const body = {
      mqtt_broker_url: document.getElementById('setting_mqtt_broker_url')?.value || '',
      mqtt_username:   document.getElementById('setting_mqtt_username')?.value || '',
    };
    const pw = document.getElementById('setting_mqtt_password')?.value || '';
    if (pw) body.mqtt_password = pw;
    await api('/api/settings', { method: 'POST', body });
    const data = await api('/api/mqtt/test-output', { method: 'POST', body: {} });
    if (result) {
      result.textContent = data.ok ? '✓ Connected' : (data.error || 'Failed');
      result.style.color = data.ok ? 'var(--accent-solar)' : '#fc814a';
    }
    loadMqttStatus();
  } catch (err) {
    if (result) { result.textContent = 'Error: ' + err.message; result.style.color = '#fc814a'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Test Connection'; }
  }
}

// Tests the BLE command proxy for reachability. Sends the current URL field value so it
// works before saving; the endpoint only does a GET to the proxy, never a vehicle command.
async function testBleProxy() {
  const btn = document.getElementById('ble-test-btn');
  const result = document.getElementById('ble-test-result');
  if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
  if (result) { result.textContent = ''; result.style.color = ''; }
  try {
    const url = document.getElementById('setting_tesla_ble_proxy_url')?.value || '';
    const data = await api('/api/tesla/test-ble', { method: 'POST', body: { url } });
    if (result) {
      result.textContent = data.ok ? `✓ Reachable (HTTP ${data.status})` : (data.error || 'Not reachable');
      result.style.color = data.ok ? 'var(--accent-solar)' : '#fc814a';
    }
  } catch (err) {
    if (result) { result.textContent = 'Error: ' + err.message; result.style.color = '#fc814a'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Test Connection'; }
  }
}

async function testMqttInput() {
  const btn = document.getElementById('mqtt-in-test-btn');
  const result = document.getElementById('mqtt-in-test-result');
  if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
  if (result) { result.textContent = ''; result.style.color = ''; }
  try {
    const body = {
      mqtt_in_broker_url:    document.getElementById('setting_mqtt_in_broker_url')?.value || '',
      mqtt_in_username:      document.getElementById('setting_mqtt_in_username')?.value || '',
      mqtt_in_topic_solar:   document.getElementById('setting_mqtt_in_topic_solar')?.value || '',
      mqtt_in_second_type:   document.getElementById('setting_mqtt_in_second_type')?.value || 'grid',
      mqtt_in_topic_second:  document.getElementById('setting_mqtt_in_topic_second')?.value || '',
      mqtt_in_grid_sign:     document.getElementById('setting_mqtt_in_grid_sign')?.value || 'import_positive',
      mqtt_in_scale:         document.getElementById('setting_mqtt_in_scale')?.value || '1',
      mqtt_in_stale_seconds: document.getElementById('setting_mqtt_in_stale_seconds')?.value || '60',
    };
    const pw = document.getElementById('setting_mqtt_in_password')?.value || '';
    if (pw) body.mqtt_in_password = pw;
    await api('/api/settings', { method: 'POST', body });
    const data = await api('/api/setup/test-inverter', { method: 'POST', body: { brand: 'mqtt' } });
    if (result) {
      result.textContent = data.ok ? '✓ Connected' : (data.error || 'Failed');
      result.style.color = data.ok ? 'var(--accent-solar)' : '#fc814a';
    }
    loadMqttStatus();
  } catch (err) {
    if (result) { result.textContent = 'Error: ' + err.message; result.style.color = '#fc814a'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Test Connection'; }
  }
}

async function loadSettings() {
  try {
    await loadInverterBrands();
    const data = await api('/api/settings');
    if (!data.ok) return;
    for (const key of FIELD_IDS) {
      const el = document.getElementById('setting_' + key);
      if (el && data.settings[key] !== undefined) {
        el.value = data.settings[key];
      }
    }
    updateGridRetailerIconPreview();
    const vinDisplay = document.getElementById('tesla-vin-display');
    if (vinDisplay && data.settings.tesla_display_name) {
      vinDisplay.textContent = data.settings.tesla_display_name + ' (' + data.settings.tesla_vin + ')';
    }

    const billIntro = document.getElementById('bill-email-intro');
    const billPreview = document.getElementById('bill-email-preview');
    const billFull = `${data.settings.bill_email_local || 'bills'}@${data.settings.bill_email_domain || 'yourdomain.com'}`;
    if (billIntro) billIntro.textContent = billFull;
    if (billPreview) billPreview.textContent = billFull;

    // Schedule
    const schedToggle = document.getElementById('schedule_enabled');
    if (schedToggle) schedToggle.checked = data.settings.schedule_enabled === 'true';
    try { renderWindows('schedule-windows-list', JSON.parse(data.settings.schedule_windows || '[]')); } catch (_e) {}

    // TOU
    const touToggle = document.getElementById('tou_enabled');
    if (touToggle) touToggle.checked = data.settings.tou_enabled === 'true';
    try { renderWindows('tou-windows-list', JSON.parse(data.settings.tou_windows || '[]')); } catch (_e) {}

    // Update checks (default on when unset)
    const updateToggle = document.getElementById('check_for_updates');
    if (updateToggle) updateToggle.checked = data.settings.check_for_updates !== 'false';

    // Automatic backups (default on when unset)
    const autoBackupToggle = document.getElementById('auto_backup_enabled');
    if (autoBackupToggle) autoBackupToggle.checked = data.settings.auto_backup_enabled !== 'false';
    loadAutoBackupStatus();

    // Electricity rate mode
    const rateModeToggle = document.getElementById('electricity_rate_mode_toggle');
    if (rateModeToggle) rateModeToggle.checked = data.settings.electricity_rate_mode === 'tou';
    toggleRateModeSections();
    loadTouConfigs();
    loadExportConfigs();
    refreshRateTemplatesForCountry(data.settings.country || 'AU');
    applyCountryUI(data.settings.country || 'AU');

    const ercotToggle = document.getElementById('ercot_pricing_enabled_toggle');
    if (ercotToggle) ercotToggle.checked = data.settings.ercot_pricing_enabled === 'true';

    const autoTripToggle = document.getElementById('auto_trip_charging_enabled_toggle');
    if (autoTripToggle) autoTripToggle.checked = data.settings.auto_trip_charging_enabled !== 'false';
  } catch (err) {
    showMessage('error', 'Failed to load settings: ' + err.message);
  }
}

async function saveSettings(e) {
  e.preventDefault();
  const body = {};
  for (const key of FIELD_IDS) {
    const el = document.getElementById('setting_' + key);
    if (el) body[key] = el.value;
  }
  // Schedule + TOU
  const schedToggle = document.getElementById('schedule_enabled');
  if (schedToggle) body.schedule_enabled = schedToggle.checked ? 'true' : 'false';
  body.schedule_windows = JSON.stringify(getWindows('schedule-windows-list'));

  const touToggle = document.getElementById('tou_enabled');
  if (touToggle) body.tou_enabled = touToggle.checked ? 'true' : 'false';
  body.tou_windows = JSON.stringify(getWindows('tou-windows-list'));

  const updateToggle = document.getElementById('check_for_updates');
  if (updateToggle) body.check_for_updates = updateToggle.checked ? 'true' : 'false';

  const autoBackupToggle = document.getElementById('auto_backup_enabled');
  if (autoBackupToggle) body.auto_backup_enabled = autoBackupToggle.checked ? 'true' : 'false';

  const rateModeToggle = document.getElementById('electricity_rate_mode_toggle');
  if (rateModeToggle) body.electricity_rate_mode = rateModeToggle.checked ? 'tou' : 'flat';

  const ercotToggle = document.getElementById('ercot_pricing_enabled_toggle');
  if (ercotToggle) body.ercot_pricing_enabled = ercotToggle.checked ? 'true' : 'false';

  const autoTripToggle = document.getElementById('auto_trip_charging_enabled_toggle');
  if (autoTripToggle) body.auto_trip_charging_enabled = autoTripToggle.checked ? 'true' : 'false';

  try {
    const data = await api('/api/settings', { method: 'POST', body });
    if (data.ok) {
      showMessage('success', 'Settings saved.');
      // Refresh the Solcast badge immediately so the user sees the new status
      const badge = document.getElementById('solcast-status-badge');
      if (badge) {
        if (body.solcast_api_key && body.solcast_resource_id) {
          badge.textContent = 'Configured ✓';
          badge.style.color = 'var(--accent-solar)';
        } else {
          badge.textContent = 'Not configured';
          badge.style.color = 'var(--text-secondary)';
        }
      }
      toggleRateModeSections();
      loadTouConfigs();
      loadRates();
      loadAutoBackupStatus();
      loadMqttStatus();
    } else {
      showMessage('error', data.error || 'Save failed.');
    }
  } catch (err) {
    showMessage('error', 'Save failed: ' + err.message);
  }
}

async function regenEnphaseToken() {
  const email = document.getElementById('setting_enphase_email')?.value || prompt('Enphase account email:');
  if (!email) return;
  const password = prompt('Enphase account password (not stored):');
  if (!password) return;
  const serial = document.getElementById('setting_enphase_serial')?.value;
  if (!serial) { showMessage('error', 'Serial number required'); return; }
  const ip = document.getElementById('setting_gateway_ip')?.value;

  showMessage('info', 'Generating token…');
  try {
    const data = await api('/api/setup/generate-token', {
      method: 'POST',
      body: { email, password, serial, ip },
    });
    if (data.ok) {
      showMessage('success', 'Token generated, expires: ' + new Date(data.expiresAt).toLocaleDateString());
    } else {
      showMessage('error', data.error || 'Token generation failed');
    }
  } catch (err) {
    showMessage('error', 'Error: ' + err.message);
  }
}

async function resetAll() {
  if (!confirm('Are you sure you want to reset all settings and return to setup? This cannot be undone.')) return;
  if (!confirm('Really reset everything? Your Tesla and Enphase credentials will be cleared.')) return;
  try {
    await api('/api/settings', {
      method: 'POST',
      body: { setup_complete: 'false' },
    });
    window.location.href = '/setup';
  } catch (err) {
    showMessage('error', 'Reset failed: ' + err.message);
  }
}

function showMessage(type, text) {
  const el = document.getElementById('settings-message');
  if (!el) return;
  el.className = `alert alert-${type}`;
  el.textContent = text;
  el.classList.remove('hidden');
  if (type === 'success') {
    setTimeout(() => el.classList.add('hidden'), 4000);
  }
}

async function useCarLocation() {
  const btn = document.getElementById('use-car-location-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Fetching…'; }
  showLocationMessage('info', 'Fetching car GPS - car must be awake…');
  try {
    const data = await api('/api/location/set-home', { method: 'POST', body: {} });
    if (data.ok) {
      const latEl = document.getElementById('setting_home_latitude');
      const lonEl = document.getElementById('setting_home_longitude');
      if (latEl) latEl.value = data.lat.toFixed(6);
      if (lonEl) lonEl.value = data.lon.toFixed(6);
      showLocationMessage('success', `Home set to ${data.lat.toFixed(5)}, ${data.lon.toFixed(5)}`);
      // Also persist immediately
      await api('/api/settings', { method: 'POST', body: { home_latitude: String(data.lat), home_longitude: String(data.lon) } });
    } else {
      showLocationMessage('error', data.error || 'Could not get GPS from car');
    }
  } catch (err) {
    showLocationMessage('error', 'Error: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Use car\'s current location'; }
  }
}

function showLocationMessage(type, text) {
  const el = document.getElementById('location-message');
  if (!el) return;
  el.className = `alert alert-${type}`;
  el.textContent = text;
  el.classList.remove('hidden');
  if (type === 'success') setTimeout(() => el.classList.add('hidden'), 5000);
}

// ─── Electricity Rate History ───

async function loadRates() {
  try {
    const data = await api('/api/rates');
    if (!data.ok) return;

    const rates = data.rates; // DESC by effective_from

    const isTou = document.getElementById('electricity_rate_mode_toggle')?.checked;
    const badge = document.getElementById('current-rate-badge');
    if (badge && rates.length > 0 && !isTou) {
      badge.textContent = `$${parseFloat(rates[0].rate_aud).toFixed(2)} / kWh`;
    }

    // Default date input to today
    const dateInput = document.getElementById('new-rate-date');
    if (dateInput && !dateInput.value) {
      dateInput.value = new Date().toISOString().slice(0, 10);
    }

    const tbody = document.getElementById('rates-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    for (const r of rates) {
      const isInitial = r.effective_from === 0;
      const dateStr = isInitial
        ? 'Initial (all prior data)'
        : new Date(r.effective_from).toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' });

      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid var(--border)';
      tr.innerHTML = `
        <td style="padding:0.35rem 0.5rem">${dateStr}</td>
        <td style="text-align:right;padding:0.35rem 0.5rem;font-family:'JetBrains Mono',monospace;font-weight:600">$${parseFloat(r.rate_aud).toFixed(2)}</td>
        <td style="text-align:right;padding:0.35rem 0.25rem">
          ${rates.length > 1 ? `<button class="window-remove rate-del" data-id="${r.id}" title="Remove">×</button>` : ''}
        </td>
      `;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll('.rate-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this rate entry?')) return;
        const res = await api(`/api/rates/${btn.dataset.id}`, { method: 'DELETE' });
        if (res.ok) loadRates();
        else showRateMessage('error', res.error || 'Delete failed');
      });
    });
  } catch (err) {
    console.error('[settings] loadRates error:', err);
  }
}

async function submitAddRate() {
  const dateInput  = document.getElementById('new-rate-date');
  const rateInput  = document.getElementById('new-rate-value');
  if (!dateInput?.value || !rateInput?.value) {
    showRateMessage('error', 'Both date and rate are required');
    return;
  }
  // Parse as local midnight to avoid UTC-offset surprises
  const [y, m, d] = dateInput.value.split('-').map(Number);
  const effectiveFrom = new Date(y, m - 1, d).getTime();
  const rate_aud = parseFloat(rateInput.value);

  const res = await api('/api/rates', { method: 'POST', body: { rate_aud, effective_from: effectiveFrom } });
  if (res.ok) {
    rateInput.value = '';
    showRateMessage('success', 'Rate added');
    loadRates();
  } else {
    showRateMessage('error', res.error || 'Failed to add rate');
  }
}

function showRateMessage(type, text) {
  const el = document.getElementById('rate-message');
  if (!el) return;
  el.className = `alert alert-${type}`;
  el.textContent = text;
  el.classList.remove('hidden');
  if (type === 'success') setTimeout(() => el.classList.add('hidden'), 3000);
}

// ─── Automatic backups ───

async function loadAutoBackupStatus() {
  const el = document.getElementById('auto-backup-status');
  if (!el) return;
  try {
    const data = await api('/api/backup/auto-status');
    if (!data.ok) { el.textContent = '-'; return; }
    if (data.count === 0) {
      el.textContent = data.enabled ? 'No automatic backup yet - one will run within the next 24 hours.' : 'Automatic backups are off.';
      return;
    }
    const sizeMb = (data.totalSizeBytes / (1024 * 1024)).toFixed(1);
    el.textContent = `Last backup: ${timeAgo(data.lastBackupAt)} · ${data.count} kept · ${sizeMb} MB total`;
  } catch (err) {
    el.textContent = '-';
    console.error('[settings] loadAutoBackupStatus error:', err);
  }
}

// ─── Encrypted backup download ───

async function downloadEncryptedBackup() {
  const passwordInput = document.getElementById('backup-password');
  const statusEl = document.getElementById('backup-encrypted-status');
  const btn = document.getElementById('backup-download-encrypted');
  const password = passwordInput?.value || '';

  if (!password) {
    if (statusEl) { statusEl.textContent = 'Enter a password first, or use the plain "Download Backup" button above.'; statusEl.style.color = 'var(--accent-import)'; }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
  if (statusEl) { statusEl.textContent = ''; }

  try {
    const res = await fetch('/api/backup/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : 'wattsnatch-backup.zip.enc';

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    if (passwordInput) passwordInput.value = '';
    if (statusEl) { statusEl.textContent = `Downloaded ${filename}. Keep the password somewhere safe - it can't be recovered.`; statusEl.style.color = 'var(--text-secondary)'; }
  } catch (err) {
    if (statusEl) { statusEl.textContent = `Failed: ${err.message}`; statusEl.style.color = 'var(--accent-import)'; }
    console.error('[settings] downloadEncryptedBackup error:', err);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Download Encrypted'; }
  }
}

// ─── Time-of-use rate cards ───

function toggleRateModeSections() {
  const isTou = document.getElementById('electricity_rate_mode_toggle')?.checked;
  const flatSection = document.getElementById('flat-rate-section');
  const touSection  = document.getElementById('tou-rate-section');
  if (flatSection) flatSection.style.display = isTou ? 'none' : '';
  if (touSection)  touSection.style.display  = isTou ? '' : 'none';
}

// Same window shape/logic as the day-picker used elsewhere, plus a label and
// its own rate - a TOU billing window needs both, unlike the plain
// schedule/peak-block windows which only gate on time.
function makeTouBillingWindowRow(w) {
  const row = document.createElement('div');
  row.className = 'window-row';

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.placeholder = 'Peak';
  labelInput.value = w.label || '';
  labelInput.style.cssText = 'width:90px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:0.8rem;padding:0.3rem 0.5rem';

  const rateInput = document.createElement('input');
  rateInput.type = 'number';
  rateInput.min = '0.01'; rateInput.max = '5'; rateInput.step = '0.01';
  rateInput.placeholder = '0.45';
  rateInput.value = w.rate_aud != null ? w.rate_aud : '';
  rateInput.style.cssText = 'width:80px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:0.8rem;padding:0.3rem 0.5rem';

  const daysDiv = document.createElement('div');
  daysDiv.className = 'window-days';
  const dayState = w.days || [];
  for (let i = 0; i < 7; i++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day-btn' + (dayState.includes(i) ? ' active' : '');
    btn.textContent = DAY_LABELS[i];
    btn.dataset.day = i;
    btn.addEventListener('click', () => btn.classList.toggle('active'));
    daysDiv.appendChild(btn);
  }

  const timeDiv = document.createElement('div');
  timeDiv.className = 'window-time';
  const startInput = document.createElement('input');
  startInput.type = 'time';
  startInput.value = w.start_time || '14:00';
  const arrow = document.createElement('span');
  arrow.textContent = '→';
  const endInput = document.createElement('input');
  endInput.type = 'time';
  endInput.value = w.end_time || '20:00';
  timeDiv.appendChild(startInput);
  timeDiv.appendChild(arrow);
  timeDiv.appendChild(endInput);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'window-remove';
  removeBtn.title = 'Remove';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => { row.remove(); });

  row.appendChild(labelInput);
  row.appendChild(rateInput);
  row.appendChild(daysDiv);
  row.appendChild(timeDiv);
  row.appendChild(removeBtn);

  row._getWindow = () => ({
    label: labelInput.value.trim(),
    rate_aud: parseFloat(rateInput.value),
    days: [...daysDiv.querySelectorAll('.day-btn.active')].map(b => parseInt(b.dataset.day, 10)),
    start_time: startInput.value,
    end_time: endInput.value,
  });

  return row;
}

function getTouEditorWindows() {
  const list = document.getElementById('tou-windows-editor-list');
  if (!list) return [];
  return [...list.querySelectorAll('.window-row')].map(r => r._getWindow());
}

// Mirrors the server's _matchTouWindow() so the badge can show what's active
// right now without an extra round-trip.
function _matchTouWindowClientSide(config, now) {
  const day = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  for (const w of config.windows) {
    if (!w.days.includes(day)) continue;
    const [sh, sm] = w.start_time.split(':').map(Number);
    const [eh, em] = w.end_time.split(':').map(Number);
    const s = sh * 60 + sm, e = eh * 60 + em;
    const inWindow = s > e ? (minutes >= s || minutes < e) : (minutes >= s && minutes < e);
    if (inWindow) return { label: w.label, rate: w.rate_aud };
  }
  return { label: 'Default', rate: config.default_rate_aud };
}

async function loadTouConfigs() {
  try {
    const data = await api('/api/tou-rates');
    if (!data.ok) return;
    const configs = data.configs; // DESC by effective_from

    const isTou = document.getElementById('electricity_rate_mode_toggle')?.checked;
    const badge = document.getElementById('current-rate-badge');
    if (badge && isTou) {
      const active = configs.find(c => c.effective_from <= Date.now());
      if (active) {
        const match = _matchTouWindowClientSide(active, new Date());
        badge.textContent = `${match.label}: $${parseFloat(match.rate).toFixed(2)} / kWh`;
      } else {
        badge.textContent = 'No TOU rate card yet';
      }
    }

    const dateInput = document.getElementById('new-tou-date');
    if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);

    const tbody = document.getElementById('tou-configs-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    for (const c of configs) {
      const isInitial = c.effective_from === 0;
      const dateStr = isInitial
        ? 'Initial (all prior data)'
        : new Date(c.effective_from).toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' });
      const windowsSummary = c.windows.map(w => `${w.label} $${parseFloat(w.rate_aud).toFixed(2)}`).join(', ');

      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid var(--border)';
      tr.innerHTML = `
        <td style="padding:0.35rem 0.5rem">${dateStr}</td>
        <td style="padding:0.35rem 0.5rem;color:var(--text-secondary)">${windowsSummary}</td>
        <td style="text-align:right;padding:0.35rem 0.5rem;font-family:'JetBrains Mono',monospace;font-weight:600">$${parseFloat(c.default_rate_aud).toFixed(2)}</td>
        <td style="text-align:right;padding:0.35rem 0.25rem">
          <button class="window-remove tou-config-del" data-id="${c.id}" title="Remove">×</button>
        </td>
      `;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('.tou-config-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this TOU rate card?')) return;
        const res = await api(`/api/tou-rates/${btn.dataset.id}`, { method: 'DELETE' });
        if (res.ok) loadTouConfigs();
        else showTouMessage('error', res.error || 'Delete failed');
      });
    });
  } catch (err) {
    console.error('[settings] loadTouConfigs error:', err);
  }
}

// Read-only summary of export/feed-in TOU configs (populated by applying a
// rate template - see refreshRateTemplatesForCountry/applyRateTemplate).
async function loadExportConfigs() {
  try {
    const data = await api('/api/export-rate-configs');
    if (!data.ok) return;
    const configs = data.configs;
    const tbody = document.getElementById('export-configs-tbody');
    const empty = document.getElementById('export-config-empty');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (configs.length === 0) {
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';
    for (const c of configs) {
      const isInitial = c.effective_from === 0;
      const dateStr = isInitial
        ? 'Initial (all prior data)'
        : new Date(c.effective_from).toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' });
      const windowsSummary = c.windows.map(w => `${w.label} $${parseFloat(w.rate_aud).toFixed(2)}`).join(', ');
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid var(--border)';
      tr.innerHTML = `
        <td style="padding:0.35rem 0.5rem">${dateStr}</td>
        <td style="padding:0.35rem 0.5rem;color:var(--text-secondary)">${windowsSummary}</td>
        <td style="text-align:right;padding:0.35rem 0.5rem;font-family:'JetBrains Mono',monospace;font-weight:600">$${parseFloat(c.default_rate_aud).toFixed(2)}</td>
        <td style="text-align:right;padding:0.35rem 0.25rem">
          <button class="window-remove export-config-del" data-id="${c.id}" title="Remove">×</button>
        </td>
      `;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('.export-config-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this export rate card?')) return;
        const res = await api(`/api/export-rate-configs/${btn.dataset.id}`, { method: 'DELETE' });
        if (res.ok) loadExportConfigs();
      });
    });
  } catch (err) {
    console.error('[settings] loadExportConfigs error:', err);
  }
}

// Populates the rate-template picker for the given country, and shows/hides
// the whole section (nothing to show for AU today - templates are US-only
// so far). Called on load and whenever the Country select changes.
async function refreshRateTemplatesForCountry(country) {
  const section = document.getElementById('rate-template-section');
  const select = document.getElementById('rate-template-select');
  const note = document.getElementById('rate-template-note');
  if (!section || !select) return;
  try {
    const data = await api(`/api/rate-templates?country=${encodeURIComponent(country)}`);
    const templates = (data.ok && data.templates) || [];
    if (templates.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = 'block';
    select.innerHTML = templates.map(t => `<option value="${t.id}">${t.label}</option>`).join('');
    const updateNote = () => {
      const t = templates.find(t => t.id === select.value);
      if (note) note.textContent = t ? t.sourceNote : '';
    };
    select.onchange = updateNote;
    updateNote();
  } catch (err) {
    console.error('[settings] refreshRateTemplatesForCountry error:', err);
  }
}

async function applyRateTemplate() {
  const select = document.getElementById('rate-template-select');
  const msgEl = document.getElementById('rate-template-message');
  if (!select || !select.value) return;
  try {
    const data = await api(`/api/rate-templates/${select.value}/apply`, { method: 'POST' });
    if (data.ok) {
      if (msgEl) { msgEl.className = 'alert alert-success'; msgEl.textContent = 'Template applied - review the rate cards above, and hand-edit if needed.'; }
      // Template application also flips electricity_rate_mode/export_rate_mode
      // server-side, so re-fetch settings to reflect that in the toggle + tables.
      loadSettings();
    } else if (msgEl) {
      msgEl.className = 'alert alert-error';
      msgEl.textContent = data.error || 'Failed to apply template';
    }
  } catch (err) {
    if (msgEl) { msgEl.className = 'alert alert-error'; msgEl.textContent = err.message; }
  }
}

async function submitAddTouConfig() {
  const dateInput = document.getElementById('new-tou-date');
  const defaultRateInput = document.getElementById('new-tou-default-rate');
  const windows = getTouEditorWindows();

  if (!dateInput?.value || !defaultRateInput?.value) {
    showTouMessage('error', 'Effective date and default rate are required');
    return;
  }
  if (windows.length === 0) {
    showTouMessage('error', 'Add at least one rate window');
    return;
  }
  for (const w of windows) {
    if (!w.label || isNaN(w.rate_aud) || w.days.length === 0) {
      showTouMessage('error', 'Every window needs a label, a rate, and at least one day selected');
      return;
    }
  }

  const [y, m, d] = dateInput.value.split('-').map(Number);
  const effective_from = new Date(y, m - 1, d).getTime();
  const default_rate_aud = parseFloat(defaultRateInput.value);

  const res = await api('/api/tou-rates', { method: 'POST', body: { default_rate_aud, effective_from, windows } });
  if (res.ok) {
    defaultRateInput.value = '';
    document.getElementById('tou-windows-editor-list').innerHTML = '';
    showTouMessage('success', 'Rate card saved');
    loadTouConfigs();
  } else {
    showTouMessage('error', res.error || 'Failed to save rate card');
  }
}

function showTouMessage(type, text) {
  const el = document.getElementById('tou-message');
  if (!el) return;
  el.className = `alert alert-${type}`;
  el.textContent = text;
  el.classList.remove('hidden');
  if (type === 'success') setTimeout(() => el.classList.add('hidden'), 3000);
}

// ── Tariff history ────────────────────────────────────────────────────────────

async function loadTariffs() {
  try {
    const data = await api('/api/tariffs');
    if (!data.ok) return;

    const feedIns      = data.tariffs.filter(t => t.type === 'feed_in');
    const supplys      = data.tariffs.filter(t => t.type === 'supply_charge');

    const fiBadge = document.getElementById('current-feed-in-badge');
    if (fiBadge && feedIns.length) fiBadge.textContent = `$${parseFloat(feedIns[0].rate_aud).toFixed(2)} / kWh`;

    const supBadge = document.getElementById('current-supply-badge');
    if (supBadge && supplys.length) supBadge.textContent = `$${parseFloat(supplys[0].rate_aud).toFixed(2)} / day`;

    // Default date inputs to today
    for (const id of ['new-feed-in-date', 'new-supply-date']) {
      const el = document.getElementById(id);
      if (el && !el.value) el.value = new Date().toISOString().slice(0, 10);
    }

    renderTariffTable('feed-in-tbody', feedIns, 'feed_in', data.tariffs);
    renderTariffTable('supply-tbody', supplys, 'supply_charge', data.tariffs);
  } catch (err) {
    console.error('[settings] loadTariffs error:', err);
  }
}

function renderTariffTable(tbodyId, rows, type, allTariffs) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.innerHTML = '';
  const sameType = allTariffs.filter(t => t.type === type);

  for (const r of rows) {
    const isInitial = r.effective_from === 0;
    const dateStr = isInitial
      ? 'Initial (all prior data)'
      : new Date(r.effective_from).toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' });

    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border)';
    tr.innerHTML = `
      <td style="padding:0.35rem 0.5rem">${dateStr}</td>
      <td style="text-align:right;padding:0.35rem 0.5rem;font-family:'JetBrains Mono',monospace;font-weight:600">$${parseFloat(r.rate_aud).toFixed(2)}</td>
      <td style="text-align:right;padding:0.35rem 0.25rem">
        ${sameType.length > 1 ? `<button class="window-remove tariff-del" data-id="${r.id}" title="Remove">×</button>` : ''}
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.tariff-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this tariff entry?')) return;
      const res = await api(`/api/tariffs/${btn.dataset.id}`, { method: 'DELETE' });
      if (res.ok) loadTariffs();
      else showTariffMessage(type, 'error', res.error || 'Delete failed');
    });
  });
}

async function submitAddTariff(type) {
  const dateId  = type === 'feed_in' ? 'new-feed-in-date'  : 'new-supply-date';
  const valueId = type === 'feed_in' ? 'new-feed-in-value' : 'new-supply-value';
  const dateInput  = document.getElementById(dateId);
  const valueInput = document.getElementById(valueId);

  if (!dateInput?.value) {
    showTariffMessage(type, 'error', 'Effective date is required');
    return;
  }
  if (!valueInput?.value) {
    showTariffMessage(type, 'error', 'Rate is required');
    return;
  }

  const [y, m, d] = dateInput.value.split('-').map(Number);
  const effectiveFrom = new Date(y, m - 1, d).getTime();
  const rate_aud = parseFloat(valueInput.value);

  if (isNaN(rate_aud)) {
    showTariffMessage(type, 'error', 'Invalid rate value');
    return;
  }

  try {
    const res = await api('/api/tariffs', { method: 'POST', body: { type, rate_aud, effective_from: effectiveFrom } });
    if (res.ok) {
      valueInput.value = '';
      showTariffMessage(type, 'success', 'Added');
      loadTariffs();
    } else {
      showTariffMessage(type, 'error', res.error || 'Failed to add');
    }
  } catch (err) {
    showTariffMessage(type, 'error', 'Request failed: ' + err.message);
  }
}

function showTariffMessage(type, level, text) {
  const id = type === 'feed_in' ? 'feed-in-message' : 'supply-message';
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `alert alert-${level}`;
  el.textContent = text;
  el.classList.remove('hidden');
  if (level === 'success') setTimeout(() => el.classList.add('hidden'), 3000);
}

// Echo every date picker's value back in an unambiguous long form.
//
// A native <input type="date"> renders in the BROWSER's locale, not the page's
// - there is no HTML, CSS or JS way to change that. So a UK/AU user whose
// browser is set to en-US sees 1 July 2026 as "07/01/26" and cannot tell
// whether the app understood it as January or July. Rather than replace the
// native picker (which is accessible, keyboard-friendly and works on mobile),
// we show what was actually selected in a form no locale can misread.
function wireDateEchoes(root = document) {
  for (const input of root.querySelectorAll('input[type="date"]')) {
    if (input.dataset.echoWired) continue;
    input.dataset.echoWired = '1';

    const echo = document.createElement('div');
    echo.className = 'date-echo';
    input.insertAdjacentElement('afterend', echo);

    const render = () => {
      if (!input.value) { echo.textContent = ''; return; }
      // Parsed as local, not UTC - `new Date('2026-07-01')` is UTC midnight and
      // renders as the previous day for anyone west of Greenwich.
      const [y, m, d] = input.value.split('-').map(Number);
      if (!y || !m || !d) { echo.textContent = ''; return; }
      echo.textContent = new Date(y, m - 1, d).toLocaleDateString('en-AU', {
        day: 'numeric', month: 'long', year: 'numeric',
      });
    };

    input.addEventListener('input', render);
    input.addEventListener('change', render);
    render();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  loadRates();
  loadTariffs();
  loadMqttStatus();
  wireDateEchoes();

  document.getElementById('mqtt-out-test-btn')?.addEventListener('click', testMqttOutput);
  document.getElementById('mqtt-in-test-btn')?.addEventListener('click', testMqttInput);
  document.getElementById('ble-test-btn')?.addEventListener('click', testBleProxy);
  document.getElementById('setting_grid_retailer_domain')?.addEventListener('input', updateGridRetailerIconPreview);

  const form = document.getElementById('settings-form');
  if (form) form.addEventListener('submit', saveSettings);

  const regenBtn = document.getElementById('regen-enphase-btn');
  if (regenBtn) regenBtn.addEventListener('click', regenEnphaseToken);

  const reAuthBtn = document.getElementById('reauth-tesla-btn');
  if (reAuthBtn) reAuthBtn.addEventListener('click', () => { window.location.href = '/auth/tesla/start'; });

  const resetBtn = document.getElementById('reset-btn');
  if (resetBtn) resetBtn.addEventListener('click', resetAll);

  const carLocBtn = document.getElementById('use-car-location-btn');
  if (carLocBtn) carLocBtn.addEventListener('click', useCarLocation);

  document.getElementById('ha-link-key-generate-btn')?.addEventListener('click', () => {
    const input = document.getElementById('setting_ha_link_key');
    if (!input) return;
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    input.value = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  });

  document.getElementById('setting_country')?.addEventListener('change', (e) => {
    if (typeof refreshRateTemplatesForCountry === 'function') refreshRateTemplatesForCountry(e.target.value);
    applyCountryUI(e.target.value);
  });
  document.getElementById('rate-template-apply-btn')?.addEventListener('click', applyRateTemplate);

  document.getElementById('backup-download-encrypted')?.addEventListener('click', downloadEncryptedBackup);

  document.getElementById('add-feed-in-btn')?.addEventListener('click', () => submitAddTariff('feed_in'));
  document.getElementById('add-supply-btn')?.addEventListener('click', () => submitAddTariff('supply_charge'));

  const addRateBtn = document.getElementById('add-rate-btn');
  if (addRateBtn) addRateBtn.addEventListener('click', submitAddRate);

  const rateModeToggle = document.getElementById('electricity_rate_mode_toggle');
  if (rateModeToggle) rateModeToggle.addEventListener('change', toggleRateModeSections);

  const addTouWindowRowBtn = document.getElementById('add-tou-window-row');
  if (addTouWindowRowBtn) {
    addTouWindowRowBtn.addEventListener('click', () => {
      const list = document.getElementById('tou-windows-editor-list');
      if (list) list.appendChild(makeTouBillingWindowRow({ days: [1,2,3,4,5], start_time: '14:00', end_time: '20:00' }));
    });
  }

  const addTouConfigBtn = document.getElementById('add-tou-config-btn');
  if (addTouConfigBtn) addTouConfigBtn.addEventListener('click', submitAddTouConfig);

  // Schedule window builder
  const addSchedBtn = document.getElementById('add-schedule-window');
  if (addSchedBtn) {
    addSchedBtn.addEventListener('click', () => {
      const list = document.getElementById('schedule-windows-list');
      if (list) list.appendChild(makeWindowRow({ days: [0,1,2,3,4,5,6], start: '22:00', end: '07:00' }));
    });
  }

  // TOU window builder
  const addTouBtn = document.getElementById('add-tou-window');
  if (addTouBtn) {
    addTouBtn.addEventListener('click', () => {
      const list = document.getElementById('tou-windows-list');
      if (list) list.appendChild(makeWindowRow({ days: [1,2,3,4,5], start: '07:00', end: '21:00' }));
    });
  }

  // ─── Bill email preview ────────────────────────────────────────────────────
  const billLocalInput  = document.getElementById('setting_bill_email_local');
  const billDomainInput = document.getElementById('setting_bill_email_domain');
  const billPreview     = document.getElementById('bill-email-preview');
  const billIntro       = document.getElementById('bill-email-intro');
  function updateBillEmailPreview() {
    const local  = billLocalInput?.value?.trim()  || 'bills';
    const domain = billDomainInput?.value?.trim() || 'yourdomain.com';
    const full = `${local}@${domain}`;
    if (billPreview) billPreview.textContent = full;
    if (billIntro) billIntro.textContent = full;
  }
  if (billLocalInput)  billLocalInput.addEventListener('input', updateBillEmailPreview);
  if (billDomainInput) billDomainInput.addEventListener('input', updateBillEmailPreview);

  // ─── Eddi CSV import ───────────────────────────────────────────────────────
  const csvInput     = document.getElementById('eddi-csv-input');
  const csvFilename  = document.getElementById('eddi-csv-filename');
  const csvImportBtn = document.getElementById('eddi-csv-import-btn');
  const csvResult    = document.getElementById('eddi-csv-result');
  let   csvText      = null;

  if (csvInput) {
    csvInput.addEventListener('change', () => {
      const file = csvInput.files[0];
      if (!file) return;
      csvFilename.textContent = file.name;
      const reader = new FileReader();
      reader.onload = (e) => {
        csvText = e.target.result;
        csvImportBtn.disabled = false;
      };
      reader.readAsText(file);
    });
  }

  if (csvImportBtn) {
    csvImportBtn.addEventListener('click', async () => {
      if (!csvText) return;
      csvImportBtn.disabled = true;
      csvImportBtn.textContent = 'Importing…';
      csvResult.className = 'alert hidden';

      try {
        const data = await api('/api/import/eddi-csv', {
          method: 'POST',
          body: { csv: csvText },
        });
        if (data.ok) {
          csvResult.className = 'alert alert-success';
          csvResult.textContent =
            `✓ Imported ${data.imported} day${data.imported !== 1 ? 's' : ''} of hot water data` +
            (data.skipped > 0 ? ` (${data.skipped} already existed, skipped)` : '');
        } else {
          csvResult.className = 'alert alert-error';
          csvResult.textContent = 'Import failed: ' + (data.error || 'Unknown error');
        }
      } catch (err) {
        csvResult.className = 'alert alert-error';
        csvResult.textContent = 'Import failed: ' + err.message;
      }

      csvImportBtn.textContent = 'Import';
      csvImportBtn.disabled = false;
    });
  }

  // ─── Air conditioning (MELCloud / MelView) ─────────────────────────────────
  // Two genuinely separate Mitsubishi cloud platforms, same credential shape -
  // one email/password form, routed to whichever platform is selected.
  const acBrandSelect = document.getElementById('setting_ac_brand');
  const acBrandNote = document.getElementById('ac-brand-note');
  const melcloudEmailInput = document.getElementById('setting_melcloud_email');
  const melcloudPassInput = document.getElementById('setting_melcloud_password');
  const melcloudTestBtn = document.getElementById('melcloud-test-btn');
  const melcloudSaveBtn = document.getElementById('melcloud-save-btn');
  const melcloudMessage = document.getElementById('melcloud-message');
  const melcloudDevices = document.getElementById('melcloud-devices');
  const melcloudDevicesList = document.getElementById('melcloud-devices-list');
  const melcloudStatusBadge = document.getElementById('melcloud-status-badge');

  const AC_BRAND_NOTES = {
    melcloud: 'Monitors power state, mode, temperature, and energy use.',
    melview: 'Monitors power state, mode, and temperature - MelView’s API has no energy/power consumption field, so a wattage reading will never appear for this platform.',
  };

  function acRoutePrefix() {
    return acBrandSelect && acBrandSelect.value === 'melview' ? 'melview' : 'melcloud';
  }

  if (acBrandSelect) {
    acBrandSelect.addEventListener('change', () => {
      if (acBrandNote) acBrandNote.textContent = AC_BRAND_NOTES[acBrandSelect.value] || '';
      loadMelcloudStatus();
    });
  }

  // Load AC status on page load, for whichever platform is currently active
  async function loadMelcloudStatus() {
    try {
      const data = await api(`/api/setup/${acRoutePrefix()}-status`);
      if (data.ok && data.configured) {
        melcloudStatusBadge.textContent = `${data.deviceCount} device${data.deviceCount !== 1 ? 's' : ''} connected`;
        melcloudStatusBadge.style.color = 'var(--accent-solar)';
        if (data.devices && data.devices.length > 0) {
          const deviceText = data.devices.map(d => `${d.name} (${d.mode})`).join(', ');
          melcloudDevicesList.textContent = deviceText;
          melcloudDevices.style.display = 'block';
        }
      } else {
        melcloudStatusBadge.textContent = 'Not configured';
        melcloudStatusBadge.style.color = 'var(--text-secondary)';
      }
    } catch (err) {
      console.log('MELCloud status load failed:', err.message);
    }
  }

  if (melcloudTestBtn) {
    melcloudTestBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const email = melcloudEmailInput?.value?.trim();
      const password = melcloudPassInput?.value?.trim();

      if (!email || !password) {
        melcloudMessage.className = 'alert alert-error';
        melcloudMessage.textContent = 'Email and password are required';
        return;
      }

      melcloudTestBtn.disabled = true;
      melcloudTestBtn.textContent = 'Testing…';
      melcloudMessage.className = 'alert hidden';

      try {
        const data = await api(`/api/setup/${acRoutePrefix()}-credentials`, {
          method: 'POST',
          body: { email, password },
        });
        if (data.ok) {
          melcloudMessage.className = 'alert alert-success';
          melcloudMessage.textContent = '✓ Connection successful! Credentials saved.';
          await loadMelcloudStatus();
        } else {
          melcloudMessage.className = 'alert alert-error';
          melcloudMessage.textContent = 'Connection failed: ' + (data.error || 'Unknown error');
        }
      } catch (err) {
        melcloudMessage.className = 'alert alert-error';
        melcloudMessage.textContent = 'Connection failed: ' + err.message;
      }

      melcloudTestBtn.disabled = false;
      melcloudTestBtn.textContent = 'Test Connection';
    });
  }

  if (melcloudSaveBtn) {
    melcloudSaveBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const email = melcloudEmailInput?.value?.trim();
      const password = melcloudPassInput?.value?.trim();

      if (!email || !password) {
        melcloudMessage.className = 'alert alert-error';
        melcloudMessage.textContent = 'Email and password are required';
        return;
      }

      melcloudSaveBtn.disabled = true;
      melcloudSaveBtn.textContent = 'Saving…';
      melcloudMessage.className = 'alert hidden';

      try {
        const data = await api(`/api/setup/${acRoutePrefix()}-credentials`, {
          method: 'POST',
          body: { email, password },
        });
        if (data.ok) {
          melcloudMessage.className = 'alert alert-success';
          melcloudMessage.textContent = '✓ Credentials saved successfully!';
          await loadMelcloudStatus();
          // Clear the password field for security
          melcloudPassInput.value = '';
        } else {
          melcloudMessage.className = 'alert alert-error';
          melcloudMessage.textContent = 'Save failed: ' + (data.error || 'Unknown error');
        }
      } catch (err) {
        melcloudMessage.className = 'alert alert-error';
        melcloudMessage.textContent = 'Save failed: ' + err.message;
      }

      melcloudSaveBtn.disabled = false;
      melcloudSaveBtn.textContent = 'Save Credentials';
    });
  }

  // Set the brand selector to whatever's actually configured, then load that
  // platform's status - loadMelcloudStatus() reads acBrandSelect.value, so
  // this must happen before the initial call.
  (async () => {
    try {
      const data = await api('/api/settings');
      if (data.ok && acBrandSelect) {
        const brand = data.settings.ac_brand || 'melcloud';
        acBrandSelect.value = brand;
        if (acBrandNote) acBrandNote.textContent = AC_BRAND_NOTES[brand] || '';
      }
    } catch (_e) {}
    loadMelcloudStatus();
  })();

  // ─── TeslaMate ────────────────────────────────────────────────────────────
  const tmTestBtn    = document.getElementById('teslamate-test-btn');
  const tmSyncBtn    = document.getElementById('teslamate-sync-btn');
  const tmMessage    = document.getElementById('teslamate-message');
  const tmBadge      = document.getElementById('teslamate-status-badge');
  const tmUrlInput   = document.getElementById('setting_teslamate_database_url');

  function showTmMessage(type, text) {
    if (!tmMessage) return;
    tmMessage.className = `alert alert-${type}`;
    tmMessage.textContent = text;
    tmMessage.classList.remove('hidden');
    if (type === 'success') setTimeout(() => tmMessage.classList.add('hidden'), 5000);
  }

  if (tmTestBtn) {
    tmTestBtn.addEventListener('click', async () => {
      const url = tmUrlInput?.value?.trim();
      if (url) {
        await api('/api/settings', { method: 'POST', body: { teslamate_database_url: url } });
      }
      tmTestBtn.disabled = true;
      tmTestBtn.textContent = 'Testing…';
      try {
        const data = await api('/api/teslamate/test', { method: 'POST' });
        if (data.ok) {
          showTmMessage('success', `✓ Connected - ${data.drive_count} drives found`);
          if (tmBadge) { tmBadge.textContent = 'Connected'; tmBadge.style.color = 'var(--accent-solar)'; }
        } else {
          showTmMessage('error', 'Connection failed: ' + (data.error || 'Unknown error'));
          if (tmBadge) { tmBadge.textContent = 'Error'; tmBadge.style.color = 'var(--accent-error, #fc814a)'; }
        }
      } catch (err) {
        showTmMessage('error', 'Error: ' + err.message);
      }
      tmTestBtn.disabled = false;
      tmTestBtn.textContent = 'Test Connection';
    });
  }

  if (tmSyncBtn) {
    tmSyncBtn.addEventListener('click', async () => {
      tmSyncBtn.disabled = true;
      tmSyncBtn.textContent = 'Syncing…';
      try {
        const data = await api('/api/teslamate/sync-sessions?days=365', { method: 'POST' });
        if (data.ok) {
          showTmMessage('success', `✓ Matched ${data.matched} of ${data.total_tm_sessions} charge sessions`);
        } else {
          showTmMessage('error', 'Sync failed: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        showTmMessage('error', 'Sync error: ' + err.message);
      }
      tmSyncBtn.disabled = false;
      tmSyncBtn.textContent = 'Sync Sessions';
    });
  }

  // Show configured status if URL is set
  async function loadTeslamateStatus() {
    try {
      const data = await api('/api/settings');
      if (!data.ok) return;
      const url = data.settings.teslamate_database_url;
      if (url && url.startsWith('postgresql')) {
        if (tmBadge) { tmBadge.textContent = 'URL configured'; tmBadge.style.color = 'var(--text-secondary)'; }
      }
    } catch (_e) {}
  }
  loadTeslamateStatus();

  // ─── Fleet Telemetry (Advanced) ──────────────────────────────────────────
  const telSendBtn   = document.getElementById('telemetry-send-btn');
  const telMessage   = document.getElementById('telemetry-message');
  const telBadge     = document.getElementById('telemetry-status-badge');
  const telHostInput = document.getElementById('setting_fleet_telemetry_hostname');
  const telPortInput = document.getElementById('setting_fleet_telemetry_port');
  const telCaInput   = document.getElementById('setting_fleet_telemetry_ca_cert');

  function showTelMessage(type, text) {
    if (!telMessage) return;
    telMessage.className = `alert alert-${type}`;
    telMessage.textContent = text;
    telMessage.classList.remove('hidden');
  }

  if (telSendBtn) {
    telSendBtn.addEventListener('click', async () => {
      const hostname = telHostInput?.value?.trim();
      if (!hostname) {
        showTelMessage('error', 'Enter your telemetry server hostname first - see TELEMETRY.md');
        return;
      }
      // Save the fields before sending so the backend reads the latest values
      await api('/api/settings', {
        method: 'POST',
        body: {
          fleet_telemetry_hostname: hostname,
          fleet_telemetry_port: telPortInput?.value?.trim() || '443',
          fleet_telemetry_ca_cert: telCaInput?.value?.trim() || '',
        },
      });
      telSendBtn.disabled = true;
      telSendBtn.textContent = 'Sending…';
      try {
        const data = await api('/api/setup/send-telemetry-config', { method: 'POST' });
        if (data.ok) {
          showTelMessage('success', '✓ Telemetry config accepted by Tesla - the car will start streaming to your server once it wakes.');
          if (telBadge) { telBadge.textContent = 'Configured ✓'; telBadge.style.color = 'var(--accent-solar)'; }
        } else {
          showTelMessage('error', (data.error || 'Unknown error') + (data.response ? ` - ${JSON.stringify(data.response)}` : ''));
          if (telBadge) { telBadge.textContent = 'Error'; telBadge.style.color = 'var(--accent-error, #fc814a)'; }
        }
      } catch (err) {
        showTelMessage('error', 'Error: ' + err.message);
      }
      telSendBtn.disabled = false;
      telSendBtn.textContent = 'Send Config to Tesla';
    });
  }

  // Show configured status if hostname is already set
  async function loadTelemetryStatus() {
    try {
      const data = await api('/api/settings');
      if (!data.ok) return;
      if (data.settings.fleet_telemetry_hostname && telBadge) {
        telBadge.textContent = 'Hostname set';
        telBadge.style.color = 'var(--text-secondary)';
      }
    } catch (_e) {}
  }
  loadTelemetryStatus();

  // ─── Calendar (iCloud / Google / Outlook) ────────────────────────────────
  const calProviderSelect = document.getElementById('cal-provider-select');
  const calStatusBadge    = document.getElementById('cal-status-badge');
  const calStatusDetail   = document.getElementById('cal-status-detail');
  const calStatusText     = document.getElementById('cal-status-text');
  const calRefreshBtn     = document.getElementById('cal-refresh-btn');
  const calPanels = {
    icloud: document.getElementById('cal-panel-icloud'),
    google: document.getElementById('cal-panel-google'),
    outlook: document.getElementById('cal-panel-outlook'),
  };

  const icalUsernameInput = document.getElementById('ical-username');
  const icalPasswordInput = document.getElementById('ical-password');
  const icalCalendarsInput = document.getElementById('ical-calendars');
  const icalSaveBtn      = document.getElementById('ical-save-btn');
  const icalMessage      = document.getElementById('ical-message');

  const googleConnectBtn    = document.getElementById('google-cal-connect-btn');
  const googleDisconnectBtn = document.getElementById('google-cal-disconnect-btn');
  const googleMessage       = document.getElementById('google-cal-message');

  const outlookConnectBtn    = document.getElementById('outlook-cal-connect-btn');
  const outlookDisconnectBtn = document.getElementById('outlook-cal-disconnect-btn');
  const outlookMessage       = document.getElementById('outlook-cal-message');

  function showCalMessage(el, type, text) {
    if (!el) return;
    el.className = `alert alert-${type}`;
    el.textContent = text;
    el.classList.remove('hidden');
    if (type === 'success') setTimeout(() => el.classList.add('hidden'), 5000);
  }

  function showCalPanel(providerId) {
    for (const [id, panel] of Object.entries(calPanels)) {
      if (panel) panel.style.display = (id === providerId) ? 'block' : 'none';
    }
    if (calProviderSelect) calProviderSelect.value = providerId;
  }

  async function loadCalProviders() {
    try {
      const data = await api('/api/setup/calendar/providers');
      if (!data.ok) return;
      showCalPanel(data.active);
      const googleConfigured = data.providers.find((p) => p.id === 'google')?.configured;
      const outlookConfigured = data.providers.find((p) => p.id === 'outlook')?.configured;
      if (googleDisconnectBtn) googleDisconnectBtn.style.display = googleConfigured ? 'inline-block' : 'none';
      if (outlookDisconnectBtn) outlookDisconnectBtn.style.display = outlookConfigured ? 'inline-block' : 'none';
    } catch (_e) {}
  }

  async function loadCalStatus() {
    try {
      const data = await api('/api/setup/calendar/status');
      if (!data.ok) return;
      if (data.configured) {
        if (calStatusBadge) { calStatusBadge.textContent = `${data.label} connected`; calStatusBadge.style.color = 'var(--accent-solar)'; }
        if (calStatusDetail) calStatusDetail.style.display = 'block';
        if (calStatusText) {
          const since = data.lastFetched ? new Date(data.lastFetched).toLocaleTimeString('en-AU') : 'never';
          calStatusText.textContent = `${data.tripCount} upcoming driving trip(s) found · last fetched ${since}`;
        }
        if (calRefreshBtn) calRefreshBtn.style.display = 'inline-block';
      } else {
        if (calStatusBadge) { calStatusBadge.textContent = 'Not configured'; calStatusBadge.style.color = 'var(--text-secondary)'; }
        if (calStatusDetail) calStatusDetail.style.display = 'none';
        if (calRefreshBtn) calRefreshBtn.style.display = 'none';
      }
    } catch (_e) {}
  }

  async function loadIcalFields() {
    try {
      const data = await api('/api/setup/ical-status');
      if (!data.ok) return;
      if (icalUsernameInput && data.username) icalUsernameInput.value = data.username;
      if (icalCalendarsInput && data.calendars) icalCalendarsInput.value = data.calendars;
    } catch (_e) {}
  }

  if (calProviderSelect) {
    calProviderSelect.addEventListener('change', async () => {
      const providerId = calProviderSelect.value;
      showCalPanel(providerId);
      try {
        await api('/api/setup/calendar/select', { method: 'POST', body: { provider: providerId } });
        await loadCalStatus();
      } catch (_e) {}
    });
  }

  if (icalSaveBtn) {
    icalSaveBtn.addEventListener('click', async () => {
      const username  = icalUsernameInput?.value?.trim();
      const password  = icalPasswordInput?.value?.trim();
      const calendars = icalCalendarsInput?.value?.trim() || '';

      if (!username || !password) {
        showCalMessage(icalMessage, 'error', 'Apple ID email and app-specific password are required');
        return;
      }

      icalSaveBtn.disabled = true;
      icalSaveBtn.textContent = 'Connecting…';

      try {
        const data = await api('/api/setup/ical-credentials', {
          method: 'POST',
          body: { username, password, calendars },
        });
        if (data.ok) {
          showCalMessage(icalMessage, 'success', '✓ iCloud Calendar connected. Fetching trips in background…');
          icalPasswordInput.value = '';
          showCalPanel('icloud');
          await loadCalStatus();
        } else {
          showCalMessage(icalMessage, 'error', 'Connection failed: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        showCalMessage(icalMessage, 'error', 'Error: ' + err.message);
      }

      icalSaveBtn.disabled = false;
      icalSaveBtn.textContent = 'Save & Connect';
    });
  }

  if (googleConnectBtn) {
    googleConnectBtn.addEventListener('click', () => { window.location.href = '/auth/google-calendar/start'; });
  }
  if (googleDisconnectBtn) {
    googleDisconnectBtn.addEventListener('click', async () => {
      try {
        await api('/api/setup/google-calendar/disconnect', { method: 'POST' });
        showCalMessage(googleMessage, 'success', 'Google Calendar disconnected');
        await loadCalProviders();
        await loadCalStatus();
      } catch (err) {
        showCalMessage(googleMessage, 'error', 'Error: ' + err.message);
      }
    });
  }

  if (outlookConnectBtn) {
    outlookConnectBtn.addEventListener('click', () => { window.location.href = '/auth/outlook-calendar/start'; });
  }
  if (outlookDisconnectBtn) {
    outlookDisconnectBtn.addEventListener('click', async () => {
      try {
        await api('/api/setup/outlook-calendar/disconnect', { method: 'POST' });
        showCalMessage(outlookMessage, 'success', 'Outlook Calendar disconnected');
        await loadCalProviders();
        await loadCalStatus();
      } catch (err) {
        showCalMessage(outlookMessage, 'error', 'Error: ' + err.message);
      }
    });
  }

  if (calRefreshBtn) {
    calRefreshBtn.addEventListener('click', async () => {
      calRefreshBtn.disabled = true;
      calRefreshBtn.textContent = 'Refreshing…';
      try {
        await api('/api/trips/refresh', { method: 'POST' });
        await loadCalStatus();
      } catch (_e) {}
      calRefreshBtn.disabled = false;
      calRefreshBtn.textContent = 'Refresh Now';
    });
  }

  // Reflect the OAuth redirect result (?calendar_connected=google|outlook / ?calendar_error=...)
  const calParams = new URLSearchParams(window.location.search);
  if (calParams.get('calendar_connected')) {
    const provider = calParams.get('calendar_connected');
    showCalPanel(provider);
    const msgEl = provider === 'google' ? googleMessage : provider === 'outlook' ? outlookMessage : null;
    showCalMessage(msgEl, 'success', `✓ ${provider === 'google' ? 'Google' : 'Outlook'} Calendar connected. Fetching trips in background…`);
    window.history.replaceState({}, '', window.location.pathname);
  } else if (calParams.get('calendar_error')) {
    showCalMessage(googleMessage || outlookMessage, 'error', 'Connection failed: ' + calParams.get('calendar_error'));
    window.history.replaceState({}, '', window.location.pathname);
  }

  loadIcalFields();
  loadCalProviders();
  loadCalStatus();

  // ─── Battery (Sigenergy / Sungrow / Tesla Powerwall) ─────────────────────
  const BATTERY_CONTROL_BRANDS = new Set(['sungrow']); // brands whose setMode() actually does something
  const batteryBrandSelect = document.getElementById('setting_battery_brand');
  const batteryPrioritySelect = document.getElementById('setting_battery_priority');
  const batteryPriorityGroup = document.getElementById('battery-priority-group');
  const batteryPriorityCaveat = document.getElementById('battery-priority-caveat');
  const batteryTestRow = document.getElementById('battery-test-row');
  const batteryTestBtn = document.getElementById('battery-test-btn');
  const batteryTestResult = document.getElementById('battery-test-result');

  function showBatteryFields(brandId) {
    document.querySelectorAll('.battery-brand-fields').forEach((el) => {
      el.style.display = (el.id === `battery-fields-${brandId}`) ? 'block' : 'none';
    });
    const configured = brandId && brandId !== 'none';
    if (batteryPriorityGroup) batteryPriorityGroup.style.display = configured ? 'block' : 'none';
    if (batteryTestRow) batteryTestRow.style.display = configured ? 'flex' : 'none';
    updateBatteryPriorityCaveat(brandId);
  }

  function updateBatteryPriorityCaveat(brandId) {
    if (!batteryPriorityCaveat || !batteryPrioritySelect) return;
    const showCaveat = batteryPrioritySelect.value === 'ev_first' && !BATTERY_CONTROL_BRANDS.has(brandId);
    batteryPriorityCaveat.style.display = showCaveat ? 'block' : 'none';
  }

  async function loadBatteryBrands() {
    if (!batteryBrandSelect) return;
    try {
      const data = await api('/api/setup/battery-brands');
      if (!data.ok || !Array.isArray(data.brands)) return;
      const options = [{ id: 'none', label: 'None' }, ...data.brands];
      batteryBrandSelect.innerHTML = options.map((b) => `<option value="${b.id}">${b.label}</option>`).join('');
    } catch (_e) {}
  }

  if (batteryBrandSelect) {
    batteryBrandSelect.addEventListener('change', () => showBatteryFields(batteryBrandSelect.value));
  }
  if (batteryPrioritySelect) {
    batteryPrioritySelect.addEventListener('change', () => updateBatteryPriorityCaveat(batteryBrandSelect?.value));
  }
  if (batteryTestBtn) {
    batteryTestBtn.addEventListener('click', async () => {
      batteryTestBtn.disabled = true;
      batteryTestBtn.textContent = 'Testing…';
      if (batteryTestResult) { batteryTestResult.textContent = ''; batteryTestResult.style.color = ''; }
      try {
        const body = {};
        for (const key of FIELD_IDS) {
          if (!key.startsWith('sigenergy_') && !key.startsWith('sungrow_') && !key.startsWith('powerwall_') && key !== 'battery_brand') continue;
          const el = document.getElementById('setting_' + key);
          if (el && el.value) body[key] = el.value;
        }
        await api('/api/settings', { method: 'POST', body });
        const data = await api('/api/setup/test-battery', { method: 'POST', body: { brand: batteryBrandSelect?.value } });
        if (batteryTestResult) {
          batteryTestResult.textContent = data.ok ? '✓ Connected' : (data.error || 'Failed');
          batteryTestResult.style.color = data.ok ? 'var(--accent-solar)' : '#fc814a';
        }
      } catch (err) {
        if (batteryTestResult) { batteryTestResult.textContent = 'Error: ' + err.message; batteryTestResult.style.color = '#fc814a'; }
      } finally {
        batteryTestBtn.disabled = false;
        batteryTestBtn.textContent = 'Test Connection';
      }
    });
  }

  (async () => {
    await loadBatteryBrands();
    const data = await api('/api/settings');
    if (data.ok) {
      const brandId = data.settings.battery_brand || 'none';
      if (batteryBrandSelect) batteryBrandSelect.value = brandId;
      if (batteryPrioritySelect) batteryPrioritySelect.value = data.settings.battery_priority || 'battery_first';
      showBatteryFields(brandId);
    }
  })();

  // ─── Solcast ──────────────────────────────────────────────────────────
  const solcastStatusBadge = document.getElementById('solcast-status-badge');
  function updateSolcastBadge(apiKey, resourceId) {
    if (!solcastStatusBadge) return;
    if (apiKey && resourceId) {
      solcastStatusBadge.textContent = 'Configured ✓';
      solcastStatusBadge.style.color = 'var(--accent-solar)';
    } else {
      solcastStatusBadge.textContent = 'Not configured';
      solcastStatusBadge.style.color = 'var(--text-secondary)';
    }
  }
  async function loadSolcastStatus() {
    try {
      const data = await api('/api/settings');
      if (!data.ok) return;
      updateSolcastBadge(data.settings.solcast_api_key, data.settings.solcast_resource_id);
    } catch (_e) {}
  }
  loadSolcastStatus();

  // ── Notification buttons ─────────────────────────────────────────────────
  const notifTestResult = document.getElementById('notif-test-result');

  async function fireNotifBtn(btnId, endpoint) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      if (notifTestResult) { notifTestResult.textContent = 'Sending…'; notifTestResult.style.color = 'var(--text-secondary)'; }
      try {
        const r = await api(endpoint, { method: 'POST' });
        if (notifTestResult) {
          if (r.sent) {
            notifTestResult.textContent = '✓ Sent - check your phone';
            notifTestResult.style.color = 'var(--accent-solar)';
          } else {
            notifTestResult.textContent = '✗ ' + (r.reason || r.error || 'Failed');
            notifTestResult.style.color = 'var(--accent-import)';
          }
        }
      } catch (e) {
        if (notifTestResult) { notifTestResult.textContent = '✗ ' + e.message; notifTestResult.style.color = 'var(--accent-import)'; }
      }
      btn.disabled = false;
    });
  }

  fireNotifBtn('notif-brief-btn',   '/api/notifications/morning-brief');
  fireNotifBtn('notif-evening-btn', '/api/notifications/evening-summary');
  fireNotifBtn('notif-test-btn',    '/api/notifications/test');

  // ── Panel nicknames ──────────────────────────────────────────────────────
  (async function loadPanelNicknames() {
    const listEl   = document.getElementById('panel-nicknames-list');
    const saveBtn  = document.getElementById('panel-nicknames-save-btn');
    const resultEl = document.getElementById('panel-nicknames-result');
    if (!listEl) return;

    let currentNicknames = {};
    try {
      const [healthData, settingsData] = await Promise.all([
        api('/api/panels/health'),
        api('/api/settings'),
      ]);
      try { currentNicknames = JSON.parse(settingsData?.settings?.panel_nicknames || '{}'); } catch (_) {}

      const panels = healthData?.panels || [];
      if (!panels.length) { listEl.innerHTML = '<span style="font-size:0.8rem;color:var(--text-secondary)">No panel data available yet.</span>'; return; }

      listEl.innerHTML = '';
      panels.forEach(p => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:0.75rem';

        const serial = document.createElement('span');
        serial.style.cssText = 'font-family:monospace;font-size:0.78rem;color:var(--text-secondary);min-width:56px;flex-shrink:0';
        serial.textContent = `…${p.serial_short}`;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'form-control';
        input.style.cssText = 'flex:1;padding:0.35rem 0.6rem;font-size:0.82rem';
        input.placeholder = `Panel ${p.panel_id}`;
        input.value = currentNicknames[p.panel_id] || '';
        input.dataset.panelId = p.panel_id;

        row.appendChild(serial);
        row.appendChild(input);
        listEl.appendChild(row);
      });
    } catch (_) {
      listEl.innerHTML = '<span style="font-size:0.8rem;color:var(--accent-import)">Failed to load panels.</span>';
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        const nicknames = {};
        listEl.querySelectorAll('input[data-panel-id]').forEach(inp => {
          const v = inp.value.trim();
          if (v) nicknames[inp.dataset.panelId] = v;
        });
        try {
          const r = await api('/api/settings', { method: 'POST', body: { panel_nicknames: JSON.stringify(nicknames) } });
          if (resultEl) {
            resultEl.textContent = r.ok ? '✓ Saved' : '✗ Failed';
            resultEl.style.color = r.ok ? 'var(--accent-solar)' : 'var(--accent-import)';
          }
        } catch (e) {
          if (resultEl) { resultEl.textContent = '✗ ' + e.message; resultEl.style.color = 'var(--accent-import)'; }
        }
        saveBtn.disabled = false;
      });
    }
  })();

  // ── Security: change dashboard password ──────────────────────────────────
  (() => {
    const saveBtn   = document.getElementById('sec-save-btn');
    const msgEl     = document.getElementById('security-msg');
    if (!saveBtn) return;

    function showMsg(text, ok) {
      msgEl.textContent = text;
      msgEl.style.display = 'block';
      msgEl.style.background    = ok ? 'rgba(74,222,128,0.1)'  : 'rgba(239,68,68,0.12)';
      msgEl.style.border        = ok ? '1px solid rgba(74,222,128,0.3)' : '1px solid rgba(239,68,68,0.35)';
      msgEl.style.color         = ok ? 'var(--accent-solar)'   : '#f87171';
    }

    saveBtn.addEventListener('click', async () => {
      const current = document.getElementById('sec-current').value;
      const newPw   = document.getElementById('sec-new').value;
      const confirm = document.getElementById('sec-confirm').value;

      if (!newPw || newPw.length < 8) {
        showMsg('Password must be at least 8 characters.', false); return;
      }
      if (newPw !== confirm) {
        showMsg('Passwords do not match.', false); return;
      }

      saveBtn.disabled = true;
      try {
        const r = await api('/api/auth/change-password', {
          method: 'POST',
          body: { currentPassword: current, newPassword: newPw },
        });
        if (r.ok) {
          showMsg('Password updated. You\'ll need it next time you sign in.', true);
          document.getElementById('sec-current').value = '';
          document.getElementById('sec-new').value     = '';
          document.getElementById('sec-confirm').value = '';
          saveBtn.textContent = 'Update Password';
        } else {
          showMsg(r.error || 'Failed to update password.', false);
        }
      } catch (e) {
        showMsg(e.message || 'Request failed.', false);
      }
      saveBtn.disabled = false;
    });
  })();
});
