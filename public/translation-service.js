// public/translation-service.js
// PEN.ai – Full-page client translator.
// Walks all text nodes (except <script>/<style>) and translates EVERYTHING via /api/translate-batch.
// Includes batching, retries, whitespace preservation, RTL handling, and noisy debug logs.
(function () {
    'use strict';
  
    const BATCH_SIZE = 60;         // Slightly larger batches
    const MAX_RETRIES = 2;         // Per batch
    const RETRY_DELAY_MS = 400;    // Backoff between retries
    const RUN_FLAG_KEY = '__penai_translate_inflight';
  
    // Near the very top:
console.log('[Translator] v2.1 loaded');  // <-- ADD THIS

// Inside translatePage(), right after we compute uniqueTrimmed:
console.log('[Translator] Will send', uniqueTrimmed.length, 'strings to /api/translate-batch for', targetLang);  // <-- ADD THIS

    /**
     * Debug helper
     */
    function log(...args) {
      // Flip to false to silence logs
      const DEBUG = true;
      if (DEBUG) console.log('[Translator]', ...args);
    }
  
    /**
     * Sleep
     */
    function delay(ms) {
      return new Promise(r => setTimeout(r, ms));
    }
  
    /**
     * Collect ALL text nodes (except inside SCRIPT/STYLE).
     * We do not honour data-no-translate right now — everything translates.
     */
    function collectTextNodes(root) {
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
  
            // Keep nodes with any non-whitespace characters
            if (!val.trim()) return NodeFilter.FILTER_REJECT;
  
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      let n;
      while ((n = walker.nextNode())) out.push(n);
      return out;
    }
  
    /**
     * POST texts to server for DeepL translation. Returns an array of translated strings.
     */
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
            throw new Error('Unexpected response shape from /api/translate-batch');
          }
          return data.translations;
        } catch (err) {
          attempt += 1;
          log(`Batch failed (attempt ${attempt}/${MAX_RETRIES + 1}):`, err && err.message ? err.message : err);
          if (attempt > MAX_RETRIES) break;
          await delay(RETRY_DELAY_MS * attempt); // simple backoff
        }
      }
      // On failure, return originals (no partial replacements)
      return texts;
    }
  
    /**
     * Translate the entire page to targetLang.
     * Idempotent-ish: guards against concurrent runs with a global flag.
     */
    async function translatePage(targetLang) {
      if (!targetLang || targetLang === 'en') {
        // Still set html attributes for consistency
        document.documentElement.lang = 'en';
        document.documentElement.dir = 'ltr';
        return;
      }
  
      // Prevent overlapping runs
      if (window[RUN_FLAG_KEY]) {
        log('translatePage skipped (already running)');
        return;
      }
      window[RUN_FLAG_KEY] = true;
  
      try {
        document.body.style.opacity = '0.7';
  
        // 1) Gather text nodes
        const textNodes = collectTextNodes(document.body);
        log('Found text nodes:', textNodes.length);
  
        // 2) Build unique trimmed texts (map originals -> trimmed to preserve spaces later)
        const originals = textNodes.map(n => n.nodeValue);
        const trimmed = originals.map(s => (s || '').trim());
        const uniqueTrimmed = Array.from(new Set(trimmed.filter(Boolean)));
  
        log(`Will send ${uniqueTrimmed.length} strings to /api/translate-batch for`, targetLang);
  
        // 3) Translate in batches and build a map { trimmed -> translated }
        const translationMap = new Map();
        for (let i = 0; i < uniqueTrimmed.length; i += BATCH_SIZE) {
          const batch = uniqueTrimmed.slice(i, i + BATCH_SIZE);
          const translated = await translateBatch(batch, targetLang);
          // If the server fell back to originals, lengths will match but text may be unchanged; we still map 1:1.
          for (let j = 0; j < batch.length; j++) {
            translationMap.set(batch[j], translated[j]);
          }
          log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: sent ${batch.length}, received ${translated.length}`);
        }
  
        // 4) Apply to DOM, preserving leading/trailing whitespace for each node
        let applied = 0;
        for (let idx = 0; idx < textNodes.length; idx++) {
          const node = textNodes[idx];
          const original = originals[idx] || '';
          const lead = original.match(/^\s*/)[0];
          const trail = original.match(/\s*$/)[0];
          const key = trimmed[idx];
  
          if (key && translationMap.has(key)) {
            const translated = translationMap.get(key);
            // Fallback safety: avoid writing undefined
            if (typeof translated === 'string' && translated.length >= 0) {
              node.nodeValue = lead + translated + trail;
              applied++;
            }
          }
        }
        log(`Applied translations to ${applied} / ${textNodes.length} text nodes.`);
  
        // 5) Set page language + direction
        document.documentElement.lang = targetLang;
        document.documentElement.dir = (targetLang === 'ar' ? 'rtl' : 'ltr');
  
      } catch (err) {
        console.error('[Translator] Fatal translatePage error:', err);
      } finally {
        document.body.style.opacity = '1';
        window[RUN_FLAG_KEY] = false;
      }
    }
  
    // Expose API
    window.TranslationService = { translatePage };
  })();
  