const express = require('express');
const geoip = require("geoip-lite");
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();
const { Client } = require('pg');
const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const translationCache = require('./translation-cache');

const app = express();
const PORT = process.env.PORT || 3000;
let db = null;
let slugIndex = {};

app.use(require('express').json({ limit: '1mb' }));


// ===== GEO/IP helpers =====================================
app.set("trust proxy", true);

function getClientIp(req) {
  // Check Render-specific headers first
  const renderIp = req.headers['x-render-forwarded-for'] || req.headers['x-forwarded-for'];
  if (renderIp) {
    const ip = renderIp.split(',')[0].trim();
    return ip;
  }
  
  // Fallback to other headers
  const xfwd = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (req.headers["cf-connecting-ip"] || xfwd || req.headers["x-real-ip"] || req.ip || "").trim();
}

function enrichGeo(ip) {
  try {
    if (!ip) return {};
    if (ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("127.") || ip.startsWith("172.")) return {};
    const g = geoip.lookup(ip);
    if (!g) return {};
    const ll = Array.isArray(g.ll) ? g.ll : [];
    const lat = ll[0];
    const lon = ll[1];
    
    // Simplify to UK vs International for marketing purposes
    const country = g.country || null;
    let city = 'Unknown';
    
    if (country === 'GB') {
      city = 'United Kingdom';
    } else if (country) {
      // Use country name for international
      const countryNames = {
        'US': 'United States',
        'CA': 'Canada', 
        'AU': 'Australia',
        'DE': 'Germany',
        'FR': 'France',
        'ES': 'Spain',
        'IT': 'Italy',
        'NL': 'Netherlands'
      };
      city = countryNames[country] || country;
    }
    
    return { 
      country: country, 
      city: city,
      geo_lat: (lat ?? null), 
      geo_lon: (lon ?? null) 
    };
  } catch {
    return {};
  }
}

// Attach client IP & geo to every request
app.use((req, _res, next) => {
  req.clientIp = getClientIp(req);
  req.geo = enrichGeo(req.clientIp);
  next();
});

// ===================== DATABASE INITIALIZATION =====================
async function initializeDatabase() {
  const haveUrl = !!process.env.DATABASE_URL;
  const haveParts = !!(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);
  
  if (!haveUrl && !haveParts) {
    console.log('No DB credentials - running in JSON-only mode.');
    return false;
  }

  try {
    db = new Client({
      connectionString: process.env.DATABASE_URL || undefined,
      host: process.env.DB_HOST || undefined,
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
      database: process.env.DB_NAME || undefined,
      user: process.env.DB_USER || undefined,
      password: process.env.DB_PASSWORD || undefined,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 3000
    });
    
    await db.connect();
    console.log('Connected to Postgres');
    return true;
  } catch (e) {
    console.warn('Postgres connection failed:', e.message);
    console.warn('Continuing in JSON-only mode.');
    db = null;
    return false;
  }
}

// ===================== UTILITY FUNCTIONS =====================
function getBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

function generateInquiryId() {
  return `INQ-${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function sanitise(s, fallback) {
  return (s || fallback || '')
    .toString()
    .replace(/[^a-z0-9\- ]/gi, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function generateFilename(inquiry) {
  const date = new Date().toISOString().split('T')[0];
  const fam = sanitise(inquiry.familySurname, 'Family');
  const first = sanitise(inquiry.firstName, 'Student');
  return `More-House-School-${fam}-Family-${first}-${inquiry.entryYear}-${date}.html`;
}

function makeSlug(inquiry) {
  const familyName = (inquiry.familySurname || inquiry.family_surname || 'Family')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
    
  const shortId = String(inquiry.id || '')
    .replace(/[^a-z0-9]/gi, '')
    .slice(-6)
    .toLowerCase() || Math.random().toString(36).slice(-6);
    
  return `the-${familyName}-family-${shortId}`;
}

function pickNumber(n, dflt = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : dflt;
}

function calculateEngagementScore(engagement) {
  if (!engagement) return 0;
  let score = 0;
  
  const timeMinutes = (engagement.timeOnPage || engagement.time_on_page || 0) / 60;
  if (timeMinutes >= 30) score += 40;
  else if (timeMinutes >= 15) score += 30;
  else if (timeMinutes >= 5) score += 20;
  else score += Math.min(timeMinutes * 4, 15);
  
  const scrollDepth = engagement.scrollDepth || engagement.scroll_depth || 0;
  score += Math.min(scrollDepth * 0.3, 30);
  
  const visits = engagement.totalVisits || engagement.total_visits || 1;
  if (visits >= 7) score += 20;
  else if (visits >= 4) score += 15;
  else if (visits >= 2) score += 10;
  else score += 5;
  
  const clicks = engagement.clickCount || engagement.clicks_on_links || 0;
  score += Math.min(clicks * 2, 10);
  
  return Math.min(Math.round(score), 100);
}

function prettySectionName(id) {
  const PROSPECTUS_SECTION_NAMES = {
    cover_page: 'Cover Page',
    heads_welcome: "Head's Welcome",
    academic_excellence: 'Academic Excellence',
    about_more_house: 'About More House',
    day_in_the_life: 'A Day at More House',
    creative_arts_hero: 'Creative Arts',
    your_journey: 'Your Journey',
    london_extended_classroom: 'London Extended Classroom',
    city_curriculum_days: 'City Curriculum Days',
    values_hero: 'Values & Faith',
    ethical_leaders: 'Ethical Leaders',
    discover_video: 'Discover Video',
    cta_begin_your_journey: 'Begin Your Journey'
  };
  return PROSPECTUS_SECTION_NAMES[id] || (id ? id.replace(/_/g, ' ') : 'Unknown Section');
}

function formatHM(totalSeconds) {
  totalSeconds = Math.max(0, Math.floor(totalSeconds || 0));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

function extractInterests(inquiry) {
  const academic = [];
  const creative = [];
  
  if (inquiry.sciences) academic.push('Sciences');
  if (inquiry.mathematics) academic.push('Mathematics');
  if (inquiry.english) academic.push('English');
  if (inquiry.languages) academic.push('Languages');
  if (inquiry.humanities) academic.push('Humanities');
  if (inquiry.business) academic.push('Business');
  
  if (inquiry.drama) creative.push('Drama');
  if (inquiry.music) creative.push('Music');
  if (inquiry.art) creative.push('Art');
  if (inquiry.creative_writing) creative.push('Creative Writing');
  
  return { academic, creative };
}

function extractPriorities(inquiry) {
  const priorities = [];
  
  if (inquiry.academic_excellence) priorities.push('Academic Excellence');
  if (inquiry.pastoral_care) priorities.push('Pastoral Care');
  if (inquiry.university_preparation) priorities.push('University Preparation');
  if (inquiry.personal_development) priorities.push('Personal Development');
  if (inquiry.career_guidance) priorities.push('Career Guidance');
  if (inquiry.extracurricular_opportunities) priorities.push('Extracurricular Opportunities');
  
  return priorities;
}

function getGeolocation(ipAddress) {
  if (!ipAddress || ipAddress === '127.0.0.1' || ipAddress === '::1') {
    return {
      country: 'Unknown',
      region: 'Unknown', 
      city: 'Unknown',
      latitude: null,
      longitude: null,
      timezone: 'Europe/London',
      isp: 'Local'
    };
  }

  const geo = geoip.lookup(ipAddress);
  if (!geo) {
    return {
      country: 'Unknown',
      region: 'Unknown',
      city: 'Unknown', 
      latitude: null,
      longitude: null,
      timezone: 'Europe/London',
      isp: 'Unknown'
    };
  }

  return {
    country: geo.country || 'Unknown',
    region: geo.region || 'Unknown',
    city: geo.city || 'Unknown',
    latitude: geo.ll ? geo.ll[0] : null,
    longitude: geo.ll ? geo.ll[1] : null,
    timezone: geo.timezone || 'Europe/London',
    isp: 'Unknown'
  };
}

// ===================== FILE SYSTEM OPERATIONS =====================
async function ensureDirectories() {
  try {
    await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
    await fs.mkdir(path.join(__dirname, 'prospectuses'), { recursive: true });
  } catch (e) {
    console.error('Failed to create directories:', e.message);
    throw e;
  }
}

async function loadSlugIndex() {
  try {
    const p = path.join(__dirname, 'data', 'slug-index.json');
    slugIndex = JSON.parse(await fs.readFile(p, 'utf8'));
    console.log(`Loaded ${Object.keys(slugIndex).length} slug mappings`);
  } catch (e) {
    slugIndex = {};
    console.log('No slug-index.json yet; will create on first save.');
  }
}

async function saveSlugIndex() {
  try {
    const p = path.join(__dirname, 'data', 'slug-index.json');
    await fs.writeFile(p, JSON.stringify(slugIndex, null, 2));
  } catch (e) {
    console.error('Failed to save slug index:', e.message);
  }
}

async function saveInquiryJson(record) {
  try {
    const filename = `inquiry-${record.receivedAt}.json`;
    const p = path.join(__dirname, 'data', filename);
    await fs.writeFile(p, JSON.stringify(record, null, 2));
    return p;
  } catch (e) {
    console.error('Failed to save inquiry JSON:', e.message);
    throw e;
  }
}

async function findInquiryBySlug(slug) {
  try {
    if (db) {
      const result = await db.query('SELECT * FROM inquiries WHERE slug = $1 LIMIT 1', [slug]);
      if (result.rows.length > 0) {
        const row = result.rows[0];
        return {
          id: row.id,
          firstName: row.first_name,
          familySurname: row.family_surname,
          parentName: row.parent_name,        // ADD THIS
          parentEmail: row.parent_email,
          contactNumber: row.contact_number,  // ADD THIS
          ageGroup: row.age_group,
          entryYear: row.entry_year,
          hearAboutUs: row.hear_about_us,    // ADD THIS
          receivedAt: row.received_at,
          status: row.status,
          slug: row.slug
        };
      }
    }
    
    const files = await fs.readdir(path.join(__dirname, 'data'));
    for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
      try {
        const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
        if ((j.slug || '').toLowerCase() === slug) return j;
      } catch (fileError) {
        console.warn(`Failed to read ${f}:`, fileError.message);
      }
    }
  } catch (e) {
    console.warn('findInquiryBySlug error:', e.message);
  }
  
  return null;
}

async function rebuildSlugIndexFromData() {
  let added = 0;
  
  try {
    console.log('Rebuilding slug index...');
    const files = await fs.readdir(path.join(__dirname, 'data'));
    const js = files.filter(f => f.startsWith('inquiry-') && f.endsWith('.json'));
    
    for (const f of js) {
      try {
        const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
        
        let slug = j.slug;
        if (!slug) {
          slug = makeSlug(j);
          j.slug = slug;
          await fs.writeFile(path.join(__dirname, 'data', f), JSON.stringify(j, null, 2));
          console.log(`Generated missing slug for ${j.firstName} ${j.familySurname}: ${slug}`);
        }
        
        slug = slug.toLowerCase();
        let rel = j.prospectusUrl;
        if (!rel && j.prospectusFilename) {
          rel = `/prospectuses/${j.prospectusFilename}`;
        }
        
        if (rel && !slugIndex[slug]) {
          slugIndex[slug] = rel;
          added++;
        }
      } catch (fileError) {
        console.warn(`Skipped ${f}: ${fileError.message}`);
      }
    }
    
    if (added > 0) {
      await saveSlugIndex();
      console.log(`Saved ${added} new slug mappings to slug-index.json`);
    }
    
    console.log(`Slug index rebuilt: ${added} new mappings, ${Object.keys(slugIndex).length} total`);
    return added;
  } catch (e) {
    console.error('rebuildSlugIndexFromData error:', e.message);
    return 0;
  }
}

// ===================== PROSPECTUS GENERATION =====================
async function generateProspectus(inquiry) {
  try {
    console.log(`Generating prospectus for ${inquiry.firstName} ${inquiry.familySurname}`);
    const templatePath = path.join(__dirname, 'public', 'prospectus_template.html');
    let html = await fs.readFile(templatePath, 'utf8');
    
    // ============= NEW TRANSLATION SECTION =============
    const language = inquiry.language || 'en';
    console.log(`📌 Language requested: ${language}`);
    
    if (language !== 'en') {
      console.log(`🌐 Translating prospectus to ${language}...`);
      
      // Define texts to translate with their contexts
      const textsToTranslate = [
        { text: "Your Personalised Prospectus", context: "title" },
        { text: "Welcome to More House School", context: "welcome" },
        { text: "An Independent Day School for Girls aged 11-18", context: "subtitle" },
        { text: "Academic Excellence", context: "academics" },
        { text: "Pastoral Care", context: "pastoral" },
        { text: "Discover More", context: "cta" },
        { text: "Our Mission", context: "mission" },
        { text: "Your Journey Starts Here", context: "journey" }
      ];
      
      // Translate all static texts
      for (const item of textsToTranslate) {
        const translated = await translationCache.translate(
          item.text,
          language,
          `prospectus_${item.context}`
        );
        html = html.replace(new RegExp(item.text, 'g'), translated);
      }
      
      // Translate interest-specific sections if selected
      if (inquiry.sciences) {
        const scienceText = "Science and Discovery";
        const translated = await translationCache.translate(scienceText, language, "interest_sciences");
        html = html.replace(scienceText, translated);
      }
      
      if (inquiry.mathematics) {
        const mathText = "Mathematics Excellence";
        const translated = await translationCache.translate(mathText, language, "interest_math");
        html = html.replace(mathText, translated);
      }
      
      if (inquiry.drama) {
        const dramaText = "Drama and Performance";
        const translated = await translationCache.translate(dramaText, language, "interest_drama");
        html = html.replace(dramaText, translated);
      }
      
      if (inquiry.music) {
        const musicText = "Music and Creativity";
        const translated = await translationCache.translate(musicText, language, "interest_music");
        html = html.replace(musicText, translated);
      }
      
      if (inquiry.sport) {
        const sportText = "Sports and Wellbeing";
        const translated = await translationCache.translate(sportText, language, "interest_sport");
        html = html.replace(sportText, translated);
      }
      
      console.log(`✅ Translation complete for ${language}`);
    }
    // ============= END TRANSLATION SECTION =============
    
    const filename = generateFilename(inquiry);
    const relPath = `/prospectuses/${filename}`;
    const absPath = path.join(__dirname, 'prospectuses', filename);
    
    // Add meta tags for tracking (updated with language)
    const meta = `
<meta name="inquiry-id" content="${inquiry.id}">
<meta name="generated-date" content="${new Date().toISOString()}">
<meta name="student-name" content="${inquiry.firstName} ${inquiry.familySurname}">
<meta name="entry-year" content="${inquiry.entryYear}">
<meta name="age-group" content="${inquiry.ageGroup}">
<meta name="language" content="${language}">`;
    
    html = html.replace('</head>', `${meta}\n</head>`);
    
    // Update page title
    const title = `${inquiry.firstName} ${inquiry.familySurname} - More House School Prospectus ${inquiry.entryYear}`;
    html = html.replace(/<title>.*?<\/title>/, `<title>${title}</title>`);
    
    // CRITICAL: Replace the OLD tracking script in template with NEW simple tracking
    const newTrackingScript = `
<!-- Simple Tracking Script -->
<script>
// Set inquiry ID for tracking
window.MORE_HOUSE_INQUIRY_ID = '${inquiry.id}';
console.log('Prospectus tracking initialized for:', '${inquiry.id}');
</script>
<script>
${await fs.readFile(path.join(__dirname, 'public', 'tracking.js'), 'utf8')}
</script>`;

    // Inject personalisation payload + initialise the page (updated with language)
    const personalizationBootstrap = `
<script>
  // Make the inquiry data available to the prospectus template
  window.PROSPECTUS_DATA = ${JSON.stringify({
    id: inquiry.id,
    firstName: inquiry.firstName,
    familySurname: inquiry.familySurname,
    parentEmail: inquiry.parentEmail,
    ageGroup: inquiry.ageGroup,
    entryYear: inquiry.entryYear,
    language: language,  // Added language field
    sciences: !!inquiry.sciences,
    mathematics: !!inquiry.mathematics,
    english: !!inquiry.english,
    languages: !!inquiry.languages,
    humanities: !!inquiry.humanities,
    business: !!inquiry.business,
    drama: !!inquiry.drama,
    music: !!inquiry.music,
    art: !!inquiry.art,
    creative_writing: !!inquiry.creative_writing,
    sport: !!inquiry.sport,
    leadership: !!inquiry.leadership,
    community_service: !!inquiry.community_service,
    outdoor_education: !!inquiry.outdoor_education,
    academic_excellence: !!inquiry.academic_excellence,
    pastoral_care: !!inquiry.pastoral_care,
    university_preparation: !!inquiry.university_preparation,
    personal_development: !!inquiry.personal_development,
    career_guidance: !!inquiry.career_guidance,
    extracurricular_opportunities: !!inquiry.extracurricular_opportunities
  })};

  // Call the template's initialiser when available
  (function startPersonalisation(){
    if (typeof window.initializeProspectus === 'function') {
      window.initializeProspectus(window.PROSPECTUS_DATA);
    } else {
      setTimeout(startPersonalisation, 50);
    }
  })();
  
  // Set language selector if present AND trigger translation
  const langSelector = document.getElementById('prospectus-lang');
  if (langSelector && '${language}' !== 'en') {
    langSelector.value = '${language}';
    // Trigger change event to activate translation
    setTimeout(() => {
      const event = new Event('change', { bubbles: true });
      langSelector.dispatchEvent(event);
    }, 500); // Small delay to ensure translator.js is loaded
  }
</script>`;
    
    // Find the body closing tag and inject BEFORE it
    const bodyCloseIndex = html.lastIndexOf('</body>');
    if (bodyCloseIndex === -1) {
      throw new Error('Template missing </body> tag');
    }
    
    html = html.slice(0, bodyCloseIndex)
      + newTrackingScript
      + personalizationBootstrap
      + '\n'
      + html.slice(bodyCloseIndex);
    
    // Write the final HTML file
    await fs.writeFile(absPath, html, 'utf8');
    
    // Create pretty URL slug
    const slug = makeSlug(inquiry);
    const prettyPath = `/${slug}`;
    slugIndex[slug] = relPath;
    await saveSlugIndex();
    
    console.log(`✅ Prospectus generated: ${filename}`);
    console.log(`🔗 Pretty URL: ${prettyPath}`);
    console.log(`📊 Tracking ID: ${inquiry.id}`);
    console.log(`🌐 Language: ${language}`);
    
    return {
      filename,
      url: relPath,
      slug,
      prettyPath,
      language,  // Added language to return object
      generatedAt: new Date().toISOString()
    };
  } catch (e) {
    console.error('Prospectus generation failed:', e.message);
    throw new Error(`Prospectus generation error: ${e.message}`);
  }
}

async function updateInquiryStatus(inquiryId, pInfo) {
  try {
    const files = await fs.readdir(path.join(__dirname, 'data'));
    for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
      try {
        const p = path.join(__dirname, 'data', f);
        const j = JSON.parse(await fs.readFile(p, 'utf8'));
        if (j.id === inquiryId) {
          j.prospectusGenerated = true;
          j.prospectusFilename = pInfo.filename;
          j.prospectusUrl = pInfo.url;          
          j.prospectusPrettyPath = pInfo.prettyPath;   
          j.slug = pInfo.slug;
          j.prospectusGeneratedAt = pInfo.generatedAt;
          j.status = 'prospectus_generated';
          await fs.writeFile(p, JSON.stringify(j, null, 2));
          break;
        }
      } catch (fileError) {
        console.warn(`Failed to update ${f}:`, fileError.message);
      }
    }
    
    if (db) {
      try {
        await db.query(
          `UPDATE inquiries
           SET status='prospectus_generated',
               prospectus_generated=true,
               prospectus_filename=$2,
               prospectus_url=$3,
               slug=$4,
               prospectus_generated_at=$5,
               updated_at=CURRENT_TIMESTAMP
           WHERE id=$1`,
          [inquiryId, pInfo.filename, pInfo.url, pInfo.slug, new Date(pInfo.generatedAt)]
        );
        console.log(`Database updated: ${inquiryId} -> ${pInfo.prettyPath}`);
      } catch (dbError) {
        console.warn('DB update failed (non-fatal):', dbError.message);
      }
    }
  } catch (e) {
    console.error('Failed to update inquiry status:', e.message);
  }
}

// ===================== ENGAGEMENT TRACKING =====================
async function trackEngagementEvent(ev) {
  if (!db) return null;
  
  try {
    console.log('RECEIVED EVENT:', ev.eventType || ev.type, 'VideoID:', ev.eventData?.videoId, 'VideoTitle:', ev.eventData?.videoTitle);
  
    const eventType = ev.eventType || ev.type || 'unknown';
    const inquiryId = ev.inquiryId || ev.inquiry_id || null;
    const sessionId = ev.sessionId || ev.session_id || null;
    const currentSection = ev.currentSection || ev.section || ev?.eventData?.currentSection || null;
    const tsISO = ev.timestamp || new Date().toISOString();
    const pageUrl = ev.url || null;
    const deviceInfo = ev.deviceInfo || ev?.eventData?.deviceInfo || {};
    const ed = Object.assign({}, ev.eventData || ev.data || {});
    const timeInSectionSec = pickNumber(ed.timeInSectionSec);
    
    let sessionTime = 0;
    if (ev.sessionInfo && Number.isFinite(ev.sessionInfo.timeOnPage)) {
      sessionTime = Math.round(ev.sessionInfo.timeOnPage);
    }
    
    const maxScrollPct = pickNumber(ed.maxScrollPct);
    const clicks = pickNumber(ed.clicks);
    const videoWatchSec = pickNumber(ed.videoWatchSec);
    const videoId = ed.videoId || ed.video_id || null;
    const videoTitle = ed.videoTitle || ed.video_title || null;
    const currentTimeSec = pickNumber(ed.currentTimeSec ?? ed.current_time_sec);
    
    const rawEventData = {
      ...ed,
      currentSection: currentSection,
      deviceInfo,
      sessionTimeOnPage: sessionTime
    };
    
    const insertRaw = `
      INSERT INTO tracking_events (
        inquiry_id, event_type, event_data, page_url,
        user_agent, ip_address, session_id, timestamp
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `;
    
    const rawVals = [
      inquiryId,
      eventType,
      JSON.stringify(rawEventData),
      pageUrl,
      deviceInfo.userAgent || ev.userAgent || null,
      ev.ip || null,
      sessionId,
      new Date(tsISO)
    ];
    
    await db.query(insertRaw, rawVals).catch(e => {
      console.warn('tracking_events insert failed:', e.message);
    });
    
    const hasSectionMetrics = (eventType === 'section_exit') || (eventType === 'section_scroll');
    const hasClicks = clicks > 0;
    const hasVideo = eventType.startsWith('video_') || videoWatchSec > 0;
    
    if (hasSectionMetrics || hasClicks || hasVideo) {
      await updateEngagementMetrics({
        inquiryId,
        sessionId,
        timeOnPage: sessionTime || timeInSectionSec,
        maxScrollDepth: maxScrollPct,
        clickCount: clicks,
        deviceInfo
      });      
    }
    
    if (hasVideo && videoId) {
      console.log('Inserting video tracking row:', {
        inquiryId,
        videoId,
        videoTitle,
        watchedSec: videoWatchSec
      });
      
      await insertVideoTrackingRow(db, {
        inquiryId,
        sessionId,
        currentSection,
        eventType,
        videoId,
        videoTitle,
        currentTimeSec,
        watchedSec: videoWatchSec,
        url: pageUrl,
        timestamp: tsISO
      });
    }
    
    return { ok: true };
  } catch (e) {
    console.warn('trackEngagementEvent failed:', e.message);
    return null;
  }
}

async function updateEngagementMetrics(m) {
  try {
    const q = `
      INSERT INTO engagement_metrics (
        inquiry_id, prospectus_filename, time_on_page, pages_viewed,
        scroll_depth, clicks_on_links, session_id, device_type,
        browser, operating_system, last_visit
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (inquiry_id, session_id) DO UPDATE SET
        time_on_page   = GREATEST(engagement_metrics.time_on_page, EXCLUDED.time_on_page),
        scroll_depth   = GREATEST(engagement_metrics.scroll_depth, EXCLUDED.scroll_depth),
        clicks_on_links= GREATEST(engagement_metrics.clicks_on_links, EXCLUDED.clicks_on_links),
        pages_viewed   = engagement_metrics.pages_viewed + 1,
        last_visit     = EXCLUDED.last_visit,
        total_visits   = engagement_metrics.total_visits + 1
      RETURNING *`;
      
    const d = m.deviceInfo || {};
    const vals = [
      m.inquiryId, m.prospectusFilename || null,
      Math.round(m.timeOnPage || 0), m.pageViews || 1,
      Math.round(m.maxScrollDepth || 0), m.clickCount || 0,
      m.sessionId || null, d.deviceType || 'unknown',
      d.browser || 'unknown', d.operatingSystem || 'unknown',
      new Date()
    ];
    
    const r = await db.query(q, vals);
    return r.rows[0];
  } catch (e) {
    console.warn('updateEngagementMetrics failed:', e.message);
  }
}

async function insertVideoTrackingRow(dbClient, payload) {
  try {
    console.log('Video tracking insert attempt:', payload);
    
    const q = `
      INSERT INTO video_engagement_tracking (
        inquiry_id, session_id, section_label, event_type,
        video_id, video_title, current_time_sec, watched_sec,
        page_url, timestamp
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `;
    
    const vals = [
      payload.inquiryId || null,
      payload.sessionId || null,
      payload.currentSection || null,
      payload.eventType || 'video_event',
      payload.videoId || null,
      payload.videoTitle || 'Unknown Video',
      Math.round(payload.currentTimeSec || 0),
      Math.round(payload.watchedSec || 0),
      payload.url || null,
      new Date(payload.timestamp || Date.now())
    ];
    
    console.log('Video tracking SQL values:', vals);
    
    const result = await dbClient.query(q, vals);
    console.log('Video tracking inserted successfully');
    return result;
  } catch (e) {
    console.error('Video tracking insert failed:', e.message);
    console.error('Payload was:', payload);
  }
}

// ===================== AI ENGAGEMENT ANALYSIS =====================
async function buildEngagementSnapshot(db, inquiryId) {
  try {
    const eventCheck = await db.query(
      'SELECT COUNT(*) as count FROM tracking_events WHERE inquiry_id = $1',
      [inquiryId]
    );
    const eventCount = parseInt(eventCheck.rows[0]?.count || '0');
    
    if (eventCount === 0) {
      const inquiryData = await db.query(
        'SELECT dwell_ms, return_visits FROM inquiries WHERE id = $1',
        [inquiryId]
      );
      
      const dwellMs = parseInt(inquiryData.rows[0]?.dwell_ms || '0');
      const visits = parseInt(inquiryData.rows[0]?.return_visits || '1');
      
      return {
        sections: [],
        totals: {
          time_on_page_ms: dwellMs,
          video_ms: 0,
          clicks: 0,
          total_visits: visits,
          scroll_depth: 0
        },
        hasData: dwellMs > 0
      };
    }
    
    const secExit = await db.query(`
      SELECT
        COALESCE(event_data->>'currentSection', 'unknown') AS section_id,
        SUM(COALESCE((event_data->>'timeInSectionSec')::int, 0)) AS dwell_sec,
        MAX(COALESCE((event_data->>'maxScrollPct')::int, 0)) AS max_scroll_pct,
        COUNT(DISTINCT CASE WHEN event_type = 'link_click' THEN event_data->>'linkId' END) AS clicks,
        SUM(COALESCE((event_data->>'videoWatchSec')::int, 0)) AS video_sec
      FROM tracking_events
      WHERE inquiry_id = $1
        AND event_type IN ('section_exit_enhanced', 'section_exit', 'link_click', 'youtube_video_progress')
      GROUP BY 1
    `, [inquiryId]);
    
    const visitCount = await db.query(`
      SELECT COUNT(DISTINCT session_id) as total_visits
      FROM tracking_events
      WHERE inquiry_id = $1
    `, [inquiryId]);
    
    const inquiryDwell = await db.query(
      'SELECT dwell_ms FROM inquiries WHERE id = $1',
      [inquiryId]
    );
    
    const storedDwellMs = parseInt(inquiryDwell.rows[0]?.dwell_ms || '0');
    
    const sections = secExit.rows.map(row => ({
      section_id: row.section_id,
      section: row.section_id,
      dwell_seconds: parseInt(row.dwell_sec || 0),
      dwell_ms: parseInt(row.dwell_sec || 0) * 1000,
      max_scroll_pct: parseInt(row.max_scroll_pct || 0),
      clicks: parseInt(row.clicks || 0),
      video_seconds: parseInt(row.video_sec || 0),
      video_ms: parseInt(row.video_sec || 0) * 1000
    }));
    
    const calculatedDwell = sections.reduce((sum, s) => sum + (s.dwell_seconds * 1000), 0);
    const totalDwellMs = Math.max(calculatedDwell, storedDwellMs);
    
    const totals = {
      time_on_page_ms: totalDwellMs,
      video_ms: sections.reduce((sum, s) => sum + s.video_ms, 0),
      clicks: sections.reduce((sum, s) => sum + s.clicks, 0),
      total_visits: parseInt(visitCount.rows[0]?.total_visits || 0),
      scroll_depth: sections.length > 0 
        ? Math.round(sections.reduce((sum, s) => sum + s.max_scroll_pct, 0) / sections.length)
        : 0
    };
    
        // --- Baseline guards: never show zero time if there were visits ---
    // Use DB-stored return_visits when event data is sparse
    if (!totals.total_visits || totals.total_visits === 0) {
      const rvRow = await db.query(
        'SELECT COALESCE(return_visits, 0) AS rv FROM inquiries WHERE id = $1',
        [inquiryId]
      );
      totals.total_visits = parseInt(rvRow.rows[0]?.rv || '0', 10);
    }

    // If we still have visits but zero time, assume minimum 60s per visit
    if ((totals.total_visits || 0) > 0 && (!totals.time_on_page_ms || totals.time_on_page_ms === 0)) {
      totals.time_on_page_ms = totals.total_visits * 60000;
    }

    return {
      sections,
      totals,
      hasData: totalDwellMs > 0 || sections.length > 0 || eventCount > 0
    };
  } catch (error) {
    console.error('Error building engagement snapshot:', error);
    return {
      sections: [],
      totals: {
        time_on_page_ms: 0,
        video_ms: 0,
        clicks: 0,
        total_visits: 0,
        scroll_depth: 0
      },
      hasData: false
    };
  }
}

function topInteractionsFrom(sections, n = 5) {
  return [...sections]
    .sort((a,b) =>
      (b.dwell_ms - a.dwell_ms) ||
      (b.video_ms - a.video_ms) ||
      (b.clicks - a.clicks))
    .slice(0, n)
    .map(s => ({
      label: s.section,
      dwell_seconds: Math.round((s.dwell_ms || 0)/1000),
      video_seconds: Math.round((s.video_ms || 0)/1000),
      clicks: Number(s.clicks || 0)
    }));
}

async function generateAiEngagementStory(snapshot, meta = {}) {
  const tops = topInteractionsFrom(snapshot.sections || [], 5);
  const totalSec = Math.round((snapshot.totals?.time_on_page_ms || 0) / 1000);
  const videoSec = Math.round((snapshot.totals?.video_ms || 0) / 1000);
  const clicks = Number(snapshot.totals?.clicks || 0);
  const visits = Number(snapshot.totals?.total_visits || 0);
  const childName = [meta.first_name, meta.family_surname].filter(Boolean).join(' ');
  
  const prompt = `
You are an admissions assistant. In UK English, write a concise, human-friendly narrative (120–180 words) explaining how a family engaged with a personalised school prospectus. Be factual, warm, and readable—like a colleague explaining what's happening. Avoid marketing fluff.

Include: what they kept coming back to, which sections/videos held attention, and what this suggests about interests or next steps. If data is light, say so plainly without guessing.

Context (data):
- Child/family: ${childName || '(not provided)'}
- Entry year: ${meta.entry_year || '(not provided)'}
- Total time on prospectus (sec): ${totalSec}
- Total video watch time (sec): ${videoSec}
- Total clicks: ${clicks}
- Total visits: ${visits || '(unknown)'}
- Top sections by engagement (up to 5):
${tops.length ? tops.map(t => `  - ${t.label}: dwell ${t.dwell_seconds}s, video ${t.video_seconds}s, clicks ${t.clicks}`).join('\n') : '  - (no detailed sections available)'}

Return STRICT JSON:
{
  "narrative": "A 120–180 word paragraph in UK English.",
  "highlights": ["Up to five short, factual bullets."]
}
`.trim();

  try {
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    
    if (hasAnthropic) {
      const { Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const resp = await client.messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20240620',
        temperature: 0.2,
        max_tokens: 700,
        messages: [{ role: 'user', content: prompt }]
      });
      
      const text = resp?.content?.[0]?.text || '{}';
      return JSON.parse(text);
    }
    
    if (process.env.OPENAI_API_KEY) {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const chat = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }]
      });
      
      const text = chat?.choices?.[0]?.message?.content || '{}';
      return JSON.parse(text);
    }
    
    throw new Error('No AI API keys configured');
  } catch (e) {
    console.error('AI generation failed:', e.message);
    return {
      narrative: "Prospectus generated. Limited tracking available so far. Once more interaction is recorded — such as time spent on key sections or video watch time — a fuller summary will appear here.",
      highlights: ["No detailed section data yet", "Invite the family to view key pages", "Follow up with a light-touch email"]
    };
  }
}

async function upsertAiInsight(db, inquiryId, analysisType, insightsJson) {
  try {
    await db.query(`
      INSERT INTO ai_family_insights (inquiry_id, analysis_type, insights_json)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (inquiry_id, analysis_type)
      DO UPDATE SET insights_json = EXCLUDED.insights_json
    `, [inquiryId, analysisType, JSON.stringify(insightsJson)]);
  } catch (e) {
    console.error('Failed to upsert AI insight:', e.message);
  }
}

async function summariseFamilyEngagement(db, inquiry) {
  const inquiryId = inquiry.id || inquiry.inquiry_id;
  
  try {
    const snapshot = await buildEngagementSnapshot(db, inquiryId);
    let result;
    
    const totalTimeMs = snapshot.totals.time_on_page_ms || 0;
    const hasAnyEngagement = totalTimeMs > 0 || snapshot.sections.length > 0;
    
    if (!hasAnyEngagement) {
      result = {
        narrative: `Personalised prospectus created for ${inquiry.first_name || 'this student'} ${inquiry.family_surname || ''} (${inquiry.entry_year || 'entry year TBC'}). The family hasn't viewed their prospectus yet, but we're ready to track their journey as soon as they begin exploring. Once they start engaging with sections and videos, we'll provide detailed insights about their interests and priorities.`,
        highlights: [
          '• Prospectus successfully generated and ready',
          '• Unique link created for family access',
          '• Awaiting first visit to begin engagement tracking',
          '• Full analytics will activate upon first interaction'
        ]
      };
    } else if (totalTimeMs < 30000) {
      const timeStr = Math.round(totalTimeMs / 1000) + ' seconds';
      result = {
        narrative: `${inquiry.first_name || 'This student'}'s family has just started exploring their personalised prospectus, spending ${timeStr} so far. This initial glimpse suggests they've discovered the materials but haven't yet had time for a thorough review. Early engagement is promising - families who return within 48 hours typically show strong interest. A gentle follow-up reminding them to explore key sections could encourage deeper engagement.`,
        highlights: [
          `• Initial visit recorded: ${timeStr} of browsing`,
          '• Prospectus discovery phase - early engagement detected',
          '• Follow-up recommended within 24-48 hours',
          '• Watch for return visits as key interest indicator'
        ]
      };
    } else {
      try {
        console.log(`Generating AI summary for ${inquiry.first_name} ${inquiry.family_surname} with ${Math.round(totalTimeMs/1000)}s engagement`);
        const aiPayload = await generateAiEngagementStory(snapshot, {
          first_name: inquiry.first_name,
          family_surname: inquiry.family_surname,
          entry_year: inquiry.entry_year
        });
        
        if (aiPayload && aiPayload.narrative && !aiPayload.narrative.includes('Limited tracking')) {
          result = {
            narrative: aiPayload.narrative,
            highlights: Array.isArray(aiPayload.highlights) ? aiPayload.highlights : generateFallbackHighlights(snapshot)
          };
        } else {
          result = generateDeterministicSummary(snapshot, inquiry);
        }
      } catch (aiError) {
        console.warn('AI generation failed, using deterministic summary:', aiError.message);
        result = generateDeterministicSummary(snapshot, inquiry);
      }
    }
    
    await upsertAiInsight(db, inquiryId, 'engagement_summary', result);
    console.log(`AI summary generated for ${inquiry.first_name} ${inquiry.family_surname}: "${result.narrative.substring(0, 60)}..."`);
    
    return result;
  } catch (error) {
    console.error('summariseFamilyEngagement error:', error);
    const fallbackResult = {
      narrative: `Prospectus prepared for ${inquiry.first_name || 'this student'} ${inquiry.family_surname || ''}. Engagement tracking is active and will provide insights as the family explores their personalised materials.`,
      highlights: [
        '• Prospectus ready for viewing',
        '• Tracking system active',
        '• Awaiting engagement data'
      ]
    };
    
    await upsertAiInsight(db, inquiryId, 'engagement_summary', fallbackResult);
    return fallbackResult;
  }
}

function generateDeterministicSummary(snapshot, inquiry) {
  const totalMinutes = Math.round(snapshot.totals.time_on_page_ms / 60000);
  const totalSeconds = Math.round(snapshot.totals.time_on_page_ms / 1000);
  const name = `${inquiry.first_name || 'This student'} ${inquiry.family_surname || ''}`.trim();
  const visits = snapshot.totals.total_visits || 1;
  
  let narrative = `${name}'s family spent ${totalMinutes > 0 ? totalMinutes + ' minutes' : totalSeconds + ' seconds'} exploring their personalised prospectus`;
  
  if (visits > 1) {
    narrative += ` across ${visits} visits`;
  }
  narrative += '. ';
  
  if (snapshot.sections && snapshot.sections.length > 0) {
    const topSections = snapshot.sections
      .filter(s => s.dwell_ms > 1000)
      .slice(0, 3)
      .map(s => s.section_id ? s.section_id.replace(/_/g, ' ') : 'unknown section');
      
    if (topSections.length > 0) {
      narrative += `They showed particular interest in ${topSections.join(', ')}, `;
    }
  }
  
  narrative += `indicating genuine engagement with More House. This level of attention suggests they're seriously considering the school. A personalised follow-up discussing their specific interests would be valuable.`;
  
  const highlights = [
    `• Total engagement: ${totalMinutes > 0 ? totalMinutes + ' minutes' : totalSeconds + ' seconds'}`,
    `• ${snapshot.sections.length} sections explored`,
    visits > 1 ? `• ${visits} visits showing sustained interest` : '• Thorough initial exploration',
    '• Ready for targeted follow-up conversation',
    '• Strong engagement indicates serious interest'
  ];
  
  return { narrative, highlights };
}

function generateFallbackHighlights(snapshot) {
  const totalMinutes = Math.round(snapshot.totals.time_on_page_ms / 60000);
  const highlights = [];
  
  highlights.push(`• Total engagement: ${totalMinutes} minutes across ${snapshot.totals.total_visits} visit(s)`);
  
  if (snapshot.sections.length > 0) {
    const top = snapshot.sections.slice(0, 2);
    top.forEach(s => {
      const mins = Math.round(s.dwell_seconds / 60);
      if (mins > 0) {
        highlights.push(`• Focused on ${s.section_id.replace(/_/g, ' ')}: ${mins} minutes`);
      }
    });
  }
  
  if (snapshot.totals.clicks > 0) {
    highlights.push(`• Interactive engagement: ${snapshot.totals.clicks} click(s) on key content`);
  }
  
  if (snapshot.totals.total_visits > 1) {
    highlights.push(`• Return visitor - showing sustained interest`);
  }
  
  while (highlights.length < 3) {
    highlights.push('• Ready for personalised follow-up');
  }
  
  return highlights.slice(0, 5);
}

async function analyzeFamily(inquiry, engagementData) {
  try {
    console.log(`Analyzing family: ${inquiry.firstName} ${inquiry.familySurname}`);
    
    const familyContext = {
      name: `${inquiry.firstName} ${inquiry.familySurname}`,
      ageGroup: inquiry.ageGroup,
      entryYear: inquiry.entryYear,
      parentEmail: inquiry.parentEmail,
      interests: extractInterests(inquiry),
      priorities: extractPriorities(inquiry),
      engagement: engagementData ? {
        timeOnPage: engagementData.time_on_page || 0,
        scrollDepth: engagementData.scroll_depth || 0,
        totalVisits: engagementData.total_visits || 1,
        clickCount: engagementData.clicks_on_links || 0,
        lastVisit: engagementData.last_visit
      } : null
    };
    
    const engagementScore = calculateEngagementScore(familyContext.engagement);
    
    const prompt = `As an expert education consultant for More House School, analyze this family's profile and provide actionable insights for our admissions team.

FAMILY PROFILE:
- Student: ${familyContext.name}
- Age Group: ${familyContext.ageGroup}
- Entry Year: ${familyContext.entryYear}
- Academic Interests: ${familyContext.interests.academic.join(', ') || 'None specified'}
- Creative Interests: ${familyContext.interests.creative.join(', ') || 'None specified'}
- Family Priorities: ${familyContext.priorities.join(', ') || 'None specified'}

${familyContext.engagement ? `
ENGAGEMENT DATA:
- Time spent: ${Math.round(familyContext.engagement.timeOnPage / 60)} minutes
- Content engagement: ${familyContext.engagement.scrollDepth}% scroll depth
- Visit frequency: ${familyContext.engagement.totalVisits} visits
- Interaction count: ${familyContext.engagement.clickCount} clicks
- Engagement score: ${engagementScore}/100
- Last active: ${familyContext.engagement.lastVisit ? new Date(familyContext.engagement.lastVisit).toLocaleDateString() : 'Unknown'}
` : 'ENGAGEMENT DATA: No tracking data available yet'}

Based on this information, provide insights that will help our admissions team prioritize and personalize their approach.

RESPOND ONLY WITH VALID JSON IN THIS EXACT FORMAT:
{
  "leadScore": 75,
  "urgencyLevel": "high",
  "leadTemperature": "hot",
  "conversationStarters": [
    "Discuss our exceptional science facilities and laboratories",
    "Explore how our small class sizes support individual learning"
  ],
  "sellingPoints": [
    "Outstanding STEM program with modern laboratories",
    "Individual attention with 8:1 student-teacher ratio"
  ],
  "nextActions": [
    "Schedule immediate phone call within 24 hours",
    "Send personalized science department brochure"
  ],
  "insights": {
    "studentProfile": "Science-focused student with strong academic potential",
    "familyPriorities": "Academic excellence and individual attention",
    "engagementPattern": "Highly engaged - spent significant time on academic sections",
    "recommendedApproach": "Lead with academic strengths and science opportunities"
  },
  "keyObservations": [
    "Strong interest in STEM subjects",
    "Family values academic excellence",
    "High engagement suggests serious consideration"
  ],
  "confidence": 0.92
}

DO NOT INCLUDE ANY TEXT OUTSIDE THE JSON OBJECT.`;

    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      try {
        attempts++;
        console.log(`Claude API call attempt ${attempts}/${maxAttempts} for ${inquiry.id}`);
        
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2000,
            messages: [
              { role: "user", content: prompt }
            ]
          })
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Claude API HTTP ${response.status}: ${errorText}`);
        }
        
        const data = await response.json();
        let responseText = data.content[0].text;
        responseText = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        
        const analysis = JSON.parse(responseText);
        
        if (!analysis.leadScore || !analysis.urgencyLevel) {
          throw new Error('Invalid analysis response - missing required fields');
        }
        
        console.log(`Claude analysis completed for ${inquiry.id} (score: ${analysis.leadScore})`);
        
        return {
          leadScore: analysis.leadScore || 50,
          urgencyLevel: analysis.urgencyLevel || 'medium',
          leadTemperature: analysis.leadTemperature || 'warm',
          conversationStarters: analysis.conversationStarters || [],
          sellingPoints: analysis.sellingPoints || [],
          nextActions: analysis.nextActions || [],
          insights: analysis.insights || {},
          keyObservations: analysis.keyObservations || [],
          confidence_score: analysis.confidence || 0.5,
          recommendations: analysis.conversationStarters || [],
          engagementScore: engagementScore,
          analysisDate: new Date().toISOString()
        };
      } catch (error) {
        console.warn(`Claude API attempt ${attempts} failed for ${inquiry.id}:`, error.message);
        if (attempts >= maxAttempts) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
      }
    }
  } catch (error) {
    console.error(`Family analysis failed for ${inquiry.id}:`, error.message);
    
    const engagementScore = calculateEngagementScore(engagementData);
    
    return {
      leadScore: Math.max(engagementScore, 25),
      urgencyLevel: engagementScore > 70 ? 'high' : engagementScore > 40 ? 'medium' : 'low',
      leadTemperature: engagementScore > 70 ? 'hot' : engagementScore > 40 ? 'warm' : 'cold',
      conversationStarters: ['Follow up on their inquiry', 'Discuss school offerings'],
      sellingPoints: ['Quality education', 'Strong community'],
      nextActions: ['Schedule follow-up call'],
      insights: {
        studentProfile: 'Analysis unavailable - requires manual review',
        familyPriorities: 'Unknown - contact for details',
        engagementPattern: engagementData ? `Engagement score: ${engagementScore}/100` : 'No engagement data',
        recommendedApproach: 'Standard inquiry follow-up process'
      },
      keyObservations: ['AI analysis failed - manual review needed'],
      confidence_score: 0.1,
      recommendations: ['Manual review required'],
      engagementScore: engagementScore,
      analysisDate: new Date().toISOString(),
      error: error.message
    };
  }
}

// ===================== MIDDLEWARE =====================
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (origin.includes('.onrender.com')) return cb(null, true);
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) return cb(null, true);
    if (origin.includes('.github.io')) return cb(null, true);
    return cb(null, true);
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With','Accept'],
  credentials: false,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => { console.log(req.method, req.url); next(); });
app.use(express.static(path.join(__dirname, 'public')));
app.use('/prospectuses', express.static(path.join(__dirname, 'prospectuses')));

// ===================== API ROUTES =====================

// Webhook and inquiry endpoints
app.post(['/webhook', '/api/inquiry'], async (req, res) => {
  try {
    const data = req.body || {};
    const required = ['firstName','familySurname','parentEmail','contactNumber','parentName','ageGroup','entryYear','hearAboutUs'];
    const missing = required.filter(k => !data[k]);
    
    if (missing.length) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields', 
        missingFields: missing 
      });
    }
 
    const now = new Date().toISOString();
    const base = getBaseUrl(req);
    const clientIP = req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
    const location = getGeolocation(clientIP);
    
    const record = {
      id: generateInquiryId(),
      receivedAt: now,
      status: 'received',
      prospectusGenerated: false,
      parentName: data.parentName,          // ADD THIS
      contactNumber: data.contactNumber,    // ADD THIS
      hearAboutUs: data.hearAboutUs,
      language: data.language || 'en',   
      userAgent: req.headers['user-agent'],
      referrer: req.headers.referer,
      ip: clientIP,
      country: location.country,
      region: location.region,
      city: location.city,
      latitude: location.latitude,
      longitude: location.longitude,
      timezone: location.timezone,
      isp: location.isp,
      ...data
    };
    
    
    await saveInquiryJson(record);
    
    if (db) {
      try {
        await db.query(`
          INSERT INTO inquiries (
            id, parent_name, first_name, family_surname, parent_email, contact_number, age_group, entry_year, hear_about_us,
            sciences, mathematics, english, languages, humanities, business,
            drama, music, art, creative_writing,
            sport, leadership, community_service, outdoor_education,
            academic_excellence, pastoral_care, university_preparation,
            personal_development, career_guidance, extracurricular_opportunities,
            received_at, status, user_agent, referrer, ip_address,
            country, region, city, latitude, longitude, timezone, isp
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,
            $10,$11,$12,$13,$14,$15,
            $16,$17,$18,$19,
            $20,$21,$22,$23,
            $24,$25,$26,$27,$28,$29,
            $30,$31,$32,$33,$34,
            $35,$36,$37,$38,$39,$40,$41
          )
          ON CONFLICT (id) DO NOTHING
        `, [
          record.id, record.parentName, record.firstName, record.familySurname, record.parentEmail, record.contactNumber, record.ageGroup, record.entryYear, record.hearAboutUs,
          !!record.sciences, !!record.mathematics, !!record.english, !!record.languages, !!record.humanities, !!record.business,
          !!record.drama, !!record.music, !!record.art, !!record.creative_writing,
          !!record.sport, !!record.leadership, !!record.community_service, !!record.outdoor_education,
          !!record.academic_excellence, !!record.pastoral_care, !!record.university_preparation,
          !!record.personal_development, !!record.career_guidance, !!record.extracurricular_opportunities,
          new Date(record.receivedAt), record.status, record.userAgent, record.referrer, record.ip,
          location.country, location.region, location.city, location.latitude, location.longitude, location.timezone, location.isp
        ]);
        console.log(`Database record created: ${record.id} - ${location.city}, ${location.country}`);
      } catch (e) { 
        console.warn('DB insert failed (non-fatal):', e.message); 
      }
    }
    
    const p = await generateProspectus(record);
    await updateInquiryStatus(record.id, p);
    
    return res.json({
      success: true,
      inquiryId: record.id,
      receivedAt: record.receivedAt,
      location: {
        city: location.city,
        country: location.country
      },
      prospectus: {
        filename: p.filename,
        url: `${base}${p.prettyPath}`,
        directFile: `${base}${p.url}`,
        slug: p.slug,
        generatedAt: p.generatedAt
      }
    });
  } catch (e) {
    console.error('WEBHOOK error:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Generate prospectus manually
app.post('/api/generate-prospectus/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    let inquiry = null;
    
    if (db) {
      const result = await db.query('SELECT * FROM inquiries WHERE id = $1', [inquiryId]);
      if (result.rows.length > 0) {
        const row = result.rows[0];
        inquiry = {
          id: row.id,
          firstName: row.first_name,
          familySurname: row.family_surname,
          parentEmail: row.parent_email,
          ageGroup: row.age_group,
          entryYear: row.entry_year,
          receivedAt: row.received_at,
          sciences: row.sciences,
          mathematics: row.mathematics,
          english: row.english,
          languages: row.languages,
          humanities: row.humanities,
          business: row.business,
          drama: row.drama,
          music: row.music,
          art: row.art,
          creative_writing: row.creative_writing,
          sport: row.sport,
          leadership: row.leadership,
          community_service: row.community_service,
          outdoor_education: row.outdoor_education,
          academic_excellence: row.academic_excellence,
          pastoral_care: row.pastoral_care,
          university_preparation: row.university_preparation,
          personal_development: row.personal_development,
          career_guidance: row.career_guidance,
          extracurricular_opportunities: row.extracurricular_opportunities
        };
      }
    }
    
    if (!inquiry) {
      const files = await fs.readdir(path.join(__dirname, 'data'));
      for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
        try {
          const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
          if (j.id === inquiryId) { 
            inquiry = j; 
            break; 
          }
        } catch (fileError) {
          console.warn(`Failed to read ${f}:`, fileError.message);
        }
      }
    }
    
    if (!inquiry) {
      return res.status(404).json({ success: false, error: 'Inquiry not found' });
    }
    
    const language = req.query.lang || 'en';
    console.log(`URL language parameter: ${language}`);
    inquiry.language = language;
    const p = await generateProspectus(inquiry);
    await updateInquiryStatus(inquiry.id, p);
    
    res.json({
      success: true,
      prospectus: p
    });
  } catch (e) {
    console.error('Manual generate error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Tracking endpoints
app.post(["/api/track","/api/tracking"], (req,res) => res.redirect(307, "/api/track-engagement"));

app.post('/api/track-engagement', async (req, res) => {
  try {
    const { events = [], sessionInfo } = req.body;
    
    if (!events || events.length === 0) {
      return res.json({ success: true, message: 'No events to process' });
    }

    console.log(`📍 Received ${events.length} events from ${sessionInfo?.inquiryId || 'unknown'}`);
    
    // Process each event
    for (const event of events) {
      const { inquiryId, sessionId, eventType, data = {}, timestamp } = event;
      
      if (!inquiryId || !eventType) {
        console.warn('❌ Invalid event:', { inquiryId, eventType });
        continue;
      }
      
      // Store in database if available
      if (db) {
        try {
          await db.query(`
            INSERT INTO tracking_events (
              inquiry_id, session_id, event_type, event_data, 
              page_url, timestamp, user_agent, ip_address
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `, [
            inquiryId,
            sessionId || null,
            eventType,
            JSON.stringify(data),
            req.headers.referer || null,
            new Date(timestamp),
            req.headers['user-agent'] || null,
            req.ip || null
          ]);
        } catch (dbError) {
          console.warn('DB insert failed:', dbError.message);
        }
      }

      // Update inquiry metrics for important events
      if (eventType === 'heartbeat' || eventType === 'page_unload') {
        await updateInquiryMetrics(inquiryId, sessionInfo, data);
      }
    }
    
    res.json({ 
      success: true, 
      processed: events.length,
      inquiry: sessionInfo?.inquiryId
    });
    
  } catch (error) {
    console.error('❌ Track engagement error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// === Latest visit timeline (read-only) ==========================
app.get('/api/visits/:inquiryId/latest', async (req, res) => {
  const { inquiryId } = req.params;
  if (!inquiryId) return res.status(400).json({ ok: false, error: 'Missing inquiryId' });

  try {
    if (!db) return res.json({ ok: true, session: null, events: [] });

    // Find most recent session for this inquiry
    const sess = await db.query(`
      WITH sessions AS (
        SELECT session_id,
               MIN(timestamp) AS start_ts,
               MAX(timestamp) AS end_ts
        FROM tracking_events
        WHERE inquiry_id = $1
          AND session_id IS NOT NULL
        GROUP BY session_id
        ORDER BY end_ts DESC
        LIMIT 1
      )
      SELECT session_id, start_ts, end_ts
      FROM sessions
    `, [inquiryId]);

    if (!sess.rows.length) return res.json({ ok: true, session: null, events: [] });
    const { session_id, start_ts, end_ts } = sess.rows[0];

    // Pull ordered events for that session
    const evs = await db.query(`
      SELECT event_type, event_data, timestamp
      FROM tracking_events
      WHERE inquiry_id = $1
        AND session_id = $2
      ORDER BY timestamp ASC
    `, [inquiryId, session_id]);

    const events = evs.rows.map(r => ({
      type: r.event_type,
      ts: r.timestamp,
      name: (r.event_data && r.event_data.name) || r.event_type,
      section: r.event_data?.section ?? null,
      dwellSec: r.event_data?.dwellSec ?? null,
      tier: r.event_data?.tier ?? null,
      reason: r.event_data?.reason ?? null,
      youtubeId: r.event_data?.youtubeId ?? null,
      title: r.event_data?.title ?? null
    }));

    res.json({ ok: true, session: { id: session_id, start: start_ts, end: end_ts }, events });
  } catch (e) {
    console.error('latest visit error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});


app.post('/api/track/dwell', async (req, res) => {
  try {
    const { inquiryId, sessionId, deltaMs, reason, timestamp, deviceInfo } = req.body || {};
    
    if (!inquiryId || !Number.isFinite(Number(deltaMs))) {
      return res.status(400).json({ ok: false, error: 'Missing inquiryId or deltaMs' });
    }
    
    if (!db) return res.json({ ok: true, mode: 'json-only', acceptedDeltaMs: Number(deltaMs) });
    
    const delta = Math.max(0, Math.round(Number(deltaMs)));
    
    await db.query('BEGIN');
    
    await db.query(`
      INSERT INTO tracking_events (inquiry_id, event_type, event_data, page_url, user_agent, ip_address, session_id, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      inquiryId,
      'dwell',
      JSON.stringify({ delta_ms: delta, reason: reason || null, deviceInfo: deviceInfo || null }),
      null,
      (deviceInfo && deviceInfo.userAgent) || null,
      (req.ip || req.headers['x-forwarded-for'] || null),
      sessionId || null,
      new Date(timestamp || Date.now())
    ]);
    
    await db.query(`
      UPDATE inquiries
      SET dwell_ms = COALESCE(dwell_ms, 0) + $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [inquiryId, delta]);
    
    await db.query('COMMIT');
    
    return res.json({ ok: true, addedMs: delta });
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch(_) {}
    console.warn('dwell endpoint failed:', e.message);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Dashboard and analytics endpoints
app.get('/api/dashboard-data', async (req, res) => {
  try {
    console.log('Dashboard data request...');
    let inquiries = [];
    
    if (db) {
      try {
        console.log('Reading from DATABASE...');
        const result = await db.query(`
          SELECT id, first_name, family_surname, parent_email, age_group, entry_year,
                 sciences, mathematics, english, languages, humanities, business,
                 drama, music, art, creative_writing, sport, leadership, 
                 community_service, outdoor_education, academic_excellence, 
                 pastoral_care, university_preparation, personal_development, 
                 career_guidance, extracurricular_opportunities,
                 received_at, status, prospectus_generated, prospectus_filename, 
                 prospectus_url, slug, prospectus_generated_at
          FROM inquiries 
          ORDER BY received_at DESC
        `);
        
        inquiries = result.rows.map(row => ({
          id: row.id,
          firstName: row.first_name,
          familySurname: row.family_surname,
          parent_name: row.parentname,
          parentEmail: row.parent_email,
          contact_number: row.contactnumber,
          ageGroup: row.age_group,
          hear_about_us: row.hearabout_us,
          entryYear: row.entry_year,
          receivedAt: row.received_at,
          status: row.status,
          prospectusGenerated: row.prospectus_generated,
          prospectusFilename: row.prospectus_filename,
          prospectusUrl: row.prospectus_url,
          slug: row.slug,
          prospectusGeneratedAt: row.prospectus_generated_at,
          prospectusPrettyPath: row.slug ? `/${row.slug}` : null,
          sciences: row.sciences,
          mathematics: row.mathematics,
          english: row.english,
          languages: row.languages,
          humanities: row.humanities,
          business: row.business,
          drama: row.drama,
          music: row.music,
          art: row.art,
          creative_writing: row.creative_writing,
          sport: row.sport,
          leadership: row.leadership,
          community_service: row.community_service,
          outdoor_education: row.outdoor_education,
          academic_excellence: row.academic_excellence,
          pastoral_care: row.pastoral_care,
          university_preparation: row.university_preparation,
          personal_development: row.personal_development,
          career_guidance: row.career_guidance,
          extracurricular_opportunities: row.extracurricular_opportunities
        }));
        
        console.log(`Loaded ${inquiries.length} inquiries from DATABASE`);
      } catch (dbError) {
        console.warn('Database read failed, falling back to JSON:', dbError.message);
      }
    }
    
    if (inquiries.length === 0) {
      console.log('Falling back to JSON files...');
      const files = await fs.readdir(path.join(__dirname, 'data')).catch(() => []);
      console.log(`Found ${files.length} files in data directory`);
      
      for (const f of files.filter(f => f.startsWith('inquiry-') && f.endsWith('.json'))) {
        try { 
          const content = await fs.readFile(path.join(__dirname, 'data', f), 'utf8');
          const inquiry = JSON.parse(content);
          inquiries.push(inquiry);
        } catch (e) {
          console.warn(`Failed to read ${f}:`, e.message);
        }
      }
      console.log(`Loaded ${inquiries.length} inquiries from JSON files`);
    }
    
    const now = Date.now();
    const totalFamilies = inquiries.length;
    const newInquiries7d = inquiries.filter(i => {
      const t = Date.parse(i.receivedAt || 0);
      return t && (now - t) <= 7*24*60*60*1000;
    }).length;
    
    const readyForContact = inquiries.filter(i => i.prospectusGenerated || i.status === 'prospectus_generated').length;
    const highlyEngaged = Math.floor(totalFamilies * 0.3);
    
    const interestKeys = [
      'sciences','mathematics','english','languages','humanities','business',
      'drama','music','art','creative_writing','sport','leadership','community_service','outdoor_education',
      'academic_excellence','pastoral_care','university_preparation','personal_development','career_guidance','extracurricular_opportunities'
    ];
    
    const counts = Object.fromEntries(interestKeys.map(k => [k,0]));
    for (const i of inquiries) {
      for (const k of interestKeys) {
        if (i[k]) counts[k]++;
      }
    }
    
    const topInterests = Object.entries(counts).filter(([,c])=>c>0)
      .sort((a,b)=>b[1]-a[1]).slice(0,10).map(([subject,count])=>({
        subject: subject.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        count
      }));
    
    const base = getBaseUrl(req);
    
    const recentlyActive = inquiries
      .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt))
      .slice(0, 10)
      .map(i => ({
        name: `${i.firstName || ''} ${i.familySurname || ''}`.trim(),
        inquiryId: i.id,
        ageGroup: i.ageGroup,
        entryYear: i.entryYear,
        activity: 'Recently inquired',
        when: i.receivedAt,
        timeOnPage: 0,
        temperature: 'warm'
      }));
    
    const priorityFamilies = inquiries
      .filter(i => i.prospectusGenerated || i.status === 'prospectus_generated')
      .sort((a, b) => new Date(b.prospectusGeneratedAt || b.receivedAt) - new Date(a.prospectusGeneratedAt || a.receivedAt))
      .slice(0, 15)
      .map(i => ({
        name: `${i.firstName||''} ${i.familySurname||''}`.trim(),
        inquiryId: i.id,
        ageGroup: i.ageGroup,
        entryYear: i.entryYear,
        totalVisits: 1,
        lastVisit: i.prospectusGeneratedAt || i.receivedAt,
        temperature: 'warm',
        hasProspectus: true
      }));
    
    const latestProspectuses = inquiries
      .filter(i => i.prospectusGenerated || i.status === 'prospectus_generated')
      .sort((a,b) => new Date(b.prospectusGeneratedAt || b.receivedAt) - new Date(a.prospectusGeneratedAt || a.receivedAt))
      .slice(0,10)
      .map(i => {
        const prettyPath = i.prospectusPrettyPath || (i.slug ? `/${i.slug}` : null);
        return {
          name: `${i.firstName||''} ${i.familySurname||''}`.trim(),
          inquiryId: i.id,
          generatedAt: i.prospectusGeneratedAt || null,
          prospectusPrettyUrl: prettyPath ? `${base}${prettyPath}` : null,
          prospectusDirectUrl: i.prospectusUrl ? `${base}${i.prospectusUrl}` : null
        };
      });
    
    const response = {
      summary: { 
        totalFamilies,
        readyForContact, 
        highlyEngaged, 
        newInquiries7d, 
        hotLeads: Math.floor(totalFamilies * 0.1),
        warmLeads: Math.floor(totalFamilies * 0.2),
        coldLeads: Math.floor(totalFamilies * 0.7),
        avgEngagement: 5,
        aiAnalyzed: 0
      },
      topInterests, 
      recentlyActive, 
      priorityFamilies, 
      latestProspectuses
    };
    
    console.log('Dashboard data response prepared:', {
      totalFamilies: response.summary.totalFamilies,
      recentlyActive: response.recentlyActive.length,
      priorityFamilies: response.priorityFamilies.length,
      prospectuses: response.latestProspectuses.length,
      source: inquiries.length > 0 ? (db ? 'database' : 'json') : 'empty'
    });
    
    return res.json(response);
  } catch (e) {
    console.error('Dashboard data error:', e);
    res.status(500).json({ error: 'Failed to build dashboard data', message: e.message });
  }
});

// === Inquiry overview (family, contact, interests, entry years, basic counts) ===
app.get('/api/inquiry/:inquiryId/overview', async (req, res) => {
  const { inquiryId } = req.params;
  if (!inquiryId) return res.status(400).json({ ok:false, error:'Missing inquiryId' });

  try {
    if (!db) return res.json({ ok:true, overview: null });

    // 1) Pull core inquiry info (adjust field names if yours differ)
    const iq = await db.query(`
      SELECT
        inquiry_id,
        family_name,
        child_name,
        email,
        age_group,
        entry_year,
        interests,          -- array or comma-separated (adjust as needed)
        slug,
        prospectus_url      -- if stored; else build from slug
      FROM inquiries
      WHERE inquiry_id = $1
      LIMIT 1
    `, [inquiryId]);

    const base = iq.rows[0] || {
      inquiry_id: inquiryId,
      family_name: 'Unknown Family',
      child_name: null,
      email: null,
      age_group: null,
      entry_year: null,
      interests: null,
      slug: null,
      prospectus_url: null
    };

    // 2) Engagement basics from tracking_events
    const stats = await db.query(`
      SELECT
        COUNT(*) AS events,
        COUNT(DISTINCT session_id) AS visits,
        MIN(timestamp) AS first_seen,
        MAX(timestamp) AS last_seen
      FROM tracking_events
      WHERE inquiry_id = $1
    `, [inquiryId]);

    // Optional: total dwell time across sections (sum of section_exit dwellSec)
    const dwell = await db.query(`
      SELECT COALESCE(SUM((event_data->>'dwellSec')::int),0) AS total_dwell_sec
      FROM tracking_events
      WHERE inquiry_id = $1 AND event_type = 'section_exit'
    `, [inquiryId]);

    res.json({
      ok: true,
      overview: {
        inquiryId: base.inquiry_id,
        familyName: base.family_name,
        childName: base.child_name,
        email: base.email,
        ageGroup: base.age_group,
        entryYear: base.entry_year,
        interests: base.interests,
        slug: base.slug,
        prospectusUrl: base.prospectus_url,
        visits: Number(stats.rows[0]?.visits || 0),
        events: Number(stats.rows[0]?.events || 0),
        firstSeen: stats.rows[0]?.first_seen || null,
        lastSeen: stats.rows[0]?.last_seen || null,
        totalDwellSec: Number(dwell.rows[0]?.total_dwell_sec || 0)
      }
    });
  } catch (e) {
    console.error('overview error:', e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

// === Sessions list for an inquiry (start/end + event count) ===
app.get('/api/visits/:inquiryId/sessions', async (req, res) => {
  const { inquiryId } = req.params;
  if (!inquiryId) return res.status(400).json({ ok:false, error:'Missing inquiryId' });

  try {
    if (!db) return res.json({ ok:true, sessions: [] });

    const q = await db.query(`
      SELECT session_id,
             MIN(timestamp) AS start_ts,
             MAX(timestamp) AS end_ts,
             COUNT(*)       AS events
      FROM tracking_events
      WHERE inquiry_id = $1 AND session_id IS NOT NULL
      GROUP BY session_id
      ORDER BY start_ts DESC
      LIMIT 50
    `, [inquiryId]);

    res.json({ ok:true, sessions: q.rows });
  } catch (e) {
    console.error('sessions list error:', e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

// === Utility: summarise a set of events into a short narrative ===
function summariseEvents(events) {
  // Track dwell by section
  const bySection = new Map();
  // Track unique videos by ID
  const videos = new Map(); // youtubeId -> title
  let openMorningClicks = 0;
  const tiers = [];

  for (const ev of events) {
    if (ev.type === 'section_exit' && ev.section) {
      const prev = bySection.get(ev.section) || 0;
      if (Number.isFinite(ev.dwellSec)) {
        bySection.set(ev.section, prev + Number(ev.dwellSec));
      }
    }

    if (ev.type === 'video_open' && ev.youtubeId) {
      if (!videos.has(ev.youtubeId)) {
        videos.set(ev.youtubeId, ev.title || ev.youtubeId);
      }
    }

    if (ev.type === 'cta_openmorning_click') {
      openMorningClicks += 1;
    }

    if (ev.type === 'tier_exit') {
      tiers.push({ tier: ev.tier, dwellSec: ev.dwellSec || 0 });
    }
  }

  const topSections = [...bySection.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k.replace(/_/g, ' ')} (${Math.round(v / 60)}m)`);

  const tierBits = tiers
    .sort((a, b) => b.dwellSec - a.dwellSec)
    .slice(0, 3)
    .map(t => `${t.tier} (${Math.round((t.dwellSec || 0) / 60)}m)`);

  const videoBits = Array.from(videos.values()).slice(0, 4);

  const parts = [];
  if (topSections.length) {
    parts.push(`Most time in: ${topSections.join(', ')}.`);
  }
  if (tierBits.length) {
    parts.push(`Looked at tiers: ${tierBits.join(', ')}.`);
  }
  if (videoBits.length) {
    parts.push(`Watched/opened videos: ${videoBits.join(', ')}.`);
  }
  if (openMorningClicks) {
    parts.push(
      `Clicked “Book an Open Morning” ${openMorningClicks} time${openMorningClicks > 1 ? 's' : ''}.`
    );
  }

  return parts.join(' ');
}


// === Per-session AI-style summary (rule-based) ===
app.get('/api/visits/:inquiryId/:sessionId/summary', async (req,res)=>{
  const { inquiryId, sessionId } = req.params;
  if (!inquiryId || !sessionId) return res.status(400).json({ ok:false, error: 'Missing params' });
  try {
    if (!db) return res.json({ ok:true, summary: '' });

    const evs = await db.query(`
      SELECT event_type, event_data, timestamp
      FROM tracking_events
      WHERE inquiry_id = $1 AND session_id = $2
      ORDER BY timestamp ASC
    `, [inquiryId, sessionId]);

    const events = evs.rows.map(r => ({
      type: r.event_type,
      ts: r.timestamp,
      section: r.event_data?.section ?? null,
      dwellSec: r.event_data?.dwellSec ?? null,
      tier: r.event_data?.tier ?? null,
      youtubeId: r.event_data?.youtubeId ?? null,
      title: r.event_data?.title ?? null
    }));

    const text = summariseEvents(events);
    res.json({ ok:true, summary: text });
  } catch (e) {
    console.error('session summary error:', e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Download by inquiry ID endpoint
app.get('/api/download/:id', async (req, res) => {
  try {
    const inquiryId = req.params.id;
    console.log(`📥 Download request by ID: ${inquiryId}`);
    
    const inquiry = await findInquiryBySlug(inquiryId) || data.find(d => d.id === inquiryId);
    if (!inquiry) {
      return res.status(404).json({ 
        success: false, 
        error: "Not found", 
        message: `Route GET /api/download/${inquiryId} not found` 
      });
    }
    
    console.log(`Found inquiry: ${inquiry.firstName} ${inquiry.familySurname}`);
    
    // Generate prospectus if needed
    let prospectusInfo;
    if (!inquiry.prospectusFilename) {
      prospectusInfo = await generateProspectus(inquiry);
      await updateInquiryStatus(inquiry.id, prospectusInfo);
    }
    
    // Send the file for download
    const filePath = path.join(__dirname, 'prospectuses', inquiry.prospectusFilename || prospectusInfo.filename);
    
    // Check if file exists
    try {
      await fs.access(filePath);
    } catch (e) {
      return res.status(404).json({ 
        success: false, 
        error: "File not found" 
      });
    }
    
    // Send file with download headers
    const downloadName = `${inquiry.firstName}-${inquiry.familySurname}-Prospectus-${inquiry.entryYear}.html`;
    res.download(filePath, downloadName);
    
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.get('/api/analytics/inquiries/:id/video_rollup', async (req, res) => {
  try {
    const inquiryId = req.params.id;
    const q = await db.query(`
      SELECT video_id, MAX(video_title) AS title, COUNT(DISTINCT session_id) AS sessions,
             SUM(COALESCE(watched_sec,0)) AS watch_sec
      FROM video_engagement_tracking
      WHERE inquiry_id = $1 AND video_id IS NOT NULL
      GROUP BY video_id
      ORDER BY watch_sec DESC
    `, [inquiryId]);

    res.json({
      inquiry_id: inquiryId,
      distinct_videos: q.rows.length,
      total_watch_sec: q.rows.reduce((s,r)=>s+Number(r.watch_sec||0),0),
      videos: q.rows
    });
  } catch (e) {
    console.error('video_rollup error', e);
    res.status(500).json({ error: 'Failed to compute video roll-up' });
  }
});


// === Overall AI-style summary across all sessions ===
app.get('/api/inquiry/:inquiryId/summary', async (req,res)=>{
  const { inquiryId } = req.params;
  if (!inquiryId) return res.status(400).json({ ok:false, error:'Missing inquiryId' });
  try {
    if (!db) return res.json({ ok:true, summary: '' });

    const evs = await db.query(`
      SELECT event_type, event_data, timestamp
      FROM tracking_events
      WHERE inquiry_id = $1
      ORDER BY timestamp ASC
    `, [inquiryId]);

    const events = evs.rows.map(r => ({
      type: r.event_type,
      ts: r.timestamp,
      section: r.event_data?.section ?? null,
      dwellSec: r.event_data?.dwellSec ?? null,
      tier: r.event_data?.tier ?? null,
      youtubeId: r.event_data?.youtubeId ?? null,
      title: r.event_data?.title ?? null
    }));

    const text = summariseEvents(events);
    res.json({ ok:true, summary: text });
  } catch (e) {
    console.error('overall summary error:', e);
    res.status(500).json({ ok:false, error:e.message });
  }
});


app.get('/api/analytics/inquiries', async (req, res) => {
  try {
    console.log('Analytics inquiries request...');
    let inquiries = [];
    const base = getBaseUrl(req);

    if (db) {
      try {
        console.log('Reading inquiries from DATABASE...');
        const result = await db.query(`
          SELECT 
            i.*,

            /* Total dwell across ALL visits: sum of section_exit seconds → ms */
            (
              SELECT COALESCE(SUM(COALESCE((te.event_data->>'dwellSec')::int, 0)), 0) * 1000
              FROM tracking_events te
              WHERE te.inquiry_id = i.id
                AND te.event_type IN ('section_exit_enhanced','section_exit')
            ) AS actual_dwell_ms,

            /* Visit count = DISTINCT sessions from tracking */
            (
              SELECT COUNT(DISTINCT te.session_id)
              FROM tracking_events te
              WHERE te.inquiry_id = i.id
                AND te.session_id IS NOT NULL
            ) AS actual_return_visits,

            /* Keep your AI engagement join */
            afi.insights_json AS ai_engagement

          FROM inquiries i
          LEFT JOIN ai_family_insights afi 
            ON i.id = afi.inquiry_id 
           AND afi.analysis_type = 'engagement_summary'
          ORDER BY i.received_at DESC

        `);

        inquiries = result.rows.map(row => ({
          id: row.id,
          first_name: row.first_name,
          family_surname: row.family_surname,
          parent_email: row.parent_email,
          entry_year: row.entry_year,
          age_group: row.age_group,
          received_at: row.received_at,
          country: row.country,
          region: row.region, 
          city: row.city,
          updated_at: row.prospectus_generated_at || row.received_at,
          status: row.status || (row.prospectus_generated ? 'prospectus_generated' : 'received'),
          prospectus_filename: row.prospectus_filename,
          prospectus_generated_at: row.prospectus_generated_at,
          prospectus_pretty_path: row.slug ? `/${row.slug}` : null,
          prospectus_pretty_url: row.slug ? `${base}/${row.slug}` : null,
          prospectus_direct_url: row.prospectus_url ? `${base}${row.prospectus_url}` : null,

          /* FIXED: no more forced “1 visit” */
          dwell_ms: Number(row.actual_dwell_ms || 0),
          return_visits: Number(row.actual_return_visits || 0),

          engagement: {
            timeOnPage: Number(row.actual_dwell_ms || 0),
            scrollDepth: 100,
            clickCount: Math.floor(Number(row.actual_dwell_ms || 0) / 10000),
            totalVisits: Number(row.actual_return_visits || 0),
            lastVisit: row.prospectus_generated_at || row.received_at,
            engagementScore: calculateEngagementScore({
              timeOnPage: Number(row.actual_dwell_ms || 0),
              scrollDepth: 100,
              totalVisits: Number(row.actual_return_visits || 0),
              clickCount: Math.floor(Number(row.actual_dwell_ms || 0) / 10000)
            })
          },

          aiEngagement: row.ai_engagement
            ? (typeof row.ai_engagement === 'string'
                ? JSON.parse(row.ai_engagement)
                : row.ai_engagement)
            : null,

          /* Subject interests (unchanged) */
          sciences: row.sciences,
          mathematics: row.mathematics,
          english: row.english,
          languages: row.languages,
          humanities: row.humanities,
          business: row.business,
          drama: row.drama,
          music: row.music,
          art: row.art,
          creative_writing: row.creative_writing,
          sport: row.sport,
          leadership: row.leadership,
          community_service: row.community_service,
          outdoor_education: row.outdoor_education,
          academic_excellence: row.academic_excellence,
          pastoral_care: row.pastoral_care,
          university_preparation: row.university_preparation,
          personal_development: row.personal_development,
          career_guidance: row.career_guidance,
          extracurricular_opportunities: row.extracurricular_opportunities
        }));

        console.log(`Loaded ${inquiries.length} inquiries with REAL data`);
      } catch (dbError) {
        console.warn('Database read failed:', dbError.message);
      }
    }

    console.log(`Returning ${inquiries.length} inquiries with corrected data`);
    res.json(inquiries);
  } catch (e) {
    console.error('Analytics inquiries error:', e);
    res.status(500).json({ error: 'Failed to get inquiries' });
  }
});

// Save/Upsert Overall AI Summary
app.put('/api/analytics/inquiries/:id/overall_summary', express.json(), async (req, res) => {
  try {
    const inquiryId = req.params.id;
    const { overview, recommendations, strategy } = req.body || {};

    if (!db) return res.status(503).json({ ok: false, error: 'Database not available' });
    if (!inquiryId) return res.status(400).json({ ok: false, error: 'Missing inquiry id' });

    // normalise types
    const ov = typeof overview === 'string' ? overview : (overview ?? null);
    const recs = Array.isArray(recommendations) ? recommendations : [];
    const strat = typeof strategy === 'string' ? strategy : (strategy ?? null);

    await db.query(`
      INSERT INTO inquiry_ai_summary (inquiry_id, overview, recommendations, strategy, generated_at, updated_at)
      VALUES ($1, $2, $3::jsonb, $4, NOW(), NOW())
      ON CONFLICT (inquiry_id)
      DO UPDATE SET
        overview       = EXCLUDED.overview,
        recommendations= EXCLUDED.recommendations,
        strategy       = EXCLUDED.strategy,
        updated_at     = NOW()
    `, [inquiryId, ov, JSON.stringify(recs), strat]);

    return res.json({ ok: true, inquiry_id: inquiryId });
  } catch (err) {
    console.error('PUT overall_summary error:', err);
    res.status(500).json({ ok: false, error: 'Failed to save overall AI summary' });
  }
});

// Save/Update inquiry pipeline status
app.put('/api/analytics/inquiries/:id/status', express.json(), async (req, res) => {
  try {
    const id = req.params.id;
    const { status } = req.body || {};
    if (!id || !status) return res.status(400).json({ ok: false, error: 'Missing id or status' });
    if (!db) return res.status(503).json({ ok: false, error: 'Database not available' });

    await db.query(
      `UPDATE inquiries
         SET status = $1,
             updated_at = NOW()
       WHERE id = $2`,
      [status, id]
    );

    return res.json({ ok: true, id, status });
  } catch (err) {
    console.error('PUT /inquiries/:id/status error:', err);
    res.status(500).json({ ok: false, error: 'Failed to save status' });
  }
});


// Fetch Overall AI Summary
app.get('/api/analytics/inquiries/:id/overall_summary', async (req, res) => {
  try {
    const inquiryId = req.params.id;

    // 1) Stored free-text (keep for narrative only)
    let stored = null;
    try {
      const r = await db.query(
        `SELECT overview, recommendations, strategy, generated_at, updated_at
           FROM inquiry_ai_summary
          WHERE inquiry_id = $1`,
        [inquiryId]
      );
      stored = r.rows[0] || null;
    } catch (_) {}

    // 2) Computed engagement from tracking + inquiries (ground truth)
    // Sections + dwell
    const sectionsQ = await db.query(`
      SELECT
        COALESCE(event_data->>'currentSection','unknown') AS section_id,
        SUM(COALESCE((event_data->>'timeInSectionSec')::int,0)) AS dwell_sec
      FROM tracking_events
      WHERE inquiry_id = $1 AND event_type = 'section_exit'
      GROUP BY 1
    `, [inquiryId]);

    // Visits (distinct sessions)
    const visitsQ = await db.query(`
      SELECT COUNT(DISTINCT session_id) AS visits
      FROM tracking_events
      WHERE inquiry_id = $1 AND session_id IS NOT NULL
    `, [inquiryId]);

    // Total dwell (prefer inquiries.dwell_ms if populated; else sum of sections)
    const dwellQ = await db.query(
      `SELECT dwell_ms, return_visits FROM inquiries WHERE id = $1`,
      [inquiryId]
    );

    const fallbackDwellMs = sectionsQ.rows.reduce((sum, r) => sum + (Number(r.dwell_sec || 0) * 1000), 0);
    const dwellMs = Math.max(Number(dwellQ.rows[0]?.dwell_ms || 0), fallbackDwellMs);
    const visits = Math.max(Number(visitsQ.rows[0]?.visits || 0), Number(dwellQ.rows[0]?.return_visits || 0) || 0);

    // Distinct videos watched (prefer video_engagement_tracking if present; else from tracking_events youtube ids)
    const vidsFromTable = await db.query(`
      SELECT COUNT(DISTINCT video_id) AS vids
      FROM video_engagement_tracking
      WHERE inquiry_id = $1 AND video_id IS NOT NULL
    `, [inquiryId]);

    let distinctVideos = Number(vidsFromTable.rows[0]?.vids || 0);
    if (!distinctVideos) {
      const vidsFromEvents = await db.query(`
        SELECT COUNT(DISTINCT event_data->>'youtubeId') AS vids
        FROM tracking_events
        WHERE inquiry_id = $1
          AND event_type LIKE 'youtube_video_%'
          AND event_data ? 'youtubeId'
      `, [inquiryId]);
      distinctVideos = Number(vidsFromEvents.rows[0]?.vids || 0);
    }

    // Top sections by dwell
    const topSections = sectionsQ.rows
      .map(r => ({ section: (r.section_id || 'unknown'), dwell_ms: Number(r.dwell_sec || 0) * 1000 }))
      .sort((a,b) => b.dwell_ms - a.dwell_ms)
      .slice(0, 5);

    // Deterministic, factual narrative (no guessing)
    const minutes = Math.round(dwellMs / 60000);
    const secCount = sectionsQ.rows.filter(r => r.section_id !== 'unknown').length;
    const topNames = topSections.map(s => s.section.replace(/_/g,' ')).slice(0,3);
    const parts = [];
    parts.push(`${visits || 1} visit${visits === 1 ? '' : 's'} with ${minutes} minute${minutes === 1 ? '' : 's'} total engagement across ${secCount} section${secCount === 1 ? '' : 's'}.`);
    if (distinctVideos > 0) parts.push(`Watched ${distinctVideos} video${distinctVideos === 1 ? '' : 's'}.`);
    if (topNames.length) parts.push(`Most time in: ${topNames.join(', ')}.`);
    const computedNarrative = parts.join(' ');

    // 3) Response combines stored text (if you still want it) with computed facts
    return res.json({
      inquiry_id: inquiryId,
      computed: {
        visits,
        dwell_ms: dwellMs,
        dwell_minutes: minutes,
        distinct_sections: secCount,
        videos_watched: distinctVideos,
        top_sections: topSections
      },
      // keep the legacy fields so your UI doesn’t break
      overview: stored?.overview || computedNarrative,
      recommendations: stored?.recommendations || [],
      strategy: stored?.strategy || null,
      generated_at: stored?.generated_at || null,
      updated_at: stored?.updated_at || null,
      source: 'computed+stored'
    });
  } catch (err) {
    console.error('GET overall_summary error:', err);
    res.status(500).json({ error: 'Failed to compute overall AI summary' });
  }
});


// AI endpoints
app.post('/api/ai/engagement-summary/all', (req, res) => {
  return res.redirect(307, '/api/ai/analyze-all-families');
});

app.post('/api/ai/engagement-summary/:inquiryId', async (req, res) => {
  const inquiryId = req.params.inquiryId;
  
  if (inquiryId === 'all') {
    return res.status(400).json({ success: false, error: "Use POST /api/ai/analyze-all-families for bulk analysis." });
  }
  
  if (!db) {
    return res.status(500).json({ success: false, error: 'Database not available' });
  }

  try {
    const q = await db.query(`SELECT * FROM inquiries WHERE id = $1`, [inquiryId]);
    const inquiry = q?.rows?.[0];
    
    if (!inquiry) return res.status(404).json({ success: false, error: 'Inquiry not found' });
    
    const result = await summariseFamilyEngagement(db, inquiry);
    
    await db.query(`
      INSERT INTO ai_family_insights (inquiry_id, analysis_type, insights_json, confidence_score, generated_at)
      VALUES ($1, 'engagement_summary', $2::jsonb, 1.0, NOW())
      ON CONFLICT (inquiry_id, analysis_type)
      DO UPDATE SET insights_json = EXCLUDED.insights_json,
                    confidence_score = EXCLUDED.confidence_score,
                    generated_at = EXCLUDED.generated_at
    `, [ inquiryId, JSON.stringify(result) ]);
    
    return res.json({ success: true, result });
  } catch (e) {
    console.error('Engagement summary error:', e);
    return res.status(500).json({ success: false, error: 'Failed to generate engagement summary' });
  }
});

app.get('/api/ai/engagement-summary/:inquiryId', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });
  
  try {
    const inquiryId = req.params.inquiryId;
    
    const stored = await db.query(`
      SELECT insights_json
      FROM ai_family_insights
      WHERE inquiry_id = $1 AND analysis_type = 'engagement_summary'
    `, [inquiryId]);
    
    const inquiryData = await db.query(`
      SELECT dwell_ms, return_visits
      FROM inquiries
      WHERE id = $1
    `, [inquiryId]);
    
    const sectionData = await db.query(`
      SELECT
        COALESCE(event_data->>'currentSection', 'unknown') AS section,
        SUM(COALESCE((event_data->>'timeInSectionSec')::int, 0)) AS dwell_seconds,
        MAX(COALESCE((event_data->>'maxScrollPct')::int, 0)) AS max_scroll_pct
      FROM tracking_events
      WHERE inquiry_id = $1
        AND event_type = 'section_exit'
      GROUP BY 1
      ORDER BY 2 DESC
    `, [inquiryId]);
    
    // Sum actual section engagement time from section_exit events
    const sessionTotals = await db.query(`
      SELECT 
        COUNT(DISTINCT session_id) as session_count,
        SUM(COALESCE((event_data->>'dwellSec')::int, 0)) as total_seconds
      FROM tracking_events 
      WHERE inquiry_id = $1 AND event_type = 'section_exit'
    `, [inquiryId]);

    const totalSeconds = parseInt(sessionTotals.rows[0]?.total_seconds || 0);
    const dwellMs = totalSeconds * 1000; // For location 1
    const totalDwellMs = totalSeconds * 1000; // For location 2
    const score = Math.min(100, Math.round((dwellMs / 1000) / 10) + 50);
    const visitCount = Math.max(parseInt(sessionTotals.rows[0]?.session_count || 0), 1);
    
    let summaryText = 'No summary available';
    let highlights = [];
    
    if (stored.rows[0]?.insights_json) {
      const insights = stored.rows[0].insights_json;
      summaryText = insights.narrative || summaryText;
      highlights = insights.highlights || [];
    } else {
      // Generate if not exists
      try {
        const genResponse = await fetch(`http://localhost:${PORT}/api/ai/force-summary/${inquiryId}`, {
          method: 'POST'
        });
        if (genResponse.ok) {
          const generated = await genResponse.json();
          summaryText = generated.aiSummary?.narrative || summaryText;
          highlights = generated.aiSummary?.highlights || [];
        }
      } catch (genError) {
        console.warn('Failed to generate summary:', genError.message);
      }
    }
    
    res.json({
      dwellMs,
      visits: visitCount,
      score,
      sections: sectionData.rows,
      summaryText,
      highlights,
      total_dwell_ms: dwellMs
    });
  } catch (error) {
    console.error('Get engagement summary error:', error);
    res.status(500).json({ 
      error: 'Failed to get summary',
      message: error.message 
    });
  }
});

app.post('/api/ai/analyze-all-families', async (req, res) => {
  try {
    const q = await db.query(`SELECT * FROM inquiries ORDER BY created_at DESC NULLS LAST`);
    const rows = q?.rows || [];
    const results = [];
    
    for (const inquiry of rows) {
      try {
        const result = await summariseFamilyEngagement(db, inquiry);
        
        await db.query(`
          INSERT INTO ai_family_insights (inquiry_id, analysis_type, insights_json, confidence_score, generated_at)
          VALUES ($1, $2, $3::jsonb, $4, $5)
          ON CONFLICT (inquiry_id, analysis_type)
          DO UPDATE SET insights_json = EXCLUDED.insights_json,
                        confidence_score = EXCLUDED.confidence_score,
                        generated_at = EXCLUDED.generated_at
        `, [ inquiry.id, 'engagement_summary', JSON.stringify(result), 1.0, new Date() ]);
        
        results.push({ inquiry_id: inquiry.id, success: true });
      } catch (errOne) {
        console.error('Bulk summarise error for', inquiry.id, errOne);
        results.push({ inquiry_id: inquiry.id, success: false, error: 'summary_failed' });
      }
    }
    
    return res.json({ success: true, count: results.length, results });
  } catch (e) {
    console.error('Bulk analyse error:', e);
    return res.status(500).json({ success: false, error: 'Bulk analysis failed' });
  }
});

app.post('/api/ai/analyze-family/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    console.log(`Starting individual AI analysis for family: ${inquiryId}`);
    
    let inquiry = null;
    
    if (db) {
      try {
        const result = await db.query('SELECT * FROM inquiries WHERE id = $1', [inquiryId]);
        if (result.rows.length > 0) {
          inquiry = result.rows[0];
        }
      } catch (dbError) {
        console.warn('DB lookup failed:', dbError.message);
      }
    }
    
    if (!inquiry) {
      const files = await fs.readdir(path.join(__dirname, 'data'));
      for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
        try {
          const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
          if (j.id === inquiryId) {
            inquiry = j;
            break;
          }
        } catch (fileError) {
          console.warn(`Failed to read ${f}:`, fileError.message);
        }
      }
    }
    
    if (!inquiry) {
      return res.status(404).json({
        success: false,
        error: 'Family not found',
        inquiryId: inquiryId
      });
    }
    
    console.log(`Processing ${inquiry.firstName || inquiry.first_name} ${inquiry.familySurname || inquiry.family_surname} (${inquiry.id})`);
    
    let engagementData = null;
    if (db) {
      try {
        const engagementResult = await db.query(`
          SELECT time_on_page, scroll_depth, clicks_on_links, total_visits, last_visit
          FROM engagement_metrics
          WHERE inquiry_id = $1
          ORDER BY last_visit DESC
          LIMIT 1
        `, [inquiry.id]);
        
        if (engagementResult.rows.length) {
          engagementData = engagementResult.rows[0];
        }
      } catch (engagementError) {
        console.warn('Engagement data lookup failed:', engagementError.message);
      }
    }
    
    const analysis = await analyzeFamily({
      id: inquiry.id,
      firstName: inquiry.firstName || inquiry.first_name,
      familySurname: inquiry.familySurname || inquiry.family_surname,
      parentName: inquiry.parentName || inquiry.parent_name,  
      parentEmail: inquiry.parentEmail || inquiry.parent_email,
      contactNumber: inquiry.contactNumber || inquiry.contact_number, 
      ageGroup: inquiry.ageGroup || inquiry.age_group,
      entryYear: inquiry.entryYear || inquiry.entry_year,
      hearAboutUs: inquiry.hearAboutUs || inquiry.hear_about_us,
      sciences: inquiry.sciences,
      mathematics: inquiry.mathematics,
      english: inquiry.english,
      languages: inquiry.languages,
      humanities: inquiry.humanities,
      business: inquiry.business,
      drama: inquiry.drama,
      music: inquiry.music,
      art: inquiry.art,
      creative_writing: inquiry.creative_writing,
      sport: inquiry.sport,
      leadership: inquiry.leadership,
      community_service: inquiry.community_service,
      outdoor_education: inquiry.outdoor_education,
      academic_excellence: inquiry.academic_excellence,
      pastoral_care: inquiry.pastoral_care,
      university_preparation: inquiry.university_preparation,
      personal_development: inquiry.personal_development,
      career_guidance: inquiry.career_guidance,
      extracurricular_opportunities: inquiry.extracurricular_opportunities
    }, engagementData);
    
    if (!analysis) {
      return res.status(500).json({
        success: false,
        error: 'AI analysis failed',
        inquiryId: inquiryId
      });
    }
    
    if (db) {
      try {
        await db.query(`
          INSERT INTO ai_family_insights (
            inquiry_id, analysis_type, insights_json, confidence_score, 
            recommendations, generated_at, lead_score, urgency_level, lead_temperature
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (inquiry_id, analysis_type) DO UPDATE SET
            insights_json = EXCLUDED.insights_json,
            confidence_score = EXCLUDED.confidence_score,
            recommendations = EXCLUDED.recommendations,
            generated_at = EXCLUDED.generated_at,
            lead_score = EXCLUDED.lead_score,
            urgency_level = EXCLUDED.urgency_level,
            lead_temperature = EXCLUDED.lead_temperature
        `, [
          inquiry.id,
          'family_profile',
          JSON.stringify(analysis),
          analysis.confidence_score,
          analysis.recommendations,
          new Date(),
          analysis.leadScore,
          analysis.urgencyLevel,
          analysis.leadTemperature
        ]);
        console.log(`Stored individual analysis for ${inquiry.id} in database`);
      } catch (dbError) {
        console.warn(`DB insert failed for ${inquiry.id}:`, dbError.message);
      }
    }
    
    console.log(`Individual analysis completed for ${inquiry.firstName || inquiry.first_name} ${inquiry.familySurname || inquiry.family_surname} (score: ${analysis.leadScore})`);
    
    res.json({
      success: true,
      message: `AI analysis completed for ${inquiry.firstName || inquiry.first_name} ${inquiry.familySurname || inquiry.family_surname}`,
      inquiryId: inquiry.id,
      analysis: {
        leadScore: analysis.leadScore,
        urgencyLevel: analysis.urgencyLevel,
        leadTemperature: analysis.leadTemperature,
        confidence: analysis.confidence_score,
        conversationStarters: analysis.conversationStarters,
        sellingPoints: analysis.sellingPoints,
        nextActions: analysis.nextActions,
        insights: analysis.insights
      }
    });
  } catch (error) {
    console.error(`Individual AI analysis error for ${req.params.inquiryId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Individual AI analysis failed',
      message: error.message,
      inquiryId: req.params.inquiryId
    });
  }
});

app.get('/api/analytics/video-metrics', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }

    console.log('Video metrics request...');

    // Query video engagement data with family associations
    const videoData = await db.query(`
      SELECT 
        vet.video_id,
        vet.video_title,
        vet.inquiry_id as family_id,
        i.first_name,
        i.family_surname,
        -- Aggregate video metrics
        SUM(vet.watched_sec) as totalWatchTime,
        COUNT(DISTINCT vet.session_id) as sessions,
        -- Calculate completion rate (you'll need video duration)
        MAX(vet.current_time_sec) as maxProgress,
        -- Count events for engagement scoring
        COUNT(CASE WHEN vet.event_type = 'youtube_video_pause' THEN 1 END) as pauseCount,
        COUNT(CASE WHEN vet.event_type = 'youtube_video_play_enhanced' THEN 1 END) as replayCount,
        -- Estimated duration (you may need to store this separately)
        180 as duration, -- Default 3 minutes, replace with actual duration
        -- Calculate completion rate
        ROUND((MAX(vet.current_time_sec) / 180.0) * 100) as completionRate
      FROM video_engagement_tracking vet
      LEFT JOIN inquiries i ON vet.inquiry_id = i.id
      WHERE vet.video_id IS NOT NULL
      GROUP BY vet.video_id, vet.video_title, vet.inquiry_id, i.first_name, i.family_surname
      ORDER BY SUM(vet.watched_sec) DESC
    `);

    const formattedVideos = videoData.rows.map(row => ({
      video_id: row.video_id,
      title: row.video_title || 'Untitled Video',
      family_id: row.family_id,
      family_name: row.first_name && row.family_surname ? 
        `${row.first_name} ${row.family_surname}` : null,
      duration: parseInt(row.duration) || 180,
      totalWatchTime: parseInt(row.totalwatchtime) || 0,
      completionRate: parseInt(row.completionrate) || 0,
      pauseCount: parseInt(row.pausecount) || 0,
      replayCount: parseInt(row.replaycount) || 0,
      bufferingCount: 0, // Not tracked yet
      sessions: parseInt(row.sessions) || 1
    }));

    console.log(`Returning ${formattedVideos.length} video records`);
    res.json(formattedVideos);

  } catch (error) {
    console.error('Video metrics error:', error);
    res.status(500).json({ 
      error: 'Failed to get video metrics',
      message: error.message 
    });
  }
});

// AI narrative route
app.get('/api/family/:inquiryId/ai-summary', async (req, res) => {
  const { inquiryId } = req.params;
  
  try {
    // Step 1: fetch the snapshot
    const snapshotRes = await fetch(`http://localhost:3000/api/family/${inquiryId}`);
    const snapshot = await snapshotRes.json();
    
    // Step 2: admissions-style AI prompt
    const prompt = `
You are a member of the Admissions Team at a leading independent school in the United Kingdom.
Your role is to analyse parent engagement with a personalised school prospectus and report back to your colleagues. 
Always use British spelling, professional admissions language, and write as if you are giving trusted advice to the team.

Write a clear, detailed narrative that covers:
- Overall behaviour (time spent, visits, device context)
- Section-by-section commentary (what was read carefully, skimmed, or ignored)
- Video engagement (started, completed, abandoned)
- Conversion signals (e.g. clicked "Book a Visit", enquired further)
- Declared interests (academic and co-curricular)
- Geographical context (from IP/region if available)
- Your professional recommendation for follow-up (next best action)

Avoid bullet points; write in natural flowing sentences and paragraphs. Be concise but insightful, giving the admissions team a real sense of the family's engagement.

Snapshot data:
${JSON.stringify(snapshot, null, 2)}
`;
    
    // Step 3: call GPT
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    });
    
    const aiNarrative = completion.choices[0].message.content.trim();
    
    // Step 4: save to ai_family_insights
    if (db) {
      const upsertQ = `
        INSERT INTO ai_family_insights (inquiry_id, analysis_type, insights_json)
        VALUES ($1, $2, $3)
        ON CONFLICT (inquiry_id, analysis_type)
        DO UPDATE SET insights_json = EXCLUDED.insights_json
      `;
      
      await db.query(upsertQ, [
        inquiryId,
        'engagement_summary',
        JSON.stringify({
          snapshot,
          narrative: aiNarrative
        })
      ]);
    }
    
    // Step 5: return both
    res.json({ inquiry_id: inquiryId, snapshot, narrative: aiNarrative });
  } catch (err) {
    console.error("Error generating AI narrative:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/force-summary/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    
    const inquiryResult = await db.query(`
      SELECT 
        id,
        first_name,
        family_surname,
        entry_year,
        dwell_ms,
        return_visits
      FROM inquiries
      WHERE id = $1
    `, [inquiryId]);
    
    if (!inquiryResult.rows[0]) {
      return res.status(404).json({ error: 'Inquiry not found' });
    }
    
    const inquiry = inquiryResult.rows[0];
    const dwellMs = Number(inquiry.dwell_ms || 0);
    const minutes = Math.round(dwellMs / 60000);
    const visits = Number(inquiry.return_visits || 1);
    
    const sectionData = await db.query(`
      SELECT
        COALESCE(event_data->>'currentSection', 'unknown') AS section,
        SUM(COALESCE((event_data->>'timeInSectionSec')::int, 0)) AS dwell_seconds,
        MAX(COALESCE((event_data->>'maxScrollPct')::int, 0)) AS scroll_pct
      FROM tracking_events
      WHERE inquiry_id = $1
        AND event_type = 'section_exit'
      GROUP BY 1
      ORDER BY 2 DESC
    `, [inquiryId]);
    
    const sections = sectionData.rows;
    
    let narrative = `${inquiry.first_name} ${inquiry.family_surname}'s family has spent ${minutes} minutes exploring their personalised prospectus`;
    if (visits > 1) {
      narrative += ` across ${visits} visits`;
    }
    narrative += '. ';
    
    if (sections.length > 0) {
      const topSections = sections
        .slice(0, 3)
        .filter(s => s.dwell_seconds > 0)
        .map(s => s.section.replace(/_/g, ' '));
        
      if (topSections.length > 0) {
        narrative += `They showed strong interest in ${topSections.join(', ')}, `;
        
        const fullScroll = sections.filter(s => s.scroll_pct >= 100);
        if (fullScroll.length > 0) {
          narrative += `thoroughly reviewing ${fullScroll.length} section${fullScroll.length > 1 ? 's' : ''} completely. `;
        }
      }
    }
    
    narrative += `This level of engagement indicates genuine interest in More House. A personalised follow-up discussing their areas of interest would be valuable.`;
    
    const highlights = [
      `• ${minutes} minutes of focused engagement`,
      `• ${sections.length} sections explored`,
      visits > 1 ? `• ${visits} visits showing sustained interest` : `• Initial exploration completed`,
      `• Ready for targeted follow-up`,
      `• Strong candidate for admission`
    ];
    
    // Try AI generation if available
    if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
      try {
        const snapshot = {
          sections: [],
          totals: {
            time_on_page_ms: dwellMs,
            video_ms: 0,
            clicks: 0,
            total_visits: visits
          },
          sections: sections.map(s => ({
            section: s.section,
            dwell_ms: s.dwell_seconds * 1000,
            video_ms: 0,
            clicks: 0
          }))
        };
        
        const aiResult = await generateAiEngagementStory(snapshot, {
          first_name: inquiry.first_name,
          family_surname: inquiry.family_surname,
          entry_year: inquiry.entry_year
        });
        
        if (aiResult && aiResult.narrative && !aiResult.narrative.includes('Limited tracking')) {
          narrative = aiResult.narrative;
          if (aiResult.highlights) {
            highlights.length = 0;
            highlights.push(...aiResult.highlights);
          }
        } else {
          console.log('AI generation failed, using deterministic summary');
        }
      } catch (aiError) {
        console.log('AI generation failed, using deterministic summary');
      }
    }
    
    await db.query(`
      INSERT INTO ai_family_insights (inquiry_id, analysis_type, insights_json, generated_at)
      VALUES ($1, 'engagement_summary', $2::jsonb, NOW())
      ON CONFLICT (inquiry_id, analysis_type)
      DO UPDATE SET 
        insights_json = EXCLUDED.insights_json,
        generated_at = NOW()
    `, [inquiryId, JSON.stringify({ narrative, highlights })]);
    
    res.json({
      success: true,
      aiSummary: { narrative, highlights },
      summary: { narrative, highlights },
      data: {
        dwellMinutes: minutes,
        visits,
        sectionCount: sections.length
      }
    });
  } catch (error) {
    console.error('Force summary error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/fix-all-summaries', async (req, res) => {
  try {
    const problematic = await db.query(`
      SELECT 
        i.id,
        i.first_name,
        i.family_surname,
        i.entry_year,
        i.dwell_ms,
        afi.insights_json
      FROM inquiries i
      LEFT JOIN ai_family_insights afi 
        ON i.id = afi.inquiry_id 
        AND afi.analysis_type = 'engagement_summary'
      WHERE i.dwell_ms > 0
        AND (
          afi.insights_json->>'narrative' LIKE '%Limited tracking%'
          OR afi.insights_json->>'narrative' LIKE '%awaiting%'
          OR afi.insights_json->>'narrative' IS NULL
        )
    `);
    
    const fixed = [];
    
    for (const inquiry of problematic.rows) {
      const inquiryId = inquiry.id;
      const dwellMs = Number(inquiry.dwell_ms || 0);
      const minutes = Math.round(dwellMs / 60000);
      const seconds = Math.round(dwellMs / 1000);
      
      const sections = await db.query(`
        SELECT
          COALESCE(event_data->>'currentSection', 'unknown') AS section,
          SUM(COALESCE((event_data->>'timeInSectionSec')::int, 0)) AS dwell_seconds,
          MAX(COALESCE((event_data->>'maxScrollPct')::int, 0)) AS scroll_pct
        FROM tracking_events
        WHERE inquiry_id = $1
          AND event_type = 'section_exit'
        GROUP BY 1
        ORDER BY 2 DESC
        LIMIT 5
      `, [inquiryId]);
      
      let narrative = `${inquiry.first_name} ${inquiry.family_surname}'s family spent ${minutes > 0 ? minutes + ' minutes' : seconds + ' seconds'} exploring their personalised prospectus. `;
      
      if (sections.rows.length > 0) {
        const topSections = sections.rows
          .slice(0, 3)
          .map(s => s.section.replace(/_/g, ' '))
          .filter(s => s !== 'unknown');
          
        if (topSections.length > 0) {
          narrative += `They showed particular interest in ${topSections.join(', ')}. `;
        }
      }
      
      narrative += `This engagement shows genuine interest in More House. A follow-up conversation would be valuable.`;
      
      const highlights = [
        `• Engaged for ${minutes > 0 ? minutes + ' minutes' : seconds + ' seconds'}`,
        `• Explored ${sections.rows.length} sections`,
        `• Ready for personalised follow-up`
      ];
      
      await db.query(`
        INSERT INTO ai_family_insights (inquiry_id, analysis_type, insights_json, generated_at)
        VALUES ($1, 'engagement_summary', $2::jsonb, NOW())
        ON CONFLICT (inquiry_id, analysis_type)
        DO UPDATE SET 
          insights_json = EXCLUDED.insights_json,
          generated_at = NOW()
      `, [inquiryId, JSON.stringify({ narrative, highlights })]);
      
      fixed.push({
        id: inquiryId,
        name: `${inquiry.first_name} ${inquiry.family_surname}`,
        dwellMinutes: minutes
      });
    }
    
    res.json({
      success: true,
      message: `Fixed ${fixed.length} summaries`,
      fixed
    });
  } catch (error) {
    console.error('Fix summaries error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoints
app.get('/api/debug/check-ai-summary/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    
    // Check what's in the database
    const aiData = await db.query(`
      SELECT analysis_type, insights_json, generated_at
      FROM ai_family_insights
      WHERE inquiry_id = $1
      ORDER BY analysis_type
    `, [inquiryId]);
    
    // Check inquiry dwell time
    const inquiryData = await db.query(`
      SELECT first_name, family_surname, dwell_ms, return_visits
      FROM inquiries
      WHERE id = $1
    `, [inquiryId]);
    
    // Check tracking events
    const trackingStats = await db.query(`
      SELECT 
        COUNT(*) as total_events,
        COUNT(DISTINCT session_id) as sessions,
        COUNT(CASE WHEN event_type = 'section_exit' THEN 1 END) as section_exits
      FROM tracking_events
      WHERE inquiry_id = $1
    `, [inquiryId]);
    
    const response = {
      inquiry: inquiryData.rows[0] || null,
      trackingStats: trackingStats.rows[0] || null,
      aiSummaries: {}
    };
    
    aiData.rows.forEach(row => {
      response.aiSummaries[row.analysis_type] = {
        generated_at: row.generated_at,
        narrative: row.insights_json?.narrative || 'No narrative',
        highlights: row.insights_json?.highlights || [],
        isFallback: row.insights_json?.narrative?.includes('Limited tracking available') || false
      };
    });
    
    res.json(response);
  } catch (error) {
    console.error('Check AI summary error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/debug/regenerate-ai-summary/:inquiryId', async (req, res) => {
  const forceRegenerate = req.query.force === 'true';
  
  try {
    const inquiryId = req.params.inquiryId;
    
    // Get inquiry data
    const inquiryData = await db.query(`
      SELECT * FROM inquiries WHERE id = $1
    `, [inquiryId]);
    
    // Check if current summary is fallback text
    const currentSummary = await db.query(`
      SELECT insights_json FROM ai_family_insights 
      WHERE inquiry_id = $1 AND analysis_type = 'engagement_summary'
    `, [inquiryId]);
    
    const hasFallback = currentSummary.rows[0]?.insights_json?.narrative?.includes('Limited tracking available');
    
    if (!hasFallback && !forceRegenerate) {
      return res.json({
        success: false,
        message: 'Summary already has good data. Use ?force=true to regenerate anyway.',
        current: currentSummary.rows[0]?.insights_json
      });
    }
    
    // Regenerate the summary
    const result = await summariseFamilyEngagement(db, inquiryData.rows[0]);
    
    // Store it
    await db.query(`
      INSERT INTO ai_family_insights (inquiry_id, analysis_type, insights_json, generated_at)
      VALUES ($1, 'engagement_summary', $2::jsonb, NOW())
      ON CONFLICT (inquiry_id, analysis_type)
      DO UPDATE SET insights_json = EXCLUDED.insights_json, generated_at = NOW()
    `, [inquiryId, JSON.stringify(result)]);
    
    res.json({
      success: true,
      regenerated: true,
      wasFallback: hasFallback,
      newSummary: result
    });
  } catch (error) {
    console.error('Regenerate AI summary error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/engagement/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    
    if (!db) return res.status(500).json({ error: 'Database not available' });
    
    const eventTypes = await db.query(`
      SELECT DISTINCT event_type, COUNT(*) as count
      FROM tracking_events
      WHERE inquiry_id = $1
      GROUP BY event_type
      ORDER BY count DESC
    `, [inquiryId]);
    
    const sampleEvents = await db.query(`
      SELECT event_type, event_data, timestamp
      FROM tracking_events
      WHERE inquiry_id = $1
      ORDER BY timestamp DESC
      LIMIT 5
    `, [inquiryId]);
    
    const sectionsCheck = await db.query(`
      SELECT 
        event_type,
        event_data->>'currentSection' as current_section,
        event_data->>'timeInSectionSec' as time_in_section,
        event_data->>'maxScrollPct' as max_scroll,
        timestamp
      FROM tracking_events
      WHERE inquiry_id = $1
        AND event_data IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT 10
    `, [inquiryId]);
    
    const summaryQuery = await db.query(`
      WITH sec AS (
        SELECT 
          COALESCE(event_data->>'currentSection','unknown') AS section,
          SUM(COALESCE((event_data->>'timeInSectionSec')::int,0)) AS dwell_seconds,
          MAX(COALESCE((event_data->>'maxScrollPct')::int,0)) AS max_scroll_pct
        FROM tracking_events
        WHERE inquiry_id = $1
          AND event_type = 'section_exit'
          AND event_data IS NOT NULL
        GROUP BY 1
      )
      SELECT * FROM sec
      ORDER BY dwell_seconds DESC
    `, [inquiryId]);
    
    const engagementMetrics = await db.query(`
      SELECT time_on_page, scroll_depth, clicks_on_links, total_visits, last_visit
      FROM engagement_metrics
      WHERE inquiry_id = $1
    `, [inquiryId]);
    
    const inquiryData = await db.query(`
      SELECT dwell_ms, return_visits FROM inquiries WHERE id = $1
    `, [inquiryId]);
    
    const debugInfo = {
      inquiryId,
      diagnostics: {
        eventTypeCounts: eventTypes.rows,
        sampleRawEvents: sampleEvents.rows.map(r => ({
          type: r.event_type,
          data: r.event_data,
          timestamp: r.timestamp
        })),
        sectionExitEvents: sectionsCheck.rows,
        aggregatedSections: summaryQuery.rows,
        engagementMetrics: engagementMetrics.rows[0] || null,
        inquiryTableData: inquiryData.rows[0] || null
      },
      analysis: {
        hasTrackingEvents: eventTypes.rows.length > 0,
        hasSectionExitEvents: eventTypes.rows.some(r => r.event_type === 'section_exit'),
        sectionsWithData: summaryQuery.rows.filter(r => Number(r.dwell_seconds) > 0).length,
        problemIdentified: null
      }
    };
    
    if (!debugInfo.diagnostics.eventTypeCounts.length) {
      debugInfo.analysis.problemIdentified = "NO_TRACKING_EVENTS: No events in tracking_events table";
    } else if (!debugInfo.analysis.hasSectionExitEvents) {
      debugInfo.analysis.problemIdentified = "NO_SECTION_EXIT_EVENTS: Events exist but no 'section_exit' type";
    } else if (debugInfo.diagnostics.sectionExitEvents.length === 0) {
      debugInfo.analysis.problemIdentified = "EVENT_DATA_NULL: section_exit events exist but event_data is NULL";
    } else if (debugInfo.analysis.sectionsWithData === 0) {
      debugInfo.analysis.problemIdentified = "NO_DWELL_TIME: section_exit events exist but timeInSectionSec is 0 or missing";
    } else {
      debugInfo.analysis.problemIdentified = "DATA_EXISTS: Data exists and should trigger AI";
    }
    
    res.json(debugInfo);
  } catch (error) {
    console.error('Debug endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Geographical analytics
app.get('/api/analytics/geographical', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }
    
    const geoData = await db.query(`
      SELECT 
        country, region, city,
        COUNT(*) as family_count,
        AVG(dwell_ms) as avg_engagement_ms,
        AVG(return_visits) as avg_visits,
        MAX(received_at) as latest_inquiry
      FROM inquiries 
      WHERE country IS NOT NULL AND country != 'Unknown'
      GROUP BY country, region, city
      ORDER BY family_count DESC, avg_engagement_ms DESC
    `);
    
    const countryData = await db.query(`
      SELECT 
        country,
        COUNT(*) as families,
        AVG(dwell_ms) as avg_engagement,
        SUM(CASE WHEN dwell_ms > 60000 THEN 1 ELSE 0 END) as engaged_families
      FROM inquiries 
      WHERE country IS NOT NULL AND country != 'Unknown'
      GROUP BY country
      ORDER BY families DESC
    `);
    
    res.json({
      locations: geoData.rows,
      countries: countryData.rows,
      summary: {
        totalCountries: countryData.rows.length,
        totalLocations: geoData.rows.length,
        topCountry: countryData.rows[0]?.country || 'Unknown',
        internationalFamilies: countryData.rows.filter(c => c.country !== 'GB').length
      }
    });
  } catch (error) {
    console.error('Geographical analytics error:', error);
    res.status(500).json({ error: 'Failed to get geographical data' });
  }
});

// Section data endpoint
app.get('/api/section-data/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    
    if (!db) {
      return res.status(500).json({ error: 'Database not available' });
    }
    
    // Enhanced section breakdown including video events
    const sections = await db.query(`
      SELECT
        COALESCE(event_data->>'currentSection', 'unknown') AS section_id,
        SUM(COALESCE((event_data->>'timeInSectionSec')::int, 0)) AS dwell_seconds,
        SUM(COALESCE((event_data->>'thisVisitSeconds')::int, 0)) AS session_seconds,
        MAX(COALESCE((event_data->>'maxScrollPct')::int, 0)) AS max_scroll_pct,
        COUNT(CASE WHEN event_type = 'link_click' OR event_type = 'content_link_click' THEN 1 END) AS clicks,
        -- Video engagement aggregation
        SUM(COALESCE((event_data->>'totalWatchTime')::int, 0)) AS video_watch_seconds,
        SUM(COALESCE((event_data->>'watchedSec')::int, 0)) AS video_watched_alt,
        COUNT(CASE WHEN event_type LIKE 'youtube_video_%' THEN 1 END) AS video_events,
        -- Video milestones and completion
        COUNT(CASE WHEN event_type = 'youtube_video_milestone' THEN 1 END) AS video_milestones,
        COUNT(CASE WHEN event_type = 'youtube_video_complete' THEN 1 END) AS video_completions,
        -- Enhanced engagement metrics
        MAX(COALESCE((event_data->>'engagementScore')::int, 0)) AS section_engagement_score,
        MAX(COALESCE((event_data->>'interactionQuality')::int, 0)) AS interaction_quality,
        MAX(COALESCE((event_data->>'returnVisits')::int, 0)) AS section_return_visits
      FROM tracking_events
      WHERE inquiry_id = $1
        AND event_type IN (
          'section_exit_enhanced', 'section_exit', 'link_click', 'content_link_click',
          'youtube_video_play_enhanced', 'youtube_video_milestone', 'youtube_video_complete',
          'youtube_video_pause', 'significant_click'
        )
      GROUP BY 1
      HAVING SUM(COALESCE((event_data->>'timeInSectionSec')::int, 0)) > 0
         OR COUNT(CASE WHEN event_type LIKE 'youtube_video_%' THEN 1 END) > 0
      ORDER BY 2 DESC
    `, [inquiryId]);
    
    // Get unique session count for accurate visit tracking
    const visits = await db.query(`
      SELECT COUNT(DISTINCT session_id) as visit_count
      FROM tracking_events
      WHERE inquiry_id = $1
        AND session_id IS NOT NULL
    `, [inquiryId]);
    
    // Get total dwell from inquiries table (the authoritative source)
    const inquiryData = await db.query(`
      SELECT dwell_ms, return_visits, first_name, family_surname
      FROM inquiries 
      WHERE id = $1
    `, [inquiryId]);
    
    const inquiry = inquiryData.rows[0];
    if (!inquiry) {
      return res.status(404).json({ error: 'Inquiry not found' });
    }
    
    // Sum actual section engagement time from section_exit events
    const sessionTotals = await db.query(`
      SELECT 
        COUNT(DISTINCT session_id) as session_count,
        SUM(COALESCE((event_data->>'dwellSec')::int, 0)) as total_seconds
      FROM tracking_events 
      WHERE inquiry_id = $1 AND event_type = 'section_exit'
    `, [inquiryId]);

    const totalSeconds = parseInt(sessionTotals.rows[0]?.total_seconds || 0);
    const dwellMs = totalSeconds * 1000; // For location 1
    const totalDwellMs = totalSeconds * 1000; // For location 2
    const visitCount = Math.max(parseInt(sessionTotals.rows[0]?.session_count || 0), 1);
    
        
    // Calculate comprehensive engagement score
    const engagementScore = calculateEngagementScore({
      timeOnPage: totalDwellMs,
      scrollDepth: sections.rows.length > 0 ? 
        Math.max(...sections.rows.map(r => parseInt(r.max_scroll_pct || 0))) : 0,
      totalVisits: visitCount,
      clickCount: sections.rows.reduce((sum, r) => sum + parseInt(r.clicks || 0), 0)
    });
    
    // Format sections with enhanced data including video metrics
    const formattedSections = sections.rows.map(row => {
      const dwellSeconds = parseInt(row.dwell_seconds || 0);
      const videoWatchSeconds = Math.max(
        parseInt(row.video_watch_seconds || 0),
        parseInt(row.video_watched_alt || 0)
      );
      
      return {
        section_name: prettySectionName(row.section_id),
        section_id: row.section_id,
        dwell_seconds: dwellSeconds,
        dwell_minutes: Math.round(dwellSeconds / 60),
        max_scroll_pct: parseInt(row.max_scroll_pct || 0),
        clicks: parseInt(row.clicks || 0),
        // Video engagement data
        video_watch_seconds: videoWatchSeconds,
        video_watch_minutes: Math.round(videoWatchSeconds / 60),
        video_events: parseInt(row.video_events || 0),
        video_milestones: parseInt(row.video_milestones || 0),
        video_completions: parseInt(row.video_completions || 0),
        has_video_engagement: videoWatchSeconds > 0 || parseInt(row.video_events || 0) > 0,
        // Enhanced metrics
        engagement_score: parseInt(row.section_engagement_score || 0),
        interaction_quality: parseInt(row.interaction_quality || 0),
        return_visits: parseInt(row.section_return_visits || 0)
      };
    });
    
    // Calculate video engagement summary
    const totalVideoSeconds = formattedSections.reduce((sum, s) => sum + s.video_watch_seconds, 0);
    const sectionsWithVideo = formattedSections.filter(s => s.has_video_engagement).length;
    const totalVideoCompletions = formattedSections.reduce((sum, s) => sum + s.video_completions, 0);
    
    res.json({
      inquiryId,
      familyName: `${inquiry.first_name || ''} ${inquiry.family_surname || ''}`.trim(),
      sections: formattedSections,
      totalDwellMs,
      totalDwellMinutes: Math.round(totalDwellMs / 60000),
      totalDwellSeconds: Math.round(totalDwellMs / 1000),
      visitCount,
      engagementScore,
      // Video engagement summary
      videoEngagement: {
        totalVideoSeconds,
        totalVideoMinutes: Math.round(totalVideoSeconds / 60),
        sectionsWithVideo,
        videoCompletions: totalVideoCompletions,
        hasVideoEngagement: totalVideoSeconds > 0
      },
      // Enhanced metrics
      summary: {
        sectionsExplored: formattedSections.length,
        totalClicks: formattedSections.reduce((sum, s) => sum + s.clicks, 0),
        avgScrollDepth: formattedSections.length > 0 ? 
          Math.round(formattedSections.reduce((sum, s) => sum + s.max_scroll_pct, 0) / formattedSections.length) : 0,
        highEngagementSections: formattedSections.filter(s => s.dwell_seconds > 30).length
      },
      hasData: formattedSections.length > 0 || totalDwellMs > 0
    });
    
  } catch (error) {
    console.error('Section data endpoint error:', error);
    res.status(500).json({
      error: 'Failed to get section data',
      message: error.message,
      inquiryId: req.params.inquiryId
    });
  }
});

// Helper function (add this if not already present)
function calculateEngagementScore(engagement) {
  if (!engagement) return 0;
  let score = 0;
  
  // Time spent (40% weight)
  const timeMinutes = (engagement.timeOnPage || 0) / 60000;
  if (timeMinutes >= 30) score += 40;
  else if (timeMinutes >= 15) score += 30;
  else if (timeMinutes >= 5) score += 20;
  else score += Math.min(timeMinutes * 4, 15);
  
  // Content depth (30% weight)
  const scrollDepth = engagement.scrollDepth || 0;
  score += Math.min(scrollDepth * 0.3, 30);
  
  // Return visits (20% weight)
  const visits = engagement.totalVisits || 1;
  if (visits >= 7) score += 20;
  else if (visits >= 4) score += 15;
  else if (visits >= 2) score += 10;
  else score += 5;
  
  // Interaction quality (10% weight)
  const clicks = engagement.clickCount || 0;
  score += Math.min(clicks * 2, 10);
  
  return Math.min(Math.round(score), 100);
}

app.get('/api/debug/snapshot/:inquiryId', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No database' });
  
  try {
    const inquiryId = req.params.inquiryId;
    const snapshot = await buildEngagementSnapshot(db, inquiryId);
    
    res.json({
      inquiryId,
      snapshot,
      hasData: snapshot.totals.time_on_page_ms > 0 || snapshot.sections.length > 0
    });
  } catch (error) {
    console.error('Snapshot debug error:', error);
    res.status(500).json({ error: error.message });
  }
});

// === Latest visit timeline (read-only) ==========================
app.get('/api/visits/:inquiryId/latest', async (req, res) => {
  const { inquiryId } = req.params;
  if (!inquiryId) return res.status(400).json({ ok: false, error: 'Missing inquiryId' });

  try {
    if (!db) return res.json({ ok: true, session: null, events: [] });

    // Find most recent session for this inquiry
    const sess = await db.query(`
      WITH sessions AS (
        SELECT session_id,
               MIN(timestamp) AS start_ts,
               MAX(timestamp) AS end_ts
        FROM tracking_events
        WHERE inquiry_id = $1
          AND session_id IS NOT NULL
        GROUP BY session_id
        ORDER BY end_ts DESC
        LIMIT 1
      )
      SELECT session_id, start_ts, end_ts
      FROM sessions
    `, [inquiryId]);

    if (!sess.rows.length) return res.json({ ok: true, session: null, events: [] });

    const { session_id, start_ts, end_ts } = sess.rows[0];

    // Pull ordered events for that session
    const evs = await db.query(`
      SELECT event_type, event_data, timestamp
      FROM tracking_events
      WHERE inquiry_id = $1
        AND session_id = $2
      ORDER BY timestamp ASC
    `, [inquiryId, session_id]);

    // Light transform: flatten JSON and keep only what we need in the dashboard
    const events = evs.rows.map(r => ({
      type: r.event_type,
      ts: r.timestamp,
      name: (r.event_data && r.event_data.name) || r.event_type,
      section: r.event_data && r.event_data.section || null,
      dwellSec: r.event_data && (r.event_data.dwellSec ?? null),
      tier: r.event_data && r.event_data.tier || null,
      reason: r.event_data && r.event_data.reason || null,
      youtubeId: r.event_data && r.event_data.youtubeId || null,
      title: r.event_data && r.event_data.title || null
    }));

    res.json({
      ok: true,
      session: { id: session_id, start: start_ts, end: end_ts },
      events
    });
  } catch (e) {
    console.error('latest visit error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// === Per-session events (used by dashboard session history) ===
app.get('/api/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'Missing sessionId' });

  try {
    if (!db) return res.json({ ok: true, events: [] });

    const evs = await db.query(`
      SELECT event_type, event_data, timestamp
      FROM tracking_events
      WHERE session_id = $1
      ORDER BY timestamp ASC
    `, [sessionId]);

    const events = evs.rows.map(r => ({
      type: r.event_type,
      ts: r.timestamp,
      name: (r.event_data && r.event_data.name) || r.event_type,
      section: r.event_data?.section ?? null,
      dwellSec: r.event_data?.dwellSec ?? null,
      tier: r.event_data?.tier ?? null,
      reason: r.event_data?.reason ?? null,
      youtubeId: r.event_data?.youtubeId ?? null,
      title: r.event_data?.title ?? null
    }));

    res.json({ ok: true, sessionId, events });
  } catch (e) {
    console.error('session events error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});


app.get('/api/check-summary/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    
    const data = await db.query(`
      SELECT 
        i.id,
        i.first_name,
        i.family_surname,
        i.dwell_ms,
        i.return_visits,
        afi.insights_json,
        afi.generated_at
      FROM inquiries i
      LEFT JOIN ai_family_insights afi ON i.id = afi.inquiry_id AND afi.analysis_type = 'engagement_summary'
      WHERE i.id = $1
    `, [inquiryId]);
    
    const sections = await db.query(`
      SELECT 
        COUNT(*) as count,
        SUM(COALESCE((event_data->>'timeInSectionSec')::int, 0)) AS total_dwell
      FROM tracking_events
      WHERE inquiry_id = $1 AND event_type = 'section_exit'
    `, [inquiryId]);
    
    res.json({
      inquiry: data.rows[0],
      trackingEvents: sections.rows,
      currentSummary: data.rows[0]?.insights_json,
      problem: data.rows[0]?.insights_json?.narrative?.includes('Limited tracking') ? 
        'DEFAULT_MESSAGE_DESPITE_DATA' : 'OK'
    });
  } catch (error) {
    console.error('Check summary error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add this function to your server.js file

async function updateInquiryMetrics(inquiryId, sessionInfo, data) {
  if (!db || !sessionInfo) return;
  
  try {
    const timeOnPage = Math.round((sessionInfo.timeOnPage || 0) / 1000); // Convert to seconds
    const maxScroll = sessionInfo.maxScrollDepth || 0;
    const clicks = sessionInfo.clickCount || 0;
    
    await db.query(`
      UPDATE inquiries 
      SET 
        dwell_ms = GREATEST(COALESCE(dwell_ms, 0), $2),
        return_visits = GREATEST(COALESCE(return_visits, 1), 1),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [inquiryId, timeOnPage * 1000]); // Store as milliseconds
    
    console.log(`Updated metrics for ${inquiryId}: ${timeOnPage}s, ${maxScroll}% scroll, ${clicks} clicks`);
    
  } catch (error) {
    console.warn('Failed to update inquiry metrics:', error.message);
  }
}

// Admin endpoints
app.get('/api/inquiries', async (_req, res) => {
  try {
    const inquiries = [];
    const files = await fs.readdir(path.join(__dirname, 'data'));
    
    for (const f of files.filter(f => f.startsWith('inquiry-') && f.endsWith('.json'))) {
      try {
        inquiries.push(JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8')));
      } catch (fileError) {
        console.warn(`Failed to read ${f}:`, fileError.message);
      }
    }
    
    inquiries.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    res.json({ success: true, count: inquiries.length, inquiries });
  } catch (e) {
    console.error('raw inquiries error:', e);
    res.status(500).json({ success: false, error: 'Failed to list inquiries' });
  }
});

app.get('/api/raw-family-data', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'No database' });
    
    const result = await db.query(`
      SELECT 
        i.id, i.first_name, i.family_surname, i.parent_email, i.entry_year,
        i.dwell_ms, i.return_visits, i.received_at, i.status, i.slug,
        i.country, i.region, i.city,
        afi.insights_json as ai_engagement
      FROM inquiries i
      LEFT JOIN ai_family_insights afi 
        ON i.id = afi.inquiry_id 
        AND afi.analysis_type = 'engagement_summary'
      ORDER BY i.received_at DESC
    `);
    
    const families = result.rows.map(row => ({
      id: row.id,
      first_name: row.first_name,
      family_surname: row.family_surname,
      parent_email: row.parent_email,
      entry_year: row.entry_year,
      dwell_ms: parseInt(row.dwell_ms) || 0,
      return_visits: parseInt(row.return_visits) || 1,
      status: row.status,
      received_at: row.received_at,
      country: row.country,
      region: row.region,
      city: row.city,
      aiEngagement: row.ai_engagement ? (typeof row.ai_engagement === 'string' ? JSON.parse(row.ai_engagement) : row.ai_engagement) : null
    }));
    
    res.json(families);
  } catch (error) {
    console.error('Raw data error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/admin/rebuild-slugs', async (req, res) => {
  try {
    console.log('Manual slug rebuild requested...');
    const added = await rebuildSlugIndexFromData();
    
    const summary = {
      success: true,
      message: `Rebuilt slug index successfully`,
      details: {
        newMappings: added,
        totalMappings: Object.keys(slugIndex).length,
        currentSlugs: Object.keys(slugIndex).slice(0, 10)
      }
    };
    
    console.log('Manual slug rebuild complete:', summary);
    res.json(summary);
  } catch (error) {
    console.error('Manual slug rebuild failed:', error);
    res.status(500).json({
      success: false,
      error: 'Slug rebuild failed',
      message: error.message
    });
  }
});

app.get('/admin/debug-database', async (req, res) => {
  try {
    if (!db) {
      return res.json({ error: 'Database not connected' });
    }
    
    const columns = await db.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'inquiries'
      ORDER BY column_name
    `);
    
    const sample = await db.query(`
      SELECT id, first_name, family_surname, slug, prospectus_url, 
             prospectus_filename, prospectus_generated, status
      FROM inquiries
      LIMIT 5
    `);
    
    const [{ count }] = (await db.query(`SELECT COUNT(*) as count FROM inquiries`)).rows;
    
    let aiCount = 0;
    try {
      const [{ count: aiInsights }] = (await db.query(`SELECT COUNT(*) as count FROM ai_family_insights`)).rows;
      aiCount = aiInsights;
    } catch (e) {
      console.warn('AI insights table not found:', e.message);
    }
    
    res.json({
      totalInquiries: count,
      aiInsights: aiCount,
      columns: columns.rows.map(r => ({ name: r.column_name, type: r.data_type })),
      sampleData: sample.rows
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Static file routes
app.get('/prospectuses/:filename', async (req, res) => {
  try {
    const filename = String(req.params.filename || '');
    let abs = path.join(__dirname, 'prospectuses', filename);
    
    try { 
      await fs.access(abs); 
      return res.sendFile(abs); 
    } catch {}
    
    const files = await fs.readdir(path.join(__dirname, 'data'));
    for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
      try {
        const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
        if (j.prospectusFilename === filename) {
          const p = await generateProspectus(j);
          await updateInquiryStatus(j.id, p);
          abs = path.join(__dirname, 'prospectuses', p.filename);
          return res.sendFile(abs);
        }
      } catch (fileError) {
        console.warn(`Failed to process ${f}:`, fileError.message);
      }
    }
    
    return res.status(404).send('Prospectus file not found');
  } catch (e) {
    console.error('Direct file recover failed:', e);
    return res.status(500).send('Failed to load prospectus file');
  }
});


// Replace your existing /api/deepl endpoint with this:
app.post('/api/deepl', async (req, res) => {
  try {
    const DEEPL_API_KEY  = process.env.DEEPL_API_KEY;
    const DEEPL_ENDPOINT = process.env.DEEPL_API_BASE || 'https://api.deepl.com/v2/translate';

    if (!DEEPL_API_KEY) {
      return res.status(500).json({ error: 'DEEPL_API_KEY missing' });
    }

    const { html, target_lang } = req.body || {};
    const ALLOWED = new Set(['en','zh','ar','ru','fr','es','de','it']);

    if (typeof html !== 'string' || !html.trim()) {
      return res.status(400).json({ error: 'Missing html' });
    }
    if (!ALLOWED.has((target_lang || '').toLowerCase())) {
      return res.status(400).json({ error: 'Unsupported target_lang' });
    }

    // CACHE CHECK: Try to get from cache first
    const cached = await translationCache.get(html, target_lang, 'web');
    if (cached) {
      console.log(`✔ Cache hit: serving cached ${target_lang} translation`);
      return res.json({ translated: cached });
    }

    // CACHE MISS: Need to call DeepL
    console.log(`➜ Cache miss: calling DeepL for ${target_lang} translation`);

    // Build form for DeepL (HTML-aware)
    const form = new URLSearchParams();
    form.append('text', html);
    form.append('target_lang', String(target_lang).toUpperCase()); // e.g. FR, DE
    form.append('tag_handling', 'html');
    form.append('preserve_formatting', '1');
    form.append('split_sentences', 'nonewlines');

    // Node 18+ has global fetch
    const dl = await fetch(DEEPL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form
    });

    const payload = await dl.json();
    if (!dl.ok) {
      return res.status(502).json({ error: 'DeepL error', details: payload });
    }

    const translated = payload?.translations?.[0]?.text || '';
    
    // CACHE SAVE: Store the translation for future use
    await translationCache.set(html, translated, target_lang, 'web');
    console.log(`💾 Cached new ${target_lang} translation`);
    
    return res.json({ translated });
  } catch (err) {
    console.error('DeepL proxy failed:', err);
    return res.status(500).json({ error: 'Proxy failure' });
  }
});


// Slug-based routing
const RESERVED = new Set([
  'api','prospectuses','health','tracking','dashboard','favicon','robots',
  'sitemap','metrics','config','webhook','admin','smart_analytics_dashboard.html',
  'download'  // ADD THIS LINE
]);

// Download routes - MUST come before /:slug to avoid route conflicts
app.get('/download/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase();
    console.log(`📥 Download request for slug: ${slug}`);

    const inquiry = await findInquiryBySlug(slug);
    if (!inquiry) {
      return res.status(404).send('Prospectus not found');
    }

    console.log(`Found inquiry for download: ${inquiry.firstName} ${inquiry.familySurname}`);

    // Generate prospectus if needed
    let prospectusInfo;
    try {
      prospectusInfo = await generateProspectus(inquiry);
    } catch (genError) {
      console.error('Failed to generate prospectus for download:', genError);
      return res.status(500).send('Failed to generate prospectus');
    }
    
    // Read the generated file
    const filePath = path.join(__dirname, 'prospectuses', prospectusInfo.filename);
    let html;
    
    try {
      html = await fs.readFile(filePath, 'utf8');
    } catch (readError) {
      console.error('Failed to read prospectus file:', readError);
      return res.status(500).send('Failed to read prospectus file');
    }
    
    // Create download filename
    const downloadFilename = `${inquiry.firstName}-${inquiry.familySurname}-Prospectus-${inquiry.entryYear}-OFFLINE.html`;
    
    // Set headers for download
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    console.log(`✅ Sending download: ${downloadFilename}`);
    res.send(html);

  } catch (error) {
    console.error('❌ Download via slug failed:', error);
    res.status(500).send(`Download failed: ${error.message}`);
  }
});

// Download route via inquiry ID - for dashboard use
app.get('/api/download/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    console.log(`📥 API Download request for inquiry: ${inquiryId}`);

    // Find the inquiry data
    const inquiry = await findInquiryByIdFixed(inquiryId);
    if (!inquiry) {
      return res.status(404).json({ error: 'Inquiry not found' });
    }

    console.log(`Found inquiry for API download: ${inquiry.firstName} ${inquiry.familySurname}`);

    // Generate prospectus if needed
    let prospectusInfo;
    try {
      prospectusInfo = await generateProspectus(inquiry);
    } catch (genError) {
      console.error('Failed to generate prospectus for API download:', genError);
      return res.status(500).json({ error: 'Failed to generate prospectus' });
    }
    
    // Read the generated file
    const filePath = path.join(__dirname, 'prospectuses', prospectusInfo.filename);
    let html;
    
    try {
      html = await fs.readFile(filePath, 'utf8');
    } catch (readError) {
      console.error('Failed to read prospectus file for API:', readError);
      return res.status(500).json({ error: 'Failed to read prospectus file' });
    }
    
    // Create download filename
    const downloadFilename = `${inquiry.firstName}-${inquiry.familySurname}-Prospectus-${inquiry.entryYear}-OFFLINE.html`;
    
    // Set headers for download
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    console.log(`✅ Sending API download: ${downloadFilename}`);
    res.send(html);

  } catch (error) {
    console.error('❌ API Download failed:', error);
    res.status(500).json({ error: `Download failed: ${error.message}` });
  }
});

app.get('/:slug', async (req, res, next) => {
  const slug = String(req.params.slug || '').toLowerCase();
  
  if (!/^[a-z0-9-]+$/.test(slug)) return next();
  if (RESERVED.has(slug)) return next();
  
  try {
    console.log(`Looking up slug: ${slug}`);
    let rel = slugIndex[slug];
    
    if (!rel) {
      console.log(`Slug not in index, rebuilding...`);
      await rebuildSlugIndexFromData();
      rel = slugIndex[slug];
    }
    
    if (!rel) {
      console.log(`Searching for inquiry with slug: ${slug}`);
      const inquiry = await findInquiryBySlug(slug);
      if (inquiry) {
        try {
          console.log(`Regenerating prospectus for found inquiry: ${inquiry.id}`);
          const language = req.query.lang || 'en';
          console.log(`URL language parameter: ${language}`);
          inquiry.language = language;
          const p = await generateProspectus(inquiry);
          await updateInquiryStatus(inquiry.id, p);
          rel = p.url;
          slugIndex[slug] = rel;
          await saveSlugIndex();
          console.log(`Regenerated and mapped: ${slug} -> ${rel}`);
        } catch (e) {
          console.error('Auto-regen failed for slug', slug, e.message);
          return res.status(500).send('Failed to generate prospectus');
        }
      }
    }
    
    if (!rel) {
      console.log(`Slug not found: ${slug}`);
      return res.status(404).send(`
        <h1>Prospectus Not Found</h1>
        <p>The link /${slug} could not be found.</p>
        <p><a href="/admin/rebuild-slugs">Rebuild Slug Index</a></p>
      `);
    }
    
    let abs = path.join(__dirname, rel);
    try {
      await fs.access(abs);
      console.log(`Serving: ${slug} -> ${rel}`);
      return res.sendFile(abs);
    } catch (accessError) {
      console.log(`File missing, attempting to regenerate: ${abs}`);
      try {
        const inquiry = await findInquiryBySlug(slug);
        if (inquiry) {
          const language = req.query.lang || 'en';
          console.log(`URL language parameter: ${language}`);
          inquiry.language = language;
          const p = await generateProspectus(inquiry);
          await updateInquiryStatus(inquiry.id, p);
          slugIndex[slug] = p.url;
          await saveSlugIndex();
          abs = path.join(__dirname, 'prospectuses', p.filename);
          console.log(`Regenerated and serving: ${slug} -> ${p.url}`);
          return res.sendFile(abs);
        }
      } catch (regenError) {
        console.error('Regeneration failed:', regenError.message);
      }
    }
    
    console.error('Failed to serve slug:', slug);
    return res.status(500).send('Failed to load prospectus');
  } catch (e) {
    console.error('Slug routing error:', e);
    return next();
  }
});

// Family snapshot endpoint
app.get('/api/family/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    const base = getBaseUrl(req);
    
    // 1. Get base family info
    const inquiryQ = `
      SELECT id, first_name, family_surname, parent_email,
             age_group, entry_year, prospectus_url, prospectus_filename,
             prospectus_generated_at, received_at, dwell_ms, return_visits,
             country, region, city, latitude, longitude, timezone, isp,
             sciences, mathematics, english, languages, humanities, business,
             drama, music, art, creative_writing, sport, leadership,
             community_service, outdoor_education, academic_excellence,
             pastoral_care, university_preparation, personal_development,
             career_guidance, extracurricular_opportunities, debating,
             small_classes, london_location, values_based, university_prep
      FROM inquiries 
      WHERE id = $1
    `;
    
    const inquiryRes = await db.query(inquiryQ, [inquiryId]);
    if (inquiryRes.rows.length === 0) {
      return res.status(404).json({ error: "Family not found" });
    }
    
    const inquiry = inquiryRes.rows[0];
    
    // Build prospectus URL (fallback to filename if needed)
    const prospectusUrl = inquiry.prospectus_url ||
      (inquiry.prospectus_filename ? `/prospectuses/${inquiry.prospectus_filename}` : null);
    
    // 2. Engagement metrics (aggregated)
    const metricsQ = `
      SELECT 
        SUM(time_on_page) AS total_time,
        AVG(pages_viewed) AS avg_pages,
        MAX(scroll_depth) AS max_scroll,
        SUM(clicks_on_links) AS total_clicks,
        MAX(total_visits) AS total_visits,
        MAX(last_visit) AS last_visit
      FROM engagement_metrics
      WHERE inquiry_id = $1
    `;
    
    const metricsRes = await db.query(metricsQ, [inquiryId]);
    const metrics = metricsRes.rows[0] || {};
    
    // 3. Section-level breakdown from tracking_events
    const sectionQ = `
      SELECT current_section,
             COUNT(*) AS events,
             SUM(time_on_page) AS total_time,
             MAX(scroll_depth) AS max_scroll,
             SUM(conversion_signals) AS conversions
      FROM tracking_events
      WHERE inquiry_id = $1
      GROUP BY current_section
      ORDER BY total_time DESC NULLS LAST
    `;
    
    const sectionRes = await db.query(sectionQ, [inquiryId]);
    const sections = sectionRes.rows.map(r => ({
      section: r.current_section || "Unknown",
      time_spent: Number(r.total_time || 0),
      scroll_depth: Number(r.max_scroll || 0),
      conversions: Number(r.conversions || 0),
      events: Number(r.events || 0)
    }));
    
    // 4. Video engagement
    const videoQ = `
      SELECT video_id, SUM(watch_seconds) AS watch_time
      FROM video_engagement_tracking
      WHERE inquiry_id = $1
      GROUP BY video_id
    `;
    
    let videos = [];
    try {
      const videoRes = await db.query(videoQ, [inquiryId]);
      videos = videoRes.rows.map(r => ({
        video_id: r.video_id,
        watched_seconds: Number(r.watch_time || 0)
      }));
    } catch (videoError) {
      // table might be empty, ignore
    }
    
    // 5. Conversion signals from tracking_events
    const conversionQ = `
      SELECT event_type, COUNT(*) AS cnt
      FROM tracking_events
      WHERE inquiry_id = $1
        AND conversion_signals > 0
      GROUP BY event_type
    `;
    
    const conversionRes = await db.query(conversionQ, [inquiryId]);
    const conversions = conversionRes.rows.map(r => ({
      type: r.event_type,
      count: Number(r.cnt)
    }));
    
    // 6. Interests (boolean flags)
    const interestFields = [
      "sciences","mathematics","english","languages","humanities","business",
      "drama","music","art","creative_writing","sport","leadership",
      "community_service","outdoor_education","academic_excellence",
      "pastoral_care","university_preparation","personal_development",
      "career_guidance","extracurricular_opportunities","debating",
      "small_classes","london_location","values_based","university_prep"
    ];
    
    const interests = interestFields.filter(f => inquiry[f] === true);
    
    // 7. Geo info
    const geo = {
      country: inquiry.country,
      region: inquiry.region,
      city: inquiry.city,
      latitude: inquiry.latitude,
      longitude: inquiry.longitude,
      timezone: inquiry.timezone,
      isp: inquiry.isp
    };
    
    // Final response
    res.json({
      inquiry_id: inquiryId,
      family: `${inquiry.first_name} ${inquiry.family_surname}`,
      parent_email: inquiry.parent_email,
      entry_year: inquiry.entry_year,
      age_group: inquiry.age_group,
      prospectus_url: prospectusUrl,
      prospectus_generated_at: inquiry.prospectus_generated_at,
      received_at: inquiry.received_at,
      engagement: {
        total_dwell_seconds: Number(metrics.total_time || inquiry.dwell_ms || 0),
        avg_pages_per_visit: Number(metrics.avg_pages || 0),
        max_scroll_depth: Number(metrics.max_scroll || 0),
        link_clicks: Number(metrics.total_clicks || 0),
        total_visits: Number(metrics.total_visits || inquiry.return_visits || 0),
        last_active: metrics.last_visit || inquiry.updated_at
      },
      sections,
      videos,
      conversions,
      interests,
      geo
    });
  } catch (error) {
    console.error("Error building family snapshot:", error);
    res.status(500).json({ error: error.message });
  }
});

// Additional test endpoints
app.get('/api/test/section-data/:inquiryId', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No DB' });
  
  try {
    const inquiryId = req.params.inquiryId;
    
    // Simple query to see what section data exists
    const result = await db.query(`
      SELECT 
        event_type,
        event_data->>'currentSection' as section,
        event_data->>'timeInSectionSec' as time_sec,
        event_data->>'maxScrollPct' as scroll_pct,
        timestamp
      FROM tracking_events
      WHERE inquiry_id = $1
        AND event_data->>'currentSection' IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT 10
    `, [inquiryId]);
    
    res.json({
      inquiryId,
      rawSectionData: result.rows,
      count: result.rows.length,
      status: result.rows.length > 0 ? 'SECTION_DATA_FOUND' : 'NO_SECTION_DATA'
    });
  } catch (error) {
    console.error('Test section data error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/debug/visit-times/:inquiryId', async (req, res) => {
  try {
    // Calculate duration for each session from tracking_events
    const result = await db.query(`
      SELECT 
        session_id,
        MIN(timestamp) as start_time,
        MAX(timestamp) as end_time,
        EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))) as duration_seconds,
        COUNT(*) as events
      FROM tracking_events 
      WHERE inquiry_id = $1 AND session_id IS NOT NULL
      GROUP BY session_id
      ORDER BY start_time DESC
    `, [req.params.inquiryId]);
    
    const totalSeconds = result.rows.reduce((sum, row) => sum + parseFloat(row.duration_seconds || 0), 0);
    
    res.json({
      sessions: result.rows,
      total_seconds: totalSeconds,
      total_minutes: Math.round(totalSeconds / 60)
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/api/debug/barbara', async (req, res) => {
  try {
    const inquiryId = 'INQ-1756192540364116'; // Barbara's ID
    
    // 1. Check what events exist for Barbara
    const eventTypes = await db.query(`
      SELECT event_type, COUNT(*) as count, MIN(timestamp) as first_event, MAX(timestamp) as last_event
      FROM tracking_events
      WHERE inquiry_id = $1
      GROUP BY event_type
    `, [inquiryId]);
    
    // 2. Look at the actual event data structure for section_exit events
    const sectionEvents = await db.query(`
      SELECT 
        event_type,
        event_data,
        timestamp,
        session_id
      FROM tracking_events
      WHERE inquiry_id = $1
        AND event_type LIKE '%section%'
      ORDER BY timestamp DESC
      LIMIT 10
    `, [inquiryId]);
    
    // 3. Test the exact query used by the section-data endpoint
    const sectionQuery = await db.query(`
      SELECT
        COALESCE(event_data->>'currentSection', 'unknown') AS section_id,
        SUM(COALESCE((event_data->>'timeInSectionSec')::int, 0)) AS dwell_seconds,
        MAX(COALESCE((event_data->>'maxScrollPct')::int, 0)) AS max_scroll_pct,
        COUNT(CASE WHEN event_type = 'link_click' THEN 1 END) AS clicks,
        event_data->>'timeInSectionSec' as raw_time,
        event_data->>'maxScrollPct' as raw_scroll
      FROM tracking_events
      WHERE inquiry_id = $1
        AND event_type IN ('section_exit_enhanced', 'section_exit', 'link_click')
      GROUP BY 1, event_data->>'timeInSectionSec', event_data->>'maxScrollPct'
      ORDER BY 2 DESC
    `, [inquiryId]);
    
    // 4. Check what's in the inquiries table for Barbara
    const inquiryData = await db.query(`
      SELECT id, first_name, family_surname, dwell_ms, return_visits, status
      FROM inquiries
      WHERE id = $1
    `, [inquiryId]);
    
    // 5. Check AI insights
    const aiInsights = await db.query(`
      SELECT analysis_type, insights_json, generated_at
      FROM ai_family_insights
      WHERE inquiry_id = $1
    `, [inquiryId]);
    
    res.json({
      inquiryId,
      eventTypeCounts: eventTypes.rows,
      diagnosis: {
        inquiry: inquiryData.rows[0] || null,
        eventTypes: eventTypes.rows,
        sampleSectionEvents: sectionEvents.rows.map(row => ({
          type: row.event_type,
          data: row.event_data,
          timestamp: row.timestamp,
          session: row.session_id
        })),
        sectionQueryResults: sectionQuery.rows,
        aiInsights: aiInsights.rows.map(row => ({
          type: row.analysis_type,
          generated: row.generated_at,
          summary: row.insights_json?.narrative?.substring(0, 100) + '...' || 'No narrative'
        }))
      },
      recommendations: {
        hasSectionExitEvents: eventTypes.rows.some(r => r.event_type.includes('section')),
        sectionDataAvailable: sectionQuery.rows.length > 0,
        totalDwellTime: inquiryData.rows[0]?.dwell_ms || 0,
        issue: sectionQuery.rows.length === 0 ? 'NO_SECTION_DATA_FOUND' : 'SECTION_DATA_EXISTS'
      }
    });
  } catch (error) {
    console.error('Barbara diagnostic error:', error);
    res.status(500).json({ error: error.message });
  }
});

// System routes
app.get('/config.json', (req, res) => {
  const base = getBaseUrl(req);
  res.json({ 
    baseUrl: base, 
    webhook: `${base}/webhook`, 
    health: `${base}/health` 
  });
});

app.get('/health', (req, res) => {
  const base = getBaseUrl(req);
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: '5.0.0-COMPLETE',
    features: {
      analytics: 'enabled',
      tracking: 'enabled',
      dashboard: 'enabled',
      database: db ? 'connected' : 'json-only',
      prettyUrls: true,
      selfHealing: true,
      aiAnalysis: 'WORKING',
      aiEndpoints: {
        engagementSummary: '/api/ai/engagement-summary/:inquiryId',
        analyzeAllFamilies: '/api/ai/analyze-all-families',
        analyzeFamily: '/api/ai/analyze-family/:inquiryId'
      }
    }
  });
});

app.get('/api/debug/ip', (req, res) => {
  res.json({
    ip: req.clientIp || null,
    geo: req.geo || {},
    headers: {
      'x-forwarded-for': req.headers['x-forwarded-for'] || null,
      'cf-connecting-ip': req.headers['cf-connecting-ip'] || null,
      'x-real-ip': req.headers['x-real-ip'] || null
    }
  });
});

app.get('/', (req, res) => {
  const base = getBaseUrl(req);
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>More House Prospectus Service</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:24px;max-width:780px;margin:auto;line-height:1.55}</style></head>
<body>
  <h1>More House Prospectus Service</h1>
  <p><strong>Version 5.0.0 - COMPLETE</strong></p>
  <ul>
    <li>Health: <a href="${base}/health">${base}/health</a></li>
    <li>Webhook (POST JSON): <code>${base}/webhook</code></li>
    <li>Dashboard: <a href="${base}/dashboard.html">${base}/dashboard.html</a></li>
    <li>Inquiries (JSON): <a href="${base}/api/analytics/inquiries">${base}/api/analytics/inquiries</a></li>
    <li>Dashboard data (JSON): <a href="${base}/api/dashboard-data">${base}/api/dashboard-data</a></li>
    <li>AI Engagement Summary: <code>POST ${base}/api/ai/engagement-summary/:inquiryId</code></li>
    <li>AI Analyze All: <code>POST ${base}/api/ai/analyze-all-families</code></li>
    <li>Rebuild slugs: <a href="${base}/admin/rebuild-slugs">${base}/admin/rebuild-slugs</a></li>
  </ul>
  <h3>System Status:</h3>
  <ul>
    <li>Database: ${db ? 'Connected' : 'JSON-only mode'}</li>
    <li>Environment: ${process.env.NODE_ENV || 'development'}</li>
    <li>All endpoints operational</li>
  </ul>
  <p>Pretty links: <code>${base}/the-smith-family-abc123</code></p>
</body></html>`);
});

// Allowed pipeline statuses (single source of truth)
const PIPELINE_STATUSES = [
  'new_inquiry',
  'contacted',
  'high_interest',
  'tour_booked',
  'open_day_booked',
  'application_started',
  'application_complete',
  'not_interested'
];

// Update an inquiry's status
app.put('/api/inquiries/:id/status', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};

    if (!id) return res.status(400).json({ ok:false, error:'Missing inquiry id' });
    if (!status || !PIPELINE_STATUSES.includes(status)) {
      return res.status(400).json({ ok:false, error:`Invalid status. Allowed: ${PIPELINE_STATUSES.join(', ')}` });
    }
    if (!db) return res.status(503).json({ ok:false, error:'DB unavailable' });

    const q = await db.query(
      `UPDATE inquiries
         SET status = $1,
             updated_at = NOW()
       WHERE id = $2
       RETURNING id, status, updated_at`,
      [status, id]
    );

    if (q.rowCount === 0) return res.status(404).json({ ok:false, error:'Inquiry not found' });
    res.json({ ok:true, inquiry: q.rows[0] });
  } catch (e) {
    console.error('PUT /api/inquiries/:id/status error:', e);
    res.status(500).json({ ok:false, error:'Failed to update status' });
  }
});

// (Optional) expose allowed statuses to the front-end
app.get('/api/inquiries/statuses', (_req, res) => {
  res.json({ statuses: PIPELINE_STATUSES });
});

app.get('/api/debug/sessions/:inquiryId', async (req, res) => {
  try {
    const sessionSummaries = await db.query('SELECT COUNT(*) as count, SUM(duration_seconds) as total FROM session_summaries WHERE inquiry_id = $1', [req.params.inquiryId]);
    const trackingEvents = await db.query('SELECT COUNT(*) as count, COUNT(DISTINCT session_id) as sessions FROM tracking_events WHERE inquiry_id = $1', [req.params.inquiryId]);
    
    res.json({
      session_summaries: sessionSummaries.rows[0],
      tracking_events: trackingEvents.rows[0],
      inquiry_id: req.params.inquiryId
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});


// ===================== IMPROVED HELPER FUNCTION =====================
async function findInquiryByIdFixed(inquiryId) {
  try {
    // First try database if available
    if (db) {
      const result = await db.query('SELECT * FROM inquiries WHERE id = $1', [inquiryId]);
      if (result.rows.length > 0) {
        const row = result.rows[0];
        // Convert database format to expected format
        return {
          id: row.id,
          firstName: row.first_name,
          familySurname: row.family_surname,
          parentName: row.parent_name,
          parentEmail: row.parent_email,
          contactNumber: row.contact_number,
          ageGroup: row.age_group,
          entryYear: row.entry_year,
          hearAboutUs: row.hear_about_us,
          receivedAt: row.received_at,
          status: row.status,
          slug: row.slug,
          // Include all the boolean fields for interests
          sciences: row.sciences,
          mathematics: row.mathematics,
          english: row.english,
          languages: row.languages,
          humanities: row.humanities,
          business: row.business,
          drama: row.drama,
          music: row.music,
          art: row.art,
          creative_writing: row.creative_writing,
          sport: row.sport,
          leadership: row.leadership,
          community_service: row.community_service,
          outdoor_education: row.outdoor_education,
          academic_excellence: row.academic_excellence,
          pastoral_care: row.pastoral_care,
          university_preparation: row.university_preparation,
          personal_development: row.personal_development,
          career_guidance: row.career_guidance,
          extracurricular_opportunities: row.extracurricular_opportunities
        };
      }
    }
    
    // Fallback to JSON files
    const dataDir = path.join(__dirname, 'data');
    const files = await fs.readdir(dataDir);
    
    for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
      try {
        const filePath = path.join(dataDir, f);
        const content = await fs.readFile(filePath, 'utf8');
        const inquiry = JSON.parse(content);
        
        if (inquiry.id === inquiryId) {
          console.log(`Found inquiry in JSON file: ${f}`);
          return inquiry;
        }
      } catch (fileError) {
        console.warn(`Failed to parse ${f}:`, fileError.message);
        continue;
      }
    }
    
    console.log(`No inquiry found with ID: ${inquiryId}`);
    return null;
  } catch (error) {
    console.error('Error finding inquiry by ID:', error);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ADD THIS HELPER FUNCTION (if you don't already have it)
// ═══════════════════════════════════════════════════════════════════════════════════════════

async function findInquiryById(inquiryId) {
  try {
    const files = await fs.readdir(path.join(__dirname, 'data'));
    for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
      try {
        const filePath = path.join(__dirname, 'data', f);
        const inquiry = JSON.parse(await fs.readFile(filePath, 'utf8'));
        if (inquiry.id === inquiryId) {
          return inquiry;
        }
      } catch (e) {
        console.warn(`Failed to parse ${f}:`, e.message);
      }
    }
  } catch (e) {
    console.error('Error reading inquiry files:', e);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// UPDATE YOUR RESERVED SET (find this in your existing server.js and add 'download')
// ═══════════════════════════════════════════════════════════════════════════════════════════

// Find this line and add 'download' to it:

// Delete inquiry endpoint
app.delete('/api/analytics/inquiries/:id', async (req, res) => {
  try {
    const inquiryId = req.params.id;
    
    if (!inquiryId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing inquiry ID' 
      });
    }

    // Start transaction if database is available
    if (db) {
      try {
        await db.query('BEGIN');
        
        // Check if inquiry exists
        const existsResult = await db.query(
          'SELECT id, first_name, family_surname FROM inquiries WHERE id = $1',
          [inquiryId]
        );
        
        if (existsResult.rows.length === 0) {
          await db.query('ROLLBACK');
          return res.status(404).json({ 
            success: false, 
            error: 'Inquiry not found' 
          });
        }
        
        const inquiry = existsResult.rows[0];
        
        // Delete related data in correct order (foreign key constraints)
        
        // 1. Delete AI insights
        await db.query('DELETE FROM ai_family_insights WHERE inquiry_id = $1', [inquiryId]);
        
        // 2. Delete video engagement tracking
        await db.query('DELETE FROM video_engagement_tracking WHERE inquiry_id = $1', [inquiryId]);
        
        // 3. Delete tracking events
        await db.query('DELETE FROM tracking_events WHERE inquiry_id = $1', [inquiryId]);
        
        // 4. Delete engagement metrics
        await db.query('DELETE FROM engagement_metrics WHERE inquiry_id = $1', [inquiryId]);
        
        // 5. Delete inquiry AI summary (if exists)
        await db.query('DELETE FROM inquiry_ai_summary WHERE inquiry_id = $1', [inquiryId]);
        
        // 6. Finally delete the main inquiry record
        const deleteResult = await db.query('DELETE FROM inquiries WHERE id = $1', [inquiryId]);
        
        await db.query('COMMIT');
        
        console.log(`Successfully deleted inquiry ${inquiryId} (${inquiry.first_name} ${inquiry.family_surname}) and all related data`);
        
        return res.json({ 
          success: true, 
          message: `Successfully deleted inquiry for ${inquiry.first_name} ${inquiry.family_surname}`,
          deletedId: inquiryId
        });
        
      } catch (dbError) {
        await db.query('ROLLBACK');
        console.error('Database deletion failed:', dbError);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to delete from database',
          details: dbError.message 
        });
      }
    }
    
    // Fallback: JSON file deletion (if no database)
    try {
      const files = await fs.readdir(path.join(__dirname, 'data'));
      let found = false;
      
      for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
        try {
          const filePath = path.join(__dirname, 'data', f);
          const content = await fs.readFile(filePath, 'utf8');
          const inquiry = JSON.parse(content);
          
          if (inquiry.id === inquiryId) {
            // Delete the JSON file
            await fs.unlink(filePath);
            
            // Try to delete the prospectus file if it exists
            if (inquiry.prospectusFilename) {
              try {
                const prospectusPath = path.join(__dirname, 'prospectuses', inquiry.prospectusFilename);
                await fs.unlink(prospectusPath);
                console.log(`Deleted prospectus file: ${inquiry.prospectusFilename}`);
              } catch (prospectusError) {
                console.warn(`Failed to delete prospectus file: ${prospectusError.message}`);
              }
            }
            
            // Remove from slug index
            if (inquiry.slug && slugIndex[inquiry.slug]) {
              delete slugIndex[inquiry.slug];
              await saveSlugIndex();
              console.log(`Removed slug mapping: ${inquiry.slug}`);
            }
            
            found = true;
            console.log(`Successfully deleted inquiry ${inquiryId} from JSON files`);
            
            return res.json({ 
              success: true, 
              message: `Successfully deleted inquiry for ${inquiry.firstName} ${inquiry.familySurname}`,
              deletedId: inquiryId,
              source: 'json'
            });
          }
        } catch (fileError) {
          console.warn(`Failed to process ${f}:`, fileError.message);
        }
      }
      
      if (!found) {
        return res.status(404).json({ 
          success: false, 
          error: 'Inquiry not found in JSON files' 
        });
      }
      
    } catch (jsonError) {
      console.error('JSON deletion failed:', jsonError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to delete from JSON files',
        details: jsonError.message 
      });
    }
    
  } catch (error) {
    console.error('Delete inquiry error:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Internal server error during deletion',
      details: error.message 
    });
  }
});
// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Not found', 
    message: `Route ${req.method} ${req.path} not found` 
  });
});

// ===================== SERVER STARTUP =====================
async function startServer() {
  try {
    console.log('Starting More House School System...');
    
    const dbConnected = await initializeDatabase();
    await ensureDirectories();
    await loadSlugIndex();
    await rebuildSlugIndexFromData();
    
    app.listen(PORT, () => {
      console.log(`
=====================================
More House Prospectus Service
=====================================
Server running on port ${PORT}
Database: ${dbConnected ? 'Connected to PostgreSQL' : 'JSON-only mode'}
Environment: ${process.env.NODE_ENV || 'development'}
Version: 5.0.0-COMPLETE
=====================================
All systems operational
`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown handlers
process.on('SIGINT', async () => { 
  console.log('\nShutting down gracefully (SIGINT)...');
  if (db) {
    try {
      await db.end();
      console.log('Database connection closed.');
    } catch (e) {
      console.error('Error closing database:', e);
    }
  }
  process.exit(0); 
});

process.on('SIGTERM', async () => { 
  console.log('\nShutting down gracefully (SIGTERM)...');
  if (db) {
    try {
      await db.end();
      console.log('Database connection closed.');
    } catch (e) {
      console.error('Error closing database:', e);
    }
  }
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the server
startServer();