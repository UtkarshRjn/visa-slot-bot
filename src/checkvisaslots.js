// Thin client for the CheckVisaSlots backend API — the exact same endpoints
// the "Check US Visa Slots" browser extension calls.
//
//   GET https://app.checkvisaslots.com/validate/v3   -> validates the access code
//   GET https://app.checkvisaslots.com/slots/v3      -> latest crowdsourced slots
//
// Auth is a single header, `x-api-key`, plus an `extVersion` header the backend
// expects. The slot data is crowdsourced: each entry carries a `createdon`
// timestamp telling you how fresh that sighting is.

const BASE = "https://app.checkvisaslots.com";

function headers(config) {
  return {
    "x-api-key": config.cvsApiKey,
    extVersion: config.extVersion,
    // The slots/v3 endpoint sits behind a WAF that 401s non-browser
    // User-Agents, so we must present a real browser UA.
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    Accept: "application/json",
  };
}

async function getJson(url, config) {
  const res = await fetch(url, { headers: headers(config) });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { message: text };
  }
  return { status: res.status, ok: res.ok, json };
}

// Confirm the API key is valid. Returns { ok, visa_type, appointment_type, message }.
export async function validateKey(config) {
  const { status, json } = await getJson(`${BASE}/validate/v3`, config);
  return {
    ok: status === 200,
    status,
    visa_type: json.visa_type,
    appointment_type: json.appointment_type,
    sn_uid_valid: json.sn_uid_valid,
    message: json.message,
  };
}

// Fetch the latest slots. Returns { ok, userDetails, slotDetails, tipMessage, message }.
export async function fetchSlots(config) {
  const { status, ok, json } = await getJson(`${BASE}/slots/v3`, config);
  return {
    ok: status === 200 && ok,
    status,
    userDetails: json.userDetails || {},
    slotDetails: Array.isArray(json.slotDetails) ? json.slotDetails : [],
    tipMessage: json.tipMessage,
    message: json.message,
  };
}
