#!/usr/bin/env node

// Fetches VARP member data from Wild Apricot API, filters to directory-eligible
// members, geocodes addresses, and writes members.json for the frontend.
//
// Usage: WA_API_KEY=xxx node scripts/fetch-members.js
// The GitHub Action passes the API key via environment variable.

const https = require("https");
const fs = require("fs");
const path = require("path");

const WA_API_KEY = process.env.WA_API_KEY;
const ACCOUNT_ID = "351843";
const OUTPUT_FILE = path.join(__dirname, "..", "members.json");
const GEOCODE_CACHE_FILE = path.join(__dirname, "..", "geocode-cache.json");

// Membership levels to exclude from directory
const EXCLUDED_LEVELS = {
  1249379: "Staff",
  1258039: "Hall of Fame",
  1259804: "Hidden",
};

// Professional Category → directory tab type mapping
const CATEGORY_MAP = {
  Contractor: "Contractor",
  "Supplier/Distributor": "Distributor & Manufacturer",
  Manufacturer: "Distributor & Manufacturer",
  "Design Professional": "Consultant & Design Professional",
  Consultant: "Consultant & Design Professional",
  "Associate (non-roofing industry professional)": "Associate Professional",
};

// Categories to exclude from directory
const EXCLUDED_CATEGORIES = ["Staff", "Emeritus"];

// ─── HTTP helpers ───────────────────────────────────────

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── WA API Auth ────────────────────────────────────────

async function getAccessToken() {
  const auth = Buffer.from(`APIKEY:${WA_API_KEY}`).toString("base64");
  const url = new URL("https://oauth.wildapricot.org/auth/token");
  const body = "grant_type=client_credentials&scope=auto";

  const data = await httpRequest(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  return data.access_token;
}

// ─── Fetch all active members (with pagination) ─────────

async function pollResult(token, resultUrl) {
  let attempts = 0;
  while (attempts < 20) {
    await sleep(3000);
    attempts++;
    try {
      const result = await httpRequest(resultUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (result.Contacts) return result.Contacts;
    } catch (e) {
      if (attempts >= 20) throw e;
    }
  }
  throw new Error("Timed out waiting for contacts result");
}

async function fetchContacts(token) {
  const filter = encodeURIComponent(
    "(Status eq Active OR Status eq PendingRenewal) AND IsMember eq true"
  );
  const base = `https://api.wildapricot.org/v2.2/accounts/${ACCOUNT_ID}/contacts`;
  const PAGE_SIZE = 100;
  const allContacts = [];
  let skip = 0;

  while (true) {
    console.log(`  Requesting page (skip=${skip})...`);
    // Each page gets its own async request
    const url = `${base}?$filter=${filter}&$top=${PAGE_SIZE}&$skip=${skip}&$async=false`;
    let page;
    try {
      const result = await httpRequest(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });

      if (result.Contacts) {
        // Synchronous response
        page = result.Contacts;
      } else if (result.ResultId) {
        // Async — poll for results
        const resultUrl = `${base}?resultId=${result.ResultId}`;
        page = await pollResult(token, resultUrl);
      } else {
        throw new Error("Unexpected API response format");
      }
    } catch (e) {
      throw new Error(`Failed fetching contacts at skip=${skip}: ${e.message}`);
    }

    console.log(`  Got ${page.length} contacts`);
    allContacts.push(...page);

    if (page.length < PAGE_SIZE) break;
    skip += page.length;
  }

  console.log(`Fetched ${allContacts.length} total contacts across all pages`);
  return allContacts;
}

// ─── Geocoding with Nominatim ───────────────────────────

function loadGeocodeCache() {
  try {
    return JSON.parse(fs.readFileSync(GEOCODE_CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveGeocodeCache(cache) {
  fs.writeFileSync(GEOCODE_CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function geocodeAddress(address, cache) {
  if (cache[address]) return cache[address];

  // Nominatim rate limit: 1 request per second
  await sleep(1100);

  const q = encodeURIComponent(address);
  const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=us`;

  try {
    const results = await httpRequest(url, {
      headers: { "User-Agent": "VARP-Directory/1.0" },
    });

    if (results.length > 0) {
      const { lat, lon } = results[0];
      const coords = { lat: parseFloat(lat), lng: parseFloat(lon) };
      cache[address] = coords;
      return coords;
    }
  } catch (e) {
    console.warn(`Geocode failed for "${address}": ${e.message}`);
  }

  return null;
}

// ─── Transform WA contact → directory member ────────────

function getFieldValue(contact, fieldName) {
  const fv = contact.FieldValues.find((f) => f.FieldName === fieldName);
  return fv ? fv.Value : null;
}

function transformContact(contact, id, coords) {
  const catValues = getFieldValue(contact, "Professional Category") || [];
  const catLabels = catValues.map((c) => c.Label);

  // Find the first mapped category (skip Staff/Emeritus)
  let directoryType = null;
  for (const label of catLabels) {
    if (EXCLUDED_CATEGORIES.includes(label)) continue;
    if (CATEGORY_MAP[label]) {
      directoryType = CATEGORY_MAP[label];
      break;
    }
  }

  // Default to "Contractor" if no mapped category found
  if (!directoryType) directoryType = "Contractor";

  const serviceAreas = getFieldValue(contact, "Service Area") || [];
  const serviceArea = serviceAreas.map((s) => s.Label);

  const website = getFieldValue(contact, "Website") || "";

  return {
    id,
    type: directoryType,
    name: contact.Organization || `${contact.FirstName} ${contact.LastName}`,
    logo: "", // Avatar URL would go here if available via API
    phone: getFieldValue(contact, "Phone") || "",
    website,
    serviceArea,
    city: getFieldValue(contact, "City") || "",
    description: getFieldValue(contact, "Company Description") || "",
    lat: coords ? coords.lat : null,
    lng: coords ? coords.lng : null,
  };
}

// ─── Main ───────────────────────────────────────────────

async function main() {
  if (!WA_API_KEY) {
    console.error("WA_API_KEY environment variable is required");
    process.exit(1);
  }

  console.log("Authenticating with Wild Apricot API...");
  const token = await getAccessToken();
  console.log("Authenticated.");

  // Check total counts
  const countBase = `https://api.wildapricot.org/v2.2/accounts/${ACCOUNT_ID}/contacts`;
  for (const label of ["WITH IsMember", "WITHOUT IsMember"]) {
    const f = label === "WITH IsMember"
      ? "(Status eq Active OR Status eq PendingRenewal) AND IsMember eq true"
      : "Status eq Active OR Status eq PendingRenewal";
    try {
      const cr = await httpRequest(`${countBase}?$filter=${encodeURIComponent(f)}&$count=true&$top=1`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      console.log(`Count ${label}: ${cr.Count}`);
    } catch(e) { console.log(`Count ${label} error: ${e.message}`); }
  }

  console.log("\nFetching active + pending-renewal members...");
  const contacts = await fetchContacts(token);

  // Filter to directory-eligible members
  let droppedLevel = 0, droppedCategory = 0, droppedRole = 0;
  const unmappedCategories = {};

  const eligible = contacts.filter((c) => {
    const fvs = {};
    c.FieldValues.forEach((fv) => (fvs[fv.FieldName] = fv.Value));

    const levelId = fvs["Membership level ID"];
    const memberRole = fvs["Member role"];
    const categories = fvs["Professional Category"] || [];
    const catLabels = categories.map((cat) => cat.Label);

    // Exclude Staff and Hidden membership levels
    if (EXCLUDED_LEVELS[levelId]) {
      droppedLevel++;
      const role = memberRole || "(no role)";
      console.log(`  DROPPED by level: ${c.Organization || c.DisplayName} — level=${EXCLUDED_LEVELS[levelId]}, role=${role}`);
      return false;
    }

    // Exclude contacts whose ONLY professional categories are Staff/Emeritus
    if (catLabels.length > 0 && catLabels.every((l) => EXCLUDED_CATEGORIES.includes(l))) {
      droppedCategory++;
      const role = memberRole || "(no role)";
      console.log(`  DROPPED by category: ${c.Organization || c.DisplayName} — cats=${catLabels.join(",")}, role=${role}`);
      return false;
    }

    // Track unmapped categories for diagnostics
    catLabels.forEach((l) => {
      if (!CATEGORY_MAP[l] && !EXCLUDED_CATEGORIES.includes(l)) {
        unmappedCategories[l] = (unmappedCategories[l] || 0) + 1;
      }
    });

    // Exclude "Bundle member" contacts — keep only Bundle Administrators
    // (one per company) and standalone members (null role)
    if (memberRole && memberRole === "Bundle member") return false;

    return true;
  });

  console.log(`\n--- Filter diagnostics ---`);
  console.log(`Total contacts from API: ${contacts.length}`);
  console.log(`Dropped by membership level (Staff/HoF/Hidden): ${droppedLevel}`);
  console.log(`Dropped by category (Staff/Emeritus only): ${droppedCategory}`);
  console.log(`Eligible after all filters: ${eligible.length}`);
  if (Object.keys(unmappedCategories).length > 0) {
    console.log(`Unmapped professional categories:`, unmappedCategories);
  }
  const noCat = eligible.filter(c => {
    const cats = (c.FieldValues.find(f => f.FieldName === "Professional Category") || {}).Value || [];
    return cats.length === 0;
  });
  console.log(`Eligible members with NO professional category: ${noCat.length}`);
  console.log(`--- end diagnostics ---\n`);

  // Geocode addresses
  const cache = loadGeocodeCache();
  const members = [];
  let id = 1;

  for (const contact of eligible) {
    const city = getFieldValue(contact, "City") || "";
    const state = getFieldValue(contact, "State");
    const stateLabel = state ? state.Label : "VA";
    const addr1 = getFieldValue(contact, "Address 1") || "";
    const zip = getFieldValue(contact, "Zip") || "";

    // Build geocode query from best available address data
    let geocodeQuery = "";
    if (addr1 && city && stateLabel) {
      geocodeQuery = `${addr1}, ${city}, ${stateLabel} ${zip}`.trim();
    } else if (city && stateLabel) {
      geocodeQuery = `${city}, ${stateLabel}`;
    } else if (city) {
      geocodeQuery = `${city}, Virginia`;
    }

    let coords = null;
    if (geocodeQuery) {
      coords = await geocodeAddress(geocodeQuery, cache);
      if (coords)
        console.log(
          `  Geocoded: ${contact.Organization || contact.DisplayName} → ${coords.lat}, ${coords.lng}`
        );
      else
        console.warn(
          `  No geocode result for: ${contact.Organization || contact.DisplayName} (${geocodeQuery})`
        );
    } else {
      console.warn(
        `  No address data for: ${contact.Organization || contact.DisplayName}`
      );
    }

    const member = transformContact(contact, id, coords);
    if (member) {
      members.push(member);
      id++;
    }
  }

  saveGeocodeCache(cache);

  // Sort by name within each category
  members.sort((a, b) => a.name.localeCompare(b.name));

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(members, null, 2));
  console.log(`\nWrote ${members.length} members to ${OUTPUT_FILE}`);

  // Print summary by category
  const byCat = {};
  members.forEach((m) => {
    byCat[m.type] = (byCat[m.type] || 0) + 1;
  });
  console.log("By category:", byCat);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
