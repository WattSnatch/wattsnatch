#!/usr/bin/env bash
#
# Copyright (c) 2026 James Shafton
# Licensed under the PolyForm Noncommercial License 1.0.0
#
# Provisions a fresh Raspberry Pi OS Lite (64-bit) install into a running
# WattSnatch appliance: installs Node.js, installs app dependencies, builds
# the Tesla command proxy, and registers both as systemd services that start
# on power-on. Intended to be run once per device, either:
#
#   (a) directly on a Pi you're setting up for yourself, or
#   (b) on a "golden" Pi you intend to image and clone for other units
#       (see DEPLOY_TO_PI.md for the cloning step).
#
# Usage:
#   git clone <your WattSnatch repo> ~/solarcharge
#   cd ~/solarcharge
#   chmod +x scripts/setup-pi.sh
#   ./scripts/setup-pi.sh
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_MAJOR=22

echo "==> WattSnatch Raspberry Pi setup"
echo "    App directory: $APP_DIR"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script targets Raspberry Pi OS (Linux). Use INSTALL.md for macOS." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Node.js
# ---------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v//;s/\..*//')" -lt "$NODE_MAJOR" ]]; then
  echo "==> Installing Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "==> Node.js $(node -v) already installed, skipping"
fi

# ---------------------------------------------------------------------------
# 2. App dependencies
# ---------------------------------------------------------------------------
echo "==> Installing npm dependencies (this can take a few minutes on a Pi)"
cd "$APP_DIR"
npm ci --omit=dev

# ---------------------------------------------------------------------------
# 3. Tesla command proxy (Go binary) - build natively for arm64
# ---------------------------------------------------------------------------
if [[ ! -x "$APP_DIR/tesla-proxy" ]]; then
  echo "==> Building tesla-proxy for arm64"
  if ! command -v go >/dev/null 2>&1; then
    echo "    Installing Go"
    sudo apt-get install -y golang-go
  fi
  TMP_GOPATH="$(mktemp -d)"
  git clone --depth 1 https://github.com/teslamotors/vehicle-command.git "$TMP_GOPATH/vehicle-command"
  (cd "$TMP_GOPATH/vehicle-command" && go build ./cmd/tesla-http-proxy)
  cp "$TMP_GOPATH/vehicle-command/tesla-http-proxy" "$APP_DIR/tesla-proxy"
  chmod +x "$APP_DIR/tesla-proxy"
  rm -rf "$TMP_GOPATH"
else
  echo "==> tesla-proxy already present, skipping build"
fi

# ---------------------------------------------------------------------------
# 4. EC key pair (only if this is a genuinely fresh install)
# ---------------------------------------------------------------------------
if [[ ! -f "$APP_DIR/keys/private.pem" ]]; then
  echo "==> Generating EC key pair"
  node -e "
    const { generateKeyPair } = require('$APP_DIR/src/services/tesla');
    generateKeyPair('$APP_DIR');
    console.log('Keys generated in keys/');
  "
else
  echo "==> keys/private.pem already present, skipping key generation"
fi

# ---------------------------------------------------------------------------
# 5. Register systemd services (auto-start on power-on, restart on crash)
# ---------------------------------------------------------------------------
echo "==> Installing systemd services (requires sudo)"
node -e "
  const { installUnits } = require('$APP_DIR/src/utils/systemd');
  const os = require('os');
  const result = installUnits('$APP_DIR', os.userInfo().username);
  console.log('Installed:', result);
"

echo
echo "==> Done. WattSnatch and the Tesla proxy are running and will start on every boot."
echo "    Check status:   systemctl status wattsnatch wattsnatch-proxy"
echo "    View app logs:  tail -f $APP_DIR/data/stdout.log"
echo "    Dashboard:      http://$(hostname -I | awk '{print $1}'):3001"
echo
echo "Next: open the dashboard and run through the setup wizard (Enphase, Tesla,"
echo "optional integrations) - see INSTALL.md sections 5-11."
