/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const UNIT_DIR = '/etc/systemd/system';

function generateAppUnit(appDir, username) {
  const nodeBin = process.execPath;
  const logDir = path.join(appDir, 'data');
  return `[Unit]
Description=WattSnatch solar EV charging controller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${username}
WorkingDirectory=${appDir}
Environment=NODE_ENV=production
Environment=PORT=3001
ExecStart=${nodeBin} ${appDir}/src/server.js
Restart=always
RestartSec=5
StandardOutput=append:${logDir}/stdout.log
StandardError=append:${logDir}/stderr.log

[Install]
WantedBy=multi-user.target
`;
}

// Where the tesla-http-proxy binary might actually be.
//
// Everything in this project puts it in the app directory: INSTALL.md,
// AGENTS.md, DEPLOY_TO_SERVER.md, scripts/setup-pi.sh, and the macOS launchd
// generator. README.md's Linux section used to say /usr/local/bin instead, so
// anyone who followed that ended up with a working binary in a place the
// generated unit did not look, and systemd failed with nothing more useful than
// "No such file or directory".
//
// The docs now agree, but checking both costs nothing and means an install done
// against the older instructions keeps working instead of needing the binary
// moved.
const PROXY_BINARY_NAME = 'tesla-proxy';

function resolveProxyBinary(appDir) {
  const candidates = [
    path.join(appDir, PROXY_BINARY_NAME),
    `/usr/local/bin/${PROXY_BINARY_NAME}`,
    `/usr/bin/${PROXY_BINARY_NAME}`,
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_err) { /* try the next one */ }
  }
  // Last resort: anywhere on PATH.
  try {
    const found = execSync(`command -v ${PROXY_BINARY_NAME} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch (_err) { /* fall through */ }
  return null;
}

function generateProxyUnit(appDir, username) {
  const keyPath = path.join(appDir, 'keys', 'private.pem');
  const logDir = path.join(appDir, 'data');
  const proxyBin = resolveProxyBinary(appDir) || path.join(appDir, PROXY_BINARY_NAME);
  return `[Unit]
Description=WattSnatch Tesla command proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${username}
WorkingDirectory=${appDir}
ExecStart=${proxyBin} -cert ${path.join(appDir, 'keys', 'proxy-tls-cert.pem')} -tls-key ${path.join(appDir, 'keys', 'proxy-tls-key.pem')} -key-file ${keyPath} -port 4443
Restart=always
RestartSec=5
StandardOutput=append:${logDir}/proxy-stdout.log
StandardError=append:${logDir}/proxy-stderr.log

[Install]
WantedBy=multi-user.target
`;
}

// Requires passwordless sudo (or to be run as root) - that's expected for a
// one-time appliance provisioning step, not for the per-request web UI flow.
// installTeslaProxy: whether to install the Fleet-signing tesla-http-proxy unit. Defaults
// to true (existing behaviour unchanged); pass false for a full Bluetooth LE setup (both
// command backend and vehicle state set to 'ble'), where that binary is never invoked and
// usually hasn't been built, so installing a unit pointing at a missing binary would just
// fail to start for no reason.
function installUnits(appDir, username, installTeslaProxy = true) {
  const dataDir = path.join(appDir, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const appUnitPath = path.join(UNIT_DIR, 'wattsnatch.service');
  const tmpAppUnit = path.join(dataDir, '.wattsnatch.service.tmp');
  fs.writeFileSync(tmpAppUnit, generateAppUnit(appDir, username), 'utf8');
  execSync(`sudo cp "${tmpAppUnit}" "${appUnitPath}"`, { stdio: 'pipe' });
  fs.unlinkSync(tmpAppUnit);

  execSync('sudo systemctl daemon-reload', { stdio: 'pipe' });
  execSync('sudo systemctl enable --now wattsnatch.service', { stdio: 'pipe' });

  if (!installTeslaProxy) {
    return { appUnitPath, proxyUnitPath: null };
  }

  // Fail here, with something the user can act on, rather than writing a unit
  // that systemd will reject at exec time with only "No such file or directory"
  // and no indication of what it was looking for or where.
  if (!resolveProxyBinary(appDir)) {
    throw new Error(
      `Tesla command proxy binary not found. Looked for "${PROXY_BINARY_NAME}" in `
      + `${appDir}, /usr/local/bin, /usr/bin and on PATH. Build it first (see INSTALL.md `
      + `step 3), then run this step again. If you have already built it, copy it to `
      + `${path.join(appDir, PROXY_BINARY_NAME)} and make sure it is executable.`
    );
  }

  const proxyUnitPath = path.join(UNIT_DIR, 'wattsnatch-proxy.service');
  const tmpProxyUnit = path.join(dataDir, '.wattsnatch-proxy.service.tmp');
  fs.writeFileSync(tmpProxyUnit, generateProxyUnit(appDir, username), 'utf8');
  execSync(`sudo cp "${tmpProxyUnit}" "${proxyUnitPath}"`, { stdio: 'pipe' });
  fs.unlinkSync(tmpProxyUnit);

  execSync('sudo systemctl daemon-reload', { stdio: 'pipe' });
  execSync('sudo systemctl enable --now wattsnatch-proxy.service', { stdio: 'pipe' });

  return { appUnitPath, proxyUnitPath };
}

function getServiceStatus() {
  function checkUnit(unit) {
    try {
      const out = execSync(`systemctl is-active ${unit} 2>/dev/null || true`, { encoding: 'utf8' }).trim();
      if (out !== 'active') return { running: false };
      const pidOut = execSync(
        `systemctl show -p MainPID --value ${unit} 2>/dev/null || true`,
        { encoding: 'utf8' }
      ).trim();
      const pid = parseInt(pidOut, 10);
      return { running: true, pid: Number.isFinite(pid) && pid > 0 ? pid : null };
    } catch (_err) {
      return { running: false };
    }
  }

  return {
    app: checkUnit('wattsnatch.service'),
    proxy: checkUnit('wattsnatch-proxy.service')
  };
}

module.exports = {
  generateAppUnit, generateProxyUnit, installUnits, getServiceStatus,
  resolveProxyBinary,
};
