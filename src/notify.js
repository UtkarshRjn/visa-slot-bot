// Notification layer. Supports two providers:
//   - ntfy   : free push to the ntfy app (reliable, default)
//   - whatsapp: CallMeBot free WhatsApp API (flaky, optional)
// Pick with NOTIFY_PROVIDER = ntfy | whatsapp | both

// Build the alert content once; each provider formats as needed.
export function buildAlert(available, appointmentType) {
  const bodyLines = [];
  for (const a of available) {
    let line = `${a.conf} ${a.location}: ${a.slots} date(s)`;
    if (a.startDate) line += `, earliest ${a.startDate}`;
    line += ` — seen ${a.ageStr}`;
    bodyLines.push(line);
  }
  if (appointmentType) bodyLines.push(`(${appointmentType})`);
  return {
    title: "US VISA SLOT AVAILABLE", // ntfy headers must be ASCII (no emoji)
    body: bodyLines.join("\n"),
  };
}

// --- ntfy ------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendNtfyOnce(config, { title, body }) {
  const url = `${config.ntfyServer.replace(/\/$/, "")}/${config.ntfyTopic}`;
  const headers = {
    Title: title,
    Priority: "urgent", // max priority — plays sound / time-sensitive
    Tags: "rotating_light",
    Click: "https://www.usvisascheduling.com/en-US/",
    "Content-Type": "text/plain; charset=utf-8",
  };
  if (config.ntfyToken) headers.Authorization = `Bearer ${config.ntfyToken}`;

  const res = await fetch(url, { method: "POST", headers, body });
  const text = await res.text();
  const ok = res.ok;
  if (!ok) console.error(`[notify:ntfy] failed (${res.status}): ${text.slice(0, 300)}`);
  return { ok, status: res.status, body: text };
}

// Send the same alert config.ntfyRepeat times, a few seconds apart, so it keeps
// buzzing until you look.
export async function sendNtfy(config, alert) {
  const times = config.ntfyRepeat || 1;
  let anyOk = false;
  for (let i = 0; i < times; i++) {
    if (i > 0) await sleep(4000);
    const title = times > 1 ? `${alert.title} (${i + 1}/${times})` : alert.title;
    const r = await sendNtfyOnce(config, { title, body: alert.body });
    anyOk = anyOk || r.ok;
  }
  return { ok: anyOk };
}

// --- WhatsApp (CallMeBot) --------------------------------------------------
export async function sendWhatsApp(config, { title, body }) {
  const text = `🚨 ${title} 🚨\n${body}\nBOOK NOW → https://www.usvisascheduling.com/en-US/`;
  const url =
    "https://api.callmebot.com/whatsapp.php" +
    `?phone=${encodeURIComponent(config.whatsappPhone)}` +
    `&text=${encodeURIComponent(text)}` +
    `&apikey=${encodeURIComponent(config.whatsappApiKey)}`;

  const res = await fetch(url, { method: "GET" });
  const respText = await res.text();
  const ok = res.ok && !/error/i.test(respText);
  if (!ok) console.error(`[notify:whatsapp] failed (${res.status}): ${respText.slice(0, 300)}`);
  return { ok, status: res.status, body: respText };
}

// --- PagerDuty (Events API v2) --------------------------------------------
// One "trigger" event -> PagerDuty runs the loud, persistent, escalating alarm
// until you acknowledge. dedup_key collapses an ongoing opening into a single
// incident so it doesn't spam.
export async function sendPagerDuty(config, { title, body }) {
  const res = await fetch("https://events.pagerduty.com/v2/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      routing_key: config.pdRoutingKey,
      event_action: "trigger",
      // Unique per alert so PagerDuty won't suppress later openings. The bot's
      // own cooldown/change-detection already prevents spam.
      dedup_key: `visa-slot-${Date.now()}`,
      payload: {
        summary: `${title} — ${body} | Book: https://www.usvisascheduling.com/en-US/`.slice(0, 1024),
        severity: "critical",
        source: "visa-slot-bot",
        component: "checkvisaslots",
      },
      links: [{ href: "https://www.usvisascheduling.com/en-US/", text: "Book on usvisascheduling" }],
    }),
  });
  const text = await res.text();
  const ok = res.ok;
  if (!ok) console.error(`[notify:pagerduty] failed (${res.status}): ${text.slice(0, 300)}`);
  return { ok, status: res.status, body: text };
}

// Dispatch to whichever provider(s) are configured. Succeeds if any provider
// delivers, so "both" gives you redundancy.
export async function sendAlert(config, alert) {
  const provider = config.notifyProvider;
  const results = [];
  if (provider === "ntfy" || provider === "both") {
    results.push(["ntfy", await sendNtfy(config, alert).catch((e) => ({ ok: false, body: e.message }))]);
  }
  if (provider === "pagerduty" || provider === "both") {
    results.push(["pagerduty", await sendPagerDuty(config, alert).catch((e) => ({ ok: false, body: e.message }))]);
  }
  if (provider === "whatsapp" || provider === "both") {
    results.push(["whatsapp", await sendWhatsApp(config, alert).catch((e) => ({ ok: false, body: e.message }))]);
  }
  const ok = results.some(([, r]) => r.ok);
  const sent = results.filter(([, r]) => r.ok).map(([name]) => name);
  return { ok, sent, results };
}
