// translation-cache.js
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class TranslationCache {
    constructor() {
        this.cacheDir = path.join(__dirname, 'cache', 'translations');
        this.memoryCache = new Map(); // Fast memory cache
        this.init();
    }

    async init() {
        try {
            await fs.mkdir(this.cacheDir, { recursive: true });
            console.log('✔ Translation cache initialized');
        } catch (error) {
            console.error('Cache init error:', error);
        }
    }

    // Generate a unique key for each translation
    getCacheKey(text, targetLang, context = '') {
        const content = `${text}_${targetLang}_${context}`;
        return crypto.createHash('md5').update(content).digest('hex').substring(0, 16);
    }

    // Get translation from cache
    async get(text, targetLang, context = '') {
        const key = this.getCacheKey(text, targetLang, context);
        
        // Check memory first (fastest)
        if (this.memoryCache.has(key)) {
            console.log(`✔ Memory cache hit: ${context || 'general'} → ${targetLang}`);
            return this.memoryCache.get(key);
        }

        // Check file cache
        try {
            const filePath = path.join(this.cacheDir, `${key}.json`);
            const data = await fs.readFile(filePath, 'utf8');
            const cached = JSON.parse(data);
            
            // Store in memory for next time
            this.memoryCache.set(key, cached.translation);
            console.log(`✔ File cache hit: ${context || 'general'} → ${targetLang}`);
            return cached.translation;
        } catch (error) {
            return null; // Not cached
        }
    }

    // Save translation to cache
    async set(text, translation, targetLang, context = '') {
        const key = this.getCacheKey(text, targetLang, context);
        
        // Save to memory
        this.memoryCache.set(key, translation);
        
        // Save to file
        try {
            const filePath = path.join(this.cacheDir, `${key}.json`);
            await fs.writeFile(filePath, JSON.stringify({
                original: text,
                translation: translation,
                language: targetLang,
                context: context,
                cachedAt: new Date().toISOString()
            }, null, 2));
        } catch (error) {
            console.error('Cache save error:', error);
        }
    }

    // Main translation function with caching - NOW CALLS DEEPL DIRECTLY
    async translate(text, targetLang, context = '') {
        // Don't translate if already in English or if target is English
        if (!text || targetLang === 'en') return text;

        // Check cache first
        const cached = await this.get(text, targetLang, context);
        if (cached) return cached;

        // Not cached - need to translate
        console.log(`→ Translating to ${targetLang}: ${context || 'general'}`);
        
        try {
            // Get DeepL credentials from environment
            const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
            const DEEPL_ENDPOINT = process.env.DEEPL_API_BASE || 'https://api.deepl.com/v2/translate';
            
            if (!DEEPL_API_KEY) {
                throw new Error('DEEPL_API_KEY not configured');
            }

            // Build form data for DeepL
            const form = new URLSearchParams();
            form.append('text', text);
            form.append('target_lang', targetLang.toUpperCase()); // e.g. FR, DE
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
            const translation = data?.translations?>[0]?.text || text;

            // Cache the translation
            await this.set(text, translation, targetLang, context);
            console.log(`💾 Cached new ${targetLang} translation for: ${context || 'general'}`);

            return translation;
        } catch (error) {
            console.error('Translation error:', error.message);
            return text; // Return original on error
        }
    }

    // Translate multiple items efficiently
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

    // Pre-cache common translations
    async precache(translations, targetLang) {
        let cached = 0;
        let translated = 0;

        for (const [context, text] of Object.entries(translations)) {
            const existing = await this.get(text, targetLang, context);
            if (existing) {
                cached++;
            } else {
                await this.translate(text, targetLang, context);
                translated++;
            }
        }

        console.log(`Pre-cache complete: ${cached} cached, ${translated} new translations`);
    }

    // Clear cache if needed
    clearMemoryCache() {
        this.memoryCache.clear();
        console.log('Memory cache cleared');
    }
    // Get cache statistics
    // Get cache statistics
    async getStats() {
        const files = await fs.readdir(this.cacheDir);
        return {
            memoryCacheSize: this.memoryCache.size,
            fileCacheSize: files.length,
            cacheDir: this.cacheDir
        };
    }
}



// Export singleton instance
module.exports = new TranslationCache();