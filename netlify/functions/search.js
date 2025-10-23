// Netlify Function: /api/search (v5 - broader domain coverage + Admission parsing + "$" detection)

const OFFICIAL_HOST_CHECKS = [
  // Federal
  h => h.endsWith(".gov"),
  h => h === "nps.gov" || h.endsWith(".nps.gov"),
  h => h === "usda.gov" || h.endsWith(".usda.gov") || h.endsWith(".fs.usda.gov"),
  h => h === "blm.gov" || h.endsWith(".blm.gov"),

  // State / local variations (.com, .org, .us)
  h => h.endsWith("stateparks.com"),
  h => h.endsWith("stateparks.org"),
  h => h.endsWith("stateparks.us"),
  h => h.includes("parks.") && (h.endsWith(".com") || h.endsWith(".org") || h.endsWith(".us")),
  h => h.includes("county") && (h.endsWith(".gov") || h.endsWith(".us") || h.endsWith(".org") || h.endsWith(".com")),
  h => h.includes("southcarolinaparks.com"), // specific known pattern
];

const FEE_TERMS = [
  "entrance fee", "admission", "admission fee", "admission rates", "parking fee",
  "day-use", "day use", "permit", "pass", "vehicle fee", "per vehicle", "per person",
  "entrance pass", "amenity fee", "$"
];

const NO_FEE_TERMS = [
  "no fee", "free entry", "free admission", "no entrance fee", "free to enter",
  "no day-use fee", "no fees", "no charge"
];

// Utility functions
function isOfficial(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return OFFICIAL_HOST_CHECKS.some(fn => fn(host));
  } catch { return false; }
}

function tokenSim(a, b) {
  const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim();
  const A = new Set(norm(a).split(" ").filter(Boolean));
  const B = new Set(norm(b).split(" ").filter(Boolean));
  const inter = [...A].filter(x => B.has(x)).length;
  return (2 * inter) / Math.max(1, A.size + B.size);
}

async function fetchText(url) {
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) return "";
    return await r.text();
  } catch { return ""; }
}

function extractAmount(text) {
  // Capture common "$" patterns
  const m = text.match(/\$\s?(\d{1,3})(\.\d{2})?\s*(per\s*(vehicle|car|person|adult|child))?/i);
  if (!m) return null;
  const dollars = `$${m[1]}${m[2] ?? ""}`;
  const suffix = m[3] ? ` ${m[3]}` : "";
  return `${dollars}${suffix}`.trim();
}

function buildScope(stateCode) {
  const base = [
    "site:.gov",
    "site:.us",
    "site:.org",
    "site:.com",
    "site:nps.gov",
    "site:fs.usda.gov",
    "site:blm.gov",
    "site:stateparks.com",
    "site:stateparks.org",
    "site:stateparks.us"
  ];
  if (stateCode) {
    const st = stateCode.toLowerCase();
    base.push(`site:${st}.gov`, `site:${st}.us`, `site:stateparks.${st}.gov`, `site:parks.${st}.gov`);
  }
  return "(" + base.join(" OR ") + ")";
}

// Main handler
export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "POST only" })
    };
  }

  const key = process.env.BRAVE_API_KEY;
  if (!key) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing BRAVE_API_KEY" })
    };
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const { query, state=null, nameForMatch=null } = body;
  if (!query) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing query" })
    };
  }

  const scope = buildScope(state);
  const q = `${query} ${scope} (admission OR "entrance fee" OR "$" OR "day-use" OR "parking fee")`;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=10&country=US&search_lang=en`;

  try {
    const sr = await fetch(url, {
      headers: {
        "X-Subscription-Token": key,
        "Accept": "application/json"
      }
    });
    const data = await sr.json();
    const results = (data.web?.results || []).filter(r => r.url);

    const official = results.filter(r => isOfficial(r.url));
    const pool = official.length ? official : results;

    let checked = 0;
    for (const r of pool) {
      if (checked >= 4) break;
      checked++;

      const html = await fetchText(r.url);
      const text = (r.title + " " + r.snippet + " " + html).toLowerCase();

      // Detect "no fee"
      if (NO_FEE_TERMS.some(k => text.includes(k))) {
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: r.url,
            feeInfo: "No fee",
            kind: "no-fee"
          })
        };
      }

      // Detect "admission" or "$"
      if (FEE_TERMS.some(k => text.includes(k))) {
        const amt = extractAmount(text);
        const feeInfo = amt ? amt : "Fee charged";
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: r.url,
            feeInfo,
            kind: "fee"
          })
        };
      }
    }

    // Fallback
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: null,
        feeInfo: "Not verified",
        kind: "not-verified"
      })
    };

  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: e.message || "Error" })
    };
  }
}
