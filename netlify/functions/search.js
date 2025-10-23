// Netlify Function: /api/search
// v21 — International wide-search + debug: returns topUrls when not verified
// Needs Netlify env: BRAVE_API_KEY

/////////////////////////////
// Multilingual signals
/////////////////////////////
const ENTRANCE_TERMS = [
  "entrance","entry","admission","day-use","day use","access",
  "entrada","ingreso","acceso",
  "entrée","entree","accès","acces",
  "eintritt","zugang",
  "ingresso","accesso","biglietto",
  "entrada","acesso", // PT
  "toegang","adgang","inträde","inngang",
  "giriş","girış",
  "入場","入園","料金",
  "门票","門票","票價","票价","收费","收費",
  "입장료","요금"
];

const FEE_TERMS = [
  // EN
  "fee","fees","price","prices","rate","rates","pricing","pass","day-use","parking fee",
  // ES
  "tarifa","tarifas","precio","precios","pase",
  // FR
  "tarif","tarifs","prix","pass",
  // DE
  "gebühr","gebuehr","gebühren","preise",
  // IT
  "tariffa","tariffe","prezzo","prezzi","pass",
  // PT
  "taxa","taxas","preço","preços","passe",
  // Others
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

// Currency patterns (many)
const CURRENCY_RX = /(\$|€|£|¥|₹|₩|₺|₽|₴|R\$|C\$|A\$|NZ\$|CHF|SEK|NOK|DKK|zł|Kč|Ft|₫|R|AED|SAR|₱|MXN|COP|PEN|S\/|CLP|ARS)\s?\d{1,3}(?:[.,]\d{2})?/i;

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
    // cap to keep memory safe
    return (await r.text()).slice(0, 900000);
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
function scoreHost(url, displayName = "", query = "", npsIntent = false) {
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

  const parkish = /(stateparks|nationalpark|national-?park|parks|parkandrec|recreation|recdept|dnr|naturalresources|natur|nature|reserva|reserve|parc|parque|parchi|gemeente|municipality|municipio|ayuntamiento|city|county|regionalpark|provincialpark)/.test(host);
  if (parkish) score += 28;

  if (looksLikeFeePath(path)) score += 30;

  const sim = Math.max(
    tokenSim(displayName, host),
    tokenSim(displayName, path),
    tokenSim(displayName, query)
  );
  score += Math.round(sim * 30);

  const qLower = (query || "").toLowerCase();
  const looksStateOrRegional = /state park|provincial park|regional park|city park|county park|parque estatal|provincial|regional/.test(qLower);
  if (!npsIntent && (host === "nps.gov" || host.endsWith(".nps.gov"))) {
    score -= 40;
    if (looksStateOrRegional) score -= 60;
  }

  const slug = toSlug(displayName || query);
  if (slug && path.includes(slug)) score += 25;

  return score;
}

function ok(payload) {
  return { statusCode: 200, headers: { "Content-Type":"application/json" }, body: JSON.stringify(payload) };
}

/////////////////////////////
// Main
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

  // VERY BROAD query set (scoped and unscoped)
  const baseTerms = `(admission OR "entrance fee" OR "day use" OR day-use OR fee OR fees OR prices OR rates OR pricing OR tarifa OR tarifs OR preise OR prezzi OR precios OR 料金 OR 요금 OR 收费 OR "$")`;
  const queries = [
    `${query} ${baseTerms}`,                 // unscoped wide
    `"${query}" ${baseTerms}`,              // exact name + wide
    `${query} (site:.gov OR site:.gov.* OR site:.govt.* OR site:.gouv.* OR site:.go.* OR site:.gob.*) ${baseTerms}`, // global gov-ish
    `${query} (site:.org OR site:.com) (park OR parks OR "national park" OR "state park" OR parc OR parque OR reserve) ${baseTerms}` // park org/com
  ];

  try {
    let bestFallback = null;
    const seenTop = []; // debug: collect top URLs

    for (const q of queries) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=20&country=US&search_lang=en`;
      const sr = await fetch(url, { headers: { "X-Subscription-Token": key, "Accept": "application/json" }});
      if (!sr.ok) continue;
      const data = await sr.json();
      let results = (data.web?.results || []).filter(r => r.url);

      // rank results
      results.sort((a, b) =>
        scoreHost(b.url, displayName, query, npsIntent) -
        scoreHost(a.url, displayName, query, npsIntent)
      );

      // collect top 10 for debugging
      seenTop.push(...results.slice(0, 10).map(r => r.url));

      let checks = 0;
      let localFallback = null;

      for (const r of results) {
        if (checks >= 20) break;
        const u = new URL(r.url);
        const host = u.hostname.toLowerCase();
        const path = u.pathname.toLowerCase();

        // coarse relevance
        const nameMatch = Math.max(
          tokenSim(displayName, r.title || ""),
          tokenSim(displayName, host + path)
        );
        if (nameMatch < 0.20) continue;
        checks++;

        const htmlRaw = await fetchText(r.url);
        const hay = `${r.title || ""}\n${r.snippet || ""}\n${htmlRaw}`;
        const lower = hay.toLowerCase();

        // reject unrelated NPS units
        if ((host.endsWith("nps.gov") || host === "nps.gov") && path.includes("/planyourvisit/")) {
          if (!isSameNpsUnit(r, displayName)) {
            continue;
          }
        }

        const hasCurrency = CURRENCY_RX.test(hay);
        const hasEntrance = hasAny(lower, ENTRANCE_TERMS);
        const hasFeeWord  = hasAny(lower, FEE_TERMS);
        const hasNoFee    = hasAny(lower, NO_FEE_TERMS);

        // explicit free near entrance
        if (!hasCurrency && hasNoFee && nearEachOther(lower, NO_FEE_TERMS, ENTRANCE_TERMS, 240)) {
          return ok({ url: r.url, feeInfo: "No fee", kind: "no-fee" });
        }

        // fee detection
        if ((hasCurrency && (hasEntrance || hasFeeWord)) || (hasFeeWord && looksLikeFeePath(path))) {
          const amt = extractAmount(hay);
          const feeInfo = amt ? amt : "Fee charged";
          return ok({ url: r.url, feeInfo, kind: "general" });
        }

        // reasonable fallback candidate
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
      // include debug list so we can see what Brave returned
      return ok({ ...bestFallback, debugTopUrls: [...new Set(seenTop)].slice(0, 10) });
    }

    return ok({ url: null, feeInfo: "Not verified", kind: "not-verified", debugTopUrls: [] });

  } catch (e) {
    return ok({ error: e.message || "Error" });
  }
}
