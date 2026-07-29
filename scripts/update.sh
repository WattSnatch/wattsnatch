#!/usr/bin/env bash
#
# Copyright (c) 2026 James Shafton
# Licensed under the PolyForm Noncommercial License 1.0.0
# See LICENSE file in the project root, or
# https://polyformproject.org/licenses/noncommercial/1.0.0
#
# One-command update: backs up first, then pulls and installs. Aborts on
# the first failure (set -e) rather than leaving things half-updated.
# macOS/Linux only - Windows users should run the three steps manually
# (see INSTALL.md #13).

set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Backing up before update..."
node scripts/backup.js
echo ""

echo "==> Fetching latest changes..."
git fetch --tags
git pull
echo ""

echo "==> Installing dependencies..."
npm install
echo ""

echo "✅ Update complete. Restart WattSnatch now:"
echo "  macOS:   launchctl kickstart -k gui/\$(id -u)/com.YOURUSERNAME.wattsnatch"
echo "  Linux:   sudo systemctl restart wattsnatch"
echo "  Windows: pm2 restart wattsnatch"
echo ""
echo "If something looks wrong after restarting, roll back:"
echo "  git tag --list                        # find the previous version"
echo "  git checkout <previous-tag>"
echo "  npm install"
echo "  npm run restore -- <path-to-the-backup-made-above>"
