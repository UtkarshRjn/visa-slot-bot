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
export async function sendNtfy(config, { title, body }) {
  const url = `${config.ntfyServer.replace(/\/$/, "")}/${config.ntfyTopic}`;
  const headers = {
    Title: title,
    Priority: "urgent", // breaks through silent / Do Not Disturb
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

// Dispatch to whichever provider(s) are configured. Succeeds if any provider
// delivers, so "both" gives you redundancy.
export async function sendAlert(config, alert) {
  const provider = config.notifyProvider;
  const results = [];
  if (provider === "ntfy" || provider === "both") {
    results.push(["ntfy", await sendNtfy(config, alert).catch((e) => ({ ok: false, body: e.message }))]);
  }
  if (provider === "whatsapp" || provider === "both") {
    results.push(["whatsapp", await sendWhatsApp(config, alert).catch((e) => ({ ok: false, body: e.message }))]);
  }
  const ok = results.some(([, r]) => r.ok);
  const sent = results.filter(([, r]) => r.ok).map(([name]) => name);
  return { ok, sent, results };
}
