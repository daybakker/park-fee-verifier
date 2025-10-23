// netlify/functions/search.js
// v40 — aggressive per-entity search, exact de-dupe done in frontend
// - Multiple query variants (fees/admission/day-use/parking)
// - Prioritize official gov domains; allow .org/.com park-ish
// - Fetch & scan pages for currency + fee words; detect “no fee”
// - Homepage fallback (so you always get a source)
// - AllTrails URL -> extract managing area / region from page JSON
//
// Required: BRAVE_API_KEY in Netlify env

/* --------------------------- Tunables --------------------------- */
const BRAVE_COUNT = 22;          // results to fetch per query variant
const MAX_QUERIES = 6;           // hard cap variants per entity
const PAGE_CHAR_LIMIT = 900000;  // to avoid memory explosion
const TEXT_NEAR_GAP = 280;       // max chars between “admission/fee” and amounts
const TIMEOUT_MS = 12000;        // fetch timeout per HTTP request

/* ------------------------- Regex / Terms ------------------------ */
const CURRENCY_RX = /(\$|€|£|¥|₹|₩|₺|₽|₴|R\$|C\$|A\$|NZ\$|CHF|SEK|NOK|DKK|zł|Kč|Ft|₫|R|AED|SAR|₱|MXN|COP|PEN|S\/|CLP|ARS)\s?\d{1,3}(?:[.,]\d{2})?/i;

const ENTRANCE_TERMS = [
  "entrance","entry","admission","tickets","ticket","day-use","day use","access","pass","passes","permit",
  "料金","入場","入園","門票","票价","票價","收费","收費","요금","입장",
  "prix","tarif","tarifs","billetterie",
  "precio","precios","tarifa","tarifas",
  "preço","preços","taxa","ingresso","ingressi",
  "prezzi","preise","gebühren"
];
const FEE_TERMS = [
  "fee","fees","price","prices","rate","rates","pricing","parking fee","parking rates",
  ...ENTRANCE_TERMS
];
const NO_FEE_TERMS = [
  "no fee","free entry","free admission","no charge","no cost","gratis",
  "sin costo","sin cargo","gratuit","kostenlos","gratuito","grátis","sem custo",
  "免费","免費","無料","무료"
];

/* ----------------------- Utilities / helpers -------------------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function toSlug(s=""){
  return s.toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g,"")
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/^-+|-+$/g,"");
}
function tokenSim(a,b){
  const norm = s => (s||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim();
  const A = new Set(norm(a).split(" ").filter(Boolean));
  const B = new Set(norm(b).split(" ").filter(Boolean));
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  const denom = A.size + B.size - inter || 1;
  return inter / denom;
}
function hasAny(h,arr){ const t=h.toLowerCase(); return arr.some(k => t.includes(k)); }
function nearEachOther(t,groupA,groupB,maxGap=TEXT_NEAR_GAP){
  t = t.toLowerCase();
  for (const a of groupA){
    const ia = t.indexOf(a); if (ia===-1) continue;
    for (const b of groupB){
      const ib = t.indexOf(b); if (ib===-1) continue;
      if (Math.abs(ia-ib) <= maxGap) return true;
    }
  }
  return false;
}
function extractAmount(t){
  const m = t.match(CURRENCY_RX);
  return m ? m[0].replace(/\s+/g, " ") : null;
}
function abortableFetch(url, opts={}){
  const c = new AbortController();
  const id = setTimeout(()=>c.abort(), TIMEOUT_MS);
  return fetch(url, { ...opts, signal: c.signal }).finally(()=>clearTimeout(id));
}
async function fetchText(url){
  try{
    const r = await abortableFetch(url, { redirect: "follow" });
    if (!r.ok) return "";
    return (await r.text()).slice(0, PAGE_CHAR_LIMIT);
  }catch{
    return "";
  }
}

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
  ["VA","Virginia"],["WA","Washington"],["WV","West Virginia"],["WI","Wisconsin"],["WY","Wyoming"],["DC","District of Columbia"]
];
const STATE_NAME_TO_ABBR = Object.fromEntries(US_STATES.map(([a,n]) => [n.toLowerCase(), a]));

function detectStateInString(s){
  if(!s) return null;
  const low = s.toLowerCase();
  for (const [abbr,name] of US_STATES){
    if (low.includes(name.toLowerCase()) || low.match(new RegExp(`\\b${abbr.toLowerCase()}\\b`))) return name;
  }
  return null;
}
function guessStateFromAllTrailsUrl(u){
  try{
    const url = new URL(u);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0]==="trail" && parts[1]==="us" && parts[2]){
      const n = parts[2].replace(/-/g," ").toLowerCase();
      const ab = STATE_NAME_TO_ABBR[n];
      if (ab) return US_STATES.find(([a]) => a===ab)[1];
      return n.replace(/\b\w/g, c => c.toUpperCase());
    }
  }catch{}
  return null;
}
function detectNpsIntent(q){
  q = (q||"").toLowerCase();
  return /\bnps\b|national park|national monument|national recreation area|national preserve/.test(q);
}
function looksLikeFeePath(p){
  return (/\/fees?(\/|\.|$)/i.test(p)
    || /\/(planyourvisit|visit|prices|pricing|tarif|tarifa|preise|料金|요금|收费)/i.test(p)
    || /\/(admission|tickets|entrada|entree|eingang|ingresso)/i.test(p));
}
function passesNameTokenGate(hay,displayName){
  const t = hay.toLowerCase();
  const toks = (displayName||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(x => x.length>=3);
  if (!toks.length) return true;
  const need = Math.min(3, toks.length);
  let hit = 0; for (const k of toks) if (t.includes(k)) hit++;
  return hit >= need;
}
function isAllTrailsUrl(s){ try{ return new URL(s).hostname.includes("alltrails.com"); } catch { return false; } }

async function fetchAllTrailsPark(url){
  const html = await fetchText(url);
  if(!html) return {parkName:null,region:null};
  const collect=(obj,out=new Set())=>{
    if(!obj) return out;
    if(Array.isArray(obj)){ obj.forEach(v=>collect(v,out)); return out; }
    if(typeof obj==="object"){
      for(const[k,v] of Object.entries(obj)){
        if(k==="name" && typeof v==="string" && v.length<=160) out.add(v);
        if(typeof v==="string" && /park|forest|preserve|reserve|recreation|national|state|zoo|museum/i.test(v) && v.length<=200) out.add(v);
        collect(v,out);
      }
    }
    return out;
  };
  const next=html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if(next){ try{
    const data=JSON.parse(next[1]);
    const names=collect(data);
    const pick=[...names].sort((a,b)=> b.length-a.length)[0]||null;
    const region = detectStateInString(JSON.stringify(data)) || guessStateFromAllTrailsUrl(url) || detectStateInString(html) || null;
    if(pick) return {parkName:pick,region};
  }catch{} }
  const re=/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m; const names=new Set();
  while((m=re.exec(html))!==null){ try{ collect(JSON.parse(m[1]), names); }catch{} }
  if(names.size){
    const best=[...names].sort((a,b)=>b.length-a.length)[0];
    const region=guessStateFromAllTrailsUrl(url)||detectStateInString(html)||null;
    return {parkName:best,region};
  }
  const title=(html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]||"").replace(/\s+\|.*$/,"").trim();
  if(title){ return {parkName:title,region:guessStateFromAllTrailsUrl(url)||detectStateInString(html)||null}; }
  return {parkName:null,region:guessStateFromAllTrailsUrl(url)||detectStateInString(html)||null};
}

/* -------------------------- Ranking & Queries --------------------------- */
function scoreCandidate(url, displayName, originalQuery, npsIntent, region){
  let score=0,host="",path="";
  try{ const u=new URL(url); host=u.hostname.toLowerCase(); path=u.pathname.toLowerCase(); }catch{ return -1; }

  // official bumps
  const isGov = /\.gov(\.[a-z]{2})?$/.test(host) || /\.govt\.[a-z]{2}$/.test(host) || /\.gouv\.[a-z]{2}$/.test(host) || /\.gob\.[a-z]{2}$/.test(host) || /\.go\.[a-z]{2}$/.test(host);
  const isNps = (host==="nps.gov"||host.endsWith(".nps.gov"));
  const isUsda= (host==="fs.usda.gov"||host.endsWith(".fs.usda.gov")||host.endsWith(".usda.gov"));
  const isBlm = (host==="blm.gov"||host.endsWith(".blm.gov"));

  if(isGov) score+=85;
  if(isNps) score+=(npsIntent?95:30);
  if(isUsda||isBlm) score+=70;

  // partner/official vendor/org/com commonly used by agencies
  if(/\.(org|com)$/i.test(host) && /(stateparks|parks|park|recreation|rec|dnr|natural|nature|preserve|reserve|conservancy|trust|audubon|museum|zoo|wildlife|county|city)/.test(host)) {
    score+=48;
  }

  if(looksLikeFeePath(path)) score+=30;
  if(region && (host+path).includes(region.toLowerCase())) score+=20;

  const sim = Math.max(tokenSim(displayName, host), tokenSim(displayName, path), tokenSim(displayName, originalQuery));
  score += Math.round(sim*34);

  const slug = toSlug(displayName||originalQuery);
  if(slug && path.includes(slug)) score+=15;

  return score;
}

function buildVariants(name, region){
  const base = `"${name}"${region?` "${region}"`:""}`;
  const core = `(admission OR tickets OR "entrance fee" OR fee OR fees OR prices OR rates OR pricing OR pass OR "day-use" OR parking)`;
  const list = [
    `${base} ${core} site:.gov`,
    `${base} ${core} (site:.gov OR site:.nps.gov OR site:.fs.usda.gov OR site:.blm.gov)`,
    `${base} ${core} (site:.gov OR site:.org)`,
    `${base} ${core} (site:.gov OR site:.org OR site:.com)`,
    `${base} (fees OR admission OR tickets) (site:.org OR site:.com)`,
    `${base} ${core}` // last super-wide
  ];
  return list.slice(0, MAX_QUERIES);
}

function buildHomepageVariants(name, region){
  const base = `"${name}"${region?` "${region}"`:""}`;
  return [
    `${base} (official OR homepage OR "plan your visit" OR visit OR park) (site:.gov OR site:.org OR site:.com)`,
    `${base} (site:.gov OR site:.org OR site:.com)`
  ];
}

/* ---------------------------- Main Handler ----------------------------- */
function ok(body){
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export async function handler(event){
  if(event.httpMethod!=="POST") return ok({error:"POST only"});
  const key = process.env.BRAVE_API_KEY;
  if(!key) return ok({error:"Missing BRAVE_API_KEY"});

  let body={}; try{ body=JSON.parse(event.body||"{}"); }catch{}
  let { query, state=null, nameForMatch=null, lenient=false, wantHomepage=true } = body;
  if(!query) return ok({error:"Missing query"});

  // AllTrails pre-processing
  if(isAllTrailsUrl(query)){
    const {parkName,region} = await fetchAllTrailsPark(query);
    if(parkName) nameForMatch = parkName;
    if(region && !state) state = region;
  }
  if(!state) state = detectStateInString(query);

  const displayName = nameForMatch || query;
  const npsIntent = detectNpsIntent(displayName);
  const region = state || null;

  const searchBrave = async (q) => {
    // backoff helper on 429
    for (let attempt=0; attempt<2; attempt++){
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${BRAVE_COUNT}&country=US&search_lang=en`;
      const res = await abortableFetch(url, { headers: { "X-Subscription-Token": key, "Accept": "application/json" } });
      if (res.status === 429) { await sleep(500); continue; }
      if (!res.ok) return [];
      const data = await res.json();
      return (data.web?.results || []).filter(r => r.url && (r.title || r.description));
    }
    return [];
  };

  const examine = async (r) => {
    let u; try{ u = new URL(r.url); }catch{ return null; }
    const host = u.hostname.toLowerCase(); const path = u.pathname.toLowerCase();
    const raw = await fetchText(r.url);
    if (!raw) return null;
    const hay = ((r.title||"")+"\n"+(r.description||"")+"\n"+r.url+"\n"+raw);

    // Require some displayName tokens present to avoid random matches
    if (!passesNameTokenGate(hay, displayName)) return null;

    const lower = hay.toLowerCase();
    const hasCur = CURRENCY_RX.test(hay);
    const hasEnt = hasAny(lower, ENTRANCE_TERMS);
    const hasFee = hasAny(lower, FEE_TERMS);
    const hasNo  = hasAny(lower, NO_FEE_TERMS);

    // Explicit "no fee" near entrance/admission words
    if (!hasCur && hasNo && nearEachOther(lower, NO_FEE_TERMS, ENTRANCE_TERMS, TEXT_NEAR_GAP)) {
      return { url: r.url, feeInfo: "No fee", kind: "no-fee" };
    }

    // General/parking if currency plus fee words OR fee-like path present
    if ((hasCur && (hasEnt || hasFee)) || looksLikeFeePath(path)) {
      const amt = extractAmount(hay);
      // crude parking classifier
      if (/(parking|car park|estacionamiento|aparcamiento)/i.test(lower) && /fee|fees|rate|rates|precio|tarifa|prix|料金|요금|收费/i.test(lower)) {
        return { url: r.url, feeInfo: amt || "Parking fee", kind: "parking" };
      }
      return { url: r.url, feeInfo: amt || "Fee charged", kind: "general" };
    }

    return null;
  };

  try {
    // PASS A: fee-focused variants
    const variants = buildVariants(displayName, region);
    for (const q of variants){
      const results = await searchBrave(q);
      // Rank by host quality & similarity
      results.sort((a,b)=>scoreCandidate(b.url, displayName, query, npsIntent, region) - scoreCandidate(a.url, displayName, query, npsIntent, region));
      for (const r of results.slice(0, BRAVE_COUNT)){
        const found = await examine(r);
        if (found) return ok(found);
      }
    }

    // PASS B: if lenient requested from client, cast wider once more
    if (lenient) {
      const wide = [
        `"${displayName}" (fees OR admission OR tickets OR pass OR parking) (site:.gov OR site:.org OR site:.com)`,
        `${displayName} fees admission prices rates (site:.gov OR site:.org OR site:.com)`,
        `${displayName} "plan your visit" fees (site:.gov OR site:.org OR site:.com)`
      ];
      for (const q of wide){
        const results = await searchBrave(q);
        results.sort((a,b)=>scoreCandidate(b.url, displayName, query, npsIntent, region) - scoreCandidate(a.url, displayName, query, npsIntent, region));
        for (const r of results.slice(0, BRAVE_COUNT)){
          const found = await examine(r);
          if (found) return ok(found);
        }
      }
    }

    // PASS C: homepage fallback (always if wantHomepage)
    if (wantHomepage) {
      const hqs = buildHomepageVariants(displayName, region);
      for (const q of hqs){
        const results = await searchBrave(q);
        results.sort((a,b)=>scoreCandidate(b.url, displayName, query, npsIntent, region) - scoreCandidate(a.url, displayName, query, npsIntent, region));
        for (const r of results.slice(0, BRAVE_COUNT-5)){
          const raw = await fetchText(r.url);
          const hay = (r.title||"")+" "+(r.description||"")+" "+r.url+" "+raw;
          if (!passesNameTokenGate(hay, displayName)) continue;
          return ok({ url: null, homepage: r.url, feeInfo: "Not verified", kind: "homepage" });
        }
      }
    }

    return ok({ url: null, homepage: null, feeInfo: "Not verified", kind: "not-verified" });
  } catch (e) {
    return ok({ error: e.message || "Error" });
  }
}
