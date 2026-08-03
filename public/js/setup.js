/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

// ─── Setup wizard ───

let currentStep = 1;
const TOTAL_STEPS = 12;

function goToStep(n) {
  if (n < 1 || n > TOTAL_STEPS) return;

  document.querySelectorAll('.step-panel').forEach((p) => p.classList.add('hidden'));
  const panel = document.getElementById('step-' + n);
  if (panel) panel.classList.remove('hidden');

  currentStep = n;
  updateProgress();
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Step-specific init
  if (n === 5) initStep5DevApp();
  if (n === 6) initStep6Vehicle();
  if (n === 7) initStep7PublicKey();
  if (n === 9) initStep9Ble();
  if (n === 11) initStep11Service();
  if (n === 12) initStep12Complete();
}

function initStep12Complete() {
  const vehicleItem = document.getElementById('step12-vehicle-checklist-item');
  if (vehicleItem) {
    vehicleItem.textContent = selectedVehicleMode === 'ble'
      ? 'Tesla vehicle configured (Bluetooth LE)'
      : 'Tesla account authorised';
  }
}

function updateProgress() {
  const pct = ((currentStep - 1) / (TOTAL_STEPS - 1)) * 100;
  const fill = document.getElementById('setup-progress-fill');
  if (fill) fill.style.width = pct + '%';

  document.querySelectorAll('.step-dot').forEach((dot, i) => {
    const stepN = i + 1;
    dot.classList.toggle('done', stepN < currentStep);
    dot.classList.toggle('active', stepN === currentStep);
  });
}

function showStepError(stepId, msg) {
  const el = document.getElementById(stepId + '-error');
  if (el) {
    el.textContent = msg;
    el.classList.remove('hidden');
  }
}

function hideStepError(stepId) {
  const el = document.getElementById(stepId + '-error');
  if (el) el.classList.add('hidden');
}

function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  if (loading) {
    btn.dataset.originalText = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span>';
  } else {
    btn.textContent = btn.dataset.originalText || 'Continue';
  }
}

// ─── Step 1: Welcome ───
document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('step1-start');
  if (startBtn) startBtn.addEventListener('click', () => goToStep(2));
});

// ─── Step 2: Solar inverter (Enphase / Fronius / SolarEdge) ───
let selectedInverterBrand = 'enphase';

function setInverterBrand(brand) {
  selectedInverterBrand = brand;
  document.querySelectorAll('.brand-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.brand === brand);
  });
  ['enphase', 'fronius', 'solaredge', 'span', 'sungrow', 'mqtt'].forEach((b) => {
    const el = document.getElementById('brand-fields-' + b);
    if (el) el.classList.toggle('hidden', b !== brand);
  });
  document.getElementById('gateway-result')?.classList.add('hidden');
  hideStepError('step2');
}

async function discoverGateway() {
  setLoading('discover-btn', true);
  hideStepError('step2');
  try {
    const data = await api('/api/setup/discover-gateway', { method: 'POST', body: {} });
    if (data.ok && data.ip) {
      document.getElementById('gateway-ip-input').value = data.ip;
      showStepInfo('step2', `Found at ${data.ip}`);
    } else {
      showStepError('step2', 'Could not auto-discover gateway. Enter the IP manually.');
    }
  } catch (err) {
    showStepError('step2', 'Discovery failed: ' + err.message);
  } finally {
    setLoading('discover-btn', false);
  }
}

// Reads whatever fields are visible for the currently selected brand.
// Returns null (and shows an error) if a required field is missing.
function collectInverterFields() {
  if (selectedInverterBrand === 'enphase') {
    const ip = document.getElementById('gateway-ip-input')?.value?.trim();
    if (!ip) { showStepError('step2', 'Enter the gateway IP'); return null; }
    return { inverter_brand: 'enphase', gateway_ip: ip };
  }
  if (selectedInverterBrand === 'fronius') {
    const ip = document.getElementById('fronius-ip-input')?.value?.trim();
    if (!ip) { showStepError('step2', 'Enter the inverter IP'); return null; }
    return { inverter_brand: 'fronius', fronius_ip: ip };
  }
  if (selectedInverterBrand === 'solaredge') {
    const apiKey = document.getElementById('solaredge-api-key-input')?.value?.trim();
    const siteId = document.getElementById('solaredge-site-id-input')?.value?.trim();
    if (!apiKey || !siteId) { showStepError('step2', 'Enter both API key and Site ID'); return null; }
    return { inverter_brand: 'solaredge', solaredge_api_key: apiKey, solaredge_site_id: siteId };
  }
  if (selectedInverterBrand === 'span') {
    const host  = document.getElementById('span-host-input')?.value?.trim();
    const token = document.getElementById('span-access-token-input')?.value?.trim();
    const circuit = document.getElementById('span-solar-circuit-input')?.value?.trim();
    if (!host || !token || !circuit) { showStepError('step2', 'Enter the panel host, access token, and solar circuit ID'); return null; }
    return { inverter_brand: 'span', span_host: host, span_access_token: token, span_solar_circuit_id: circuit };
  }
  if (selectedInverterBrand === 'sungrow') {
    const host = document.getElementById('sungrow-host-input')?.value?.trim();
    if (!host) { showStepError('step2', 'Enter the inverter/dongle host or IP'); return null; }
    return {
      inverter_brand: 'sungrow',
      sungrow_host:    host,
      sungrow_port:    document.getElementById('sungrow-port-input')?.value?.trim() || '502',
      sungrow_unit_id: document.getElementById('sungrow-unit-id-input')?.value?.trim() || '1',
    };
  }
  if (selectedInverterBrand === 'mqtt') {
    const broker      = document.getElementById('mqtt-in-broker')?.value?.trim();
    const topicSolar  = document.getElementById('mqtt-in-topic-solar')?.value?.trim();
    const topicSecond = document.getElementById('mqtt-in-topic-second')?.value?.trim();
    if (!broker)      { showStepError('step2', 'Enter the MQTT broker URL'); return null; }
    if (!topicSolar || !topicSecond) { showStepError('step2', 'Enter both the solar topic and the second topic'); return null; }
    if (topicSolar === topicSecond)  { showStepError('step2', 'The solar and second topics must be different'); return null; }
    return {
      inverter_brand:       'mqtt',
      mqtt_in_broker_url:   broker,
      mqtt_in_username:     document.getElementById('mqtt-in-username')?.value?.trim() || '',
      mqtt_in_password:     document.getElementById('mqtt-in-password')?.value || '',
      mqtt_in_topic_solar:  topicSolar,
      mqtt_in_second_type:  document.getElementById('mqtt-in-second-type')?.value || 'grid',
      mqtt_in_topic_second: topicSecond,
      mqtt_in_grid_sign:    document.getElementById('mqtt-in-grid-sign')?.value || 'import_positive',
      mqtt_in_scale:        document.getElementById('mqtt-in-scale')?.value || '1',
      mqtt_in_stale_seconds: document.getElementById('mqtt-in-stale')?.value || '60',
    };
  }
  return null;
}

async function testGateway() {
  // Enphase's test-gateway route is a pre-save connectivity check (doesn't require the
  // token/settings to already be saved) - keep using it for Enphase specifically.
  if (selectedInverterBrand === 'enphase') {
    const ip = document.getElementById('gateway-ip-input')?.value?.trim();
    if (!ip) { showStepError('step2', 'Enter an IP address first'); return; }
    setLoading('test-gateway-btn', true);
    hideStepError('step2');
    try {
      const data = await api('/api/setup/test-gateway', { method: 'POST', body: { ip } });
      if (data.ok) {
        document.getElementById('gateway-serial').textContent = data.serial || '-';
        document.getElementById('gateway-firmware').textContent = data.firmware || '-';
        document.getElementById('gateway-result').classList.remove('hidden');
      } else {
        showStepError('step2', data.error || 'Connection failed');
      }
    } catch (err) {
      showStepError('step2', 'Test failed: ' + err.message);
    } finally {
      setLoading('test-gateway-btn', false);
    }
    return;
  }

  // Fronius / SolarEdge: save the fields first (test-inverter reads from settings), then test.
  const fields = collectInverterFields();
  if (!fields) return;
  setLoading('test-gateway-btn', true);
  hideStepError('step2');
  try {
    await api('/api/settings', { method: 'POST', body: fields });
    const data = await api('/api/setup/test-inverter', { method: 'POST', body: { brand: selectedInverterBrand } });
    if (data.ok) {
      showStepInfo('step2', `✓ Connected - solar ${Math.round(data.readings?.solarW || 0)}W`);
    } else {
      showStepError('step2', data.error || 'Connection failed');
    }
  } catch (err) {
    showStepError('step2', 'Test failed: ' + err.message);
  } finally {
    setLoading('test-gateway-btn', false);
  }
}

async function saveGatewayAndNext() {
  const fields = collectInverterFields();
  if (!fields) return;
  await api('/api/settings', { method: 'POST', body: fields });
  // Enphase needs its own auth step (step 3); Fronius (no auth) and SolarEdge
  // (API key already entered above) skip straight to the vehicle-connection step.
  goToStep(selectedInverterBrand === 'enphase' ? 3 : 4);
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.brand-pill').forEach((btn) => {
    btn.addEventListener('click', () => setInverterBrand(btn.dataset.brand));
  });

  const discoverBtn = document.getElementById('discover-btn');
  if (discoverBtn) discoverBtn.addEventListener('click', discoverGateway);

  const testBtn = document.getElementById('test-gateway-btn');
  if (testBtn) testBtn.addEventListener('click', testGateway);

  const nextBtn = document.getElementById('step2-next');
  if (nextBtn) nextBtn.addEventListener('click', saveGatewayAndNext);
});

// ─── Step 3: Enphase credentials ───
async function generateEnphaseToken() {
  const email = document.getElementById('enphase-email')?.value?.trim();
  const password = document.getElementById('enphase-password')?.value;
  const serial = document.getElementById('enphase-serial')?.value?.trim();
  const ip = (await api('/api/settings')).settings?.gateway_ip || '';

  if (!email || !password || !serial) {
    showStepError('step3', 'All fields required');
    return;
  }

  setLoading('gen-token-btn', true);
  hideStepError('step3');
  try {
    const data = await api('/api/setup/generate-token', {
      method: 'POST',
      body: { email, password, serial, ip },
    });
    if (data.ok) {
      document.getElementById('token-expiry').textContent = new Date(data.expiresAt).toLocaleDateString('en-AU');
      document.getElementById('token-result').classList.remove('hidden');
      showStepInfo('step3', 'Token generated successfully. Password has not been stored.');
    } else {
      showStepError('step3', data.error || 'Token generation failed');
    }
  } catch (err) {
    showStepError('step3', 'Error: ' + err.message);
  } finally {
    setLoading('gen-token-btn', false);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const genBtn = document.getElementById('gen-token-btn');
  if (genBtn) genBtn.addEventListener('click', generateEnphaseToken);

  const nextBtn = document.getElementById('step3-next');
  if (nextBtn) nextBtn.addEventListener('click', () => {
    const tokenResult = document.getElementById('token-result');
    if (!tokenResult || tokenResult.classList.contains('hidden')) {
      showStepError('step3', 'Generate a token first');
      return;
    }
    goToStep(4);
  });

  document.getElementById('step3-back')?.addEventListener('click', () => goToStep(2));
});

// ─── Step 4: Vehicle connection method (Fleet API/Telemetry vs Bluetooth LE) ───
// This single choice sets BOTH tesla_command_backend and tesla_state_source to the same
// value. Mixed setups (e.g. BLE commands + Fleet Telemetry state) are still possible
// afterward from Settings, but a combined choice is the sane default for setup.
let selectedVehicleMode = 'fleet';

function setVehicleMode(mode) {
  selectedVehicleMode = mode;
  document.querySelectorAll('.mode-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

async function saveVehicleModeAndNext() {
  try {
    await api('/api/settings', {
      method: 'POST',
      body: { tesla_command_backend: selectedVehicleMode, tesla_state_source: selectedVehicleMode },
    });
    goToStep(5);
  } catch (err) {
    showStepError('step4', 'Save failed: ' + err.message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.mode-pill').forEach((btn) => {
    btn.addEventListener('click', () => setVehicleMode(btn.dataset.mode));
  });
  document.getElementById('step4-next')?.addEventListener('click', saveVehicleModeAndNext);
  document.getElementById('step4-back')?.addEventListener('click', () => {
    goToStep(selectedInverterBrand === 'enphase' ? 3 : 2);
  });
});

// ─── Step 5: Tesla developer app ───
// Content branches on selectedVehicleMode: Fleet mode needs a redirect URI and ends in an
// OAuth redirect; Bluetooth LE mode only needs the client ID/secret (used later to register
// the public-key domain with Tesla - no user login involved) and never leaves this page.
function initStep5DevApp() {
  const isBle = selectedVehicleMode === 'ble';
  document.getElementById('tesla-redirect-uri-group')?.classList.toggle('hidden', isBle);
  // Bluetooth LE never sends the user through Tesla's login, so there is no
  // authorisation for an unregistered domain to block. That mode registers the
  // domain later, at the public-key step, where it is genuinely needed.
  document.getElementById('tesla-domain-group')?.classList.toggle('hidden', isBle);
  const desc = document.getElementById('step5-desc');
  if (desc) {
    desc.innerHTML = isBle
      ? `Enter your Tesla Fleet API application's Client ID and Secret. You need a registered developer application at
         <a href="https://developer.tesla.com" target="_blank" rel="noopener">developer.tesla.com</a> - these are used only to
         register your public key with Tesla in a later step. No login or redirect URI is needed for Bluetooth LE mode.`
      : `Enter your Tesla Fleet API application credentials. You need a registered developer application at
         <a href="https://developer.tesla.com" target="_blank" rel="noopener">developer.tesla.com</a>.
         The redirect URI must match exactly what you registered.`;
  }
  const infoAlert = document.getElementById('step5-info-alert');
  if (infoAlert) {
    infoAlert.textContent = isBle
      ? 'Clicking "Save and Continue" stores your credentials here - it does not redirect anywhere or log in to your Tesla account.'
      : 'Clicking "Authorise with Tesla" will redirect you to Tesla\'s login page. You\'ll be sent back here automatically.';
  }
  const authBtn = document.getElementById('tesla-auth-btn');
  if (authBtn) authBtn.textContent = isBle ? 'Save and Continue →' : 'Authorise with Tesla →';
}

async function saveTeslaCredsAndRedirect() {
  const clientId = document.getElementById('tesla-client-id')?.value?.trim();
  const clientSecret = document.getElementById('tesla-client-secret')?.value?.trim();

  if (selectedVehicleMode === 'ble') {
    if (!clientId || !clientSecret) {
      showStepError('step5', 'Client ID and Client Secret are required');
      return;
    }
    await api('/api/settings', { method: 'POST', body: { tesla_client_id: clientId, tesla_client_secret: clientSecret } });
    goToStep(6);
    return;
  }

  const redirectUri = document.getElementById('tesla-redirect-uri')?.value?.trim();
  const keyDomain = document.getElementById('tesla-key-domain')?.value?.trim();
  if (!clientId || !clientSecret || !redirectUri || !keyDomain) {
    showStepError('step5', 'All fields required');
    return;
  }

  await api('/api/settings', { method: 'POST', body: { tesla_client_id: clientId, tesla_client_secret: clientSecret, tesla_redirect_uri: redirectUri } });

  // Register the domain with Tesla BEFORE handing off to their login.
  //
  // Tesla will not authorise users for an app whose domain is not registered,
  // and the only thing it tells them is "Something went wrong. Try again
  // later. No policy rules" - on Tesla's own page, after they have signed in,
  // with nothing pointing back at the real cause. Registering first turns that
  // dead end into an error we can explain.
  //
  // Registration needs only the client credentials just saved (no OAuth token)
  // and is idempotent, so running it on every pass through this step is safe.
  const btn = document.getElementById('tesla-auth-btn');
  const originalLabel = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Registering domain with Tesla…'; }

  try {
    const reg = await api('/api/setup/register-partner', { method: 'POST', body: { domain: keyDomain } });
    if (!reg.ok) {
      showStepError('step5',
        `Tesla rejected the domain registration: ${reg.error || 'unknown error'}. `
        + `Check that "${keyDomain}" matches the Allowed Origin on your Tesla app, `
        + `and that your public key is reachable at `
        + `https://${keyDomain}/.well-known/appspecific/com.tesla.3p.public-key.pem`);
      return;
    }
  } catch (err) {
    showStepError('step5', `Could not register the domain with Tesla: ${err.message}`);
    return;
  } finally {
    if (btn) { btn.disabled = false; if (originalLabel) btn.textContent = originalLabel; }
  }

  window.location.href = '/auth/tesla/start';
}

document.addEventListener('DOMContentLoaded', () => {
  const authBtn = document.getElementById('tesla-auth-btn');
  if (authBtn) authBtn.addEventListener('click', saveTeslaCredsAndRedirect);
  document.getElementById('step5-back')?.addEventListener('click', () => goToStep(4));
});

// ─── Fleet-mode fallbacks (triggered from step 6 on 412 or other fetch-vehicles errors) ───
function showManualVin(el, error) {
  el.innerHTML = `
    <div class="alert alert-warn" style="margin-bottom:1rem">
      Could not fetch vehicle automatically (${error || 'API error'}). Enter your VIN manually instead - find it in the Tesla app under <strong>your car → Software</strong>, or on the dashboard visible through the windshield.
    </div>
    <label style="display:block;margin-bottom:0.5rem;color:var(--text-secondary);font-size:0.85rem">Vehicle VIN</label>
    <input id="manual-vin-input" class="input" type="text" placeholder="5YJ3E1EA1PF000000" style="margin-bottom:0.75rem;width:100%;font-family:monospace">
    <button class="btn btn-primary" onclick="saveManualVin()">Save VIN</button>
    <span id="manual-vin-status" style="margin-left:0.75rem;font-size:0.85rem"></span>`;
}

// Bluetooth LE mode never has an access token to call fetch-vehicles with, so it goes
// straight to manual VIN entry - same fields, without the "couldn't fetch automatically"
// framing since nothing was actually attempted.
function showManualVinBle(el) {
  el.innerHTML = `
    <label style="display:block;margin-bottom:0.5rem;color:var(--text-secondary);font-size:0.85rem">Vehicle VIN</label>
    <input id="manual-vin-input" class="input" type="text" placeholder="5YJ3E1EA1PF000000" style="margin-bottom:0.75rem;width:100%;font-family:monospace">
    <p class="text-secondary text-xs" style="margin-bottom:0.75rem">Find it in the Tesla app under <strong>your car → Software</strong>, or on the dashboard visible through the windshield.</p>
    <button class="btn btn-primary" onclick="saveManualVin()">Save VIN</button>
    <span id="manual-vin-status" style="margin-left:0.75rem;font-size:0.85rem"></span>`;
}

async function saveManualVin() {
  const vin = document.getElementById('manual-vin-input')?.value?.trim().toUpperCase();
  if (!vin || vin.length !== 17) {
    document.getElementById('manual-vin-status').textContent = 'VIN must be 17 characters';
    return;
  }
  try {
    await api('/api/settings', { method: 'POST', body: { tesla_vin: vin, tesla_display_name: vin } });
    const el = document.getElementById('vehicle-info');
    if (el) el.innerHTML = `<div class="alert alert-success">VIN saved: <strong style="font-family:monospace">${vin}</strong></div>`;
  } catch (err) {
    document.getElementById('manual-vin-status').textContent = 'Error: ' + err.message;
  }
}

function showPartnerRegistration(el) {
  el.innerHTML = `
    <div class="alert alert-warn" style="margin-bottom:1rem">
      <strong>One more step required.</strong> Tesla requires you to register your app domain with their servers before API access works. This is a one-time step.
    </div>
    <label style="display:block;margin-bottom:0.5rem;color:var(--text-secondary);font-size:0.85rem">Your app domain (where your public key will be hosted)</label>
    <input id="partner-domain-input" class="input" type="text" placeholder="yourname.github.io" style="margin-bottom:0.75rem;width:100%">
    <p style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:0.75rem">A bare hostname, e.g. <code>yourname.github.io</code> - no <code>https://</code> and no path. Tesla reads the key from the domain <strong>root</strong>, so a project page such as <code>yourname.github.io/my-keys</code> cannot serve it.</p>
    <button class="btn btn-primary" onclick="registerPartnerFromVehicleStep()">Register domain with Tesla</button>
    <span id="partner-reg-status" style="margin-left:0.75rem;font-size:0.85rem"></span>`;
}

async function registerPartnerFromVehicleStep() {
  const domain = document.getElementById('partner-domain-input')?.value?.trim();
  if (!domain) { document.getElementById('partner-reg-status').textContent = 'Enter a domain first'; return; }

  const statusEl = document.getElementById('partner-reg-status');
  statusEl.textContent = 'Registering…';

  try {
    const data = await api('/api/setup/register-partner', { method: 'POST', body: { domain } });
    if (data.ok) {
      statusEl.textContent = '';
      const el = document.getElementById('vehicle-info');
      if (el) el.innerHTML = `<div style="color:var(--text-secondary)">Registered! Fetching vehicle list…</div>`;
      await initStep6Vehicle();
    } else {
      statusEl.textContent = 'Error: ' + (data.error || 'Registration failed');
    }
  } catch (err) {
    statusEl.textContent = 'Error: ' + err.message;
  }
}

// ─── Step 6: Vehicle selection (Fleet: fetch-vehicles; Bluetooth LE: manual VIN entry) ───
async function initStep6Vehicle() {
  const el = document.getElementById('vehicle-info');
  if (!el) return;

  const titleEl = document.getElementById('step6-title');
  const descEl = document.getElementById('step6-desc');

  // First check if VIN already saved (true for both modes, and for a returning fleet user).
  const settings = await api('/api/settings');
  const vin = settings.settings?.tesla_vin;
  const name = settings.settings?.tesla_display_name;

  if (vin) {
    if (titleEl) titleEl.textContent = 'Vehicle Connected';
    el.innerHTML = `<div class="alert alert-success">Connected: <strong>${name || vin}</strong><br><span style="font-family:monospace;font-size:0.85em;opacity:0.7">${vin}</span></div>`;
    return;
  }

  if (selectedVehicleMode === 'ble') {
    if (titleEl) titleEl.textContent = 'Enter Your Vehicle';
    if (descEl) descEl.textContent = 'Bluetooth LE mode has no way to auto-detect your vehicle - enter its VIN directly.';
    showManualVinBle(el);
    return;
  }

  // Fleet mode: VIN not saved - try fetching vehicles now via the stored OAuth token.
  if (titleEl) titleEl.textContent = 'Vehicle Connected';
  if (descEl) descEl.textContent = 'Tesla authentication was successful. Your vehicle has been detected.';
  el.innerHTML = `<div style="color:var(--text-secondary)">Fetching vehicle list…</div>`;
  try {
    const data = await api('/api/setup/fetch-vehicles');
    if (data.ok && data.vehicles?.length > 0) {
      const v = data.vehicles[0];
      el.innerHTML = `<div class="alert alert-success">Connected: <strong>${v.display_name || v.vin}</strong><br><span style="font-family:monospace;font-size:0.85em;opacity:0.7">${v.vin}</span></div>`;
    } else if (data.error && data.error.includes('412')) {
      showPartnerRegistration(el);
    } else {
      showManualVin(el, data.error);
    }
  } catch (err) {
    showManualVin(el, err.message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('step6-next')?.addEventListener('click', () => goToStep(7));
  document.getElementById('step6-back')?.addEventListener('click', () => goToStep(5));
});

// ─── Step 7: Public key (+ explicit partner registration for Bluetooth LE mode) ───
// Fleet-mode users already register their partner domain via the step-6 412 fallback above;
// Bluetooth LE users never call fetch-vehicles (no OAuth token exists), so they'd otherwise
// never register at all. This section makes that step explicit and required for BLE mode.
let blePartnerRegistered = false;

async function initStep7PublicKey() {
  await loadPublicKey();

  const section = document.getElementById('step7-partner-section');
  if (!section) return;

  if (selectedVehicleMode !== 'ble') {
    section.classList.add('hidden');
    return;
  }

  const settings = await api('/api/settings');
  blePartnerRegistered = settings.settings?.tesla_partner_registered === 'true';
  section.classList.remove('hidden');
  const statusEl = document.getElementById('partner-reg-status');
  if (statusEl && blePartnerRegistered) statusEl.textContent = '✓ Already registered';
}

async function registerPartnerFromKeyStep() {
  const domain = document.getElementById('key-url-input')?.value?.trim();
  const statusEl = document.getElementById('partner-reg-status');
  if (!domain) { if (statusEl) statusEl.textContent = 'Enter your app URL above first'; return; }

  setLoading('register-partner-btn', true);
  if (statusEl) statusEl.textContent = 'Registering…';
  try {
    const data = await api('/api/setup/register-partner', { method: 'POST', body: { domain } });
    if (data.ok) {
      blePartnerRegistered = true;
      if (statusEl) statusEl.textContent = '✓ Registered';
    } else if (statusEl) {
      statusEl.textContent = 'Error: ' + (data.error || 'Registration failed');
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Error: ' + err.message;
  } finally {
    setLoading('register-partner-btn', false);
  }
}

async function loadPublicKey() {
  try {
    const data = await api('/api/setup/public-key');
    if (data.ok) {
      const el = document.getElementById('public-key-display');
      if (el) el.textContent = data.publicKey;
    }
  } catch (_err) {}
}

async function verifyKeyUrl() {
  const url = document.getElementById('key-url-input')?.value?.trim();
  if (!url) { showStepError('step7', 'Enter your app URL'); return; }
  setLoading('verify-key-btn', true);
  hideStepError('step7');
  try {
    const data = await api('/api/setup/verify-key-url', { method: 'POST', body: { url } });
    if (data.ok && data.match) {
      showStepInfo('step7', 'Key verified - your domain is serving the correct public key.');
    } else {
      showStepError('step7', data.error || 'Key mismatch - check your web server config.');
    }
  } catch (err) {
    showStepError('step7', 'Verification failed: ' + err.message);
  } finally {
    setLoading('verify-key-btn', false);
  }
}

function copyPublicKey() {
  const el = document.getElementById('public-key-display');
  if (el) navigator.clipboard.writeText(el.textContent).catch(() => {});
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('copy-key-btn')?.addEventListener('click', copyPublicKey);
  document.getElementById('verify-key-btn')?.addEventListener('click', verifyKeyUrl);
  document.getElementById('register-partner-btn')?.addEventListener('click', registerPartnerFromKeyStep);
  document.getElementById('step7-next')?.addEventListener('click', () => {
    if (selectedVehicleMode === 'ble' && !blePartnerRegistered) {
      showStepError('step7', 'Register your domain with Tesla first (below) - required for Bluetooth LE to work.');
      return;
    }
    goToStep(8);
  });
  document.getElementById('step7-back')?.addEventListener('click', () => goToStep(6));
});

// ─── Step 8: Virtual key pairing ───
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('step8-next')?.addEventListener('click', () => {
    goToStep(selectedVehicleMode === 'ble' ? 9 : 10);
  });
  document.getElementById('step8-back')?.addEventListener('click', () => goToStep(7));
});

// ─── Step 9: Bluetooth LE proxy (only reachable in Bluetooth LE mode) ───
async function initStep9Ble() {
  try {
    const settings = await api('/api/settings');
    const saved = settings.settings?.tesla_ble_proxy_url;
    const input = document.getElementById('ble-proxy-url-input');
    if (input && saved) input.value = saved;
  } catch (_err) {}
}

async function testBleProxyInSetup() {
  const url = document.getElementById('ble-proxy-url-input')?.value?.trim();
  const resultEl = document.getElementById('step9-test-result');
  setLoading('step9-test-btn', true);
  if (resultEl) { resultEl.textContent = ''; resultEl.style.color = ''; }
  try {
    const data = await api('/api/tesla/test-ble', { method: 'POST', body: { url } });
    if (resultEl) {
      resultEl.textContent = data.ok ? `✓ Reachable (HTTP ${data.status})` : (data.error || 'Not reachable');
      resultEl.style.color = data.ok ? 'var(--accent-solar)' : '#fc814a';
    }
  } catch (err) {
    if (resultEl) { resultEl.textContent = 'Error: ' + err.message; resultEl.style.color = '#fc814a'; }
  } finally {
    setLoading('step9-test-btn', false);
  }
}

async function saveBleProxyAndNext() {
  const url = document.getElementById('ble-proxy-url-input')?.value?.trim();
  if (!url) { showStepError('step9', 'Enter the BLE proxy URL'); return; }
  try {
    await api('/api/settings', { method: 'POST', body: { tesla_ble_proxy_url: url } });
    goToStep(10);
  } catch (err) {
    showStepError('step9', 'Save failed: ' + err.message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('step9-test-btn')?.addEventListener('click', testBleProxyInSetup);
  document.getElementById('step9-next')?.addEventListener('click', saveBleProxyAndNext);
  document.getElementById('step9-back')?.addEventListener('click', () => goToStep(8));
});

// ─── Step 10: Charging preferences ───
async function savePrefsAndNext() {
  const fields = ['min_charge_amps', 'max_charge_amps', 'hold_minutes', 'smoothing_window', 'polling_interval_seconds', 'charger_voltage', 'electricity_rate_aud'];
  const body = {};
  for (const f of fields) {
    const el = document.getElementById('pref_' + f);
    if (el) body[f] = el.value;
  }
  try {
    await api('/api/settings', { method: 'POST', body });
    goToStep(11);
  } catch (err) {
    showStepError('step10', 'Save failed: ' + err.message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('step10-next')?.addEventListener('click', savePrefsAndNext);
  document.getElementById('step10-back')?.addEventListener('click', () => {
    goToStep(selectedVehicleMode === 'ble' ? 9 : 8);
  });

  // Load current prefs
  api('/api/settings').then((data) => {
    if (!data.ok) return;
    const fields = ['min_charge_amps', 'max_charge_amps', 'hold_minutes', 'smoothing_window', 'polling_interval_seconds', 'charger_voltage', 'electricity_rate_aud'];
    for (const f of fields) {
      const el = document.getElementById('pref_' + f);
      if (el && data.settings[f]) el.value = data.settings[f];
    }
  }).catch(() => {});
});

// ─── Step 11: Install service ───
function initStep11Service() {
  const isFullyBle = selectedVehicleMode === 'ble';
  const descEl = document.getElementById('step11-desc');
  if (descEl) {
    descEl.textContent = isFullyBle
      ? 'Install WattSnatch as a macOS LaunchAgent so it starts automatically at login and runs continuously in the background. Bluetooth LE mode does not need the Fleet-signing Tesla proxy service, so it is skipped - keep your own TeslaBleHttpProxy process running instead (step 9).'
      : 'Install WattSnatch as a macOS LaunchAgent so it starts automatically at login and runs continuously in the background. This will also install the Tesla command proxy service.';
  }
  document.getElementById('service-proxy-row')?.classList.toggle('hidden', isFullyBle);
  checkServiceStatus();
}

async function installService() {
  setLoading('install-service-btn', true);
  hideStepError('step11');
  try {
    const data = await api('/api/setup/install-service', { method: 'POST', body: {} });
    if (data.ok) {
      showStepInfo('step11', 'Service installed. Checking status…');
      setTimeout(checkServiceStatus, 2000);
    } else {
      showStepError('step11', data.error || 'Install failed');
    }
  } catch (err) {
    showStepError('step11', 'Error: ' + err.message);
  } finally {
    setLoading('install-service-btn', false);
  }
}

async function checkServiceStatus() {
  try {
    const data = await api('/api/setup/service-status');
    if (!data.ok) return;
    const appEl = document.getElementById('service-app-status');
    const proxyEl = document.getElementById('service-proxy-status');
    if (appEl) {
      appEl.innerHTML = data.status.app.running
        ? `<span class="pill pill-ok"><span class="status-dot status-dot-green"></span>Running</span>`
        : `<span class="pill pill-idle"><span class="status-dot status-dot-grey"></span>Stopped</span>`;
    }
    if (proxyEl) {
      proxyEl.innerHTML = data.status.proxy.running
        ? `<span class="pill pill-ok"><span class="status-dot status-dot-green"></span>Running</span>`
        : `<span class="pill pill-idle"><span class="status-dot status-dot-grey"></span>Stopped</span>`;
    }
  } catch (_err) {}
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('install-service-btn')?.addEventListener('click', installService);
  document.getElementById('check-status-btn')?.addEventListener('click', checkServiceStatus);
  document.getElementById('step11-next')?.addEventListener('click', () => goToStep(12));
  document.getElementById('step11-back')?.addEventListener('click', () => goToStep(10));
});

// ─── Step 12: Complete ───
async function completeSetup() {
  setLoading('complete-btn', true);
  try {
    await api('/api/setup/complete', { method: 'POST', body: {} });
    setTimeout(() => { window.location.href = '/'; }, 1200);
  } catch (err) {
    showStepError('step12', 'Error: ' + err.message);
    setLoading('complete-btn', false);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('complete-btn')?.addEventListener('click', completeSetup);
  document.getElementById('step12-back')?.addEventListener('click', () => goToStep(11));
});

// ─── Helpers ───
function showStepInfo(stepId, msg) {
  const el = document.getElementById(stepId + '-info');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  el.className = 'alert alert-success mt-2';
}

// ─── Init ───
document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const stepParam = params.get('step');
  const errParam = params.get('error');

  if (stepParam && !isNaN(parseInt(stepParam))) {
    const n = parseInt(stepParam);
    currentStep = n;
    if (errParam) {
      // Show error after goToStep renders the panel. auth.js always redirects error cases
      // back to step 5 (Tesla Developer App), so that's always the right error box. This
      // path is Fleet-only by construction (Bluetooth LE mode never triggers an OAuth
      // redirect), so selectedVehicleMode defaulting to 'fleet' here is correct.
      setTimeout(() => showStepError('step5', 'Tesla auth error: ' + errParam), 50);
    }
  }

  goToStep(currentStep);
});
