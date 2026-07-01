// Loads and validates configuration from environment variables.
// A tiny .env loader is included so we have zero runtime dependencies.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// --- minimal .env loader (no dotenv dependency) ---------------------------
function loadDotEnv() {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // strip surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadDotEnv();

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`[config] Missing required env var: ${name}`);
    console.error(`         Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v.trim();
}

function num(name, def) {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function list(name) {
  const v = process.env[name];
  if (!v || !v.trim()) return [];
  return v
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

// Which notifier to use: ntfy | whatsapp | both. Default to whatever is
// configured, preferring ntfy.
function pickProvider() {
  const explicit = process.env.NOTIFY_PROVIDER?.trim().toLowerCase();
  if (explicit) return explicit;
  if (process.env.NTFY_TOPIC?.trim()) return "ntfy";
  if (process.env.CALLMEBOT_APIKEY?.trim()) return "whatsapp";
  return "ntfy";
}

const notifyProvider = pickProvider();

export const config = {
  // CheckVisaSlots
  cvsApiKey: required("CVS_API_KEY"),
  extVersion: process.env.EXT_VERSION?.trim() || "4.7.3",

  // Notification provider
  notifyProvider,

  // ntfy (push)
  ntfyServer: process.env.NTFY_SERVER?.trim() || "https://ntfy.sh",
  ntfyTopic:
    notifyProvider === "ntfy" || notifyProvider === "both"
      ? required("NTFY_TOPIC")
      : process.env.NTFY_TOPIC?.trim() || "",
  ntfyToken: process.env.NTFY_TOKEN?.trim() || "", // only for private servers
  ntfyRepeat: Math.max(1, num("NTFY_REPEAT", 3)), // send each alert N times

  // PagerDuty (Events API v2)
  pdRoutingKey:
    notifyProvider === "pagerduty" || notifyProvider === "both"
      ? required("PD_ROUTING_KEY")
      : process.env.PD_ROUTING_KEY?.trim() || "",

  // CallMeBot WhatsApp (optional)
  whatsappPhone:
    notifyProvider === "whatsapp" || notifyProvider === "both"
      ? required("CALLMEBOT_PHONE")
      : process.env.CALLMEBOT_PHONE?.trim() || "",
  whatsappApiKey:
    notifyProvider === "whatsapp" || notifyProvider === "both"
      ? required("CALLMEBOT_APIKEY")
      : process.env.CALLMEBOT_APIKEY?.trim() || "",

  // Polling behaviour
  pollIntervalSeconds: num("POLL_INTERVAL_SECONDS", 30),
  // Only treat a sighting as "available" if it was seen within this many minutes.
  maxAgeMinutes: num("MAX_AGE_MINUTES", 20),
  // Don't re-alert for the same location more often than this (unless it changes).
  cooldownMinutes: num("NOTIFY_COOLDOWN_MINUTES", 15),
  // Optional: only care about these locations (substring match, case-insensitive).
  // Empty = all relevant locations.
  locations: list("LOCATIONS"),

  // Where to persist "already notified" state across restarts.
  stateFile: process.env.STATE_FILE?.trim() || path.join(rootDir, ".state.json"),
};
