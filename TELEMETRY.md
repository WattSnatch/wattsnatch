# Setting Up Tesla Fleet Telemetry for WattSnatch

This is an **optional, advanced** setup guide. WattSnatch works completely fine without this - by default it polls the Tesla REST API as a fallback (every ~2 minutes while it's needed), which is enough for solar-diversion charging. Fleet Telemetry gives you real-time (sub-second) car data instead of that polling fallback. Only do this if you want that extra responsiveness and are comfortable with some networking setup.

**Read this whole document before starting** - the very first section below is a hard architectural constraint that determines whether this is even possible for your setup.

---

## Table of contents

1. [The one constraint that decides everything](#1-the-one-constraint-that-decides-everything)
2. [What Fleet Telemetry actually is](#2-what-fleet-telemetry-actually-is)
3. [Prerequisites](#3-prerequisites)
4. [Get a public hostname pointing at your WattSnatch machine](#4-get-a-public-hostname-pointing-at-your-wattsnatch-machine)
5. [Get a valid TLS certificate](#5-get-a-valid-tls-certificate)
6. [Register the hostname with your Tesla developer app](#6-register-the-hostname-with-your-tesla-developer-app)
7. [Run Tesla's fleet-telemetry server](#7-run-teslas-fleet-telemetry-server)
8. [Tell Tesla to start streaming - the WattSnatch side](#8-tell-tesla-to-start-streaming---the-wattsnatch-side)
9. [Verifying it's working](#9-verifying-its-working)
10. [Keeping it running](#10-keeping-it-running)
11. [Troubleshooting](#11-troubleshooting)
12. [Security notes](#12-security-notes)

---

## 1. The one constraint that decides everything

**WattSnatch's Fleet Telemetry listener only ever connects to `127.0.0.1` (localhost) - it cannot subscribe to a telemetry server running anywhere else on your network or on a cloud VPS.** (See `src/services/telemetry.js` - the ZMQ address is fixed, not currently a setting.)

This means: **Tesla's `fleet-telemetry` server binary must run on the exact same physical machine that runs WattSnatch itself.** You cannot put it on a cheap cloud VPS and point WattSnatch at it over the network - that's how most general "Tesla Fleet Telemetry" tutorials online are written, but it will **not** work with WattSnatch as shipped today.

Practically, this means your WattSnatch machine (the Mac Mini / NUC / Pi sitting on your home network) needs to be **reachable from the public internet on port 443** - which for a typical home internet connection means router port-forwarding plus a way to keep a public hostname pointed at your home IP as it changes. Section 4 covers both ways to do this.

If your home network is behind Carrier-Grade NAT (CGNAT) - common on some mobile broadband, Starlink, and some NBN plans - you **cannot** port-forward at all, and this guide won't work for you regardless of anything else. Check with your ISP if you're not sure; if `whatismyip.com` shows a different IP than your router's WAN address, you're behind CGNAT.

---

## 2. What Fleet Telemetry actually is

Tesla's `fleet-telemetry` is Tesla's own open-source server (github.com/teslamotors/fleet-telemetry) that your car connects **outbound** to, over a persistent TLS connection, and streams live vehicle data to. You run an instance of it yourself; nothing about it is hosted by Tesla. Once running, WattSnatch subscribes to that local instance over ZMQ and gets pushed updates instead of asking the Tesla REST API for them.

Compared to the REST polling fallback:

| | REST fallback (default) | Fleet Telemetry |
|---|---|---|
| Setup effort | None - works out of the box | Domain, TLS cert, port-forwarding, running an extra service |
| Update frequency | ~Every 2 minutes while needed | Sub-second, as it happens |
| Tesla API cost | Occasional `data` calls | None for updates (telemetry is free once configured) |
| Reliability | Very simple, few moving parts | One more thing that can silently stop working |

For solar diversion specifically, the 2-minute REST fallback is genuinely fine most of the time - the difference mainly shows up in how quickly the dashboard reflects charge-state changes. Weigh that against the setup effort below before committing to this.

---

## 3. Prerequisites

- WattSnatch already installed and working (see `INSTALL.md`), including a completed Tesla Fleet API developer app registration and OAuth connection.
- A domain name you control (a subdomain of something you already own is fine - you do **not** need a second domain beyond what `INSTALL.md` step 6 already had you set up for key hosting).
- Administrative access to your home router (to set up port forwarding), **or** a tunnel solution that supports raw TCP passthrough (see the note in section 4).
- Comfort running one extra background service (Docker is the easiest way; a native binary works too).

---

## 4. Get a public hostname pointing at your WattSnatch machine

You need a hostname that resolves to your home's current public IP, and port 443 on that IP forwarded to your WattSnatch machine.

### Option A - Dynamic DNS + port forwarding (most common)

1. Most home routers change public IP periodically. Set up **Dynamic DNS (DDNS)**: many routers have a built-in DDNS client (check Settings → WAN or Advanced), or use a free/cheap third-party DDNS service and run their small updater script/container on your WattSnatch machine. Point a subdomain (e.g. `telemetry.yourdomain.com`) at whatever DDNS gives you, either directly or via a CNAME.
2. In your router's port forwarding settings, forward **external port 443 → your WattSnatch machine's local IP, port 443**. Give your WattSnatch machine a static/reserved local IP first (in your router's DHCP settings) so this doesn't break when it renews its lease.
3. Confirm it works before continuing: from **outside** your home network (e.g. phone on mobile data, with Wi-Fi off), `curl -v https://telemetry.yourdomain.com` should at least attempt a TLS handshake (it'll fail with a certificate error at this point - that's expected, you haven't set one up yet - you're just confirming the connection reaches your machine).

### Option B - Tunnel with raw TCP passthrough (no port forwarding needed)

If you can't or don't want to port-forward (CGNAT, restrictive ISP router, or you just prefer it), a tunnel service that does **TCP passthrough without terminating TLS** can work - for example Cloudflare Tunnel's TCP application mode. This matters specifically because Tesla's vehicle validates the TLS certificate presented by the telemetry server directly; if a proxy terminates TLS and re-encrypts (as most HTTP-oriented tunnels do), the car will be talking to the tunnel's certificate, not yours, and the `ca` field you register with Tesla won't match. You specifically need **raw TCP forwarding**, not an HTTPS reverse proxy, for this to work. Setting this up is provider-specific - consult your tunnel provider's docs for "TCP" or "raw port" application types, not their standard web-proxy mode.

---

## 5. Get a valid TLS certificate

Tesla vehicles **will not connect to a self-signed certificate** - you need one from a real, publicly trusted CA. **Let's Encrypt** (free) is what this guide and WattSnatch's default configuration assume.

Using `certbot` on the WattSnatch machine:

```bash
sudo certbot certonly --standalone -d telemetry.yourdomain.com
```

(`--standalone` temporarily binds port 80/443 itself to complete the HTTP-01 challenge - stop any other service using those ports first, or use `--webroot` / DNS-01 instead if that's a problem for you.)

This produces `fullchain.pem` and `privkey.pem` under `/etc/letsencrypt/live/telemetry.yourdomain.com/`. The `fleet-telemetry` binary needs both files (section 7).

**Set up auto-renewal** - Let's Encrypt certs expire every 90 days:
```bash
sudo certbot renew --dry-run   # confirms renewal will work
```
Certbot installs its own renewal timer/cron job automatically on most systems; just confirm it's active (`systemctl list-timers | grep certbot` on Linux).

### How the car decides whether to trust your server - read this before anything breaks

This is the single most important fact in this guide, and it is not obvious:
**the vehicle does not use a normal public trust store. It validates your
server's TLS certificate against exactly the `ca` chain contained in the last
`fleet_telemetry_config` it applied - nothing else.** Tesla's own docs describe
the `ca` field as "the full certificate chain used to generate the server's TLS
certificate".

Three consequences follow, and each one has caused a real outage:

1. **The `ca` field must be the full chain** - every certificate above your
   leaf (intermediate *and* root), not just the issuing intermediate. A lone
   intermediate can be rejected even when it directly issued your cert.
2. **Any change to your certificate's chain silently strands the car.** If a
   renewal comes from a different intermediate (Let's Encrypt rotates them:
   E5/E6/E7, and newer generations regularly), the car keeps validating against
   the old chain and drops every connection with `remote error: tls: bad
   certificate`. Nothing on your side errors - the car just stops connecting
   and WattSnatch quietly falls back to slow REST polling.
3. **The fix for a chain change is always a config re-send** (section 8), never
   just a certificate swap and restart.

Extract the full chain to paste into WattSnatch's **CA certificate** field
(Settings → Fleet Telemetry) - everything in `fullchain.pem` except the first
certificate (the leaf):

```bash
awk '/BEGIN CERT/{n++} n>=2' /etc/letsencrypt/live/telemetry.yourdomain.com/fullchain.pem
```

Do not leave the CA field blank. WattSnatch's built-in default is a snapshot of
one Let's Encrypt intermediate (E7) that will not match certificates issued
after Let's Encrypt rotates again - relying on it means your setup breaks on a
future renewal, not today, which is the worst kind of breakage. Always paste
the chain of the certificate you are actually serving. The `ca` field accepts
a bundle of several certificates, which section 10 uses for safe migrations.

---

## 6. Register the hostname with your Tesla developer app

Tesla only accepts `fleet_telemetry_config` requests for hostnames under a domain your developer app has already registered ("partner account registration") - this is the same registration you did in `INSTALL.md` when hosting your public key. If you try to register a telemetry hostname that Tesla can't match to your registered domain, you'll get an error like:

```
"error": "hostname domain does not match with partner account"
```

If your telemetry hostname is a subdomain of the same domain you used for key hosting (e.g. key hosting at `yourdomain.com`, telemetry at `telemetry.yourdomain.com`), this should already be covered - Tesla matches on the registered root domain. If you're using a completely unrelated domain for telemetry, you'll need to run the partner registration step again for that domain first (see `src/routes/setup.js` → `/api/setup/register-partner`, or redo setup wizard step 6 with the new domain).

---

## 7. Run Tesla's fleet-telemetry server

This is Tesla's own binary, not part of WattSnatch. Get it from [github.com/teslamotors/fleet-telemetry](https://github.com/teslamotors/fleet-telemetry) - **check that repository's own README for the current, authoritative configuration format**, since it's maintained by Tesla and changes independently of WattSnatch. What follows is the shape of what you need, to orient you before you read their docs in detail:

- Point it at your Let's Encrypt cert and key files from section 5.
- Bind it to listen on port 443.
- Configure it to output to a **ZMQ** dispatcher (as opposed to Kafka or the other backends it supports), bound to `tcp://127.0.0.1:5678` - this is the exact address WattSnatch's `telemetry.js` subscribes to, so this part is not optional or renameable on WattSnatch's side.
- Run it as a background service alongside WattSnatch and the Tesla command proxy (Docker Compose, or a systemd unit / launchd plist depending on your OS - same pattern as `INSTALL.md` section 9 uses for the other services).

Confirm it's listening before moving on:
```bash
sudo lsof -i :443        # should show your fleet-telemetry process
netstat -an | grep 5678  # should show it bound locally for ZMQ
```

---

## 8. Tell Tesla to start streaming - the WattSnatch side

With your telemetry server running and reachable, this part is fully self-service from the WattSnatch dashboard:

1. Go to **Settings → Fleet Telemetry (Advanced)**.
2. Enter your **telemetry server hostname** (e.g. `telemetry.yourdomain.com`) and leave port at `443`.
3. Paste the **full CA chain** of your certificate into the **CA certificate** field (section 5 has the exact command). Do not leave it blank - the built-in default breaks on future renewals.
4. Click **Send Config to Tesla**.

The car applies a new config within a few minutes of being awake and online.
When it applies one that changes the connection details, it drops its current
session and reconnects - a `DISCONNECTED` followed by a fresh `CONNECTED` in
the fleet-telemetry log is the sign the new config took effect.

Behind the scenes this calls `POST /api/setup/send-telemetry-config`, which builds the `fleet_telemetry_config` payload from your settings and sends it to Tesla via the local Tesla command proxy (the same signed-command proxy from `INSTALL.md` section 4 - it must be running for this step to work). A success response means Tesla has accepted the config and will push it to your car the next time it's online.

The fields WattSnatch requests, and at what interval, are fixed in code (`src/routes/setup.js`) - currently `ChargeAmps`, `DetailedChargeState`, `Soc`, `ChargeLimitSoc`, `ChargerVoltage`, `ACChargingPower`, and `Location`, which is everything the controller needs and nothing more.

---

## 9. Verifying it's working

- Watch your `fleet-telemetry` server's own logs - you should see an incoming connection from your vehicle shortly after it's next awake, followed by a stream of data messages.
- On the WattSnatch dashboard, the "Tesla: OK" indicator should stay live-updating rather than only refreshing every couple of minutes.
- Check WattSnatch's own event log (Logs page) for `Subscribed to ZMQ socket tcp://127.0.0.1:5678` at startup - confirms the app-side subscriber connected to your local fleet-telemetry instance correctly.
- If the car has been asleep, telemetry won't show anything until it wakes - this is normal, not a fault.

---

## 10. Keeping it running

### Certificate renewal is NOT fire-and-forget

An automatic `certbot renew` plus a service restart is **not enough**, and
setting exactly that up and walking away is how this breaks. Renewal gives you
a new certificate; if Let's Encrypt has rotated intermediates since the last
one, the new chain no longer matches the `ca` the car has pinned (section 5),
and the car silently stops connecting the moment the renewed cert is served.
`fleet-telemetry` also only reads its certificate at startup, so a renewal
without a restart changes nothing at all.

After **every** renewal, check whether the chain changed:

```bash
openssl x509 -in /etc/letsencrypt/live/telemetry.yourdomain.com/fullchain.pem -noout -issuer
```

If the issuer differs from what is in your WattSnatch **CA certificate** field:
update that field with the new full chain (section 5's command) and **Send
Config to Tesla** again. If it is unchanged, a restart of `fleet-telemetry` is
all that's needed. Symptoms of getting this wrong: continuous
`TLS handshake error ... remote error: tls: bad certificate` lines in the
fleet-telemetry log from your car's IP, while WattSnatch shows stale, slow
data - no error is raised anywhere.

### Changing the hostname (or CA) without an outage

Because the `ca` field accepts a bundle, migrations can be made safe and
reversible. To move to a new hostname or a new certificate chain:

1. Get a certificate covering **both** the old and new hostnames (one cert,
   two SANs), or when only the chain is changing, keep the current cert.
2. Set the CA field to a bundle of **both** chains: the one the car currently
   trusts plus the new one, concatenated. Send Config to Tesla. The car now
   trusts either.
3. Point `fleet-telemetry` at the new certificate and restart it. The car
   reconnects, validating the new chain against the bundle.
4. Update the hostname in Settings, Send Config again. The car drops its
   session and reconnects to the new name.
5. Let it soak through at least one full car sleep/wake cycle - the wake
   reconnect is the real test of DNS plus certificate plus config together.
6. Only then clean up: remove the old DNS record, and send one final config
   with the old chain removed from the bundle.

One change per step, verify the reconnect after each, and every step is
individually reversible.

### The rest

- **Dynamic DNS**: if your home IP changes and DDNS lags behind, the hostname will stop resolving correctly until it catches up - most DDNS clients update every few minutes, which is normally fine.
- **Service restarts**: run `fleet-telemetry` as a proper background service (not a manual foreground process) using the same service-manager pattern (`launchd`/`systemd`/PM2) you used for WattSnatch itself in `INSTALL.md`, so it survives reboots and crashes.
- If you ever stop running Fleet Telemetry, WattSnatch falls straight back to REST polling automatically - there's nothing to "undo" on the WattSnatch side; it degrades gracefully if the ZMQ socket simply isn't there.

---

## 11. Troubleshooting

**"hostname domain does not match with partner account"**
Your telemetry hostname isn't under a domain your Tesla developer app has registered - see section 6.

**Nothing shows up on the WattSnatch dashboard, no errors either**
Check the car is actually awake and online - telemetry only flows while the car is connected to Tesla's servers.

**`fleet-telemetry` won't start / TLS handshake errors**
Almost always a certificate path or permissions issue - confirm the binary can actually read both `fullchain.pem` and `privkey.pem` (Let's Encrypt's live directory is often root-only by default).

**Port forwarding seems right but the external test in section 4 still fails**
Double-check your WattSnatch machine's local IP hasn't changed (reserve it in your router's DHCP settings), and confirm no other local firewall (e.g. macOS's own firewall, `ufw` on Linux) is blocking inbound 443.

**`TLS handshake error ... remote error: tls: bad certificate` from your car's IP, over and over**
The car is rejecting your certificate because it no longer chains to the `ca`
the car has pinned from its last-applied config. This is what a renewal onto a
rotated intermediate looks like, and it is also what a wrong or partial CA
field looks like (a lone intermediate instead of the full chain). Fix: put the
full chain of the certificate you are actually serving into the CA field and
Send Config to Tesla again (sections 5 and 10). Note the error text says the
*remote* end (the car) sent the alert - your server's certificate loads fine,
which is exactly why nothing else complains.

**It worked, then silently stopped some weeks later**
Check certificate expiry first (`openssl x509 -enddate -noout -in fullchain.pem`) - a lapsed renewal is the most common cause. If the certificate is current but was recently *renewed*, check whether the renewal changed the issuer chain - see the entry above and section 10.

---

## 12. Security notes

You are opening a port directly to a home server on the public internet - treat that machine accordingly:
- Only forward port 443, nothing else, to this specific machine.
- Keep `fleet-telemetry` and the OS itself patched.
- The telemetry stream itself is one-directional (car → your server) and TLS-encrypted end to end using your own certificate - Tesla's vehicle firmware, not just anyone, is the intended client, but a correctly-configured TLS server is still the right amount of caution to apply here, same as any other public-facing service.
- If you decide this isn't worth the exposure for your setup, that's a completely reasonable call - the REST fallback path exists precisely so this integration can stay optional.
