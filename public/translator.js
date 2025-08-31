(function () {
  'use strict';

  // ---------------------------- Config ----------------------------
  const PICKER_ID   = 'prospectus-lang';
  const STORE_KEY   = 'penai_prospectus_lang';
  const ALLOWED     = new Set(['en','zh','ar','ru','fr','es','de','it']); // DeepL codes (we'll .toUpperCase() before sending)

  // Phrases to preserve anywhere they appear
  const BRAND_TOKENS = [
    'More House School',
    'More House',
    'Knightsbridge'
  ];

  // Any blocks you’ve marked with data-no-translate are excluded entirely
  const EXCLUDE_SELECTOR = '[data-no-translate]';

  // ---------------------- State & Utilities -----------------------
  let ORIGINAL_HTML = null;
  let isTranslating = false;

  function getPicker() {
    return document.getElementById(PICKER_ID);
  }

  function getInitialLang() {
    // URL ?lang= takes priority; then last saved; default 'en'
    try {
      const u = new URL(window.location.href);
      const fromURL = (u.searchParams.get('lang') || '').trim().toLowerCase();
      if (ALLOWED.has(fromURL)) return fromURL;
    } catch (_) {}
    const fromLS = (localStorage.getItem(STORE_KEY) || '').trim().toLowerCase();
    return ALLOWED.has(fromLS) ? fromLS : 'en';
  }

  function setLangAttrs(lang) {
    document.documentElement.lang = lang || 'en';
    document.documentElement.dir  = (lang === 'ar') ? 'rtl' : 'ltr';
  }

  function writeLangToURL(lang) {
    try {
      const u = new URL(window.location.href);
      if (lang === 'en') u.searchParams.delete('lang');
      else u.searchParams.set('lang', lang);
      history.replaceState(null, '', u.toString());
    } catch (_) {}
  }

  // Gentle, classy transition
  function beginTransition() {
    const b = document.body.style;
    b.transition = 'opacity 200ms ease, filter 200ms ease';
    b.opacity = '0.6';
    b.filter = 'blur(1px)';
  }
  function endTransition() {
    const b = document.body.style;
    b.opacity = '';
    b.filter = '';
    // keep transition property for any future change or clear it:
    // b.transition = '';
  }

  // Escape regex special chars
  function escReg(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Replace tokens with <span class="notranslate" translate="no">…</span>
  function protectBrandTokens(html) {
    let out = html;
    BRAND_TOKENS.forEach(tok => {
      if (!tok) return;
      const re = new RegExp(escReg(tok), 'g');
      out = out.replace(re, `<span class="notranslate" translate="no">${tok}</span>`);
    });
    return out;
  }

  // Prepare HTML to send to DeepL:
  //  - remove excluded blocks (data-no-translate) and replace with placeholders
  //  - remove <script> and <style> tags (placeholders)
  //  - protect brand tokens
  function buildTranslatableHTML() {
    // Work from the original, never from a previously translated DOM
    const tmp = document.createElement('div');
    tmp.innerHTML = ORIGINAL_HTML;

    const placeholders = [];
    let counter = 0;

    function replaceNodeWithPlaceholder(node, label) {
      const key = `PEN_PLACEHOLDER_${label}_${counter++}`;
      const comment = document.createComment(key);
      const html = node.outerHTML;
      node.replaceWith(comment);
      placeholders.push({ key, html });
    }

    // 1) Exclude declared blocks
    tmp.querySelectorAll(EXCLUDE_SELECTOR).forEach(node => replaceNodeWithPlaceholder(node, 'EXCL'));

    // 2) Strip scripts
    tmp.querySelectorAll('script').forEach(node => replaceNodeWithPlaceholder(node, 'SCRIPT'));

    // 3) Strip styles (optional but safe)
    tmp.querySelectorAll('style').forEach(node => replaceNodeWithPlaceholder(node, 'STYLE'));

    // 4) Now we have a clean HTML string to translate
    let html = tmp.innerHTML;

    // 5) Protect brand tokens
    html = protectBrandTokens(html);

    return { html, placeholders };
  }

  // Restore placeholders back into translated HTML
  function restorePlaceholders(translated, placeholders) {
    let out = translated;
    placeholders.forEach(({ key, html }) => {
      // Replace comment markers like <!--PEN_PLACEHOLDER_EXCL_0-->
      const marker = `<!--${key}-->`;
      out = out.replace(marker, html);
    });
    return out;
  }

  async function translateTo(lang) {
    if (isTranslating) return;
    if (!ALLOWED.has(lang)) return;

    // English: restore original and exit
    if (lang === 'en') {
      isTranslating = true;
      beginTransition();
      try {
        document.body.innerHTML = ORIGINAL_HTML;
        setLangAttrs('en');
        localStorage.setItem(STORE_KEY, 'en');
        writeLangToURL('en');
      } finally {
        // Re-bind picker listener after DOM swap
        bindPicker();
        isTranslating = false;
        endTransition();
      }
      return;
    }

    const { html, placeholders } = buildTranslatableHTML();

    isTranslating = true;
    beginTransition();
    try {
      const res = await fetch('/api/deepl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, target_lang: lang })
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`DeepL proxy failed: ${res.status} ${text}`);
      }
      const data = await res.json();
      const translatedHTML = (data && data.translated) ? data.translated : '';
      if (!translatedHTML) throw new Error('Empty translated payload');

      // Restore placeholders (picker, address box, scripts/styles)
      const restored = restorePlaceholders(translatedHTML, placeholders);

      // Swap full body content at once
      document.body.innerHTML = restored;

      // Attributes, memory, URL param
      setLangAttrs(lang);
      localStorage.setItem(STORE_KEY, lang);
      writeLangToURL(lang);
    } catch (err) {
      console.error('[translator] Translation error:', err);
      alert('Sorry — we could not translate the page just now. Please try again.');
      // On failure, keep current DOM and attributes unchanged
    } finally {
      // Re-bind picker listener after DOM swap
      bindPicker();
      isTranslating = false;
      endTransition();
    }
  }

  // Ensure the picker drives translation; also sync its value with current lang
  function bindPicker() {
    const picker = getPicker();
    if (!picker) return;
    // Remove existing listener by cloning (simple, avoids double-binding after swaps)
    const clone = picker.cloneNode(true);
    picker.parentNode.replaceChild(clone, picker);

    clone.addEventListener('change', e => {
      const lang = String((e.target.value || 'en')).trim().toLowerCase();
      if (!ALLOWED.has(lang)) return;
      translateTo(lang);
    });

    // Keep picker showing the current choice
    const current = getInitialLang();
    if (clone.value !== current) clone.value = current;
  }

  function init() {
    ORIGINAL_HTML = document.body.innerHTML; // snapshot English baseline
    const initial = getInitialLang();
    setLangAttrs(initial);

    bindPicker();
    if (initial !== 'en') {
      // Translate immediately if URL/localStorage says so
      translateTo(initial);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
