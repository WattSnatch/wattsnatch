# Sandbox instance

A second, isolated WattSnatch checkout for testing changes without touching
the production instance running live in the house.

## Setup

```
git worktree add /Users/youruser/solarcharge-sandbox -b sandbox main   # from the prod checkout
cd /Users/youruser/solarcharge-sandbox
npm install
```

Own `node_modules`, own `keys/` (auto-generated fresh on first boot - never
copy prod's `keys/` into the sandbox; it isn't paired as a Tesla virtual key
anyway, so a fresh keypair is fine).

## Running it

```
WATTSNATCH_DB_PATH=/Users/youruser/.solarcharge-sandbox/solarcharge.db \
PORT=3003 \
TESLA_PROXY_URL=https://127.0.0.1:19443 \
FLEET_TELEMETRY_ADDR=tcp://127.0.0.1:19678 \
node src/server.js
```

(`npm run dev` also works - same env vars, adds `node --watch` for iterative changes.)

**The three env vars above are not optional - they are what makes this safe to run
at all.** Do not omit them. Here's why each one exists:

- `WATTSNATCH_DB_PATH` - without this, `src/db.js` defaults to
  `~/.solarcharge/solarcharge.db`, which is **production's real, live database**.
  Omitting this env var means the sandbox reads and writes prod's actual data.
- `TESLA_PROXY_URL` - without this, `src/services/tesla.js` defaults to
  `https://localhost:4443`, which is **production's real, already-running
  `tesla-proxy`**, signing with the real paired Tesla virtual key. If the
  sandbox's controller loop ever decided to start/stop charging or change
  amps, it would send a **real command to the real car** through prod's proxy.
  Point it at an address nothing is listening on (e.g. `19443`) so any command
  attempt fails to connect instead.
- `FLEET_TELEMETRY_ADDR` - without this, `src/services/telemetry.js` defaults
  to `tcp://127.0.0.1:5678`, the same ZMQ PUB socket production's Fleet
  Telemetry listener subscribes to. Since ZMQ PUB/SUB allows multiple
  subscribers, the sandbox would silently receive **real, live vehicle
  telemetry** and its controller would start making real charge decisions off
  real data. Point it at a dead port (e.g. `19678`) instead.

Both env vars were added specifically to make this possible - they default to
the original hardcoded values, so production's launchd service is completely
unaffected by their existence.

## Seeding the database (one-time copy of production)

**Do not run `npm run restore` from the sandbox checkout to seed it.**
`src/services/backup.js`'s `DB_DIR` constant is computed from `os.homedir()`,
not from the checkout path - running restore from *either* checkout resolves
to the same prod path, so it would silently overwrite production's live
database. Use this procedure instead:

1. From the **production checkout**: `npm run backup` (uses `better-sqlite3`'s
   `.backup()` API - a consistent, WAL-safe snapshot, not a raw file copy).
2. Unzip the resulting backup to a scratch directory.
3. `mkdir -p ~/.solarcharge-sandbox && cp <scratch>/solarcharge.db ~/.solarcharge-sandbox/solarcharge.db`
   - a plain file copy is fine here since the unzipped `.db` is already a
   static, clean snapshot.
4. **Do not** copy the backup's `keys/` folder into the sandbox checkout.
5. **Before ever booting the sandbox**, blank live credentials copied into the
   settings table:
   ```sql
   UPDATE settings SET value='' WHERE key IN (
     'mqtt_broker_url','mqtt_username','mqtt_password',
     'ha_link_key',
     'google_calendar_client_secret','outlook_calendar_client_secret','tesla_client_secret',
     'myenergi_serial','myenergi_api_key'
   );
   ```
   Reasoning: `mqtt_broker_url`/creds point at the real broker - if left set,
   the sandbox would publish to the same topics as prod, overwriting the live
   Home Assistant sensor values. `ha_link_key`/OAuth secrets are real
   credentials that don't need to exist in a second location. `myenergi_*` -
   see the note below.

## Integrations that are NOT safe to leave live in the sandbox

- **Tesla charge commands** - closed via `TESLA_PROXY_URL` above.
- **Live vehicle telemetry** - closed via `FLEET_TELEMETRY_ADDR` above.
- **Home Assistant / MQTT out** - closed by blanking `mqtt_broker_url` above.
- **myenergi Eddi (hot water)** - `boost`/`stopBoost`/`setMode` are only ever
  called from explicit dashboard button clicks (`src/routes/api.js`), never
  autonomously by the controller loop - so this is only a risk if a human
  clicks Boost/Stop/Mode buttons in the sandbox's own dashboard UI. Credentials
  are blanked in the DB regardless, as defense in depth (`myenergi: not
  configured - skipping start` on boot confirms it's inert).
- **MELCloud (aircon)** - same story: controller.js never calls a MELCloud
  "set" function autonomously; the only thing WattSnatch's own code changes is
  credentials, not device state. **However**, MELCloud's password is stored in
  the macOS Keychain under the service name `'WattSnatch'` - this is **shared
  between the prod and sandbox checkouts** (keytar keys on service name, not
  checkout path), so the sandbox can still authenticate as the real MELCloud
  account even with DB fields blank. This is harmless unless you manually use
  a "set temperature"/mode control in the sandbox's own UI - just don't do that.
- **Enphase panel polling** - read-only monitoring of the real gateway on the
  LAN. Harmless; both instances polling the same hardware causes no conflict.

## What doesn't work in the sandbox (by design, not a bug)

- Live Tesla vehicle state (telemetry disabled) - REST fallback will just
  report the car unreachable/stale.
- Real Tesla charge commands (proxy unreachable) - will fail to connect,
  which is correct.
- Home Assistant / MQTT publishing (broker unconfigured).

None of this round's features (country setting, US rate templates, NEM 3.0
export modeling, grid-carbon source, ERCOT pricing, SPAN panel) need any of
the above to be live.
