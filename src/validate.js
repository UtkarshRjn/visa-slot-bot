// Quick standalone check: is my CheckVisaSlots API key valid, and what does a
// live /slots/v3 response look like? Run: npm run validate
import { config } from "./config.js";
import { validateKey, fetchSlots } from "./checkvisaslots.js";
import { detectAvailable } from "./detector.js";

const v = await validateKey(config);
console.log("validate/v3 ->", v);

const slots = await fetchSlots(config);
console.log(`\nslots/v3 -> HTTP ${slots.status}, ${slots.slotDetails.length} locations`);
console.log("userDetails:", slots.userDetails);
for (const s of slots.slotDetails) {
  console.log(`  ${s.visa_location}: slots=${s.slots} start=${s.start_date || "-"} seen=${s.createdon}`);
}

const { available } = detectAvailable(slots, config);
console.log(`\nWould alert on ${available.length} location(s):`);
for (const a of available) console.log(`  ${a.conf} ${a.location} (${a.slots}, ${a.ageStr})`);
