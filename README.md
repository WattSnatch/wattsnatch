# WattSnatch

[![Tests](https://github.com/WattSnatch/wattsnatch/actions/workflows/test.yml/badge.svg)](https://github.com/WattSnatch/wattsnatch/actions/workflows/test.yml)

Automatically divert excess solar power to your Tesla. When your solar system is generating more than your home needs, WattSnatch adjusts your Tesla's charge rate in real time so you're charging from the sun rather than the grid - and stops or reduces charging when solar drops.

**What you need:**
- An Enphase IQ Gateway (Envoy) on your local network (Fronius, SolarEdge, SPAN Panel, and Sungrow are also supported - or feed **any** inverter in over MQTT, see below)
- A Tesla vehicle
- A free Tesla Fleet API developer account
- A Mac, Windows PC, or Linux machine to run the server (can be always-on, like a Mac mini)

Works in Australia and the United States out of the box (Settings → Region drives currency/unit labels, one-click US utility rate templates, and NEM 3.0-style time-varying export credit for California) - and anywhere else with a supported inverter and Tesla coverage, minus the region-specific extras.

Beyond the core solar-to-EV diversion, WattSnatch also has optional support for a home battery (Sigenergy, Sungrow, or Tesla Powerwall), air-conditioning monitoring (MELCloud or MelView), hot water diversion (myenergi Eddi), calendar-aware trip planning, electricity bill parsing, and Home Assistant integration - see [FEATURES.md](FEATURES.md) for the complete list, or [INSTALL.md](INSTALL.md#11-optional-integrations) for setup instructions on each.

The setup wizard lets you choose how WattSnatch talks to your car: Tesla's cloud Fleet API/Telemetry (default), or fully cloud-free over Bluetooth LE (no Fleet Telemetry, no ongoing Fleet API calls, no Tesla OAuth token) once you're in range at home. Both still need the same one-time Tesla developer app and virtual key pairing - that part is Tesla's own security requirement either way. See [INSTALL.md](INSTALL.md#tesla-vehicle-connection-fleet-api-vs-bluetooth-le) for details.

[![WattSnatch walkthrough](https://img.youtube.com/vi/c2HrjkGhlFg/maxresdefault.jpg)](https://youtu.be/c2HrjkGhlFg)

## System requirements

WattSnatch is deliberately lightweight - measured on a real long-running install, it idles at ~140 MB RAM and near-0% CPU between poll ticks (every 15s by default).

| | Minimum | Recommended |
|---|---|---|
| CPU | 1 core, any 64-bit CPU from the last decade | 2+ cores (Raspberry Pi 4 class or better) |
| RAM | 1 GB free | 2 GB+ free |
| Disk | 5 GB free (app + dependencies ≈ 120 MB; database grows ~600 MB/year, telemetry kept 5 years) | 20 GB+ if you want years of history |
| OS | macOS, Linux, or Windows with Node.js 20+ | macOS (gets one-click background-service install and Keychain credential storage) or Linux |
| Network | Wired or Wi-Fi on the **same LAN as your solar meter**, if it's a local-network device (Enphase, Fronius, SPAN, Sungrow) - a cloud VPS won't reach those. SolarEdge (cloud API) and MQTT input have no LAN requirement. | Always-on machine (Mac mini, Pi, home server) |

Two dependencies (`better-sqlite3`, `zeromq`) compile native code during `npm install`, so build tools must be present: Xcode Command Line Tools on macOS, `build-essential python3` on Debian/Ubuntu, or the "Desktop development with C++" workload on Windows.

---

## Quick start

```bash
git clone https://github.com/WattSnatch/wattsnatch.git
cd wattsnatch
npm install
npm run preflight   # checks Node version, build tools, ports, and more - fix anything it flags first
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

Download and install Node.js **version 20 or later** from [nodejs.org](https://nodejs.org). Choose the LTS version.

**On Debian, Ubuntu or Raspberry Pi OS**, `apt install nodejs` gives you Node 18, which is too old - `better-sqlite3` does not support it. Use NodeSource or `nvm` instead; see [INSTALL.md](INSTALL.md#install-nodejs) for the exact commands. You'll also need `git` before cloning: `sudo apt install -y git`.

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

**Then generate the proxy's TLS certificate.** The proxy serves over HTTPS and needs its own certificate. This is separate from the Tesla command-signing keypair the setup wizard creates for you, and is not generated automatically:

```bash
cd /path/to/wattsnatch
openssl req -x509 -nodes -newkey rsa:2048 -sha256 -days 3650 \
  -keyout keys/proxy-tls-key.pem -out keys/proxy-tls-cert.pem \
  -subj "/CN=localhost"
chmod 600 keys/proxy-tls-key.pem
```

Self-signed is fine - the proxy only listens on localhost. Keep `proxy-tls-key.pem` private and never commit it to a public repository. See [INSTALL.md](INSTALL.md#4-build-the-tesla-command-proxy) for the Windows command and more detail.

---

### Step 4 - Create a Tesla Developer account

WattSnatch uses Tesla's official Fleet API, which requires a free developer registration.

1. Go to [developer.tesla.com](https://developer.tesla.com) and sign in with your Tesla account
2. Click **Create Application**
3. Fill in the details:
   - **App name:** WattSnatch (or anything you like)
   - **Purpose:** Personal use / home automation
   - **Website:** a domain you control, e.g. a free GitHub Pages URL - see [INSTALL.md](INSTALL.md#5-register-a-tesla-developer-app) for the full walkthrough including what this is for
4. **Grant type:** enable both Authorization Code and Client Credentials (Machine-to-Machine) - WattSnatch needs both, not just one
5. **Allowed Redirect URI:** `http://localhost:3001/auth/tesla/callback`

   Get this exactly right, including the `/tesla/` part - `/auth/callback` is not a real route and will fail with "Cannot GET" after you log in to Tesla. If you run WattSnatch on a port other than 3001, use that port here instead. You'll enter this same value in the setup wizard, and the two must match exactly.
6. Under **API and Scopes**, tick all of:
   - Vehicle Information
   - Vehicle Location
   - Vehicle Commands
   - Vehicle Charging Management
7. Save and note your **Client ID** and **Client Secret** - you'll enter these in the setup wizard

**If you are not in North America or Asia-Pacific, set your region.** Tesla runs
the Fleet API from separate regional servers, and an account registered in one
region cannot be reached through another - the failures name neither the region
nor your account, so a wrong setting looks like a broken app. Settings → Tesla →
**Fleet API region**:

| Region | Covers |
|---|---|
| `na` (default) | North America **and Asia-Pacific**, including Australia and New Zealand |
| `eu` | Europe, Middle East, Africa |
| `cn` | China |

Australian and US installs need no change; this exists for everyone else.

---

### Step 5 - Host your public key (one-time)

Tesla requires your app's public key to be accessible at a public URL. The easiest free method is GitHub Pages.

Tesla reads the key from the **root** of the domain, at `/.well-known/appspecific/com.tesla.3p.public-key.pem`, so the Pages site has to be a **user site** rather than a project site.

1. Create a **new public GitHub repository** named exactly `YOUR_GITHUB_USERNAME.github.io`. That exact name is what makes it a user site served from the domain root - any other name gives you a project site one level down, which cannot serve the root path Tesla fetches.
2. In the repo's **Settings → Pages**, set source to **Deploy from branch → main**
3. Add an empty `.nojekyll` file to the repo root, or Jekyll will silently drop the `.well-known` folder and the key will 404
4. Your GitHub Pages URL will be: `https://YOUR_GITHUB_USERNAME.github.io`
5. In the **Tesla developer portal**, set your app's **Allowed Origin** to this URL, with no path after it

You don't need to put anything in the repo yet - the setup wizard will generate your key pair and tell you exactly what to paste in.

---

### Step 6 - Run the setup wizard

Start WattSnatch:
```bash
npm start
```

Open **http://localhost:3001** in your browser.

The wizard has 12 steps. Two of them are skipped depending on choices you make, so you won't see all 12:

1. **Welcome** - overview, nothing to enter.
2. **Connect your solar inverter** - pick your brand, then fill in its fields (see the table below). Enphase has a "Find automatically" button that discovers the gateway over your local network.
3. **Authenticate with Enphase** - **Enphase only.** Your Enlighten email and password, plus the gateway serial number from the sticker on the unit. The password is used once to generate a local token and is never stored. Every other brand skips this step entirely.
4. **How should WattSnatch talk to your car?** - choose **Fleet API + Fleet Telemetry** (Tesla's cloud, the default) or **Bluetooth LE** (fully cloud-free, but the machine must be in Bluetooth range of the car). This choice reshapes the remaining steps.
5. **Tesla Developer App** - paste the Client ID and Client Secret from Step 4 above. Fleet API mode also asks for the Redirect URI and the **public key domain** (the bare hostname from Step 5 above, matching your app's Allowed Origin), registers that domain with Tesla, and then sends you through Tesla's login. Registering first is deliberate: Tesla refuses to authorise users for an app whose domain it does not know, and reports it only as "No policy rules" on its own login page, which says nothing about the actual cause. Bluetooth LE mode asks for none of this and registers the domain later, at the public-key step.
6. **Vehicle Connected** - Fleet API confirms the car detected on your Tesla account. Bluetooth LE asks you to type the VIN, since there is no token to look it up with.
7. **Register Public Key with Tesla** - the wizard shows your public key. Put it at `.well-known/appspecific/com.tesla.3p.public-key.pem` on the domain you gave Tesla, then click Verify.
8. **Pair Virtual Key with Car** - required for both modes, and you must do it in person: on an **iPhone**, open Safari to the link shown, tap Add Key, and hold your key card to the console reader. Tesla requires this of every third-party app.
9. **Bluetooth LE Proxy** - **Bluetooth LE only.** Enter and test the URL of your TeslaBleHttpProxy. Fleet API mode skips this.
10. **Charging Preferences** - min/max amps, hold timer, voltage, electricity rate (see Settings reference below).
11. **Install Background Service** - macOS (launchd) and Linux (systemd). Starts WattSnatch automatically on boot, and in Fleet API mode installs the `tesla-proxy` service too. On Windows, use PM2 instead (see below).
12. **Done.**

**What each solar brand asks for in step 2:**

| Brand | Fields | Needs a cloud account? |
|---|---|---|
| **Enphase IQ Gateway** | Gateway IP or hostname | Yes - Enlighten login in step 3 |
| **Fronius** | Inverter IP or hostname | No, local only |
| **SolarEdge** | API Key, Site ID | Yes - from your SolarEdge monitoring account |
| **SPAN Panel** | Panel host or IP, Access Token, Solar Circuit ID | Token from SPAN; unverified against real hardware |
| **Sungrow (SH-series hybrid + WiNet-S)** | Inverter/dongle host or IP, Modbus port, Unit ID | No, local Modbus TCP; unverified against real hardware |
| **MQTT (any other inverter)** | Broker URL, username/password, solar topic, a second grid or consumption topic, plus sign/scale/stale options | No - you publish the readings yourself |

Enphase, Fronius, SPAN and Sungrow are local-network devices, so WattSnatch must be on the same LAN as them. SolarEdge and MQTT have no such requirement.

**Which Sungrow systems this covers.** The Sungrow driver was written against the
**SH-series hybrid** inverters using a **WiNet-S** dongle over local Modbus TCP,
and its register addresses come from EVCC's `sungrow-hybrid` template - they
include battery registers. Two things follow:

- **SG-series string inverters** (SG5K-D and similar) are a different register
  layout and have no battery, so this driver is not expected to work with them.
- **Older dongles**, such as the WiFi V31, generally do not expose Modbus TCP on
  your LAN at all - they upload to iSolarCloud instead. If the dongle never
  appears as a device on your network, that is usually why, and no amount of
  configuration will reach it.

If your Sungrow isn't an SH-series on a WiNet-S, use the **MQTT input** provider
instead: publish your solar and grid figures from whatever already talks to your
inverter (Home Assistant, for example) and WattSnatch drives charging from those
exactly as it would from a native gateway. That path works with any inverter.

If you get interrupted, reopen `http://localhost:3001/setup` and it resumes where you left off.

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
tesla-proxy -cert keys\proxy-tls-cert.pem -tls-key keys\proxy-tls-key.pem -key-file keys\private.pem -port 4443
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
ExecStart=/usr/local/bin/tesla-proxy -cert keys/proxy-tls-cert.pem -tls-key keys/proxy-tls-key.pem -key-file keys/private.pem -port 4443
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
PORT=8085 npm start

# Windows
set PORT=8085 && npm start
```

**If you change the port, update your Tesla Redirect URI to match.** Both the Redirect URI on your app at [developer.tesla.com](https://developer.tesla.com) and the one in the setup wizard need the new port, e.g. `http://localhost:8085/auth/tesla/callback`. A mismatch here fails only at the very end of the Tesla login, which makes it a confusing one to diagnose.

`PORT` is one of five environment variables WattSnatch reads - see [INSTALL.md](INSTALL.md#environment-variables) for the full list, including how to move the database or point at a proxy on a different host.

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

These are the core charging settings. Everything else is configured in the dashboard's Settings page - solar meter brand, home battery, air conditioning, time-of-use rates, calendar, notifications, and Home Assistant. See [FEATURES.md](FEATURES.md) for what each one does.

---

## Troubleshooting

**Gateway / meter: Error**
- Check the address for your meter in Settings (gateway IP for Enphase, inverter IP for Fronius, host for SPAN or Sungrow, API key and site ID for SolarEdge)
- For local-network meters (Enphase, Fronius, SPAN, Sungrow), make sure your server is on the same LAN as the device
- **Enphase:** try regenerating the token in Settings (you'll need your Enlighten email and password again)
- **MQTT input:** check the broker is reachable and that readings are still arriving - the reading goes stale after the timeout you configured, which is treated as an error rather than as zero solar

**`npm run update` runs but the version never changes**
Look for lines like `! [rejected] v1.21.1 -> v1.21.1 (would clobber existing tag)`.
Git refuses to move a tag that already exists locally pointing at different
content, and exits non-zero - which aborts the update script before it pulls
anything. The installed version stays put while the dashboard keeps advertising
a newer one. Fixed from v1.25.0 onward, but if you are updating *from* an
earlier version you need to break the deadlock by hand once:
```bash
git fetch --tags --force
git pull
npm install
```
After that, `npm run update` works normally.

**Fleet Telemetry stops after about 90 days**
Your telemetry certificate expired. A plain `certbot renew` only covers
`/etc/letsencrypt`; the certificate `fleet-telemetry` serves lives in a
user-owned tree and needs renewing separately. Run both, and see everything the
certificate needs, with:
```bash
npm run cert-renew -- --dry-run
```
[TELEMETRY.md](TELEMETRY.md) section 10 covers the whole arrangement - the two
certbot trees, scheduling the renewal job, and the alerts WattSnatch raises when
a renewal fails or the job stops running.

**Setup fails at domain registration with `invalid_audience`**
Tesla is rejecting the partner token request. This is currently affecting newly
created Tesla developer applications and is not something you have
misconfigured. There is no workaround yet. See
[issue #6](https://github.com/WattSnatch/wattsnatch/issues/6) for the current
status, how to confirm you are affected, and what has been ruled out.

Applications created before this started are unaffected, so existing installs
keep working. Bluetooth LE mode does not use partner tokens and is also
unaffected.

**"Something went wrong. Try again later. No policy rules" on Tesla's login page**
This is Tesla saying it will not authorise users for an app whose domain it has
not registered - the message is unrelated to what actually needs fixing. It
means the `partner_accounts` registration has not succeeded for your domain.
- Check your public key is reachable at the domain **root**:
  ```bash
  curl -sI https://YOUR_DOMAIN/.well-known/appspecific/com.tesla.3p.public-key.pem | head -1
  ```
  You want `200`. A `404` usually means either the repo is a project site rather
  than a user site (`USERNAME.github.io`), or the empty `.nojekyll` file is
  missing and GitHub Pages has dropped the `.well-known` folder.
- Confirm the **Public key domain** you entered in wizard step 5 is a bare
  hostname (`yourname.github.io`) and matches the **Allowed Origin** on your
  Tesla app exactly.
- To register by hand at any time:
  ```bash
  curl -s -X POST http://localhost:3001/api/setup/register-partner \
    -H "Content-Type: application/json" \
    -d '{"domain":"yourname.github.io"}'
  ```
  It needs only the Client ID/Secret already saved, and is safe to repeat.

**Tesla API calls fail for no obvious reason, and you are outside North America / Asia-Pacific**
Check Settings → Tesla → **Fleet API region**. Tesla serves the Fleet API from
separate regional deployments and an account registered in one is unreachable
through another. The default (`na`) covers North America and Asia-Pacific
including Australia; European accounts need `eu` and Chinese accounts `cn`.
Symptoms are unhelpful - authentication or vehicle calls fail without naming the
region as the cause.

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
- **Your solar meter** - Enphase contacts Enphase's cloud only once during setup to mint a local token, after which all readings come straight from the gateway on your LAN. Fronius, SPAN, Sungrow and MQTT input are local-network only and never leave your network. SolarEdge is the exception: it has no local API, so readings are polled from SolarEdge's cloud monitoring service for as long as you use it.

Your Tesla OAuth tokens and Enphase tokens are encrypted at rest using AES-256. Telemetry history is retained for 5 years (the Data page's last-quarter and last-year views read from it), event logs for 90 days, and charge session records indefinitely. On a real install, telemetry grows the database by roughly 1.7 MB per day, or about 600 MB per year - worth knowing if you're running from a small SD card.

---

## Architecture overview

```
Solar meter (Enphase / Fronius / SolarEdge / SPAN / Sungrow / MQTT)
    ↓ polling every 15s (local LAN, or cloud API for SolarEdge)
WattSnatch server (Node.js / Express / SQLite)
    ↓ SSE push
Browser dashboard (vanilla JS)

Tesla Fleet API (cloud)
    ↓ vehicle state
WattSnatch controller
    ↓ charge commands
Tesla proxy (local, port 4443) → signs with EC private key → Tesla cloud → car
```

Reading vehicle state and sending commands are separate paths that share nothing, so
either can fail while the other keeps working. By default state comes from polling the
Fleet API. If you also run Fleet Telemetry (optional, see
[INSTALL.md](INSTALL.md#real-time-telemetry---tesla-fleet-telemetry-advanced-optional)),
the car pushes to your own server instead:

```
car → :443 (raw TCP passthrough) → fleet-telemetry :9443 → ZeroMQ :5678 → WattSnatch
```

That path needs a CA-signed certificate on a public domain, and **it must be renewed on
a schedule**. When it lapses the car simply stops connecting and WattSnatch falls back to
polling - you get stale data rather than an error.

---

## License

WattSnatch is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE). You're free to run, modify, and adapt it for your own household - personal, non-commercial use is explicitly permitted. Any commercial use (selling it, hosting it as a paid service, bundling it into a product, paid support/managed services, or building a competing commercial product) requires a separate commercial license - see the [LICENSE](LICENSE) file for details.

WattSnatch itself plans to offer official paid installation and support services directly - see [COMMERCIAL.md](COMMERCIAL.md) for how that fits alongside the license, and what counts as third-party commercial use versus an official WattSnatch service.
