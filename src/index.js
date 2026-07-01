// Visa Slot Bot — polls the CheckVisaSlots API every couple of minutes and
// fires an urgent WhatsApp alert (via CallMeBot) when a relevant US visa slot
// opens up.
//
//   node src/index.js          -> run forever, polling on an interval
//   node src/index.js --once   -> run a single check and exit (for cron/CI)

import fs from "node:fs";
import { config } from "./config.js";
import { validateKey, fetchSlots } from "./checkvisaslots.js";
import { detectAvailable } from "./detector.js";
import { sendAlert, buildAlert } from "./notify.js";

const ONCE = process.argv.includes("--once");

function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}
function log(...args) {
  console.log(`[${ts()}]`, ...args);
}

// --- notified-state persistence (dedupe / cooldown) -----------------------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(config.stateFile, "utf8"));
  } catch {
    return {};
  }
}
function saveState(state) {
  try {
    fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    log("[warn] could not persist state:", e.message);
  }
}

// Decide which available locations we should actually alert about right now,
// respecting the per-location cooldown and change detection.
function pickNotifiable(available, state) {
  const now = Date.now();
  const cooldownMs = config.cooldownMinutes * 60 * 1000;
  const toNotify = [];
  for (const a of available) {
    const sig = `${a.slots}|${a.startDate || ""}`;
    const prev = state[a.location];
    const changed = !prev || prev.sig !== sig;
    const cooledDown = !prev || now - prev.ts >= cooldownMs;
    if (changed || cooledDown) toNotify.push({ a, sig });
  }
  return toNotify;
}

async function runOnce(state) {
  const resp = await fetchSlots(config);
  if (!resp.ok) {
    log(`[error] slots fetch failed (HTTP ${resp.status}): ${resp.message || "unknown"}`);
    return;
  }

  const { available, appointmentType } = detectAvailable(resp, config);

  if (available.length === 0) {
    const total = resp.slotDetails.length;
    log(`no slots (checked ${total} location${total === 1 ? "" : "s"}, type: ${appointmentType || "?"})`);
    return;
  }

  // Something is available — decide what's worth pinging about.
  const summary = available
    .map((a) => `${a.location}:${a.slots}(${a.ageStr})`)
    .join(", ");
  log(`AVAILABLE -> ${summary}`);

  const notifiable = pickNotifiable(available, state);
  if (notifiable.length === 0) {
    log("(already alerted recently — staying quiet)");
    return;
  }

  const alert = buildAlert(
    notifiable.map((n) => n.a),
    appointmentType
  );
  const result = await sendAlert(config, alert);
  if (result.ok) {
    log(`📲 alert sent via ${result.sent.join("+")} for: ${notifiable.map((n) => n.a.location).join(", ")}`);
    const now = Date.now();
    for (const n of notifiable) state[n.a.location] = { sig: n.sig, ts: now };
    saveState(state);
  } else {
    log("[error] alert NOT sent — will retry next cycle");
  }
}

async function main() {
  log(`Visa Slot Bot starting. Poll every ${config.pollIntervalSeconds}s. Notify via: ${config.notifyProvider}.`);
  if (config.locations.length)
    log(`Location filter: ${config.locations.join(", ")}`);
  else log("Location filter: none (all relevant locations)");

  // Validate the API key up front so misconfig fails loudly.
  try {
    const v = await validateKey(config);
    if (v.ok) {
      log(`API key OK — visa: ${v.visa_type || "?"}, type: ${v.appointment_type || "?"}`);
    } else {
      log(`[warn] key validation returned HTTP ${v.status}: ${v.message || "invalid?"}`);
      log("       Continuing anyway; check CVS_API_KEY if slot fetches keep failing.");
    }
  } catch (e) {
    log("[warn] could not validate key (network?):", e.message);
  }

  const state = loadState();

  if (ONCE) {
    await runOnce(state).catch((e) => log("[error]", e.message));
    return;
  }

  // Long-running loop with a little jitter so we don't look robotic.
  // Uses setTimeout (not setInterval) so a slow/failed cycle never overlaps.
  const baseMs = config.pollIntervalSeconds * 1000;
  const tick = async () => {
    try {
      await runOnce(state);
    } catch (e) {
      log("[error]", e.message);
    }
    const jitter = Math.floor((Math.random() - 0.5) * 20_000); // ±10s
    setTimeout(tick, Math.max(30_000, baseMs + jitter));
  };
  tick();
}

main();
