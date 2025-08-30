// public/translation-service.js
(function () {
  'use strict';

  const RELAY_URL = '/api/translate-html';
  const RUN_FLAG = '__penai_translate_inflight';
  const STORE_KEY = '__penai_original_html';
  const LANG_KEY  = 'penai_prospectus_lang';
  const SUPPORTED = ['en','zh','ar','ru','fr','es','de','it'];

  function log(...a){ if (true) console.log('[PEN.translate]', ...a); }
  function setLangAttrs(lang) {
    document.documentElement.lang = lang || 'en';
    document.documentElement.dir  = (lang === 'ar' ? 'rtl' : 'ltr');
  }
  function normaliseLang(x) {
    if (!x) return 'en';
    const lc = x.toLowerCase();
    if (SUPPORTED.includes(lc)) return lc;
    const base = lc.split('-')[0];
    return SUPPORTED.includes(base) ? base : 'en';
  }

  function ensureOriginalSnapshot() {
    if (!window[STORE_KEY]) {
      window[STORE_KEY] = document.documentElement.outerHTML;
      log('Original HTML snapshot captured (length:', window[STORE_KEY].length, ')');
    }
    return window[STORE_KEY];
  }

  async function relayTranslateHtml({ html, lang }) {
    const res = await fetch(RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, lang })
    });
    if (!res.ok) {
      const body = await res.text().catch(()=> '');
      throw new Error(`Translate relay failed: HTTP ${res.status} ${body}`);
    }
    const data = await res.json();
    if (!data || typeof data.html !== 'string') throw new Error('Translate relay returned no html');
    return data;
  }

  function writeWholeDocument(html, lang) {
    document.open();
    document.write(html);
    document.close();
    try { setLangAttrs(lang); } catch(_){}
  }

  async function translateTo(targetLang) {
    const lang = normaliseLang(targetLang);
    if (lang === 'en') {
      writeWholeDocument(ensureOriginalSnapshot(), 'en');
      localStorage.setItem(LANG_KEY, 'en');
      return;
    }
    if (window[RUN_FLAG]) { log('translateTo skipped (already running)'); return; }
    window[RUN_FLAG] = true;

    const prevOpacity = document.body && document.body.style.opacity;
    try {
      if (document.body) document.body.style.opacity = '0.7';

      const originalHtml = ensureOriginalSnapshot();
      log(`Translating full document to "${lang}" (length ${originalHtml.length})`);
      const { html } = await relayTranslateHtml({ html: originalHtml, lang });
      writeWholeDocument(html, lang);
      localStorage.setItem(LANG_KEY, lang);
      bindPicker(); // DOM replaced; re-bind picker
    } catch (err) {
      console.error('[PEN.translate] Fatal translation error:', err);
      try { writeWholeDocument(ensureOriginalSnapshot(), 'en'); } catch(_){}
    } finally {
      if (document.body) document.body.style.opacity = prevOpacity || '1';
      window[RUN_FLAG] = false;
    }
  }

  function bindPicker() {
    const sel = document.getElementById('prospectus-lang');
    if (!sel) return;
    const stored = normaliseLang(localStorage.getItem(LANG_KEY) || 'en');
    if (sel.value !== stored) sel.value = stored;
    sel.onchange = function () { translateTo(this.value); };
  }

  window.PEN = window.PEN || {};
  window.PEN.translate = {
    to: translateTo,
    current: () => normaliseLang(localStorage.getItem(LANG_KEY) || document.documentElement.lang || 'en'),
    init: function () {
      ensureOriginalSnapshot();
      bindPicker();
      const urlLang = new URLSearchParams(location.search).get('lang');
      const lang = normaliseLang(urlLang || localStorage.getItem(LANG_KEY) || 'en');
      if (lang !== 'en') translateTo(lang); else setLangAttrs('en');
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.PEN.translate.init());
  } else {
    window.PEN.translate.init();
  }
})();
