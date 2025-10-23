// Netlify Function: /api/search
// Purpose:
// - Use Brave Search API to find OFFICIAL sources only
// - Check up to 4 relevant results
// - If page mentions "no fee" => return No fee
// - If page mentions fee terms => return Fee (try to pull an amount)
// - Otherwise => Not verified
//
// Returns JSON: { url, domain, title, feeInfo, kind }
//   feeInfo: "No fee" | "Fee charged" | "$10 per vehicle" | "Not verified"
//   kind: "no-fee" | "parking" | "vehicle" | "general" | "not-verified"

const OFFICIAL_DOMAINS = [".gov", ".nps.gov", ".usda.gov", ".blm.gov"];

const FEE_TERMS = [
  "entrance fee","admission","parking fee","day-use","day use",
  "permit","pass","vehicle fee","per vehicle","per person"
];

const NO_FEE_TERMS = [
  "no fee","free entry","free admission","no entrance fee","free to enter","no day-use fee"
];

// tiny helpers (no extra libs)
function containsAny(text, terms) {
  const t = text.toLowerCase();
  return terms.some(k => t.includes(k));
}

function isOfficial(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith(".gov")) return true; // state/county/city .gov
    return OFFICIAL_DOMAINS.some(s => host.endsWith(s));
  } catch {
    return false;
  }
}

// rough token similarity (good enough gate)
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
    return text.slice(0, 400000); // cap for safety
  } catch { return ""; }
}

function extractAmount(text) {
  const m = text.match(/\$\s?(\d{1,3})(\.\d{2})?\s*(per (vehicle|car|person))?/i);
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
  const base = "(site:.gov OR site:.nps.gov OR site:.usda.gov OR site:.blm.gov)";
  if (!stateCode) return base;
  const st = stateCode.toLowerCase();
  const statePart = `(site:${st}.gov OR site:stateparks.${st}.gov)`;
  return `${base} OR ${statePart}`;
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "POST only" };
  }
  const key = process.env.BRAVE_API_KEY;
  if (!key) return { statusCode: 500, body: "Missing BRAVE_API_KEY" };

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const { query, state=null, nameForMatch=null } = body;
  if (!query) return { statusCode: 400, body: "Missing query" };

  // build search
  const scope = buildScope(state);
  const q = `${query} (${scope}) "fee" OR "parking" OR "day-use" OR "admission"`;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=6`;

  try {
    const sr = await fetch(url, { headers: { "X-Subscription-Token": key }});
    if (!sr.ok) return { statusCode: sr.status, body: await sr.text() };
    const data = await sr.json();
    const results = (data.web?.results || []).filter(r => r.url);

    let fallback = null;
    let checks = 0;

    for (const r of results) {
      if (checks >= 4) break;          // <= stop after 4 relevant checks
      if (!isOfficial(r.url)) continue;

      if (nameForMatch) {
        const score = Math.max(
          tokenSim(nameForMatch, r.title || ""),
          tokenSim(nameForMatch, r.snippet || "")
        );
        if (score < 0.5) continue;     // light fuzzy gate
      }

      checks++;
      const html = await fetchText(r.url);
      const haystack = `${r.title || ""}\n${r.snippet || ""}\n${html}`.toLowerCase();

      if (containsAny(haystack, NO_FEE_TERMS)) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            url: r.url,
            domain: new URL(r.url).hostname,
            title: r.title || "",
            feeInfo: "No fee",
            kind: "no-fee"
          })
        };
      }

      if (containsAny(haystack, FEE_TERMS)) {
        const amount = extractAmount(haystack);
        const kind = classifyKind(haystack);
        return {
          statusCode: 200,
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
      body: JSON.stringify({
        url: null, domain: null, title: "",
        feeInfo: "Not verified",
        kind: "not-verified"
      })
    };

  } catch (e) {
    return { statusCode: 500, body: e.message || "Error" };
  }
}
