// Netlify Function: /api/search  (v2 - more robust)
// - Uses Brave Search API and restricts to official domains
// - Checks up to 4 official results for fee phrases
// - Tries harder (more results, better scope) and always returns JSON

const OFFICIAL_HOST_CHECKS = [
  h => h.endsWith(".gov"),
  h => h === "nps.gov" || h.endsWith(".nps.gov"),
  h => h === "usda.gov" || h.endsWith(".usda.gov") || h.endsWith(".fs.usda.gov"),
  h => h === "blm.gov" || h.endsWith(".blm.gov"),
];

const FEE_TERMS = [
  "entrance fee","admission","parking fee","day-use","day use",
  "permit","pass","vehicle fee","per vehicle","per person","fee required","entrance pass"
];

const NO_FEE_TERMS = [
  "no fee","free entry","free admission","no entrance fee","free to enter","no day-use fee","no fees"
];

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
    const text = await r.text();
    return text.slice(0, 500000);
  } catch { return ""; }
}

function extractAmount(text) {
  // $10, $10.00, $10 per vehicle/person/car
  const m = text.match(/\$\s?(\d{1,3})(\.\d{2})?\s*(per (vehicle|car|person|motorcycle|bike))?/i);
  if (!m) return null;
  const dollars = `$${m[1]}${m[2] ?? ""}`;
  const suffix = m[3] ? ` ${m[3]}` : "";
  return `${dollars}${suffix}`.trim();
}

function classifyKind(text) {
  const t = text.toLowerCase();
  if (t.includes("parking fee") || t.includes("parking pass")) return "parking";
  if (t.includes("per vehicle") || t.includes("vehicle")) return "vehicle";
  return "general";
}

function buildScope(stateCode) {
  const base = [
    "site:.gov",
    "site:nps.gov",
    "site:usda.gov",
    "site:fs.usda.gov",
    "site:blm.gov",
  ];
  if (stateCode) {
    const st = stateCode.toLowerCase();
    base.push(`site:${st}.gov`, `site:stateparks.${st}.gov`);
  }
  return "(" + base.join(" OR ") + ")";
}

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

  // Build Brave query
  const scope = buildScope(state);
  const q = `${query} ${scope} (fee OR parking OR "day-use" OR admission)`;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=10&country=US&search_lang=en`;

  try {
    const sr = await fetch(url, {
      headers: {
        "X-Subscription-Token": key,
        "Accept": "application/json"
      }
    });
    if (!sr.ok) {
      return {
        statusCode: sr.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Brave error", detail: await sr.text() })
      };
    }
    const data = await sr.json();
    const results = (data.web?.results || []).filter(r => r.url);

    // Consider only official results, but keep a fallback
    const official = results.filter(r => isOfficial(r.url));
    const pool = official.length ? official : results;

    let fallback = null;
    let checks = 0;

    for (const r of pool) {
      if (checks >= 4) break;
      if (nameForMatch) {
        const score = Math.max(
          tokenSim(nameForMatch, r.title || ""),
          tokenSim(nameForMatch, r.snippet || "")
        );
        if (score < 0.45) continue; // slightly looser
      }

      checks++;
      const html = await fetchText(r.url);
      const haystack = `${r.title || ""}\n${r.snippet || ""}\n${html}`.toLowerCase();

      if (NO_FEE_TERMS.some(k => haystack.includes(k))) {
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: r.url,
            domain: new URL(r.url).hostname,
            title: r.title || "",
            feeInfo: "No fee",
            kind: "no-fee"
          })
        };
      }

      if (FEE_TERMS.some(k => haystack.includes(k))) {
        const amount = extractAmount(haystack);
        const kind = classifyKind(haystack);
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: r.url,
            domain: new URL(r.url).hostname,
            title: r.title || "",
            feeInfo: amount ? amount : "Fee charged",
            kind
          })
        };
      }

      fallback = fallback || r;
    }

    if (fallback) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: fallback.url,
          domain: new URL(fallback.url).hostname,
          title: fallback.title || "",
          feeInfo: "Not verified",
          kind: "not-verified"
        })
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: null, domain: null, title: "",
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
