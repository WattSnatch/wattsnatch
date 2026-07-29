# WattSnatch

[![Tests](https://github.com/WattSnatch/wattsnatch/actions/workflows/test.yml/badge.svg)](https://github.com/WattSnatch/wattsnatch/actions/workflows/test.yml)

Automatically divert excess solar power to your Tesla. When your Enphase solar system is generating more than your home needs, WattSnatch adjusts your Tesla's charge rate in real time so you're charging from the sun rather than the grid - and stops or reduces charging when solar drops.

**What you need:**
- An Enphase IQ Gateway (Envoy) on your local network (Fronius, SolarEdge, and SPAN Panel are also supported - or feed **any** inverter in over MQTT, see below)
- A Tesla vehicle
- A free Tesla Fleet API developer account
- A Mac, Windows PC, or Linux machine to run the server (can be always-on, like a Mac mini)

Works in Australia and the United States out of the box (Settings → Region drives currency/unit labels, one-click US utility rate templates, and NEM 3.0-style time-varying export credit for California) - and anywhere else with a supported inverter and Tesla coverage, minus the region-specific extras.

The setup wizard lets you choose how WattSnatch talks to your car: Tesla's cloud Fleet API/Telemetry (default), or fully cloud-free over Bluetooth LE (no Fleet Telemetry, no ongoing Fleet API calls, no Tesla OAuth token) once you're in range at home. Both still need the same one-time Tesla developer app and virtual key pairing - that part is Tesla's own security requirement either way. See [INSTALL.md](INSTALL.md#tesla-vehicle-connection-fleet-api-vs-bluetooth-le) for details.

[![WattSnatch walkthrough](https://img.youtube.com/vi/c2HrjkGhlFg/maxresdefault.jpg)](https://youtu.be/c2HrjkGhlFg)

## System requirements

WattSnatch is deliberately lightweight - measured on a real long-running install, it idles at ~140 MB RAM and near-0% CPU between 5-second poll ticks.

| | Minimum | Recommended |
|---|---|---|
| CPU | 1 core, any 64-bit CPU from the last decade | 2+ cores (Raspberry Pi 4 class or better) |
| RAM | 1 GB free | 2 GB+ free |
| Disk | 2 GB free (app + dependencies ≈ 120 MB; the database grows to ~100 MB over months and auto-prunes old telemetry) | 5 GB free |
| OS | macOS, Linux, or Windows with Node.js 18+ | macOS (gets one-click background-service install and Keychain credential storage) or Linux |
| Network | Wired or Wi-Fi on the **same LAN as your solar gateway** - this is a hard requirement; a cloud VPS won't work | Always-on machine (Mac mini, Pi, home server) |

Two dependencies (`better-sqlite3`, `zeromq`) compile native code during `npm install`, so build tools must be present: Xcode Command Line Tools on macOS, `build-essential python3` on Debian/Ubuntu, or the "Desktop development with C++" workload on Windows.

---

## Quick start

```bash
git clone https://github.com/WattSnatch/wattsnatch.git
cd wattsnatch
npm install
npm start
```

Then open **http://localhost:3001** and follow the setup wizard.

---

## Installing with an AI coding agent

If you use an agentic coding tool (Claude Code, Cursor, Codex, or similar), you can hand it most of this install. The repo ships an [AGENTS.md](AGENTS.md) written specifically for agents - point yours at the repo and say **"follow AGENTS.md"**.

**What the agent can do for you:** clone and install, build the Tesla command proxy, generate signing keys, discover and test your solar gateway connection, set sensible charging defaults, install the background service, and verify the whole install end-to-end via the setup API.

**What the agent cannot do - these steps are yours:**

| Step | Why it must be you |
|---|---|
| Create the Tesla developer app at developer.tesla.com | Your Tesla account login |
| Complete the Tesla OAuth sign-in | Your credentials + 2FA, in your own browser |
| Enter your Enphase (Enlighten) email and password | Never hand credentials to an agent - you run the one command yourself; the password is used once to mint a local token and never stored |
| Pair the virtual key at the car | Requires physically tapping your key card on the car's console (iPhone + Safari) |
| Choose the dashboard password | It should be a password the agent doesn't know |

AGENTS.md marks every step with ✅ (agent), 🔑 (your credentials), 🌐 (your browser), or 🚗 (physically at the car), so the agent knows exactly where to stop and hand back to you.

---

## Detailed installation

### Step 1 - Install Node.js

Download and install Node.js **version 18 or later** from [nodejs.org](https://nodejs.org). Choose the LTS version.

To verify it's installed, open Terminal (Mac/Linux) or Command Prompt (Windows) and run:

```
node --version
```

You should see something like `v20.x.x`.

---

### Step 2 - Download WattSnatch

**Option A - Git (recommended):**
```bash
git clone https://github.com/WattSnatch/wattsnatch.git
cd wattsnatch
npm install
```

**Option B - ZIP download:**
Download the ZIP from GitHub, unzip it, open a terminal inside the unzipped folder, and run:
```bash
npm install
```

---

### Step 3 - Install the Tesla command proxy

Tesla requires a small local proxy to sign charging commands with your private key. This is an official Tesla open-source tool.

**macOS:**
```bash
# Install Go first (needed to build the proxy)
brew install go

# Build the proxy
git clone https://github.com/teslamotors/vehicle-command.git
cd vehicle-command
go build ./cmd/tesla-http-proxy

# Copy the binary into your WattSnatch folder
cp tesla-http-proxy /path/to/wattsnatch/tesla-proxy
cd ..
```

**Windows:**
1. Install Go from [go.dev/dl](https://go.dev/dl/) (download the Windows installer)
2. Open a new Command Prompt window (so Go is on your PATH) and run:
```
git clone https://github.com/teslamotors/vehicle-command.git
cd vehicle-command
go build ./cmd/tesla-http-proxy
```
3. Copy the resulting `tesla-http-proxy.exe` to a folder on your PATH (e.g. `C:\Windows\System32\`) and rename it `tesla-proxy.exe`

**Linux:**
```bash
sudo apt install golang-go git   # Debian/Ubuntu; adjust for your distro
git clone https://github.com/teslamotors/vehicle-command.git
cd vehicle-command
go build ./cmd/tesla-http-proxy
sudo cp tesla-http-proxy /usr/local/bin/tesla-proxy
cd ..
```

---

### Step 4 - Create a Tesla Developer account

WattSnatch uses Tesla's official Fleet API, which requires a free developer registration.

1. Go to [developer.tesla.com](https://developer.tesla.com) and sign in with your Tesla account
2. Click **Create Application**
3. Fill in the details:
   - **App name:** WattSnatch (or anything you like)
   - **Purpose:** Personal use / home automation
4. Under **API and Scopes**, tick all of:
   - Vehicle Information
   - Vehicle Location
   - Vehicle Commands
   - Vehicle Charging Management
5. Save and note your **Client ID** and **Client Secret** - you'll enter these in the setup wizard

---

### Step 5 - Host your public key (one-time)

Tesla requires your app's public key to be accessible at a public URL. The easiest free method is GitHub Pages.

1. Create a **new public GitHub repository** (e.g. `wattsnatch-key`)
2. In the repo's **Settings → Pages**, set source to **Deploy from branch → main**
3. Your GitHub Pages URL will be: `https://YOUR_GITHUB_USERNAME.github.io/wattsnatch-key`
4. In the **Tesla developer portal**, set your app's **Allowed Origin** to this URL

You don't need to put anything in the repo yet - the setup wizard will generate your key pair and tell you exactly what to paste in.

---

### Step 6 - Run the setup wizard

Start WattSnatch:
```bash
npm start
```

Open **http://localhost:3001** in your browser.

The wizard will walk you through these steps in order:

1. **Enphase** - enter your gateway's local IP address (find it in your router's device list, or in the Enphase app) and the serial number from the sticker on the gateway
2. **Enphase token** - enter your Enphase account email and password (the password is used once to generate a local token and is never stored)
3. **Tesla credentials** - paste your Client ID and Client Secret from Step 4
4. **Public key** - the wizard generates an EC key pair and shows you the public key. Create the file `.well-known/appspecific/com.tesla.3p.public-key.pem` in your GitHub Pages repo and paste the key in. Once the URL is live, click Next.
5. **Tesla auth** - you'll be redirected to Tesla's login page. Sign in and grant access to your vehicle.
6. **Charging settings** - configure your preferences (see Settings reference below)
7. **Install service** (macOS only) - installs WattSnatch as a background service that starts automatically at login

---

## Running automatically on startup

### macOS - built-in service installer

The setup wizard's final step installs WattSnatch and the Tesla proxy as macOS LaunchAgents. They will start automatically on login and restart if they crash.

To check the services are running:
```bash
launchctl list | grep wattsnatch
```

To manually stop/start:
```bash
launchctl stop com.YOURUSERNAME.wattsnatch
launchctl start com.YOURUSERNAME.wattsnatch
```

To uninstall (stop auto-start):
```bash
launchctl unload ~/Library/LaunchAgents/com.YOURUSERNAME.wattsnatch.plist
launchctl unload ~/Library/LaunchAgents/com.YOURUSERNAME.wattsnatch.proxy.plist
```

### Windows - using PM2

PM2 is a process manager that keeps Node apps running and registers them with Windows to start on boot.

```
npm install -g pm2
pm2 start src/server.js --name wattsnatch
pm2 save
pm2 startup
```

Copy and run the command that `pm2 startup` outputs - this registers it with Windows startup.

For the Tesla proxy, create a file called `start-proxy.bat` inside the WattSnatch folder:
```bat
tesla-proxy -cert keys\public.pem -key keys\private.pem -port 4443
```

Then add it to PM2:
```
pm2 start start-proxy.bat --name tesla-proxy
pm2 save
```

### Linux - systemd

Create `/etc/systemd/system/wattsnatch.service`:
```ini
[Unit]
Description=WattSnatch
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/path/to/wattsnatch
ExecStart=/usr/bin/node src/server.js
Restart=always
Environment=PORT=3001

[Install]
WantedBy=multi-user.target
```

Create `/etc/systemd/system/tesla-proxy.service`:
```ini
[Unit]
Description=Tesla Command Proxy
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/path/to/wattsnatch
ExecStart=/usr/local/bin/tesla-proxy -cert keys/public.pem -key keys/private.pem -port 4443
Restart=always

[Install]
WantedBy=multi-user.target
```

Enable and start both:
```bash
sudo systemctl enable wattsnatch tesla-proxy
sudo systemctl start wattsnatch tesla-proxy
```

---

## Accessing from other devices on your network

WattSnatch is accessible from any device on the same Wi-Fi, not just the machine running it.

1. Find your server's local IP address:
   - **Mac:** Run `ipconfig getifaddr en0` in Terminal, or check System Settings → Network
   - **Windows:** Run `ipconfig` in Command Prompt and look for **IPv4 Address**
2. On any phone, tablet, or computer on the same network, open `http://192.168.x.x:3001` (replace with your server's actual IP)

**Tip:** Set a static/reserved IP for your server in your router settings so this address never changes.

---

## Changing the port

If port 3001 is already in use on your machine:

```bash
# Mac / Linux
PORT=8080 npm start

# Windows
set PORT=8080 && npm start
```

---

## Settings reference

| Setting | Default | Description |
|---|---|---|
| Min charge amps | 5 A | Don't start or continue charging below this level. Most Tesla chargers need at least 5 A to operate. |
| Max charge amps | 32 A | Maximum allowed charge rate for solar diversion. Set this to match your home charger's physical limit. |
| Hold minutes | 3 min | How long to keep charging after solar drops before stopping, to avoid repeated start/stop cycles on passing clouds. |
| Smoothing window | 3 polls | Number of readings to average before adjusting. Higher = more stable but slower to react. |
| Polling interval | 15 s | How often to read solar output and check car state. |
| Charger voltage | 240 V | Your home charger voltage. 240V in Australia, UK, and Europe. US homes are typically 240V for EV chargers. |
| Electricity rate | $0.30/kWh | Used only for the "Est. Saved" display - enter your grid import rate. |
| Home radius | 0.1 km | GPS geofence radius. Solar charging control is suspended when your car is outside this radius (e.g. at a Supercharger). |

---

## Troubleshooting

**Gateway: Error**
- Check the Enphase gateway IP address in Settings
- Make sure your server is on the same local network as the gateway
- Try regenerating the Enphase token in Settings (you'll need your Enphase email and password again)

**Tesla: Error**
- Go to Settings and click **Re-authorise Tesla**
- If that doesn't help: go to [tesla.com/teslaaccount/security](https://tesla.com/teslaaccount/security), find WattSnatch under Third-party Apps and **Revoke** it, then re-authorise from scratch via Settings

**Car shows as Asleep when it's awake**
- The Tesla cloud can take up to 60 seconds to reflect the car's true state after it wakes up
- If it persists, the car may have a poor cellular or Wi-Fi connection

**Charging commands not working (charge rate doesn't adjust)**
- The Tesla proxy must be running alongside the main app. Check:
  - **macOS:** `launchctl list | grep proxy`
  - **Windows/Linux:** Check PM2 or systemd status for `tesla-proxy`
- Try running `tesla-proxy` directly in a terminal to confirm the binary is installed correctly

**"better-sqlite3" error on startup**
- Run `npm rebuild` to recompile the native SQLite module for your machine and Node version

**Port 3001 already in use**
- Either change the port (see above) or find what's using 3001: `lsof -i :3001` (Mac/Linux) or `netstat -ano | findstr :3001` (Windows)

---

## Privacy & data

All data is stored locally in a SQLite database at `~/.solarcharge/solarcharge.db` in your home directory (the internal folder/file name predates the WattSnatch rebrand and hasn't been migrated yet - this is a known cosmetic inconsistency, not a functional issue). Nothing is sent to any third-party cloud service during normal operation, except:

- **Tesla Fleet API** - to read your car's state and send charging commands
- **Enphase cloud** - only once during setup to generate a local token; all ongoing data comes directly from your gateway on the local network

Your Tesla OAuth tokens and Enphase tokens are encrypted at rest using AES-256. Telemetry history is retained for 7 days, event logs for 90 days, and charge session records are kept indefinitely.

---

## Architecture overview

```
Enphase IQ Gateway (local LAN)
    ↓ HTTP polling every 15s
WattSnatch server (Node.js / Express / SQLite)
    ↓ SSE push
Browser dashboard (vanilla JS)

Tesla Fleet API (cloud)
    ↓ vehicle state
WattSnatch controller
    ↓ charge commands
Tesla proxy (local, port 4443) → signs with EC private key → Tesla cloud → car
```

---

## License

WattSnatch is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE). You're free to run, modify, and adapt it for your own household - personal, non-commercial use is explicitly permitted. Any commercial use (selling it, hosting it as a paid service, bundling it into a product, paid support/managed services, or building a competing commercial product) requires a separate commercial license - see the [LICENSE](LICENSE) file for details.

WattSnatch itself plans to offer official paid installation and support services directly - see [COMMERCIAL.md](COMMERCIAL.md) for how that fits alongside the license, and what counts as third-party commercial use versus an official WattSnatch service.
