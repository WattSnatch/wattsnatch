# Deploy WattSnatch to Mac Mini Server
**Server:** `your-server-hostname` (`192.0.2.10`), user `youruser`  
**Run all commands on the Mac Mini unless stated otherwise.**

---

## Step 1 - Copy the app to the server

Run this on your **development Mac** (not the server):

```bash
rsync -av --exclude='.git' --exclude='node_modules' --exclude='data' --exclude='keys' \
  /Users/youruser/solarcharge/ \
  youruser@192.0.2.10:/Users/youruser/solarcharge/
```

> `data/` is excluded - your database stays put if you're updating an existing install.  
> `keys/` is excluded for the same reason. On a fresh install you'll generate new keys in Step 5.

---

## Step 2 - Install Node.js (if not already installed)

```bash
# Check if Node is already installed
node --version   # need v18 or later

# If not installed, use nvm:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.zshrc   # or ~/.bash_profile
nvm install 22
nvm use 22
nvm alias default 22
```

---

## Step 3 - Install dependencies

```bash
cd /Users/youruser/solarcharge
npm install
```

`zeromq` compiles a native addon - it will take 30–60 seconds on first install.  
If you see `node-gyp` errors:

```bash
xcode-select --install   # install Xcode Command Line Tools
npm install              # then retry
```

---

## Step 4 - Verify the tesla-proxy binary is present

The `tesla-proxy` binary must be in the app folder. Check:

```bash
ls -la /Users/youruser/solarcharge/tesla-proxy
./tesla-proxy --help 2>&1 | head -5
```

If it's missing, it needs to be rebuilt from source:

```bash
# Install Go (if not present)
brew install go

# Clone and build
cd ~
git clone https://github.com/teslamotors/vehicle-command.git
cd vehicle-command
go build ./cmd/tesla-http-proxy
cp tesla-http-proxy /Users/youruser/solarcharge/tesla-proxy
chmod +x /Users/youruser/solarcharge/tesla-proxy
```

---

## Step 5 - Generate the EC key pair (fresh install only)

Skip this step if `keys/private.pem` and `keys/public.pem` already exist from a previous install.

```bash
cd /Users/youruser/solarcharge
node -e "
const { generateKeyPair } = require('./src/services/tesla');
generateKeyPair(__dirname);
console.log('Keys generated in keys/');
"
```

Then generate the proxy TLS cert (self-signed RSA - this is just for the local proxy, not for vehicle commands):

```bash
mkdir -p keys
openssl req -x509 -newkey rsa:2048 -keyout keys/proxy-tls-key.pem \
  -out keys/proxy-tls-cert.pem -days 3650 -nodes \
  -subj "/CN=localhost"
```

**Important:** The EC P-256 public key (`keys/public.pem`) must be hosted at:  
`https://YOUR_GITHUB_USERNAME.github.io/.well-known/appspecific/com.tesla.3p.public-key.pem`  

This is required for Tesla Fleet API. See the README for full instructions if setting up from scratch.

---

## Step 6 - First run (setup wizard)

Start the app manually first to run through the setup wizard:

```bash
cd /Users/youruser/solarcharge
node src/server.js
```

Open a browser and go to `http://192.0.2.10:3001`

You'll be redirected to the setup wizard. Complete it:
1. **Enphase** - enter your Enlighten email/password and gateway IP (try `envoy.local` for auto-discovery)
2. **Tesla** - enter your Tesla Developer app Client ID and Secret, then click "Connect Tesla" to do the OAuth flow
3. **Home location** - click "Use Car's Current Location" (car must be awake and home)
4. Finish setup - the controller starts automatically

> The setup wizard stores all credentials encrypted in `data/solarcharge.db`. You only need to do this once.

---

## Step 7 - Install as launchd services (auto-start on boot)

The app includes a built-in launchd installer. From the **Settings** page in the web UI, click **"Install as System Service"**. This installs and loads both:
- The main app (`com.youruser.solarcharge`)
- The Tesla proxy (`com.youruser.solarcharge.proxy`)

Or do it manually:

```bash
cd /Users/youruser/solarcharge
node -e "
const { installPlists } = require('./src/utils/launchd');
const os = require('os');
const { paths } = installPlists(__dirname, os.userInfo().username);
console.log('Installed:', paths);
"
```

Verify both services are running:

```bash
launchctl list | grep solarcharge
```

You should see three entries:
- `com.youruser.solarcharge` (app, port 3001)
- `com.youruser.solarcharge.proxy` (Tesla proxy, port 4443)
- `com.solarcharge.telemetry` (Fleet Telemetry, already running from earlier setup)

---

## Step 8 - Send the Fleet Telemetry config to the car

This is a one-time step that tells the Tesla what fields to stream and where to send them.

First, get your stored Tesla credentials from the database:

```bash
cd /Users/youruser/solarcharge
node -e "
const db = require('./src/db').initDb();
const { decrypt } = require('./src/utils/crypto');
const vin = db.getSetting('tesla_vin');
const row = db.getToken('tesla');
const token = JSON.parse(decrypt(row.token_data));
console.log('VIN:', vin);
console.log('Token (first 60 chars):', token.access_token.slice(0, 60) + '...');
"
```

Copy the full VIN and token, then run (replace the placeholders):

```bash
VIN="YOUR_VIN_HERE"
TOKEN="YOUR_FULL_TOKEN_HERE"

curl -k -X POST "https://localhost:4443/api/1/vehicles/${VIN}/fleet_telemetry_config" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"vins\": [\"${VIN}\"],
    \"config\": {
      \"hostname\": \"telemetry.parallelhometech.com.au\",
      \"port\": 443,
      \"ca\": \"\",
      \"fields\": {
        \"ChargeAmps\":          { \"interval_seconds\": 1  },
        \"DetailedChargeState\": { \"interval_seconds\": 1  },
        \"Soc\":                 { \"interval_seconds\": 30 },
        \"ChargeLimit\":         { \"interval_seconds\": 60 },
        \"ChargerVoltage\":      { \"interval_seconds\": 30 },
        \"ChargerPower\":        { \"interval_seconds\": 5  },
        \"Location\":            { \"interval_seconds\": 60 }
      }
    }
  }"
```

Expected response: `{"response":{"result":true},"error":null}`

> `-k` skips TLS verification for localhost - safe here, you're talking to your own proxy.

### Verify the config synced to the car

The car must be awake (wake it from the Tesla app if needed):

```bash
curl "https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/vehicles/${VIN}/fleet_telemetry_config" \
  -H "Authorization: Bearer ${TOKEN}"
```

Wait for `"synced": true` - can take up to 5 minutes after the car wakes.

---

## Step 9 - Verify everything is working

### Check all services are running:
```bash
# App + proxy
launchctl list | grep youruser.solarcharge

# Fleet Telemetry
sudo launchctl list | grep solarcharge.telemetry
```

### Watch live telemetry arrive:
```bash
tail -f ~/.solarcharge/telemetry-error.log
```

With the car awake and plugged in, you should see JSON vehicle data messages appearing every few seconds.

### Check the app logs:
```bash
tail -f /Users/youruser/solarcharge/data/stdout.log
```

You should see on startup:
```
[Telemetry] Subscribed to ZMQ socket tcp://127.0.0.1:5678
[WattSnatch] Listening on http://0.0.0.0:3001
[Controller] Controller started (Enphase interval 15000ms, Fleet Telemetry active)
```

### Open the dashboard:
Go to `http://192.0.2.10:3001` from any device on your network.

- **Gateway pill** → green = Enphase is responding
- **Tesla pill** → green = Fleet Telemetry has received car data in the last 5 minutes
- Battery %, charge state, and solar flow update live

---

## Restart / Update commands

```bash
# Restart the app after a code update:
launchctl kickstart -k gui/$(id -u)/com.youruser.solarcharge

# Restart the Tesla proxy:
launchctl kickstart -k gui/$(id -u)/com.youruser.solarcharge.proxy

# Restart Fleet Telemetry (needs sudo - system daemon):
sudo launchctl kickstart -k system/com.solarcharge.telemetry

# View app logs:
tail -f ~/solarcharge/data/stdout.log
tail -f ~/solarcharge/data/stderr.log
```

---

## Troubleshooting

**`[Telemetry] zeromq not installed` in logs:**
```bash
cd /Users/youruser/solarcharge && npm install
launchctl kickstart -k gui/$(id -u)/com.youruser.solarcharge
```

**Tesla pill stays red (no telemetry) after car is awake:**
```bash
# Check Fleet Telemetry is running and not erroring
sudo launchctl list | grep solarcharge.telemetry
tail -50 ~/.solarcharge/telemetry-error.log

# Check Tesla's error endpoint (shows why the car can't connect)
curl "https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/vehicles/${VIN}/fleet_telemetry_errors" \
  -H "Authorization: Bearer ${TOKEN}"

# Verify the TLS cert is being served correctly externally
openssl s_client -connect telemetry.parallelhometech.com.au:443 </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -dates
```

**`synced: false` after sending telemetry config:**
- Wake the car via the Tesla app, wait 2 minutes, re-run the verify command
- Try resending the config

**Charging commands fail / `ECONNREFUSED` on port 4443:**
```bash
# Check the Tesla proxy is running
launchctl list | grep proxy

# Try starting it manually to see errors:
cd /Users/youruser/solarcharge
./tesla-proxy -cert keys/proxy-tls-cert.pem \
              -tls-key keys/proxy-tls-key.pem \
              -key-file keys/private.pem \
              -port 4443 \
              -verbose
```

**Gateway pill red / Enphase not responding:**
- Check the gateway IP in Settings matches your Enphase IQ Gateway's LAN IP
- The gateway JWT expires every 6 months - the app auto-renews, but if it fails, go to Settings → re-enter Enphase password to force a refresh

**Roll back to the pre-telemetry polling version:**
```bash
cd /Users/youruser/solarcharge
git checkout 5dc908c -- src/controller.js
# Remove zeromq dependency from package.json if desired
npm start
```
