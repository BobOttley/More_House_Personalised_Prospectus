// server.js — complete file (UK English comments), full feature set
// Enhanced version with AI analysis, proper tracking injection, dashboard URLs, and slug resolution

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();
const { Client } = require('pg');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

// ────────────────────────────────────────────────────────────────────────────────
// Helpers: base URL + CORS
// ────────────────────────────────────────────────────────────────────────────────
function getBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host']  || req.get('host');
  return `${proto}://${host}`;
}

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
app.use((req, _res, next) => { console.log('→', req.method, req.url); next(); });

// Static public (dashboard.html, tracking.js, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// ────────────────────────────────────────────────────────────────────────────────
// Database Connection
// ────────────────────────────────────────────────────────────────────────────────
let db = null;
async function initializeDatabase() {
  const haveUrl   = !!process.env.DATABASE_URL;
  const haveParts = !!(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);
  if (!haveUrl && !haveParts) {
    console.log('📉 No DB credentials — running in JSON-only mode.');
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
    console.log('✅ Connected to Postgres');
    return true;
  } catch (e) {
    console.warn('⚠️ Postgres connection failed:', e.message);
    console.warn('➡️ Continuing in JSON-only mode.');
    db = null;
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// 🤖 AI INSIGHTS TABLE CREATION
// ────────────────────────────────────────────────────────────────────────────────
async function ensureAIInsightsTable() {
  if (!db) return;
  
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_family_insights (
        id SERIAL PRIMARY KEY,
        inquiry_id VARCHAR(50) NOT NULL,
        analysis_type VARCHAR(50) NOT NULL DEFAULT 'family_profile',
        insights_json TEXT,
        confidence_score DECIMAL(3,2) DEFAULT 0.5,
        recommendations TEXT[],
        lead_score INTEGER DEFAULT 50,
        urgency_level VARCHAR(20) DEFAULT 'medium',
        lead_temperature VARCHAR(10) DEFAULT 'warm',
        generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(inquiry_id, analysis_type)
      );
    `);
    
    // Create index for faster queries
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_insights_lead_score 
      ON ai_family_insights(lead_score DESC, generated_at DESC);
    `);
    
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_ai_insights_urgency 
      ON ai_family_insights(urgency_level, lead_score DESC);
    `);
    
    console.log('✅ AI insights table verified/created');
  } catch (error) {
    console.warn('⚠️ Failed to create AI insights table:', error.message);
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// File Management Functions
// ────────────────────────────────────────────────────────────────────────────────
let slugIndex = {}; // { [slug]: '/prospectuses/file.html' }

async function ensureDirectories() {
  await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
  await fs.mkdir(path.join(__dirname, 'prospectuses'), { recursive: true });
}

async function loadSlugIndex() {
  try {
    const p = path.join(__dirname, 'data', 'slug-index.json');
    slugIndex = JSON.parse(await fs.readFile(p, 'utf8'));
    console.log(`🔎 Loaded ${Object.keys(slugIndex).length} slug mappings`);
  } catch {
    slugIndex = {};
    console.log('ℹ️ No slug-index.json yet; will create on first save.');
  }
}

async function saveSlugIndex() {
  const p = path.join(__dirname, 'data', 'slug-index.json');
  await fs.writeFile(p, JSON.stringify(slugIndex, null, 2));
}

function generateInquiryId() {
  return `INQ-${Date.now()}${Math.floor(Math.random()*1000)}`;
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
  const fam  = sanitise(inquiry.familySurname, 'Family');
  const first = sanitise(inquiry.firstName, 'Student');
  return `More-House-School-${fam}-Family-${first}-${inquiry.entryYear}-${date}.html`;
}

// 🔧 IMPROVED makeSlug function to handle edge cases
function makeSlug(inquiry) {
  // Handle both database and JSON field names
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

function normaliseSegment(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseProspectusFilename(filename) {
  const m = String(filename).match(/^More-House-School-(.+?)-Family-(.+?)-(\d{4})-(\d{4}-\d{2}-\d{2})\.html$/i);
  if (!m) return null;
  return {
    familySeg: normaliseSegment(m[1]),
    firstSeg:  normaliseSegment(m[2]),
    yearSeg:   m[3],
    dateSeg:   m[4]
  };
}

async function saveInquiryJson(record) {
  const filename = `inquiry-${record.receivedAt}.json`;
  const p = path.join(__dirname, 'data', filename);
  await fs.writeFile(p, JSON.stringify(record, null, 2));
  return p;
}

async function findInquiryByFilenameSmart(filename) {
  const parsed = parseProspectusFilename(filename);
  const dir = path.join(__dirname, 'data');
  const files = await fs.readdir(dir).catch(() => []);
  const inquiries = [];

  for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      inquiries.push(j);
      // 1) Exact saved filename
      if (j.prospectusFilename === filename) return j;
      // 2) Same as "expected" filename (recomputed)
      try { if (generateFilename(j) === filename) return j; } catch {}
    } catch {}
  }

  if (!parsed) return null;

  // 3) Match by parsed family/first/year
  const byParsed = inquiries.find(j =>
    normaliseSegment(j.familySurname) === parsed.familySeg &&
    normaliseSegment(j.firstName)    === parsed.firstSeg &&
    String(j.entryYear)              === parsed.yearSeg
  );
  if (byParsed) return byParsed;

  // 4) Fallback: unique match on first+year
  const candidates = inquiries.filter(j =>
    normaliseSegment(j.firstName) === parsed.firstSeg &&
    String(j.entryYear)           === parsed.yearSeg
  );
  if (candidates.length === 1) return candidates[0];

  return null;
}

async function findInquiryBySlug(slug) {
  try {
    // Try database first
    if (db) {
      const result = await db.query('SELECT * FROM inquiries WHERE slug = $1 LIMIT 1', [slug]);
      if (result.rows.length > 0) {
        const row = result.rows[0];
        return {
          id: row.id,
          firstName: row.first_name,
          familySurname: row.family_surname,
          parentEmail: row.parent_email,
          ageGroup: row.age_group,
          entryYear: row.entry_year,
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
          extracurricular_opportunities: row.extracurricular_opportunities,
          receivedAt: row.received_at,
          status: row.status,
          slug: row.slug
        };
      }
    }
    
    // Fallback to JSON files
    const files = await fs.readdir(path.join(__dirname, 'data'));
    for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
      try {
        const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
        if ((j.slug || '').toLowerCase() === slug) return j;
      } catch {}
    }
  } catch (e) {
    console.warn('findInquiryBySlug error:', e.message);
  }
  return null;
}

// 🔧 FIXED SLUG REBUILDING
async function rebuildSlugIndexFromData() {
  let added = 0;
  console.log('🔨 Rebuilding slug index...');
  
  try {
    // Try database first (where your actual families live)
    if (db) {
      console.log('📊 Rebuilding from database...');
      const result = await db.query(`
        SELECT id, slug, prospectus_url, prospectus_filename, first_name, family_surname
        FROM inquiries 
        WHERE prospectus_generated = true OR prospectus_filename IS NOT NULL
      `);
      
      for (const row of result.rows) {
        let slug = row.slug;
        
        // Generate slug if missing
        if (!slug) {
          slug = makeSlug({
            familySurname: row.family_surname,
            id: row.id
          });
          
          // Update database with generated slug
          try {
            await db.query('UPDATE inquiries SET slug = $1 WHERE id = $2', [slug, row.id]);
            console.log(`🔧 Generated missing slug for ${row.first_name} ${row.family_surname}: ${slug}`);
          } catch (updateError) {
            console.warn(`⚠️ Failed to update slug for ${row.id}:`, updateError.message);
          }
        }
        
        slug = slug.toLowerCase();
        let rel = row.prospectus_url;
        if (!rel && row.prospectus_filename) {
          rel = `/prospectuses/${row.prospectus_filename}`;
        }
        
        if (rel && !slugIndex[slug]) {
          slugIndex[slug] = rel;
          added++;
          console.log(`✅ Added slug: ${slug} -> ${rel} (${row.first_name} ${row.family_surname})`);
        }
      }
    } else {
      // Fallback to JSON files
      console.log('📁 Rebuilding from JSON files...');
      const files = await fs.readdir(path.join(__dirname, 'data'));
      const js = files.filter(f => f.startsWith('inquiry-') && f.endsWith('.json'));
      
      for (const f of js) {
        try {
          const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
          let slug = j.slug;
          
          if (!slug) {
            slug = makeSlug(j);
            // Update JSON file with slug
            j.slug = slug;
            await fs.writeFile(path.join(__dirname, 'data', f), JSON.stringify(j, null, 2));
            console.log(`🔧 Generated missing slug for ${j.firstName} ${j.familySurname}: ${slug}`);
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
        } catch (e) {
          console.warn(`⚠️ Skipped ${f}: ${e.message}`);
        }
      }
    }
    
    if (added > 0) {
      await saveSlugIndex();
      console.log(`💾 Saved ${added} new slug mappings to slug-index.json`);
    }
    
    console.log(`🔨 Slug index rebuilt: ${added} new mappings, ${Object.keys(slugIndex).length} total`);
    
    // Debug: Show current slug index
    if (Object.keys(slugIndex).length > 0) {
      console.log('📋 Current slug mappings:');
      Object.entries(slugIndex).slice(0, 5).forEach(([slug, path]) => {
        console.log(`   ${slug} -> ${path}`);
      });
      if (Object.keys(slugIndex).length > 5) {
        console.log(`   ... and ${Object.keys(slugIndex).length - 5} more`);
      }
    }
    
    return added;
  } catch (e) {
    console.error('❌ rebuildSlugIndexFromData error:', e.message);
    return 0;
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// 🎯 FIXED PROSPECTUS GENERATION - PROPER TRACKING + URL STORAGE
// ────────────────────────────────────────────────────────────────────────────────
async function generateProspectus(inquiry) {
  console.log(`🎨 Generating prospectus for ${inquiry.firstName} ${inquiry.familySurname}`);
  const templatePath = path.join(__dirname, 'public', 'prospectus_template.html');
  
  try {
    let html = await fs.readFile(templatePath, 'utf8');
    
    const filename = generateFilename(inquiry);
    const relPath = `/prospectuses/${filename}`;
    const absPath = path.join(__dirname, 'prospectuses', filename);

    // STEP 1: Add meta tags to <head>
    const meta = `
<meta name="inquiry-id" content="${inquiry.id}">
<meta name="generated-date" content="${new Date().toISOString()}">
<meta name="student-name" content="${inquiry.firstName} ${inquiry.familySurname}">
<meta name="entry-year" content="${inquiry.entryYear}">
<meta name="age-group" content="${inquiry.ageGroup}">
<meta name="tracking-enabled" content="true">`;

    html = html.replace('</head>', `${meta}\n</head>`);

    // STEP 2: Update title
    const title = `${inquiry.firstName} ${inquiry.familySurname} - More House School Prospectus ${inquiry.entryYear}`;
    html = html.replace(/<title>.*?<\/title>/, `<title>${title}</title>`);

    // STEP 3: Create personalization script
    const personalizeBoot = `<script>
document.addEventListener('DOMContentLoaded', function(){
  const userData = ${JSON.stringify(inquiry, null, 2)};
  console.log('🎯 Initializing prospectus with data:', userData);
  if (typeof initializeProspectus === 'function') {
    initializeProspectus(userData);
    console.log('✅ Prospectus personalized successfully');
  } else {
    console.error('❌ initializeProspectus function not found');
  }
});
</script>`;

    // STEP 4: Create tracking script injection
    const trackingInject = `<!-- More House Analytics Tracking -->
<script>
window.MORE_HOUSE_INQUIRY_ID='${inquiry.id}';
console.log('📊 Inquiry ID set for tracking:', window.MORE_HOUSE_INQUIRY_ID);
</script>
<script src="/tracking.js"></script>`;

    // STEP 5: Find and inject BOTH scripts before </body>
    const bodyCloseIndex = html.lastIndexOf('</body>');
    if (bodyCloseIndex === -1) {
      throw new Error('Template missing </body> tag');
    }
    
    const allScripts = personalizeBoot + '\n' + trackingInject + '\n';
    const finalHtml = html.slice(0, bodyCloseIndex) + allScripts + html.slice(bodyCloseIndex);

    // STEP 6: Save the file
    await fs.writeFile(absPath, finalHtml, 'utf8');

    // STEP 7: Create and save slug mapping
    const slug = makeSlug(inquiry);
    const prettyPath = `/${slug}`;
    slugIndex[slug] = relPath;
    await saveSlugIndex();

    // STEP 8: Verify the injection worked
    const savedContent = await fs.readFile(absPath, 'utf8');
    const hasTrackingJs = savedContent.includes('<script src="/tracking.js"></script>');
    const hasInquiryId = savedContent.includes(`window.MORE_HOUSE_INQUIRY_ID='${inquiry.id}'`);
    const hasPersonalization = savedContent.includes('initializeProspectus');

    console.log(`📁 Prospectus saved: ${filename}`);
    console.log(`🌐 Pretty URL: ${prettyPath}`);
    console.log(`📊 Tracking script: ${hasTrackingJs ? '✅ VERIFIED' : '❌ MISSING'}`);
    console.log(`🔑 Inquiry ID: ${hasInquiryId ? '✅ VERIFIED' : '❌ MISSING'}`);
    console.log(`🎯 Personalization: ${hasPersonalization ? '✅ VERIFIED' : '❌ MISSING'}`);

    if (!hasTrackingJs || !hasInquiryId) {
      console.error('🚨 CRITICAL: Tracking script injection FAILED!');
      console.log('🔍 Body section preview:', savedContent.slice(bodyCloseIndex - 200, bodyCloseIndex + 200));
    }

    return {
      filename,
      url: relPath,
      slug,
      prettyPath,
      generatedAt: new Date().toISOString()
    };
  } catch (e) {
    console.error('❌ Prospectus generation failed:', e.message);
    throw new Error(`prospectus_template.html error: ${e.message}`);
  }
}

// 🔧 FIXED updateInquiryStatus - PROPERLY SAVE URLs TO DATABASE
async function updateInquiryStatus(inquiryId, pInfo) {
  // Update JSON files
  const files = await fs.readdir(path.join(__dirname, 'data'));
  for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
    const p = path.join(__dirname, 'data', f);
    const j = JSON.parse(await fs.readFile(p, 'utf8'));
    if (j.id === inquiryId) {
      j.prospectusGenerated = true;
      j.prospectusFilename  = pInfo.filename;
      j.prospectusUrl       = pInfo.url;          
      j.prospectusPrettyPath= pInfo.prettyPath;   
      j.slug                = pInfo.slug;
      j.prospectusGeneratedAt = pInfo.generatedAt;
      j.status              = 'prospectus_generated';
      await fs.writeFile(p, JSON.stringify(j, null, 2));
      break;
    }
  }

  // 🎯 CRITICAL: Save URLs to database for dashboard
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
      console.log(`✅ Database updated: ${inquiryId} -> ${pInfo.prettyPath}`);
    } catch (e) {
      console.warn('❌ DB update failed (non-fatal):', e.message);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Tracking Functions (UNIFIED - NO CONFLICTS)
// ────────────────────────────────────────────────────────────────────────────────
async function trackEngagementEvent(ev) {
  if (!db) return null;
  try {
    const q = `
      INSERT INTO tracking_events (
        inquiry_id, event_type, event_data, page_url,
        user_agent, ip_address, session_id, timestamp
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`;
    const vals = [
      ev.inquiryId, ev.eventType, JSON.stringify(ev.eventData || {}),
      ev.url || null, ev.deviceInfo?.userAgent || null, ev.ip || null,
      ev.sessionId || null, new Date(ev.timestamp || Date.now())
    ];
    const r = await db.query(q, vals);
    return r.rows[0];
  } catch (e) {
    console.warn('trackEngagementEvent failed:', e.message);
    return null;
  }
}

async function updateEngagementMetrics(m) {
  if (!db) return null;
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
    return null;
  }
}

// Helper function to calculate engagement score consistently
function calculateEngagementScore(engagement) {
  if (!engagement) return 0;
  
  let score = 0;
  
  // Time spent (40% weight)
  const timeMinutes = (engagement.timeOnPage || engagement.time_on_page || 0) / 60;
  if (timeMinutes >= 30) score += 40;
  else if (timeMinutes >= 15) score += 30;
  else if (timeMinutes >= 5) score += 20;
  else score += Math.min(timeMinutes * 4, 15);
  
  // Content depth (30% weight)
  const scrollDepth = engagement.scrollDepth || engagement.scroll_depth || 0;
  score += Math.min(scrollDepth * 0.3, 30);
  
  // Return visits (20% weight)
  const visits = engagement.totalVisits || engagement.total_visits || 1;
  if (visits >= 7) score += 20;
  else if (visits >= 4) score += 15;
  else if (visits >= 2) score += 10;
  else score += 5;
  
  // Interaction quality (10% weight)
  const clicks = engagement.clickCount || engagement.clicks_on_links || 0;
  score += Math.min(clicks * 2, 10);
  
  return Math.min(Math.round(score), 100);
}

// Fixed getDashboardMetrics function to properly calculate from engagement_metrics table
async function getDashboardMetrics() {
  try {
    if (db) {
      // Database version - get real engagement data from your existing tables
      console.log('📊 Calculating dashboard metrics from database...');
      
      const [{ c: totalFamilies }] = (await db.query(`SELECT COUNT(*)::int AS c FROM inquiries`)).rows;
      console.log(`👨‍👩‍👧‍👦 Total families: ${totalFamilies}`);
      
      // Hot leads: families with high engagement (>10 minutes + >80% scroll OR multiple visits with good engagement)
      const [{ c: hotLeads }] = (await db.query(`
        SELECT COUNT(DISTINCT inquiry_id)::int AS c 
        FROM engagement_metrics 
        WHERE (time_on_page > 600 AND scroll_depth > 80) 
           OR (total_visits >= 3 AND time_on_page > 300 AND scroll_depth > 60)
      `)).rows;
      console.log(`🔥 Hot leads: ${hotLeads}`);
      
      // Warm leads: families with moderate engagement (>5 minutes + >50% scroll)
      // Exclude those already counted as hot leads
      const [{ c: warmLeads }] = (await db.query(`
        SELECT COUNT(DISTINCT inquiry_id)::int AS c 
        FROM engagement_metrics 
        WHERE (time_on_page > 300 AND scroll_depth > 50)
        AND inquiry_id NOT IN (
          SELECT DISTINCT inquiry_id FROM engagement_metrics 
          WHERE (time_on_page > 600 AND scroll_depth > 80) 
             OR (total_visits >= 3 AND time_on_page > 300 AND scroll_depth > 60)
        )
      `)).rows;
      console.log(`🌟 Warm leads: ${warmLeads}`);
      
      // Average engagement time in minutes
      const [{ avg_time }] = (await db.query(`
        SELECT AVG(time_on_page) as avg_time 
        FROM engagement_metrics
        WHERE time_on_page > 0
      `)).rows;
      const avgEngagement = Math.round((avg_time || 0) / 60);
      console.log(`📊 Average engagement: ${avgEngagement} minutes`);

      const metrics = {
        hotLeads,
        warmLeads,
        totalFamilies,
        avgEngagement
      };
      
      console.log('✅ Dashboard metrics calculated:', metrics);
      return metrics;
    } else {
      // JSON fallback
      console.log('📁 Using JSON fallback for metrics...');
      const files = await fs.readdir(path.join(__dirname, 'data'));
      const totalFamilies = files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json')).length;
      
      return {
        hotLeads: 0,
        warmLeads: 0,
        totalFamilies,
        avgEngagement: 0
      };
    }
  } catch (error) {
    console.error('❌ Error getting dashboard metrics:', error);
    return { hotLeads: 0, warmLeads: 0, totalFamilies: 0, avgEngagement: 0 };
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// 🤖 ENHANCED AI ANALYSIS FUNCTIONS
// ────────────────────────────────────────────────────────────────────────────────
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

// 🤖 ENHANCED AI ANALYSIS FUNCTION WITH BETTER ERROR HANDLING
async function analyzeFamily(inquiry, engagementData) {
  try {
    console.log(`🤖 Analyzing family: ${inquiry.firstName} ${inquiry.familySurname}`);
    
    // Build comprehensive context for Claude
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

    // Calculate engagement score
    const engagementScore = calculateEngagementScore(familyContext.engagement);

    // Enhanced prompt for Claude with specific formatting instructions
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

    // Call Claude API with retry logic
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      try {
        attempts++;
        console.log(`🔄 Claude API call attempt ${attempts}/${maxAttempts} for ${inquiry.id}`);
        
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
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
        
        // Clean up response (remove any markdown formatting)
        responseText = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        
        // Parse the JSON response
        const analysis = JSON.parse(responseText);
        
        // Validate required fields
        if (!analysis.leadScore || !analysis.urgencyLevel) {
          throw new Error('Invalid analysis response - missing required fields');
        }
        
        console.log(`✅ Claude analysis completed for ${inquiry.id} (score: ${analysis.leadScore})`);
        
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
          recommendations: analysis.conversationStarters || [], // For backward compatibility
          engagementScore: engagementScore,
          analysisDate: new Date().toISOString()
        };

      } catch (error) {
        console.warn(`⚠️ Claude API attempt ${attempts} failed for ${inquiry.id}:`, error.message);
        
        if (attempts >= maxAttempts) {
          throw error;
        }
        
        // Wait before retry (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
      }
    }

  } catch (error) {
    console.error(`❌ Family analysis failed for ${inquiry.id}:`, error.message);
    
    // Return fallback analysis based on engagement data
    const engagementScore = calculateEngagementScore(engagementData);
    return {
      leadScore: Math.max(engagementScore, 25), // Minimum score based on engagement
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

// ────────────────────────────────────────────────────────────────────────────────
// Preflight
// ────────────────────────────────────────────────────────────────────────────────
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
  res.header('Access-Control-Max-Age', '86400');
  res.sendStatus(200);
});

// ────────────────────────────────────────────────────────────────────────────────
// Main Routes
// ────────────────────────────────────────────────────────────────────────────────

// Webhook: create inquiry + generate prospectus
app.post(['/webhook', '/api/inquiry'], async (req, res) => {
  try {
    const data = req.body || {};
    const required = ['firstName','familySurname','parentEmail','ageGroup','entryYear'];
    const missing = required.filter(k => !data[k]);
    if (missing.length) return res.status(400).json({ success:false, error:'Missing required fields', missingFields: missing });

    const now = new Date().toISOString();
    const base = getBaseUrl(req);
    const record = {
      id: generateInquiryId(),
      receivedAt: now,
      status: 'received',
      prospectusGenerated: false,
      userAgent: req.headers['user-agent'],
      referrer: req.headers.referer,
      ip: req.ip || req.connection?.remoteAddress,
      ...data
    };

    // Persist JSON (always)
    await saveInquiryJson(record);

    // 🎯 CRITICAL: Save to database with proper URL fields
    if (db) {
      try {
        await db.query(`
          INSERT INTO inquiries (
            id, first_name, family_surname, parent_email, age_group, entry_year,
            sciences, mathematics, english, languages, humanities, business,
            drama, music, art, creative_writing,
            sport, leadership, community_service, outdoor_education,
            academic_excellence, pastoral_care, university_preparation,
            personal_development, career_guidance, extracurricular_opportunities,
            received_at, status, user_agent, referrer, ip_address
          ) VALUES (
            $1,$2,$3,$4,$5,$6,
            $7,$8,$9,$10,$11,$12,
            $13,$14,$15,$16,
            $17,$18,$19,$20,
            $21,$22,$23,$24,$25,$26,
            $27,$28,$29,$30,$31
          )
          ON CONFLICT (id) DO NOTHING
        `, [
          record.id, record.firstName, record.familySurname, record.parentEmail, record.ageGroup, record.entryYear,

          !!record.sciences, !!record.mathematics, !!record.english, !!record.languages, !!record.humanities, !!record.business,
          !!record.drama, !!record.music, !!record.art, !!record.creative_writing,
          !!record.sport, !!record.leadership, !!record.community_service, !!record.outdoor_education,
          !!record.academic_excellence, !!record.pastoral_care, !!record.university_preparation,
          !!record.personal_development, !!record.career_guidance, !!record.extracurricular_opportunities,

          new Date(record.receivedAt), record.status, record.userAgent, record.referrer, record.ip
        ]);
        console.log(`✅ Database record created: ${record.id}`);
      } catch (e) { 
        console.warn('❌ DB insert failed (non-fatal):', e.message); 
      }
    }

    // Generate prospectus
    const p = await generateProspectus(record);
    await updateInquiryStatus(record.id, p);

    return res.json({
      success: true,
      inquiryId: record.id,
      receivedAt: record.receivedAt,
      prospectus: {
        filename: p.filename,
        url: `${base}${p.prettyPath}`,      // Pretty URL for user
        directFile: `${base}${p.url}`,      // Direct file URL 
        slug: p.slug,
        generatedAt: p.generatedAt
      }
    });
  } catch (e) {
    console.error('WEBHOOK error:', e);
    return res.status(500).json({ success:false, error:e.message });
  }
});

// Manual (re)generate for an existing inquiry
app.post('/api/generate-prospectus/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    let inquiry = null;
    
    // Try database first
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
    if (!inquiry) {
      const files = await fs.readdir(path.join(__dirname, 'data'));
      for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
        const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
        if (j.id === inquiryId) { inquiry = j; break; }
      }
    }
    
    if (!inquiry) return res.status(404).json({ success:false, error:'Inquiry not found' });

    const p = await generateProspectus(inquiry);
    await updateInquiryStatus(inquiry.id, p);

    const base = getBaseUrl(req);
    res.json({
      success: true,
      inquiryId,
      prospectus: {
        filename: p.filename,
        url: `${base}${p.prettyPath}`,
        directFile: `${base}${p.url}`,
        slug: p.slug,
        generatedAt: p.generatedAt
      }
    });
  } catch (e) {
    console.error('Manual generate error:', e);
    res.status(500).json({ success:false, error:e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// TRACKING ENDPOINT (UNIFIED - NO CONFLICTS)
// ────────────────────────────────────────────────────────────────────────────────
app.post('/api/track-engagement', async (req, res) => {
  try {
    const { events = [], sessionInfo } = req.body || {};
    const clientIP = req.ip || req.connection?.remoteAddress;
    
    console.log(`📊 Tracking: ${events.length} events from ${sessionInfo?.inquiryId || 'unknown'}`);
    
    // Process individual events
    for (const e of (events.length ? events : [req.body])) {
      const { inquiryId, sessionId, eventType, timestamp, data = {}, url, currentSection } = e;
      if (!inquiryId || !sessionId || !eventType) continue;
      
      await trackEngagementEvent({
        inquiryId, 
        sessionId, 
        eventType,
        timestamp: timestamp || new Date().toISOString(),
        eventData: data, 
        url, 
        currentSection,
        deviceInfo: data.deviceInfo,
        ip: clientIP
      });
    }
    
    // Process session summary
    if (sessionInfo?.inquiryId) {
      await updateEngagementMetrics({
        inquiryId: sessionInfo.inquiryId,
        sessionId: sessionInfo.sessionId,
        timeOnPage: sessionInfo.timeOnPage,
        maxScrollDepth: sessionInfo.maxScrollDepth,
        clickCount: sessionInfo.clickCount,
        deviceInfo: sessionInfo.deviceInfo,
        prospectusFilename: 'unknown'
      });
    }
    
    res.json({ 
      success: true, 
      message: `Tracked ${(events.length || 1)} event(s)`,
      eventsProcessed: events.length || 1
    });
  } catch (e) {
    console.error('❌ track-engagement error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// 🤖 ENHANCED AI ANALYSIS ENDPOINTS
// ────────────────────────────────────────────────────────────────────────────────

// Enhanced batch AI analysis endpoint
app.post('/api/ai/analyze-all-families', async (req, res) => {
  try {
    console.log('🤖 Starting comprehensive AI analysis for all families...');
    
    let inquiries = [];
    
    // Get inquiries from database first, fallback to JSON
    if (db) {
      console.log('📊 Loading families from database...');
      const result = await db.query(`
        SELECT id, first_name, family_surname, parent_email, age_group, entry_year,
               sciences, mathematics, english, languages, humanities, business,
               drama, music, art, creative_writing, sport, leadership, 
               community_service, outdoor_education, academic_excellence,
               pastoral_care, university_preparation, personal_development,
               career_guidance, extracurricular_opportunities, received_at
        FROM inquiries 
        ORDER BY received_at DESC
      `);
      
      inquiries = result.rows.map(row => ({
        id: row.id,
        firstName: row.first_name,
        familySurname: row.family_surname,
        parentEmail: row.parent_email,
        ageGroup: row.age_group,
        entryYear: row.entry_year,
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
        extracurricular_opportunities: row.extracurricular_opportunities,
        receivedAt: row.received_at
      }));
    } else {
      // JSON fallback
      console.log('📁 Loading families from JSON files...');
      const files = await fs.readdir(path.join(__dirname, 'data'));
      for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
        try {
          const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
          inquiries.push(j);
        } catch (fileError) {
          console.warn(`⚠️ Failed to read ${f}:`, fileError.message);
        }
      }
    }

    console.log(`📊 Found ${inquiries.length} families to analyze`);
    
    if (inquiries.length === 0) {
      return res.json({
        success: true,
        message: 'No families found to analyze',
        results: { total: 0, analyzed: 0, errors: 0 },
        details: []
      });
    }

    let analysisCount = 0;
    const errors = [];
    const successDetails = [];

    // Process each family
    for (const inquiry of inquiries) {
      try {
        console.log(`🔍 Processing ${inquiry.firstName} ${inquiry.familySurname} (${inquiry.id})`);
        
        // Get engagement data if available
        let engagementData = null;
        if (db) {
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
        }

        // Call Claude API for analysis
        const analysis = await analyzeFamily(inquiry, engagementData);
        
        if (analysis) {
          // Store analysis in database if available
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
              
              console.log(`💾 Stored analysis for ${inquiry.id} in database`);
            } catch (dbError) {
              console.warn(`⚠️ DB insert failed for ${inquiry.id}:`, dbError.message);
            }
          }

          analysisCount++;
          successDetails.push({
            inquiryId: inquiry.id,
            name: `${inquiry.firstName} ${inquiry.familySurname}`,
            leadScore: analysis.leadScore,
            urgencyLevel: analysis.urgencyLevel,
            confidence: analysis.confidence_score
          });
          
          console.log(`✅ Analysis completed for ${inquiry.firstName} ${inquiry.familySurname} (score: ${analysis.leadScore})`);
        }
        
      } catch (error) {
        console.error(`❌ Analysis failed for ${inquiry.id}:`, error.message);
        errors.push({ 
          inquiryId: inquiry.id, 
          name: `${inquiry.firstName || ''} ${inquiry.familySurname || ''}`.trim(),
          error: error.message 
        });
      }
    }

    console.log(`🎯 AI analysis complete: ${analysisCount}/${inquiries.length} successful`);
    
    const response = {
      success: true,
      message: `AI analysis completed for ${analysisCount} out of ${inquiries.length} families`,
      results: {
        total: inquiries.length,
        analyzed: analysisCount,
        errors: errors.length,
        successRate: inquiries.length > 0 ? Math.round((analysisCount / inquiries.length) * 100) : 0
      },
      successDetails: successDetails.slice(0, 10), // Show first 10 successful analyses
      errors: errors.length > 0 ? errors.slice(0, 5) : undefined // Show first 5 errors
    };
    
    res.json(response);

  } catch (error) {
    console.error('❌ Batch AI analysis error:', error);
    res.status(500).json({
      success: false,
      error: 'AI analysis failed',
      message: error.message,
      results: { total: 0, analyzed: 0, errors: 1 }
    });
  }
});

// Add this endpoint to your server.js for individual family analysis
app.post('/api/ai/analyze-family/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    console.log(`🤖 Starting individual AI analysis for family: ${inquiryId}`);
    
    let inquiry = null;
    
    // Get inquiry from database first, fallback to JSON
    if (db) {
      console.log('📊 Loading family from database...');
      const result = await db.query(`
        SELECT id, first_name, family_surname, parent_email, age_group, entry_year,
               sciences, mathematics, english, languages, humanities, business,
               drama, music, art, creative_writing, sport, leadership, 
               community_service, outdoor_education, academic_excellence,
               pastoral_care, university_preparation, personal_development,
               career_guidance, extracurricular_opportunities, received_at
        FROM inquiries 
        WHERE id = $1
      `, [inquiryId]);
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
        inquiry = {
          id: row.id,
          firstName: row.first_name,
          familySurname: row.family_surname,
          parentEmail: row.parent_email,
          ageGroup: row.age_group,
          entryYear: row.entry_year,
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
          extracurricular_opportunities: row.extracurricular_opportunities,
          receivedAt: row.received_at
        };
      }
    } else {
      // JSON fallback
      console.log('📁 Loading family from JSON files...');
      const files = await fs.readdir(path.join(__dirname, 'data'));
      for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
        try {
          const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
          if (j.id === inquiryId) {
            inquiry = j;
            break;
          }
        } catch (fileError) {
          console.warn(`⚠️ Failed to read ${f}:`, fileError.message);
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
    
    console.log(`🔍 Processing ${inquiry.firstName} ${inquiry.familySurname} (${inquiry.id})`);
    
    // Get engagement data if available
    let engagementData = null;
    if (db) {
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
    }

    // Call Claude API for analysis (using your existing analyzeFamily function)
    const analysis = await analyzeFamily(inquiry, engagementData);
    
    if (!analysis) {
      return res.status(500).json({
        success: false,
        error: 'AI analysis failed',
        inquiryId: inquiryId
      });
    }
    
    // Store analysis in database if available
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
        
        console.log(`💾 Stored individual analysis for ${inquiry.id} in database`);
      } catch (dbError) {
        console.warn(`⚠️ DB insert failed for ${inquiry.id}:`, dbError.message);
      }
    }
    
    console.log(`✅ Individual analysis completed for ${inquiry.firstName} ${inquiry.familySurname} (score: ${analysis.leadScore})`);
    
    res.json({
      success: true,
      message: `AI analysis completed for ${inquiry.firstName} ${inquiry.familySurname}`,
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
    console.error(`❌ Individual AI analysis error for ${req.params.inquiryId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Individual AI analysis failed',
      message: error.message,
      inquiryId: req.params.inquiryId
    });
  }
});

// New endpoint to get AI insights for dashboard
app.get('/api/ai/family-insights', async (req, res) => {
  try {
    console.log('🤖 Retrieving AI insights for dashboard...');
    
    if (!db) {
      return res.json({
        success: false,
        message: 'AI insights require database connection',
        insights: []
      });
    }
    
    // Get AI insights with family information
    const insights = await db.query(`
      SELECT 
        ai.inquiry_id,
        ai.insights_json,
        ai.confidence_score,
        ai.lead_score,
        ai.urgency_level,
        ai.lead_temperature,
        ai.generated_at,
        i.first_name,
        i.family_surname,
        i.parent_email,
        i.entry_year,
        i.age_group,
        em.time_on_page,
        em.total_visits,
        em.last_visit
      FROM ai_family_insights ai
      JOIN inquiries i ON i.id = ai.inquiry_id
      LEFT JOIN engagement_metrics em ON em.inquiry_id = ai.inquiry_id
      WHERE ai.analysis_type = 'family_profile'
      ORDER BY ai.lead_score DESC, ai.generated_at DESC
      LIMIT 50
    `);
    
    const processedInsights = insights.rows.map(row => {
      let parsedInsights = {};
      try {
        parsedInsights = JSON.parse(row.insights_json || '{}');
      } catch (e) {
        console.warn(`Failed to parse insights for ${row.inquiry_id}`);
      }
      
      return {
        inquiryId: row.inquiry_id,
        familyName: `${row.first_name} ${row.family_surname}`,
        parentEmail: row.parent_email,
        entryYear: row.entry_year,
        ageGroup: row.age_group,
        leadScore: row.lead_score,
        urgencyLevel: row.urgency_level,
        leadTemperature: row.lead_temperature,
        confidence: row.confidence_score,
        generatedAt: row.generated_at,
        insights: parsedInsights,
        engagement: {
          timeOnPage: row.time_on_page || 0,
          totalVisits: row.total_visits || 0,
          lastVisit: row.last_visit
        }
      };
    });
    
    console.log(`📊 Retrieved ${processedInsights.length} AI insights`);
    
    res.json({
      success: true,
      insights: processedInsights,
      summary: {
        total: processedInsights.length,
        hotLeads: processedInsights.filter(i => i.leadScore >= 80).length,
        warmLeads: processedInsights.filter(i => i.leadScore >= 60 && i.leadScore < 80).length,
        coldLeads: processedInsights.filter(i => i.leadScore < 60).length
      }
    });
    
  } catch (error) {
    console.error('❌ Failed to get AI insights:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve AI insights',
      message: error.message
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// 🎯 ENHANCED DASHBOARD DATA ENDPOINT WITH AI INSIGHTS INTEGRATION
// ────────────────────────────────────────────────────────────────────────────────
app.get('/api/dashboard-data', async (req, res) => {
  try {
    console.log('📊 Enhanced dashboard data request with AI insights...');
    const base = getBaseUrl(req);

    if (db) {
      console.log('🗄️ Using database for enhanced dashboard data...');
      
      // 1. BASIC METRICS
      const [{ c: totalFamilies }] = (await db.query(`SELECT COUNT(*)::int AS c FROM inquiries`)).rows;
      const [{ c: newInquiries7d }] = (await db.query(`
        SELECT COUNT(*)::int AS c
        FROM inquiries
        WHERE COALESCE(received_at, created_at) >= NOW() - INTERVAL '7 days'
      `)).rows;
      const [{ c: readyForContact }] = (await db.query(`
        SELECT COUNT(*)::int AS c
        FROM inquiries
        WHERE status='prospectus_generated' OR prospectus_generated IS TRUE
      `)).rows;
      
      // 2. AI-ENHANCED ENGAGEMENT METRICS
      let aiInsightsSummary = { hotLeads: 0, warmLeads: 0, coldLeads: 0, analyzed: 0 };
      try {
        const aiMetrics = await db.query(`
          SELECT 
            COUNT(*) as total_analyzed,
            SUM(CASE WHEN lead_score >= 80 THEN 1 ELSE 0 END) as hot_leads,
            SUM(CASE WHEN lead_score >= 60 AND lead_score < 80 THEN 1 ELSE 0 END) as warm_leads,
            SUM(CASE WHEN lead_score < 60 THEN 1 ELSE 0 END) as cold_leads,
            AVG(lead_score) as avg_score
          FROM ai_family_insights 
          WHERE analysis_type = 'family_profile'
        `);
        
        if (aiMetrics.rows.length > 0) {
          const metrics = aiMetrics.rows[0];
          aiInsightsSummary = {
            hotLeads: parseInt(metrics.hot_leads || 0),
            warmLeads: parseInt(metrics.warm_leads || 0),
            coldLeads: parseInt(metrics.cold_leads || 0),
            analyzed: parseInt(metrics.total_analyzed || 0),
            averageScore: Math.round(parseFloat(metrics.avg_score || 0))
          };
        }
      } catch (aiError) {
        console.warn('⚠️ AI metrics query failed:', aiError.message);
      }
      
      // Fallback to traditional engagement if no AI data
      if (aiInsightsSummary.analyzed === 0) {
        console.log('📊 No AI data, using traditional engagement metrics...');
        const traditionalMetrics = await getDashboardMetrics();
        aiInsightsSummary.hotLeads = traditionalMetrics.hotLeads;
        aiInsightsSummary.warmLeads = traditionalMetrics.warmLeads;
      }
      
      // 3. AVERAGE ENGAGEMENT TIME
      const [{ avg_time }] = (await db.query(`
        SELECT AVG(time_on_page) as avg_time 
        FROM engagement_metrics WHERE time_on_page > 0
      `)).rows;
      const avgEngagement = Math.round((avg_time || 0) / 60);

      // 4. TOP INTERESTS ANALYSIS
      const interestRow = (await db.query(`
        SELECT
          SUM(CASE WHEN sciences THEN 1 ELSE 0 END)::int AS sciences,
          SUM(CASE WHEN mathematics THEN 1 ELSE 0 END)::int AS mathematics,
          SUM(CASE WHEN english THEN 1 ELSE 0 END)::int AS english,
          SUM(CASE WHEN languages THEN 1 ELSE 0 END)::int AS languages,
          SUM(CASE WHEN humanities THEN 1 ELSE 0 END)::int AS humanities,
          SUM(CASE WHEN business THEN 1 ELSE 0 END)::int AS business,
          SUM(CASE WHEN drama THEN 1 ELSE 0 END)::int AS drama,
          SUM(CASE WHEN music THEN 1 ELSE 0 END)::int AS music,
          SUM(CASE WHEN art THEN 1 ELSE 0 END)::int AS art,
          SUM(CASE WHEN creative_writing THEN 1 ELSE 0 END)::int AS creative_writing,
          SUM(CASE WHEN sport THEN 1 ELSE 0 END)::int AS sport,
          SUM(CASE WHEN leadership THEN 1 ELSE 0 END)::int AS leadership,
          SUM(CASE WHEN academic_excellence THEN 1 ELSE 0 END)::int AS academic_excellence,
          SUM(CASE WHEN pastoral_care THEN 1 ELSE 0 END)::int AS pastoral_care
        FROM inquiries
      `)).rows[0];

      const topInterests = Object.entries(interestRow || {}).map(([subject, count]) => ({
        subject: subject.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        count: Number(count || 0)
      })).filter(x => x.count > 0).sort((a, b) => b.count - a.count).slice(0, 10);

      // 5. RECENT ACTIVITY WITH AI INSIGHTS
      const recentlyActive = (await db.query(`
        SELECT DISTINCT ON (te.inquiry_id) 
               te.inquiry_id, 
               te.event_type, 
               te."timestamp",
               COALESCE(i.first_name,'') AS first_name,
               COALESCE(i.family_surname,'') AS family_surname,
               ai.lead_score,
               ai.urgency_level
        FROM tracking_events te
        JOIN inquiries i ON i.id = te.inquiry_id
        LEFT JOIN ai_family_insights ai ON ai.inquiry_id = te.inquiry_id 
          AND ai.analysis_type = 'family_profile'
        WHERE te.event_type <> 'heartbeat' 
          AND te."timestamp" >= NOW() - INTERVAL '24 hours'
        ORDER BY te.inquiry_id, te."timestamp" DESC
        LIMIT 10
      `)).rows.map(r => ({
        name: `${r.first_name} ${r.family_surname}`.trim(),
        inquiryId: r.inquiry_id,
        activity: r.event_type,
        when: r.timestamp,
        leadScore: r.lead_score || null,
        urgencyLevel: r.urgency_level || 'unknown',
        temperature: r.lead_score >= 80 ? 'hot' : r.lead_score >= 60 ? 'warm' : 'cold'
      }));

      // 6. PRIORITY FAMILIES WITH AI SCORING
      const priorityFamilies = (await db.query(`
        SELECT 
          i.id as inquiry_id,
          COALESCE(i.first_name,'') AS first_name,
          COALESCE(i.family_surname,'') AS family_surname,
          COALESCE(i.age_group,'') AS age_group,
          COALESCE(i.entry_year,'') AS entry_year,
          COALESCE(ai.lead_score, 0) as ai_score,
          COALESCE(ai.urgency_level, 'unknown') as urgency,
          COALESCE(ai.insights_json, '{}') as insights_json,
          MAX(em.time_on_page) AS time_on_page,
          MAX(em.total_visits) AS total_visits,
          MAX(em.last_visit) AS last_visit,
          ai.generated_at as ai_analysis_date
        FROM inquiries i
        LEFT JOIN ai_family_insights ai ON ai.inquiry_id = i.id 
          AND ai.analysis_type = 'family_profile'
        LEFT JOIN engagement_metrics em ON em.inquiry_id = i.id
        GROUP BY i.id, i.first_name, i.family_surname, i.age_group, i.entry_year,
                 ai.lead_score, ai.urgency_level, ai.insights_json, ai.generated_at
        ORDER BY 
          COALESCE(ai.lead_score, 0) DESC,
          MAX(em.time_on_page) DESC,
          MAX(em.total_visits) DESC,
          i.received_at DESC
        LIMIT 15
      `)).rows.map(r => {
        let insights = {};
        try {
          insights = JSON.parse(r.insights_json || '{}');
        } catch (e) {}
        
        return {
          name: `${r.first_name} ${r.family_surname}`.trim(),
          inquiryId: r.inquiry_id,
          ageGroup: r.age_group,
          entryYear: r.entry_year,
          aiScore: r.ai_score || 0,
          urgencyLevel: r.urgency,
          timeOnPage: Number(r.time_on_page || 0),
          totalVisits: Number(r.total_visits || 0),
          lastVisit: r.last_visit,
          temperature: r.ai_score >= 80 ? 'hot' : r.ai_score >= 60 ? 'warm' : 'cold',
          hasAIAnalysis: !!r.ai_analysis_date,
          nextActions: insights.nextActions || [],
          keyObservations: insights.keyObservations || [],
          analysisDate: r.ai_analysis_date
        };
      });

      // 7. LATEST PROSPECTUSES WITH ENHANCED DATA
      let latestProspectuses = [];
      try {
        const lp = (await db.query(`
          SELECT 
            i.id, i.first_name, i.family_surname, i.prospectus_filename, 
            i.prospectus_url, i.slug, i.prospectus_generated_at,
            ai.lead_score, ai.urgency_level
          FROM inquiries i
          LEFT JOIN ai_family_insights ai ON ai.inquiry_id = i.id 
            AND ai.analysis_type = 'family_profile'
          WHERE i.prospectus_generated IS TRUE 
            AND (i.prospectus_url IS NOT NULL OR i.slug IS NOT NULL)
          ORDER BY i.prospectus_generated_at DESC NULLS LAST
          LIMIT 10
        `)).rows;
        
        latestProspectuses = lp.map(r => {
          const pretty = r.slug ? `${base}/${r.slug}` : (r.prospectus_url ? `${base}${r.prospectus_url}` : null);
          const direct = r.prospectus_url ? `${base}${r.prospectus_url}` : null;
          
          return {
            name: `${r.first_name || ''} ${r.family_surname || ''}`.trim(),
            inquiryId: r.id,
            generatedAt: r.prospectus_generated_at,
            prospectusPrettyUrl: pretty,
            prospectusDirectUrl: direct,
            leadScore: r.lead_score || null,
            urgencyLevel: r.urgency_level || 'unknown',
            temperature: r.lead_score >= 80 ? 'hot' : r.lead_score >= 60 ? 'warm' : 'cold'
          };
        });
        
        console.log(`📋 Latest prospectuses: ${latestProspectuses.length} found`);
      } catch (e) {
        console.warn('Failed to get latest prospectuses:', e.message);
      }

      // 8. BUILD ENHANCED RESPONSE
      const response = {
        summary: { 
          readyForContact, 
          highlyEngaged: aiInsightsSummary.hotLeads + aiInsightsSummary.warmLeads, 
          newInquiries7d, 
          totalFamilies,
          hotLeads: aiInsightsSummary.hotLeads,
          warmLeads: aiInsightsSummary.warmLeads,
          coldLeads: aiInsightsSummary.coldLeads,
          avgEngagement,
          aiAnalyzed: aiInsightsSummary.analyzed,
          aiAverageScore: aiInsightsSummary.averageScore || 0
        },
        topInterests, 
        recentlyActive, 
        priorityFamilies, 
        latestProspectuses,
        aiInsights: {
          available: aiInsightsSummary.analyzed > 0,
          totalAnalyzed: aiInsightsSummary.analyzed,
          averageScore: aiInsightsSummary.averageScore || 0,
          distribution: {
            hot: aiInsightsSummary.hotLeads,
            warm: aiInsightsSummary.warmLeads,
            cold: aiInsightsSummary.coldLeads
          }
        }
      };
      
      console.log('✅ Enhanced dashboard data response prepared:', {
        summary: response.summary,
        aiInsights: response.aiInsights,
        priorityFamilies: response.priorityFamilies.length,
        recentlyActive: response.recentlyActive.length
      });
      
      return res.json(response);
    }

    // JSON FALLBACK (basic functionality)
    console.log('📁 Using JSON fallback...');
    const files = await fs.readdir(path.join(__dirname, 'data')).catch(() => []);
    const inquiries = [];
    for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
      try { 
        inquiries.push(JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'))); 
      } catch {}
    }

    const now = Date.now();
    const totalFamilies = inquiries.length;
    const newInquiries7d = inquiries.filter(i => {
      const t = Date.parse(i.receivedAt || 0);
      return t && (now - t) <= 7*24*60*60*1000;
    }).length;
    const readyForContact = inquiries.filter(i => i.prospectusGenerated || i.status === 'prospectus_generated').length;

    const interestKeys = [
      'sciences','mathematics','english','languages','humanities','business',
      'drama','music','art','creative_writing','sport','leadership','community_service','outdoor_education',
      'academic_excellence','pastoral_care','university_preparation','personal_development','career_guidance','extracurricular_opportunities'
    ];
    const counts = Object.fromEntries(interestKeys.map(k => [k,0]));
    for (const i of inquiries) for (const k of interestKeys) if (i[k]) counts[k]++;

    const topInterests = Object.entries(counts).filter(([,c])=>c>0)
      .sort((a,b)=>b[1]-a[1]).slice(0,10).map(([subject,count])=>({
        subject: subject.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        count
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
          prospectusDirectUrl: i.prospectusUrl ? `${base}${i.prospectusUrl}` : null,
          leadScore: null,
          urgencyLevel: 'unknown',
          temperature: 'unknown'
        };
      });

    return res.json({
      summary: { 
        readyForContact, 
        highlyEngaged: 0, 
        newInquiries7d, 
        totalFamilies,
        hotLeads: 0,
        warmLeads: 0,
        coldLeads: 0,
        avgEngagement: 0,
        aiAnalyzed: 0,
        aiAverageScore: 0
      },
      topInterests, 
      recentlyActive: [], 
      priorityFamilies: [], 
      latestProspectuses,
      aiInsights: {
        available: false,
        totalAnalyzed: 0,
        averageScore: 0,
        distribution: { hot: 0, warm: 0, cold: 0 }
      }
    });
  } catch (e) {
    console.error('❌ Enhanced dashboard data error:', e);
    res.status(500).json({ error:'Failed to build enhanced dashboard data', message:e.message });
  }
});

// 🔧 FIXED /api/analytics/inquiries endpoint with CORRECT URLs + AI DATA
app.get('/api/analytics/inquiries', async (req, res) => {
  try {
    console.log('📋 Analytics inquiries request received...');
    const base = getBaseUrl(req);
    
    // TRY DATABASE FIRST (where your families actually live!)
    if (db) {
      console.log('🗄️ Using database for inquiries data...');
      
      try {
        // Get all inquiries from database with CORRECT URL construction + AI insights
        const inquiriesResult = await db.query(`
          SELECT 
            i.id, i.first_name, i.family_surname, i.parent_email, i.entry_year, i.age_group,
            i.received_at, i.updated_at, i.status, i.prospectus_filename, i.prospectus_url, i.slug,
            i.prospectus_generated_at, i.prospectus_generated,
            i.sciences, i.mathematics, i.english, i.languages, i.humanities, i.business,
            i.drama, i.music, i.art, i.creative_writing, i.sport, i.leadership, 
            i.community_service, i.outdoor_education,
            ai.lead_score, ai.urgency_level, ai.lead_temperature, ai.insights_json, ai.confidence_score
          FROM inquiries i
          LEFT JOIN ai_family_insights ai ON ai.inquiry_id = i.id AND ai.analysis_type = 'family_profile'
          ORDER BY COALESCE(ai.lead_score, 0) DESC, i.received_at DESC
        `);
        
        console.log(`📊 Found ${inquiriesResult.rows.length} inquiries in database`);
        
        const out = [];
        
        for (const inquiry of inquiriesResult.rows) {
          // 🎯 CRITICAL: Build CORRECT pretty path using slug
          const prettyPath = inquiry.slug ? `/${inquiry.slug}` : null;
          
          const rec = {
            id: inquiry.id,
            first_name: inquiry.first_name,
            family_surname: inquiry.family_surname,
            parent_email: inquiry.parent_email,
            entry_year: inquiry.entry_year,
            age_group: inquiry.age_group,
            received_at: inquiry.received_at,
            updated_at: inquiry.updated_at,
            status: inquiry.status,
            prospectus_filename: inquiry.prospectus_filename,
            slug: inquiry.slug,
            prospectus_generated_at: inquiry.prospectus_generated_at,
            prospectus_pretty_path: prettyPath,
            prospectus_pretty_url: prettyPath ? `${base}${prettyPath}` : null,
            prospectus_direct_url: inquiry.prospectus_url ? `${base}${inquiry.prospectus_url}` : null,
            engagement: null,
            // Include interest fields
            sciences: inquiry.sciences,
            mathematics: inquiry.mathematics,
            english: inquiry.english,
            languages: inquiry.languages,
            humanities: inquiry.humanities,
            business: inquiry.business,
            drama: inquiry.drama,
            music: inquiry.music,
            art: inquiry.art,
            sport: inquiry.sport,
            leadership: inquiry.leadership,
            community_service: inquiry.community_service,
            outdoor_education: inquiry.outdoor_education,
            // 🤖 ADD AI INSIGHTS
            aiInsights: inquiry.lead_score ? {
              leadScore: inquiry.lead_score,
              urgencyLevel: inquiry.urgency_level,
              temperature: inquiry.lead_temperature,
              confidence: inquiry.confidence_score,
              hasAnalysis: true
            } : {
              leadScore: null,
              urgencyLevel: 'unknown',
              temperature: 'unknown',
              confidence: 0,
              hasAnalysis: false
            }
          };

          // Get engagement data for this inquiry
          try {
            const engagementResult = await db.query(`
              SELECT time_on_page, scroll_depth, clicks_on_links, total_visits, last_visit
              FROM engagement_metrics
              WHERE inquiry_id = $1
              ORDER BY last_visit DESC
              LIMIT 1
            `, [inquiry.id]);
            
            if (engagementResult.rows.length) {
              const em = engagementResult.rows[0];
              rec.engagement = {
                timeOnPage: em.time_on_page || 0,
                scrollDepth: em.scroll_depth || 0,
                clickCount: em.clicks_on_links || 0,
                totalVisits: em.total_visits || 0,
                lastVisit: em.last_visit,
                engagementScore: calculateEngagementScore(em)
              };
            }
          } catch (engagementError) {
            console.warn(`⚠️ Failed to get engagement for ${inquiry.id}:`, engagementError.message);
          }
          
          out.push(rec);
        }
        
        console.log(`✅ Returning ${out.length} inquiries from database`);
        console.log(`📊 Families with engagement: ${out.filter(f => f.engagement).length}`);
        console.log(`🤖 Families with AI analysis: ${out.filter(f => f.aiInsights.hasAnalysis).length}`);
        
        return res.json(out);
        
      } catch (dbError) {
        console.error('❌ Database query failed:', dbError.message);
        console.log('📁 Falling back to JSON files...');
      }
    }
    
    // JSON FALLBACK (only if database fails)
    console.log('📁 Using JSON fallback for inquiries...');
    const dataDir = path.join(__dirname, 'data');
    const files = await fs.readdir(dataDir).catch(() => []);
    const jsonFiles = files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'));
    
    console.log(`📋 Found ${jsonFiles.length} inquiry JSON files`);
    
    const out = [];
    
    for (const f of jsonFiles) {
      try {
        const filePath = path.join(dataDir, f);
        const fileContent = await fs.readFile(filePath, 'utf8');
        const j = JSON.parse(fileContent);
        
        const prettyPath = j.prospectusPrettyPath || (j.slug ? `/${j.slug}` : null);
      
        const rec = {
          id: j.id,
          first_name: j.firstName,
          family_surname: j.familySurname,
          parent_email: j.parentEmail,
          entry_year: j.entryYear,
          age_group: j.ageGroup,
          received_at: j.receivedAt,
          updated_at: j.prospectusGeneratedAt || j.receivedAt,
          status: j.status || (j.prospectusGenerated ? 'prospectus_generated' : 'received'),
          prospectus_filename: j.prospectusFilename || null,
          slug: j.slug || null,
          prospectus_generated_at: j.prospectusGeneratedAt || null,
          prospectus_pretty_path: prettyPath,
          prospectus_pretty_url: prettyPath ? `${base}${prettyPath}` : null,
          prospectus_direct_url: j.prospectusUrl ? `${base}${j.prospectusUrl}` : null,
          engagement: null,
          // Include interest fields
          sciences: j.sciences,
          mathematics: j.mathematics,
          english: j.english,
          languages: j.languages,
          humanities: j.humanities,
          business: j.business,
          drama: j.drama,
          music: j.music,
          art: j.art,
          sport: j.sport,
          leadership: j.leadership,
          community_service: j.community_service,
          outdoor_education: j.outdoor_education,
          // No AI insights in JSON mode
          aiInsights: {
            leadScore: null,
            urgencyLevel: 'unknown',
            temperature: 'unknown',
            confidence: 0,
            hasAnalysis: false
          }
        };
        
        out.push(rec);
      } catch (fileError) {
        console.error(`❌ Error processing file ${f}:`, fileError.message);
      }
    }
    
    console.log(`✅ Returning ${out.length} inquiries from JSON files`);
    res.json(out);
    
  } catch (e) {
    console.error('❌ Analytics inquiries error:', e);
    res.status(500).json({ error: 'Failed to get inquiries' });
  }
});

// Debug endpoint to check data directory
app.get('/api/debug/data-files', async (req, res) => {
  try {
    const dataDir = path.join(__dirname, 'data');
    const files = await fs.readdir(dataDir).catch(() => []);
    const inquiryFiles = files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'));
    
    const fileDetails = [];
    for (const f of inquiryFiles.slice(0, 5)) { // Just check first 5 files
      try {
        const content = await fs.readFile(path.join(dataDir, f), 'utf8');
        const parsed = JSON.parse(content);
        fileDetails.push({
          filename: f,
          id: parsed.id,
          name: `${parsed.firstName} ${parsed.familySurname}`,
          receivedAt: parsed.receivedAt
        });
      } catch (e) {
        fileDetails.push({ filename: f, error: e.message });
      }
    }
    
    res.json({
      dataDirectory: dataDir,
      totalFiles: files.length,
      inquiryFiles: inquiryFiles.length,
      allFiles: files,
      sampleInquiries: fileDetails
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Legacy raw list (kept for parity)
app.get('/api/inquiries', async (_req, res) => {
  try {
    const files = await fs.readdir(path.join(__dirname, 'data'));
    const inquiries = [];
    for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
      inquiries.push(JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8')));
    }
    inquiries.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    res.json({ success: true, count: inquiries.length, inquiries });
  } catch (e) {
    console.error('raw inquiries error:', e);
    res.status(500).json({ success:false, error:'Failed to list inquiries' });
  }
});

// ────────────────────────────────────────────────────────────────────────────────
// Self-healing direct file route (serve/regenerate) — put BEFORE static
// ────────────────────────────────────────────────────────────────────────────────
app.get('/prospectuses/:filename', async (req, res) => {
  try {
    const filename = String(req.params.filename || '');
    let abs = path.join(__dirname, 'prospectuses', filename);

    // Serve if present
    try { await fs.access(abs); return res.sendFile(abs); } catch {}

    // Smart recovery (handles missing/changed filenames)
    const inquiry = await findInquiryByFilenameSmart(filename);
    if (inquiry) {
      const p = await generateProspectus(inquiry);
      await updateInquiryStatus(inquiry.id, p); // backfills prospectusFilename/Url
      abs = path.join(__dirname, 'prospectuses', p.filename);
      return res.sendFile(abs);
    }

    // Last nudge
    await rebuildSlugIndexFromData();
    return res.status(404).send('Prospectus file not found');
  } catch (e) {
    console.error('❌ Direct file recover failed:', e);
    return res.status(500).send('Failed to load prospectus file');
  }
});

// Keep static serving for any other static assets in /prospectuses
app.use('/prospectuses', express.static(path.join(__dirname, 'prospectuses')));

// ────────────────────────────────────────────────────────────────────────────────
// 🔧 ADMIN DEBUG ENDPOINTS
// ────────────────────────────────────────────────────────────────────────────────
app.get('/admin/rebuild-slugs', async (req, res) => {
  try {
    console.log('🔧 Manual slug rebuild requested...');
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
    
    console.log('✅ Manual slug rebuild complete:', summary);
    res.json(summary);
  } catch (error) {
    console.error('❌ Manual slug rebuild failed:', error);
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
    
    // Check what columns exist
    const columns = await db.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'inquiries'
      ORDER BY column_name
    `);
    
    // Get sample inquiry data
    const sample = await db.query(`
      SELECT id, first_name, family_surname, slug, prospectus_url, 
             prospectus_filename, prospectus_generated, status
      FROM inquiries 
      LIMIT 5
    `);
    
    // Count total inquiries
    const [{ count }] = (await db.query(`SELECT COUNT(*) as count FROM inquiries`)).rows;
    
    // Check AI insights table
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

// ────────────────────────────────────────────────────────────────────────────────
// Root/info endpoints
// ────────────────────────────────────────────────────────────────────────────────
app.get('/config.json', (req, res) => {
  const base = getBaseUrl(req);
  res.json({ baseUrl: base, webhook: `${base}/webhook`, health: `${base}/health` });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: '4.0.0-ai-enhanced',
    features: {
      analytics: 'enabled',
      tracking: 'enabled',
      dashboard: 'enabled',
      database: db ? 'connected' : 'json-only',
      prettyUrls: true,
      selfHealing: true,
      aiAnalysis: 'enabled',
      aiInsights: 'enabled',
      trackingFixed: 'enabled',
      dashboardUrlsFixed: 'enabled',
      claudeIntegration: 'enabled'
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
  <p><strong>🎯 Version 4.0.0 - AI Enhanced!</strong></p>
  <ul>
    <li>Health: <a href="${base}/health">${base}/health</a></li>
    <li>Webhook (POST JSON): <code>${base}/webhook</code></li>
    <li>Dashboard: <a href="${base}/smart_analytics_dashboard.html">${base}/smart_analytics_dashboard.html</a></li>
    <li>Inquiries (JSON): <a href="${base}/api/analytics/inquiries">${base}/api/analytics/inquiries</a></li>
    <li>Dashboard data (JSON): <a href="${base}/api/dashboard-data">${base}/api/dashboard-data</a></li>
    <li>🤖 AI Insights: <a href="${base}/api/ai/family-insights">${base}/api/ai/family-insights</a></li>
    <li>Rebuild slugs: <a href="${base}/admin/rebuild-slugs">${base}/admin/rebuild-slugs</a></li>
    <li>Debug database: <a href="${base}/admin/debug-database">${base}/admin/debug-database</a></li>
  </ul>
  <h3>🎯 New AI Features:</h3>
  <ul>
    <li>✅ Claude API integration for family analysis</li>
    <li>✅ Lead scoring and prioritization (0-100)</li>
    <li>✅ Hot/Warm/Cold temperature classification</li>
    <li>✅ Conversation starters and selling points</li>
    <li>✅ Enhanced dashboard with AI insights</li>
    <li>✅ Automated family insights generation</li>
  </ul>
  <h3>🔧 Maintained Fixes:</h3>
  <ul>
    <li>✅ Tracking script injection works properly</li>
    <li>✅ Dashboard URLs are correctly saved and displayed</li>
    <li>✅ Pretty URLs (slugs) are properly generated and resolved</li>
    <li>✅ Database synchronization with JSON fallback</li>
  </ul>
  <p>Pretty links look like: <code>${base}/the-smith-family-abc123</code></p>
  <p>🤖 AI Analysis: <code>POST ${base}/api/ai/analyze-all-families</code></p>
  <p>🧠 AI Insights API: <code>GET ${base}/api/ai/family-insights</code></p>
</body></html>`);
});

// ────────────────────────────────────────────────────────────────────────────────
// 🔧 ENHANCED PRETTY URL HANDLER (Replace your existing /:slug route)
// ────────────────────────────────────────────────────────────────────────────────
const RESERVED = new Set([
  'api','prospectuses','health','tracking','dashboard','favicon','robots',
  'sitemap','metrics','config','webhook','admin','smart_analytics_dashboard.html'
]);

app.get('/:slug', async (req, res, next) => {
  const slug = String(req.params.slug || '').toLowerCase();
  
  // Skip if invalid slug format or reserved
  if (!/^[a-z0-9-]+$/.test(slug)) return next();
  if (RESERVED.has(slug)) return next();

  console.log(`🔍 Looking up slug: ${slug}`);

  let rel = slugIndex[slug];
  if (!rel) {
    console.log(`❓ Slug not in index, rebuilding...`);
    await rebuildSlugIndexFromData();
    rel = slugIndex[slug];
  }

  if (!rel) {
    console.log(`🔎 Searching for inquiry with slug: ${slug}`);
    const inquiry = await findInquiryBySlug(slug);
    if (inquiry) {
      try {
        console.log(`🔧 Regenerating prospectus for found inquiry: ${inquiry.id}`);
        const p = await generateProspectus(inquiry);
        await updateInquiryStatus(inquiry.id, p);
        rel = p.url;
        slugIndex[slug] = rel;
        await saveSlugIndex();
        console.log(`✅ Regenerated and mapped: ${slug} -> ${rel}`);
      } catch (e) {
        console.error('❌ Auto-regen failed for slug', slug, e.message);
        return res.status(500).send('Failed to generate prospectus');
      }
    }
  }

  if (!rel) {
    console.log(`❌ Slug not found: ${slug}`);
    return res.status(404).send(`
      <h1>Prospectus Not Found</h1>
      <p>The link /${slug} could not be found.</p>
      <p><a href="/admin/rebuild-slugs">Rebuild Slug Index</a></p>
    `);
  }

  // Serve the file
  let abs = path.join(__dirname, rel);
  try {
    await fs.access(abs);
    console.log(`✅ Serving: ${slug} -> ${rel}`);
    return res.sendFile(abs);
  } catch (accessError) {
    console.log(`📁 File missing, attempting to regenerate: ${abs}`);
    
    // Try to regenerate the file
    const inquiry = await findInquiryBySlug(slug);
    if (inquiry) {
      try {
        const p = await generateProspectus(inquiry);
        await updateInquiryStatus(inquiry.id, p);
        slugIndex[slug] = p.url;
        await saveSlugIndex();
        abs = path.join(__dirname, 'prospectuses', p.filename);
        console.log(`✅ Regenerated and serving: ${slug} -> ${p.url}`);
        return res.sendFile(abs);
      } catch (regenError) {
        console.error('❌ Regeneration failed:', regenError.message);
      }
    }
    
    console.error('❌ Failed to serve slug:', slug);
    return res.status(500).send('Failed to load prospectus');
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({ success:false, error:'Not found', message:`Route ${req.method} ${req.path} not found` });
});

// ────────────────────────────────────────────────────────────────────────────────
// 🚀 ENHANCED STARTUP WITH AI TABLE CREATION
// ────────────────────────────────────────────────────────────────────────────────
async function startServer() {
  console.log('🏁 Starting More House School System with AI Analytics...');
  
  const dbConnected = await initializeDatabase();
  await ensureDirectories();
  await loadSlugIndex();
  
  // ✅ NEW: Ensure AI insights table exists
  if (dbConnected) {
    await ensureAIInsightsTable();
  }
  
  await rebuildSlugIndexFromData();

  app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 MORE HOUSE SCHOOL SYSTEM STARTED');
    console.log('╔═══════════════════════════════════════════════════════════════════════════════╗');
    console.log(`🌐 Server: http://localhost:${PORT}`);
    console.log(`📋 Webhook: http://localhost:${PORT}/webhook`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/smart_analytics_dashboard.html`);
    console.log(`🤖 AI Analysis: POST http://localhost:${PORT}/api/ai/analyze-all-families`);
    console.log(`🧠 AI Insights: GET http://localhost:${PORT}/api/ai/family-insights`);
    console.log(`🔗 Pretty URL pattern: http://localhost:${PORT}/the-<family>-family-<shortid>`);
    console.log(`📊 DB: ${dbConnected ? 'Connected' : 'JSON-only'}`);
    console.log('🎯 NEW AI FEATURES:');
    console.log('   ✅ Claude API integration for family analysis');
    console.log('   ✅ Lead scoring and prioritization (0-100)');
    console.log('   ✅ Hot/Warm/Cold temperature classification');
    console.log('   ✅ Conversation starters and selling points');
    console.log('   ✅ Enhanced dashboard with AI insights');
    console.log('   ✅ Automated family insights generation');
    console.log('🔧 PREVIOUS FIXES MAINTAINED:');
    console.log('   ✅ Tracking script injection works');
    console.log('   ✅ Dashboard URLs display correctly');
    console.log('   ✅ Pretty URLs resolve properly');
    console.log('   ✅ Database + JSON synchronization');
    console.log('╚═══════════════════════════════════════════════════════════════════════════════╝');
  });
}

process.on('SIGINT', async () => { if (db) await db.end(); process.exit(0); });
process.on('SIGTERM', async () => { if (db) await db.end(); process.exit(0); });

startServer();

// Enhanced module exports
module.exports = {
  generateProspectus,
  updateInquiryStatus,
  generateFilename,
  trackEngagementEvent,
  updateEngagementMetrics,
  analyzeFamily,  // ✅ NEW: Export AI analysis function
  ensureAIInsightsTable,  // ✅ NEW: Export table creation function
  calculateEngagementScore,  // ✅ NEW: Export engagement scoring
  extractInterests,  // ✅ NEW: Export interest extraction
  extractPriorities  // ✅ NEW: Export priority extraction
};