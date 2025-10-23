// Netlify Function: /api/search
// v23 — International search + AllTrails URL extractor + region strictness + anti-wrong-state
// Env required: BRAVE_API_KEY

/////////////////////////////
// Multilingual fee signals
/////////////////////////////
const ENTRANCE_TERMS = [
  "entrance","entry","admission","day-use","day use","access",
  "entrada","ingreso","acceso",
  "entrée","entree","accès","acces",
  "eintritt","zugang",
  "ingresso","accesso","biglietto",
  "entrada","acesso",
  "toegang","adgang","inträde","inngang",
  "giriş","girış",
  "入場","入園","料金",
  "门票","門票","票價","票价","收费","收費",
  "入場料","입장료","요금"
];

const FEE_TERMS = [
  "fee","fees","price","prices","rate","rates","pricing","pass","parking fee","day-use",
  "tarifa","tarifas","precio","precios","pase",
  "tarif","tarifs","prix","pass",
  "gebühr","gebuehr","gebühren","preise",
  "tariffa","tariffe","prezzo","prezzi","pass",
  "taxa","taxas","preço","preços","passe",
  "料金","요금","收费","收費","цена","цены"
];

const NO_FEE_TERMS = [
  "no fee","free entry","free admission","free","no charge",
  "gratis","sin costo","sin cargo",
  "gratuit",
  "kostenlos",
  "gratuito","grátis","sem custo",
  "免费","免費","無料","무료"
];

// Currency recognition (broad)
const CURRENCY_RX = /(\$|€|£|¥|₹|₩|₺|₽|₴|R\$|C\$|A\$|NZ\$|CHF|SEK|NOK|DKK|zł|Kč|Ft|₫|R|AED|SAR|₱|MXN|COP|PEN|S\/|CLP|ARS)\s?\d{1,3}(?:[.,]\d{2})?/i;

/////////////////////////////
// Region knowledge (light)
/////////////////////////////
const US_STATES = [
  ["AL","Alabama"],["AK","Alaska"],["AZ","Arizona"],["AR","Arkansas"],["CA","California"],
  ["CO","Colorado"],["CT","Connecticut"],["DE","Delaware"],["FL","Florida"],["GA","Georgia"],
  ["HI","Hawaii"],["ID","Idaho"],["IL","Illinois"],["IN","Indiana"],["IA","Iowa"],
  ["KS","Kansas"],["KY","Kentucky"],["LA","Louisiana"],["ME","Maine"],["MD","Maryland"],
  ["MA","Massachusetts"],["MI","Michigan"],["MN","Minnesota"],["MS","Mississippi"],["MO","Missouri"],
  ["MT","Montana"],["NE","Nebraska"],["NV","Nevada"],["NH","New Hampshire"],["NJ","New Jersey"],
  ["NM","New Mexico"],["NY","New York"],["NC","North Carolina"],["ND","North Dakota"],["OH","Ohio"],
  ["OK","Oklahoma"],["OR","Oregon"],["PA","Pennsylvania"],["RI","Rhode Island"],["SC","South Carolina"],
  ["SD","South Dakota"],["TN","Tennessee"],["TX","Texas"],["UT","Utah"],["VT","Vermont"],
  ["VA","Virginia"],["WA","Washington"],["WV","West Virginia"],["WI","Wisconsin"],["WY","Wyoming"],
  ["DC","District of Columbia"]
];

const US_STATE_NAME_TO_ABBR = Object.fromEntries(US_STATES.map(([a,n]) => [n.toLowerCase(), a]));
const US_ABBR_TO_NAME = Object.fromEntries(US_STATES.map(([a,n]) => [a.toLowerCase(), n]));

function normalizeStateTerms(input) {
  if (!input) return [];
  const s = input.trim().toLowerCase();
  // accept "tx" / "texas" etc.
  for (const [abbr, name] of US_STATES) {
    if (s === abbr.toLowerCase() || s === name.toLowerCase()) {
      return [abbr.toLowerCase(), name.toLowerCase()];
    }
  }
  // otherwise treat the token as a free region token
  return [s];
}

function otherUsStateTokens(excludeTokens) {
  const ex = new Set(excludeTokens.map(t => t.toLowerCase()));
  const tokens = [];
  for (const [abbr, name] of US_STATES) {
    if (!ex.has(abbr.toLowerCase()) && !ex.has(name.toLowerCase())) {
      tokens.push(abbr.toLowerCase(), name.toLowerCase());
    }
  }
  return tokens;
}

/////////////////////////////
// General helpers
/////////////////////////////
function toSlug(s = "") {
  return s
    .toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
    return (await r.text()).slice(0, 900000); // cap
  } catch { return ""; }
}

function hasAny(hay, arr) {
  const t = hay.toLowerCase();
  return arr.some(k => t.includes(k));
}

function nearEachOther(text, wordsA, wordsB, maxGap = 220) {
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

function extractAmount(text) {
  const m = text.match(CURRENCY_RX);
  return m ? m[0].replace(/\s+/g," ") : null;
}

function looksLikeFeePath(path) {
  return (
    /\/fees?(\/|\.|$)/i.test(path) ||
    /\/(planyourvisit|visit|prices|pricing|tarif|tarifa|preise|料金|요금|收费)/i.test(path) ||
    /\/(admission|entrada|entree|eingang|ingresso)/i.test(path)
  );
}

function detectNpsIntent(q) {
  const s = (q || "").toLowerCase();
  return /\bnps\b|national park|national monument|national recreation area|national preserve/.test(s);
}

function isSameNpsUnit(r, displayName) {
  const nm = (displayName || "").toLowerCase();
  const slug = toSlug(displayName || "");
  const titleLower = (r.title || "").toLowerCase();
  const urlLower = (r.url || "").toLowerCase();
  return (
    titleLower.includes(nm) ||
    urlLower.includes(slug) ||
    tokenSim(nm, titleLower) >= 0.55
  );
}

// Global “official-ish” scoring
function scoreHost(url, displayName = "", query = "", npsIntent = false, regionTokens = [], otherStateTokens = []) {
  let score = 0;
  let host = "", path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch { return -1; }

  // government-ish
  const isGov =
    /\.gov(\.[a-z]{2})?$/.test(host) ||
    /\.govt\.[a-z]{2}$/.test(host) ||
    /\.gouv\.[a-z]{2}$/.test(host) ||
    /\.gob\.[a-z]{2}$/.test(host) ||
    /\.go\.[a-z]{2}$/.test(host) ||
    /\.municipio\.[a-z]{2}$/.test(host) ||
    /\.kommune\.[a-z]{2}$/.test(host);

  if (isGov) score += 80;

  // US federal agencies
  if (host === "nps.gov" || host.endsWith(".nps.gov")) score += (npsIntent ? 80 : 10);
  if (host === "fs.usda.gov" || host.endsWith(".fs.usda.gov") || host.endsWith(".usda.gov")) score += 60;
  if (host === "blm.gov" || host.endsWith(".blm.gov")) score += 60;

  // park-ish org/com
  const parkish = /(stateparks|nationalpark|national-?park|parks|parkandrec|recreation|recdept|dnr|naturalresources|natur|nature|reserva|reserve|parc|parque|parchi|gemeente|municipality|municipio|ayuntamiento|city|county|regionalpark|provincialpark)/.test(host);
  if (parkish) score += 28;

  // fee-y paths
  if (looksLikeFeePath(path)) score += 30;

  // region tokens boost
  const joined = host + " " + path;
  for (const t of regionTokens) {
    if (t && joined.includes(t)) score += 20;
  }

  // penalize other US states appearing in host/path (wrong-state guard)
  for (const t of otherStateTokens) {
    if (t && joined.includes(t)) score -= 30;
  }

  // similarity to name/query
  const sim = Math.max(
    tokenSim(displayName, host),
    tokenSim(displayName, path),
    tokenSim(displayName, query)
  );
  score += Math.round(sim * 30);

  // slug hint
  const slug = toSlug(displayName || query);
  if (slug && path.includes(slug)) score += 25;

  return score;
}

function ok(payload) {
  return { statusCode: 200, headers: { "Content-Type":"application/json" }, body: JSON.stringify(payload) };
}

/////////////////////////////
// AllTrails helpers
/////////////////////////////
function isAllTrailsUrl(s) {
  try { return new URL(s).hostname.includes("alltrails.com"); } catch { return false; }
}

// Try to infer state from an AllTrails trail URL like /trail/us/virginia/old-rag-...
function guessStateFromAllTrailsUrl(u) {
  try {
    const url = new URL(u);
    const parts = url.pathname.split("/").filter(Boolean);
    // e.g., ["trail","us","virginia","old-rag..."]
    if (parts[0] === "trail" && parts[1] === "us" && parts[2]) {
      const stateName = parts[2].replace(/-/g, " ").toLowerCase();
      // Map to abbr if we can
      const abbr = US_STATE_NAME_TO_ABBR[stateName];
      if (abbr) return US_STATES.find(([a]) => a === abbr)[1]; // Proper case
      // Try capitalizing each word
      return stateName.replace(/\b\w/g, c => c.toUpperCase());
    }
    return null;
  } catch { return null; }
}

// Heuristics to extract managing park from AllTrails HTML
async function extractParkFromAllTrails(url) {
  const html = await fetchText(url);
  if (!html) return { parkName: null, region: null };

  // Look for "park" page links in breadcrumbs or tag sections
  // Example anchor: <a href="https://www.alltrails.com/park/us/virginia/shenandoah-national-park">Shenandoah National Park</a>
  const parkLinkRegex = /<a[^>]+href="https?:\/\/www\.alltrails\.com\/park\/[^"]+"[^>]*>([^<]{3,120})<\/a>/gi;
  let m, candidates = [];
  while ((m = parkLinkRegex.exec(html)) !== null) {
    const name = (m[1] || "").replace(/\s+/g, " ").trim();
    if (name && !/alltrails/i.test(name)) candidates.push(name);
  }

  // Try JSON-LD (some pages have structured data with "name")
  // We scan for the biggest JSON-LD and look for "park" / "area" text nearby
  if (candidates.length === 0) {
    const ldjsonRegex = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let bestLen = 0, bestBlock = "";
    let mm;
    while ((mm = ldjsonRegex.exec(html)) !== null) {
      if (mm[1] && mm[1].length > bestLen) {
        bestLen = mm[1].length; bestBlock = mm[1];
      }
    }
    if (bestBlock) {
      try {
        const data = JSON.parse(bestBlock);
        const names = [];
        const crawl = (obj) => {
          if (!obj) return;
          if (Array.isArray(obj)) return obj.forEach(crawl);
          if (typeof obj === "object") {
            if (typeof obj.name === "string") names.push(obj.name);
            Object.values(obj).forEach(crawl);
          }
        };
        crawl(data);
        for (const n of names) {
          if (/park|parc|parque|reserve|preserve|forest|national/i.test(n)) {
            candidates.push(n);
          }
        }
      } catch {}
    }
  }

  // Unique + pick the most "park-ish"
  candidates = [...new Set(candidates)];
  candidates.sort((a,b) => (/\b(national|state|provincial|regional)\b/i.test(b)?1:0) - (/\b(national|state|provincial|regional)\b/i.test(a)?1:0));

  const parkName = candidates[0] || null;
  const region = guessStateFromAllTrailsUrl(url);
  return { parkName, region };
}

/////////////////////////////
// Main search handler
/////////////////////////////
export async function handler(event) {
  if (event.httpMethod !== "POST") return ok({ error: "POST only" });

  const key = process.env.BRAVE_API_KEY;
  if (!key) return ok({ error: "Missing BRAVE_API_KEY" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  let { query, state = null, nameForMatch = null } = body;
  if (!query) return ok({ error: "Missing query" });

  // AllTrails: if query is an AllTrails URL, resolve to park name + region
  if (isAllTrailsUrl(query)) {
    const { parkName, region } = await extractParkFromAllTrails(query);
    if (parkName) {
      nameForMatch = parkName;
    }
    if (region && !state) {
      state = region; // e.g., "Texas"
    }
    // If we still don't have a name, fall back to any slug words to improve results
    if (!nameForMatch) {
      try {
        const u = new URL(query);
        const parts = u.pathname.split("/").filter(Boolean);
        // keep last segment words as hint
        nameForMatch = parts[parts.length - 1]?.replace(/-/g, " ");
      } catch {}
    }
  }

  const displayName = nameForMatch || query;
  const npsIntent = detectNpsIntent(displayName);

  // Region tokens & wrong-state penalties
  const regionTokens = normalizeStateTerms(state); // e.g., ["tx","texas"]
  const otherStateTokens = regionTokens.length ? otherUsStateTokens(regionTokens) : [];

  // VERY BROAD queries with exact phrase variants
  const core = `(admission OR "entrance fee" OR "day use" OR day-use OR fee OR fees OR prices OR rates OR pricing OR tarifa OR tarifs OR preise OR prezzi OR precios OR 料金 OR 요금 OR 收费 OR "$")`;

  const qList = [
    `"${displayName}" ${core}`,
    `${displayName} ${core}`,
    `"${displayName}" (site:.gov OR site:.gov.* OR site:.govt.* OR site:.gouv.* OR site:.go.* OR site:.gob.*) ${core}`,
    `"${displayName}" (site:.org OR site:.com) (park OR parks OR "national park" OR "state park" OR parc OR parque OR reserve) ${core}`
  ];

  try {
    let bestFallback = null;
    const seenTop = [];

    for (const q of qList) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=20&country=US&search_lang=en`;
      const sr = await fetch(url, { headers: { "X-Subscription-Token": key, "Accept": "application/json" }});
      if (!sr.ok) continue;
      const data = await sr.json();
      let results = (data.web?.results || []).filter(r => r.url);

      // rank with name+region strictness
      results.sort((a, b) =>
        scoreHost(b.url, displayName, query, npsIntent, regionTokens, otherStateTokens) -
        scoreHost(a.url, displayName, query, npsIntent, regionTokens, otherStateTokens)
      );

      seenTop.push(...results.slice(0, 10).map(r => r.url));

      let checks = 0;
      let localFallback = null;

      for (const r of results) {
        if (checks >= 20) break;

        let u;
        try { u = new URL(r.url); } catch { continue; }
        const host = u.hostname.toLowerCase();
        const path = u.pathname.toLowerCase();

        // coarse name relevance
        const nameMatch = Math.max(
          tokenSim(displayName, r.title || ""),
          tokenSim(displayName, (host + path))
        );
        if (nameMatch < 0.20) { continue; }
        checks++;

        const htmlRaw = await fetchText(r.url);
        const hay = `${r.title || ""}\n${r.snippet || ""}\n${htmlRaw}`;
        const lower = hay.toLowerCase();

        // Require region tokens (if provided) to appear somewhere (title/url/body)
        if (regionTokens.length) {
          const inHay = regionTokens.some(t => t && lower.includes(t));
          const inJoined = regionTokens.some(t => t && (host + path).includes(t));
          if (!inHay && !inJoined) {
            // not confidently same state/country — skip
            continue;
          }
        }

        // Avoid unrelated NPS units
        if ((host.endsWith("nps.gov") || host === "nps.gov") && path.includes("/planyourvisit/")) {
          if (!isSameNpsUnit(r, displayName)) {
            continue;
          }
        }

        const hasCurrency = CURRENCY_RX.test(hay);
        const hasEntrance = hasAny(lower, ENTRANCE_TERMS);
        const hasFeeWord  = hasAny(lower, FEE_TERMS);
        const hasNoFee    = hasAny(lower, NO_FEE_TERMS);

        // explicit free near entrance/admission
        if (!hasCurrency && hasNoFee && nearEachOther(lower, NO_FEE_TERMS, ENTRANCE_TERMS, 240)) {
          return ok({ url: r.url, feeInfo: "No fee", kind: "no-fee" });
        }

        // fee detection
        if ((hasCurrency && (hasEntrance || hasFeeWord)) || (hasFeeWord && looksLikeFeePath(path))) {
          const amt = extractAmount(hay);
          const feeInfo = amt ? amt : "Fee charged";
          return ok({ url: r.url, feeInfo, kind: "general" });
        }

        // fallback candidate if it looks fee-ish or carries slug
        const slug = toSlug(displayName);
        if (!localFallback && (looksLikeFeePath(path) || (slug && path.includes(slug)))) {
          localFallback = r;
        }
      }

      if (localFallback && !bestFallback) {
        bestFallback = { url: localFallback.url, feeInfo: "Not verified", kind: "not-verified" };
      }
    }

    if (bestFallback) {
      return ok({ ...bestFallback, debugTopUrls: [...new Set(seenTop)].slice(0, 10) });
    }

    return ok({ url: null, feeInfo: "Not verified", kind: "not-verified", debugTopUrls: [] });

  } catch (e) {
    return ok({ error: e.message || "Error" });
  }
}
