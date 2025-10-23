// Netlify Function: /api/search
// v26 — Robust AllTrails extractor (__NEXT_DATA__), strong name-token filter, region inference
// Env var required: BRAVE_API_KEY

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

// Broad currency detector
const CURRENCY_RX = /(\$|€|£|¥|₹|₩|₺|₽|₴|R\$|C\$|A\$|NZ\$|CHF|SEK|NOK|DKK|zł|Kč|Ft|₫|R|AED|SAR|₱|MXN|COP|PEN|S\/|CLP|ARS)\s?\d{1,3}(?:[.,]\d{2})?/i;

/////////////////////////////
// US state metadata
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
const STATE_NAME_TO_ABBR = Object.fromEntries(US_STATES.map(([a,n]) => [n.toLowerCase(), a]));
const STATE_ABBR_TO_NAME = Object.fromEntries(US_STATES.map(([a,n]) => [a.toLowerCase(), n]));

/////////////////////////////
// Utility helpers
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
    return (await r.text()).slice(0, 900000);
  } catch { return ""; }
}

function hasAny(hay, arr) {
  const t = hay.toLowerCase();
  return arr.some(k => t && t.includes(k));
}

function nearEachOther(text, groupA, groupB, maxGap = 240) {
  const t = text.toLowerCase();
  for (const a of groupA) {
    const ia = t.indexOf(a);
    if (ia === -1) continue;
    for (const b of groupB) {
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

function isAllTrailsUrl(s) {
  try { return new URL(s).hostname.includes("alltrails.com"); } catch { return false; }
}

/////////////////////////////
// Region parsing
/////////////////////////////
function normalizeRegionTokens(input) {
  if (!input) return [];
  const s = input.trim().toLowerCase();
  for (const [abbr, name] of US_STATES) {
    if (s === abbr.toLowerCase() || s === name.toLowerCase()) {
      return [abbr.toLowerCase(), name.toLowerCase()];
    }
  }
  return [s];
}

function otherUsStateTokens(excludeTokens = []) {
  const ex = new Set(excludeTokens.map(t => t.toLowerCase()));
  const toks = [];
  for (const [abbr, name] of US_STATES) {
    if (!ex.has(abbr.toLowerCase()) && !ex.has(name.toLowerCase())) {
      toks.push(abbr.toLowerCase(), name.toLowerCase());
    }
  }
  return toks;
}

function detectStateInString(s) {
  if (!s) return null;
  const low = s.toLowerCase();
  for (const [abbr, name] of US_STATES) {
    if (low.includes(name.toLowerCase()) || low.match(new RegExp(`\\b${abbr.toLowerCase()}\\b`))) {
      return name; // canonical name
    }
  }
  return null;
}

function guessStateFromAllTrailsUrl(u) {
  try {
    const url = new URL(u);
    const parts = url.pathname.split("/").filter(Boolean);
    // /trail/us/louisiana/slug...
    if (parts[0] === "trail" && parts[1] === "us" && parts[2]) {
      const name = parts[2].replace(/-/g, " ").toLowerCase();
      const abbr = STATE_NAME_TO_ABBR[name];
      if (abbr) return US_STATES.find(([a]) => a === abbr)[1];
      return name.replace(/\b\w/g, c => c.toUpperCase());
    }
  } catch {}
  return null;
}

/////////////////////////////
// “Official-ish” ranking
/////////////////////////////
function scoreHost(url, displayName, query, npsIntent, regionTokens = [], otherStateTokens = []) {
  let score = 0;
  let host = "", path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch { return -1; }

  const isGov =
    /\.gov(\.[a-z]{2})?$/.test(host) ||
    /\.govt\.[a-z]{2}$/.test(host) ||
    /\.gouv\.[a-z]{2}$/.test(host) ||
    /\.gob\.[a-z]{2}$/.test(host) ||
    /\.go\.[a-z]{2}$/.test(host) ||
    /\.municipio\.[a-z]{2}$/.test(host) ||
    /\.kommune\.[a-z]{2}$/.test(host);

  if (isGov) score += 80;
  if (host === "nps.gov" || host.endsWith(".nps.gov")) score += (npsIntent ? 80 : 10);
  if (host === "fs.usda.gov" || host.endsWith(".fs.usda.gov") || host.endsWith(".usda.gov")) score += 60;
  if (host === "blm.gov" || host.endsWith(".blm.gov")) score += 60;

  const parkish = /(stateparks|nationalpark|national-?park|parks|parkandrec|recreation|recdept|dnr|naturalresources|natur|nature|reserva|reserve|parc|parque|parchi|municipality|municipio|ayuntamiento|city|county|regionalpark|provincialpark)/.test(host);
  if (parkish) score += 28;

  if (looksLikeFeePath(path)) score += 30;

  // Region boost / wrong-state penalty
  const joined = host + " " + path;
  for (const t of regionTokens) if (t && joined.includes(t)) score += 24;
  for (const t of otherStateTokens) if (t && joined.includes(t)) score -= 40;

  // Name similarity
  const sim = Math.max(
    tokenSim(displayName, host),
    tokenSim(displayName, path),
    tokenSim(displayName, query)
  );
  score += Math.round(sim * 30);

  const slug = toSlug(displayName || query);
  if (slug && path.includes(slug)) score += 25;

  return score;
}

/////////////////////////////
// Name-token gating
/////////////////////////////
const GENERIC_NAME_WORDS = new Set([
  "the","a","an","of","and","or","at","on","in","to","for","by",
  "park","parks","state","national","provincial","regional","county","city","trail","area","forest","recreation","recreational","natural","nature","reserve","preserve","site"
]);

function coreNameTokens(name) {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g," ")
    .split(/\s+/)
    .filter(t => t && !GENERIC_NAME_WORDS.has(t) && t.length >= 3);
}

// Require at least min(3, tokens.length) distinctive tokens to appear
function passesNameTokenGate(haystack, displayName) {
  const text = haystack.toLowerCase();
  const tokens = coreNameTokens(displayName);
  if (tokens.length === 0) return true;
  const need = Math.min(3, tokens.length);
  let hit = 0;
  for (const t of tokens) if (text.includes(t)) hit++;
  return hit >= need;
}

/////////////////////////////
// AllTrails extractors (ROBUST)
/////////////////////////////
function collectNamesFromJson(obj, out = new Set()) {
  if (!obj) return out;
  if (Array.isArray(obj)) { obj.forEach(it => collectNamesFromJson(it, out)); return out; }
  if (typeof obj === "object") {
    for (const [k,v] of Object.entries(obj)) {
      if (k === "name" && typeof v === "string" && v.length <= 120) out.add(v);
      // Common AllTrails fields that hold display names:
      if (typeof v === "string" && /park|forest|preserve|reserve|recreation|national|state/i.test(v) && v.length <= 140) {
        out.add(v);
      }
      collectNamesFromJson(v, out);
    }
  }
  return out;
}

function pickMostParkLikeName(names) {
  const arr = [...names];
  // Prefer names with explicit park keywords and more specific qualifiers
  const score = (n) => {
    const s = n.toLowerCase();
    let sc = 0;
    if (/\b(national|state|provincial|regional|county)\b/.test(s)) sc += 5;
    if (/\bpark\b/.test(s)) sc += 5;
    if (/forest|preserve|reserve|recreation/.test(s)) sc += 3;
    sc += Math.min(4, coreNameTokens(n).length); // distinctiveness
    return sc;
  };
  arr.sort((a,b) => score(b) - score(a));
  return arr[0] || null;
}

async function extractParkFromAllTrails(url) {
  const html = await fetchText(url);
  if (!html) return { parkName: null, region: null };

  // 1) __NEXT_DATA__ (Next.js) — the most reliable
  const nextMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1]);
      const names = collectNamesFromJson(data);
      const best = pickMostParkLikeName(names);
      const region =
        detectStateInString(JSON.stringify(data)) ||
        guessStateFromAllTrailsUrl(url) ||
        detectStateInString(html) ||
        null;
      if (best) return { parkName: best, region };
    } catch {}
  }

  // 2) JSON-LD blocks
  const ldjsonRegex = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let block;
  let namesLD = new Set();
  while ((block = ldjsonRegex.exec(html)) !== null) {
    try {
      const json = JSON.parse(block[1]);
      collectNamesFromJson(json, namesLD);
    } catch {}
  }
  if (namesLD.size) {
    const best = pickMostParkLikeName(namesLD);
    const region =
      detectStateInString(html) ||
      guessStateFromAllTrailsUrl(url) ||
      null;
    if (best) return { parkName: best, region };
  }

  // 3) Park anchor slug fallback
  const candidates = new Set();
  const parkAnchor = /https?:\/\/www\.alltrails\.com\/park\/[^"]+\/([a-z0-9\-]+)"/gi;
  let m;
  while ((m = parkAnchor.exec(html)) !== null) {
    const slug = (m[1] || "").replace(/-/g, " ");
    if (slug) candidates.add(slug.replace(/\b\w/g, c => c.toUpperCase()));
  }
  if (candidates.size) {
    return { parkName: pickMostParkLikeName(candidates), region: guessStateFromAllTrailsUrl(url) || detectStateInString(html) || null };
  }

  // 4) Title fallback
  const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "").replace(/\s+\|.*$/,"").trim();
  const titleCand = /(.+?)\s*-\s*AllTrails/i.test(title) ? RegExp.$1 : title;
  if (titleCand) {
    const region = guessStateFromAllTrailsUrl(url) || detectStateInString(html) || null;
    return { parkName: titleCand, region };
  }

  return { parkName: null, region: guessStateFromAllTrailsUrl(url) || detectStateInString(html) || null };
}

/////////////////////////////
// Brave search & logic
/////////////////////////////
function buildQueries(displayName, region) {
  const core = `(admission OR "entrance fee" OR "day use" OR day-use OR fee OR fees OR prices OR rates OR pricing OR tarifa OR tarifs OR preise OR prezzi OR precios OR 料金 OR 요금 OR 收费 OR "$")`;
  const withRegion = region ? ` "${region}"` : "";
  return [
    `"${displayName}"${withRegion} ${core}`,
    `${displayName}${withRegion} ${core}`,
    `"${displayName}"${withRegion} (site:.gov OR site:.gov.* OR site:.govt.* OR site:.gouv.* OR site:.go.* OR site:.gob.*) ${core}`,
    `"${displayName}"${withRegion} (site:.org OR site:.com) (park OR parks OR "national park" OR "state park" OR parc OR parque OR reserve) ${core}`
  ];
}

function ok(payload) {
  return { statusCode: 200, headers: { "Content-Type":"application/json" }, body: JSON.stringify(payload) };
}

export async function handler(event) {
  if (event.httpMethod !== "POST") return ok({ error: "POST only" });
  const key = process.env.BRAVE_API_KEY;
  if (!key) return ok({ error: "Missing BRAVE_API_KEY" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  let { query, state = null, nameForMatch = null } = body;
  if (!query) return ok({ error: "Missing query" });

  // AllTrails support
  if (isAllTrailsUrl(query)) {
    const { parkName, region } = await extractParkFromAllTrails(query);
    if (parkName) nameForMatch = parkName;
    if (region && !state) state = region;
    if (!nameForMatch) {
      try {
        const u = new URL(query);
        const parts = u.pathname.split("/").filter(Boolean);
        nameForMatch = parts.at(-1)?.replace(/-/g, " ");
      } catch {}
    }
  }

  // If the query text itself includes a state, capture it
  if (!state) state = detectStateInString(query);

  const displayName = nameForMatch || query;
  const npsIntent = detectNpsIntent(displayName);

  // Region tokens & anti-wrong-state tokens
  let regionTokens = normalizeRegionTokens(state);
  let otherStateTokens = regionTokens.length ? otherUsStateTokens(regionTokens) : [];

  // Build initial query list
  let qList = buildQueries(displayName, regionTokens[1] || regionTokens[0] || null);

  try {
    const seenTop = [];
    let bestFallback = null;
    let inferredState = null;

    const tryBatch = async (queries, requireRegion = false) => {
      for (const q of queries) {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=20&country=US&search_lang=en`;
        const sr = await fetch(url, { headers: { "X-Subscription-Token": key, "Accept": "application/json" }});
        if (!sr.ok) continue;
        const data = await sr.json();
        let results = (data.web?.results || []).filter(r => r.url);

        // rank
        results.sort((a, b) =>
          scoreHost(b.url, displayName, query, npsIntent, regionTokens, otherStateTokens) -
          scoreHost(a.url, displayName, query, npsIntent, regionTokens, otherStateTokens)
        );

        seenTop.push(...results.slice(0, 10).map(r => r.url));

        // if region unknown, tally states that co-occur
        if (!regionTokens.length) {
          const counts = {};
          for (const r of results.slice(0, 12)) {
            const low = (r.title + " " + r.description + " " + r.url).toLowerCase();
            const found = detectStateInString(low);
            if (found) counts[found] = (counts[found] || 0) + 1;
          }
          const top = Object.entries(counts).sort((a,b) => b[1]-a[1])[0];
          if (top && top[1] >= 2) inferredState = top[0];
        }

        // scan pages
        let checks = 0;
        for (const r of results) {
          if (checks >= 20) break;
          let u; try { u = new URL(r.url); } catch { continue; }
          const host = u.hostname.toLowerCase();
          const path = u.pathname.toLowerCase();

          // coarse name relevance
          const nameMatch = Math.max(
            tokenSim(displayName, r.title || ""),
            tokenSim(displayName, (host + path))
          );
          if (nameMatch < 0.20) continue;
          checks++;

          const htmlRaw = await fetchText(r.url);
          const hay = `${r.title || ""}\n${r.description || ""}\n${r.url}\n${htmlRaw}`;
          const lower = hay.toLowerCase();

          // strict name-token gate
          if (!passesNameTokenGate(hay, displayName)) continue;

          // Region requirement
          if ((requireRegion || regionTokens.length) && regionTokens.length) {
            const inUrl = regionTokens.some(t => t && (host + path).includes(t));
            const inText = regionTokens.some(t => t && lower.includes(t));
            if (!inUrl && !inText) continue;
            if (otherStateTokens.some(t => t && (host + path).includes(t))) continue;
          }

          // Avoid unrelated NPS unit
          if ((host.endsWith("nps.gov") || host === "nps.gov") && path.includes("/planyourvisit/")) {
            const nm = (displayName || "").toLowerCase();
            const titleLower = (r.title || "").toLowerCase();
            const urlLower = r.url.toLowerCase();
            if (!(titleLower.includes(nm) || urlLower.includes(toSlug(displayName)) || tokenSim(nm, titleLower) >= 0.55)) {
              continue;
            }
          }

          const hasCurrency = CURRENCY_RX.test(hay);
          const hasEntrance = hasAny(lower, ENTRANCE_TERMS);
          const hasFeeWord  = hasAny(lower, FEE_TERMS);
          const hasNoFee    = hasAny(lower, NO_FEE_TERMS);

          if (!hasCurrency && hasNoFee && nearEachOther(lower, NO_FEE_TERMS, ENTRANCE_TERMS, 240)) {
            return { url: r.url, feeInfo: "No fee", kind: "no-fee" };
          }

          if ((hasCurrency && (hasEntrance || hasFeeWord)) || (hasFeeWord && looksLikeFeePath(path))) {
            const amt = extractAmount(hay);
            const feeInfo = amt ? amt : "Fee charged";
            return { url: r.url, feeInfo, kind: "general" };
          }

          if (!bestFallback && looksLikeFeePath(path)) {
            bestFallback = { url: r.url, feeInfo: "Not verified", kind: "not-verified" };
          }
        }
      }
      return null;
    };

    // Pass 1
    let found = await tryBatch(qList, false);

    // If we inferred a state and none provided, re-run strictly with it
    if (!found && inferredState && !regionTokens.length) {
      regionTokens = normalizeRegionTokens(inferredState);
      otherStateTokens = otherUsStateTokens(regionTokens);
      qList = buildQueries(displayName, regionTokens[1] || regionTokens[0]);
      found = await tryBatch(qList, true);
    }

    if (found) return ok(found);
    if (bestFallback) return ok({ ...bestFallback });
    return ok({ url: null, feeInfo: "Not verified", kind: "not-verified" });

  } catch (e) {
    return ok({ error: e.message || "Error" });
  }
}
