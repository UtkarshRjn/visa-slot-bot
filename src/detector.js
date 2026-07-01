// Turns a raw /slots/v3 response into a list of "available" locations worth
// alerting on. Mirrors the extension's own rules:
//   - Dropbox appointments: every location counts.
//   - Consular/interview appointments: ignore "VAC" locations (those are the
//     document-drop centres, not the interview consulate).
// On top of that we apply the user's optional location filter and a freshness
// window, and we grade confidence by how recently the slot was seen.

function ageSeconds(createdon) {
  if (createdon === undefined || createdon === null) return Infinity;
  const t =
    typeof createdon === "number" ? createdon : Date.parse(createdon);
  if (!Number.isFinite(t)) return Infinity;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

export function relativeAge(seconds) {
  if (!Number.isFinite(seconds)) return "unknown age";
  if (seconds < 90) return `${seconds}s ago`;
  const mins = Math.round(seconds / 60);
  if (mins < 90) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
}

// 🔥 = very fresh, ⚠️ = recent, ℹ️ = older but within window.
function confidence(seconds) {
  if (seconds <= 120) return "🔥";
  if (seconds <= 300) return "⚠️";
  return "ℹ️";
}

// Returns { available: [ {location, slots, startDate, ageSecs, ageStr, conf} ],
//           appointmentType }
export function detectAvailable(slotsResponse, config) {
  const appointmentType = slotsResponse.userDetails?.appointment_type || "";
  const isDropbox = appointmentType.toLowerCase() === "dropbox";
  const maxAgeSecs =
    config.maxAgeMinutes > 0 ? config.maxAgeMinutes * 60 : Infinity;

  const available = [];
  for (const entry of slotsResponse.slotDetails) {
    const location = String(entry.visa_location || "").trim();
    const slots = Number(entry.slots) || 0;
    if (slots <= 0) continue;

    // Relevance rule from the extension.
    if (!isDropbox && location.toUpperCase().includes("VAC")) continue;

    // Optional user location filter.
    if (config.locations.length > 0) {
      const up = location.toUpperCase();
      const match = config.locations.some((l) => up.includes(l));
      if (!match) continue;
    }

    // Freshness window.
    const ageSecs = ageSeconds(entry.createdon);
    if (ageSecs > maxAgeSecs) continue;

    available.push({
      location,
      slots,
      startDate: entry.start_date || null,
      ageSecs,
      ageStr: relativeAge(ageSecs),
      conf: confidence(ageSecs),
    });
  }

  // Freshest first.
  available.sort((a, b) => a.ageSecs - b.ageSecs);
  return { available, appointmentType };
}
