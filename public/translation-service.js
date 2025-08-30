// public/translation-service.js
// PEN.ai – Robust client translation utilities.
// - Full-page translate (skips <script>/<style>)
// - Mop-up translate: only nodes that still look English
// - MutationObserver: watches for dynamically inserted text and translates it
(function () {
    'use strict';
  
    const BATCH_SIZE = 60;
    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 400;
    const OBS_DEBOUNCE_MS = 250;
    const RUN_FLAG_KEY = '__penai_translate_inflight';
  
    function log(...args) {
      const DEBUG = true;
      if (DEBUG) console.log('[Translator]', ...args);
    }
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
  
    // Heuristic: looks like English (Latin letters present) and not just numbers/punctuation
    function looksEnglish(s) {
      if (!s) return false;
      const t = s.trim();
      if (!t) return false;
      if (!/[A-Za-z]/.test(t)) return false;
      // Avoid tiny fragments like single letters
      return t.replace(/[^A-Za-z]/g, '').length >= 2;
    }
  
    function collectTextNodes(root, predicate) {
      const out = [];
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            const p = node.parentElement;
            if (!p) return NodeFilter.FILTER_REJECT;
            const tag = p.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
  
            const val = node.nodeValue;
            if (!val) return NodeFilter.FILTER_REJECT;
            if (!val.trim()) return NodeFilter.FILTER_REJECT;
  
            if (predicate && !predicate(val)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      let n;
      while ((n = walker.nextNode())) out.push(n);
      return out;
    }
  
    async function translateBatch(texts, targetLang) {
      if (!texts.length || !targetLang || targetLang === 'en') return texts;
  
      let attempt = 0;
      while (attempt <= MAX_RETRIES) {
        try {
          const res = await fetch('/api/translate-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ texts, lang: targetLang })
          });
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${body || ''}`.trim());
          }
          const data = await res.json();
          if (!data || !Array.isArray(data.translations)) {
            throw new Error('Unexpected response from /api/translate-batch');
          }
          return data.translations;
        } catch (err) {
          attempt += 1;
          log(`Batch failed (attempt ${attempt}/${MAX_RETRIES + 1}):`, err && err.message ? err.message : err);
          if (attempt > MAX_RETRIES) break;
          await delay(RETRY_DELAY_MS * attempt);
        }
      }
      return texts; // fail safe: no changes
    }
  
    // Full-page: translate every text node
    async function translatePage(targetLang) {
      if (!targetLang || targetLang === 'en') {
        document.documentElement.lang = 'en';
        document.documentElement.dir = 'ltr';
        return;
      }
      if (window[RUN_FLAG_KEY]) {
        log('translatePage skipped (already running)');
        return;
      }
      window[RUN_FLAG_KEY] = true;
  
      try {
        document.body.style.opacity = '0.7';
  
        const textNodes = collectTextNodes(document.body);
        log('Found text nodes:', textNodes.length);
  
        const originals = textNodes.map(n => n.nodeValue);
        const trimmed = originals.map(s => (s || '').trim());
        const uniqueTrimmed = Array.from(new Set(trimmed.filter(Boolean)));
        log(`Will send ${uniqueTrimmed.length} strings to /api/translate-batch for`, targetLang);
  
        const translationMap = new Map();
        for (let i = 0; i < uniqueTrimmed.length; i += BATCH_SIZE) {
          const batch = uniqueTrimmed.slice(i, i + BATCH_SIZE);
          const translated = await translateBatch(batch, targetLang);
          for (let j = 0; j < batch.length; j++) {
            translationMap.set(batch[j], translated[j]);
          }
          log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: sent ${batch.length}, received ${translated.length}`);
        }
  
        let applied = 0;
        for (let idx = 0; idx < textNodes.length; idx++) {
          const node = textNodes[idx];
          const original = originals[idx] || '';
          const lead = original.match(/^\s*/)[0];
          const trail = original.match(/\s*$/)[0];
          const key = trimmed[idx];
          if (key && translationMap.has(key)) {
            const translated = translationMap.get(key);
            if (typeof translated === 'string') {
              node.nodeValue = lead + translated + trail;
              applied++;
            }
          }
        }
        log(`Applied translations to ${applied} / ${textNodes.length} nodes.`);
  
        document.documentElement.lang = targetLang;
        document.documentElement.dir = (targetLang === 'ar' ? 'rtl' : 'ltr');
      } catch (err) {
        console.error('[Translator] Fatal translatePage error:', err);
      } finally {
        document.body.style.opacity = '1';
        window[RUN_FLAG_KEY] = false;
      }
    }
  
    // Mop-up: translate only nodes that still look English (good after server-side translation)
    async function translateOnlyEnglish(targetLang) {
      if (!targetLang || targetLang === 'en') return;
  
      const nodes = collectTextNodes(document.body, looksEnglish);
      if (!nodes.length) {
        log('Mop-up: nothing that looks
  