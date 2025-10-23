// Netlify Function: /api/search
// v27 — adds `lenient` mode and stronger nonprofit/parks support

const ENTRANCE_TERMS = [
  "entrance","entry","admission","day-use","day use","access",
  "entrada","ingreso","acceso","entrée","entree","accès","acces",
  "eintritt","zugang","ingresso","noleggio","noleggi",
  "ingresso","accesso","biglietto",
  "toegang","adgang","inträde","inngang","giriş",
  "入場","入園","料金","门票","門票","票價","票价","收费","收費",
  "入場料","입장료","요금"
];

const FEE_TERMS = [
  "fee","fees","price","prices","rate","rates","pricing","pass","parking fee","day-use",
  "tarifa","tarifas","precio","precios","pase","tarif","tarifs","prix","pass",
  "gebühr","gebuehr","gebühren","preise",
  "tariffa","tariffe","prezzo","prezzi",
  "taxa","taxas","preço","preços","passe",
  "料金","요금","收费","收費","цена","цены"
];

const NO_FEE_TERMS = [
  "no fee","free entry","free admission","free","no charge",
  "gratis","sin costo","sin cargo","gratuit","kostenlos",
  "gratuito","grátis","sem custo","免费","免費","無料","무료"
];

const CURRENCY_RX = /(\$|€|£|¥|₹|₩|₺|₽|₴|R\$|C\$|A\$|NZ\$|CHF|SEK|NOK|DKK|zł|Kč|Ft|₫|R|AED|SAR|₱|MXN|COP|PEN|S\/|CLP|ARS)\s?\d{1,3}(?:[.,]\d{2})?/i;

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

function toSlug(s=""){return s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");}
function tokenSim(a,b){const n=s=>(s||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").replace(/\s+/g," ").trim();const A=new Set(n(a).split(" ").filter(Boolean));const B=new Set(n(b).split(" ").filter(Boolean));const inter=[...A].filter(x=>B.has(x)).length;return (2*inter)/Math.max(1,A.size+B.size);}
async function fetchText(url){try{const r=await fetch(url,{redirect:"follow"});if(!r.ok)return"";return(await r.text()).slice(0,900000);}catch{return"";}}
function hasAny(h,arr){const t=h.toLowerCase();return arr.some(k=>t.includes(k));}
function nearEachOther(t,groupA,groupB,maxGap=240){t=t.toLowerCase();for(const a of groupA){const ia=t.indexOf(a);if(ia===-1)continue;for(const b of groupB){const ib=t.indexOf(b);if(ib===-1)continue;if(Math.abs(ia-ib)<=maxGap)return true;}}return false;}
function extractAmount(t){const m=t.match(CURRENCY_RX);return m?m[0].replace(/\s+/g," "):null;}
function looksLikeFeePath(p){return (/\/fees?(\/|\.|$)/i.test(p)||/\/(planyourvisit|visit|prices|pricing|tarif|tarifa|preise|料金|요금|收费)/i.test(p)||/\/(admission|entrada|entree|eingang|ingresso)/i.test(p));}
function detectNpsIntent(q){q=(q||"").toLowerCase();return /\bnps\b|national park|national monument|national recreation area|national preserve/.test(q);}
function isAllTrailsUrl(s){try{return new URL(s).hostname.includes("alltrails.com");}catch{return false;}}

function detectStateInString(s){if(!s)return null;const low=s.toLowerCase();for(const [abbr,name] of US_STATES){if(low.includes(name.toLowerCase())||low.match(new RegExp(`\\b${abbr.toLowerCase()}\\b`)))return name;}return null;}
function guessStateFromAllTrailsUrl(u){try{const url=new URL(u);const parts=url.pathname.split("/").filter(Boolean);if(parts[0]==="trail"&&parts[1]==="us"&&parts[2]){const n=parts[2].replace(/-/g," ").toLowerCase();const ab=STATE_NAME_TO_ABBR[n];if(ab)return US_STATES.find(([a])=>a===ab)[1];return n.replace(/\b\w/g,c=>c.toUpperCase());}}catch{}return null;}

function normalizeRegionTokens(input){if(!input)return[];const s=input.trim().toLowerCase();for(const [abbr,name] of US_STATES){if(s===abbr.toLowerCase()||s===name.toLowerCase())return[abbr.toLowerCase(),name.toLowerCase()];}return[s];}
function otherUsStateTokens(ex=[]){const exSet=new Set(ex.map(t=>t.toLowerCase()));const toks=[];for(const[abbr,name] of US_STATES){if(!exSet.has(abbr.toLowerCase())&&!exSet.has(name.toLowerCase())){toks.push(abbr.toLowerCase(),name.toLowerCase());}}return toks;}

const GENERIC = new Set(["the","a","an","of","and","or","at","on","in","to","for","by","park","parks","state","national","provincial","regional","county","city","trail","area","forest","recreation","recreational","natural","nature","reserve","preserve","site"]);
function coreNameTokens(name){return (name||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(t=>t&&!GENERIC.has(t)&&t.length>=3);}
function passesNameTokenGate(hay,displayName){const t=hay.toLowerCase();const tokens=coreNameTokens(displayName);if(tokens.length===0)return true;const need=Math.min(3,tokens.length);let hit=0;for(const tok of tokens)if(t.includes(tok))hit++;return hit>=need;}

function scoreHost(url,displayName,query,npsIntent,regionTokens=[],otherStateTokens=[],lenient=false){
  let score=0,host="",path="";
  try{const u=new URL(url);host=u.hostname.toLowerCase();path=u.pathname.toLowerCase();}catch{return -1;}

  const isGov = /\.gov(\.[a-z]{2})?$/.test(host) || /\.govt\.[a-z]{2}$/.test(host) || /\.gouv\.[a-z]{2}$/.test(host) || /\.gob\.[a-z]{2}$/.test(host) || /\.go\.[a-z]{2}$/.test(host);
  if(isGov) score+=80;
  if(host==="nps.gov"||host.endsWith(".nps.gov")) score+=(npsIntent?80:10);
  if(host==="fs.usda.gov"||host.endsWith(".fs.usda.gov")||host.endsWith(".usda.gov")) score+=60;
  if(host==="blm.gov"||host.endsWith(".blm.gov")) score+=60;

  const parkish = /(stateparks|nationalpark|national-?park|parks|parkandrec|recreation|recdept|dnr|naturalresources|nature|preserve|reserve|parc|parque|municipio|ayuntamiento|city|county|regionalpark|provincialpark|wildlife|audubon|trust|conservancy|botanic|botanical|museum|zoo)/.test(host);
  if(parkish) score+= lenient ? 36 : 26; // small bump in lenient

  if(looksLikeFeePath(path)) score+=30;

  const joined=host+" "+path;
  for(const t of regionTokens) if(t && joined.includes(t)) score+=24;
  for(const t of otherStateTokens) if(t && joined.includes(t)) score-=40;

  const sim=Math.max(tokenSim(displayName,host),tokenSim(displayName,path),tokenSim(displayName,query));
  score+=Math.round(sim*30);

  const slug=toSlug(displayName||query);
  if(slug && path.includes(slug)) score+=25;

  return score;
}

async function fetchAllTrailsPark(url){
  const html=await fetchText(url);
  if(!html) return {parkName:null,region:null};
  // __NEXT_DATA__
  const next=html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  const collect=(obj,out=new Set())=>{
    if(!obj) return out;
    if(Array.isArray(obj)){obj.forEach(v=>collect(v,out));return out;}
    if(typeof obj==="object"){
      for(const[k,v] of Object.entries(obj)){
        if(k==="name" && typeof v==="string" && v.length<=140) out.add(v);
        if(typeof v==="string" && /park|forest|preserve|reserve|recreation|national|state/i.test(v) && v.length<=160) out.add(v);
        collect(v,out);
      }
    }
    return out;
  };
  const pick=(names)=>{
    const arr=[...names];
    const score=n=>{
      const s=n.toLowerCase();
      let sc=0;
      if(/\b(national|state|provincial|regional|county)\b/.test(s)) sc+=5;
      if(/\bpark\b/.test(s)) sc+=5;
      if(/forest|preserve|reserve|recreation/.test(s)) sc+=3;
      sc+=Math.min(4,coreNameTokens(n).length);
      return sc;
    };
    arr.sort((a,b)=>score(b)-score(a));
    return arr[0]||null;
  };
  if(next){
    try{
      const data=JSON.parse(next[1]);
      const names=collect(data);
      const best=pick(names);
      const region=detectStateInString(JSON.stringify(data))||guessStateFromAllTrailsUrl(url)||detectStateInString(html)||null;
      if(best) return {parkName:best,region};
    }catch{}
  }
  // ld+json
  const re=/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m; const names=new Set();
  while((m=re.exec(html))!==null){ try{ collect(JSON.parse(m[1]), names); }catch{} }
  if(names.size){
    const best=[...names].sort((a,b)=>b.length-a.length)[0];
    const region=guessStateFromAllTrailsUrl(url)||detectStateInString(html)||null;
    return {parkName:best,region};
  }
  // meta fallback
  const title=(html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]||"").replace(/\s+\|.*$/,"").trim();
  if(title){ return {parkName:title,region:guessStateFromAllTrailsUrl(url)||detectStateInString(html)||null}; }
  return {parkName:null,region:guessStateFromAllTrailsUrl(url)||detectStateInString(html)||null};
}

function buildQueries(displayName, region){
  const core=`(admission OR "entrance fee" OR "day use" OR day-use OR fee OR fees OR prices OR rates OR pricing OR tarifa OR tarifs OR preise OR prezzi OR precios OR 料金 OR 요금 OR 收费 OR "$")`;
  const withRegion = region ? ` "${region}"` : "";
  return [
    `"${displayName}"${withRegion} ${core}`,
    `${displayName}${withRegion} ${core}`,
    `"${displayName}"${withRegion} (site:.gov OR site:.gov.* OR site:.govt.* OR site:.gouv.* OR site:.go.* OR site:.gob.*) ${core}`,
    `"${displayName}"${withRegion} (site:.org OR site:.com) (park OR parks OR "national park" OR "state park" OR parc OR parque OR reserve OR preserve OR museum OR zoo OR botanical) ${core}`
  ];
}
function ok(p){return{statusCode:200,headers:{"Content-Type":"application/json"},body:JSON.stringify(p)};}

export async function handler(event){
  if(event.httpMethod!=="POST") return ok({error:"POST only"});
  const key=process.env.BRAVE_API_KEY;
  if(!key) return ok({error:"Missing BRAVE_API_KEY"});

  let body={}; try{body=JSON.parse(event.body||"{}");}catch{}
  let {query, state=null, nameForMatch=null, lenient=false}=body;
  if(!query) return ok({error:"Missing query"});

  if(isAllTrailsUrl(query)){
    const {parkName,region}=await fetchAllTrailsPark(query);
    if(parkName) nameForMatch=parkName;
    if(region && !state) state=region;
    if(!nameForMatch){
      try{const u=new URL(query);const parts=u.pathname.split("/").filter(Boolean);nameForMatch=parts.at(-1)?.replace(/-/g," ");}catch{}
    }
  }
  if(!state) state=detectStateInString(query);

  const displayName=nameForMatch||query;
  const npsIntent=detectNpsIntent(displayName);

  let regionTokens=normalizeRegionTokens(state);
  let otherStateTokens=regionTokens.length?otherUsStateTokens(regionTokens):[];

  let qList=buildQueries(displayName, regionTokens[1]||regionTokens[0]||null);

  try{
    let bestFallback=null;
    let inferred=null;

    const tryBatch=async(queries, requireRegion=false, useLenient=false)=>{
      for(const q of queries){
        const url=`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=20&country=US&search_lang=en`;
        const res=await fetch(url,{headers:{"X-Subscription-Token":key,"Accept":"application/json"}});
        if(!res.ok) continue;
        const data=await res.json();
        let results=(data.web?.results||[]).filter(r=>r.url);

        results.sort((a,b)=>scoreHost(b.url,displayName,query,npsIntent,regionTokens,otherStateTokens,useLenient)-scoreHost(a.url,displayName,query,npsIntent,regionTokens,otherStateTokens,useLenient));

        if(!regionTokens.length){
          const counts={};
          for(const r of results.slice(0,12)){
            const low=(r.title+" "+r.description+" "+r.url).toLowerCase();
            const s=detectStateInString(low);
            if(s) counts[s]=(counts[s]||0)+1;
          }
          const top=Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
          if(top && top[1]>=2) inferred=top[0];
        }

        let checks=0;
        for(const r of results){
          if(checks>=22) break;
          let u; try{u=new URL(r.url);}catch{continue;}
          const host=u.hostname.toLowerCase(); const path=u.pathname.toLowerCase();

          const nameMatch=Math.max(tokenSim(displayName,r.title||""),tokenSim(displayName,(host+path)));
          if(nameMatch<0.20) continue;
          checks++;

          const raw=await fetchText(r.url);
          const hay=(r.title||"")+"\n"+(r.description||"")+"\n"+r.url+"\n"+raw;
          const lower=hay.toLowerCase();

          if(!passesNameTokenGate(hay,displayName)) continue;

          if((requireRegion||regionTokens.length)&&regionTokens.length){
            const inUrl=regionTokens.some(t=>t && (host+path).includes(t));
            const inTxt=regionTokens.some(t=>t && lower.includes(t));
            if(!inUrl && !inTxt) continue;
            if(otherStateTokens.some(t=>t && (host+path).includes(t))) continue;
          }

          if((host.endsWith("nps.gov")||host==="nps.gov") && path.includes("/planyourvisit/")){
            const nm=(displayName||"").toLowerCase();
            const titleLower=(r.title||"").toLowerCase();
            const urlLower=r.url.toLowerCase();
            if(!(titleLower.includes(nm)||urlLower.includes(toSlug(displayName))||tokenSim(nm,titleLower)>=0.55)) continue;
          }

          const hasCur=CURRENCY_RX.test(hay);
          const hasEnt=hasAny(lower,ENTRANCE_TERMS);
          const hasFee=hasAny(lower,FEE_TERMS);
          const hasNo=hasAny(lower,NO_FEE_TERMS);

          if(!hasCur && hasNo && nearEachOther(lower,NO_FEE_TERMS,ENTRANCE_TERMS,260)){
            return {url:r.url, feeInfo:"No fee", kind:"no-fee"};
          }
          if((hasCur && (hasEnt||hasFee)) || (hasFee && looksLikeFeePath(path))){
            const amt=extractAmount(hay);
            return {url:r.url, feeInfo: (amt||"Fee charged"), kind:"general"};
          }
          if(!bestFallback && looksLikeFeePath(path)){
            bestFallback={url:r.url, feeInfo:"Not verified", kind:"not-verified"};
          }
        }
      }
      return null;
    };

    // pass 1 (strict)
    let found=await tryBatch(qList,false,false);

    // inferred state strict retry
    if(!found && inferred && !regionTokens.length){
      regionTokens=normalizeRegionTokens(inferred);
      otherStateTokens=otherUsStateTokens(regionTokens);
      qList=buildQueries(displayName, regionTokens[1]||regionTokens[0]);
      found=await tryBatch(qList,true,false);
    }

    // lenient retry (allow more nonprofit/commercial hosts scoring higher)
    if(!found){
      found=await tryBatch(qList, !!regionTokens.length, true);
    }

    if(found) return ok(found);
    if(bestFallback) return ok(bestFallback);
    return ok({url:null,feeInfo:"Not verified",kind:"not-verified"});
  }catch(e){
    return ok({error:e.message||"Error"});
  }
}
