# Visa Slot Bot 🛂📲

A tiny, dependency-free Node service that **ports the "Check US Visa Slots" Chrome
extension into a headless bot**. It polls the same CheckVisaSlots backend the
extension uses, every ~2 minutes, and sends you an **urgent WhatsApp alert** the
moment a US visa slot opens up at a location you care about.

No browser, no visa-portal login, no CAPTCHA — it reuses CheckVisaSlots'
crowdsourced slot feed, so it's light enough to run free in the cloud.

## How it works

The extension gets all its slot data from one authenticated API call. This bot
makes the exact same call:

| | |
|---|---|
| Slots | `GET https://app.checkvisaslots.com/slots/v3` |
| Validate key | `GET https://app.checkvisaslots.com/validate/v3` |
| Auth | headers `x-api-key: <your access code>` + `extVersion: 4.7.3` |

The response is `{ userDetails, slotDetails: [{ visa_location, slots, start_date, createdon }] }`.
A location has openings when `slots > 0`; `createdon` says how fresh that
sighting is. Detection rules match the extension:

- **Dropbox** appointment type → all locations count.
- **Consular/interview** → `VAC` (document-drop) locations are ignored.
- Confidence by freshness: 🔥 ≤2 min · ⚠️ ≤5 min · ℹ️ older (within your window).

On a fresh, relevant `slots > 0`, it WhatsApps you via [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/)
and won't spam (per-location cooldown + change detection).

## Setup (5 minutes)

### 1. Get your CheckVisaSlots API key
Open the **Check US Visa Slots** extension popup → copy the **Access Code**
(API key) field. (It's the same key stored as `apiKey` by the extension.)

### 2. Activate CallMeBot WhatsApp (one-time, free)
From the phone you want alerts on:
1. Add **+34 644 91 96 80** to your contacts.
2. Send it this WhatsApp message: **`I allow callmebot to send me messages`**
3. You'll get a reply with your personal **apikey**. (See
   https://www.callmebot.com/blog/free-api-whatsapp-messages/)

### 3. Configure
```bash
cp .env.example .env
# then edit .env and fill in:
#   CVS_API_KEY, CALLMEBOT_PHONE (+countrycode), CALLMEBOT_APIKEY
```

### 4. Test it
```bash
npm run validate   # confirms your key + prints the current live slot feed
npm run check      # runs ONE poll cycle (alerts if something's open)
```

### 5. Run it
```bash
npm start          # polls every 2 minutes, forever
```

## Deploy to free cloud

### Fly.io — recommended (true 2-min polling, always-on)
```bash
fly launch --no-deploy         # pick an app name; keep the Dockerfile
fly secrets set \
  CVS_API_KEY=xxxx \
  CALLMEBOT_PHONE=+14085551234 \
  CALLMEBOT_APIKEY=123456
fly deploy
fly logs                       # watch it run
```

### GitHub Actions — zero-infra fallback (~5-min polling)
Push this repo to GitHub, add repo secrets `CVS_API_KEY`, `CALLMEBOT_PHONE`,
`CALLMEBOT_APIKEY` (Settings → Secrets → Actions). The workflow in
`.github/workflows/check.yml` runs `--once` on a schedule. GitHub's minimum is
5 minutes (and can lag), so use Fly/a VPS if you truly need 2.

### Railway / Render / any VPS
It's just `node src/index.js` — deploy as a **worker/background** process (not a
web service) with the same env vars.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `CVS_API_KEY` | — | **Required.** CheckVisaSlots access code. |
| `CALLMEBOT_PHONE` | — | **Required.** Your number, e.g. `+14085551234`. |
| `CALLMEBOT_APIKEY` | — | **Required.** From CallMeBot activation. |
| `POLL_INTERVAL_SECONDS` | `120` | Poll frequency. |
| `MAX_AGE_MINUTES` | `20` | Ignore sightings older than this. |
| `NOTIFY_COOLDOWN_MINUTES` | `15` | Min gap before re-alerting the same location. |
| `LOCATIONS` | (all) | Filter, e.g. `NEW DELHI,CHENNAI`. |
| `EXT_VERSION` | `4.7.3` | Version header the API expects. |

## Notes & caveats

- **Crowdsourced data.** Slots come from other users' extensions, so there's a
  lag. Freshest (🔥 ≤2 min) sightings are the ones worth rushing for; older ones
  may already be gone. Tune `MAX_AGE_MINUTES` to taste.
- **Requires a valid CheckVisaSlots key.** Some data (e.g. `start_date`) is
  premium-only on their side; the bot works with whatever your key returns.
- Be reasonable with polling (default 2 min is gentle). This is an unofficial
  port for personal use; respect CheckVisaSlots' terms.
