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

const BRAND_TOKENS = new Set([
  "Bath", "More House", "St Andrews", "Durham", "Exeter", "Warwick", 
  "Bristol", "Edinburgh", "Cambridge", "RADA", "King's College London", 
  "Imperial College London", "University College London", "London School of Economics", 
  "Central Saint Martins", "22-24 Pont Street", "Knightsbridge", "London SW1X 0AA",
  "Tel: 020 7235 2855", "Email: registrar@morehouse.org.uk", "registrar@morehouse.org.uk"
]);

function normaliseLang(s){ 
  if(!s) return 'en'; 
  return LANG_MAP.get(String(s).trim().toLowerCase()) || 'en'; 
}

function isRtl(lang){ return RTL.has(normaliseLang(lang)); }

const TOKEN_RE = BRAND_TOKENS.size > 0
  ? new RegExp(Array.from(BRAND_TOKENS).sort((a,b) => b.length - a.length).map(t => t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'), 'g')
  : null;

function protectBrands(s) {
  if (!s || !TOKEN_RE) return { text: s, bag: [] };
  
  const bag = [];
  const text = s.replace(TOKEN_RE, match => {
    const i = bag.length;
    bag.push(match);
    return `__PENBRAND_${i}__`;
  });
  
  return { text, bag };
}

function restoreBrands(s, bag) {
  if (!bag || bag.length === 0) return s;
  
  let result = s;
  bag.forEach((val, i) => {
    result = result.replace(new RegExp(`__PENBRAND_${i}__`, 'g'), val);
  });
  
  return result;
}

function shouldSkipText(text) {
  if (!text || !text.trim()) return true;
  if (text.trim().length <= 1) return true;
  // Fixed regex - removed \d from character class and used \w instead
  if (/^[\W_]+$/u.test(text)) return true;
  if (/^\s*[0-9\.\,\:\-\+\(\)%\s]+\s*$/.test(text)) return true;
  return false;
}

async function deeplBatch(texts, lang) {
  lang = normaliseLang(lang);
  if (!texts?.length || !DEEPL_API_KEY || lang === 'en') return texts;
  
  const params = new URLSearchParams();
  texts.forEach(t => params.append('text', t));
  params.set('target_lang', lang.toUpperCase());
  
  try {
    const r = await fetch(DEEPL_URL, { 
      method: 'POST', 
      headers: { 
        'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`, 
        'Content-Type': 'application/x-www-form-urlencoded' 
      }, 
      body: params 
    });
    
    if (!r.ok) return texts;
    const data = await r.json();
    return texts.map((_, i) => data.translations?.[i]?.text || texts[i]);
  } catch {
    return texts;
  }
}

async function translateHtmlFragment(html, lang) {
  lang = normaliseLang(lang);
  if (lang === 'en' || !html?.trim()) return html;

  const parts = html.split(/(<[^>]+>)/g);
  const out = [];
  const jobs = [];
  const jobsIdx = [];
  const brandBags = [];

  let inScript = false, inStyle = false;

  for (const p of parts) {
    if (p.startsWith('<')) {
      if (/<\s*script\b/i.test(p) && !p.startsWith('</')) inScript = true;
      if (/<\s*\/\s*script\b/i.test(p)) inScript = false;
      if (/<\s*style\b/i.test(p) && !p.startsWith('</')) inStyle = true;
      if (/<\s*\/\s*style\b/i.test(p)) inStyle = false;
      out.push(p);
      continue;
    }

    if (inScript || inStyle || shouldSkipText(p)) {
      out.push(p);
      continue;
    }

    const { text: protectedText, bag } = protectBrands(p);
    
    jobsIdx.push(out.length);
    brandBags.push(bag);
    jobs.push(protectedText);
    out.push('');
  }

  if (jobs.length) {
    const translated = await deeplBatch(jobs, lang);
    translated.forEach((s, i) => {
      const restored = restoreBrands(s, brandBags[i]);
      out[jobsIdx[i]] = restored;
    });
  }

  let html2 = out.join('');

  if (/<html\b/i.test(html2)) {
    html2 = html2.replace(/(<html\b[^>]*?)\s+lang="[^"]*"/i, '$1');
    html2 = html2.replace(/(<html\b)([^>]*?)>/i, `$1 lang="${lang}"$2>`);
    
    if (isRtl(lang)) {
      if (/<html[^>]*\bdir=/i.test(html2)) {
        html2 = html2.replace(/(<html\b[^>]*\b)dir="[^"]*"/i, '$1dir="rtl"');
      } else {
        html2 = html2.replace(/(<html\b)([^>]*?)>/i, '$1 dir="rtl"$2>');
      }
    }
  }

  return html2.replace(/<\/head>/i, `<meta name="penai-lang" content="${lang}"></head>`);
}

module.exports = { translateHtmlFragment, normaliseLang, SUPPORTED };