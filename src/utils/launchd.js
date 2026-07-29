/*
 * Copyright (c) 2026 James Shafton
 * Licensed under the PolyForm Noncommercial License 1.0.0
 * See LICENSE file in the project root, or
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

function generateAppPlist(appDir, username) {
  const logDir = path.join(appDir, 'data');
  const nodeBin = process.execPath;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.${username}.wattsnatch</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodeBin}</string>
        <string>${appDir}/src/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${appDir}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PORT</key>
        <string>3001</string>
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logDir}/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${logDir}/stderr.log</string>
</dict>
</plist>
`;
}

function generateProxyPlist(appDir, username) {
  const certPath = path.join(appDir, 'keys', 'public.pem');
  const keyPath = path.join(appDir, 'keys', 'private.pem');
  const logDir = path.join(appDir, 'data');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.${username}.wattsnatch.proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>${appDir}/tesla-proxy</string>
        <string>-cert</string>
        <string>${path.join(appDir, 'keys', 'proxy-tls-cert.pem')}</string>
        <string>-tls-key</string>
        <string>${path.join(appDir, 'keys', 'proxy-tls-key.pem')}</string>
        <string>-key-file</string>
        <string>${keyPath}</string>
        <string>-port</string>
        <string>4443</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${appDir}</string>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logDir}/proxy-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${logDir}/proxy-stderr.log</string>
</dict>
</plist>
`;
}

// installTeslaProxy: whether to install the Fleet-signing tesla-http-proxy service.
// Defaults to true (existing behaviour unchanged). Callers pass false when the user has
// chosen Bluetooth LE for both command backend and vehicle state - that binary is never
// invoked in that mode, and it usually hasn't even been built, so installing a launchd
// service pointing at a missing binary would just crash-loop for no reason.
function installPlists(appDir, username, installTeslaProxy = true) {
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const dataDir = path.join(appDir, 'data');

  // Ensure directories exist
  if (!fs.existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
  }
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const appPlistPath = path.join(launchAgentsDir, `com.${username}.wattsnatch.plist`);
  const proxyPlistPath = path.join(launchAgentsDir, `com.${username}.wattsnatch.proxy.plist`);

  fs.writeFileSync(appPlistPath, generateAppPlist(appDir, username), 'utf8');

  try {
    execSync(`launchctl load -w "${appPlistPath}"`, { stdio: 'pipe' });
  } catch (err) {
    // May already be loaded
    console.warn('[launchd] App plist load warning:', err.message);
  }

  if (!installTeslaProxy) {
    return { appPlistPath, proxyPlistPath: null };
  }

  fs.writeFileSync(proxyPlistPath, generateProxyPlist(appDir, username), 'utf8');

  try {
    execSync(`launchctl load -w "${proxyPlistPath}"`, { stdio: 'pipe' });
  } catch (err) {
    console.warn('[launchd] Proxy plist load warning:', err.message);
  }

  return { appPlistPath, proxyPlistPath };
}

function getServiceStatus(username) {
  const appLabel = `com.${username}.wattsnatch`;
  const proxyLabel = `com.${username}.wattsnatch.proxy`;

  function checkLabel(label) {
    try {
      const out = execSync(`launchctl list "${label}" 2>/dev/null || echo "not found"`, { encoding: 'utf8' });
      if (out.includes('not found') || out.trim() === '') return { running: false };
      const pidMatch = out.match(/"PID"\s*=\s*(\d+)/);
      return { running: true, pid: pidMatch ? parseInt(pidMatch[1]) : null };
    } catch (_err) {
      return { running: false };
    }
  }

  return {
    app: checkLabel(appLabel),
    proxy: checkLabel(proxyLabel)
  };
}

module.exports = { generateAppPlist, generateProxyPlist, installPlists, getServiceStatus };
