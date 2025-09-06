// translation-cache.js - NO CACHING VERSION
const fs = require('fs').promises;
const path = require('path');

class TranslationCache {
    constructor() {
        console.log('Translation system initialized - NO CACHING');
    }

    // Main translation function - calls DeepL directly every time
    async translate(text, targetLang, context = '') {
        // Don't translate if already in English or if target is English
        if (!text || targetLang === 'en') return text;

        // Always call DeepL directly - NO CACHING
        console.log(`→ Translating to ${targetLang}: ${context || 'general'} (DIRECT CALL)`);
        
        try {
            // Get DeepL credentials from environment
            const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
            const DEEPL_ENDPOINT = 'https://api.deepl.com/v2/translate';
            
            if (!DEEPL_API_KEY) {
                throw new Error('DEEPL_API_KEY not configured');
            }

            // Build form data for DeepL
            const form = new URLSearchParams();
            form.append('text', text);
            form.append('target_lang', targetLang.toUpperCase());
            form.append('tag_handling', 'html');
            form.append('preserve_formatting', '1');
            form.append('split_sentences', 'nonewlines');

            // Call DeepL API directly
            const response = await fetch(DEEPL_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: form
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(`DeepL API error: ${response.status} - ${JSON.stringify(errorData)}`);
            }

            const data = await response.json();
            const translation = data?.translations?.[0]?.text || text;

            console.log(`✅ Translation completed for ${targetLang}`);
            return translation;
            
        } catch (error) {
            console.error('Translation error:', error.message);
            return text; // Return original on error
        }
    }

    // Translate multiple items - no caching
    async translateBatch(items, targetLang) {
        const results = [];
        for (const item of items) {
            const translated = await this.translate(
                item.text, 
                targetLang, 
                item.context || ''
            );
            results.push(translated);
        }
        return results;
    }

    // Dummy methods to maintain compatibility
    clearMemoryCache() {
        console.log('No cache to clear - using direct translation');
    }

    async getStats() {
        return {
            memoryCacheSize: 0,
            fileCacheSize: 0,
            mode: 'direct_translation_no_cache'
        };
    }

    // No-op methods for compatibility
    async get() { return null; }
    async set() { return; }
    async precache() { return; }
    async cleanupCache() { return; }
}

// Export singleton instance
module.exports = new TranslationCache();