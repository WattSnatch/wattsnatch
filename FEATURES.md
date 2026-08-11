# WattSnatch - Complete Feature Reference

WattSnatch is a self-hosted Node.js home energy orchestration system built around one core job - **divert excess solar power into a Tesla instead of exporting it to the grid** - and grown into a full household energy platform: hot water diversion, air-con monitoring, trip-aware charge planning, bill parsing, retailer comparison, AI-generated briefings, and a Home Assistant bridge.

It runs as a single Express server (`src/server.js`) with a SQLite database, polling local hardware (Enphase gateway, myenergi Eddi, MELCloud) and cloud APIs (Tesla Fleet API, Solcast, Open-Meteo, AEMO, Google Gemini/OpenRouter), pushing live updates to a browser dashboard over Server-Sent Events.

**Stack:** Node.js / Express, `better-sqlite3`, vanilla JS frontend, ZeroMQ (Tesla Fleet Telemetry), MQTT (Home Assistant), AES-256-GCM token encryption.

---

## 1. Core Solar → EV Charging Engine

This is the original and central feature - everything else is built around it.

### The control loop (`src/controller.js`)
Every 5 seconds the controller:
1. Polls the configured solar meter (Enphase, Fronius, SolarEdge, SPAN, Sungrow, or MQTT input) for solar production, house consumption, and grid import/export (W).
2. Reads the car's live charge state from Tesla **Fleet Telemetry** (a ZMQ push feed - no polling required for normal operation).
3. Computes solar excess: `solar_w − consumption_w + existing_ev_charge_w`.
4. Applies a rolling average (**smoothing window**, default 3 readings) so passing clouds don't cause flapping.
5. Converts smoothed excess watts into a target amperage (`excess ÷ charger_voltage`), clamped to `min_charge_amps`–`max_charge_amps`.
6. Runs a state machine that starts, stops, or re-targets the car's charge rate to match.
7. Pushes the result to the dashboard instantly via Server-Sent Events.

Tesla commands are throttled to every **other** tick, while the solar meter is still polled every tick, roughly halving Tesla Fleet API command costs without hurting solar responsiveness. Tick length is `polling_interval_seconds`, which defaults to 15s (so meter every 15s, Tesla commands every 30s).

**Optional: Bluetooth LE command backend.** By default, charge start/stop/amps/limit commands go through the local `tesla-http-proxy` (signs commands, relays via Tesla's cloud Fleet API). Setting `tesla_command_backend` to `ble` in Settings routes those same commands through [TeslaBleHttpProxy](https://github.com/wimaha/TeslaBleHttpProxy) instead - commands go straight to the car over Bluetooth LE, no cloud hop. BLE only works while the car is within range (a few metres), so it's a home-charging alternative.

**Optional: Bluetooth LE vehicle state (fully cloud-free).** Setting `tesla_state_source` to `ble` reads the car's state (battery, charging status, amps, charge limit) over the same BLE proxy instead of Fleet Telemetry, polling `vehicle_data` about every 30 seconds and using `body_controller_state` for a wake-free presence/sleep check. Because Bluetooth only reaches a few metres, reachability doubles as geofencing (in range = at home), so no GPS is needed. Set **both** `tesla_command_backend` and `tesla_state_source` to `ble` for a setup that needs no Fleet Telemetry, no Fleet API, and no Tesla OAuth token at all - everything happens over local Bluetooth. Trade-off vs. Fleet Telemetry: state is polled (a few seconds per read, ~30s cadence) rather than pushed live, so it reacts slightly slower. Solar readings from the inverter are unaffected and still update every 5 seconds either way.

**TeslaBleHttpProxy does not practically run on macOS.** It needs macOS's CoreBluetooth framework, which refuses unsigned or ad-hoc-signed binaries before ever offering a Bluetooth permission prompt - confirmed via a real install attempt (silent `SIGABRT`, then an AMFI `AppleMobileFileIntegrityError` found in the unified log, not a TCC/permissions issue). A paid Apple Developer ID certificate fixes it in principle; in practice, run the proxy on a Linux machine (e.g. a Raspberry Pi near the car) and point `tesla_ble_proxy_url` at its LAN address - it doesn't need to be the same machine WattSnatch itself runs on, and WattSnatch's own server has no such restriction on macOS.

**Choosing Bluetooth LE during setup, not just afterward.** The setup wizard has a dedicated step ("How should WattSnatch talk to your car?") that sets both settings together and adjusts the rest of the wizard accordingly: the Tesla Developer App step skips the redirect URI and OAuth login (Client ID/Secret only, used solely to register your public-key domain with Tesla), vehicle detection becomes direct manual VIN entry instead of an API fetch, the public-key step gains an explicit "Register domain with Tesla" action (required before continuing, since the OAuth-based auto-registration fallback used in Fleet mode never runs without a token), a new step covers building/running TeslaBleHttpProxy and testing its connectivity, and the background-service install step skips installing the unused Fleet-signing `tesla-http-proxy` service entirely. The one-time Tesla developer account, key generation, and virtual key pairing at the car are unavoidable either way - that's Tesla's own security requirement, identical for both paths.

### State machine
| State | Meaning |
|---|---|
| `IDLE` | No car connected, or nothing to do |
| `WAITING` | Car plugged in, no usable solar yet |
| `MONITORING` | Solar excess detected - confirming before starting, or attempting a wake |
| `CHARGING` | Actively solar-diverting |
| `HOLDING` | Solar dropped - waiting out the hold timer before stopping, to avoid short-cycling |
| `STOPPED` | User pressed STOP - won't auto-resume until AUTO is pressed |
| `OVERRIDE` | **Charge Now** - grid charging at max amps regardless of solar |
| `SCHEDULED` | Inside a user-defined time-of-day charging window |
| `DEPARTURE` | Grid top-up charging to hit a target SOC before a known departure time |
| `ERROR` | Fault state |

### Key charging behaviours
- **Minimum-amp threshold** - never starts or holds a charge below a useful current (default 5A), avoiding pointless trickle sessions.
- **Hold timer** (default 3 min) - when solar drops, steps the car down to minimum amps immediately but doesn't stop the session until the hold period expires, protecting against stop/start cycling.
- **Home/away geofencing** - Haversine distance check against a configured home lat/lon + radius; charging control is suspended entirely while the car is away (e.g. parked at a Supercharger).
- **External-charge interception** - if the car starts charging on its own (from the touchscreen or a Tesla-scheduled charge) outside of WattSnatch's control, it's stopped or re-targeted so the app stays the single source of truth.
- **Charge-limit enforcement** - if the battery is at or above the configured charge limit but still drawing power, WattSnatch stops it. It only acts on a limit the car has actually confirmed: Fleet Telemetry pushes `ChargeLimitSoc` solely when it *changes*, and vehicle state is persisted, so a value that was ever wrong would otherwise stay wrong across restarts and silently cap charging below what you set. The limit is re-confirmed from the vehicle hourly, and until it is confirmed WattSnatch defers to the car - which enforces its own limit natively, so this cannot overcharge.
- **Sleeping-car wake logic** - if the car reports no charge state and hasn't been seen recently, WattSnatch sends a Fleet API wake command (throttled to once per 3 minutes) rather than assuming it's unplugged.
- **REST API fallback** - Fleet Telemetry (ZMQ) is the primary data source; if it goes stale for 5+ minutes or hasn't delivered a charging state since restart, the controller falls back to polling the Tesla REST API directly, then goes back to pure telemetry once ZMQ resumes.

### Solar meter providers (`src/services/meters/`)
The control loop reads solar/consumption/grid through a swappable provider abstraction, selected in the setup wizard (`inverter_brand` setting, defaults to `enphase`):
- **Enphase IQ Gateway** - local LAN polling, per-panel microinverter health.
- **Fronius** - local Solar API v1 (no cloud account).
- **SolarEdge** - cloud monitoring API (key + site ID).
- **MQTT (bring your own data)** - for any inverter not natively supported yet. Subscribe to your own MQTT topics for solar production and either net grid power or house consumption (WattSnatch derives the third), with configurable grid-sign convention and a watts/kW scale. Every provider returns the same normalized `{ solarW, consumptionW, gridW, ... }` shape, so the rest of the controller is provider-agnostic.
  - **Stale-safe:** the MQTT provider caches the latest published values and serves them synchronously to the control loop, but if no fresh message arrives within a configurable window (default 60s) `fetchReadings()` throws - the controller then treats the feed as a dead gateway and stops adjusting the charge rate rather than acting on frozen data. Serving stale readings is the one failure mode explicitly designed out.
- **SPAN Panel** *(unverified)* - a US smart electrical panel with local circuit-level monitoring. Implemented from SPAN's public API documentation without access to real hardware to test against - since SPAN has no single dedicated "solar" reading, you identify which monitored circuit is the solar feed (`span_solar_circuit_id`). Deliberately throws rather than defaulting to 0 on any missing/malformed field, since a silent wrong reading would feed directly into charge-control and financial decisions. Please test carefully and report issues if you have this hardware.
- **Sungrow** *(unverified)* - SH-series hybrid inverter, local Modbus TCP via the WiNet-S dongle (same connection as the Sungrow battery integration - reuses its `sungrow_host`/`sungrow_port`/`sungrow_unit_id` settings, so a user with both configures the connection once). Register addresses and the 32-bit word-swapped decode convention are taken from evcc's published Sungrow template (see `THIRD_PARTY_LICENSES.md`), verified against a real Modbus TCP server built specifically to test this - including a scenario that exceeds 16 bits, since a wrong word-order bug would otherwise coincide with the right answer for any smaller residential system and go undetected. House consumption is derived (solar + grid import − battery charge) rather than a dedicated register, and nets out the battery's own charge/discharge power so a hybrid unit's attached battery isn't miscounted as house load. A hard plausibility bound (rejecting any reading no real SH-series system could produce) guards against a garbled or mis-decoded response being silently acted on. Still genuinely unverified against real hardware - please open an issue if yours reports something different.

### Home battery support (`src/services/battery/`) *(unverified - no real hardware to test against)*
Optional, separate from the solar-meter providers above - reads a home battery's charge state and, for one brand, can actively arbitrate whether solar goes to it or to the EV first (`battery_brand` setting, defaults to `none`):
- **Sigenergy** (Sigen Hybrid / PV Max / SigenStore) - local Modbus TCP (requires installer-level access to enable it in Sigenergy's configuration app). Read-only: SoC and charge/discharge power. No exposed charge-power-control register, so **EV first priority has no effect** on this brand.
- **Sungrow** (SH-series hybrid) - local Modbus TCP via the WiNet-S dongle. Read + control: the only brand where **EV first priority actively works** - WattSnatch commands the inverter's EMS mode to pause battery charging while the EV is plugged in and wants power, then restores normal self-consumption mode once it's done. Requires the inverter's rated max charge/discharge power to be entered in Settings, so there's always a known-good state to restore to.
- **Tesla Powerwall** - local Tesla Energy Gateway API (no cloud account or internet needed for reading). Read-only: SoC and charge/discharge power. The only write the Gateway/Fleet API exposes is a backup-reserve percentage (a discharge floor for outage backup, via the cloud Fleet API, not the local Gateway) - not a charge-power lever, so **EV first priority has no effect** on this brand either.
- **Priority modes:** `battery_first` (default) is a genuine no-op - every one of these systems already prioritizes charging itself before allowing export on its own firmware, so there's nothing to actively do. `ev_first` only has teeth on Sungrow; selecting it on Sigenergy/Powerwall is accepted but surfaced in Settings as having no effect for that brand, rather than silently doing nothing.
- Adding a battery **requires no changes to the existing solar-diversion formula** (`solarExcessW = solarW - consumptionW`) - all three brands sit behind the primary meter's measurement point, so whatever the battery draws to charge itself is already folded into the existing `consumptionW` reading.
- **Dashboard visual:** when configured, the Energy Flow diagram shows a Battery node alongside EV/Hot Water/AC, with an animated line to/from Home - flowing outward (blue) while charging, reversed (violet) while discharging. Hidden entirely when `battery_brand` is `none`, the same treatment the AC node gets when MELCloud isn't configured, rather than showing a permanently-idle icon for a feature the dashboard's visitor doesn't have.
- Register addresses (Sigenergy, Sungrow) and Gateway API endpoints (Powerwall) were taken from [evcc-io/evcc](https://github.com/evcc-io/evcc) and its `go-powerwall` dependency (both MIT licensed - see `THIRD_PARTY_LICENSES.md`), not verified against real hardware, same status as the SPAN Panel provider below. Please open an issue if your unit behaves differently.
- **Why control is this limited, and why it's not a WattSnatch design choice:** every brand's *local* API only exposes what the manufacturer chose to expose over Modbus/local HTTP - there's no local "charge now"/"discharge now" command on any of the three brands above, full stop. Aggregators like Amber Electric's SmartShift go further than any self-hosted tool can, but not through a documented public API most of the time: Amber has stated they have "a special arrangement with Tesla" for Powerwall so they don't need a customer's API key at all, and for other brands their published support docs describe driving charge/discharge indirectly by moving the **minimum reserve/backup-reserve level** up and down (raise it to force a charge toward that floor, lower it to allow discharge past where it'd otherwise stop) - a lever available on Powerwall's cloud Fleet API, but not currently used by `teslaPowerwall.js`, since it doesn't cleanly express "prioritize the EV" (it affects the reserve/export floor generally, not the EV specifically). Worth knowing separately: Tesla's own app already prioritizes an EV over the Powerwall for excess solar in the default **Self-Powered** mode, with no third-party app or retailer required - the Powerwall only claims solar ahead of the EV once the EV hits its charge limit, or if the Powerwall itself is below its Backup Reserve floor. So `battery_first`/`ev_first` here matters far less for Powerwall owners than it does for Sungrow owners, since Tesla's own default already does most of what people want.

### Manual controls (dashboard buttons)
- **Auto** - resume solar-only control.
- **Stop** - halt charging and lock out auto-restart until Auto is pressed again.
- **Charge Now** - override to grid charging at max amps immediately, regardless of solar.
- **Charging Control** master toggle - fully disable/enable WattSnatch's control of the car.
- **Charge limit slider** - set the Tesla's charge limit % from the dashboard.

---

## 2. Departure & Trip-Aware Charging

A layer on top of the core solar loop that guarantees the car is ready for known trips, using solar first and grid only as a last resort.

### Manual departure scheduling (`departureScheduler.js`)
Set a single target SOC + departure time. Solar keeps charging normally; if within **6 hours** of the deadline and SOC is still below target, the scheduler forces grid charging at max amps until the target is met or the deadline passes. Clears itself automatically once satisfied.

### ERCOT real-time wholesale pricing *(unverified, optional, off by default)*
For Texas users on a real-time-pricing retail plan: `src/services/ercotPricing.js` polls ERCOT's public real-time Settlement Point Price. This is a **supplementary signal, not a rate-resolver mode** - most Texas retail plans aren't 1:1 wholesale pass-through, so it never replaces your configured electricity rate. When enabled and the live price spikes, a non-urgent departure grid top-up is delayed - but only while more than 2 hours of margin remains before the departure deadline, so a price spike can never cause a missed target. Implemented from ERCOT's public API documentation without a live account to verify against.

### Automatic trip planning (`tripPlanner.js`)
The most complex piece of business logic in the app:
- Reads upcoming calendar events (see Calendar integration below) and estimates round-trip energy: `2 × distance_km × 0.155 kWh/km` (real-world Model Y efficiency, refined from TeslaMate history) + sentry-mode drain for the time parked at the destination + a battery-health degradation factor.
- Groups trips less than 90 minutes apart into multi-stop **chains** (e.g. home → A → B → home) and assesses the whole chain's energy needs together.
- Checks the Solcast forecast for the intervening period; if forecast solar (at an assumed 70% EV-conversion rate) covers the shortfall, the trip is marked `SOLAR_WILL_COVER` and no grid charging is scheduled.
- If a deficit remains, calculates the grid top-up cost and marks the trip `NEEDS_ATTENTION`, triggering a push notification.
- Maintains a **20% SOC floor** - never plans to drain the battery below this on a round trip.
- Runs a **midnight trip check** at sunset: refreshes tomorrow's calendar, re-chains trips, and hands a target SOC + deadline to the departure scheduler automatically - no manual input required for repeat trips. Toggle in Settings → Calendar (`auto_trip_charging_enabled`, on by default) to turn this specific automatic overnight scheduling off - everything else in this list (assessment, notifications, same-day trip checks) keeps running either way.
- Matches completed drives back to the original planned trip (via TeslaMate, within 8 hours and 500m of home) to record actual vs. planned energy use.
- Feeds an "is a trip due within 18 hours and still short on charge" flag back into the core solar loop - when true, the minimum solar-diversion threshold is lowered (down to a 400W floor) so more solar gets captured before a trip, without ever reaching for grid power in the solar-only path.

### Known destinations & calendar (`calendar.js`, `calendar/`)
- Connects to **one** of three calendar providers at a time, chosen in Settings: **iCloud** (CalDAV, app-specific password), **Google Calendar** (OAuth2, Calendar API v3), or **Outlook / Microsoft 365** (OAuth2, Microsoft Graph). Each lives in its own adapter under `src/services/calendar/`, following the same provider-registry pattern as the solar inverter integrations (`src/services/meters/`).
- Polls the active provider hourly, 7 days ahead. Google and Microsoft Graph expand recurring events server-side (`singleEvents=true` / `calendarview`); the iCloud adapter expands RRULE/EXDATE itself, since iCloud's CalDAV server returns the un-expanded master event.
- Filters out non-driving events (video calls, all-day events) and requires a location field - identical logic regardless of which provider the events came from.
- Geocodes locations via OpenStreetMap Nominatim by default (free, no key needed) and calculates straight-line distance - optionally, add a Google Maps API key in Settings to use Google's Geocoding API (location-biased, far less prone to matching the wrong city/state/country for short addresses) and the Routes API for real driving distance instead of straight-line (the newer "Routes API", not the older "Distance Matrix API", which Google now rejects for new API keys/projects). Falls back to the free path automatically if no key is set or a Google call fails.
- Every trip distance (single destination or each leg of a multi-stop chain) is rounded **up** to the nearest whole km before it feeds into energy planning - a deliberate small safety buffer, since underestimating a trip risks leaving the car short of charge, while overestimating just means a slightly earlier top-up.
- Matches geocoded coordinates against previously seen destinations within 200m so recurring trips don't re-geocode every time.
- Auto-imports frequent destinations from TeslaMate drive history to pre-populate the known-destination list.

### Free power windows (`calendar.js`)
- Several retailers give away electricity for set periods (Solar Sharer and similar), and some let the customer pick the slots themselves each fortnight - so there is no fixed tariff schedule to configure against. Those windows are read from the **same calendar already connected for trip planning**: create an event titled `Free Power` and WattSnatch charges the car at full rate for exactly that window, ignoring solar, because the grid costs nothing at the time.
- **Off by default** - this is the only feature that deliberately imports from the grid, so it never runs unless switched on in **Settings → Calendar**.
- Match keywords are configurable and comma-separated (default `free power`), matched case-insensitively against the **event title only, never its location** - so driving to a venue that happens to contain the phrase does nothing.
- **All-day events are ignored.** A window has to state its hours; otherwise one mistyped all-day entry would mean twenty-four hours of full-rate grid charging, which is the opposite of the point.
- Reuses the existing scheduled-charging path rather than adding a second way to force charging, so there is one force-charge implementation. The one difference: a free power window **overrides a TOU peak**, since a peak-rate window is a reason not to import and during free power the import is free. An explicit user stop still wins over both.
- Grid import during a free window is logged with its own `free_power` diversion reason, so it is not conflated with ordinary scheduled import in the cost breakdown.
- Settings lists the windows actually matched in the next 7 days, so a mistyped event title is visible immediately rather than only when the car fails to charge.

---

## 3. Home Energy Integrations

### Hot water - myenergi Eddi (`myenergi.js`)
- Polls the Eddi diverter every 30 seconds via HTTP Digest Auth for live divert wattage, both temperature-probe readings, and status (Solar Mode / Diverting / Boosting / Max Temp Reached / Stopped).
- Accumulates boost energy across polls into a running daily total.
- **Historical backfill** - pulls up to 30 days of hourly data from myenergi's own history endpoints to correct any gaps.
- Manual controls: boost for N minutes, stop boost, switch between Eco and Stopped modes - all from the dashboard.
- CSV import tool for historical Eddi data predating WattSnatch.

### Air conditioning - MELCloud or MelView (`ac.js` registry, `melcloud.js` / `melview.js`)
Mitsubishi Electric runs two genuinely separate cloud platforms that both get casually called "MELCloud" - same manufacturer, different accounts, different APIs. `ac_brand` setting (defaults to `melcloud`, so existing installs are unaffected) picks which one WattSnatch talks to:
- **MELCloud** (`melcloud.js`) - the global platform. Polls every 60 seconds (their hard rate limit) for every registered AC unit: power state, mode (Cool/Dry/Fan/Heat/Auto), set and room temperature, and **daily/lifetime energy use** (from which the dashboard derives a rough estimated wattage - see the Energy Flow diagram section above for its limitations).
- **MelView** (`melview.js`) *(unverified against every unit type, but its login/status flow was confirmed live against a real AU account during development)* - Mitsubishi's separate AU/NZ-only "Wi-Fi Control" platform (`api.melview.net`), used by the AU/NZ-branded phone app of the same name. Cookie-based auth rather than a token in the response body. Reports power state, mode, and set/room temperature - **but its API has no energy or power-consumption field at all**, confirmed by reading the full reference integration's response handling, so `daily_energy_kwh`/`total_energy_kwh` are always null here and the dashboard will never show a wattage figure for a MelView-configured AC, unlike MELCloud's estimate.
- Both feed into baseline anomaly detection (below) so AC operation doesn't get mistaken for a fault, and both are hidden entirely on the dashboard's Energy Flow diagram until credentials are configured for whichever is active, rather than showing a permanently-idle icon for a feature the visitor doesn't have.
- Settings UI: a single "Air Conditioning" card with a platform dropdown and one email/password form - Test Connection and Save Credentials both now validate the login synchronously before saving (previously, at least for MELCloud, invalid credentials could be saved with a false "success" message, only failing silently on the next poll).

### Per-panel solar health (`enphase-panels.js`)
- Polls per-inverter production every 5 minutes during daylight (6am–8pm).
- Uses the **median output across all panels** as a live irradiance proxy, then flags any panel producing under 80% of that median on a clear day (median > 50W) as underperforming.
- Runs a nightly analysis after 10pm and pushes a notification (ntfy + macOS) for any panel confirmed bad, throttled to one alert per panel per week.
- Supports custom nicknames per panel/position (e.g. "North roof left") for readable alerts.

### House baseline learning (`baseline.js`)
- Records 5-minute snapshots of "pure house load" (total consumption minus EV, hot water, and AC) and learns a 14-day baseline.
- Flags anomalies when load exceeds baseline by more than 40% while the AC is off and it's under 28°C outside - catching things like an appliance left running, without false-triggering during expected heat-pump AC surges.

---

## 4. Forecasting

### Solar forecast - Solcast (`solcast.js`)
- Fetches 7-day, 30-minute-resolution PV forecasts (max 10 calls/day on the free tier).
- Provides "remaining today," "tomorrow," and "last completed period" windows.
- **Intraday accuracy tracking** - compares actual generation against the forecast for the period just completed, computes an accuracy ratio, and applies it to adjust the remaining-today forecast in real time.

### Weather (`weatherGrid.js`)
- Polls Open-Meteo (no API key required) every 30 minutes: current conditions with an emoji/label mapping, next-24h cloud cover and rain probability, and 7-day daily highs/lows/rain/sunrise/sunset.

### Grid carbon intensity (`weatherGrid.js`, `src/services/gridIntensity/`)
- **AEMO (Australia, default)** - polls AEMO's public NEM data every 5 minutes for the Queensland (QLD1) region: total demand, scheduled (thermal) generation, and semi-scheduled (solar/wind) generation. Derives renewable % and an estimated carbon intensity (gCO₂/kWh) using a Queensland thermal-fleet average factor. No API key needed; unchanged behavior from before.
- **WattTime / ElectricityMaps** *(unverified, optional)* - swappable providers for other countries/regions, selected via `grid_intensity_provider` in Settings. Implemented from each service's public API documentation without a live account to test against - fails loudly (logged) rather than showing a plausible-looking but wrong value, and shows a clear "not configured" state on the dashboard rather than misleading zeros when no API key is set.

---

## 5. Financial & Cost Tracking

### Country / region setting
- A `country` setting (Settings → Region) drives which utility rate plan templates are offered and how dollar values are labelled - it doesn't change how anything is calculated internally, since internal columns/settings/variables deliberately keep their existing `_aud`-suffixed names regardless of country (a full rename was judged too invasive for no functional benefit).
- The dashboard's Grid node icon is configurable from the same Region card: enter your electricity retailer's domain (e.g. `originenergy.com.au`, `pge.com`) and it shows their favicon instead of the default plug icon. Purely cosmetic, has no effect on any calculation.

### Flat or time-of-use electricity billing
- A Settings toggle switches the whole app between a flat rate (with dated rate-history, unchanged from before) and time-of-use billing: named windows (e.g. Peak/Shoulder) with their own days-of-week + time range + rate, plus a default (off-peak) rate for everything else.
- Like flat rates, a new TOU rate card is versioned by an effective-from date, so past periods keep costing at whatever card was active at the time even after you update your rates.
- Every "Effective from" date picker echoes your selection underneath it in long form ("1 July 2026"). A browser's native date control renders in *its own* locale rather than the page's, and no page setting can change that - so `07/01/26` means January to some readers and July to others. The echo removes the ambiguity without replacing the native picker.
- One canonical rate resolver backs every dollar figure in the app - the Data page, session costs, the FBT log, financial ledger, trip-cost estimates, and retailer comparison - so nothing is computed against today's rate for historical energy under either mode. Real-time (EV/telemetry) usage is costed per-interval; hot-water usage is costed per-day (the finest granularity the Eddi's own counters support).

### US utility rate plan templates (`src/services/rateTemplates/`)
- A one-click preset picker (Settings → Electricity Rate, filtered by country) that pre-fills the TOU editor from a common utility rate plan instead of hand-building windows: **PG&E E-TOU-C**, **SCE TOU-D-PRIME**, and **SDG&E TOU-DR1** (all California, with NEM 3.0-style export windows - see below), and **Con Edison Time-of-Use** (New York, import-only - proves the registry isn't CA-specific).
- Applying a template inserts a new dated rate card exactly like manually adding one in the existing editor - a one-time starting point you can freely hand-edit afterward, not a live link back to the template.
- **Rate values are approximated from each utility's publicly published rate schedule, not verified against a live account** - utility rates change periodically, so treat every template as a starting point to confirm against your own bill, not an authoritative lookup. Each template surfaces this caveat in the UI next to the picker.

### Time-varying export/feed-in rate - NEM 3.0 support
- California's NEM 3.0 replaced flat net metering with a time-varying export credit that's often near-zero at midday and highest in the evening - this makes self-consuming solar (via EV/hot-water diversion) meaningfully more valuable than exporting, which is WattSnatch's whole premise.
- A second, independent TOU concept (`export_rate_configs`/`export_rate_windows`, mirroring the import-side tables column-for-column) models this: an `export_rate_mode` setting (default `flat`, unchanged behavior for every existing install) toggles between the existing single flat feed-in tariff and time-varying export windows.
- The daily financial ledger resolves export credit per-interval against this (same pattern already used for import cost), so a day spanning both near-zero midday export and higher evening export is costed accurately rather than averaged into one flat number.
- Applying a California rate template above sets this up automatically; it can also be configured manually (Settings → Export/Feed-in Rate).

### Energy attribution - how solar-vs-grid is worked out (`db.getEnergyBreakdownForPeriod`)
This is the single source for "what did this period cost, and where did the energy go". Everything money-related on the Data page and the Bills tab reads it, so those screens cannot disagree with each other.

- **Totals are measured, not modelled.** Import, export, cost and credit come from `grid_w`, the whole-home meter flow. No estimation is involved.
- **The solar-versus-grid split is computed once**, as a single waterfall across every category, so a watt can only be attributed to one load. It replaces three separate per-category models (house, hot water, car) that each used incompatible assumptions and were then summed - the house took a proportional share of production while the car assumed the house had first call on it, so the same watt could be billed twice.
- **The waterfall allocates the measured import**, in reverse solar priority: whatever is last in line for sunshine is first in line for the grid. This is what makes the arithmetic close - the per-category figures add up to the meter on *every interval*, not merely on average, so no after-the-fact scaling is needed and time-of-use pricing stays exact.
- Priority order is house → hot water → car, encoded in one list. Adding a monitored load is an entry in that list; the waterfall, reconciliation and API shape all follow from it.
- **Coverage is reported alongside the numbers.** Energy is integrated over the telemetry rows that exist and each row counts for at most 2 minutes, so an unrecorded hour contributes almost nothing rather than being interpolated. That understates import *and* export together, which is hard to spot by eye and looks identical to a mis-set tariff, so the share of the period actually recorded is shown rather than hidden.
- The per-category split remains an **attribution** and is presented as one; the totals are meter readings and are presented as fact.

### Wrapped - period story (`db.getWrappedForPeriod`)
A full-screen, slide-by-slide summary of a completed period: total generation, self-sufficiency, sunniest and least grid-reliant days, how many days the car and hot water ran on 95%+ solar and the longest run of them, biggest saver, which load leaned on the grid hardest, priciest day, export, and charging sessions.

- Appears on the Data page only when a **month, quarter, half-year or year has just closed**, for 10 days afterwards - it is meant to arrive, not to be dialled up for arbitrary periods. Several can be waiting at once (on 1 January the month, quarter, half and year have all just ended).
- Built on the same reconciled breakdown as the rest of the page, so the story cannot contradict the detail it summarises.
- Day-level figures come from `telemetry_log` grouped by **local** calendar day, deliberately not from `financial_ledger` - see below.
- Days with less than 18h of telemetry are excluded from "best day" superlatives, so an outage cannot win a ratio like self-sufficiency.

### Daily financial ledger
Every night, the controller computes the previous day's energy ledger from raw telemetry: kWh imported, kWh exported, kWh solar self-consumed, and a **proportional solar allocation** across the EV, hot water, and house loads based on each load's share of total consumption at each interval. Produces import cost, export credit, solar-avoided cost, and net daily cost.

**Not the source for any period total shown in the UI.** It is built incrementally and has permanent holes on any date its nightly job never ran for, and its proportional allocation predates the waterfall described above. It is retained for day-level detail and lifetime running totals only; anything describing a specific period reads `getEnergyBreakdownForPeriod` instead.

### Electricity bill parsing (`billPoller.js`)
- Polls a Cloudflare Worker mailbox hourly for incoming bill emails, pulls PDF attachments, and sends them to Google Gemini for structured extraction: billing period, retailer, total amount, GST, tariff rates, and time-of-use usage breakdown.
- Stores parsed bills for comparison against WattSnatch's own metered estimate of what the bill *should* be.
- Manual PDF upload supported as an alternative to email polling.

### Retailer comparison (`retailerComparison.js`)
- Models actual half-hourly grid import/export history (default 90-day window) against ~10 South-East Queensland retail plans (Origin, AGL, Energy Australia, Red Energy, Alinta, Simply, Ergon, plus a TOU plan and an info-only Amber wholesale reference).
- Classifies each interval into peak (3pm–9pm weekdays)/off-peak/shoulder for TOU plans.
- Reports period cost, annualised cost, and savings vs. the account's actual current plan, sorted cheapest-first.

### FBT (Fringe Benefits Tax) home-charging log
Tracks EV home-charging sessions with cost-basis (solar vs. grid kWh × rate) for personal tax/FBT record-keeping purposes.

### Solar-to-drive attribution
For every recorded drive (via TeslaMate), matches the charge session(s) that fed it within a ±60-minute window and computes what fraction of that trip's energy came from solar vs. grid - shown per-drive in the Drives tab.

---

## 6. AI Features

### AI energy briefing (`aiInsights.js`)
Generates a natural-language briefing twice daily (6:30am and 9:00pm) covering: hot water divert outlook, EV charging plan (including any upcoming trips in the next 48h), and laundry-timing suitability based on forecast solar. Tries free LLM providers in priority order - OpenRouter free-tier models first, then Claude Haiku, then Gemini - with output-cleaning to strip any chain-of-thought reasoning before display.

### Bill data extraction
As above - Gemini is used to turn unstructured bill PDFs into structured line items (this is effectively an AI-powered OCR/extraction feature, distinct from the briefing).

---

## 7. Notifications

Delivered via **ntfy** (self-hosted push) with optional macOS native notifications, covering:
- Trip grid top-up required (high priority, with approve/dismiss action buttons)
- Panel underperformance alerts
- House load anomalies (baseline exceeded)
- Solar generation milestones (new all-time daily record)
- Fully-solar charge session completions (0 grid kWh used)
- Grid-free streaks (24+ hours with no grid import)
- Morning brief (solar forecast, car status, today's trips, laundry suitability)
- Evening summary (today's generation, EV solar/grid split, tomorrow's forecast)
- Midnight charge-schedule notification when the trip planner schedules an overnight grid top-up

---

## 8. Home Assistant & MQTT

MQTT works in **both directions**, and both are fully editable at any time from
**Settings → Home Assistant / MQTT** (not just during initial setup):

- **Publishing to Home Assistant** (`mqttPublisher.js`) - pushes live solar, grid, consumption, EV, Eddi, and derived
  house-load wattage, plus a full car device (battery level, charge limit, charge amps, charger power, charging state,
  an online/connectivity sensor, a home/away presence sensor, and a `device_tracker` that shows the car on HA's map)
  out to an MQTT broker every controller tick, using retained messages so Home Assistant always has a last-known
  value on restart. Car data is sourced from the same Fleet Telemetry data every charge decision already uses, so
  it's a full car dashboard in Home Assistant with no separate Tesla integration or extra API calls. Also publishes
  seven **daily energy total** sensors (solar generated, grid import, grid export, EV charged, hot water, hot water
  boost, house usage - all kWh, resetting at midnight) as `state_class: total_increasing`, so they plug directly into
  Home Assistant's own Energy Dashboard rather than needing template sensors or utility meters built on the HA side.
  These reuse the exact same daily totals already computed for WattSnatch's own dashboard/embed view (no extra query),
  so the HA numbers can never drift from what WattSnatch itself shows for the same day. Entities are
  auto-created via HA's MQTT Discovery convention, nothing to configure on the HA side beyond having its own
  Settings → Devices & Services → MQTT integration already connected to the same broker.
  **Setup:** Settings → Home Assistant / MQTT → Publish to Home Assistant. Enter the broker URL (usually the same
  one HA already uses) and optional username/password, click Test Connection, then Save Settings. A status badge
  shows connected/not-connected, and a connection failure surfaces the actual broker error there rather than failing
  silently.
- **Bring your own inverter data** (`src/services/meters/mqttInput.js`) - feed live solar/grid data *into* WattSnatch
  from any inverter over MQTT when there's no native provider yet, including one whose data already lives in Home
  Assistant. See "Solar meter providers" in section 1.
  **Setup:** Settings → Home Assistant / MQTT → Bring your own inverter data. If the data is already in Home
  Assistant, add HA's built-in MQTT Statestream integration to `configuration.yaml` to republish the relevant
  sensors as plain MQTT topics (the Settings card includes a worked example), then map the solar and grid/consumption
  topics below, set Data source to MQTT, Test Connection, and Save Settings.
- **Car location REST endpoint** (`/api/car/location`) - a lightweight, key-authenticated endpoint that lets Home Assistant derive a `home`/`not_home` sensor for the car directly from WattSnatch's own geofence logic, without needing a separate Tesla integration in HA. (Superseded for most uses by the MQTT car entities above, which need no HA-side `rest` sensor config at all, kept for anyone already using it.)
- **TeslaMate MQTT bridge** - telemetry gathered from Tesla's Fleet Telemetry stream is also made available to TeslaMate for its own drive-logging and Grafana dashboards.

---

## 9. Historical Data & Analytics

### Charge session history
Every charging session (start reason, end reason, peak/average amps, kWh solar vs. grid, estimated savings) is stored indefinitely and browsable with period filters (day/week/month/quarter/year).

### Day Replay (`dayReplay.js`)
After sunset each day, aggregates that day's telemetry into 5-minute power-flow snapshots (solar, house, EV, hot water, grid) for an animated "replay" of the day's energy flow on the dashboard.

### Drives tab
Per-drive efficiency (Wh/km), distance, duration, and solar-vs-grid attribution, sourced from TeslaMate and cross-referenced with WattSnatch charge sessions.

### Panel health tab
Live per-panel status grid with a red/amber/green health indicator per inverter, backed by the underperformance detection above.

### Retailers tab
Interactive comparison table showing what the same usage would have cost on each modelled retail plan.

### Bills tab
Parsed historical bills, upload/import tools, and a bill-vs-actual-metered comparison.

### Solar Provenance / km-driven-by-source charts
Aggregate views breaking down, over any period, how many kilometres were driven on solar-sourced charge vs. grid-sourced charge.

### Time-of-Day Pattern heatmap
A day-of-week x hour-of-day heatmap (Data page) showing average solar excess or EV charging power for each cell, over the last 7/30/90 days - which specific hours and days actually capture solar excess or draw EV charging, complementing the hour-only "Daily Energy Shape" chart and the day-only calendar heatmap.

### Chart rendering (`public/vendor/ripl/`)
Every chart on the Data page - Daily Energy Flow, Daily Performance Heatmap, Daily Energy Shape, Time-of-Day Pattern, and Savings vs Spend - is rendered with [Ripl](https://www.ripl.run) (MIT licensed, see `THIRD_PARTY_LICENSES.md`), bundled locally in `public/vendor/ripl/ripl.bundle.js` via esbuild - no CDN, no network calls at runtime, same self-hosted/local-first model as the rest of the app. Chosen over hand-rolled `<div>`/SVG charts for real hover tooltips (touch-friendly, not the invisible-on-mobile native `title` attribute), consistent axes, and animated transitions.

### Settings & Logs pages
Full configuration UI for every integration and threshold in this document, plus a live event log viewer (state changes, API errors, commands issued, API-cost events) with configurable retention.

---

## 10. Setup & Operations

- **12-step guided setup wizard** (two steps are conditional: the Enphase login is skipped for other meter brands, and the Bluetooth LE proxy step is skipped in Fleet API mode) - solar meter selection and connection testing, Enphase gateway discovery & pairing, Tesla developer app registration walkthrough, EC keypair generation for Tesla's vehicle-command signing requirement, Tesla OAuth flow, charging preference defaults, and (macOS) background-service installation.
- **Tesla local command proxy** - commands are signed locally via Tesla's official `tesla-http-proxy` using an EC P-256 keypair, per Tesla's vehicle-command security model; WattSnatch itself never holds unsigned command authority.
- **Token lifecycle management** (`tokens.js`) - hourly check that renews the Tesla access token automatically (via refresh token) when within 10 minutes of expiry, and warns ahead of Enphase JWT expiry (which requires re-entering the Enlighten password once, never stored).
- **Encrypted credential storage** - every stored secret (OAuth tokens, API keys, and the MELCloud, MelView and iCloud calendar credentials) is AES-256-GCM encrypted at rest in SQLite, under a random 32-byte key generated once per install and held in the database. Before v1.26.0 the key was derived from the Mac's hardware UUID, falling back to a hardcoded constant on Linux and Windows; those installs were effectively unencrypted and are re-encrypted automatically on upgrade.
- **Session-based auth** with bcrypt password hashing gates the dashboard itself; a small set of endpoints (car-location for Home Assistant, embed views) use separate shared-secret auth so external tools don't need a full login session.
- **Brute-force login lockout** - failed logins escalate through 30-second, 5-minute, then 30-minute lockout tiers (global, not per-IP, since the app has one shared password rather than per-user accounts). A successful login fully resets the counter.
- **Password recovery** - `npm run reset-password -- <new-password>` (or `--clear` to remove the password entirely) for when you're locked out or have forgotten it; also clears any active lockout.
- **HTTP security headers** via `helmet`, tuned for a self-hosted LAN app (no forced HTTPS/HSTS, CSP left off pending a stricter inline-script/style refactor, cross-origin isolation relaxed so the Drives page can load map tiles and the embed view can be iframed).
- **Embeddable view** (`embed.html` / `embedRouter`) - a stripped-down, key-authenticated dashboard view suitable for wall-mounted displays or iframing elsewhere.
- **Backup & restore** (`backup.js`) - a "Download Backup" button in Settings (and `npm run backup` on the CLI) creates a zip of the database (safely hot-copied via `better-sqlite3`'s `.backup()`, not a raw file copy) plus `keys/`, with a manifest. `npm run restore` reverses it, taking its own safety snapshot first so a restore is itself undoable. `npm run update` chains backup → `git pull` → `npm install` into one command. Optionally password-protect a backup (Settings, or `npm run backup -- --encrypt`) with AES-256-GCM - worth doing before a backup leaves this machine (cloud sync, USB drive, email), since it bundles your Tesla command key; there's no password recovery if you lose it.
- **Automatic daily backups** - runs itself once a day from inside the app (checked every polling tick, no cron/launchd setup needed), on by default. Self-manages its own disk footprint: every backup from the last 7 days is kept, then thinned to one per week for ~12 weeks, then deleted - so it never needs manual pruning. Stored separately from on-demand downloads in `~/.solarcharge/backups/auto/`, restorable the same way (`npm run restore`). Status (last run, count, total size) shown in Settings.
- **Update notifications** - the dashboard checks GitHub's public releases API roughly twice a day (server-side cached, no personal data sent) and shows a badge in the top bar when a newer version exists; opt out via Settings → Backup & Restore.

---

## Data Model (SQLite)

24 tables back the app, the major ones being: `settings`, `auth_tokens` (encrypted), `charge_sessions`, `telemetry_log`, `events_log`, `electricity_rates` & `tariff_history`, `eddi_telemetry`, `ac_telemetry`, `load_history`, `electricity_bills`, `known_destinations` & `trip_log`, `solcast_forecasts` & `solcast_intraday_tracking`, `financial_ledger`, `ev_home_charging_log` (FBT), `panel_production` & `panel_health_alerts`, `day_replays`, `departure_schedule`, `weather_cache`, and `grid_intensity_log`.

Retention: telemetry history 7 days, event logs 90 days, charge sessions and financial ledger entries kept indefinitely.

---

## Architecture Summary

```
Enphase IQ Gateway (LAN)          Tesla Fleet Telemetry (ZMQ push)
       │ HTTP poll 5s                     │ real-time
       ▼                                  ▼
              controller.js (state machine)
       │                    │                    │
       ▼                    ▼                    ▼
  Tesla proxy          SQLite DB            SSE → dashboard
  (signed cmds)      (all history)       MQTT → Home Assistant
       │
       ▼
  Tesla Fleet API → car

Supporting services (independent poll loops):
  myenergi (30s) · MELCloud (60s) · Enphase panels (5min) · baseline (5min)
  Solcast (throttled) · Open-Meteo (30min) · AEMO (5min) · CalDAV (60min)
  Bill mailbox (60min) · TeslaMate (query on demand, 1h cache)
  Trip planner (5min) · Notification monitor (5min) · Day replay (post-sunset)
  AI briefing (06:30 & 21:00) · Token renewal (hourly)
```
