# Installing WattSnatch - Self-Hosting Guide

This is a complete, from-scratch guide to running your own instance of WattSnatch. It's written for someone who has never seen the codebase before.

WattSnatch is **one required core** (Enphase solar monitoring + Tesla charge control) plus a set of **optional integrations** (hot water, air-con, calendar-aware trip planning, bill parsing, notifications, Home Assistant, etc.). You can run just the core in about 30–45 minutes; each optional integration adds its own setup time on top. This guide covers all of it, clearly marked.

---

## Table of contents

1. [What you need before you start](#1-what-you-need-before-you-start)
2. [System requirements](#2-system-requirements)
3. [Install Node.js and the app](#3-install-nodejs-and-the-app)
   - [Tesla vehicle connection: Fleet API vs. Bluetooth LE](#tesla-vehicle-connection-fleet-api-vs-bluetooth-le)
4. [Build the Tesla command proxy](#4-build-the-tesla-command-proxy)
5. [Register a Tesla developer app](#5-register-a-tesla-developer-app)
6. [Host your public key](#6-host-your-public-key)
7. [Run the setup wizard](#7-run-the-setup-wizard)
8. [Pair the virtual key with your car](#8-pair-the-virtual-key-with-your-car)
9. [Run WattSnatch as a background service](#9-run-wattsnatch-as-a-background-service)
10. [Set a dashboard password](#10-set-a-dashboard-password)
11. [Optional integrations](#11-optional-integrations)
12. [Exposing the dashboard outside your home network](#12-exposing-the-dashboard-outside-your-home-network)
13. [Updating](#13-updating)
14. [Uninstalling](#14-uninstalling)
15. [Troubleshooting](#15-troubleshooting)
16. [Current self-hosting limitations](#16-current-self-hosting-limitations)

---

## 1. What you need before you start

**Hardware:**
- An **Enphase IQ Gateway (Envoy)** on your local network, with an Enlighten account (email + password) that has access to it.
- A **Tesla vehicle**.
- A machine to run the server that can stay on continuously - a Mac Mini, an old laptop, a NUC, a Raspberry Pi 4+, or a cheap always-on Linux box all work. It must be on the **same local network** as your Enphase gateway (the gateway is only reachable over LAN).

**Accounts (all free):**
- A free [Tesla developer account](https://developer.tesla.com) (uses your normal Tesla login).
- A place to publicly host one static text file - a free **GitHub Pages** site is the easiest option and is what this guide uses. (Tesla requires your app's public key to be reachable at a public HTTPS URL; it does not need to be the same machine running WattSnatch.)

**Time:** budget 30–45 minutes for the core install, longer if this is your first time using GitHub Pages or the Tesla developer portal.

---

## 2. System requirements

WattSnatch is lightweight. Measured on a real long-running install: ~140 MB RAM at steady state, near-0% CPU between poll ticks, and a database that grows to roughly 100 MB over months (old telemetry is auto-pruned after 7 days).

| | Minimum | Recommended |
|---|---|---|
| CPU | 1 core, any 64-bit CPU | 2+ cores - a Raspberry Pi 4, old laptop, NUC, or Mac mini is plenty |
| RAM | 1 GB free | 2 GB+ free |
| Disk | 2 GB free (app + dependencies ≈ 120 MB, database ≈ 100 MB after months) | 5 GB free |
| OS | macOS, Windows, or Linux | macOS or Linux for an always-on install (macOS additionally gets the one-click background-service installer and Keychain credential storage) |
| Node.js | v18 or later (LTS recommended) | Latest LTS |
| Build tools | A C/C++ compiler toolchain - two dependencies (`better-sqlite3`, `zeromq`) compile native code during `npm install` if no prebuilt binary exists for your platform | - |
| Network | Same LAN as your Enphase gateway (hard requirement - a cloud VPS won't work); outbound internet for the Tesla Fleet API | Wired Ethernet on an always-on machine |

**Build tools by platform:**
- **macOS:** install Xcode Command Line Tools: `xcode-select --install`
- **Windows:** install the "Desktop development with C++" workload from Visual Studio Build Tools, or run `npm install --global windows-build-tools` from an elevated prompt (Node docs have current guidance - this changes over time)
- **Linux (Debian/Ubuntu):** `sudo apt install build-essential python3`

If `npm install` fails partway through with a `node-gyp` or compiler error, this is almost always the cause - install the build tools above and re-run `npm install`.

---

## 3. Install Node.js and the app

### Install Node.js
Download the LTS installer from [nodejs.org](https://nodejs.org) for your OS, or use a version manager (`nvm`, `fnm`). Confirm it worked:
```bash
node --version   # should print v18.x.x or later
npm --version
```

### Get the code
```bash
git clone https://github.com/WattSnatch/wattsnatch.git
cd wattsnatch
npm install
```

`npm install` will take a minute or two - it's compiling `better-sqlite3` and `zeromq` for your machine.

---

## Tesla vehicle connection: Fleet API vs. Bluetooth LE

Before building anything, decide how WattSnatch should talk to your car - the setup wizard asks this too (step 4), and it changes which proxy you build below and what the rest of setup looks like.

| | Fleet API + Fleet Telemetry (default) | Bluetooth LE (fully cloud-free) |
|---|---|---|
| Vehicle commands (start/stop/amps/limit) | Sent via Tesla's cloud Fleet API | Sent directly to the car over Bluetooth, no cloud hop |
| Vehicle state (battery, charging status) | Live push from Fleet Telemetry (needs its own always-on streaming server - see [Real-time telemetry](#real-time-telemetry---tesla-fleet-telemetry-advanced-optional)) | Polled over Bluetooth every ~30 seconds |
| Range | Anywhere the car has signal | Only while the car is within Bluetooth range of whichever machine runs TeslaBleHttpProxy (a few metres, i.e. at home) |
| Geofencing | GPS-based (home lat/lon + radius) | Automatic - Bluetooth range itself is the geofence |
| Requires a live Tesla OAuth token | Yes | No - only for the one-time developer app registration below |
| What you build | `tesla-http-proxy` (this section) | [TeslaBleHttpProxy](https://github.com/wimaha/TeslaBleHttpProxy) (same idea, different binary) |
| Supported platform for the proxy | macOS, Linux, Windows | **Linux only in practice** - see the macOS warning below |

**Both paths still need the same one-time Tesla developer app, EC keypair, and virtual key paired to your car** (sections 5-8 below) - that's Tesla's own security requirement for any app that wants to send signed commands, and it's identical either way. Bluetooth LE only skips the *ongoing* cloud dependency: no Fleet Telemetry server to run, no Fleet API calls once you're set up, and the setup wizard skips the OAuth login itself (you'll enter your VIN manually instead of it being auto-detected).

> **⚠️ Bluetooth LE's proxy does not practically run on macOS.** TeslaBleHttpProxy needs macOS's CoreBluetooth framework, which refuses to run unsigned or ad-hoc-signed binaries (`codesign --sign -`) before the OS even offers a Bluetooth permission prompt - confirmed via `~/Library/Diagnostic Reports` crash logs and the unified log showing an AMFI (`AppleMobileFileIntegrityError`, code -423) rejection, not a TCC/permissions issue. A real paid Apple Developer ID signing certificate fixes it in principle; the practical answer for a self-hosted project is to **run TeslaBleHttpProxy on a Linux machine instead** (a Raspberry Pi near the car works well) and point `tesla_ble_proxy_url` at that machine's LAN address - it does not need to be the same machine WattSnatch itself runs on. WattSnatch's own server has no such restriction and runs fine on macOS regardless of which backend you choose.

If you're not sure, start with Fleet API - it's simpler to set up (no separate proxy binary to build, no extra machine needed) and works from anywhere. Switch to Bluetooth LE later from Settings if you decide you want a cloud-free setup; nothing about the choice is permanent.

---

## 4. Build the Tesla command proxy

Tesla's vehicle-command security model requires charging commands to be cryptographically signed locally before they reach Tesla's servers. WattSnatch doesn't sign commands itself - it delegates to Tesla's own open-source `tesla-http-proxy` binary, which must run alongside WattSnatch on the same machine.

**Using Bluetooth LE instead?** Skip this section - the wizard's Bluetooth LE step (step 9) covers building [TeslaBleHttpProxy](https://github.com/wimaha/TeslaBleHttpProxy) instead, which reuses the same key you generate in step 7 below. Build it on a **Linux** machine, not macOS - see the warning above.

**macOS:**
```bash
brew install go
git clone https://github.com/teslamotors/vehicle-command.git
cd vehicle-command
go build ./cmd/tesla-http-proxy
cp tesla-http-proxy /path/to/wattsnatch/tesla-proxy
cd ..
```

**Windows:**
1. Install Go from [go.dev/dl](https://go.dev/dl/).
2. Open a **new** Command Prompt (so Go is on PATH):
```
git clone https://github.com/teslamotors/vehicle-command.git
cd vehicle-command
go build ./cmd/tesla-http-proxy
```
3. Copy `tesla-http-proxy.exe` into your `wattsnatch` folder and rename it `tesla-proxy.exe`.

**Linux:**
```bash
sudo apt install golang-go git
git clone https://github.com/teslamotors/vehicle-command.git
cd vehicle-command
go build ./cmd/tesla-http-proxy
cp tesla-http-proxy /path/to/wattsnatch/tesla-proxy
cd ..
```

The setup wizard (step 7) will generate an EC keypair and TLS certificate for this proxy automatically - you don't need to do that by hand.

---

## 5. Register a Tesla developer app

1. Go to [developer.tesla.com](https://developer.tesla.com) and sign in with your normal Tesla account.
2. Click **Create Application**.
3. Fill in:
   - **App name:** anything (e.g. "WattSnatch")
   - **Purpose:** Personal use / home automation
4. Under **API and Scopes**, enable:
   - Vehicle Information
   - Vehicle Location
   - Vehicle Commands
   - Vehicle Charging Management
5. Set the **Redirect URI** - this must match what you'll enter in the setup wizard. If you're only running this locally, `http://localhost:3001/auth/callback` is fine. If you'll access it via a domain, use that domain instead.
6. Save the app and note your **Client ID** and **Client Secret** somewhere safe - you'll paste these into the setup wizard in step 5 below. (If you're planning to use Bluetooth LE - see [below](#tesla-vehicle-connection-fleet-api-vs-bluetooth-le) - the Redirect URI doesn't matter since you'll never complete the OAuth login, but the developer app registration itself is still required.)

---

## 6. Host your public key

Tesla requires your app's EC public key to be reachable at:
```
https://<your-domain>/.well-known/appspecific/com.tesla.3p.public-key.pem
```

The easiest free way to satisfy this is **GitHub Pages**, and it does **not** need to be the same machine or domain your WattSnatch dashboard runs on - this is purely to satisfy Tesla's verification requirement.

1. Create a new **public** GitHub repository (e.g. `wattsnatch-key`).
2. In **Settings → Pages**, set source to **Deploy from branch → main**.
3. Your Pages URL will be `https://YOUR_GITHUB_USERNAME.github.io/wattsnatch-key`.
4. You don't need to add the key file yet - the setup wizard will show you the exact key contents to paste in once it's generated (step 7 of the wizard).

---

## 7. Run the setup wizard

Start the server:
```bash
npm start
```

Open **http://localhost:3001** in a browser on the same machine (or any device on your LAN, using the server's local IP instead of `localhost`). The wizard walks through 12 steps, branching at step 4 depending on whether you choose Fleet API or Bluetooth LE (see [Tesla vehicle connection: Fleet API vs. Bluetooth LE](#tesla-vehicle-connection-fleet-api-vs-bluetooth-le) below):

| Step | What it does |
|---|---|
| 1 | Welcome / overview |
| 2 | Choose your inverter brand - Enphase (gateway IP + serial, with "Find automatically" LAN discovery), Fronius, SolarEdge, or **MQTT (other)** to feed any inverter in over MQTT (see [MQTT solar input](#mqtt-solar-input-any-unsupported-inverter)). |
| 3 | Enter your Enlighten account email + password once - this generates a local access token; **your password itself is never stored.** |
| 4 | Choose **Fleet API + Fleet Telemetry** or **Bluetooth LE** - this sets how WattSnatch reads and controls your car for the rest of setup |
| 5 | Paste your Tesla Client ID / Client Secret from the developer app you registered. **Fleet mode** also asks for a Redirect URI and clicking through completes Tesla's OAuth login in your browser; **Bluetooth LE mode** only needs the Client ID/Secret and never leaves this page |
| 6 | **Fleet mode:** confirms the vehicle detected via your Tesla account (falling back to manual VIN entry if that fails). **Bluetooth LE mode:** enter your VIN directly - there's no token to auto-detect it with |
| 7 | Copy the generated public key, add it to your GitHub Pages repo at the path above, then click Verify. **Bluetooth LE mode** also has a required "Register domain with Tesla" button here - Fleet mode registers this automatically as part of step 6 if needed |
| 8 | Pair a virtual key with the car (see the pairing section below - must be done from your phone, near the car). Required for both paths |
| 9 | **Bluetooth LE mode only:** enter your BLE proxy URL and test connectivity to the TeslaBleHttpProxy process you built and are running (see below). Fleet mode skips straight to step 10 |
| 10 | Set your charging preferences (min/max amps, hold timer, charger voltage, electricity rate - see the Settings reference in `README.md` for what each does) |
| 11 | (macOS/Linux) install WattSnatch as a background service. Fleet mode also installs the Tesla-signing proxy service; Bluetooth LE mode skips it since it isn't used |
| 12 | Done |

If you get interrupted partway through, just reopen `http://localhost:3001/setup` - it resumes where you left off using what's already saved.

---

## 8. Pair the virtual key with your car

This is a Tesla requirement for **any** third-party app that wants to send charging commands - it's not specific to WattSnatch, and confirms physical possession of the car.

1. On your **iPhone**, open Safari and navigate to:
   `https://tesla.com/_ak/<your-key-hosting-domain>` (the wizard shows you the exact URL - it's built from the domain you entered in step 7).
2. The Tesla app opens - tap **Add Key**.
3. Tap your physical Tesla key card (or phone key) against the centre console reader to confirm.
4. Return to the wizard and continue.

You must be at the car for this step. Android users: Tesla's virtual key flow is iOS-only at the time of writing - pair using an iPhone if you don't own one, or ask someone who does.

---

## 9. Run WattSnatch as a background service

The setup wizard's Install Background Service step (step 11) handles this automatically on **macOS** (installs LaunchAgents for both WattSnatch and the Tesla proxy, set to start on login and restart on crash) or **Linux** (systemd units). If you chose Bluetooth LE for both command backend and vehicle state, the Tesla-signing proxy service is skipped since it's never used - keep your own TeslaBleHttpProxy process running instead (see below).

**Check it's running:**
```bash
launchctl list | grep wattsnatch
```

**Windows - using PM2:**
```
npm install -g pm2
pm2 start src/server.js --name wattsnatch
pm2 save
pm2 startup
```
Run whatever command `pm2 startup` prints - it registers PM2 with Windows startup. For the Tesla proxy, create `start-proxy.bat`:
```bat
tesla-proxy.exe -cert keys\proxy-tls-cert.pem -key keys\proxy-tls-key.pem -port 4443
```
```
pm2 start start-proxy.bat --name tesla-proxy
pm2 save
```

**Linux - using systemd:**

`/etc/systemd/system/wattsnatch.service`:
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

`/etc/systemd/system/tesla-proxy.service`:
```ini
[Unit]
Description=Tesla Command Proxy
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/path/to/wattsnatch
ExecStart=/path/to/wattsnatch/tesla-proxy -cert keys/proxy-tls-cert.pem -key keys/proxy-tls-key.pem -port 4443
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now wattsnatch tesla-proxy
```

---

## 10. Set a dashboard password

**By default, a fresh install has no login password** - anyone who can reach the dashboard's URL can use it. Set one before you rely on this daily, and especially before exposing it beyond your own LAN:

Go to **Settings → change password** in the dashboard (or `POST /api/auth/change-password` directly), and set a password of at least 8 characters. This is a single shared password, not a multi-user account system.

Repeated failed login attempts trigger an escalating lockout (30 seconds, then 5
minutes, then 30 minutes) to slow down brute-force attempts. If you're locked out or
have forgotten your password, run this on the machine hosting the app:

```bash
npm run reset-password -- <new-password>   # set a new password
npm run reset-password -- --clear          # or remove the password entirely
```

Both also clear any active lockout.

---

## 11. Optional integrations

None of these are required for core solar → EV charging to work. Add them as you want the extra features.

### Hot water diversion - myenergi Eddi
**Needs:** your Eddi hub serial number and myenergi API key (from the myenergi app account settings).
Enter both in **Settings → myenergi**. Polls every 30 seconds once configured.

### Air-conditioning monitoring - MELCloud
**Needs:** your MELCloud account email + password (the same one used in the official MELCloud/MELView app).
Enter in **Settings → MELCloud**; credentials are stored in your OS's secure credential store (macOS Keychain, etc. via `keytar`), not the database.

### Calendar-aware trip planning - iCloud, Google, or Outlook
Pick one provider in **Settings → Calendar**; only one is active at a time.

- **iCloud** - an Apple ID email + an **app-specific password** (generate one at [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific Passwords - do **not** use your real iCloud password). You can restrict which calendars are scanned by name.
- **Google Calendar** - your own OAuth app: create one at [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials), enable the "Google Calendar API", and add `http://<wattsnatch-host>:3001/auth/google-calendar/callback` as an authorized redirect URI. Enter the Client ID/Secret/Redirect URI in Settings, save, then click **Connect Google Calendar** and sign in with your own Google account.
- **Outlook / Microsoft 365** - your own Azure App Registration at [portal.azure.com](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade), with the `Calendars.Read` delegated Graph permission and `http://<wattsnatch-host>:3001/auth/outlook-calendar/callback` as a redirect URI. Enter the credentials in Settings, save, then click **Connect Outlook Calendar**.

Each provider lives in its own file under `src/services/calendar/` (`icloud.js`, `google.js`, `outlook.js`), following the same swappable-adapter pattern as the solar inverter integrations in `src/services/meters/` - adding another calendar source means dropping in a new file there, not touching the shared trip-planning logic in `src/services/calendar.js`.

### Google Maps API - accurate driving distance (optional)
By default, trip planning geocodes calendar event locations via OpenStreetMap Nominatim (free, no key needed) and estimates each trip as straight-line distance. Adding a Google Maps API key upgrades both steps:

- **Geocoding API** - location-biased to your home coordinates, so short/ambiguous addresses (e.g. a suburb name that also exists in another state) are far less likely to resolve to the wrong place.
- **Routes API** - real driving distance and time instead of straight-line, using traffic-aware routing (so it matches what you'd see searching the same route in Google Maps).

**Setup:**
1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and create a project (or use an existing one).
2. Under **APIs & Services → Library**, enable both the **Geocoding API** and the **Routes API**. (The older "Distance Matrix API" is not used and Google now rejects it for new projects - make sure it's specifically **Routes API**.)
3. Under **APIs & Services → Credentials**, create an **API key**. It's strongly recommended to restrict it (under "API restrictions") to only those two APIs, so the key can't be used for anything else if it ever leaks.
4. Paste the key into **Settings → Calendar → Google Maps API key** and save.

If no key is set, or a Google call fails for any reason, WattSnatch automatically falls back to the free Nominatim/straight-line path - this is a pure upgrade, never a requirement. Every trip distance also gets rounded **up** to the nearest whole km before it's used for energy planning, as a small deliberate safety buffer against undercharging.

### Solar forecasting - Solcast
**Needs:** a free [Solcast](https://solcast.com) hobbyist account, giving you an API key and a Resource ID for your specific rooftop site (set up on their site using your panel array's location/tilt/azimuth).
Free tier allows 10 API calls/day, which is what WattSnatch is tuned to stay within.

### Electricity bill parsing
**Needs:**
1. A free [Google AI Studio](https://aistudio.google.com) Gemini API key (used to extract structured data from bill PDFs).
2. A working mechanism to get bill emails into WattSnatch as PDF attachments.

The second part is **not turnkey out of the box** - the reference implementation forwards bill emails through a small Cloudflare Worker as an email-to-webhook bridge, which isn't included in this repository. Until you build an equivalent, use the **manual PDF upload** button on the Bills page instead - paste your Gemini API key in Settings and upload bills yourself as they arrive.

### Push notifications - ntfy
**Needs:** nothing to sign up for. [ntfy.sh](https://ntfy.sh) is free, or self-hostable. Pick any unguessable topic name (it's unauthenticated by default - anyone who knows the topic name can read it, so make it a random string, not "wattsnatch"), enter the ntfy server URL (default `https://ntfy.sh`) and your topic name in **Settings → Notifications**, and install the ntfy app on your phone subscribed to that same topic.

### MQTT solar input - any unsupported inverter
If WattSnatch doesn't natively support your inverter yet, you can feed it live readings over MQTT and it drives charging exactly as it would from a native gateway. In the setup wizard's inverter step, pick **MQTT (other)** and provide:

- **Broker URL** (e.g. `mqtt://192.168.1.50:1883`, or `mqtts://` for TLS) and optional username/password.
- **Solar production topic** - publishes a plain number in watts.
- **Second signal** - either your **net grid power** or your **house consumption** topic (WattSnatch derives the third value). For a grid topic, tell it whether positive means importing or exporting; there's also a watts/kW scale.

Most people already expose these values in Home Assistant, [solar-assistant](https://solar-assistant.io), or an ESPHome energy meter - publish them to any broker and point WattSnatch at the topics.

> **Fail-safe:** if no fresh message arrives within the stale timeout (default 60s), WattSnatch treats the feed as a dead gateway and stops adjusting the charge rate rather than acting on frozen numbers. Set the timeout comfortably above your source's publish interval.

### Home Assistant integration (MQTT output)
In the other direction, the live power-flow MQTT publisher is off until configured. Set your broker details once via the settings API (or Settings page) and restart:

```bash
curl -X POST http://localhost:3001/api/settings -H "Content-Type: application/json" \
  -d '{"mqtt_broker_url":"mqtt://<broker-ip>:1883","mqtt_username":"<user>","mqtt_password":"<pass>"}'
```

WattSnatch then publishes retained `wattsnatch/power/*` topics (solar, grid, consumption, ev, eddi, house) every tick, ready to consume as MQTT sensors in Home Assistant.

The companion **car home/away sensor** for Home Assistant (`GET /api/car/location`) is fully self-service: set an `ha_link_key` value in Settings, then configure a HA `rest` sensor pointing at `http://<wattsnatch-host>:3001/api/car/location?key=<your-key>`.

### TeslaMate integration (drive history, solar-attributed drives)
**Needs:** a separate, already-running [TeslaMate](https://github.com/teslamate-org/teslamate) instance (its own Docker Compose stack - not something WattSnatch installs for you) with **network access from the WattSnatch machine to TeslaMate's PostgreSQL port**. Enter the Postgres connection details in **Settings → TeslaMate**. This is read-only - WattSnatch never writes to TeslaMate's database.

### Real-time telemetry - Tesla Fleet Telemetry (advanced, optional)
By default, WattSnatch gets vehicle data by **polling the Tesla REST API** as a fallback whenever its faster telemetry path is unavailable (every ~2 minutes while it's needed). This works out of the box with no extra setup and is genuinely fine for most people.

For real-time (sub-second) updates instead, Tesla offers a **Fleet Telemetry** push feed - but standing this up yourself requires:
- Your **own public domain name** with a valid CA-signed TLS certificate (Tesla will not connect to a self-signed cert)
- Running [Tesla's `fleet-telemetry` server binary](https://github.com/teslamotors/fleet-telemetry) somewhere publicly reachable on port 443
- Registering that hostname with your Tesla developer app and sending a `fleet_telemetry_config` request (WattSnatch's setup route for this currently has one maintainer's domain **hardcoded** - see [section 16](#16-current-self-hosting-limitations))

Treat this as a follow-up project once the core app is working, not a day-one requirement.

---

## 12. Exposing the dashboard outside your home network

By default WattSnatch is LAN-only (`http://<local-ip>:3001`). If you want to check it from outside your home:
- **Recommended:** a reverse-proxy tunnel with automatic HTTPS - e.g. Cloudflare Tunnel, Tailscale, or a reverse proxy (Caddy/nginx) in front of the Node process terminating TLS.
- **Set a dashboard password first** (section 10) - don't expose an unauthenticated instance to the internet.
- Avoid port-forwarding port 3001 directly on your router without HTTPS in front of it; the login form submits a plaintext password over whatever transport you expose.

---

## 13. Updating

**macOS/Linux - one command:**
```bash
cd wattsnatch
npm run update
```
This backs up your database and keys first (see below), then runs `git pull` and `npm install`, then tells you the exact restart command for your platform. It stops (`set -e`) on the first failure instead of leaving things half-updated.

**Windows** (or if you'd rather run it by hand):
```bash
cd wattsnatch
npm run backup
git pull
npm install
```
Then restart the service (`pm2 restart wattsnatch` on Windows, `launchctl kickstart -k gui/$(id -u)/com.YOURUSERNAME.wattsnatch` on macOS, `sudo systemctl restart wattsnatch` on Linux).

**Backing up first matters.** A bad update is a 10-second recovery if you have a recent backup, and a much bigger problem if you don't. `npm run backup` (or the Download Backup button in Settings → Backup & Restore) writes a zip of your database and `keys/` folder to `~/.solarcharge/backups/` - it does *not* include credentials stored in your OS's secure keychain (myenergi/MELCloud/iCloud), which stay on this machine regardless.

WattSnatch also **backs itself up automatically once a day** (on by default - see Settings → Backup & Restore), so `npm run update`'s pre-update backup is a belt-and-braces extra, not your only line of defence. Automatic backups live in `~/.solarcharge/backups/auto/` with daily snapshots for a week, thinning to one per week for ~3 months before being pruned - no manual cleanup needed.

**Rolling back:**
```bash
git tag --list                 # find the version you want to go back to
git checkout <previous-tag>
npm install
npm run restore -- <path-to-a-backup-zip>
```
`npm run restore` takes its own safety snapshot of the *current* state before touching anything, so a restore is itself undoable if you picked the wrong backup.

**Encrypting a backup:** add `--encrypt` to `npm run backup` (or use the password field next to Download Backup in Settings) to password-protect the zip with AES-256-GCM before it's written. Do this for any backup that's going to leave this machine - it bundles your Tesla command key alongside the database. `npm run restore` auto-detects a `.enc` file and prompts for the password. There is no password recovery - losing it makes that backup permanently unreadable, so keep it somewhere separate from the backup file itself.

**Update notifications:** the dashboard checks GitHub's public releases API roughly twice a day (no personal data sent - just an anonymous request for the latest tag) and shows a badge in the top bar if a newer version is available. Turn this off in Settings → Backup & Restore if you'd rather not.

---

## 14. Uninstalling

**macOS:**
```bash
launchctl unload ~/Library/LaunchAgents/com.YOURUSERNAME.wattsnatch.plist
launchctl unload ~/Library/LaunchAgents/com.YOURUSERNAME.wattsnatch.proxy.plist
rm ~/Library/LaunchAgents/com.YOURUSERNAME.wattsnatch*.plist
```
**Windows:** `pm2 delete wattsnatch tesla-proxy && pm2 save`
**Linux:** `sudo systemctl disable --now wattsnatch tesla-proxy`

Then delete the project folder. Consider revoking WattSnatch's access at [tesla.com/teslaaccount/security](https://tesla.com/teslaaccount/security) under Third-Party Apps if you're not reinstalling.

---

## 15. Troubleshooting

**`npm install` fails on `better-sqlite3` or `zeromq`**
Missing build tools - see [System requirements](#2-system-requirements) above, then `npm install` again.

**Gateway shows "Error"**
Confirm the server can reach the Enphase gateway's local IP (same subnet), and try regenerating the Enphase token in Settings.

**Tesla shows "Error"**
Re-authorize from Settings. If that fails, revoke WattSnatch at [tesla.com/teslaaccount/security](https://tesla.com/teslaaccount/security) → Third-Party Apps, then redo the OAuth step from scratch.

**Charging commands don't do anything**
The `tesla-proxy` process must be running alongside the main app at all times - check its service status separately from the main app's.

**Car shows "Asleep" when it's clearly awake**
Tesla's cloud state can lag up to ~60 seconds behind reality. If it's persistent, check the car's own cellular/Wi-Fi signal.

**Port 3001 already in use**
```bash
PORT=8080 npm start        # Mac/Linux
set PORT=8080 && npm start # Windows
```

---

## 16. Current self-hosting limitations

Since this project may go open source, here's an honest list of what still assumes the original maintainer's environment and would need generalizing (or working around) by a new self-hoster:

| Item | File | Issue |
|---|---|---|
| Fleet Telemetry hostname | `src/routes/setup.js` (`send-telemetry-config`) | Hardcodes one maintainer's telemetry server domain. Real-time telemetry (section 11) isn't usable out of the box until this is made configurable - the REST-polling fallback works fine without it. |
| Bill-email ingestion | `src/services/billPoller.js` + `db.js` default `cf_worker_url` | No included mechanism to get bill emails into the app; relies on an external Cloudflare Worker not in this repo. Manual PDF upload works today as a substitute. |
| Single shared password | `src/middleware/sessionAuth.js` | One dashboard password for the whole household, not per-user accounts. Fine for a home LAN, worth knowing before wider deployment. |
| Timezone assumptions | `aiInsights.js`, `notifications.js`, `dashboard.js`, `retailerComparison.js` | Timestamp formatting in AI briefings and notifications is hardcoded to `Australia/Brisbane` (AEST). Core charging logic uses the server's local clock and works anywhere; only the display strings in those features assume AEST until made configurable. |

None of these block the **core** solar-diversion feature - they only affect specific optional integrations.

---

## A note on Tesla Fleet API costs

Tesla's Fleet API is not unconditionally free at high call volumes - Tesla publishes a monthly free allowance per developer account, beyond which per-call charges apply (separately for "commands," "data," and "wake" calls, priced per Tesla's own developer pricing page, which varies by region and changes over time - check [developer.tesla.com](https://developer.tesla.com) for current figures rather than relying on any number quoted here). WattSnatch is tuned to stay well inside typical free-tier limits for one vehicle under normal solar-charging patterns (Tesla commands are throttled to a 10-second cadence, and the REST fallback path only polls when telemetry is stale), but it's worth knowing this is a live cloud API with a cost model, not a flat-rate local integration like the Enphase gateway.
