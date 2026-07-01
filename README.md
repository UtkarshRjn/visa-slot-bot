# Visa Slot Bot 🛂📲

A tiny, dependency-free bot that **ports the "Check US Visa Slots" Chrome
extension into a headless service**. It polls the same CheckVisaSlots backend the
extension uses, roughly **every 30 seconds**, and sends you an **urgent mobile
push** the moment a US visa slot opens up at a location you care about.

No browser, no visa-portal login, no CAPTCHA — it reuses CheckVisaSlots'
crowdsourced slot feed, so it's light enough to run free in the cloud.

Two flavors, same logic:
- **`worker/`** — a Cloudflare Worker (recommended, free, always-on, ~30s cron).
- **`src/`** — a Node service you can run locally or on any VPS.

## How it works

The extension gets all its slot data from one authenticated API call. This bot
makes the exact same call:

| | |
|---|---|
| Slots | `GET https://app.checkvisaslots.com/slots/v3` |
| Validate key | `GET https://app.checkvisaslots.com/validate/v3` |
| Auth | headers `x-api-key: <your access code>` + `extVersion: 4.7.3` |

> Note: `slots/v3` sits behind a WAF that rejects non-browser User-Agents, so the
> bot sends a normal Chrome UA.

The response is `{ userDetails, slotDetails: [{ visa_location, slots, start_date, createdon }] }`.
A location has openings when `slots > 0`; `createdon` says how fresh that
sighting is. Detection rules match the extension:

- **Dropbox** appointment type → all locations count.
- **Consular/interview** → `VAC` (document-drop) locations are ignored.
- Confidence by freshness of the sighting: 🔥 ≤2 min · ⚠️ ≤5 min · ℹ️ older (within your window).

On a fresh, relevant `slots > 0`, it pushes you an alert and won't spam
(per-location cooldown + change detection).

## Notifications

Two providers, pick with `NOTIFY_PROVIDER` = `ntfy` | `whatsapp` | `both`:

- **ntfy (default, recommended)** — free, reliable push. Install the
  [ntfy app](https://ntfy.sh/) on your phone and subscribe to a hard-to-guess
  topic name. Alerts use `urgent` priority so they break through silent / Do Not
  Disturb, and tapping one opens the visa scheduling site.
- **WhatsApp via [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/)**
  — free but flaky. One-time activation: from your phone, message
  **+34 644 91 96 80** the text `I allow callmebot to send me messages`; it
  replies with your `apikey`.

## Get your CheckVisaSlots API key

Open the **Check US Visa Slots** extension popup → copy the **Access Code**
(API key) field. (It's the same key the extension stores as `apiKey`.)

---

## Deploy: Cloudflare Workers (recommended — free, no credit card, ~30s)

Everything lives in `worker/`. Cron fires every minute (Cloudflare's minimum);
each run does two passes 30s apart, so effective polling is ~30s.

```bash
cd worker
npx wrangler login                                  # one-time; opens browser
# one-time per account: claim a workers.dev subdomain in the dashboard
#   (Workers & Pages -> onboarding) if you haven't already

npx wrangler kv namespace create STATE              # copy the id into wrangler.toml
printf 'YOUR_CVS_KEY'   | npx wrangler secret put CVS_API_KEY
printf 'your_ntfy_topic'| npx wrangler secret put NTFY_TOPIC
npx wrangler deploy                                 # registers the 30s cron

npx wrangler tail                                   # watch it run live
```

Config (poll interval, freshness, cooldown, location filter) lives in
`worker/wrangler.toml` under `[vars]`. Secrets (`CVS_API_KEY`, `NTFY_TOPIC`) are
set via `wrangler secret put` and kept out of the repo.

---

## Run locally / on a VPS (Node)

```bash
cp .env.example .env      # fill in CVS_API_KEY + your notifier settings
npm run validate          # confirms your key + prints the current live slot feed
npm run check             # runs ONE poll cycle (alerts if something's open)
npm start                 # polls every ~30s, forever
```

Deploy the Node version anywhere as a **worker/background** process (not a web
service). Note: **Fly.io and Railway now require a credit card** even on their
free tiers — Cloudflare Workers above needs neither.

### GitHub Actions — zero-infra fallback (~5-min polling)
Add repo secrets `CVS_API_KEY` + your notifier secrets (Settings → Secrets →
Actions). The workflow in `.github/workflows/check.yml` runs `--once` on a
schedule. GitHub's minimum is 5 minutes (and can lag), so use the Worker if you
want ~30s.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `CVS_API_KEY` | — | **Required.** CheckVisaSlots access code. |
| `NOTIFY_PROVIDER` | `ntfy` | `ntfy` \| `whatsapp` \| `both`. |
| `NTFY_TOPIC` | — | Required for ntfy. Your subscribed topic name. |
| `NTFY_SERVER` | `https://ntfy.sh` | Override for a self-hosted ntfy. |
| `CALLMEBOT_PHONE` | — | Required for whatsapp. e.g. `+14085551234`. |
| `CALLMEBOT_APIKEY` | — | Required for whatsapp. From CallMeBot activation. |
| `POLL_INTERVAL_SECONDS` | `30` | Poll frequency (Node loop; Worker passes/min). |
| `MAX_AGE_MINUTES` | `20` | Ignore sightings older than this. |
| `NOTIFY_COOLDOWN_MINUTES` | `15` | Min gap before re-alerting the same location. |
| `LOCATIONS` | (all) | Filter, e.g. `NEW DELHI,CHENNAI`. |
| `EXT_VERSION` | `4.7.3` | Version header the API expects. |

## Notes & caveats

- **Crowdsourced data.** Slots come from other users' extensions, so there's a
  lag — you're alerted when CheckVisaSlots learns of a slot. Freshest (🔥 ≤2 min)
  sightings are the ones worth rushing for; older ones may already be gone. Tune
  `MAX_AGE_MINUTES` to taste.
- **Requires a valid CheckVisaSlots key.** Some data (e.g. `start_date`) is
  premium-only on their side; the bot works with whatever your key returns.
- **Keep your ntfy topic private.** Anyone who knows it can push to your phone.
- Be reasonable with polling. This is an unofficial port for personal use;
  respect CheckVisaSlots' terms.
