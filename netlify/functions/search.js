// Netlify Function: /api/search (v7 — scoring-based official detection + NPS + Admission/$ parsing)

const ENTRANCE_TERMS = ["entrance","admission","day-use","day use","entry","gate"];
const FEE_TERMS = [
  "entrance fee","entrance fees","admission","admission fee","admission rates",
  "parking fee","day-use","day use","vehicle fee","per vehicle","per person",
  "entrance pass","amenity fee","standard amenity fee","use fee","daily fee","$"
];
const NO_FEE_TERMS = [
  "no fee","free entry","free admission","no entrance fee","free to enter",
  "no day-use fee","no fees","no charge"
];

// ---------- utils ----------
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
    return (await r.text()).slice(0, 800000);
  } catch { return ""; }
}

function findDollarAmounts(text) {
  return [...text.matchAll(/\$\s?(\d{1,3})(\.\d{2})?/g)].map(m => m[0].replace(/\s+/g,""));
}

function extractAmount(text) {
  // "$35 per vehicle", "$3 per adult", "$35", etc.
  const m = text.match(/\$\s?(\d{1,3})(\.\d{2})?\s*(per\s*(vehicle|car|person|adult|child|motorcycle|bike))?/i);
  if (!m) return null;
  const dollars = `$${m[1]}${m[2] ?? ""}`;
  const suffix = m[3] ? ` ${m[3]}` : "";
  return `${dollars}${suffix}`.trim();
}

function extractAdmissionBlock(text) {
  // Look for ADMISSION lines like:
  // "ADMISSION $3 adults; $1.50 SC seniors; $1 children age 6-15; age 5 & younger free"
  const m = text.match(/admission[^.\n\r:<]*[:\-]?\s*(?:<[^>]*>)*\s*(\$[^.\n\r<]+)/i);
  if (!m) return null;
  const anyAmt = extractAmount(m[0]);
  return anyAmt || "Fee charged";
}

function npsExtractEntranceFees(text) {
  // Try to pull Vehicle/Motorcycle/Per Person from typical NPS pages
  const vehicle = extractLabelAmount(text, [/private\s+vehicle/, /vehicle/]);
  const moto    = extractLabelAmount(text, [/motorcycle/]);
  const person  = extractLabelAmount(text, [/per\s+person/, /individual/]);

  if (vehicle) return { feeInfo: vehicle.includes("per") ? vehicle : `${vehicle} per vehicle`, kind: "vehicle" };
  if (moto)    return { feeInfo: moto.includes("per") ? moto : `${moto} per vehicle`, kind: "vehicle" };
  if (person)  return { feeInfo: person.includes("per") ? person : `${person} per person`, kind: "general" };
  return null;
}

function extractLabelAmount(text, labelRegexes) {
  for (const rx of labelRegexes) {
    const r1 = new RegExp(`${rx.source}\\s*[:\\-–]?\\s*\\$\\s?(\\d{1,3})(\\.\\d{2})?`, "i");
    const m1 = text.match(r1);
    if (m1) return `$${m1[1]}${m1[2] ?? ""}`;
  }
  const m2 = text.match(/\$\s?(\d{1,3})(\.\d{2})?\s*per\s*(vehicle|car|person|adult|child)/i);
  if (m2) return `$${m2[1]}${m2[2] ?? ""} per ${m2[3]}`;
  return null;
}

function nearEachOther(text, wordsA, wordsB, maxGap = 160) {
  const t = text.toLowerCase();
  for (const a of wordsA) {
    const ia = t.indexOf(a);
    if (ia === -1) continue;
    for (const b of wordsB) {
      const ib = t.indexOf(b);
      if (ib === -1) continue;
      if (Math.abs(ia - ib) <= maxGap) return true;
    }
  }
  return false;
}

function classifyKind(text) {
  const t = text.toLowerCase();
  if (t.includes("parking fee") || t.includes("parking pass")) return "parking";
  if (t.includes("per vehicle") || t.includes("vehicle")) return "vehicle";
  return "general";
}

// ---------- domain scoring (no per-state list required) ----------
function scoreHost(url, nameForMatch = "", query = "") {
  let score = 0;
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch { return -1; }

  const tldGov = host.endsWith(".gov");
  const tldUs  = host.endsWith(".us");
  const tldOrg = host.endsWith(".org");
  const tldCom = host.endsWith(".com");

  // Strongly prefer federal official
  if (host === "nps.gov" || host.endsWith(".nps.gov")) score += 80;
  if (host === "fs.usda.gov" || host.endsWith(".fs.usda.gov") || host.endsWith(".usda.gov")) score += 70;
  if (host === "blm.gov" || host.endsWith(".blm.gov")) score += 70;
  if (tldGov) score += 60;

  // Semi-official/local agency patterns on .com/.org/.us
  const hostHasParkish =
    /stateparks|parks|parkandrec|parkrec|recreation|recreationandparks|recdept|conservation|dnr|naturalresources|gameandfish|fishandgame|county|city|township/.test(host);
  if (tldUs)  score += 35;
  if (tldOrg && hostHasParkish) score += 28;
  if (tldCom && hostHasParkish) score += 24;

  // Prefer likely fee pages
  if (/\/fees(\/|\.|$)/.test(path)) score += 25;
  if (path.includes("/planyourvisit/fees")) score += 25;
  if (path.includes("/admission")) score += 20;
  if (path.includes("/maps-and-brochures")) score += 16;
  if (path.includes("/rates") || path.includes("/pricing")) score += 14;

  // Fuzzy match to the queried name
  const sim = Math.max(tokenSim(nameForMatch, host), tokenSim(nameForMatch, path), tokenSim(nameForMatch, query));
  score += Math.round(sim * 30); // up to +30

  return score;
}

function buildScope(stateCode) {
  const base = [
    "site:.gov",
    "site:.us",
    "site:.org",
    "site:.com",
    "site:nps.gov",
    "site:fs.usda.gov",
    "site:blm.gov"
  ];
  if (stateCode) {
    const st = stateCode.toLowerCase();
    base.push(`site:${st}.gov`, `site:${st}.us`, `site:parks.${st}.gov`, `site:stateparks.${st}.gov`);
  }
  return "(" + base.join(" OR ") + ")";
}

// ---------- main ----------
export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: { "Content-Type":"application/json" }, body: JSON.stringify({ error: "POST only" }) };
  }

  const key = process.env.BRAVE_API_KEY;
  if (!key) {
    return { statusCode: 500, headers: { "Content-Type":"application/json" }, body: JSON.stringify({ error: "Missing BRAVE_API_KEY" }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const { query, state=null, nameForMatch=null } = body;
  if (!query) {
    return { statusCode: 400, headers: { "Content-Type":"application/json" }, body: JSON.stringify({ error: "Missing query" }) };
  }

  const scope = buildScope(state);
  const q = `${query} ${scope} (admission OR "entrance fee" OR "$" OR "day-use" OR "parking fee")`;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=12&country=US&search_lang=en`;

  try {
    const sr = await fetch(url, { headers: { "X-Subscription-Token": key, "Accept": "application/json" }});
    if (!sr.ok) {
      return { statusCode: sr.status, headers: { "Content-Type":"application/json" }, body: JSON.stringify({ error: "Brave error", detail: await sr.text() }) };
    }
    const data = await sr.json();
    let results = (data.web?.results || []).filter(r => r.url);

    // Score results to prefer the right domains
    results.sort((a, b) => scoreHost(b.url, nameForMatch || query, query) - scoreHost(a.url, nameForMatch || query, query));

    let fallback = null;
    let checks = 0;

    for (const r of results) {
      if (checks >= 4) break;
      checks++;

      const htmlRaw = await fetchText(r.url);
      const hay = `${r.title || ""}\n${r.snippet || ""}\n${htmlRaw}`;
      const lower = hay.toLowerCase();

      // NPS-specific: try structured entrance fee extraction
      try {
        const host = new URL(r.url).hostname.toLowerCase();
        if (host.endsWith("nps.gov") || host === "nps.gov") {
          if (lower.includes("entrance fee")) {
            const npsHit = npsExtractEntranceFees(hay);
            if (npsHit) {
              return ok({
                url: r.url,
                feeInfo: npsHit.feeInfo,
                kind: npsHit.kind
              });
            }
          }
        }
      } catch {}

      // Generic admission block (e.g., many state/county sites)
      if (lower.includes("admission")) {
        const adm = extractAdmissionBlock(hay);
        if (adm) {
          const kind = adm.includes("per vehicle") ? "vehicle" : classifyKind(lower);
          return ok({ url: r.url, feeInfo: adm, kind });
        }
      }

      // Generic fee detection via $/terms
      const amounts = findDollarAmounts(hay);
      const hasFeeTerms = FEE_TERMS.some(k => lower.includes(k));
      const hasNoFeeTerms = NO_FEE_TERMS.some(k => lower.includes(k));
      const hasEntranceContextNoFee = hasNoFeeTerms && nearEachOther(lower, NO_FEE_TERMS, ENTRANCE_TERMS, 160);

      if (amounts.length || hasFeeTerms) {
        const labeled = npsExtractEntranceFees(hay) || null;
        const feeInfo = labeled?.feeInfo || (extractAmount(hay) || "Fee charged");
        const kind = labeled?.kind || classifyKind(lower);
        return ok({ url: r.url, feeInfo, kind });
      }

      // Only report "No fee" when there are NO dollar amounts AND phrase is near entrance terms
      if (!amounts.length && hasEntranceContextNoFee) {
        return ok({ url: r.url, feeInfo: "No fee", kind: "no-fee" });
      }

      fallback = fallback || r;
    }

    if (fallback) {
      return ok({ url: fallback.url, feeInfo: "Not verified", kind: "not-verified" });
    }

    return ok({ url: null, feeInfo: "Not verified", kind: "not-verified" });

  } catch (e) {
    return { statusCode: 500, headers: { "Content-Type":"application/json" }, body: JSON.stringify({ error: e.message || "Error" }) };
  }
}

// helper for consistent responses
function ok(payload) {
  return { statusCode: 200, headers: { "Content-Type":"application/json" }, body: JSON.stringify(payload) };
}
