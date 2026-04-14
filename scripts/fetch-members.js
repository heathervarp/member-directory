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

// ─── Fetch all active members ───────────────────────────

async function fetchContacts(token) {
  const filter = encodeURIComponent(
    "(Status eq Active OR Status eq PendingRenewal) AND IsMember eq true"
  );
  const url = `https://api.wildapricot.org/v2.2/accounts/${ACCOUNT_ID}/contacts?$filter=${filter}&$top=500`;

  // Initial request returns async result
  const initial = await httpRequest(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const resultId = initial.ResultId;
  if (!resultId) throw new Error("No ResultId returned from contacts API");

  // Poll for results
  const resultUrl = `https://api.wildapricot.org/v2.2/accounts/${ACCOUNT_ID}/Contacts/?resultId=${resultId}&$top=500`;
  let attempts = 0;
  while (attempts < 20) {
    await sleep(3000);
    attempts++;
    try {
      const result = await httpRequest(resultUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

      if (result.Contacts) {
        console.log(`Fetched ${result.Contacts.length} active members`);
        return result.Contacts;
      }
    } catch (e) {
      if (attempts >= 20) throw e;
    }
  }

  throw new Error("Timed out waiting for contacts result");
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

  if (!directoryType) return null;

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

  console.log("Fetching active + pending-renewal members...");
  const contacts = await fetchContacts(token);

  // Filter to directory-eligible members
  const eligible = contacts.filter((c) => {
    const fvs = {};
    c.FieldValues.forEach((fv) => (fvs[fv.FieldName] = fv.Value));

    const levelId = fvs["Membership level ID"];
    const memberRole = fvs["Member role"];
    const categories = fvs["Professional Category"] || [];
    const catLabels = categories.map((cat) => cat.Label);

    // Exclude Staff and Hidden membership levels
    if (EXCLUDED_LEVELS[levelId]) return false;

    // Exclude Staff/Emeritus professional categories
    if (
      catLabels.every(
        (l) => EXCLUDED_CATEGORIES.includes(l) || !CATEGORY_MAP[l]
      )
    )
      return false;

    // Only include Bundle Coordinators (one per company/bundle)
    if (!memberRole || memberRole.toLowerCase() !== "bundle coordinator")
      return false;

    return true;
  });

  console.log(
    `${eligible.length} directory-eligible members (of ${contacts.length} total)`
  );

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
