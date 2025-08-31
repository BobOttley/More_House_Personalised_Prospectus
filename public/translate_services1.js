window.TranslationService = (function() {
  'use strict';
  
  const cache = new Map();
  const BATCH_SIZE = 50;
  
  async function translateBatch(texts, targetLang) {
      if (!texts.length || targetLang === 'en') return texts;
      
      try {
          const response = await fetch('/api/translate-batch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ texts, lang: targetLang })
          });
          
          if (!response.ok) throw new Error('Translation failed');
          const data = await response.json();
          return data.translations || texts;
      } catch (error) {
          console.error('Translation error:', error);
          return texts;
      }
  }
  
  async function translatePage(targetLang) {
      if (targetLang === 'en') return;
      
      document.body.style.opacity = '0.7';
      
      const textNodes = [];
      const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          {
              acceptNode: function(node) {
                  const parent = node.parentElement;
                  if (parent && (
                      parent.tagName === 'SCRIPT' ||
                      parent.tagName === 'STYLE' ||
                      parent.hasAttribute('data-no-translate')
                  )) {
                      return NodeFilter.FILTER_REJECT;
                  }
                  
                  if (node.nodeValue && node.nodeValue.trim()) {
                      return NodeFilter.FILTER_ACCEPT;
                  }
                  return NodeFilter.FILTER_REJECT;
              }
          }
      );
      
      let node;
      while (node = walker.nextNode()) {
          textNodes.push(node);
      }
      
      const uniqueTexts = [...new Set(textNodes.map(n => n.nodeValue.trim()))];
      
      for (let i = 0; i < uniqueTexts.length; i += BATCH_SIZE) {
          const batch = uniqueTexts.slice(i, i + BATCH_SIZE);
          const translations = await translateBatch(batch, targetLang);
          
          const translationMap = new Map();
          batch.forEach((text, index) => {
              translationMap.set(text, translations[index]);
          });
          
          textNodes.forEach(node => {
              const originalText = node.nodeValue.trim();
              if (translationMap.has(originalText)) {
                  node.nodeValue = translationMap.get(originalText);
              }
          });
      }
      
      document.documentElement.lang = targetLang;
      document.documentElement.dir = targetLang === 'ar' ? 'rtl' : 'ltr';
      document.body.style.opacity = '1';
  }
  
  return { translatePage };
})();