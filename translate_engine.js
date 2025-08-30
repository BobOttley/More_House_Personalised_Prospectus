// translate_engine.js
const SUPPORTED = new Set(['en','zh','ar','ru','fr','es','de','it']);
const LANG_MAP = new Map(Object.entries({
  'en':'en','en-gb':'en','en-us':'en',
  'ar':'ar','ru':'ru','fr':'fr','es':'es','de':'de','it':'it',
  'zh':'zh','zh-cn':'zh','zh-hans':'zh','zh-hant':'zh'
}));
const RTL = new Set(['ar']);
const DEEPL_API_KEY = (process.env.DEEPL_API_KEY || '').trim();
const DEEPL_URL = DEEPL_API_KEY ? 'https://api-free.deepl.com/v2/translate' : null;
const BRAND_TOKENS = (process.env.BRAND_TOKENS || "More House,22-24 Pont Street,Knightsbridge,London SW1X 0AA,registrar@morehouse.org.uk")
  .split(',').map(s=>s.trim()).filter(Boolean);

function normaliseLang(s){ if(!s) return 'en'; const k=String(s).trim().toLowerCase(); return LANG_MAP.get(k)||'en'; }
function isRtl(lang){ return RTL.has(normaliseLang(lang)); }

const TOKEN_RE = BRAND_TOKENS.length
  ? new RegExp(BRAND_TOKENS.slice().sort((a,b)=>b.length-a.length).map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g')
  : null;
const BRACK_RE = /(\{\{.*?\}\}|\[\[.*?\]\])/gs;

function protect(list, re, tag){
  if(!re) return {text:list, bag:[]};
  const bag=[]; const text = list.replace(re, m => { const i=bag.length; bag.push(m); return `__PEN_${tag}_${i}__`; });
  return {text, bag};
}
function restore(s, bag, tag){
  if(!bag?.length) return s;
  let out=s; bag.forEach((v,i)=>{ out = out.split(`__PEN_${tag}_${i}__`).join(v); });
  return out;
}
function protectBrands(s){ return TOKEN_RE ? protect(s, TOKEN_RE, 'BRAND') : {text:s, bag:[]}; }
function restoreBrands(s,bag){ return restore(s,bag,'BRAND'); }
function protectBrackets(s){ return protect(s, BRACK_RE, 'BRACK'); }
function restoreBrackets(s,bag){ return restore(s,bag,'BRACK'); }
function skip(t){ if(!t?.trim()) return true; if(t.trim().length<=1) return true; if(/^[\W_]+$/u.test(t)) return true; if(/^\s*[\d\.\,\:\-\+\(\)%\s]+\s*$/.test(t)) return true; return false; }

async function deeplBatch(texts, lang){
  lang = normaliseLang(lang);
  if(!texts?.length) return texts;
  if(!DEEPL_API_KEY || !DEEPL_URL || lang==='en') return texts;
  const params = new URLSearchParams();
  texts.forEach(t=>params.append('text', t));
  params.set('target_lang', lang.toUpperCase());
  const r = await fetch(DEEPL_URL, { method:'POST', headers:{ 'Authorization':`DeepL-Auth-Key ${DEEPL_API_KEY}`, 'Content-Type':'application/x-www-form-urlencoded' }, body: params });
  if(!r.ok){ return texts; }
  const data = await r.json().catch(()=>({translations:[]}));
  const out = data.translations||[];
  return texts.map((_,i)=> out[i]?.text ?? texts[i]);
}

async function translateHtmlFragment(html, lang){
  lang = normaliseLang(lang);
  if(lang==='en' || !html?.trim()) return html;

  const parts = html.split(/(<[^>]+>)/g);
  const out=[]; const jobs=[]; const idx=[]; const brands=[]; const bracks=[];
  let inScript=false, inStyle=false;
  const isOpen=(n,t)=> new RegExp(`<\\s*${n}\\b`,'i').test(t)&&!t.startsWith('</');
  const isClose=(n,t)=> new RegExp(`<\\s*/\\s*${n}\\b`,'i').test(t);

  for(const p of parts){
    if(p.startsWith('<')){
      if(isOpen('script',p)) inScript=true;
      if(isClose('script',p)) inScript=false;
      if(isOpen('style',p))  inStyle=true;
      if(isClose('style',p)) inStyle=false;
      out.push(p); continue;
    }
    if(inScript||inStyle||skip(p)){ out.push(p); continue; }
    const pb = protectBrands(p);
    const p2 = protectBrackets(pb.text);
    idx.push(out.length); brands.push(pb.bag); bracks.push(p2.bag); jobs.push(p2.text);
    out.push('');
  }

  if(jobs.length){
    const tx = await deeplBatch(jobs, lang);
    tx.forEach((s,i)=>{ s=restoreBrackets(s,bracks[i]); s=restoreBrands(s,brands[i]); out[idx[i]]=s; });
  }

  let html2 = out.join('');
  if(/<html\b/i.test(html2)){
    html2 = html2.replace(/(<html\b[^>]*?)\s+lang="[^"]*"/i, '$1');
    html2 = html2.replace(/(<html\b)([^>]*?)>/i, `$1 lang="${lang}"$2>`);
    if(isRtl(lang)){
      if(/<html[^>]*\bdir=/i.test(html2)) html2 = html2.replace(/(<html\b[^>]*\b)dir="[^"]*"/i,'$1dir="rtl"');
      else html2 = html2.replace(/(<html\b)([^>]*?)>/i,'$1 dir="rtl"$2>');
    } else {
      html2 = html2.replace(/(<html\b[^>]*\b)dir="[^"]*"/i,'$1');
    }
  }
  html2 = html2.replace(/<\/head>/i, `<meta name="penai-lang" content="${lang}"></head>`);
  return html2;
}

module.exports = { translateHtmlFragment, normaliseLang, SUPPORTED };
