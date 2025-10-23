// Netlify Function: /api/search (v9 — prefer state-park pages like TPWD; generic alert)
// - Scores by domain trust, path hints (/state-parks/), host hints (tpwd), and name slug match
// - Penalizes NPS unless the unit clearly matches the query
// - Parses NPS fee tables + generic ADMISSION/$
// - Stops after 4 checked pages

const ENTRANCE_TERMS = ["entrance","admission","day-use","day use","entry","gate"];
const FEE_TERMS = [
  "entrance fee","entrance fees","admission","admission fee","admission rates",
  "parking fee","day-use","day use","entrance pass","amenity fee","$"
];
const NO_FEE_TERMS = [
  "no fee","free entry","free admission","no entrance fee","free to enter",
  "no day-use fee","no fees","no charge"
];

// ---------- utils ----------
function toSlug(s="") {
  return s
    .toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/^-+|-+$/g,"");
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
    return (await r.text()).slice(0, 800000);
  } catch { return ""; }
}

function findDollarAmounts(text) {
  return [...text.matchAll(/\$\s?(\d{1,3})(\.\d{2})?/g)].map(m => m[0].replace(/\s+/g,""));
}

function extractAmount(text) {
  // "$5 per person", "$35", "$10 per vehicle"
  const m = text.match(/\$\s?(\d{1,3})(\.\d{2})?\s*(per\s*(vehicle|car|person|adult|child|motorcycle|bike))?/i);
  if (!m) return null;
  const dollars = `$${m[1]}${m[2] ?? ""}`;
  const suffix = m[3] ? ` ${m[3]}` : "";
  return `${dollars}${suffix}`.trim();
}

function extractAdmissionBlock(text) {
  // e.g. "ADMISSION $3 adults; $1.50 seniors; ..."
  const m = text.match(/admission[^.\n\r:<]*[:\-]?\s*(?:<[^>]*>)*\s*(\$[^.\n\r<]+)/i);
  if (!m) return null;
  const anyAmt = extractAmount(m[0]);
  return anyAmt || "Fee charged";
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

function npsExtractEntranceFees(text) {
  const vehicle = extractLabelAmount(text, [/private\s+vehicle/, /vehicle/]);
  const moto    = extractLabelAmount(text, [/motorcycle/]);
  const person  = extractLabelAmount(text, [/per\s+person/, /individual/]);
  if (vehicle) return { feeInfo: vehicle.includes("per") ? vehicle : `${vehicle} per vehicle` };
  if (moto)    return { feeInfo: moto.includes("per") ? moto : `${moto} per vehicle` };
  if (person)  return { feeInfo: person.includes("per") ? person : `${person} per person` };
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

function looksLikeFeePath(path) {
  return (
    /\/fees(\/|\.|$)/.test(path) ||
    path.includes("/planyourvisit/fees") ||
    path.includes("/admission") ||
    path.includes("/maps-and-brochures") ||
    path.includes("/rates") ||
    path.includes("/pricing") ||
    path.includes("/fees-facilities") ||
    path.includes("/state-parks/") // <-- big boost for TPWD & many states
  );
}

function detectNpsIntent(q) {
  const s = (q || "").toLowerCase();
  return /\bnps\b|national park|national monument|national recreation area|national preserve/.test(s);
}

// Domain scoring (no per-state list; uses hints instead)
function scoreHost(url, nameForMatch = "", query = "", npsIntent = false) {
  let score = 0;
  let host = "", path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch { return -1; }

  const tldGov = host.endsWith(".gov");
  const tldUs  = host.endsWith(".us");
  const tldOrg = host.endsWith(".org");
  const tldCom = host.endsWith(".com");

  // Strongly prefer federal official, but only if intended
  if (host === "nps.gov" || host.endsWith(".nps.gov")) score += (npsIntent ? 80 : 10);
  if (host === "fs.usda.gov" || host.endsWith(".fs.usda.gov") || host.endsWith(".usda.gov")) score += 60;
  if (host === "blm.gov" || host.endsWith(".blm.gov")) score += 60;
  if (host === ".gov" || host.endsWith(".gov")) score += 60;
  if (host.includes("tpwd")) score += 40;
  if (path.includes("/state-parks/")) score += 40;
  if (path.includes ("statepark")) score +=40;
  if (tldGov) score += 50;

  // Semi-official/local: park-ish keywords
  const parkish = /stateparks|parks|parkandrec|recreation|recdept|dnr|naturalresources|county|city|tpwd|parksandwildlife/.test(host);
  if (tldUs)  score += 30;
  if (tldOrg && parkish) score += 26;
  if (tldCom && parkish) score += 24;

  // Big hints for state-park fee pages
  if (looksLikeFeePath(path)) score += 28;
  if (host.includes("tpwd")) score += 35;              // Texas Parks & Wildlife
  if (path.includes("/state-parks/")) score += 32;     // Many states use this

  // Fuzzy match to name (host/path/title/query)
  const sim = Math.max(
    tokenSim(nameForMatch, host),
    tokenSim(nameForMatch, path),
    tokenSim(nameForMatch, query)
  );
  score += Math.round(sim * 30); // up to +30

  // If query does NOT look like NPS and host is nps.gov → penalize a lot
  if (!npsIntent && (host === "nps.gov" || host.endsWith(".nps.gov"))) score -= 60;

  // Extra bonus if the park slug appears in the path
 if (slug && path.includes(slug)) {
  // try to parse immediately
  const htmlRaw = await fetchText(r.url);
  const hay = `${r.title || ""}\n${r.snippet || ""}\n${htmlRaw}`;
  const lower = hay.toLowerCase();

  // admission block
  if (lower.includes("admission")) {
    const adm = extractAdmissionBlock(hay);
    if (adm) return ok({ url: r.url, feeInfo: adm, kind: "general" });
  }
  // generic $/fee detection
  const amounts = findDollarAmounts(hay);
  if (amounts.length || /entrance fee|admission|day\-use|\$/.test(lower)) {
    const feeInfo = extractAmount(hay) || "Fee charged";
    return ok({ url: r.url, feeInfo, kind: "general" });
  }
  // explicit “no fee” near entrance words
  if (/no fee|free/.test(lower) && nearEachOther(lower, ["no fee","free"], ["entrance","admission","day-use"])) {
    return ok({ url: r.url, feeInfo: "No fee", kind: "no-fee" });
  }
}
  
function buildScope(stateCode) {
  const base = [
    "site:.gov","site:.us","site:.org","site:.com",
    "site:nps.gov","site:fs.usda.gov","site:blm.gov"
  ];
  if (stateCode) {
    const st = stateCode.toLowerCase();
    base.push(`site:${st}.gov`, `site:${st}.us`, `site:parks.${st}.gov`, `site:stateparks.${st}.gov`);
  }
  return "(" + base.join(" OR ") + ")";
}

function ok(payload) {
  return { statusCode: 200, headers: { "Content-Type":"application/json" }, body: JSON.stringify(payload) };
}

// ---------- main ----------
export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return ok({ error: "POST only" });
  }

  const key = process.env.BRAVE_API_KEY;
  if (!key) return ok({ error: "Missing BRAVE_API_KEY" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const { query, state=null, nameForMatch=null } = body;
  if (!query) return ok({ error: "Missing query" });

  const scope = buildScope(state);
  const baseQ = `${query} ${scope} (admission OR "entrance fee" OR "$" OR "day-use" OR "parking fee")`;

  // Try two queries: general + fee-path focused (improves TPWD/other states)
  const queries = [
    baseQ,
    `${query} ${scope} ("/state-parks/" OR "/fees-facilities/" OR "/fees")`
  ];

  const npsIntent = detectNpsIntent(query);

  try {
    let bestPayload = null;

    for (const q of queries) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=12&country=US&search_lang=en`;
      const sr = await fetch(url, { headers: { "X-Subscription-Token": key, "Accept": "application/json" }});
      if (!sr.ok) continue;
      const data = await sr.json();
      let results = (data.web?.results || []).filter(r => r.url);

      // Score & sort
      results.sort((a, b) =>
        scoreHost(b.url, nameForMatch || query, query, npsIntent) -
        scoreHost(a.url, nameForMatch || query, query, npsIntent)
      );

      let fallback = null;
      let checks = 0;

      for (const r of results) {
        if (checks >= 10) break;

        const u = new URL(r.url);
        const host = u.hostname.toLowerCase();
        const path = u.pathname.toLowerCase();

        // Require loose name match to avoid unrelated units (e.g., REDW vs San Angelo)
        const nameMatch = Math.max(
          tokenSim(nameForMatch || query, r.title || ""),
          tokenSim(nameForMatch || query, host + path)
        );
        if (nameMatch < 0.20) { continue; }

        checks++;
        const htmlRaw = await fetchText(r.url);
        const hay = `${r.title || ""}\n${r.snippet || ""}\n${htmlRaw}`;
        const lower = hay.toLowerCase();

        // NPS structured extraction (only when it's actually NPS and looks like fees)
        if ((host.endsWith("nps.gov") || host === "nps.gov") && path.includes("/planyourvisit/")) {
          if (lower.includes("entrance fee")) {
            const npsHit = npsExtractEntranceFees(hay);
            if (npsHit) {
              return ok({ url: r.url, feeInfo: npsHit.feeInfo, kind: "general" });
            }
          }
        }

        // Admission block (e.g., many state/county sites)
        if (lower.includes("admission")) {
          const adm = extractAdmissionBlock(hay);
          if (adm) return ok({ url: r.url, feeInfo: adm, kind: "general" });
        }

        // Generic $/fee detection
        const amounts = findDollarAmounts(hay);
        const hasFeeTerms = FEE_TERMS.some(k => lower.includes(k));
        const hasNoFeeTerms = NO_FEE_TERMS.some(k => lower.includes(k));
        const hasEntranceContextNoFee = hasNoFeeTerms && nearEachOther(lower, NO_FEE_TERMS, ENTRANCE_TERMS, 160);

        if (amounts.length || hasFeeTerms) {
          const labeled = npsExtractEntranceFees(hay);
          const feeInfo = labeled?.feeInfo || extractAmount(hay) || "Fee charged";
          return ok({ url: r.url, feeInfo, kind: "general" });
        }

        if (!amounts.length && hasEntranceContextNoFee) {
          return ok({ url: r.url, feeInfo: "No fee", kind: "no-fee" });
        }

        fallback = fallback || r;
      }

      // keep best fallback across queries
      if (fallback && !bestPayload) {
        bestPayload = { url: fallback.url, feeInfo: "Not verified", kind: "not-verified" };
      }
    }

    if (bestPayload) return ok(bestPayload);
    return ok({ url: null, feeInfo: "Not verified", kind: "not-verified" });

  } catch (e) {
    return ok({ error: e.message || "Error" });
  }
}
