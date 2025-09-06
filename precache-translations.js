// precache-translations.js
const translationCache = require('./translation-cache');

async function precacheCommonTexts() {
    const languages = ['zh', 'ar', 'ru', 'fr', 'es', 'de', 'it'];
    
    // Define all your common texts
    const commonTexts = {
        'form_title': 'Create Your Personalised Prospectus',
        'form_welcome': 'Welcome to More House School',
        'form_family_info': 'Family Information',
        'form_parent_name': 'Parent/Guardian Name',
        'form_first_name': "Daughter's First Name",
        'form_surname': 'Family Surname',
        'prospectus_title': 'Your Personalised Prospectus',
        'prospectus_welcome': 'Welcome to More House School',
        'prospectus_academics': 'Academic Excellence',
        'prospectus_pastoral': 'Pastoral Care',
        // Add all your static texts here
    };

    for (const lang of languages) {
        console.log(`\nPre-caching for ${lang}...`);
        await translationCache.precache(commonTexts, lang);
    }

    const stats = await translationCache.getStats();
    console.log('\n✅ Pre-caching complete!', stats);
}

// Run it
precacheCommonTexts();