// Netlify Function: /api/search
// v20 — International: multilingual fee terms, global gov patterns, ccTLD boosts, slug match, stricter NPS matching.
// Requires: BRAVE_API_KEY set in Netlify environment vars.

/////////////////////////////
// Language-aware constants
/////////////////////////////

// Entrance/admission keywords in several languages (lowercase; keep short & unambiguous)
const ENTRANCE_TERMS = [
  // EN
  "entrance", "entry", "admission", "day-use", "day use", "access",
  // ES
  "entrada", "ingreso", "acceso",
  // FR
  "entrée", "entree", "accès", "acces",
  // DE
  "eintritt", "zugang",
  // IT
  "ingresso", "accesso", "biglietto",
  // PT
  "entrada", "acesso",
  // NL/Scandinavian
  "toegang", "adgang", "inträde", "inngang",
  // TR
  "giriş", "girış",
  // JA
  "入場", "入園", "料金",
  // ZH
  "门票", "門票", "票價", "票价", "收费", "收費",
  // KO
  "입장료", "요금",
];

// Generic fee/pay words (to pair with a currency or digits)
const FEE_TERMS = [
  // EN
  "fee", "fees", "price", "prices", "rate", "rates", "pass",
  "parking fee", "amenity fee", "day-use",
  // ES
  "tarifa", "tarifas", "precio", "precios", "pase",
  // FR
  "tarif", "tarifs", "prix", "pass",
  // DE
  "gebühr", "gebuehr", "gebühren", "preise",
  // IT
  "tariffa", "tariffe", "prezzo", "prezzi", "pass",
  // PT
  "taxa", "taxas", "preço", "preços", "passe",
  // Others short
  "料金", "요금", "收费", "收費", "цена", "цены"
];

// Negative “no fee” patterns
const NO_FEE_TERMS = [
  "no fee", "free", "free entry", "free admission", "no entrance fee", "no charge",
  // ES
  "gratis", "sin costo", "sin cargo",
  // FR
  "gratuit",
  // DE
  "kostenlos",
  // IT
  "gratuito",
  // PT
  "gratuito", "grátis", "sem custo",
  // ZH/JA/KO
  "免费", "免費", "무료", "無料"
];

// Currency symbols/patterns (many)
const CURRENCY_RX = /(\$|€|£|¥|₹|₩|₺|₽|₴|R\$|C\$|A\$|NZ\$|CHF|SEK|NOK|DKK|zł|Kč|Ft|₫|R|AED|SAR|₱|MXN|COP|PEN|S\/|CLP|ARS)\s?\d{1,3}([.,]\d{2})?/i;

/////////////////////////////
// Helpers
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

function nearEachOther(text, wordsA, wordsB, maxGap = 200) {
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
    /\/(admission|entrada|entree|eingang|ingresso|entrada)/i.test(path)
  );
}

function detectNpsIntent(q) {
  const s = (q || "").toLowerCase();
  return /\bnps\b|national park|national monument|national recreation area|national preserve/.test(s);
}

// Accept only if NPS unit matches query
function isSameNpsUnit(r, query) {
  const nm = (query || "").toLowerCase();
  const slug = toSlug(query || "");
  const titleLower = (r.title || "").toLowerCase();
  const urlLower = (r.url || "").toLowerCase();
  return (
    titleLower.includes(nm) ||
    urlLower.includes(slug) ||
    tokenSim(nm, titleLower) >= 0.55
  );
}

// Domain scoring: global “official-ish” boosts
function scoreHost(url, displayName = "", query = "", npsIntent = false) {
  let score = 0;
  let host = "", path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch { return -1; }

  // Global government patterns
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

  // Park-related hosts across TLDs
  const parkish = /(stateparks|nationalpark|national-?park|parks|parkandrec|recreation|recdept|dnr|naturalresources|natur|nature|reserva|reserve|parc|parque|parchi|parqueadero|gemeente|municipality|municipio|ayuntamiento|city|county)/.test(host);
  if (parkish) score += 28;

  // Fee-y paths
  if (looksLikeFeePath(path)) score += 30;

  // Similarity to query
  const sim = Math.max(
    tokenSim(displayName, host),
    tokenSim(displayName, path),
    tokenSim(displayName, query)
  );
  score += Math.round(sim * 30);

  // Penalize NPS when query looks like “State Park” etc.
  const qLower = (query || "").toLowerCase();
  const looksStateOrRegional = /state park|provincial park|regional park|city park|county park|parque estatal|parc national|parco/.test(qLower);
  if (!npsIntent && (host === "nps.gov" || host.endsWith(".nps.gov"))) {
    score -= 40;
    if (looksStateOrRegional) score -= 60;
  }

  // Slug signal
  const slug = toSlug(displayName || query);
  if (slug && path.includes(slug)) score += 25;

  return score;
}

function buildScope(countryOrStateCode) {
  // Don’t over-restrict: we’ll use scoring; scope just hints.
  const base = [
    "site:.gov", "site:.gov.*", "site:.govt.*", "site:.gouv.*", "site:.go.*", "site:.gob.*",
    "site:.us", "site:.uk", "site:.au", "site:.ca", "site:.nz", "site:.eu",
    "site:.org", "site:.com",
    "site:nps.gov", "site:fs.usda.gov", "site:blm.gov"
  ];
  if (countryOrStateCode) {
    const st = countryOrStateCode.toLowerCase();
    base.push(`site:.${st}`);
  }
  return "(" + base.join(" OR ") + ")";
}

function ok(payload) {
  return { statusCode: 200, headers: { "Content-Type":"application/json" }, body: JSON.stringify(payload) };
}

/////////////////////////////
// Main handler
/////////////////////////////

export async function handler(event) {
  if (event.httpMethod !== "POST") return ok({ error: "POST only" });

  const key = process.env.BRAVE_API_KEY;
  if (!key) return ok({ error: "Missing BRAVE_API_KEY" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const { query, state = null, nameForMatch = null } = body;
  if (!query) return ok({ error: "Missing query" });

  const displayName = nameForMatch || query;
  const npsIntent = detectNpsIntent(query);
  const scope = buildScope(state);

  // Broad, multilingual query variants
  const queries = [
    `${query} ${scope} (admission OR "entrance fee" OR entrada OR entrée OR eintritt OR ingresso OR tarifa OR tarif OR gebühr OR precio OR prix OR 料金 OR 요금 OR 收费 OR "$")`,
    `${query} ${scope} (fees OR prices OR rates OR pricing OR tarifas OR tarifs OR preise OR prezzi OR precios OR 料金 OR 요금 OR 收费)`,
    `${query} ${scope} (parking fee OR "day-use" OR "day use" OR estacionamiento OR aparcamiento OR estacionamiento pago OR "parcheggio" OR "料金" OR "요금")`
  ];

  try {
    let bestFallback = null;

    for (const q of queries) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=15&country=US&search_lang=en`;
      const sr = await fetch(url, { headers: { "X-Subscription-Token": key, "Accept": "application/json" }});
      if (!sr.ok) continue;
      const data = await sr.json();
      let results = (data.web?.results || []).filter(r => r.url);

      // Rank by global “official-ish” score
      results.sort((a, b) =>
        scoreHost(b.url, displayName, query, npsIntent) -
        scoreHost(a.url, displayName, query, npsIntent)
      );

      let checks = 0;
      let localFallback = null;

      for (const r of results) {
        if (checks >= 15) break;
        const u = new URL(r.url);
        const host = u.hostname.toLowerCase();
        const path = u.pathname.toLowerCase();

        // Require the result to look related by title or URL tokens
        const nameMatch = Math.max(
          tokenSim(displayName, r.title || ""),
          tokenSim(displayName, host + path)
        );
        if (nameMatch < 0.20) continue;
        checks++;

        const htmlRaw = await fetchText(r.url);
        const hay = `${r.title || ""}\n${r.snippet || ""}\n${htmlRaw}`;
        const lower = hay.toLowerCase();

        // Don’t accept unrelated NPS units
        if ((host.endsWith("nps.gov") || host === "nps.gov") && path.includes("/planyourvisit/")) {
          if (!isSameNpsUnit(r, displayName)) {
            continue;
          }
        }

        // Strong signals:
        const hasCurrency = CURRENCY_RX.test(hay);
        const hasEntrance = hasAny(lower, ENTRANCE_TERMS);
        const hasFeeWord  = hasAny(lower, FEE_TERMS);
        const hasNoFee    = hasAny(lower, NO_FEE_TERMS);

        // Accept: explicit “no fee” near entrance/admission words
        if (!hasCurrency && hasNoFee && nearEachOther(lower, NO_FEE_TERMS, ENTRANCE_TERMS, 220)) {
          return ok({ url: r.url, feeInfo: "No fee", kind: "no-fee" });
        }

        // Accept: fees present (currency + entrance/fee words)
        if ((hasCurrency && (hasEntrance || hasFeeWord)) || (hasFeeWord && looksLikeFeePath(path))) {
          const amt = extractAmount(hay);
          const feeInfo = amt ? (amt.includes("per") ? amt : amt) : "Fee charged";
          return ok({ url: r.url, feeInfo, kind: "general" });
        }

        // Prefer a decent fallback (slug in path or fee-looking path)
        const slug = toSlug(displayName);
        if (!localFallback && (looksLikeFeePath(path) || (slug && path.includes(slug)))) {
          localFallback = r;
        }
      }

      if (localFallback && !bestFallback) {
        bestFallback = { url: localFallback.url, feeInfo: "Not verified", kind: "not-verified" };
      }
    }

    if (bestFallback) return ok(bestFallback);
    return ok({ url: null, feeInfo: "Not verified", kind: "not-verified" });

  } catch (e) {
    return ok({ error: e.message || "Error" });
  }
}
