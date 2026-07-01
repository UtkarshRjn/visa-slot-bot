// Cloudflare Worker port of the visa slot bot.
// Runs on a 2-minute cron: polls the CheckVisaSlots API, and pushes an urgent
// ntfy notification when a relevant US visa slot opens up. Dedupe/cooldown
// state lives in a KV namespace (binding: STATE).
//
// Config comes from env (wrangler.toml [vars] + the CVS_API_KEY secret):
//   CVS_API_KEY (secret), EXT_VERSION, NTFY_SERVER, NTFY_TOPIC,
//   MAX_AGE_MINUTES, NOTIFY_COOLDOWN_MINUTES, LOCATIONS

const BASE = "https://app.checkvisaslots.com";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const VISA_URL = "https://www.usvisascheduling.com/en-US/";
const STATE_KEY = "notified";

function cfg(env) {
  return {
    apiKey: env.CVS_API_KEY,
    extVersion: env.EXT_VERSION || "4.7.3",
    ntfyServer: (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, ""),
    ntfyTopic: env.NTFY_TOPIC,
    ntfyRepeat: Math.max(1, Number(env.NTFY_REPEAT ?? 3)),
    notifyProvider: (env.NOTIFY_PROVIDER || "ntfy").toLowerCase(), // ntfy | pagerduty | both
    pdRoutingKey: env.PD_ROUTING_KEY || "",
    maxAgeMinutes: Number(env.MAX_AGE_MINUTES ?? 20),
    cooldownMinutes: Number(env.NOTIFY_COOLDOWN_MINUTES ?? 15),
    locations: (env.LOCATIONS || "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  };
}

async function fetchSlots(c) {
  const res = await fetch(`${BASE}/slots/v3`, {
    headers: {
      "x-api-key": c.apiKey,
      extVersion: c.extVersion,
      "User-Agent": BROWSER_UA,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { message: text };
  }
  return {
    ok: res.ok,
    status: res.status,
    userDetails: json.userDetails || {},
    slotDetails: Array.isArray(json.slotDetails) ? json.slotDetails : [],
    message: json.message,
  };
}

function ageSeconds(createdon) {
  if (createdon == null) return Infinity;
  const t = typeof createdon === "number" ? createdon : Date.parse(createdon);
  if (!Number.isFinite(t)) return Infinity;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}
function relativeAge(s) {
  if (!Number.isFinite(s)) return "unknown age";
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}
function confidence(s) {
  if (s <= 120) return "🔥";
  if (s <= 300) return "⚠️";
  return "ℹ️";
}

function detectAvailable(resp, c) {
  const appointmentType = resp.userDetails?.appointment_type || "";
  const isDropbox = appointmentType.toLowerCase() === "dropbox";
  const maxAgeSecs = c.maxAgeMinutes > 0 ? c.maxAgeMinutes * 60 : Infinity;
  const available = [];
  for (const e of resp.slotDetails) {
    const location = String(e.visa_location || "").trim();
    const slots = Number(e.slots) || 0;
    if (slots <= 0) continue;
    if (!isDropbox && location.toUpperCase().includes("VAC")) continue;
    if (c.locations.length && !c.locations.some((l) => location.toUpperCase().includes(l)))
      continue;
    const ageSecs = ageSeconds(e.createdon);
    if (ageSecs > maxAgeSecs) continue;
    available.push({
      location,
      slots,
      startDate: e.start_date || null,
      ageSecs,
      ageStr: relativeAge(ageSecs),
      conf: confidence(ageSecs),
    });
  }
  available.sort((a, b) => a.ageSecs - b.ageSecs);
  return { available, appointmentType };
}

function buildBody(available, appointmentType) {
  const lines = available.map((a) => {
    let l = `${a.conf} ${a.location}: ${a.slots} date(s)`;
    if (a.startDate) l += `, earliest ${a.startDate}`;
    return l + ` — seen ${a.ageStr}`;
  });
  if (appointmentType) lines.push(`(${appointmentType})`);
  return lines.join("\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendNtfy(c, title, body) {
  const res = await fetch(`${c.ntfyServer}/${c.ntfyTopic}`, {
    method: "POST",
    headers: {
      Title: title, // ASCII only
      Priority: "urgent",
      Tags: "rotating_light",
      Click: VISA_URL,
      "Content-Type": "text/plain; charset=utf-8",
    },
    body,
  });
  return res.ok;
}

// Send the same alert multiple times (a few seconds apart) so it keeps buzzing.
async function sendNtfyRepeated(c, title, body) {
  let anyOk = false;
  for (let i = 0; i < c.ntfyRepeat; i++) {
    if (i > 0) await sleep(4000);
    const t = c.ntfyRepeat > 1 ? `${title} (${i + 1}/${c.ntfyRepeat})` : title;
    anyOk = (await sendNtfy(c, t, body)) || anyOk;
  }
  return anyOk;
}

const PD_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";

async function pdEvent(c, payload) {
  return fetch(PD_EVENTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ routing_key: c.pdRoutingKey, ...payload }),
  });
}

// PagerDuty Events API v2: one "trigger" event -> PagerDuty handles the loud,
// persistent, escalating alarm until you acknowledge.
// We auto-resolve the previous alert first so an old open incident can't cause
// PagerDuty to group/throttle the new one (keeps every real opening loud).
async function sendPagerDuty(c, title, body, env) {
  try {
    const prev = env && (await env.STATE.get("pd_last"));
    if (prev) await pdEvent(c, { event_action: "resolve", dedup_key: prev });
  } catch (e) {
    console.log("pd resolve-prev failed:", e.message);
  }

  const dedup = `visa-slot-${Date.now()}`;
  const res = await pdEvent(c, {
    event_action: "trigger",
    dedup_key: dedup,
    payload: {
      summary: `${title} — ${body}`.slice(0, 1024),
      severity: "critical",
      source: "visa-slot-bot",
      component: "checkvisaslots",
    },
    links: [{ href: VISA_URL, text: "Book on usvisascheduling" }],
  });
  if (res.ok && env) await env.STATE.put("pd_last", dedup);
  return res.ok;
}

// Dispatch to whichever provider(s) are configured.
async function dispatch(c, title, body, env) {
  const p = c.notifyProvider;
  let ok = false;
  if (p === "ntfy" || p === "both") ok = (await sendNtfyRepeated(c, title, body)) || ok;
  if (p === "pagerduty" || p === "both") ok = (await sendPagerDuty(c, title, body, env)) || ok;
  return ok;
}

async function run(env) {
  const c = cfg(env);
  const resp = await fetchSlots(c);
  if (!resp.ok) {
    console.log(`slots fetch failed HTTP ${resp.status}: ${resp.message || "?"}`);
    return { ok: false, status: resp.status };
  }

  const { available, appointmentType } = detectAvailable(resp, c);
  if (available.length === 0) {
    console.log(`no slots (checked ${resp.slotDetails.length}, type ${appointmentType || "?"})`);
    return { ok: true, available: 0 };
  }

  // Load dedupe state.
  const state = (await env.STATE.get(STATE_KEY, "json")) || {};
  const now = Date.now();
  const cooldownMs = c.cooldownMinutes * 60 * 1000;

  const notifiable = [];
  for (const a of available) {
    const sig = `${a.slots}|${a.startDate || ""}`;
    const prev = state[a.location];
    const changed = !prev || prev.sig !== sig;
    const cooled = !prev || now - prev.ts >= cooldownMs;
    if (changed || cooled) notifiable.push({ a, sig });
  }

  console.log(`AVAILABLE: ${available.map((a) => `${a.location}:${a.slots}(${a.ageStr})`).join(", ")}`);
  if (notifiable.length === 0) {
    console.log("already alerted recently — staying quiet");
    return { ok: true, available: available.length, notified: 0 };
  }

  const body = buildBody(notifiable.map((n) => n.a), appointmentType);
  const sent = await dispatch(c, "US VISA SLOT AVAILABLE", body, env);
  if (sent) {
    for (const n of notifiable) state[n.a.location] = { sig: n.sig, ts: now };
    await env.STATE.put(STATE_KEY, JSON.stringify(state));
    console.log(`notified: ${notifiable.map((n) => n.a.location).join(", ")}`);
  } else {
    console.log("ntfy send failed — will retry next cron");
  }
  return { ok: true, available: available.length, notified: sent ? notifiable.length : 0 };
}

// Cloudflare cron only fires once/minute, so to approximate faster polling we
// run several passes within one invocation, spaced POLL_INTERVAL_SECONDS apart.
async function runRepeated(env) {
  const intervalSec = Math.max(10, Number(env.POLL_INTERVAL_SECONDS ?? 30));
  const passes = Math.max(1, Math.floor(60 / intervalSec));
  for (let i = 0; i < passes; i++) {
    if (i > 0) await sleep(intervalSec * 1000);
    try {
      await run(env);
    } catch (e) {
      console.log("run error:", e.message);
    }
  }
}

export default {
  // Cron entrypoint.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRepeated(env));
  },
  // Manual entrypoint for testing:
  //   GET /run  -> run one cycle now
  //   GET /test -> send a test push
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/run") {
      const r = await run(env);
      return Response.json(r);
    }
    if (url.pathname === "/test") {
      const c = cfg(env);
      const ok = await dispatch(c, "Visa Slot Bot test", "✅ Cloudflare Worker is live and can reach your phone.", env);
      return Response.json({ ok });
    }
    return new Response("visa-slot-bot worker ok. Try /run or /test", { status: 200 });
  },
};
