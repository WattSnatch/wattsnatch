# Deploy WattSnatch to a Raspberry Pi (auto-start appliance)

This covers turning a Raspberry Pi into a WattSnatch box that boots straight into a running server with no manual steps - for your own home, or as the basis for the pre-configured units described in [COMMERCIAL.md](COMMERCIAL.md).

There are two related goals here:

1. **Single Pi, self-hosted** - flash it, run one script, done.
2. **Golden image for multiple units** - build one Pi properly, then clone its SD card so you're not repeating the setup by hand for every unit you sell/ship.

---

## Recommended hardware

- **Raspberry Pi 4 or 5** (4GB+ RAM). A Pi 3 will run WattSnatch but feels sluggish with `better-sqlite3` + the dashboard's SSE stream under load.
- **Boot from USB SSD, not microSD, if you're shipping these to other people.** SD cards wear out from the constant small writes WattSnatch does (telemetry logging every few seconds) and are the #1 cause of "it just stopped working" support requests for appliance-style Pi projects. A cheap USB3 SSD is a few dollars more and meaningfully more reliable. Raspberry Pi Imager supports USB SSD boot directly on Pi 4/5.
- Ethernet if possible - one less thing to debug in Enphase/Tesla proxy connectivity issues.

## 1. Flash the OS

Use [Raspberry Pi Imager](https://www.raspberrypi.com/software/):

- OS: **Raspberry Pi OS Lite (64-bit)** - no desktop needed, this runs headless.
- In the Imager's advanced options (gear icon / Ctrl+Shift+X): set hostname (e.g. `wattsnatch`), enable SSH, set a username/password, and pre-configure Wi-Fi if not using Ethernet.

Boot the Pi, then SSH in.

## 2. Run the provisioning script

```bash
git clone <your-repo-url> ~/solarcharge
cd ~/solarcharge
chmod +x scripts/setup-pi.sh
./scripts/setup-pi.sh
```

This does everything `INSTALL.md` steps 3–9 describe, automated for Debian/Raspberry Pi OS: installs Node 22, runs `npm ci`, builds the `tesla-proxy` Go binary natively for arm64, generates the EC key pair if missing, and installs both the app and the proxy as **systemd services** (`wattsnatch.service`, `wattsnatch-proxy.service`) that start on boot and restart automatically if they crash.

When it finishes, the dashboard is live at `http://<pi-ip>:3001`. Continue with `INSTALL.md` sections 5–11 (Tesla developer app, setup wizard, pairing the virtual key, optional integrations).

Useful commands afterwards:

```bash
systemctl status wattsnatch wattsnatch-proxy   # check both are running
sudo systemctl restart wattsnatch              # restart after a code update
journalctl -u wattsnatch -f                    # follow systemd's view of the logs
tail -f ~/solarcharge/data/stdout.log          # app's own log file
```

### One caveat: `keytar` on headless Linux

Two *optional* integrations (MELCloud air-con monitoring, iCloud calendar for trip planning) store credentials via `keytar`, which relies on a system keyring (`libsecret`/GNOME Keyring). A bare Raspberry Pi OS Lite install doesn't have one running, so those two integrations specifically may fail to save credentials until you install and unlock a headless keyring:

```bash
sudo apt-get install -y gnome-keyring libsecret-1-0
```

Core functionality (Enphase, Tesla, Eddi) doesn't use `keytar` - it stores tokens encrypted in the SQLite DB - so this only matters if you use those two specific integrations.

---

## 3. Building a golden image for multiple units

If you're going to hand-build several of these (the "Assisted" tier from `COMMERCIAL.md`), don't repeat steps 1–2 by hand each time. Build one properly, then clone it:

1. Follow steps 1–2 above on a first Pi, **but stop before running the WattSnatch setup wizard.** You want the software installed and the services enabled, with an empty/unconfigured database - not your own Enphase/Tesla credentials baked into every unit you ship.
2. Reset it to a clean, unconfigured state:
   ```bash
   sudo systemctl stop wattsnatch wattsnatch-proxy
   rm -f ~/solarcharge/data/*.db ~/solarcharge/data/*.log
   rm -f ~/solarcharge/keys/private.pem ~/solarcharge/keys/public.pem   # regenerate per unit, don't clone a shared key
   sudo systemctl start wattsnatch wattsnatch-proxy
   ```
   Confirm the dashboard now shows the first-run setup wizard, not your own data.
3. Shut the Pi down, remove the SD card / SSD, and image it from another machine:
   ```bash
   # macOS/Linux, replace /dev/diskN with the actual device (check with `diskutil list` / `lsblk`)
   sudo dd if=/dev/diskN of=wattsnatch-golden.img bs=4M status=progress
   ```
   Shrink the image so it's not the full card size (otherwise every clone is stuck at the golden card's capacity): [PiShrink](https://github.com/Drewsif/PiShrink) is the standard tool for this - `sudo pishrink.sh wattsnatch-golden.img`.
4. To produce a new unit: flash `wattsnatch-golden.img` to a fresh SD card/SSD with Raspberry Pi Imager (or `dd`), boot it, and it comes up running WattSnatch with the setup wizard waiting. Per-unit steps that must still happen individually (can't be baked into the image):
   - EC key pair generation (each device needs its own - this happens automatically on first `setup-pi.sh` run, or trigger it manually per the `INSTALL.md` step 5 snippet)
   - Hostname/Wi-Fi if it differs per unit
   - The customer's own Enphase/Tesla setup wizard

---

## What I can't do from here

I can write and test all of the above code and scripts, but I don't have physical access to a Raspberry Pi - flashing the SD card, plugging it in, and confirming it boots correctly is something you'll need to do and report back on. If `setup-pi.sh` hits an error on real hardware, paste me the output and I'll fix it.
