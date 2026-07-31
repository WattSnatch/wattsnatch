# Installing WattSnatch with an AI coding agent

This file exists so a capable coding agent (Claude Code, Cursor, or similar) can install and
configure WattSnatch largely on its own, stopping only at the points that genuinely require a
human - an account login, a password only the user should type, or physical presence at the car.

**If you're an agent reading this:** follow the phases in order. Each step is marked:

- ✅ **Agent** - you can run this yourself right now.
- 🔑 **User (credentials)** - this step submits a password, API key, or account secret somewhere.
  Do not type, hold, or transmit the user's credential yourself, even transiently in a request
  body you construct. Tell the user the exact command or screen, and have them run/enter it, or
  paste you back only the *non-secret* result (e.g. "done" or an error message) - never the
  secret itself.
- 🌐 **User (browser)** - an OAuth/consent flow on someone else's site. You cannot complete this
  even if you have browser automation tools; it requires the user's own login and (often) 2FA.
- 🚗 **User (physical)** - requires being at the car in person, on an iPhone.

Stop and clearly report which step you've reached whenever you hit a 🔑, 🌐, or 🚗 step. Resume
once the user confirms it's done.

---

## Phase 0 - Confirm the target machine

WattSnatch's Enphase gateway must be reachable on the **local network** the install machine is
on - it will not work installed on a cloud VPS talking to a home gateway remotely. Confirm with
the user that you are running on (or have a shell into) the actual machine that will run
WattSnatch day to day, on the same LAN as their Enphase gateway.

---

## Phase 1 - Core install ✅

```bash
node --version   # must be v18+; if missing or older, stop and ask the user to install it
git clone https://github.com/WattSnatch/wattsnatch.git
cd wattsnatch
npm install
```

If `npm install` fails on `better-sqlite3` or `zeromq` with a `node-gyp`/compiler error, install
build tools for the platform first (macOS: `xcode-select --install`; Debian/Ubuntu:
`sudo apt install build-essential python3`; Windows: the "Desktop development with C++"
workload), then re-run `npm install`.

Then run the pre-flight check and confirm it exits 0 before proceeding - it checks Node version,
native module compilation, port availability, filesystem permissions, keyring/credential storage,
mDNS, and internet connectivity all at once, so any environment problem surfaces here with a clear
fix rather than as a confusing failure partway through setup:

```bash
npm run preflight
```

If it exits non-zero, fix whatever it reports (it tells you exactly what) and run it again before
continuing - don't proceed with a failing pre-flight check.

```bash
node -e "console.log('install dir:', process.cwd())"
npm start &
sleep 2
curl -s http://localhost:3001/api/setup/inverter-brands
```

A JSON response with `"ok": true` confirms the server is up and the setup API is reachable.

---

## Phase 2 - Choose Fleet API or Bluetooth LE, then build the matching proxy ✅

Ask the user first (don't assume): **Fleet API + Fleet Telemetry** (default - cloud-based, works
from anywhere, needs an ongoing Fleet Telemetry streaming server for live vehicle state) or
**Bluetooth LE** (fully cloud-free - no Fleet Telemetry, no ongoing Fleet API calls, no Tesla
OAuth token needed once set up, but only works while the car is within Bluetooth range, i.e. at
home). Both still need the same one-time Tesla developer app, EC keypair, and virtual key pairing
below - that part is Tesla's own security requirement and is identical either way.

**Fleet API** - build `tesla-http-proxy`:
```bash
# macOS
brew install go
git clone https://github.com/teslamotors/vehicle-command.git /tmp/vehicle-command
cd /tmp/vehicle-command && go build ./cmd/tesla-http-proxy
cp tesla-http-proxy /path/to/wattsnatch/tesla-proxy

# Linux
sudo apt install golang-go git
git clone https://github.com/teslamotors/vehicle-command.git /tmp/vehicle-command
cd /tmp/vehicle-command && go build ./cmd/tesla-http-proxy
cp tesla-http-proxy /path/to/wattsnatch/tesla-proxy
```
Windows: install Go from go.dev/dl, open a **new** terminal so PATH picks it up, then the same
`git clone` + `go build` - copy `tesla-http-proxy.exe` into the wattsnatch folder as
`tesla-proxy.exe`. This one you may need to ask the user to run if your shell can't invoke a
freshly-installed `go` in the same session.

**Bluetooth LE** - build [TeslaBleHttpProxy](https://github.com/wimaha/TeslaBleHttpProxy) instead
(same signing key, different binary, no cloud calls at runtime):

**⚠️ Build and run this on Linux, never macOS, even if that's where WattSnatch itself is running.**
TeslaBleHttpProxy needs macOS's CoreBluetooth framework, which rejects unsigned/ad-hoc-signed
binaries with a silent `SIGABRT` before ever offering a Bluetooth permission prompt (confirmed via
crash logs and an AMFI `AppleMobileFileIntegrityError` in the unified log - not a fixable
permissions issue, a code-signing one requiring a paid Apple Developer ID certificate). Do not
attempt `codesign --sign -`, an `Info.plist` with `NSBluetoothAlwaysUsageDescription`, or any other
workaround on macOS - both were tried for real and neither addresses the actual rejection. If the
user's WattSnatch machine is a Mac, tell them plainly they need a separate Linux machine on the
same LAN (a Raspberry Pi near the car works well) to run this specific proxy on - ask before
assuming they have one available.

```bash
# on the Linux machine, not the Mac
sudo apt install golang-go git
git clone https://github.com/wimaha/TeslaBleHttpProxy.git /tmp/TeslaBleHttpProxy
cd /tmp/TeslaBleHttpProxy && go build
```
It needs to keep running (on that Linux machine) alongside WattSnatch, pointed at the same
`keys/private.pem` WattSnatch generates below - copy that file over, it doesn't need to be
regenerated. Once running, save its URL (the Linux machine's LAN IP, not `localhost`) and set both
backend settings:
```bash
curl -s -X POST http://localhost:3001/api/settings -H "Content-Type: application/json" \
  -d '{"tesla_command_backend":"ble","tesla_state_source":"ble","tesla_ble_proxy_url":"http://<linux-machine-lan-ip>:8080"}'
curl -s -X POST http://localhost:3001/api/tesla/test-ble -H "Content-Type: application/json" -d '{}'
```
`{"ok":true}` confirms the proxy is reachable (this never sends a vehicle command - safe to call
freely).

Generate the EC keypair used to sign commands (needed either way):

```bash
curl -s http://localhost:3001/api/setup/public-key
```

Keep the returned `publicKey` - you need it in Phase 4.

---

## Phase 3 - Tesla developer app 🌐

Tell the user, don't do it yourself:

1. Go to https://developer.tesla.com and sign in with their normal Tesla account.
2. **Create Application** - any name, purpose "Personal use / home automation".
3. Enable scopes: Vehicle Information, Vehicle Location, Vehicle Commands, Vehicle Charging
   Management.
4. Set Redirect URI - `http://localhost:3001/auth/callback` if running locally only. **Bluetooth
   LE users:** this field is still required by Tesla's app registration form, but you'll never
   actually complete an OAuth redirect to it, so any valid-looking HTTPS URL is fine.
5. Save, and have them give you the **Client ID** and **Client Secret** (these are app
   credentials, not a personal password - safe for them to paste to you).

Once you have both:

```bash
curl -s -X POST http://localhost:3001/api/settings \
  -H "Content-Type: application/json" \
  -d '{"tesla_client_id":"<CLIENT_ID>","tesla_client_secret":"<CLIENT_SECRET>","tesla_redirect_uri":"http://localhost:3001/auth/callback"}'
```
*(Check `src/routes/settings.js` for the exact settings-write endpoint shape if this differs -
the setup wizard writes these same keys via its own form.)*

### Host the public key 🌐 (agent can do the repo/pages part ✅ with confirmation)

Tesla requires the public key from Phase 2 reachable at
`https://<domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`. The simplest path is a
public GitHub Pages repo. You *can* create this with `gh repo create` and push the key file
yourself - but creating a new public GitHub repo is visible, hard-to-reverse action, so **confirm
with the user first**, same as any repo creation. Once it's live:

```bash
curl -s -X POST http://localhost:3001/api/setup/verify-key-url \
  -H "Content-Type: application/json" \
  -d '{"url":"https://USERNAME.github.io/wattsnatch-key"}'
```
`{"ok":true,"match":true}` confirms Tesla can see the correct key.

```bash
curl -s -X POST http://localhost:3001/api/setup/register-partner \
  -H "Content-Type: application/json" \
  -d '{"domain":"USERNAME.github.io/wattsnatch-key"}'
```
This call only needs the Client ID/Secret saved above (no OAuth token) - run it directly for
**both** paths. Fleet-mode setups also get this triggered automatically as a fallback if vehicle
auto-fetch below returns a 412, but there's no reason to wait for that - calling it here is safe
and idempotent either way.

### Vehicle ID: Tesla OAuth login 🌐 (Fleet API), or manual VIN ✅ (Bluetooth LE)

**Fleet API:** this step is **always** the user's - it's their Tesla account login, likely with
2FA. Give them the login URL your app constructs (client_id + redirect_uri + scopes per the
standard Tesla OAuth authorize endpoint - see `src/routes/auth.js`), have them complete it in
their own browser, and wait for them to confirm the redirect succeeded before continuing.

```bash
curl -s http://localhost:3001/api/setup/fetch-vehicles
```
Once OAuth is done, this should return their vehicle(s) and auto-store the VIN. `{"ok":false}`
here means the OAuth step didn't complete - go back and check with the user.

**Bluetooth LE:** there's no token to fetch vehicles with, so skip the OAuth login and fetch step
entirely. Ask the user for their VIN (Tesla app → their car → Software, or the dashboard visible
through the windshield) and set it directly:
```bash
curl -s -X POST http://localhost:3001/api/settings -H "Content-Type: application/json" \
  -d '{"tesla_vin":"<THEIR_VIN>","tesla_display_name":"<THEIR_VIN>"}'
```

---

## Phase 4 - Pair the virtual key 🚗

Not app-specific - Tesla requires this of every third-party app, to confirm physical possession
of the car. The user must, on an **iPhone** (Android isn't supported for this flow), open Safari
to `https://tesla.com/_ak/<key-hosting-domain>`, tap **Add Key**, then tap their physical key
card or phone key against the centre console reader. You cannot do this step under any
circumstances - it requires their physical presence. Wait for them to confirm before continuing.

---

## Phase 5 - Enphase gateway 🔑 + ✅

Discovery and connection testing are safe to automate:

```bash
curl -s -X POST http://localhost:3001/api/setup/discover-gateway
# or, if that fails to find it on the LAN:
curl -s -X POST http://localhost:3001/api/setup/test-gateway -H "Content-Type: application/json" -d '{"ip":"<gateway-ip>"}'
```

Generating the access token requires the user's **Enlighten email + password**. This is a
credential - do not enter it yourself even if you're technically capable of constructing the
request. Ask the user to run this command themselves, substituting their own values:

```bash
curl -s -X POST http://localhost:3001/api/setup/generate-token \
  -H "Content-Type: application/json" \
  -d '{"email":"<their-enlighten-email>","password":"<their-enlighten-password>","serial":"<gateway-serial-from-sticker>","ip":"<gateway-ip>"}'
```

Their password is never stored - only the resulting token is. Once they confirm it returned
`{"ok":true}`, verify:

```bash
curl -s -X POST http://localhost:3001/api/setup/test-connection
```

---

## Phase 6 - Charging preferences ✅

Reasonable defaults an agent can set without asking, unless the user has stated a preference:

```bash
curl -s -X POST http://localhost:3001/api/settings -H "Content-Type: application/json" -d '{
  "min_charge_amps": "5",
  "max_charge_amps": "32",
  "hold_minutes": "3",
  "smoothing_window": "3",
  "charger_voltage": "240",
  "electricity_rate_aud": "0.30"
}'
```
Ask the user for their actual charger's max amps and real electricity rate if they know them -
defaults above are Australian-typical, not universal.

---

## Phase 7 - Background service ✅

```bash
curl -s -X POST http://localhost:3001/api/setup/install-service
curl -s http://localhost:3001/api/setup/service-status
```
Installs LaunchAgents on macOS or systemd units on Linux via this one endpoint. Windows isn't
covered by it - see INSTALL.md for manual service setup there. If both `tesla_command_backend`
and `tesla_state_source` are set to `ble`, the Fleet-signing `tesla-proxy` service is skipped
automatically (it's never invoked in that mode) - `service-status` correctly reporting it as not
running in that case isn't a problem.

```bash
curl -s -X POST http://localhost:3001/api/setup/complete
```

---

## Phase 8 - Dashboard password 🔑

Technically just another API call, but this is the password protecting the whole household's
dashboard - have the **user** pick and enter it themselves rather than an agent choosing one on
their behalf:

```
POST /api/auth/change-password   { "password": "<their-choice, 8+ chars>" }
```

---

## Optional integrations

All follow the same pattern - 🔑 for the credential-bearing setup call (user runs it personally),
✅ for everything else (installing, testing, verifying):

| Integration | Credential step (🔑 - user runs) | Agent can do |
|---|---|---|
| myenergi Eddi | Eddi serial + myenergi API key via Settings → myenergi | Verify it starts polling (check `/api/logs` for eddi entries) |
| MELCloud (global air-con platform) | `POST /api/setup/melcloud-credentials` with their email+password | `GET /api/setup/melcloud-status` to confirm |
| MelView (AU/NZ air-con platform - separate from MELCloud, different account, same manufacturer) | `POST /api/setup/melview-credentials` with their email+password | `GET /api/setup/melview-status` to confirm. If MELCloud rejects a working-looking login, this is very likely why - ask which platform their "Wi-Fi Control" app actually is before assuming the password is wrong |
| iCloud Calendar | `POST /api/setup/ical-credentials` with Apple ID + **app-specific password** (never their real iCloud password - generate one at appleid.apple.com) | `GET /api/setup/calendar/status` |
| Google Calendar | 🌐 User creates an OAuth app at console.cloud.google.com/apis/credentials, enables the "Google Calendar API", adds `http://localhost:3001/auth/google-calendar/callback` as an authorized redirect URI, and gives you the Client ID/Secret to save via `POST /api/settings` (`google_calendar_client_id`, `google_calendar_client_secret`, `google_calendar_redirect_uri`). Then 🌐 they open `/auth/google-calendar/start` themselves and complete Google's own login/consent - you cannot do this step. | `POST /api/setup/calendar/select {"provider":"google"}` to activate it; `GET /api/setup/calendar/status` to confirm |
| Outlook / Microsoft 365 Calendar | 🌐 User creates an Azure App Registration at portal.azure.com, adds the `Calendars.Read` delegated Graph permission, adds `http://localhost:3001/auth/outlook-calendar/callback` as a redirect URI, and gives you the Client ID/Secret (`outlook_calendar_client_id`, `outlook_calendar_client_secret`, `outlook_calendar_tenant_id` - leave tenant as `common` unless told otherwise) to save via `POST /api/settings`. Then 🌐 they open `/auth/outlook-calendar/start` themselves. | `POST /api/setup/calendar/select {"provider":"outlook"}`; `GET /api/setup/calendar/status` |
| Google Maps (driving distance, optional) | 🌐 User creates/selects a project at console.cloud.google.com, enables the **Geocoding API** and **Routes API** (not Distance Matrix), creates an API key restricted to those two APIs, and gives it to you to save via `POST /api/settings` (`google_maps_api_key`) | Nothing further to verify server-side - falls back to free Nominatim/straight-line automatically if the key is missing or a call fails |
| Solcast | API key + Resource ID from their Solcast account, via Settings | - |
| Bill parsing (Gemini) | Their Google AI Studio API key, via Settings | Manual PDF upload works without email ingestion |
| ntfy | Just a topic name (not a real secret, but let the user pick it - an agent-chosen topic name they don't know isn't useful to them) | - |
| Home Assistant / MQTT (publish) | Broker URL + username/password for their MQTT broker, via Settings -> Home Assistant / MQTT, or `POST /api/settings` (`mqtt_broker_url`, `mqtt_username`, `mqtt_password`) | `POST /api/mqtt/test-output` after saving; `GET /api/mqtt/status` to confirm connected. Disabled until configured, no default broker is assumed |
| Home Assistant / MQTT (bring your own inverter data) | Broker URL/credentials plus two topic names (solar, grid or consumption), via the same Settings card or `POST /api/settings` (`mqtt_in_broker_url`, `mqtt_in_username`, `mqtt_in_password`, `mqtt_in_topic_solar`, `mqtt_in_second_type`, `mqtt_in_topic_second`, `mqtt_in_grid_sign`, `mqtt_in_scale`, `mqtt_in_stale_seconds`), then set `inverter_brand` to `mqtt` | `POST /api/setup/test-inverter {"brand":"mqtt"}` after saving |
| TeslaMate | Postgres host/port/credentials for their existing TeslaMate instance, via Settings | Test the connection once entered |
| Tesla Bluetooth LE (commands and/or vehicle state) | - (no credential beyond the Phase 2/3 developer app + key pairing shared with Fleet API) | Covered in Phase 2 above. `tesla_command_backend` controls command delivery; `tesla_state_source` controls where vehicle state (battery, charging status) comes from. Set both to `ble` for a fully cloud-free setup, or mix them (e.g. BLE commands + Fleet Telemetry state) if the user wants that. `POST /api/tesla/test-ble` verifies proxy reachability without sending any command. |

---

## Testing changes without touching production

See [SANDBOX.md](SANDBOX.md) for running a second, isolated instance
alongside production (separate DB, separate port, Tesla proxy/telemetry
pointed at dead addresses so it can never issue real charge commands or
receive live vehicle data). Use this instead of testing directly against the
production instance running live in the house.

---

## Verification checklist

Before telling the user setup is complete, confirm:

```bash
curl -s http://localhost:3001/api/setup/service-status   # background service running
curl -s -X POST http://localhost:3001/api/setup/test-connection  # Enphase gateway reachable
curl -s http://localhost:3001/api/settings | grep -o '"tesla_vin":"[^"]*"'  # VIN saved
```

The first two should return `"ok": true`; the last should show a non-empty VIN. (`fetch-vehicles`
only applies to Fleet API mode and will correctly return an error for Bluetooth LE setups, since
there's no OAuth token to fetch with - the VIN check above works for both.) Then tell the user to
open the dashboard and confirm they
see live solar and car data, and remind them to **set a dashboard password** (Phase 8) if they
haven't yet - a fresh install has none.

---

## What NOT to do, ever, regardless of how this file reads

- Never type, store, or transmit a real password/API key/secret on the user's behalf - even
  though several of the endpoints above technically accept them in a request body. The user
  submitting it themselves is the point, not a formality.
- Never create GitHub repos, register domains, or take any other externally-visible action
  without confirming with the user first, same as any other coding task.
- Never attempt the Tesla OAuth login or the virtual-key pairing yourself - both are
  structurally impossible to delegate (2FA, physical car presence) and shouldn't be attempted.
