# WattSnatch - Change Log

---

## 2026-07-31 - v1.22.0: Pre-flight check script

Added `npm run preflight` - a new script that checks every failure mode
that's actually bitten a real install so far, all in one pass, before the
setup wizard starts: Node version against `package.json`'s `engines`
field, whether `better-sqlite3`/`zeromq`/`keytar` actually load (and
whether that's a missing build toolchain or an ABI mismatch from a Node
version change), a live functional check that the OS keychain/keyring is
actually reachable (not just that the native module loaded), port
availability, filesystem write access for the database and keys
directories, mDNS/Avahi presence for Enphase gateway auto-discovery, and
basic internet connectivity. Exits non-zero if anything needs attention,
so it's scriptable - AGENTS.md now tells an agent to run this and confirm
a clean exit before proceeding with setup, rather than discovering these
one at a time mid-install with a different confusing error each time.

## 2026-07-31 - v1.21.1: Installation documentation and reliability fixes

Prompted by a real installer's GitHub issue (Tesla developer app grant
type/website field, now fixed) and a follow-up systematic audit of the
whole setup wizard against every doc, looking for anything else that
could block a first-time install:

- `INSTALL.md`/`README.md`/`docs.html` now explain the Tesla developer
  app's grant type (both Authorization Code and Client Credentials need
  enabling, not just one) and website field (same domain as the public
  key hosting step).
- MELCloud vs MelView is now properly documented as two separate
  Mitsubishi platforms with different accounts, not one - the previous
  wording actively implied they were the same login, which is exactly
  what caused a real installer's air-con connection to fail.
- Fixed a real bug, not just a docs gap: `melcloud.js` and `melview.js`
  had an unguarded `require('keytar')` that would crash the entire app
  at startup on a headless Linux box missing `libsecret`, not just fail
  those two integrations. Guarded the same way `calendar/icloud.js`
  already was.
- Documented `libsecret`/keyring requirements for MELCloud, MelView, and
  iCloud Calendar on headless Linux; mDNS/Avahi requirements for
  automatic Enphase gateway discovery; and that a 2FA-enabled Enlighten
  account will fail Enphase token generation with a generic error.
- Documented `npm run restore`'s `--yes` flag and `WATTSNATCH_BACKUP_PASSWORD`
  environment variable, needed for a non-interactive restore - without
  them the command hangs forever waiting for input that never comes.
- Fixed a self-contradiction in the setup wizard: the Tesla redirect URI
  field said "must be HTTPS," while the docs correctly say
  `http://localhost` is fine for a local-only install. The docs were
  right; the field text was overstated and is now fixed to match.
- Added a `.nojekyll` step to the GitHub Pages public-key hosting
  instructions - without it, GitHub's default Jekyll processing silently
  drops the dot-prefixed `.well-known` folder Tesla requires.
- Added an `engines` field to `package.json` so an unsupported Node
  version fails with a clear message at `npm install` instead of a
  confusing error deep inside a native module build.
- Generalized the existing `better-sqlite3` native-module-mismatch
  troubleshooting note to cover `zeromq` and `keytar` too, since all
  three fail the same way after a Node version change.

## 2026-07-31 - v1.21.0: MelView AC support (AU/NZ), fixed a MELCloud login bug, air-con provider registry

Root-caused a user report of "MELCloud Connection failed: Unauthorized" through several
layers: first, a real integration bug - `melcloud.js` was calling the `melcloud-api`
library's constructor with `new MelcloudAPI({ email, password })` (a single options
object), but the library actually takes `(email, password)` as two positional
arguments, so `password` was silently `undefined` on every login attempt regardless
of how correct the real credentials were. Fixed, and confirmed via a direct
reproduction before and after.

That fix uncovered a second, deeper issue: the account in question still failed to
authenticate, including against melcloud.com's own login page directly. Investigation
turned up that Mitsubishi Electric actually runs **two separate cloud platforms** that
both get casually called "MELCloud" - the global MELCloud service, and a distinct
AU/NZ-only platform called **MelView** (`api.melview.net`), used by the region's
"Wi-Fi Control" branded app. Different accounts, different APIs - MELCloud credentials
don't work on MelView and vice versa, which is exactly what the user was hitting.

Added a new `melview.js` provider (protocol adapted from jz-v/ha-melview, MIT licensed
- see `THIRD_PARTY_LICENSES.md`) alongside the existing MELCloud one, and a small
`ac.js` registry (mirroring the existing meter/battery provider registries) so
`ac_brand` picks which platform is active - defaults to `melcloud`, so existing
installs are unaffected. One important limitation worth knowing: **MelView's API has
no energy or power-consumption field at all**, confirmed by reading the full reference
integration's response handling - unlike MELCloud (which at least derives a rough
estimated wattage from daily energy use), a MelView-configured AC will show power
state, mode, and temperature, but never a wattage figure on the dashboard.

Also fixed a related reliability gap found along the way: the Settings UI's "Test
Connection" and "Save Credentials" buttons for MELCloud previously saved whatever
credentials were entered and restarted the poller *unconditionally* - a wrong password
would report "Connection successful!" and only fail silently on the next 60-second
poll. Both routes (and MelView's new equivalent) now log in synchronously and only
save/report success once that's actually confirmed against the real API.

Verified MelView's implementation end-to-end against the real service (not just
against a mock) - confirmed it correctly parses a genuine account-rejection response
from `api.melview.net` (structured `id:0`/`userunits:0` body, an explicitly-expired
auth cookie) rather than throwing on an unexpected shape, using the exact credentials
already on file. That specific account's password turned out to be wrong for MELCloud,
melcloud.com, *and* MelView alike - confirmed separately that Australia/NZ simply
isn't served by MELCloud at all (Mitsubishi Electric routes that region to MelView
exclusively at the hardware-registration level) - so for AU/NZ users this is MelView
or nothing, not a credentials problem to keep chasing.

**A second, more serious MELCloud bug found on closer review, independent of the
above**: `fetchDevices()` called `_client.getBuildings()`, a method that does not
exist anywhere on the `melcloud-api` v1.1.2 client (it only exposes `getDevices()`
and the `getAirConditioners()` convenience wrapper), and read energy fields
(`todayEnergyConsumption`/`energyConsumption`) that library's device parser never
produces at all. Both would have thrown or returned nothing for every MELCloud user,
login success or not - the integration was never actually functional, independent of
the earlier login-argument bug. Rewritten against the library's real API:
`getAirConditioners()` for device state, `getEnergyReport()` per device for today's
energy use (best-effort - some devices/accounts don't expose it, handled per-device
without failing the whole poll), with a `MODE_MAP` correcting a naming quirk where the
library reports Cool mode as the literal string `'cold'`. Verified against a stub
client exercising both the happy path and a device with no energy history.

## 2026-07-30 - v1.20.0: Battery on the Energy Flow diagram, AC/Battery hidden when unconfigured

The Energy Flow diagram (Solar → Home → Grid, with animated lines out to EV,
Hot Water, and AC) had no equivalent for a home battery - configuring one only
surfaced a separate stat card (SoC, charge bar, power as text), not a proper
node on the diagram like every other appliance gets. Added a Battery branch
with the same animated-line treatment, plus one wrinkle none of the existing
branches needed: a battery's power flow is bidirectional. Charging shows a
blue line flowing from Home outward, same direction as everything else;
discharging reverses it - power flowing from the battery back to the house -
shown in violet, travelling the same path backwards via the SVG
`animateMotion` `keyPoints` reversal trick rather than building a second path.

Also addressed a smaller thing noticed along the way: the AC node was always
shown even for installs with no MELCloud configured, sitting there
permanently idle. Both AC and the new Battery branch now hide entirely
(`display:none`) until their respective feature is actually configured,
rather than advertising hardware the dashboard's visitor doesn't have.

House load (the "Home" node's value) already subtracted EV/Hot Water/AC power
from total consumption to isolate the base house load - battery charging
power needed the same treatment (it's folded into the meter's consumptionW
reading exactly like those three), while discharging power is deliberately
*not* added back in, since a battery supplying power isn't something the
house consumed.

Caught one real bug during verification: a direction change (charging ↔
discharging) while the battery branch stayed continuously visible didn't
reverse the animation, because the reversal is baked into each dot's
`animateMotion` at SVG-build time, and only a full `drawFlowCurves()` rebuild
applies it - a plain attribute update doesn't reverse an already-built path.
Fixed by detecting a direction flip in `setFlowCurveActive()` and forcing a
rebuild specifically for that case. Verified end-to-end in the browser by
driving `dashboard.js`'s real functions with synthetic telemetry (charging →
discharging → unconfigured) against a static copy of the dashboard, checking
the actual SVG `keyPoints`/`keyTimes`/colors at each step - not just reading
the code.

## 2026-07-30 - v1.19.0: Sungrow solar/grid meter support

Sungrow SH-series hybrid inverters were already supported as a *battery*
(read + control, via local Modbus TCP). They were missing as a *meter* -
even a Sungrow owner still needed a separate device just for the
solar/grid/consumption readings that drive the core diversion loop. This adds
that meter provider, reusing the exact same `sungrow_host`/`sungrow_port`/
`sungrow_unit_id` settings as the battery integration - one connection
configured once, usable for both.

Given the explicit ask to make this as robust as possible without access to
real hardware to test against: audited every existing meter provider's unit
handling first (Enphase/Fronius/SPAN are natively watts; SolarEdge explicitly
converts kW→W; MQTT-input has a user-configurable scale) - all already
correct. For Sungrow specifically, the PV power and export power registers
are 32-bit values split across two 16-bit Modbus registers in *word-swapped*
order (low word first) per evcc's published template - gotten backwards, this
silently produces a wildly wrong reading for any value over 65,535W, while
coinciding with the right answer for anything smaller, which is exactly the
kind of bug that would pass unnoticed on a small residential system and only
surface on a larger one. Built a real Modbus TCP test server (using
`modbus-serial`'s own `ServerTCP`) to verify the decode logic end-to-end,
including a scenario deliberately exceeding 16 bits, plus scenarios for grid
import/export, a battery charging/discharging (netted out of the consumption
calculation so a hybrid unit's attached battery isn't miscounted as house
load), and a firmware/no-battery-installed fallback - all passing before this
shipped. A hard plausibility bound also rejects any reading no real SH-series
system could produce, as a last line of defense against a mis-decoded
response being silently acted on.

Marked **unverified** in the UI regardless, same as every other Modbus
provider in this project - a mock server proves the code is internally
consistent, not that a real inverter agrees with the register map.

---

## 2026-07-29 - v1.18.0: Daily energy totals published to Home Assistant

WattSnatch's MQTT publisher previously only pushed instantaneous power (W) and
car state - no cumulative daily energy (kWh), so there was no way to get
WattSnatch's solar/grid/EV/hot-water/house totals into Home Assistant's own
Energy Dashboard without building template sensors or utility meters by hand
on the HA side.

Adds seven new sensors - Solar Generated Today, Grid Import Today, Grid Export
Today, EV Charged Today, Hot Water Today, Hot Water Boost Today, and House
Usage Today - published with `device_class: energy` and
`state_class: total_increasing`, which is what tells Home Assistant's Energy
Dashboard this is a resettable daily counter rather than an ever-increasing
lifetime meter. They plug directly into the Energy Dashboard's configuration
screen with no template sensors needed.

These reuse the exact `todayKwh` object already computed every controller
tick for WattSnatch's own dashboard/embed view - no new database query, and
the HA numbers can never drift from what WattSnatch's own UI shows for the
same day. Auto-created via HA's existing MQTT Discovery convention, same as
every other WattSnatch entity - nothing to configure on the HA side.

Verified against the real production MQTT broker: all seven topics publish
correct values, and the discovery config for each sensor was confirmed
correctly formed (unit, device class, state class, grouped under the existing
WattSnatch device) before considering this done.

---

## 2026-07-29 - v1.17.0: Live retailer plan data on the Retailers page

The Retailers comparison page previously used a hardcoded list of retailer rates,
last updated mid-2025 and specific to the Energex (SE QLD) network area. It now
fetches live current plan data from the Australian Energy Regulator's public
Consumer Data Right register (the same government data behind Energy Made
Easy) - no API key needed, refreshed automatically once a day, with a manual
"Refresh now" button on the page. New `retailer_network_distributor` setting
(Settings → Region) targets your specific network area instead of assuming
Energex; covers Australia's NECF states (QLD, NSW, VIC, SA, TAS, ACT).

For each of 7 major retailers, the cheapest current residential plan for your
own real usage pattern is selected and costed using the plan's actual published
rates/windows (not a fixed assumption), correctly handling GST (the CDR API
returns usage rates and supply charges GST-exclusive; feed-in tariff GST
treatment is detected per-retailer from their own disclosure text, since it
isn't consistent across retailers). Demand-tariff plans are excluded entirely
rather than costed incorrectly, since that requires the user's actual peak kW
draw per billing period, which isn't computed. Falls back cleanly to the
previous static estimates if the live fetch has never succeeded.

The Retailers page now also shows your own current plan's rates (flat or TOU,
supply charge, feed-in tariff) at the top, and each retailer row shows its own
rates alongside the cost comparison - not just the totals - so plan differences
are visible at a glance rather than only in the final dollar figures.

---

## 2026-07-27 - v1.16.0: Loading spinner on the Solar Savings period stats

A small spinner now shows next to the "Solar Savings" heading on the Data page while `loadPeriodData()` is fetching (switching periods, applying a custom date range) and clears once the numbers are in - including on failure, so it never gets stuck spinning. Uses the existing shared `.spinner` component (already used elsewhere in the app), no new styling.

---

## 2026-07-27 - v1.15.1: Data page still slow after the SQL fix - found the real remaining cause

The SQL-pushdown fix (v1.15.0) made each period-stat query fast in isolation, but the Data page was still noticeably slow. Root cause: `better-sqlite3` is synchronous, so the three endpoints the page calls (`/api/stats/periods`, `/api/stats/house/periods`, `/api/stats/master/periods`) don't actually run in parallel on the server despite the browser firing them concurrently - they queue up on Node's single thread and their times add together. Worse, `master/periods` was redundantly recomputing the exact same ~9 boundaries' (today/week/month/quarter/year + last_*) worth of car and house numbers that the other two endpoints had just computed independently.

Fix: a short-TTL (5s) in-memory cache shared across `getPeriodStats()` and `getHousePeriodStats()`, keyed by their exact (start, end) arguments - pure memoization, no change to any of the underlying math. Measured on this database: the same three-endpoint sequence dropped from ~4.2s to ~2.0s on top of v1.15.0's fix.

---

## 2026-07-27 - v1.15.0: Data page period stats moved from JS to SQL (major speedup)

`getPeriodStats()` (EV) and `getHousePeriodStats()` were pulling every matching telemetry row into JS and looping over them to apply per-row time-of-use rate resolution - fine at first, but as telemetry history grows (measured against ~558k real rows here) that loop became the dominant cost of loading the Data page: `/api/stats/master/periods` was taking up to 8 seconds, `/api/stats/house/periods` up to 6.7 seconds, for a "Year" view.

Root cause, isolated with real timing: the raw SQL scan over the full table only took ~0.3 seconds - the cost was Node marshalling hundreds of thousands of rows out of SQLite and looping over them in JS, repeated redundantly (3 stat categories x ~9 period boundaries per page load).

Fix: `buildRateCaseSql()` generates the same rate-resolution logic (flat rate history, TOU windows including overnight-spanning ones, per-config effective-date versioning, and the TOU-with-no-configs-yet flat fallback) as a SQL `CASE` expression instead of a JS closure, so the entire aggregation - rate lookup included - runs as a single SQL query per call, returning one summed row instead of hundreds of thousands.

Verified before switching over: ran the old row-by-row JS implementation and the new SQL implementation side by side across six real date ranges (including one spanning this database's actual TOU config transition date, to exercise both the flat-fallback and TOU-window branches), confirmed matching results within rounding tolerance, then swapped.

Result on this database: `/api/stats/master/periods` 8.0s -> 2.2s, `/api/stats/house/periods` 6.7s -> 1.4s, `/api/stats/periods` 1.5s -> 0.6s.

---

## 2026-07-27 - v1.14.0: All Data page charts converted to Ripl

Following the Time-of-Day Pattern heatmap, every other chart on the Data page has been rebuilt on [Ripl](https://www.ripl.run) instead of hand-rolled `<div>`/SVG code: real hover tooltips (the old ones were either the native browser `title` attribute or nothing at all - both invisible on touch/mobile), consistent axes, and smooth entry/update animations across the whole page.

- **Daily Energy Flow** (stacked bar, House/EV/Hot Water/AC) - solar/grid sub-split per device dropped from the tooltip (still available in the "Solar vs Grid Breakdown" card directly below), in exchange for a real shared-axis tooltip listing every visible series at once.
- **Daily Performance Heatmap** - same week-chunked grid as before (positional 7-day rows, not real calendar-weekday alignment - unchanged from the original), now with a proper color-scale legend.
- **Daily Energy Shape** (solar generation + energy use, hour-of-day) - the two panels' shared Y-axis is now set explicitly via `axis.y.max` on both charts rather than hand-computed pixel heights, same comparability as before.
- **Savings vs Spend, Month on Month** - grouped bar chart; dropped the old mobile-specific "cramped" label-hiding logic in favor of Ripl's own axis label handling.
- Rebuilt `public/vendor/ripl/ripl.bundle.js` (was `ripl-heatmap.bundle.js`) to include `@ripl/charts`' bar chart alongside the heatmap chart - same MIT-licensed, locally-vendored, no-network-calls bundle as before, just broader in scope now.

---

## 2026-07-27 - v1.13.0: Time-of-Day Pattern heatmap on the Data page

New chart on the Data page: a day-of-week x hour-of-day heatmap of average solar excess or EV charging power, over the last 7/30/90 days - answering "which specific hours, on which days, actually capture solar excess or draw EV charging," which neither the existing hour-only "Daily Energy Shape" chart nor the day-only calendar heatmap show on their own.

- Backend: `db.getHeatmapProfile()` + `GET /api/stats/heatmap?days=&metric=solar_excess|ev`, aggregating `telemetry_log` by local day-of-week and hour-of-day.
- Frontend: rendered with [Ripl](https://www.ripl.run) (MIT licensed), an open-source charting library - not a hand-rolled chart like the rest of the Data page's charts, since a categorical heatmap with a proper color legend isn't something worth reimplementing from scratch. Bundled locally with esbuild into `public/vendor/ripl/ripl-heatmap.bundle.js` - no CDN, no external script tag, no network calls at runtime; verified against the actual npm packages and GitHub source (zero runtime dependencies, no fetch/XMLHttpRequest/telemetry anywhere in the library) before adopting it.
- Metric toggle (Solar Excess / EV Charging) and period toggle (7D/30D/90D), matching the existing chart controls' look and behavior elsewhere on the page.

---

## 2026-07-24 - v1.12.0: Home battery support (Sigenergy, Sungrow, Tesla Powerwall) *(unverified)*

New optional integration for home batteries, separate from the existing solar-meter providers, with a genuine EV-vs-battery priority setting - not just a read-only status tile.

- **Three brands** (`battery_brand` setting, defaults to `none`): **Sigenergy** (Sigen Hybrid/PV Max/SigenStore, local Modbus TCP, read-only), **Sungrow** (SH-series hybrid, local Modbus TCP via WiNet-S, read + control), **Tesla Powerwall** (local Gateway API, read-only, no cloud account needed).
- **Priority modes**: `battery_first` (default) is a deliberate no-op - every supported battery already prioritizes charging itself before allowing export on its own firmware. `ev_first` commands the battery to pause charging while the EV is plugged in and wants power - but only Sungrow exposes a charge-power-control register to actually do this; Sigenergy and Powerwall accept the setting but Settings clearly marks it as having no effect for those brands.
- **No change to the core solar-diversion formula** - all three brands sit behind the primary meter's measurement point, so `solarExcessW = solarW - consumptionW` already accounts for whatever the battery draws, with zero modification to its 6 existing call sites in `controller.js`.
- New Settings card (brand picker, per-brand connection fields, priority selector, test connection) and a dashboard tile (SoC bar, charge/discharge power, current priority mode) that stays hidden entirely until a brand is configured.
- Like the SPAN Panel provider, this ships **unverified against real hardware** - built from evcc-io/evcc's public Modbus templates and its `go-powerwall` dependency (both MIT licensed, see `THIRD_PARTY_LICENSES.md`). Please open an issue if your unit behaves differently.

---

## 2026-07-22 - v1.11.0: Choose Bluetooth LE during setup, not just afterward

The setup wizard now offers Bluetooth LE as a genuine install-time choice instead of
something you had to know to flip on afterward in Settings. A new step ("How should
WattSnatch talk to your car?") sets both the command backend and state source together
and reshapes the rest of the wizard accordingly:

- **Tesla Developer App step** - Bluetooth LE mode only asks for Client ID/Secret (no
  redirect URI, no OAuth login); those credentials are used solely to register your
  public-key domain with Tesla later, never to fetch an access token.
- **Vehicle detection** - Fleet mode is unchanged (auto-fetch via the OAuth token);
  Bluetooth LE mode goes straight to manual VIN entry, since there's no token to fetch
  vehicles with.
- **Public key step** - gained an explicit, required "Register domain with Tesla" action
  for Bluetooth LE mode. Fleet mode's existing automatic registration (triggered when
  vehicle auto-fetch first fails) is untouched, but it never ran for Bluetooth LE users
  since they never call that endpoint - without this, BLE setups could complete without
  ever registering, and the car would never trust the key.
- **New step**: build/run TeslaBleHttpProxy, enter its URL, and test connectivity before
  continuing.
- **Install Background Service step** - skips installing the unused Fleet-signing
  `tesla-http-proxy` launchd/systemd service entirely when both settings are Bluetooth LE,
  since it's never invoked and usually was never built - previously this would install a
  service pointing at a missing binary.
- Fixed a pre-existing bug in the Tesla OAuth error-redirect handling where the error
  message was computed for the wrong step number and never actually displayed.

The one-time Tesla developer account, EC keypair, and virtual key pairing at the car are
still required for both paths - that's Tesla's own security requirement and is identical
either way. Fleet mode's flow is otherwise unchanged.

---

## 2026-07-21 - v1.10.0: Fully cloud-free Bluetooth LE mode (vehicle state polling)

WattSnatch can now read vehicle state over Bluetooth, not just send commands over
it. A new `tesla_state_source` setting (Settings -> Vehicle Command Backend) chooses
between:

- **Fleet Telemetry** (default) - live push stream + cloud REST fallback, unchanged.
- **Bluetooth LE proxy** - polls the car's charge state over BLE via
  TeslaBleHttpProxy's `vehicle_data` endpoint (about every 30 seconds), and uses
  `body_controller_state` for a presence/sleep check that never wakes the car.

Set **both** the command backend and the state source to Bluetooth LE for a fully
cloud-free setup: no Fleet Telemetry, no Fleet API, no Tesla OAuth token required.

Because Bluetooth only carries a few metres, reachability doubles as geofencing in
BLE state mode (car in range = at home), so GPS is not needed. State is polled
rather than pushed, so it reacts a little slower than Fleet Telemetry; solar
readings from your inverter still update every 5 seconds regardless.

Fleet Telemetry mode is completely unchanged.

---

## 2026-07-21 - v1.9.1: Bluetooth LE command backend hardening

Reliability fixes to the optional BLE command backend (TeslaBleHttpProxy):

- BLE commands no longer require a valid Fleet OAuth token. BLE authenticates
  over the paired Bluetooth key, so a missing or briefly-expired Fleet token
  no longer silently blocks charge start/stop/amps commands (including the
  manual Stop button). The cloud REST state fallback still requires the token,
  which is correct. Fleet-mode behaviour is unchanged.
- BLE commands now use `wait=true`, so a success response means the car
  actually applied the command rather than that it was merely queued over BLE.
- `set_charging_amps` / `set_charge_limit` now send the string body form the
  proxy documents in BLE mode, while Fleet mode keeps the integer form.
- Command responses are parsed defensively: a success status with an empty or
  non-JSON body no longer throws.
- New "Test Connection" button for the BLE proxy in Settings (reachability
  check only - it never sends a command to the car).
- Added unit tests for command-backend routing.

Note: BLE changes command *delivery* only. Vehicle *state* still comes from
Fleet Telemetry, so Fleet Telemetry is still required even when using BLE.

---

## 2026-07-21 - v1.9.0: Configurable grid retailer icon

The dashboard's Grid node used to always show AGL's logo, hardcoded. Not
everyone is with AGL, so there's now a "Grid icon" field under Settings ->
Region & Currency where you can enter your own retailer's domain (e.g.
`originenergy.com.au`, `pge.com`) and the dashboard/embed views will show
their favicon instead. Leave it blank for a generic plug icon. Purely
cosmetic, doesn't affect any calculations.

---

## 2026-07-21 - v1.8.0: Settings UI for both MQTT directions

**Both MQTT integrations are now fully configurable from Settings, not just
during initial setup.** Previously, publishing to Home Assistant had no
Settings UI at all despite the docs telling you to configure it there, and
the MQTT-input meter provider (bring your own inverter data) was writable
only once, in the setup wizard, with no way to edit it afterward short of
re-running the whole wizard or editing the database directly.

A new "Home Assistant / MQTT" card covers both directions:

- **Publish to Home Assistant**: broker URL/username/password, a Test
  Connection button, and a live status badge that now surfaces the actual
  connection error instead of failing silently forever.
- **Bring your own inverter data**: the same fields the setup wizard already
  had, now pre-filled and editable at any time, plus a Data source dropdown
  so switching to or from MQTT doesn't require re-running setup. Includes a
  worked Home Assistant MQTT Statestream example for anyone whose inverter
  data already lives in HA but not yet as a plain MQTT topic, which was the
  missing step for that path.

Also fixed a related accidental-wipe risk: `mqtt_password`/`mqtt_in_password`
now use the same masked-secret protection as other credentials, since a
persistent settings page (unlike a one-time wizard) means every blank save
would otherwise silently clear a previously-set password.

---

## 2026-07-19 - v1.7.1: Two accuracy fixes - telemetry gaps and supply charge

**Fixed: whole-house telemetry silently stopped recording while the car
was away from home.** The control loop's away-from-home and
charging-control-disabled branches updated the live dashboard but never
wrote to `telemetry_log`, so grid import/export, solar, and hot-water
readings simply vanished for however long the car was out (confirmed
against a real day: ~6 hours of missing data, including a 14 kWh hot
water boost, making the app's daily grid totals disagree badly with the
utility's own figures). Both branches now record telemetry on every tick
- grid metering is a property-level measurement and never depended on the
car being home. Only affects recording going forward; historical gaps
can't be backfilled.

**Fixed: past periods priced supply charge at today's rate.** The Data
page computed the period's supply charge as `days × current setting`, so
after a price change, "Last Month" (and any other past period) was
charged entirely at the new rate - e.g. a June viewed after a July 1
price rise was overstated by the full delta × 30 days. The
`/api/stats/master/periods` route now returns a `supply_charge_aud`
priced day-by-day from `tariff_history` (the same versioned store the
usage rates already use), and the frontend prefers it, keeping the old
calculation only as a fallback. Verified against a real bill: WattSnatch's
month total now lands within cents of the retailer's own figure.

---

## 2026-07-17 - v1.7.0: Car entities over MQTT for Home Assistant

**Full car dashboard in Home Assistant with no separate Tesla integration.**
`mqttPublisher.js` now publishes the car's battery level, charge limit,
charge amps, charger power, charging state, an online/connectivity
sensor, a home/away presence sensor, and a `device_tracker` (shows the
car on HA's map) - all under their own "WattSnatch Car" device, auto-created
via the same MQTT Discovery mechanism the existing power sensors already
use. Sourced entirely from `telemetry.getState()` (the same Fleet
Telemetry data every charge decision already reads) plus the controller's
own geofence result, so this adds no new API calls, no new credentials,
and no extra load on Tesla's Fleet API - it's the data WattSnatch already
has, just also published where Home Assistant can use it.

The existing key-authenticated `/api/car/location` REST endpoint is
unaffected and still works for anyone already using it - the MQTT
entities are additive, not a replacement.

---

## 2026-07-16 - v1.6.2: kWh accuracy fix + trip-charging toggle

**Fixed: dashboard/History undercounting grid, solar, and EV kWh by close
to 2x.** `getTodayStats()`, `getPeriodStats()`, and `getMonthlyStats()` all
assumed every telemetry row represented exactly `polling_interval_seconds`
of elapsed time and multiplied accordingly - but real rows don't land on a
fixed cadence (Tesla commands are throttled to every other controller
tick, plus normal jitter). Verified against a live production snapshot:
rows were landing ~11.5s apart against a configured 5s interval, and the
old formula reproduced the exact under-reported figure a user spotted on
their dashboard. All three now weight each row by its actual elapsed time
to the next row (via `LEAD()`, capped at 120s), matching the pattern
`getHousePeriodStats` and the nightly financial ledger already used
correctly - this closes an inconsistency between functions, not a new
technique. Affects the dashboard's Energy Flow "today" figures, History's
period stats, the monthly calendar view, retailer comparison, AI
briefings, and notifications.

**Added: on/off toggle for automatic overnight trip charging** (Settings
→ Calendar, `auto_trip_charging_enabled`, **on by default**). The
midnight trip check that schedules exactly enough grid charging for
tomorrow's known trips can now be turned off for anyone who'd rather plan
manually - implemented as a single early-return gate at the top of
`runMidnightTripCheck()`, so the actual trip-energy calculation and
departure-scheduling logic beneath it is completely unchanged whether the
toggle is on or off.

---

## 2026-07-16 - v1.6.1: Release-hardening bug fixes

A full review pass over the v1.6.0 surface plus targeted audits of the
core paths, ahead of wider community release.

**Fixed: Save Settings silently wiped stored secrets.** Secret values are
stripped from `GET /api/settings` responses, so the Settings form could
only ever POST them back as empty strings - and the POST handler wrote
them unconditionally. Every Save Settings click therefore erased any
stored `google_calendar_client_secret` / `outlook_calendar_client_secret`
(a long-standing latent bug) plus the new WattTime/ElectricityMaps/ERCOT
credentials. Empty writes to masked secrets are now treated as
"unchanged"; MQTT broker passwords are deliberately excluded since ''
there legitimately means "passwordless broker".

**Fixed: weather forecasts were hardcoded to Brisbane time.** The
Open-Meteo request sent `timezone=Australia/Brisbane`, skewing daily
forecast boundaries and sunrise/sunset for any install outside that
timezone. Now `timezone=auto` (inferred from the home coordinates).

**Completed: outside temperature in house-baseline anomaly detection.**
`baseline.js` carried a TODO - the documented "skip anomaly alerts when
it's over 28°C and the AC is running" suppression could never fire
because outside temperature was never populated. It now reads the
weather service's cached current temperature (null-safe: unknown
temperature never suppresses an alert or fabricates a reading), and
load-history snapshots record it for future analysis.

**Fixed: dashboard showed "0% renewable" for providers that don't report
renewable %.** WattTime/ElectricityMaps return carbon intensity only;
null now renders as no renewable line (icon falls back to intensity
thresholds) instead of a fake zero.

**Fixed: a stale cached ERCOT price could keep delaying departure
charging.** `isPriceSpiking()` now ignores cached prices older than 15
minutes, so a spike observed before the ERCOT API went quiet can't hold
back grid top-ups off dead data (the 2-hour pre-deadline override was
already a backstop; this tightens the normal path).

**Hardened: SPAN consumption sanity check.** Derived consumption
(solar + grid) now clamps small negatives (timing skew between the two
panel API calls) and throws loudly on large ones - which indicate
`span_solar_circuit_id` points at the wrong circuit - instead of feeding
an inflated solar-excess figure into charge control.

**Perf: export-rate resolver preloads flat feed-in history** once per
ledger run instead of one DB query per exported telemetry row, mirroring
how the import-side resolver already worked.

**Docs:** removed two stale "self-hosting limitations" from the website
(MQTT broker address and Fleet Telemetry hostname have both been real
Settings for several releases), added the Country setting to the
settings reference, and noted SPAN + US support in the README.

---

## 2026-07-16 - v1.6.0: US readiness - country setting, rate templates, NEM 3.0, best-effort integrations

**Country setting** - a new `country` setting (Settings → Region, defaults to
`AU`) drives which utility rate plan templates are offered and how dollar
values are labelled. Internal columns/settings/variables deliberately keep
their existing `_aud`-suffixed names regardless of country - a full rename
was judged too invasive for no functional benefit; only the display layer
(`public/js/currency.js`) is country-aware.

**US utility rate plan templates** (`src/services/rateTemplates/`) - a
one-click preset picker that pre-fills the TOU rate editor from a common
utility rate plan instead of hand-building windows: PG&E E-TOU-C, SCE
TOU-D-PRIME, SDG&E TOU-DR1 (all California, with NEM 3.0-style export
windows), and Con Edison Time-of-Use (New York, import-only). Applying a
template inserts a new dated rate card you can freely hand-edit afterward -
values are approximated from each utility's publicly published rate
schedule, not verified against a live account, and surfaced with that
caveat in the UI next to the picker.

**Time-varying export/feed-in rate - NEM 3.0 support** - California's NEM
3.0 replaced flat net metering with an export credit that's often
near-zero at midday and highest in the evening, making solar
self-consumption meaningfully more valuable than exporting. New
`export_rate_configs`/`export_rate_windows` tables mirror the existing
import-side TOU tables column-for-column; a new `export_rate_mode` setting
(default `flat`, zero behavior change for existing installs) toggles
between the existing flat feed-in tariff and time-varying export windows.
The nightly financial ledger (`controller.js` `_updateFinancialLedger()`)
now resolves export credit per-interval, the same pattern already used for
import cost, instead of one flat multiply for the whole day.

**Grid carbon intensity provider registry** (`src/services/gridIntensity/`)
- AEMO's existing logic was extracted verbatim into its own provider module
(zero behavior change for AU installs), alongside new WattTime and
ElectricityMaps providers for other countries/regions. Both are
**best-effort** - implemented from public API docs without a live account
to test against - and show a clear "not configured" state on the dashboard
(rather than misleading zeros) until a user supplies an API key.

**ERCOT real-time wholesale pricing** (`src/services/ercotPricing.js`,
optional, off by default) - a supplementary signal for Texas users on
real-time-pricing retail plans, not a rate-resolver mode. When enabled and
the live wholesale price spikes, `departureScheduler.js` delays a
non-urgent departure grid top-up, but only with more than 2 hours of
margin before the deadline, so a spike can never cause a missed target.
Best-effort, same caveat as the grid-carbon providers.

**SPAN Panel meter provider** (`src/services/meters/span.js`, best-effort)
- a new meter provider for SPAN's US smart electrical panel, following the
existing Enphase/Fronius/SolarEdge provider contract. SPAN has no single
dedicated "solar" reading, so the monitored circuit acting as the solar
feed must be identified explicitly (`span_solar_circuit_id`). Deliberately
throws on any missing/malformed API field rather than defaulting to 0,
since a silently wrong reading would feed directly into charge-control and
financial decisions - implemented from public docs without real hardware
to test against.

**Sandbox instance** - a second, fully isolated WattSnatch instance
(`git worktree`, separate DB/port, Tesla proxy and Fleet Telemetry pointed
at unreachable addresses so it can never issue real commands or receive
live vehicle data) was set up for testing all of the above without
touching the production instance running live in the house. See
`SANDBOX.md` for the full setup and safety rationale.

**Files changed:** `src/db.js`, `src/controller.js`, `src/server.js`,
`src/routes/api.js`, `src/services/tesla.js`, `src/services/telemetry.js`,
`src/services/departureScheduler.js`, `src/services/weatherGrid.js`,
`src/services/rateTemplates/` (new), `src/services/gridIntensity/` (new),
`src/services/ercotPricing.js` (new), `src/services/meters/span.js` (new),
`src/services/meters/index.js`, `public/settings.html`,
`public/js/settings.js`, `public/js/currency.js` (new), `public/setup.html`,
`public/js/setup.js`, `test/rateResolver.test.js`, `SANDBOX.md` (new),
`AGENTS.md`, `FEATURES.md`.

---

## 2026-07-15 - v1.5.1: Google Maps driving distance, MQTT Discovery

**Trip-distance accuracy** - calendar-based trip planning can now optionally
use a Google Maps API key (Settings → Calendar) instead of the free
OpenStreetMap Nominatim/straight-line path:
- **Geocoding API** for location-biased address lookup (fewer wrong-city
  matches on short/ambiguous addresses).
- **Routes API** (not the older Distance Matrix API, which Google now
  rejects for new projects) for real, traffic-aware driving distance
  instead of straight-line.
- Falls back to the free path automatically if no key is set or a Google
  call fails - a pure upgrade, never a requirement.
- Every trip distance (single destination or each chain leg) is now rounded
  **up** to the nearest whole km before it feeds into energy planning, as a
  small deliberate safety buffer against undercharging.

**Home Assistant MQTT Discovery** - `mqttPublisher.js` now publishes proper
HA MQTT Discovery config payloads alongside the existing retained power
topics, so the six `sensor.wattsnatch_*` entities (solar/grid/consumption/
ev/eddi/house) auto-create in Home Assistant with no manual YAML setup -
and survive a full HA rebuild, since the discovery payload lives on the
MQTT broker rather than in HA's own state.

## 2026-07-14 - v1.5.0: Dependency fixes, CI, encrypted backups

**Dependency vulnerabilities:** `npm audit fix` resolved a high-severity CRLF
injection in `form-data` and a moderate DoS in `qs` (both transitive deps).
Confirmed 0 vulnerabilities remaining and the full test suite still passes.

**Continuous integration** (`.github/workflows/test.yml`) - runs the test
suite on every push and pull request to `main`. Uses Node 22 on
`ubuntu-latest`; installs `libsecret-1-dev` first since `keytar`'s native
build needs it on Linux (it's preinstalled on macOS).

**Encrypted backups** - backups (manual or via `npm run backup`) can now be
optionally password-protected with AES-256-GCM (`src/utils/backupCrypto.js`,
scrypt-derived key). This is deliberately a *separate* crypto utility from
the existing `src/utils/crypto.js`, which derives its key from this
machine's hardware UUID and is meant for things that never leave the
machine (OAuth tokens at rest) - a backup is the opposite case: it's worth
encrypting *because* it might leave the machine (cloud sync, USB drive,
email), and it bundles the Tesla command private key alongside the
database, so it must be decryptable from a password alone, not tied to this
install.
- **CLI:** `npm run backup -- --encrypt` (prompts for a password, or reads
  `WATTSNATCH_BACKUP_PASSWORD` for non-interactive use); writes a `.enc`
  file. `npm run restore` auto-detects `.enc` and prompts for the password.
- **Settings UI:** an optional password field next to the existing Download
  Backup button; a separate "Download Encrypted" button posts the password
  in the request body (never the URL) and the browser saves the resulting
  `.enc` file.
- No password recovery exists for an encrypted backup by design - losing
  the password makes that specific backup permanently unreadable.
- Automatic daily backups remain unencrypted (unattended, no one present to
  supply a passphrase) - encryption is for the backups you're about to
  move off this machine.

**Files changed:** `package.json`, `package-lock.json`,
`.github/workflows/test.yml` (new), `src/utils/backupCrypto.js` (new),
`src/services/backup.js`, `scripts/backup.js`, `scripts/restore.js`,
`src/routes/api.js`, `public/settings.html`, `public/js/settings.js`,
`test/backup.test.js`, `README.md`.

---

## 2026-07-14 - v1.4.0: Login lockout, password recovery, security headers, tests, mobile fixes

**Problem:** A pre-launch pass identified five gaps: the dashboard's single shared
password had no brute-force protection, no way to recover from a forgotten/locked-out
password, no HTTP security headers, zero automated test coverage on the highest-risk
logic (rate resolution, backups, login lockout), and several genuine mobile-layout
overflow bugs on the Settings and Data pages that had never been tested at phone
width.

**Login lockout** (`src/middleware/sessionAuth.js`, `src/routes/login.js`,
`public/login.html`) - failed attempts escalate through 30s (5th failure), 5min (8th),
then 30min (12th) lockout tiers, tracked globally rather than per-IP since this app
has one shared password rather than per-user accounts (an attacker spreading attempts
across IPs shouldn't get more tries than one hammering from a single IP). A
successful login fully resets the counter. The login page distinguishes a lockout
error from a plain wrong-password error and disables the form while locked.

**Password recovery** (`scripts/reset-password.js`, new `npm run reset-password`
script) - sets a new password directly (`npm run reset-password -- <new-password>`)
or clears it entirely (`--clear`, with a confirmation prompt), also resetting any
active lockout so a legitimate recovery isn't blocked by the thing that likely
prompted it.

**Security headers** - added `helmet`, tuned for this app's actual environment:
`contentSecurityPolicy` and `hsts` left off (the app relies on inline styles/scripts
throughout, and its primary use case is plain HTTP on a home LAN), cross-origin
isolation relaxed so the Drives page can still load Leaflet/map tiles from third-party
CDNs and the embed view can still be iframed by other origins.

**Test suite** (`test/*.test.js`, using Node's built-in `node:test` - zero new
dependencies) - 19 tests covering the rate resolver (flat + TOU, including overnight
window wraparound and weekday/weekend exclusion), backup/restore round-trip and the
GFS-style retention pruning logic, and the login lockout escalation tiers. A new
`WATTSNATCH_DB_PATH` env var (`src/db.js`) lets the suite point at a throwaway SQLite
file instead of ever touching the real database.

**Mobile responsiveness** - tested the Settings and Data pages at true 375px width
(iPhone SE) for the first time and found three real bugs on each:
- Settings: the rate/TOU/tariff "add new entry" rows and the TOU day-picker's 7-button
  row didn't fit on one line and didn't wrap correctly, clipping content off-screen;
  the rate-history tables had a dead, never-applied `overflow-x: auto` rule. Fixed
  with a `.rate-add-row` / `.window-row` mobile stacking layout and by actually
  wiring up the table scroll wrapper.
- Data page: the top hero card's CSS Grid track never shrank below the min-content
  width of the (horizontally-scrollable) period-button strip inside it, forcing the
  *entire page* wider than the viewport instead of letting the strip scroll
  internally - a classic CSS Grid `min-width: auto` gotcha. Also fixed the button
  strip loading pre-scrolled to the right (hiding the active "Today" button behind
  the "Last X" buttons), and the 12-month savings-vs-spend chart's per-bar dollar
  labels, which collided into unreadable clutter at phone width - now suppressed
  below 600px in favour of the existing hover tooltip.

**Files changed:** `src/middleware/sessionAuth.js`, `src/routes/login.js`,
`public/login.html`, `scripts/reset-password.js` (new), `src/server.js`, `src/db.js`,
`test/rateResolver.test.js` (new), `test/backup.test.js` (new),
`test/loginLockout.test.js` (new), `public/settings.html`, `public/history.html`,
`public/js/history-v2.js`, `package.json`.

---

## 2026-07-13 - v1.3.1: Fix self-sufficiency ring showing over 100%

**Problem:** The Data page's "running on sunshine" ring could show over 100% (e.g.
113%) even on a day with real grid usage. Two separate bugs, both root-caused to the
same pattern: the numerator ("solar used") and denominator ("total load") of a ratio
were sourced from data with different completeness guarantees.

1. **Today's ring specifically:** the numerator used the Enphase gateway's own
   lifetime hardware accumulator (`currentWh - baselineWh`), which keeps counting
   through any gap in the app's own polling (restart, brief network drop, DB hiccup).
   The denominator (`totalLoad`) was built entirely from `telemetry_log` rows the
   poller actually managed to write - so the same gap that's invisible to the
   accumulator silently drops that window's consumption from the total, letting the
   ratio exceed 100%. Fixed by computing the ring's numerator from the same
   telemetry-derived sources as the denominator (the accurate hardware-accumulator
   figure is still used for the "Today's Solar" *production* stat, which is a
   different, correct use for it).
2. **All periods:** hot water's contribution to "solar used" counted the Eddi's
   *grid-boosted* energy as if it were solar too (`hw.total_kwh` instead of
   `hw.total_kwh - hw.boost_kwh`) - inflating both the ring and the "Total Saved"
   dollar figure. Same bug existed in `getEddiPeriodStats`'s `est_savings_aud`
   calculation in `db.js`, found while fixing the ring since it's the same root
   cause; corrected there too (real 30-day savings dropped from $86.09 to $78.65 on
   this install, matching the boosted kWh at the average rate).

Also added `Math.min(100, ...)` as a defensive clamp on the displayed percentage -
self-sufficiency cannot exceed 100% by definition, so the display should never show
an impossible value regardless of any future data-quality edge case.

**Files changed:** `public/js/history-v2.js` (ring's solar/self-sufficiency
calculation), `src/db.js` (`getEddiPeriodStats` savings calculation).

---

## 2026-07-13 - v1.3.0: Automatic daily backups

**Problem:** Backups (v1.1.0) were entirely manual - a button in Settings or `npm run
backup`. Nothing happened if you just forgot, which is exactly when you'd need one.

**Decision:** The controller's existing polling loop already does daily-cadence work
(the financial ledger update checks "has the date changed" every tick and only acts
once) - added the same pattern for backups: every poll tick checks whether 24h have
passed since `last_auto_backup_at`, and if so runs a backup via the existing, already-
proven `createBackupZip()` (safe hot-copy, not a raw file copy). No cron/launchd
config needed; it runs itself from inside the app. On by default
(`auto_backup_enabled` setting), toggle in Settings → Backup & Restore.

Deliberately did **not** implement byte-level incremental (delta) backups - a live
SQLite database in WAL mode makes that fragile to get right (WAL-segment shipping,
checkpoint coordination), and a backup is exactly the wrong place to cut that corner.
Instead, disk growth is bounded by automatic retention: `pruneAutoBackups()` keeps
every backup from the last 7 days, then thins to one per (calendar) week for ~12
weeks, then deletes anything older - a GFS-style rotation, tested against 47
synthetic files spanning 0-100 days old before being wired to real backups.

Failure handling: the "last backup" timestamp is only persisted *after* a successful
backup, not before - so a transient failure (e.g. disk full) retries on the next poll
tick rather than silently going a full day without a backup. An in-memory in-flight
flag (not the timestamp) prevents overlapping runs while one is still writing.

Verified live: forced the real running app's `last_auto_backup_at` two days into the
past and confirmed it created a real backup and ran retention entirely on its own on
the next poll tick, with no manual script invocation.

**Files changed:** `src/services/backup.js` (`pruneAutoBackups`, `getAutoBackupStatus`,
`AUTO_BACKUP_DIR`), `src/controller.js` (`_runAutoBackup`, poll-loop trigger),
`src/db.js` (`auto_backup_enabled` default), `src/routes/api.js`
(`/api/backup/auto-status`, settings whitelist), `public/settings.html` +
`public/js/settings.js` (toggle + status line), `FEATURES.md`, `INSTALL.md`, website
`docs.html`.

---

## 2026-07-13 - v1.2.0: Time-of-use electricity billing

**Problem:** Electricity rate was a single flat number. Users on a time-of-use (TOU)
plan (different rates by time of day) had no way to represent that, and every dollar
figure in the app (Data page, session costs, financial ledger, FBT log, trip estimates,
retailer comparison) was already quietly wrong in a related way: most of them costed
*historical* energy at *today's* rate rather than the rate that was actually in effect
at the time, even under the existing flat-rate model.

**Decision:**
- New `tou_rate_configs` + `tou_rate_windows` tables: a "config" is one versioned TOU
  rate card (named windows - Peak/Shoulder/etc. - each with days, a time range, and a
  rate, plus a default/off-peak rate), versioned by `effective_from` the same way the
  existing flat `electricity_rates` history table is.
- A new `electricity_rate_mode` setting (`flat`/`tou`) plus a toggle and rate-card editor
  in Settings, next to the existing Electricity Rate history table.
- One canonical resolver, `getRateAtTimestamp(tsMs)` / `createRateResolver()` for loops,
  replaced **every** ad-hoc rate lookup in the codebase (8 call sites across
  `controller.js`, `db.js`, and `api.js`) that previously read the flat
  `electricity_rate_aud` setting directly. This fixes the "today's rate applied to
  historical energy" bug for flat-rate users too, not just TOU users:
  - `getPeriodStats`/`getEddiPeriodStats`/`getHousePeriodStats`/`getSolarProvenance` in
    `db.js` now resolve the rate per telemetry row (or per day for Eddi, the finest
    granularity its own counters support) instead of a single rate for the whole period
    or just the latest `electricity_rates` row.
  - `calcSessionEnergyFromTelemetry` now costs each session per-interval, so a session
    spanning a TOU boundary (or a rate change) is priced correctly.
  - `_updateFinancialLedger` now accumulates `import_cost`/`solar_avoided_cost` per
    telemetry row instead of one flat multiply, since a single day can span multiple
    TOU windows.
  - `/api/teslamate/sync-sessions` (which can backfill sessions up to 90 days old) now
    costs each session at its own timestamp instead of today's rate.
  - `/api/stats/master/periods`'s house-solar savings figure now comes from
    `getHousePeriodStats`'s own (now correctly rate-aware) calculation instead of being
    re-multiplied by today's flat rate after the fact.
  - Removed a dead `rateAud` computation in the main control loop that was calculated
    every ~15s but never actually consumed (`_stateMachine`'s params never included it).
- Verified via regression testing against the real database: energy (kWh) figures are
  byte-identical before/after for every changed function; dollar figures changed only
  where the fix corrects a real historical-rate bug (confirmed by cross-checking against
  the known rate-change date), and TOU mode produces sane blended rates.

**Files changed:** `src/db.js` (new tables/CRUD/resolver, `getPeriodStats`,
`getEddiPeriodStats`, `getHousePeriodStats`, `getSolarProvenance`,
`calcSessionEnergyFromTelemetry`, `closeOrphanedSessions`), `src/controller.js`
(`_endSession`, `_updateFinancialLedger`, boot-time orphan close, dead-code removal),
`src/routes/api.js` (`/api/tou-rates` CRUD, `/api/stats/master/periods`,
`/api/teslamate/sync-sessions`, settings whitelist), `src/services/tripPlanner.js`,
`src/services/retailerComparison.js`, `public/settings.html` + `public/js/settings.js`
(Flat/TOU toggle and rate-card editor), `FEATURES.md`, website `docs.html`.

---

## 2026-07-13 - v1.1.0: Backup & restore, update notifications, extended period stats

### Backups, rollback, and one-command updates

**Problem:** There was no way to back up your data before an update, no way to roll back if
an update broke something, and no way to know an update existed in the first place.

**Decision:**
- `src/services/backup.js` - creates a zip of the database (via `better-sqlite3`'s `.backup()`
  for a safe hot-copy under WAL mode, not a raw file copy that can miss in-flight writes) plus
  `keys/`, with a manifest. Shared by both the HTTP route and the CLI scripts.
- `GET /api/backup/download` + a "Download Backup" button in Settings → Backup & Restore -
  streams the zip straight to the browser's normal save-file flow.
- `scripts/backup.js` (`npm run backup`) - CLI equivalent, writes to `~/.solarcharge/backups/`
  by default.
- `scripts/restore.js` (`npm run restore -- <zip>`) - restores a backup, after first taking its
  own safety snapshot of the current state, so a restore is itself undoable. Removes stale
  WAL/SHM sidecar files before restoring so the DB isn't paired with old write-ahead-log state.
- `scripts/update.sh` (`npm run update`, macOS/Linux) - backs up, then `git fetch --tags && git
  pull`, then `npm install`, then prints the restart command for the platform. Aborts on first
  failure (`set -e`).
- `GET /api/version/check` - checks GitHub's public releases API (no auth, no personal data,
  server-side cached ~12h) for a newer tagged release; `common.js` injects a `pill-warn` badge
  into the top bar on every page if one exists. New `check_for_updates` setting (default on)
  turns it off.
- Git tagging starts with this release (`v1.1.0`) so `git checkout <tag>` is a real rollback
  target going forward.

**Files changed:** `src/services/backup.js` (new), `src/routes/api.js` (`/api/backup/download`,
`/api/version/check`, `compareVersions`, `check_for_updates` in the settings whitelist),
`public/settings.html` + `public/js/settings.js` (Backup & Restore card), `public/js/common.js`
(update badge), `scripts/backup.js`, `scripts/restore.js`, `scripts/update.sh` (new),
`package.json` (`adm-zip` dependency, `backup`/`restore`/`update` scripts, version bump),
`INSTALL.md` / `FEATURES.md` / website `docs.html` (updating & rollback docs).

---

## 2026-07-13 - Last-period buttons, custom date range, monthly savings-vs-spend chart

**Decision:** Extended all 5 period-stat routes (`/api/stats/periods`, `/api/stats/eddi/periods`,
`/api/stats/master/periods`, `/api/stats/house/periods`, `/api/stats/solar-km`) with
`last_week`/`last_month`/`last_quarter`/`last_year` ("last complete period", as opposed to the
existing "current period to date" keys) plus an optional `custom` key parsed from `?from=&to=`
query params. Added `GET /api/financial/monthly-trend` reading `financial_ledger`, grouped by
calendar month, exposing `saved` (`solar_avoided_cost`) vs `spent` (`net_cost`) per month.

**Frontend:** Data page's Solar Savings hero gained a second button row (Last Week/Month/
Quarter/Year) plus a custom date-range picker, laid out as a single CSS grid so each "Last X"
button sits directly under its "X" counterpart; a new "Savings vs Spend - Month on Month" chart
card renders the 12-month trend as a lightweight div-based dual-bar chart.

**Files changed:** `src/routes/api.js`, `public/history.html`, `public/js/history-v2.js`.

---

## 2026-06-17 - Bug fixes: Eddi grid boost tracking, SmartThings 401 handling

### Bug Fix: Eddi boost energy always showing zero

**Root cause:** `myenergi.js` never passed `boost_today_kwh` to `insertEddiTelemetry()`. The
myenergi live status API's `che` field tracks solar-divert energy only; there is no separate
field for grid-boost energy in the status endpoint.

**Fix:**
- Added in-memory boost accumulator (`_boostTodayKwh`) in `myenergi.js` that tracks elapsed
  time while `sta` indicates Boosting (status codes 4/6: "Boosting"), multiplies by divert
  watts, and accumulates kWh.
- Accumulator is seeded from the last DB value at server start so restarts don't lose progress.
- Resets to 0 at local midnight (day rollover).
- `boost_today_kwh` now written to `eddi_telemetry` every poll cycle.
- `getEddiDailyStats()` in `db.js` updated to return `boost_kwh` per day.
- Monthly stats API (`/api/stats/monthly`) now includes `hw_boost_kwh` per day.
- `history-v2.js` device breakdown now correctly counts hot water grid boost (was hardcoded 0).
- Hot water period cards on the data page now show solar/grid split bar + actual boost kWh.
- Main dashboard `hw-node-today` now shows combined total and annotates grid boosts inline.

### Bug Fix: SmartThings 401 - washer data stopped recording

**Root cause:** The SmartThings Personal Access Token expired (API returns HTTP 401). The
`stGet()` function called `JSON.parse(raw)` before checking `res.statusCode`, so the error
surfaced as an opaque "Unexpected token '<'" JSON parse failure instead of "401 Unauthorized".

**Fix:**
- `stGet()` now checks `res.statusCode` before attempting `JSON.parse`. 401 generates an
  explicit "Personal Access Token may have expired" error message in logs.
- `_state.lastError` added to SmartThings service state; exposed via `/api/smartthings/status`.
- Settings page SmartThings badge now reads live connectivity status on load: shows
  "⚠ Token expired - regenerate PAT" when the API returns 401.

**Action required:** Regenerate your SmartThings Personal Access Token at
https://account.smartthings.com/tokens and update it in Settings → Samsung SmartThings.

### Feature: Historical Eddi boost backfill from myenergi API

Added `POST /api/eddi/backfill-boost?days=N` which fetches per-minute history from the
myenergi `/cgi-jday-E{serial}` endpoint and writes correct `boost_today_kwh` values for
past days that have no boost data. Energy values in the API are in Watt-seconds (Joules);
divide by 3,600,000 to convert to kWh. Sums `h1b + h2b` (heater 1 and 2 boost fields).

Backfilled on deployment: June 10 (12.6 kWh), June 11 (5.5 kWh), June 12 (5.3 kWh),
May 27 (5.4 kWh). Total 28.85 kWh of previously missing grid boost history recovered.

A "Sync grid boosts" button on the Data page → Hot Water section allows re-running the
backfill at any time (scans 90 days, skips days already populated).

---

## 2026-06-09 - Departure Scheduler, Retailer Comparison Engine, Weather & Grid Intelligence

Three new features plus a controller bug fix.

### Bug Fix: Controller stuck in IDLE while car charges from grid

**Root cause:** The `batteryPct >= chargeLimit` early-return in `_stateMachine()` fires every
tick when the battery is at or above the Tesla charge limit, bypassing the switch statement
entirely. The IDLE case that would call `_safeStop()` was never reached.

**Symptom:** Controller reported IDLE while the car actively charged from the grid (scheduled
charge or manual override from the car's own interface) with no hold countdown.

**Fix (`src/controller.js`):** Added `_safeStop()` call inside the early-return block,
conditioned on `!knownDisconnected && chargingState === 'Charging'`. The stop fires before
resetting to IDLE so grid charging can't slip through.

---

### Feature #2 - EV Departure Scheduler

"Leave at 8am tomorrow, need 80%" - schedule a departure and the app handles the rest.
Solar-first: the normal solar diversion loop keeps running. Grid top-up only engages within
6 hours of departure if the target SOC can't be reached on solar alone.

#### `src/db.js`
- New `departure_schedule` table (departure_time, target_soc, notes, created_at, active)
- New functions: `setDeparture()`, `getActiveDeparture()`, `clearDeparture()`
- Exported in `module.exports`

#### `src/services/departureScheduler.js` (new)
- `setDeparture(departureTimeMs, targetSoc, notes)` - validates and persists
- `getActiveDeparture()` - returns active departure with hoursUntil, or null
- `clearDeparture()` - cancels active departure
- `getDepartureDecision(currentSoc, maxAmps)` - called every controller tick; returns
  `active`, `needsGridCharge`, `missingPct`, `hoursUntil`; auto-clears on target reached
  or departure time passed

#### `src/controller.js`
- New `STATES.DEPARTURE` state
- Imports `departureScheduler`
- `_runDeparture()` method - mirrors `_runScheduled()`; charges at max amps; auto-clears
  when SOC reaches target
- `_loop()`: departure decision checked after vehicle state is known; fires `_runDeparture()`
  and returns when `needsGridCharge = true`
- `_stateMachine()`: DEPARTURE case resets to IDLE/WAITING/MONITORING when scheduler clears
- Status strip, banner logic, and action button states updated for DEPARTURE

#### `src/routes/api.js`
- `GET /api/departure` - returns active departure
- `POST /api/departure` - set departure (departure_time, target_soc, notes)
- `DELETE /api/departure` - cancel departure

#### `public/index.html`
- Departure card: datetime picker + SOC slider + set/cancel UI; shows active departure
  summary (time, target, hours remaining, status)
- Departure banner in EV card (shown when state = DEPARTURE)
- CSS styles for both

#### `public/js/dashboard.js`
- Departure module (IIFE): loads/renders departure card, handles set/clear, polls every 60 s
- `handleTelemetry()` updated: DEPARTURE banner show/hide, action button states, status strip

---

### Feature #5 - Retailer Comparison Engine

Models actual half-hourly grid consumption from `telemetry_log` against 9 major SE QLD
retailer rate structures to show estimated costs and potential savings.

#### `src/db.js`
- `getHalfHourlyEnergyData(days)` - aggregates telemetry into 30-min buckets with
  kWh imported and exported per slot

#### `src/services/retailerComparison.js` (new)
- 9 retailer definitions: Origin (flat), AGL, Energy Australia, Red Energy, Alinta,
  Simply Energy, Ergon/Energy Qld, Origin TOU (3-tier peak/shoulder/off-peak), Amber
  Electric (marked as info - can't model without live wholesale spot data)
- `touSlot(tsMs)` - classifies each slot as peak/shoulder/offpeak using QLD TOU periods
  (peak = 3pm–9pm weekdays, off-peak = 9pm–7am daily, shoulder = rest)
- `compareRetailers(days)` - returns ranked retailer list with per-period and annualised
  cost, saving vs current, usage/supply/export breakdown; `current` row uses app's
  actual electricity_rate_aud / feed_in_tariff_aud / supply_charge_daily_aud settings
- Rates are approximate for Energex network area mid-2025

#### `src/routes/api.js`
- `GET /api/retailer-comparison?days=N` (7–365)

#### `src/server.js`
- New page route: `GET /retailer` → `public/retailer.html`

#### `public/retailer.html` (new)
- Full comparison page: 30d/90d/6mo/1yr period selector, summary cards (period, kWh
  imported/exported, current estimated cost, best saving), TOU breakdown grid,
  sortable retailer table (cheapest first), Amber info row, disclaimer
- Added "Retailers" nav link to all page navbars (index, bills, history, logs, settings)

---

### Weather & Grid Intelligence

Real-time weather forecast and QLD grid carbon intensity displayed on the dashboard.

#### `src/db.js`
- New `weather_cache` table (single row, upserted on each fetch)
- New `grid_intensity_log` table (time-series, indexed on recorded_at)
- New functions: `upsertWeatherCache()`, `getWeatherCache()`, `insertGridIntensity()`,
  `getLatestGridIntensity()`, `getGridIntensityHistory()`

#### `src/services/weatherGrid.js` (new)
- **Open-Meteo API** (free, no API key): polls every 30 min for current conditions,
  5-day daily forecast, next-24h hourly. Uses home lat/lng from DB settings.
  Returns current temp/emoji/label/humidity/wind, daily forecast with max/min temps.
- **AEMO public visualisation API** (`visualisations.aemo.com.au`, no auth): polls every
  5 min for QLD1 TOTALDEMAND, SCHEDULEDGENERATION, SEMISCHEDULEDGENERATION, PRICE.
  Derives renewable% (large-scale solar+wind / total demand) and carbon intensity
  (~676 gCO2/kWh for scheduled thermal fleet, scaled by renewable fraction).
  Also captures spot price ($/MWh) for context.
- Both APIs cache results in DB for fast startup / no-wait on first page load
- `start()` / `stop()` service lifecycle; restores from DB cache on start

#### `src/routes/api.js`
- `GET /api/weather` - cached weather data
- `GET /api/carbon-intensity` - latest grid intensity snapshot
- `POST /api/weather/refresh` - force immediate re-fetch of both

#### `src/server.js`
- Imports and starts `weatherGrid` service; stops on shutdown

#### `public/index.html`
- Weather strip above the top row: current conditions (emoji, temp, label, humidity,
  wind), 4-day forecast tiles, grid intensity badge (gCO2/kWh + renewable% + icon that
  changes from 🌿 → ⚡ → 🏭 based on renewable%; border colour: green/amber/red)

#### `public/js/dashboard.js`
- Weather/grid module (IIFE): loads weather + grid intensity on page load, refreshes
  every 5 minutes; renders weather strip and grid badge

---

## 2026-06-08 - Flow diagram: smooth SVG bezier curves from Home to bottom nodes

Replaced the old straight/rotated vertical pipe approach (which had dead references to non-existent DOM elements) with proper SVG cubic bezier curves drawn dynamically in the `#flow-curves-svg` overlay.

**Visual:** All four curves start from a single convergence point at the bottom-centre of the House icon and fan out gracefully to each bottom branch icon (EV, Hot Water, Washer, AC). The curves use a vertical tangent at both ends - leaving the house straight down and arriving at each icon straight up - creating a natural, organic S-curve shape.

**Animation:** 3 staggered dots (0.6 s apart) travel along each active curve via SVG `animateMotion` + `mpath`. Dots fade in/out at the ends. Inactive curves show a very dim static guide line.

**AC colour modes:** Cooling → blue dots/stroke; Heating → orange dots/stroke; neither → grey.

**Responsive:** `window.resize` redraws all curves within 80 ms. Washer branch toggling also triggers a redraw.

### `public/js/dashboard.js`
- New `drawFlowCurves()` - measures DOM positions, builds SVG paths and dot groups
- New `setFlowCurveActive(key, active, mode)` - toggles dot visibility and path stroke
- `updateFlowDiagram`: replaced dead evPipe/hwPipeFlow/washerPipe references with `setFlowCurveActive` calls; washer branch now triggers `drawFlowCurves()` on visibility change
- `handleTelemetry`: removed dead `hwPipe`/`acPipe` element lookups; AC node now uses `setFlowCurveActive('ac', …, mode)`
- `DOMContentLoaded`: calls `drawFlowCurves()` on init + adds debounced resize listener

---

## 2026-06-08 - Trip planner & calendar fixes

### Bug: "Today" label shown for tomorrow's trips
`formatTripDate` compared hours-elapsed (`diffH < 24`) which labels a trip at 9:30 AM tomorrow as "Today" when checked at 8 PM. Now compares calendar-day midnight boundaries in local time.

### Bug: Trip planner used SoC=0 when Fleet Telemetry hadn't pushed yet
`assessTripFeasibility` used `telemetry.getState().batteryPct || 0` which falls back to 0% when the car is asleep or the server just restarted. Now falls back to `db.getLastTelemetry().battery_pct` so the last known SoC is used.

### Bug: Trips card blank after server restart (calendar/planner race condition)
`tripPlanner.start()` ran immediately after `calendar.start()`, before the async CalDAV fetch completed. Fixed by delaying `tripPlanner.start()` by 8 s in `server.js`. Dashboard also retries `loadTrips()` once after 12 s if calendar is configured but trips came back empty.

---

## 2026-06-08 - Samsung SmartThings washing machine integration

Full end-to-end integration: real-time power tracking, flow diagram node, house load correction, Data page period stats, and laundry solar recommendations.

### `src/services/smartthings.js` (new)
Polls SmartThings REST API (`api.smartthings.com`) every 30s using a Personal Access Token. Reads `powerMeter` (watts), `energyMeter` (kWh), and `washerOperatingState`. Exposes `getState()`, `listDevices()`, `start()`, `stop()`.

### `src/db.js`
- New `smartthings_telemetry` table (recorded_at, device_id, power_w, energy_kwh, operating_state)
- Migration: `ALTER TABLE telemetry_log ADD COLUMN washer_w REAL DEFAULT 0`
- `insertSmartThingsTelemetry()` - stores raw SmartThings polls
- `getWasherPeriodStats(startMs, endMs)` - kWh, solar/grid split, cost (same approach as house load using washer_w from telemetry_log)
- `getWasherDailyStats(year, month)` - per-day totals for charts
- `getHousePeriodStats` and `getHouseDailyStats` - now subtract `COALESCE(washer_w, 0)` so house load never double-counts the washing machine
- Default settings: `smartthings_token`, `smartthings_device_id`, `smartthings_configured`

### `src/controller.js`
- Imports smartthings service
- All 3 `logTelemetry()` calls now include `washer_w: smartthings.getState().powerW || 0`
- SSE payload includes `washerW`, `washerState`, `washerConfigured`

### `src/server.js`
Starts/stops smartthings service alongside all other services.

### `src/routes/api.js`
- `GET /api/smartthings/status` - live state
- `GET /api/smartthings/devices` - list powerMeter-capable devices (for setup)
- `GET /api/stats/washer/periods` - period stats (Today/Week/Month/Quarter/Year)
- `GET /api/stats/washer/monthly` - daily totals for chart
- `GET /api/today/node-totals` - now includes `washer_kwh`

### `public/index.html`
- New `#washer-branch` in the flow diagram bottom row (hidden until SmartThings configured)
- Washing machine SVG icon (front-loader drum design)
- `.pipe-home-washer` pipe with `rotate(10deg)` - dots flow top→bottom (home→washer direction)

### `public/css/dashboard.css`
- `.flow-node-icon.washer` - blue (`#63b3ed`) matching the house load colour
- `.flow-pipe-v.home-washer` and `.flow-pipe-v.pipe-home-washer` styles

### `public/js/dashboard.js`
- House load calculation subtracts `washerW` in all 3 locations (bottom stat, flow diagram, status strip)
- Washer node show/hide, active state, and watt value updated from SSE
- `loadFlowTotals()` sets `#washer-node-today`

### `public/settings.html` + `public/js/settings.js`
- SmartThings settings card: PAT input, device ID input, Discover button (lists devices), Test Connection button
- Badge updates on save

### `public/history.html` + `public/js/history-v2.js`
- New "Washing Machine" period section (hidden until data exists)
- `loadWasherPeriodStats()` - identical card layout to Car Charging / Hot Water / House Load

### `src/services/notifications.js`
- `notifyMorningBrief()` now adds a laundry recommendation if SmartThings is configured and solar forecast ≥ 15 kWh: *"👕 Great day for laundry!"*

---

## 2026-06-08 - Charge-for-trip button + morning brief notification

### "Charge to X% for this trip" button
When a trip has `status === NEEDS_ATTENTION` (car doesn't have enough charge to complete the round trip while staying above 20%), a button appears on the trip card. Tapping it:
1. Sets the Tesla charge limit to exactly `minimumSocRequired` (no more)
2. Starts charging immediately via `commandChargeNow()`
3. Button shows "✓ Charging to X%" on success

**Files changed:**
- `src/routes/api.js` - `POST /api/trips/charge-for-trip` with `{ targetSocPct }` body
- `public/index.html` - `.trip-grid-charge-btn` CSS (orange pill badge style)
- `public/js/dashboard.js` - `renderTrips()` now renders button + click handler for NEEDS_ATTENTION trips only

### Daily 7:00 AM morning brief notification
Every morning at 7:00 AEST, a push notification is sent via ntfy with:
- Car battery %
- Solar forecast for today + tomorrow
- Up to 3 upcoming trips (today/tomorrow) with energy requirement and solar coverage status

**Files changed:**
- `src/services/notifications.js` - `notifyMorningBrief()` function
- `src/server.js` - `scheduleMorningBrief()` IIFE schedules the notification at 07:00, repeats daily

### iPhone push setup (ntfy)
To receive notifications on iPhone:
1. In WattSnatch Settings → Notifications, change Base URL to `https://ntfy.sh` and set a unique topic (e.g. `wattsnatch-yourname`)
2. Install the free **ntfy** app from the App Store
3. Subscribe to the same topic name
Push notifications now arrive on iPhone for trip alerts, morning brief, and all other WattSnatch notifications.

---

## 2026-06-08 - Calendar fixed (3 bugs) + sentry drain corrected

### Bug 1: CalDAV time range format wrong (trips never fetched)
`tsdav` requires ISO 8601 with dashes (`2026-06-08T12:00:00Z`). Calendar was sending compact iCalendar format (`20260608T120000Z`), which `tsdav` silently rejects. All calendar fetches returned 0 events since this was first set up.
- `src/services/calendar.js` - `fetchCalDAVEvents`: changed `now.toISOString().replace(/[-:]/g, '')...` to `now.toISOString().split('.')[0] + 'Z'`

### Bug 2: Multi-line LOCATION fields not unescaped (geocoding failed)
iCalendar LOCATION values use `\n` and `\,` as escape sequences. These were being passed raw to the geocoder, causing lookups to fail.
- `src/services/calendar.js` - `parseVevent`: added `.replace(/\\n/gi, ' ').replace(/\\,/g, ',')` to location after extraction

### Bug 3: Sentry drain calculated for wait time at home, not event duration
`hoursAway` (time until departure, up to 7 days) was used for sentry drain, producing absurd kWh values. User has sentry disabled at home; sentry only matters while parked at the destination.
- `src/services/calendar.js` - `parseVevent`: now extracts `DTEND`; trip object includes `eventDurationHours` (defaults to 2h if no DTEND)
- `src/services/tripPlanner.js` - `calculateTripRequirement`: renamed `hoursAway` → `destinationHours`; sentry = `sentryRate × destinationHours`; call site passes `trip.eventDurationHours ?? 2`
- `src/routes/api.js` - trips endpoint now includes `eventDurationHours` in response

### Calendar window expanded to 7 days (was 48h)
Both the CalDAV fetch and the trip filter window changed from 48h to 7 days so upcoming trips for the week show on the dashboard.

---

## 2026-06-08 - AI briefing merged into forecast card; trip energy badges

### AI briefing merged into Solar Forecast card
The separate "AI Energy Briefing" card is gone. The briefing now lives inside the Solar Forecast card, separated by a thin divider line. Same refresh button and timestamp, now inline after the forecast chart.

**Files changed:**
- `public/index.html` - removed `#ai-insights-card` div; added `.forecast-ai-divider`, `.forecast-ai-header`, `#ai-insights-body` inside `#forecast-card`
- `public/css/dashboard.css` - removed `.ai-insights-card` standalone styles; added `.forecast-ai-divider`, `.forecast-ai-header`, `.forecast-ai-title` inline styles

### Trip energy badges on dashboard trips card
Each trip in the Upcoming Trips card now shows three pill badges below the trip name:
- **grey** - `X km each way`
- **purple** - `X.X kWh` (total round-trip energy including sentry + buffer)
- **amber** - `X% needed` (minimum SoC % required to complete round trip)

**Files changed:**
- `public/index.html` - `.trip-energy-row`, `.trip-energy-badge` CSS (`.kwh` purple, `.pct` amber, `.dist` grey)
- `public/js/dashboard.js` - `renderTrips()` now builds `energyRow` from `trip.required.total` and `trip.required.minimumSocRequired`

---

## 2026-06-08 - "Kilometres Driven by Source" card on Data page

Added a three-panel card to the Data page showing km driven by energy source since WattSnatch started (20 May 2026). Updates with the existing Today / Week / Month / Quarter / Year period toggle.

**Three panels:**
- ☀ **Driven on Sunshine** - `charge_sessions.SUM(kwh_solar)` ÷ TeslaMate real efficiency
- ⚡ **Driven on Grid** - `getPeriodStats().grid_kwh` (home grid, from telemetry) ÷ efficiency  
- 🔌 **Public Chargers** - TeslaMate `charging_processes` WHERE NOT at most-common charging address (home heuristic) ÷ efficiency

**Efficiency:** Uses TeslaMate's real-world kWh/km from the last 90 days of drives. Falls back to 0.155 kWh/km (6.5 km/kWh) if TeslaMate isn't connected.

**Files changed:**
- `src/db.js` - `getSolarKwhCharged(startMs, endMs)`
- `src/services/teslamate.js` - `getPublicChargeKwh(startMs, endMs)` - queries TeslaMate `charging_processes` excluding the most-common charging address (home)
- `src/routes/api.js` - `GET /api/stats/solar-km` - returns all three sources for all 5 periods
- `public/history.html` - `.km-origins-card` with 3-column panel layout + responsive stacked on mobile
- `public/js/history-v2.js` - `loadPeriodData()` populates all 6 new elements on period switch

---

## 2026-06-08 - AI Energy Briefing card on dashboard

Added a twice-daily AI-generated energy summary to the dashboard, powered by the existing Gemini API key.

**What it does:**
- Generates a 3-paragraph plain-English briefing (~140 words) at **7:00 am** and **6:00 pm** AEST every day
- Also generates on startup if the last briefing is more than 14 hours old
- Covers: (1) hot water - will solar be enough without a grid boost today/tomorrow? (2) EV charging - is today a good solar day, will the 20% minimum be easy to maintain? (3) one-line overall outlook

**Data fed to the AI:**
- Current Tesla battery % (from last telemetry)
- Solcast solar forecast: remaining today + tomorrow + next 3 days
- Today's energy usage split by house / EV / hot water (solar vs grid)
- 7-day averages for each category including grid boost history

**Files changed:**

### `src/services/aiInsights.js` *(new)*
- `generateInsight()` - gathers all data, calls Gemini API (`maxOutputTokens: 2048` needed because gemini-2.5-flash uses thinking tokens that count against the budget), stores result in DB
- `getInsight()` - returns cached text + timestamp
- `start()` / `stop()` - lifecycle; schedules `setTimeout` chains targeting 07:00 and 18:00 local time

### `src/db.js`
- Added default settings: `ai_insight_text` and `ai_insight_generated_at`

### `src/routes/api.js`
- `GET /api/ai-insights` - returns cached insight text + generated_at timestamp
- `POST /api/ai-insights/refresh` - triggers immediate Gemini regeneration (used by the ↻ button)

### `src/server.js`
- Imports and starts/stops `aiInsights` service alongside other services

### `public/index.html`
- Added `#ai-insights-card` between the Solar Forecast and Panel Health cards

### `public/css/dashboard.css`
- Added `.ai-insights-card`, `.ai-insights-header`, `.ai-insights-body`, `.ai-insights-loading`, `.ai-insights-error` styles

### `public/js/dashboard.js`
- `loadAiInsights()` - fetches `/api/ai-insights`, splits text into `<p>` tags, shows timestamp
- Wired to the ↻ refresh button (calls `/api/ai-insights/refresh` then reloads)
- Called on load and every 30 minutes

**Note:** `maxOutputTokens` must be 2048+ for gemini-2.5-flash - the model uses ~400–600 thinking tokens internally which count against the budget, leaving too few for output at 500.

---

Use this file to track every edit made to the codebase so context can be restored across development sessions.

---

## 2026-06-07 - Comprehensive mobile optimisation (all pages)

**Files changed:**

### `public/css/main.css`
- `≤480px`: container padding → 0.875rem; page-content padding reduced; page-title smaller; card padding and card-value font-size reduced.

### `public/css/dashboard.css`
- `≤900px`: `forecast-summary` gets `overflow-x:auto; flex-wrap:nowrap` so 8-day forecast scrolls horizontally without blowing layout. `forecast-summary-item` gets `flex-shrink:0`.
- `≤600px`: Eddi control card padding/buttons compact; `flow-node-today` text smaller; forecast chart height 70px; trips card smaller.
- `≤480px`: Bottom stats labels/values smaller; EV card tighter; flow-node icon labels shrunk; metric card padding reduced.

### `public/history.html`
- `≤400px`: Hero stat label drops `text-transform:uppercase` (long labels like "TOTAL HOUSE LOAD POWERED BY SUNSHINE" wrap badly in all-caps on tiny screens); hero-stat padding/value sizes reduced; savings totals smaller; chart/heatmap cards tighter padding; heatmap header stacks vertically.

### `public/logs.html`
- Filter button row: `overflow-x:auto; flex-wrap` removed, each button gets `flex-shrink:0` so they scroll horizontally instead of wrapping to 3 rows on phones. "Clear display" → "Clear" to save space.

### `public/settings.html`
- `≤600px`: card padding reduced; `grid-2` gap tighter; save-button row (`settings-save-row`) set to `flex-wrap:wrap` so Save/Reset stack vertically on small screens.
- `≤400px`: card-header wraps for long labels + status badges.

---

## 2026-06-07 - Eddi hot water controls on dashboard

Added a Hot Water control card (mirrors the Tesla EV card) with 5 action buttons:

| Button | What it does |
|---|---|
| ☀ Solar | Returns Eddi to normal solar-divert mode (`mode 1`) |
| Boost 30m | Manual boost for 30 minutes |
| Boost 60m | Manual boost for 60 minutes |
| Stop Boost | Cancels active boost (sends minutes=0) |
| Off | Fully stops the Eddi (`mode 0`) |

The card shows the current status (Diverting / Boosting / Stopped / Paused) and heater temperatures (T1, T2) from the SSE telemetry stream. The active button is highlighted in real time.

**Files changed:**
- `src/services/myenergi.js` - added `sendCommand()`, `setMode(mode)`, `boost(heater, minutes)`, `stopBoost(heater)` functions. Commands use GET with digest auth (same as status polls). Forces a re-poll 2s after each command so state refreshes quickly.
- `src/routes/api.js` - three new POST routes: `/api/eddi/boost`, `/api/eddi/stop-boost`, `/api/eddi/mode`
- `public/css/dashboard.css` - `.eddi-card`, `.eddi-action-btn` styles
- `public/index.html` - Eddi card HTML below the flow diagram + EV card section
- `public/js/dashboard.js` - `setupEddiControls()` IIFE, `_updateEddiCard()` hook called from `handleTelemetry` on each SSE tick

**Note:** The myenergi hub API endpoint format for boost is `/cgi-eddi-boost-E{serial}-{heater}-{minutes}` and for mode is `/cgi-eddi-mode-E{serial}-{mode}`. These are best-effort from community documentation - if a command fails, the error message is shown in the card and the exact URL can be adjusted in `myenergi.js`.

---

## 2026-06-07 - Flow diagram: today's energy totals under each node

Each node in the dashboard energy flow diagram now shows the cumulative energy produced/consumed today below the live watt reading:

- **Solar** - today's generation (kWh from Enphase baseline, falls back to telemetry sum)
- **Home** - today's house-only load kWh (excl. EV, HW, AC)
- **Grid** - today's export (↑) and import (↓) separately
- **EV** - today's charged kWh
- **Hot Water** - today's Eddi diverted kWh
- **AC** - shows `-` (AC load not separately accumulated in the DB yet)

Amounts < 1 kWh are shown in Wh (e.g. "340 Wh"); ≥ 1 kWh shown as "14.2 kWh".

**Files changed:**
- `src/routes/api.js` - new `GET /api/today/node-totals` aggregating all node figures in one server call
- `public/css/dashboard.css` - `.flow-node-today` style (small dim monospace label)
- `public/index.html` - `<span class="flow-node-today" id="*-node-today">` added to all 6 nodes
- `public/js/dashboard.js` - `fmtEnergy()` helper + `loadFlowTotals()` function; called on load and every 5 min

---

## 2026-06-07 - Solcast: extend forecast from 48h to 7 days (168h)

Changed `hours=48` → `hours=168` in the Solcast API fetch URL. A single call now returns up to 8 days of 30-min forecast intervals. Auto-fetch interval reduced from 6h to 12h (still well within the 10 calls/day free tier limit; `canFetch()` guard raised to 10). 337 intervals now stored vs 96 before.

---

## 2026-06-07 - Solcast: auto-fetch + show all forecast days on dashboard

**Changes:**

### `src/server.js`
- Added `autoFetchSolcast()` - runs on startup and every 6 hours automatically. Respects the 4/day `canFetch()` guard. No action if API key/resource ID not configured.

### `src/db.js`
- Added `getSolcastDailyTotals()` - returns `[{ day, kwh }]` for every remaining forecast day using `SUM(pv_estimate_kw × 0.5)` per calendar day (correct kWh from 30-min intervals). Only uses latest `fetched_at` batch.

### `src/routes/api.js`
- `GET /api/solcast/forecast` now includes `daily_totals` in the response.

### `public/index.html`
- Replaced static "Today / Tomorrow" summary items with a single `#forecast-daily-summary` container filled dynamically.

### `public/js/dashboard.js`
- `loadForecast()` now renders all days from `daily_totals`: labels "Today (remaining)", "Tomorrow", or "Weekday D Mon" for further days.

---

## 2026-06-07 - Fix: Solcast forecast showing 4× actual kWh

**Root cause:** Each of the 4 daily Solcast fetches inserted a fresh batch of rows but only deleted rows older than 2 hours. Since all 4 fetches happen within 2 hours, all 4 batches accumulated in `solcast_forecasts`. Both `getSolcastForecastInWindow` and `getSolcastForecastBatch` queried ALL rows with no `fetched_at` filter, so the result was summed 4× - 20 kWh became 80 kWh.

**Files changed:**

### `src/db.js`
- `getSolcastForecastBatch()`: changed from `fetched_at >= now - 2h` to `fetched_at = (SELECT MAX(fetched_at) ...)` - only the latest batch.
- `getSolcastForecastInWindow()`: added `AND fetched_at = (SELECT MAX(fetched_at) ...)` - same fix.

### `src/services/solcast.js`
- `fetchForecast()`: changed cleanup from `DELETE WHERE fetched_at < now - 2h` to `DELETE FROM solcast_forecasts` (full clear before inserting new batch).

**Database:** Ran `DELETE … WHERE fetched_at < MAX(fetched_at)` - removed 288 duplicate rows.

---

## 2026-06-07 - Fix: Solcast credentials not saving / badge not updating

**Root cause:** `solcast_api_key` input was `type="password"`. Browsers treat password fields specially - they may suppress autocomplete, prevent programmatic reads via `el.value`, and some password managers silently replace the entered value. The result: the field appeared to accept input but sent an empty string to the API, leaving the DB with blank keys.

**Files changed:**

### `public/settings.html`
- Changed `setting_solcast_api_key` from `type="password"` to `type="text"` with `autocomplete="off" spellcheck="false"`. API keys are not passwords and don't need browser password-manager treatment.

### `public/js/settings.js`
- `loadSolcastStatus()` now calls a shared `updateSolcastBadge(apiKey, resourceId)` helper.
- `saveSettings()` updates the badge immediately after a successful save (no reload needed to see "Configured ✓").

**Note:** Existing empty values are in the DB. User must re-enter their Solcast API key and resource ID in Settings and save once.

---

## 2026-06-07 - Data page mobile layout fixes

**Problem:** Multiple responsive bugs on history.html:
- 768px breakpoint was resetting `energy-score-ring` BACK to 160px (larger than tablet at 120px) - bug.
- 768px was collapsing `hero-stats` to 1 column - wastes vertical space; 2 columns is better.
- Savings period toggles (5 buttons) had no overflow handling - could break layout.
- Savings total row (4 figures) had no mobile wrapping - overflowed on small screens.
- Period card grids (5 cols) dropped to only 2 cols at ≤700px but not below.
- No layout fixes below 600px (small phones).

**Files changed:** `public/history.html` - rewrote all responsive media queries:
- `≤900px`: top-hero-card stacks; period toggles scroll horizontally; ring stays 120px.
- `≤600px`: savings-total-row becomes 2×2 grid; savings-breakdown 2 columns; chart-toggles scroll; period-grid forced to 2 cols.
- `≤768px`: hero-stats 2 columns (not 1); hero-stat padding/font reduced.
- `≤400px`: hero-stats 1 column; period-grid 1 column; reduced top-hero-card padding.

---

## 2026-06-07 - Dashboard & Data page visual polish

**Changes:**

### `public/css/dashboard.css`
- **Vertical pipe animation reversed** - bottom branches (EV, Hot Water, AC) now animate dots upward (bottom-to-top, `flow-btt`) instead of top-to-bottom, so they flow *inward* toward the Home node rather than outward.
- **Vertical pipe rotation flipped** - EV pipe changed from `rotate(-20deg)` to `rotate(+20deg)`, AC pipe from `rotate(+20deg)` to `rotate(-20deg)`. Pipes now lean inward (forming a `/|\` shape toward Home) rather than fanning outward (`\|/`).
- **Vertical pipe transform-origin fixed** - changed from `top center` to `bottom center` for all three branch pipes so the pipe base stays centred on each node icon while the top still points toward Home.

### `public/history.html`
- **Score ring `%` sign** - `.energy-score-label` font-size increased from `0.65rem` to `1.1rem` (more visible alongside the big score number).
- **Score ring number centering (final)** - removed CSS `transform:rotate(-90deg)` from the SVG element. Arc circles wrapped in `<g transform="rotate(-90,100,100)">` so the arc still starts at 12 o'clock. `<text>` has no rotation: `x="100"` = horizontal centre, `y="118"` places the standard font baseline so the visual cap-height sits at the circle's geometric centre - no `dominant-baseline` required. Number and `%` are inline `<tspan>` elements in one `<text>` node.
- **Removed "Self-Sufficient" label** below the ring - "running on sunshine ☀️" sublabel stays; the redundant uppercase label is gone.
- **EV and Hot Water hero stat cards** - initial placeholder changed from "- kWh" to "-%" to match their new solar-percentage display format.

### `public/js/history-v2.js`
- **House load card** - label changed to fixed "Total house load powered by sunshine" (no longer period-prefixed); kWh sub shown at 1.1rem (medium) instead of the tiny 0.75rem sub style.
- **EV charging card** - label changed to "EV charging powered by sunshine"; main value now shows solar percentage (`ev.self_pct`%); kWh moved to medium-sized sub.
- **Hot water card** - label changed to "Hot water powered by sunshine"; main value now shows solar percentage (computed as `(total_kwh − boost_kwh) / total_kwh × 100`); kWh moved to medium-sized sub.
- **Grid Reliance hero card** - previously "Running on Sunshine / Self-Sufficiency". Now labelled "Grid Reliance", value is `totalGridKwh / totalLoad × 100` (red, `var(--accent-import)`), sub-text shows grid kWh draw. The ring still shows self-sufficiency %.

---

## 2026-06-07 - Phase 5: Diversion Logging & Context Awareness

**Goal:** Wrap the existing Tesla solar-diversion loop (unchanged) with richer logging and trip-awareness. The Eddi is never commanded - its divert watts are read only (`myenergi.getState().divertW`) and used to label logs.

**Scope guard:** The surplus calculation, smoothing algorithm, and amps-to-Tesla state machine in `src/controller.js` were **not** rewritten. Phase 5 adds annotations and exactly one new input to the loop (trip-aware threshold).

### `src/db.js`
- Migration: `ALTER TABLE telemetry_log ADD COLUMN trip_within_18hrs INTEGER DEFAULT 0` and `ADD COLUMN diversion_reason TEXT` (both idempotent).
- `logTelemetry()` now persists the two new columns.
- Added `getDiversionLog(hours=24)` - returns only the rows where `diversion_reason` *changed* (via a `LAG() OVER` window), so the Data tab shows a readable transition history instead of thousands of identical 15-second rows. Exported.

### `src/services/tripPlanner.js`
- Added `getNextTripRequirement()` - read-only; returns the soonest trip departing within 18h (status, location, departureTime, SoC, deficit) from in-memory assessments, or null. Exported.

### `src/controller.js`
- `_tripContext()` - in-memory trip lookup (no I/O).
- `_getDiversionThreshold(tripPriority)` - the **only** new input to the loop: when an imminent trip still `NEEDS_ATTENTION`, lowers the minimum solar surplus to `max(base × 0.7, 400 W)` (still solar-only, never reaches to grid).
- `_diversionReason(...)` - maps controller state + context to a label: `solar_diversion_active` / `below_threshold` / `hold_timer` / `trip_priority_mode` / `override` / `no_surplus` (+ `scheduled_charging`).
- All `logTelemetry()` call sites now pass `trip_within_18hrs` and `diversion_reason`. SSE payload carries `tripWithin18hrs`, `tripPriority`, `tripLocation`, `tripDepartureTime`.

### `src/routes/api.js`
- Added `GET /api/diversion-log?hours=N` (1–168, default 24) → `{ ok, hours, entries }`.

### `public/css/dashboard.css`
- Added `.status-strip-trip` (+ `.priority`) and `.diversion-log-link` styles.

### `public/index.html`
- Added a "View diversion log →" link beneath the status strip, linking to `/data#diversion-log`.

### `public/js/dashboard.js`
- Extended `updateStatusStrip()` with trip-awareness: "Standby - surplus below threshold (trip priority mode)" / "Idle - no surplus available" wording, plus an appended trip context line (departure time + location) when a trip is within 18h.

### `public/history.html`
- Added a "Diversion Log" card (`id="diversion-log"`) with a 7-column table (time, reason, state, solar, to car, to hot water, trip<18h).

### `public/js/history.js`
- Added `loadDiversionLog()` - fetches `/api/diversion-log?hours=24`, renders colour-coded reason transitions; called on load. Scrolls the log into view when arriving via the `#diversion-log` hash.

**Verification:** Service restarted via `launchctl kickstart -k`; `/api/diversion-log` returns transitions; controller now writes `diversion_reason`/`trip_within_18hrs` each loop; SSE carries trip fields; dashboard and Data pages serve 200.

---

## 2026-06-07 - Energy score updates per period; add spent + supply charge

**Changes:**

1. **Energy score updates for all periods** - was only updated when period = 'today'. Now updates on every toggle. Today uses the full 3-component formula (self-use + self-sufficiency + grid penalty). Other periods use a 2-component formula (self-sufficiency 60% + grid penalty 40%) since generation data is only tracked daily via the Enphase accumulator baseline.

2. **Spent amounts on each breakdown card** - each savings breakdown item (EV, Hot Water, House Solar) now shows the grid cost spent in orange below the green savings figure. Hidden if $0.

3. **Daily supply charge** - a new "Supply Charge" column appears in the savings total row showing the network/distribution fixed charge for the selected period. Calculated as `period_days × supply_charge_daily_aud`. Added `getPeriodDays(period)` function to compute elapsed days in each period accurately. Supply charge daily rate is stored in `settings.supply_charge_daily_aud` (set to $0.9449). Also added `supplyChargeDailyAud` to `loadFuelSettings()` so it can be updated from the Settings page.

**Files changed:**
- `src/db.js`: `supply_charge_daily_aud` setting updated from $0.95 to $0.9449 (user's actual rate)
- `public/history.html`: added `sh-supply-charge`, `sh-ev-spent`, `sh-hw-spent`, `sh-house-spent` elements; "Grid Spent" renamed "Grid Usage"; added `.sbd-spent` CSS class
- `public/js/history-v2.js`: added `supplyChargeDailyAud` + `getPeriodDays()`; `loadPeriodData` now populates all new elements and updates energy score for every period

---

## 2026-06-07 - Period toggle now controls all metrics (Today/Week/Month/Quarter/Year)

**Change:** The period toggle previously only updated the savings hero block. Now it controls everything - all 6 kWh stat cards and the savings breakdown update together when you switch period.

Added **Week** and **Quarter** buttons (was Today/Month/Year, now Today/Week/Month/Quarter/Year).

**Files changed:**

### `public/history.html`
- Toggle buttons: added Week and Quarter, shortened "This Month"→"Month", "This Year"→"Year"
- Added `id` attributes to all 6 stat card label divs so JS can update them dynamically

### `public/js/history-v2.js`
- Removed `loadSavingsHero`, `loadTodayData`, `setupSavingsHeroToggles`, `savingsPeriod`
- Added single unified `loadPeriodData(period)` that:
  - Fetches all 4 period APIs in parallel (EV, Eddi, House, Master)
  - For 'today': also fetches Enphase gateway solar + telemetry export figure
  - Updates savings hero (total saved, grid spent, EV/HW/House breakdown)
  - Updates all 6 stat card values AND their labels (e.g. "This Month House Load")
  - Updates energy score ring only when period = 'today' (daily metric, not meaningful as aggregate)
- Added `PERIOD_LABELS` map and `activePeriod` state variable
- `setupPeriodToggles()` replaces `setupSavingsHeroToggles()`
- Init: calls `loadPeriodData('month')` once (replaces two separate calls)

---

## 2026-06-07 - Redesign: Top hero card with prominent savings summary

**Problem:** Energy score had no "/ 100" label so the number had no context. Financial savings/spending data wasn't prominent - it was buried in period grid cards below the fold.

**Changes:**

### `public/history.html`
- Replaced the centred energy score ring + hero-stats layout with a two-column `top-hero-card`:
  - **Left column**: score ring (r=80, slightly smaller) with "/ 100" label, "Energy Score" title, and subtitle
  - **Right column**: Savings Hero - period toggle buttons (Today / This Month / This Year), big green "Total Saved" figure, orange "Grid Spent" figure, and a 3-card breakdown row (EV | Hot Water | House Solar)
- `hero-stats` grid (6 kWh cards) retained below for today's production context
- Added all required CSS: `.top-hero-card`, `.savings-hero`, `.savings-total-*`, `.savings-breakdown`, `.savings-period-btn`, responsive breakpoints

### `public/js/history-v2.js`
- Added `loadSavingsHero(period)` - fetches master, EV, and Eddi period stats, computes house savings as `master − ev − hw`, populates the 5 savings elements
- Added `setupSavingsHeroToggles()` - wires Today/Month/Year buttons to call `loadSavingsHero` with the selected period
- Fixed `updateEnergyScoreRing` circumference from `2π×90` to `2π×80` (matches the new `r="80"` SVG circle)
- Init now calls `loadSavingsHero('month')` and `setupSavingsHeroToggles()` on load

---

## 2026-06-07 - Fix: Today's Solar production now matches Enphase Enlighten

**Problem:** "Today's Solar" was showing ~14.7 kWh when Enlighten and Home Assistant reported ~20.9 kWh. The telemetry-sum approach (`SUM(solar_w × interval)`) undercounts because it misses any time the app wasn't running, and the Enphase gateway's `/api/v1/production` endpoint returns `wattHoursToday: 0` on this firmware (broken).

**Root cause investigation:**
- `/api/v1/production` - `wattHoursToday` always 0 on this firmware
- `/api/v1/production/inverters` - no energy fields, only current watts
- `/ivp/meters/readings` - includes `actEnergyDlvd` (lifetime accumulated Wh) ✅

**Solution:** Track the meter's `actEnergyDlvd` lifetime accumulator. At midnight (day rollover), the controller stores the current value as the day's baseline. Today's production = `current − baseline`. Since it's a lifetime counter (never resets unless hardware replaced), this is accurate regardless of app restart gaps during the day.

**Today's baseline was manually seeded** from `current_actEnergyDlvd − 20900 Wh` (matching Enlighten). From tomorrow onwards the baseline auto-updates at midnight.

**Files changed:**

### `src/services/enphase.js`
- `fetchMeterReadings`: captures `meter.actEnergyDlvd` from the production meter and returns it as `solarActEnergyDlvdWh` in the readings object. Also added `fetchProductionTotals` (retained but unused - endpoint broken on this firmware).

### `src/controller.js`
- After each successful Enphase reading: if `solarActEnergyDlvdWh` is present, checks if the local calendar day has changed. On day rollover: saves current value as `enphase_energy_baseline_wh` and date as `enphase_energy_baseline_date`. Always saves current value as `enphase_energy_current_wh`.

### `src/routes/api.js`
- `GET /api/stats/enphase/today`: rewrote to read from settings (`baseline_wh`, `current_wh`, `baseline_date`). Returns `{ ok, whToday }` - no live gateway call needed. Returns `ok: false` with explanation if no baseline exists yet.

### `public/js/history-v2.js`
- `loadTodayData`: already falls back to telemetry sum if gateway endpoint returns `ok: false`, so no change needed.

---

## 2026-06-07 - Fix: Hero stat cards showing wrong data sources

**Problem:** The Data page hero stats were all sourced from the EV charging periods endpoint (`/api/stats/periods`), which meant:
- **Today's Solar**: showed 0.22 kWh (solar portion of EV charging) instead of ~14.7 kWh (total Enphase generation)
- **Grid Imported**: showed 0.31 kWh (EV grid only) instead of 5.2 kWh (house + EV grid total)
- **Self-Sufficiency**: showed 42% (EV self-sufficiency) instead of ~76% (whole-household)

**Fix:**
- `getTodayStats()` in `src/db.js` extended to return `solar_kwh` (sum of `solar_w * interval_h / 1000`), `grid_export_kwh`, and `grid_import_kwh` from `telemetry_log` - these come from the authoritative Enphase measurements.
- `loadTodayData()` in `public/js/history-v2.js` rewritten to fetch all four period sources in parallel (telemetry/today, EV periods, Eddi periods, house periods) and compute correct composite values:
  - **Today's Solar** = `solar_kwh` from Enphase telemetry (total panel output)
  - **Grid Imported** = `house.grid_kwh + ev.grid_kwh` (whole-household grid draw)
  - **Self-Sufficiency** = `(solar_kwh - export_kwh) / total_consumption × 100`
  - Sub-labels updated: solar shows export kWh, house shows "% from solar", EV/HW show dollar savings

**Files changed:**
- `src/db.js`: `getTodayStats()` - added `solar_kwh`, `grid_export_kwh`, `grid_import_kwh` to the solar query
- `public/js/history-v2.js`: `loadTodayData()` - rewritten to use correct sources for all 6 hero stats and energy score

---

## 2026-06-07 - Restore financial period cards to Data page

**Problem:** The Data page redesign (history-v2.js) removed the four period summary grids (Combined Savings, Car Charging, Hot Water, House Load) that showed Today/Week/Month/Quarter/Year breakdowns. It also replaced the working period API calls with a broken `renderMonthStats` function that incorrectly computed totals from local daily chart data instead of calling the real endpoints.

**Solution:** Kept the new design (Energy Score ring, hero stats, combined chart, calendar heatmap) but added the period grids back between the hero stats and the bill estimate card. Removed the broken `renderMonthStats` entirely.

**Files changed:**

### `public/history.html`
- Added CSS for period grid layout (`.period-grid`, `.period-card`, `.period-split-bar`, `.period-fuel-compare`, etc.)
- Inserted four period sections (Combined Savings, Car Charging, Hot Water, House Load) with their respective `id` anchors between the hero stats and bill estimate card
- Removed the broken `<div class="month-stats-grid">` element

### `public/js/history-v2.js`
- Added `fuelSettings`, `loadFuelSettings()`, `fuelComparison()` for Car Charging fuel vs petrol/hybrid comparison
- Removed `renderMonthStats()` (was incorrectly computing from local chart data)
- Added `loadMasterPeriodStats()` → `/api/stats/master/periods`
- Added `loadEVPeriodStats()` → `/api/stats/periods` (includes fuel comparison cards)
- Added `loadHWPeriodStats()` → `/api/stats/eddi/periods`
- Added `loadHousePeriodStats()` → `/api/stats/house/periods`
- Updated init to call `loadFuelSettings()` first, then all four period loaders on page load

---

## 2026-06-06 - Fix: Hot Water kWh double-counted for AEST timezone

**Problem:** The Hot Water "Today / This Week / This Month / This Quarter / This Year" period stats were approximately double the real value (e.g. 21.96 kWh instead of 12.78 kWh for a single day).

**Root cause:** `getEddiPeriodStats()` in `src/db.js` grouped Eddi rows by UTC calendar day (`CAST(recorded_at / 86400000 AS INTEGER)`). The Eddi's `energy_today_kwh` counter resets at **local AEST midnight** (UTC+10), which is 14:00 UTC the previous day. For Brisbane (UTC+10), one AEST day spans two UTC day buckets:
- Bucket A: 14:00–23:59 UTC (= AEST 00:00–09:59) → `MAX = 9.23 kWh` (counter value at 10am AEST)
- Bucket B: 00:00–13:01 UTC (= AEST 10:00–23:01) → `MAX = 12.73 kWh` (end-of-day value)

The function summed both MAXes: 9.23 + 12.73 = 21.96 kWh - double counting the morning portion.

**Fix:** Shift `recorded_at` into local time before bucketing: `CAST((recorded_at + tzOffsetMs) / 86400000 AS INTEGER)` where `tzOffsetMs = -new Date().getTimezoneOffset() * 60 * 1000` (+36,000,000ms for Brisbane). Now the entire AEST day lands in a single bucket, and a single `MAX(energy_today_kwh)` gives the correct daily total.

**What was NOT affected:**
- `getEddiDailyStats()` - already correct (uses relative offset from local-midnight `start`, so buckets align with AEST days)
- `getHousePeriodStats()` / `getHouseDailyStats()` - no day bucketing involved
- The Data tab daily charts - use `getEddiDailyStats()`, unaffected

**Files changed:**

### `src/db.js`
- `getEddiPeriodStats`: both `day_bucket` SQL expressions changed from `CAST(recorded_at / 86400000 AS INTEGER)` to `CAST((recorded_at + ?) / 86400000 AS INTEGER)` with `tzOffsetMs` bound as the first parameter. Applied to both the main totals query and the rate-period sub-queries.

---

## 2026-06-06 - Fix: Hot Water load being double-counted in Home node

**Problem:** The HOME node in the energy flow diagram (and the "home load" text in the monitoring status strip) were showing total Enphase consumption, which includes the Eddi/hot water diverter load. This caused HOME to read ~3.9 kW when the true house-only load was ~0.3 kW, because the Eddi was consuming 3.6 kW of solar.

**Root cause:** Two places in `dashboard.js` calculated house watts without subtracting `eddiDivertW`:
- `updateFlowDiagram` computed `houseNodeW = consumption - evWatts` (missing `- eddiDivertW`)
- `updateStatusStrip` used the same incomplete formula in the "Monitoring" message

Note: The HOME stat card at the bottom of the dashboard was **already correct** (line 112 subtracts both `evWatts` and `eddiDivertW`). The logged data in `telemetry_log` is also correct - it stores `consumption_w` (total, including Eddi) and `eddi_w` separately, and all DB stats functions already subtract both when calculating house load (`consumption_w - ev_w - eddi_w`). No data migration needed.

**Files changed:**

### `public/js/dashboard.js`
- `updateFlowDiagram`: changed `houseNodeW = consumption - evWatts` → `houseNodeW = consumption - evWatts - eddiDivertW`
- `updateStatusStrip`: changed "home load" in the monitoring message to also subtract `eddiDivertW`

---

## 2026-06-05 - Split bar chart into three separate charts

**Problem:** The "Daily Charging" bar chart showed EV solar, EV grid, and Hot Water all stacked together. Three different scales on one chart made it unreadable.

**Decision:** Pull them apart into three focused charts:
- **EV Charging** - stacked bar (solar amber + grid blue), unchanged logic, just without hot water bars
- **Hot Water** - separate bar chart, single orange bar per day from Eddi diverted energy
- **House Load** - stacked area SVG chart (solar amber fills from bottom, grid blue fills above), matching energy-monitoring convention for continuous 24/7 loads

**Files changed:**

### `src/db.js`
- Added `getHouseDailyStats(year, month)` - new function that uses the same LEAD-window SQL as `getHousePeriodStats` but grouped by calendar day, returning `{ day, house_kwh, house_solar_kwh, house_grid_kwh }` for each day of the month.
- Exported the new function in `module.exports`.

### `src/routes/api.js`
- Added `GET /api/stats/house/monthly?year=YYYY&month=M` endpoint - calls `db.getHouseDailyStats(year, month)` and returns `{ ok, year, month, days }`.

### `public/history.html`
- Removed "Hot Water" from the EV chart legend.
- Added a new "Daily Hot Water" chart card (below EV chart) with orange legend, `hw-chart-area` and `hw-chart-label-row` IDs.
- Added a new "Daily House Load" chart card with amber/blue area legend, `house-chart-area` and `house-chart-label-row` IDs.

### `public/js/history.js`
- Renamed `renderChart(days)` → `renderEVChart(days)` and removed the hot water bars from it (`maxVal` now only considers EV totals; no `hw_kwh` bars rendered).
- Added `renderHWChart(days)` - same bar structure as EV chart, single orange bar per day from `d.hw_kwh`.
- Added `renderHouseChart(days)` - renders an SVG stacked area (total in blue, solar in amber on top) as an absolutely-positioned layer inside `.chart-area`, with transparent `.chart-col` overlay divs for hover tooltips.
- Updated `loadMonthlyStats()` to fire both `/api/stats/monthly` and `/api/stats/house/monthly` in parallel with `Promise.all`, then call all three render functions.
