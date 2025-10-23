// netlify/functions/search.js
// v31 — ultra-lenient search + guaranteed homepage fallback + better AllTrails parsing

const CURRENCY_RX = /(\$|€|£|¥|₹|₩|₺|₽|₴|R\$|C\$|A\$|NZ\$|CHF|SEK|NOK|DKK|zł|Kč|Ft|₫|R|AED|SAR|₱|MXN|COP|PEN|S\/|CLP|ARS)\s?\d{1,3}(?:[.,]\d{2})?/i;

const ENTRANCE_TERMS = [
  "entrance","entry","admission","tickets","ticket","day-use","day use","access","pass","passes","permit",
  "料金","入場","入園","門票","票价","票價","收费","收費","요금","입장","prix","tarif","tarifs","billetterie",
  "precio","precios","tarifa","tarifas","preço","preços","taxa","ingresso","ingressi","prezzi","preise","gebühren"
];
const FEE_TERMS = [
  "fee","fees","price","prices","rate","rates","pricing","parking fee","parking rates",
  ...ENTRANCE_TERMS
];
const NO_FEE_TERMS = [
  "no fee","free entry","free admission","no charge","no cost","gratis",
  "sin costo","sin cargo","gratuit","kostenlos","gratuito","grátis","sem custo","免费","免費","無料","무료"
];

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

function toSlug(s=""){return s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");}
function tokenSim(a,b){const n=s=>(s||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim();const A=new Set(n(a).split(" ").filter(Boolean));const B=new Set(n(b).split(" ").filter(Boolean));const inter=[...A].filter(x=>B.has(x)).length;return (2*inter)/Math.max(1,A.size+B.size);}
function hasAny(h,arr){const t=h.toLowerCase();return arr.some(k=>t.includes(k));}
function nearEachOther(t,groupA,groupB,maxGap=260){t=t.toLowerCase();for(const a of groupA){const ia=t.indexOf(a);if(ia===-1)continue;for(const b of groupB){const ib=t.indexOf(b);if(ib===-1)continue;if(Math.abs(ia-ib)<=maxGap)return true;}}return false;}
function extractAmount(t){const m=t.match(CURRENCY_RX);return m?m[0].replace(/\s+/g," "):null;}
async function fetchText(url){try{const r=await fetch(url,{redirect:"follow"});if(!r.ok)return"";return(await r.text()).slice(0,900000);}catch{return"";}}

const STATE_NAME_TO_ABBR = Object.fromEntries(US_STATES.map(([a,n]) => [n.toLowerCase(), a]));

function detectStateInString(s){ if(!s) return null; const low=s.toLowerCase(); for (const [abbr,name] of US_STATES){ if(low.includes(name.toLowerCase())||low.match(new RegExp(`\\b${abbr.toLowerCase()}\\b`))) return name; } return null; }
function guessStateFromAllTrailsUrl(u){ try{ const url=new URL(u); const parts=url.pathname.split("/").filter(Boolean); if(parts[0]==="trail"&&parts[1]==="us"&&parts[2]){ const n=parts[2].replace(/-/g," ").toLowerCase(); const ab=STATE_NAME_TO_ABBR[n]; if(ab) return US_STATES.find(([a])=>a===ab)[1]; return n.replace(/\b\w/g,c=>c.toUpperCase()); } }catch{} return null; }

function detectNpsIntent(q){ q=(q||"").toLowerCase(); return /\bnps\b|national park|national monument|national recreation area|national preserve/.test(q); }
function looksLikeFeePath(p){return (/\/fees?(\/|\.|$)/i.test(p)||/\/(planyourvisit|visit|prices|pricing|tarif|tarifa|preise|料金|요금|收费)/i.test(p)||/\/(admission|tickets|entrada|entree|eingang|ingresso)/i.test(p));}
function passesNameTokenGate(hay,displayName){ const t=hay.toLowerCase(); const toks=(displayName||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(x=>x.length>=3); if(!toks.length) return true; const need=Math.min(3,toks.length); let hit=0; for(const k of toks) if(t.includes(k)) hit++; return hit>=need; }

function isAllTrailsUrl(s){ try{ return new URL(s).hostname.includes("alltrails.com"); } catch { return false; } }

async function fetchAllTrailsPark(url){
  const html=await fetchText(url);
  if(!html) return {parkName:null,region:null};
  const collect=(obj,out=new Set())=>{
    if(!obj) return out;
    if(Array.isArray(obj)){obj.forEach(v=>collect(v,out));return out;}
    if(typeof obj==="object"){
      for(const[k,v] of Object.entries(obj)){
        if(k==="name" && typeof v==="string" && v.length<=160) out.add(v);
        if(typeof v==="string" && /park|forest|preserve|reserve|recreation|national|state|zoo|museum/i.test(v) && v.length<=200) out.add(v);
        collect(v,out);
      }
    }
    return out;
  };
  // __NEXT_DATA__
  const next=html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if(next){ try{
    const data=JSON.parse(next[1]);
    const names=collect(data);
    const pick=[...names].sort((a,b)=> b.length-a.length)[0]||null;
    const region=detectStateInString(JSON.stringify(data))||guessStateFromAllTrailsUrl(url)||detectStateInString(html)||null;
    if(pick) return {parkName:pick,region};
  }catch{} }
  // ld+json
  const re=/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m; const names=new Set();
  while((m=re.exec(html))!==null){ try{ collect(JSON.parse(m[1]), names); }catch{} }
  if(names.size){
    const best=[...names].sort((a,b)=>b.length-a.length)[0];
    const region=guessStateFromAllTrailsUrl(url)||detectStateInString(html)||null;
    return {parkName:best,region};
  }
  // <meta> description/title fallback
  const title=(html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]||"").replace(/\s+\|.*$/,"").trim();
  if(title){ return {parkName:title,region:guessStateFromAllTrailsUrl(url)||detectStateInString(html)||null}; }
  return {parkName:null,region:guessStateFromAllTrailsUrl(url)||detectStateInString(html)||null};
}

function scoreHost(url,displayName,query,npsIntent,region){
  let score=0,host="",path="";
  try{const u=new URL(url);host=u.hostname.toLowerCase();path=u.pathname.toLowerCase();}catch{return -1;}

  // domain quality
  const isGov = /\.gov(\.[a-z]{2})?$/.test(host) || /\.govt\.[a-z]{2}$/.test(host) || /\.gouv\.[a-z]{2}$/.test(host) || /\.gob\.[a-z]{2}$/.test(host) || /\.go\.[a-z]{2}$/.test(host);
  const isNps = (host==="nps.gov"||host.endsWith(".nps.gov"));
  const isUsda= (host==="fs.usda.gov"||host.endsWith(".fs.usda.gov")||host.endsWith(".usda.gov"));
  const isBlm = (host==="blm.gov"||host.endsWith(".blm.gov"));

  if(isGov) score+=80;
  if(isNps) score+=(npsIntent?90:20);
  if(isUsda||isBlm) score+=60;

  // park-ish orgs: .org/.com widely used by official partners & state/county vendors
  if(/\.(org|com)$/i.test(host) && /(stateparks|parks|park|recreation|rec|dnr|natural|nature|preserve|reserve|conservancy|trust|audubon|museum|zoo|wildlife)/.test(host)) {
    score+=45; // big bump (this is the “looser” part)
  }

  if(looksLikeFeePath(path)) score+=28;
  if(region && (host+path).includes(region.toLowerCase())) score+=22;

  // name similarity & slug
  const sim=Math.max(tokenSim(displayName,host), tokenSim(displayName,path), tokenSim(displayName,query));
  score+=Math.round(sim*32);
  const slug=toSlug(displayName||query);
  if(slug && path.includes(slug)) score+=18;

  return score;
}

function buildQueryVariants(name, region){
  const base = `"${name}"${region?` "${region}"`:""}`;
  const core = `(admission OR tickets OR "entrance fee" OR fee OR fees OR prices OR rates OR pricing OR pass OR "day-use" OR parking)`;
  return [
    `${base} ${core}`,
    `${base} (site:.gov OR site:.gov.* OR site:.gouv.* OR site:.go.*) ${core}`,
    `${base} (site:.org OR site:.com) (park OR state park OR national park OR nature preserve OR conservancy OR trust OR recreation) ${core}`,
    // super wide
    `${base} ${core} (site:.gov OR site:.org OR site:.com)`
  ];
}

function buildHomepageQueries(name, region){
  const base = `"${name}"${region?` "${region}"`:""}`;
  return [
    `${base} (official OR homepage OR "plan your visit" OR visit OR park) (site:.gov OR site:.org OR site:.com)`,
    `${base} (site:.gov OR site:.org OR site:.com)`
  ];
}

function ok(body){
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export async function handler(event){
  if(event.httpMethod!=="POST") return ok({error:"POST only"});
  const key=process.env.BRAVE_API_KEY;
  if(!key) return ok({error:"Missing BRAVE_API_KEY"});

  let body={}; try{body=JSON.parse(event.body||"{}");}catch{}
  let {query, state=null, nameForMatch=null, lenient=false, wantHomepage=false}=body;
  if(!query) return ok({error:"Missing query"});

  // AllTrails pre-processing
  if(isAllTrailsUrl(query)){
    const {parkName,region}=await fetchAllTrailsPark(query);
    if(parkName) nameForMatch=parkName;
    if(region && !state) state=region;
  }
  if(!state) state=detectStateInString(query);

  const displayName=nameForMatch||query;
  const npsIntent=detectNpsIntent(displayName);
  const region = state || null;

  const searchBrave = async (q) => {
    const url=`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=20&country=US&search_lang=en`;
    const res=await fetch(url,{headers:{"X-Subscription-Token":key,"Accept":"application/json"}});
    if(!res.ok) return [];
    const data=await res.json();
    return (data.web?.results||[]).filter(r=>r.url && (r.title||r.description));
  };

  const examine = async (r) => {
    let u; try{u=new URL(r.url);}catch{return null;}
    const host=u.hostname.toLowerCase(); const path=u.pathname.toLowerCase();
    const raw=await fetchText(r.url);
    if(!raw) return null;
    const hay=(r.title||"")+"\n"+(r.description||"")+"\n"+r.url+"\n"+raw;
    if(!passesNameTokenGate(hay,displayName)) return null;

    const lower=hay.toLowerCase();
    const hasCur = CURRENCY_RX.test(hay);
    const hasEnt = hasAny(lower, ENTRANCE_TERMS);
    const hasFee = hasAny(lower, FEE_TERMS);
    const hasNo  = hasAny(lower, NO_FEE_TERMS);

    // prefer explicit no-fee near entrance/admission
    if(!hasCur && hasNo && nearEachOther(lower, NO_FEE_TERMS, ENTRANCE_TERMS, 300)) {
      return { url: r.url, feeInfo: "No fee", kind: "no-fee" };
    }

    // general or parking fee if we have currency + fee/admission words OR fee-ish path
    if ((hasCur && (hasEnt || hasFee)) || looksLikeFeePath(path)) {
      const amt = extractAmount(hay);
      const info = amt ? amt : "Fee charged";
      // crude parking detect
      if (/(parking|car park|estacionamiento|aparcamiento)/i.test(lower) && /fee|fees|rate|rates|precio|tarifa|prix|料金|요금|收费/i.test(lower)) {
        return { url: r.url, feeInfo: amt || "Parking fee", kind: "parking" };
      }
      return { url: r.url, feeInfo: info, kind: "general" };
    }

    return null;
  };

  try {
    // ----- PASS 1: fee-specific queries -----
    const q1 = buildQueryVariants(displayName, region);
    for (const q of q1) {
      const results = await searchBrave(q);
      // rank
      results.sort((a,b)=>scoreHost(b.url,displayName,query,npsIntent,region)-scoreHost(a.url,displayName,query,npsIntent,region));
      // scan top 22
      for (const r of results.slice(0,22)) {
        const found = await examine(r);
        if (found) return ok(found);
      }
    }

    // ----- PASS 2: SUPER LENIENT (when lenient requested) -----
    if (lenient) {
      const wide = [
        `"${displayName}" (fees OR admission OR tickets OR pass OR parking) (site:.gov OR site:.org OR site:.com)`,
        `${displayName} fees admission prices rates (site:.gov OR site:.org OR site:.com)`,
        `${displayName} "plan your visit" fees (site:.gov OR site:.org OR site:.com)`
      ];
      for (const q of wide) {
        const results = await searchBrave(q);
        results.sort((a,b)=>scoreHost(b.url,displayName,query,npsIntent,region)-scoreHost(a.url,displayName,query,npsIntent,region));
        for (const r of results.slice(0,22)) {
          const found = await examine(r);
          if (found) return ok(found);
        }
      }
    }

    // ----- PASS 3: HOMEPAGE FALLBACK (ALWAYS run if wantHomepage) -----
    if (wantHomepage) {
      const hqs = buildHomepageQueries(displayName, region);
      for (const q of hqs) {
        const results = await searchBrave(q);
        // rank for "official-ish" even without fee words
        results.sort((a,b)=>scoreHost(b.url,displayName,query,npsIntent,region)-scoreHost(a.url,displayName,query,npsIntent,region));
        for (const r of results.slice(0,18)) {
          // quick skim: just ensure the name appears somewhere
          const raw=await fetchText(r.url);
          const hay=(r.title||"")+" "+(r.description||"")+" "+r.url+" "+raw;
          if(!passesNameTokenGate(hay,displayName)) continue;
          // return homepage kind (lets UI fill source even if fee not found)
          return ok({ url: null, homepage: r.url, feeInfo: "Not verified", kind: "homepage" });
        }
      }
    }

    return ok({ url: null, homepage: null, feeInfo: "Not verified", kind: "not-verified" });
  } catch (e) {
    return ok({ error: e.message || "Error" });
  }
}

