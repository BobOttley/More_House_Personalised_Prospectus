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

// Updated brand tokens to match your Python version
const BRAND_TOKENS = new Set([
  "Bath", "More House", "St Andrews", "Durham", "Bath", "Exeter", "Warwick", 
  "Bristol", "Edinburgh", "Cambridge", "RADA", "King's College London", 
  "Imperial College London", "University College London", "London School of Economics", 
  "Central Saint Martins", "22-24 Pont Street", "Knightsbridge", "London SW1X 0AA",
  "Tel: 020 7235 2855", "Email: registrar@morehouse.org.uk", "registrar@morehouse.org.uk"
]);

function normaliseLang(s){ 
  if(!s) return 'en'; 
  const k = String(s).trim().toLowerCase(); 
  return LANG_MAP.get(k) || 'en'; 
}

function isRtl(lang){ 
  return RTL.has(normaliseLang(lang)); 
}

// Create regex from brand tokens (sorted by length, longest first)
const TOKEN_RE = BRAND_TOKENS.size > 0
  ? new RegExp(Array.from(BRAND_TOKENS).sort((a,b) => b.length - a.length).map(t => t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'), 'g')
  : null;

const BRACK_RE = /(\{\{.*?\}\}|\[\[.*?\]\])/gs;

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

function protectBrackets(s) {
  if (!s) return { text: s, bag: [] };
  
  const bag = [];
  const text = s.replace(BRACK_RE, match => {
    const i = bag.length;
    bag.push(match);
    return `__PENPROT_${i}__`;
  });
  
  return { text, bag };
}

function restoreBrackets(s, bag) {
  if (!bag || bag.length === 0) return s;
  
  let result = s;
  bag.forEach((val, i) => {
    result = result.replace(new RegExp(`__PENPROT_${i}__`, 'g'), val);
  });
  
  return result;
}

function shouldSkipText(text) {
  if (!text || !text.trim()) return true;
  if (text.trim().length <= 1) return true;
  if (/^[\W_]+$/u.test(text)) return true;
  if (/^\s*[\d\.\,\:\-\+\(\)%\s]+\s*$/.test(text)) return true;
  return false;
}

async function deeplBatch(texts, lang) {
  lang = normaliseLang(lang);
  if (!texts || texts.length === 0) return texts;
  if (!DEEPL_API_KEY || !DEEPL_URL || lang === 'en') return texts;
  
  try {
    const params = new URLSearchParams();
    texts.forEach(t => params.append('text', t));
    params.set('target_lang', lang.toUpperCase());
    
    const response = await fetch(DEEPL_URL, { 
      method: 'POST', 
      headers: { 
        'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`, 
        'Content-Type': 'application/x-www-form-urlencoded' 
      }, 
      body: params 
    });
    
    if (!response.ok) {
      console.warn('DeepL API error:', response.status);
      return texts;
    }
    
    const data = await response.json();
    const translations = data.translations || [];
    
    return texts.map((originalText, i) => {
      return translations[i]?.text || originalText;
    });
  } catch (error) {
    console.warn('DeepL translation failed:', error.message);
    return texts;
  }
}

async function translateHtmlFragment(html, lang) {
  lang = normaliseLang(lang);
  if (lang === 'en' || !html || !html.trim()) return html;

  // Split into alternating [text, <tag>, text, <tag>...]
  const parts = html.split(/(<[^>]+>)/g);
  const out = [];
  const jobs = [];
  const jobsIdx = [];
  const jobsBrandBags = [];
  const jobsBrackBags = [];

  let inScript = false;
  let inStyle = false;

  const isOpening = (tagname, t) => new RegExp(`<\\s*${tagname}\\b`, 'i').test(t) && !t.startsWith('</');
  const isClosing = (tagname, t) => new RegExp(`<\\s*/\\s*${tagname}\\b`, 'i').test(t);

  for (const p of parts) {
    if (p.startsWith('<')) {
      // Track script/style context
      if (isOpening('script', p)) inScript = true;
      if (isClosing('script', p)) inScript = false;
      if (isOpening('style', p)) inStyle = true;
      if (isClosing('style', p)) inStyle = false;
      out.push(p);
      continue;
    }

    // Text node
    if (inScript || inStyle) {
      out.push(p);
      continue;
    }
    if (shouldSkipText(p)) {
      out.push(p);
      continue;
    }

    const { text: s1, bag: brandBag } = protectBrands(p);
    const { text: s2, bag: brackBag } = protectBrackets(s1);

    jobsIdx.push(out.length);
    jobsBrandBags.push(brandBag);
    jobsBrackBags.push(brackBag);
    jobs.push(s2);
    out.push(''); // placeholder
  }

  // Translate all queued text parts
  if (jobs.length > 0) {
    const translated = await deeplBatch(jobs, lang);
    translated.forEach((s, i) => {
      let restored = restoreBrackets(s, jobsBrackBags[i]);
      restored = restoreBrands(restored, jobsBrandBags[i]);
      out[jobsIdx[i]] = restored;
    });
  }

  let html2 = out.join('');

  // Ensure <html lang=".."> (don't duplicate)
  if (/<html\b/i.test(html2)) {
    // Remove any existing lang attr then set the one we want
    html2 = html2.replace(/(<html\b[^>]*?)\s+lang="[^"]*"/i, '$1');
    html2 = html2.replace(/(<html\b)([^>]*?)>/i, `$1 lang="${lang}"$2>`);
    
    if (isRtl(lang)) {
      if (/<html[^>]*\bdir=/i.test(html2)) {
        html2 = html2.replace(/(<html\b[^>]*\b)dir="[^"]*"/i, '$1dir="rtl"');
      } else {
        html2 = html2.replace(/(<html\b)([^>]*?)>/i, '$1 dir="rtl"$2>');
      }
    } else {
      // remove dir if present and not RTL
      html2 = html2.replace(/(<html\b[^>]*\b)dir="[^"]*"/i, '$1');
    }
  }

  // Mark selected language (for debugging)
  if (/<\/head>/i.test(html2)) {
    html2 = html2.replace(/<\/head>/i, `<meta name="penai-lang" content="${lang}"></head>`);
  }

  return html2;
}

module.exports = { translateHtmlFragment, normaliseLang, SUPPORTED };