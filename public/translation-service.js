// public/translation-service.js
// Lightweight page translator: walks all text nodes and batches calls to /api/translate-batch.
// NOTE: translates EVERYTHING except <script>/<style>. Ignores data-no-translate for now.
(function () {
    'use strict';
  
    const BATCH_SIZE = 50;
  
    async function translateBatch(texts, targetLang) {
      if (!texts.length || !targetLang || targetLang === 'en') return texts;
      try {
        const res = await fetch('/api/translate-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ texts, lang: targetLang })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return Array.isArray(data.translations) ? data.translations : texts;
      } catch (err) {
        console.error('Translation batch failed:', err);
        return texts;
      }
    }
  
    // Collect ALL text nodes (except inside SCRIPT/STYLE). We do NOT skip branding right now.
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
  
            const trimmed = val.trim();
            if (!trimmed) return NodeFilter.FILTER_REJECT;
  
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      let n;
      while ((n = walker.nextNode())) out.push(n);
      return out;
    }
  
    async function translatePage(targetLang) {
      if (!targetLang || targetLang === 'en') return;
  
      document.body.style.opacity = '0.7';
  
      // 1) Grab text nodes
      const textNodes = collectTextNodes(document.body);
  
      // 2) Build unique list to reduce token cost
      const originals = textNodes.map(n => n.nodeValue.trim());
      const uniqueTexts = Array.from(new Set(originals));
  
      // 3) Translate in batches
      const translationMap = new Map();
      for (let i = 0; i < uniqueTexts.length; i += BATCH_SIZE) {
        const batch = uniqueTexts.slice(i, i + BATCH_SIZE);
        const translated = await translateBatch(batch, targetLang);
        for (let j = 0; j < batch.length; j++) {
          translationMap.set(batch[j], translated[j]);
        }
      }
  
      // 4) Apply back to DOM
      for (const node of textNodes) {
        const t = node.nodeValue.trim();
        if (translationMap.has(t)) {
          node.nodeValue = translationMap.get(t);
        }
      }
  
      // 5) Set page language + direction
      document.documentElement.lang = targetLang;
      document.documentElement.dir = (targetLang === 'ar' ? 'rtl' : 'ltr');
  
      document.body.style.opacity = '1';
    }
  
    // Expose a tiny API
    window.TranslationService = { translatePage };
  })();
  