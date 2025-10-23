// Netlify Function: /api/search  (v3 – NPS-aware, fewer false "no fee")
//
// Improvements:
// 1) Prefer official *fee pages* (URLs containing /fees or /planyourvisit/fees).
// 2) NPS-specific parsing for "Entrance Fees" tables (Private Vehicle, Motorcycle, Per Person).
// 3) "No fee" only if:
//    - we do NOT detect any $ amounts on the page, AND
//    - the phrase "no fee" appears near "entrance" or "day-use" terms.
// 4) If both "no fee" and fees appear, we always prefer the fee.
// 5) Ask Brave for more results and do up to 3 tailored queries.

const OFFICIAL_HOST_CHECKS = [
  h => h.endsWith(".gov"),
  h => h === "nps.gov" || h.endsWith(".nps.gov"),
  h => h === "usda.gov" || h.endsWith(".usda.gov") || h.endsWith(".fs.usda.gov"),
  h => h === "blm.gov" || h.endsWith(".blm.gov"),
];

const FEE_TERMS = [
  "entrance fee","entrance fees","admission","parking fee","day-use","day use",
  "permit","pass","vehicle fee","per vehicle","per person","entrance pass","standard amenity fee"
];

const ENTRANCE_TERMS = [
  "entrance","admission","day-use","day use","entry","gate"
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

function looksLikeFeePage(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    // common official fee page patterns
    return /\/fees(\/|\.|$)/.test(p) || p.includes("/planyourvisit/fees");
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
    return text.slice(0, 600000);
  } catch { return ""; }
}

function findDollarAmounts(text) {
  // $10 or $10.00; capture nearby context words
  const amounts = [...text.matchAll(/\$\s?(\d{1,3})(\.\d{2})?/g)].map(m => m[0].replace(/\s+/g,""));
  return amounts; // array of "$10", "$35.00", etc.
}

function extractLabeledAmount(text, labelRegexes) {
  // Look for "Private Vehicle $35", "$35 per vehicle", etc.
  for (const rx of labelRegexes) {
    const r1 = new RegExp(`${rx.source}\\s*[:\\-–]?\\s*\\$\\s?(\\d{1,3})(\\.\\d{2})?`, "i");
    const m1 = text.match(r1);
    if (m1) return `$${m1[1]}${m1[2] ?? ""}`;
  }
  // Also handle "$35 per vehicle" anywhere:
  const m2 = text.match(/\$\s?(\d{1,3})(\.\d{2})?\s*per\s*(vehicle|car|motorcycle|person)/i);
  if (m2) return `$${m2[1]}${m2[2] ?? ""} per ${m2[3]}`;
  return null;
}

function npsExtractEntranceFees(text) {
  // NPS pages often list: Private Vehicle, Motorcycle, Per Person
  const vehicle = extractLabeledAmount(text, [/private\s+vehicle/, /vehicle/]);
  const moto    = extractLabeledAmount(text, [/motorcycle/]);
  const person  = extractLabeledAmount(text, [/per\s+person/, /individual/]);

  // Prefer vehicle -> motorcycle -> person
  if (vehicle) return { feeInfo: vehicle.includes("per") ? vehicle : `${vehicle} per vehicle`, kind: "vehicle" };
  if (moto)    return { feeInfo: moto.includes("per") ? moto : `${moto} per vehicle`, kind: "vehicle" };
  if (person)  return { feeInfo: person.includes("per") ? person : `${person} per person`, kind: "general" };
  return null;
}

function nearEachOther(text, wordsA, wordsB, maxGap = 140) {
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

function makeQueries(query, state, nameForMatch) {
  const scope = buildScope(state);
  const base = [
    `${query} ${scope} (fee OR fees OR "entrance fee" OR admission OR parking)`,
  ];
  // If we have a nice name, try an NPS-fee-focused query too
  if (nameForMatch) {
    base.push(`${nameForMatch} site:nps.gov (fees OR "entrance fees" OR "plan your visit" OR planyourvisit/fees)`);
  }
  // And a general fees page probe
  base.push(`${query} ${scope} (fees page OR /fees)`);
  return base;
}

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

  const queries = makeQueries(query, state, nameForMatch).slice(0, 3);

  try {
    for (const q of queries) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=12&country=US&search_lang=en`;
      const sr = await fetch(url, { headers: { "X-Subscription-Token": key, "Accept": "application/json" }});
      if (!sr.ok) continue;
      const data = await sr.json();
      let results = (data.web?.results || []).filter(r => r.url);

      // Prefer official results and, within those, fee pages first
      results = results
        .filter(r => isOfficial(r.url))
        .sort((a, b) => Number(looksLikeFeePage(b.url)) - Number(looksLikeFeePage(a.url)));

      // Fall back to any result if none official
      if (!results.length) results = (data.web?.results || []).filter(r => r.url);

      let fallback = null;
      let checks = 0;

      for (const r of results) {
        if (checks >= 4) break;

        if (nameForMatch) {
          const score = Math.max(
            tokenSim(nameForMatch, r.title || ""),
            tokenSim(nameForMatch, r.snippet || "")
          );
          if (score < 0.45) continue;
        }

        checks++;
        const htmlRaw = await fetchText(r.url);
        const hay = `${r.title || ""}\n${r.snippet || ""}\n${htmlRaw}`;
        const lower = hay.toLowerCase();

        // 1) NPS-specific structured extraction
        if (new URL(r.url).hostname.toLowerCase().endsWith("nps.gov")) {
          // Look for "Entrance Fees" section header quickly
          if (lower.includes("entrance fee")) {
            const npsHit = npsExtractEntranceFees(hay);
            if (npsHit) {
              return {
                statusCode: 200,
                headers: { "Content-Type":"application/json" },
                body: JSON.stringify({
                  url: r.url,
                  domain: new URL(r.url).hostname,
                  title: r.title || "",
                  feeInfo: npsHit.feeInfo,
                  kind: npsHit.kind
                })
              };
            }
          }
        }

        // 2) Generic extraction
        const amounts = findDollarAmounts(hay);
        const hasFeeTerms = FEE_TERMS.some(k => lower.includes(k));
        const hasNoFeeTerms = NO_FEE_TERMS.some(k => lower.includes(k));
        const hasEntranceContextNoFee = hasNoFeeTerms && nearEachOther(lower, NO_FEE_TERMS, ENTRANCE_TERMS, 160);

        // If any $ amounts OR strong fee terms exist → prefer fee path
        if (amounts.length || hasFeeTerms) {
          const labeled = npsExtractEntranceFees(hay) || null;
          const feeInfo = labeled?.feeInfo || (amounts[0] ? amounts[0] : "Fee charged");
          const kind = labeled?.kind || classifyKind(lower);
          return {
            statusCode: 200,
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({
              url: r.url,
              domain: new URL(r.url).hostname,
              title: r.title || "",
              feeInfo,
              kind
            })
          };
        }

        // Only report "No fee" when:
        //  - We did NOT see any $ amounts, AND
        //  - The "no fee"/"free" phrase is in ENTRANCE/DAY-USE context.
        if (!amounts.length && hasEntranceContextNoFee) {
          return {
            statusCode: 200,
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({
              url: r.url,
              domain: new URL(r.url).hostname,
              title: r.title || "",
              feeInfo: "No fee",
              kind: "no-fee"
            })
          };
        }

        fallback = fallback || r;
      }

      if (fallback) {
        return {
          statusCode: 200,
          headers: { "Content-Type":"application/json" },
          body: JSON.stringify({
            url: fallback.url,
            domain: new URL(fallback.url).hostname,
            title: fallback.title || "",
            feeInfo: "Not verified",
            kind: "not-verified"
          })
        };
      }
    }

    // Nothing helpful from all queries
    return {
      statusCode: 200,
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({
        url: null, domain: null, title: "",
        feeInfo: "Not verified",
        kind: "not-verified"
      })
    };

  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ error: e.message || "Error" })
    };
  }
}
