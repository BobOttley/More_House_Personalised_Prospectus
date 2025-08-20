// server.js — complete file (UK English comments), full feature set
// Fixed version with no conflicting endpoints and proper AI analysis

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();
const { Client } = require('pg');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: base URL + CORS
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Database Connection
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// File Management Functions
// ─────────────────────────────────────────────────────────────────────────────
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

function makeSlug(inquiry) {
  const fam = (inquiry.familySurname || 'Family').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g,'');
  const shortId = String(inquiry.id || '').replace(/[^a-z0-9]/gi,'').slice(-6).toLowerCase() || Math.random().toString(36).slice(-6);
  return `the-${fam}-family-${shortId}`;
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
    const files = await fs.readdir(path.join(__dirname, 'data'));
    for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
      try {
        const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
        if ((j.slug || '').toLowerCase() === slug) return j;
      } catch {}
    }
  } catch {}
  return null;
}

async function rebuildSlugIndexFromData() {
  let added = 0;
  try {
    const files = await fs.readdir(path.join(__dirname, 'data'));
    const js = files.filter(f => f.startsWith('inquiry-') && f.endsWith('.json'));
    for (const f of js) {
      try {
        const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
        const s = (j.slug || '').toLowerCase();
        if (!s) continue;
        let rel = j.prospectusUrl;
        if (!rel && j.prospectusFilename) rel = `/prospectuses/${j.prospectusFilename}`;
        if (rel && !slugIndex[s]) { slugIndex[s] = rel; added++; }
      } catch {}
    }
    if (added) await saveSlugIndex();
    console.log(`🔁 Rebuilt slug index (added ${added})`);
  } catch (e) {
    console.warn('⚠️ rebuildSlugIndexFromData error:', e.message);
  }
  return added;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prospectus Generation
// ─────────────────────────────────────────────────────────────────────────────
async function generateProspectus(inquiry) {
  console.log(`🎨 Generating prospectus for ${inquiry.firstName} ${inquiry.familySurname}`);
  const templatePath = path.join(__dirname, 'public', 'prospectus_template.html');
  let html;
  try {
    html = await fs.readFile(templatePath, 'utf8');
  } catch (e) {
    throw new Error(`prospectus_template.html missing: ${e.message}`);
  }

  const filename = generateFilename(inquiry);
  const relPath  = `/prospectuses/${filename}`;
  const absPath  = path.join(__dirname, relPath);

  const meta = `
<meta name="inquiry-id" content="${inquiry.id}">
<meta name="generated-date" content="${new Date().toISOString()}">
<meta name="student-name" content="${inquiry.firstName} ${inquiry.familySurname}">
<meta name="entry-year" content="${inquiry.entryYear}">
<meta name="age-group" content="${inquiry.ageGroup}">
<meta name="tracking-enabled" content="true">`;

  html = html.replace('</head>', `${meta}\n</head>`);
  const title = `${inquiry.firstName} ${inquiry.familySurname} - More House School Prospectus ${inquiry.entryYear}`;
  html = html.replace(/<title>.*?<\/title>/, `<title>${title}</title>`);

  const personaliseBoot = `<script>
document.addEventListener('DOMContentLoaded', function(){
  const userData = ${JSON.stringify(inquiry, null, 2)};
  if (typeof initializeProspectus === 'function') initializeProspectus(userData);
});
</script>`;

  const trackingInject = `<!-- Tracking -->
<script>window.MORE_HOUSE_INQUIRY_ID='${inquiry.id}';</script>
<script src="/tracking.js"></script>`;

  const idx = html.lastIndexOf('</body>');
  if (idx === -1) throw new Error('Template missing </body>');
  const finalHtml = html.slice(0, idx) + personaliseBoot + '\n' + trackingInject + '\n' + html.slice(idx);

  await fs.writeFile(absPath, finalHtml, 'utf8');

  const slug = makeSlug(inquiry);
  slugIndex[slug] = relPath;
  await saveSlugIndex();

  return {
    filename,
    url: relPath,
    slug,
    prettyPath: `/${slug}`,
    generatedAt: new Date().toISOString()
  };
}

async function updateInquiryStatus(inquiryId, pInfo) {
  // Update JSON
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

  // Best-effort DB update
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
    } catch (e) {
      console.warn('DB update failed (non-fatal):', e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tracking Functions (UNIFIED - NO CONFLICTS)
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// AI Analysis Functions
// ─────────────────────────────────────────────────────────────────────────────
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

async function analyzeFamily(inquiry, engagementData) {
  try {
    // Build context for Claude
    const familyContext = {
      name: `${inquiry.firstName} ${inquiry.familySurname}`,
      ageGroup: inquiry.ageGroup,
      entryYear: inquiry.entryYear,
      interests: extractInterests(inquiry),
      priorities: extractPriorities(inquiry),
      engagement: engagementData ? {
        timeOnPage: engagementData.time_on_page || 0,
        scrollDepth: engagementData.scroll_depth || 0,
        totalVisits: engagementData.total_visits || 0,
        lastVisit: engagementData.last_visit
      } : null
    };

    // Construct prompt for Claude
    const prompt = `As an expert education consultant for More House School, analyze this family's profile and provide insights for our admissions team.

FAMILY PROFILE:
- Student: ${familyContext.name}
- Age Group: ${familyContext.ageGroup}
- Entry Year: ${familyContext.entryYear}
- Academic Interests: ${familyContext.interests.academic.join(', ') || 'None specified'}
- Creative Interests: ${familyContext.interests.creative.join(', ') || 'None specified'}
- Family Priorities: ${familyContext.priorities.join(', ') || 'None specified'}
${familyContext.engagement ? `
ENGAGEMENT DATA:
- Time spent on prospectus: ${Math.round(familyContext.engagement.timeOnPage / 60)} minutes
- Content engagement: ${familyContext.engagement.scrollDepth}% scroll depth
- Visit frequency: ${familyContext.engagement.totalVisits} visits
- Last active: ${familyContext.engagement.lastVisit ? new Date(familyContext.engagement.lastVisit).toLocaleDateString() : 'Unknown'}
` : ''}

Please provide a JSON response with insights for admissions teams.

Respond ONLY with valid JSON in this format:
{
  "leadScore": 85,
  "conversationStarters": [
    "Ask about their interest in our science facilities",
    "Discuss our small class sizes for individual attention"
  ],
  "sellingPoints": [
    "Exceptional science laboratories", 
    "Individual attention in small classes"
  ],
  "urgencyLevel": "high",
  "nextAction": "Schedule immediate callback - highly engaged family",
  "insights": {
    "studentProfile": "Science-focused with strong academic drive",
    "familyPriorities": "Academic excellence and individual attention"
  },
  "confidence": 0.92
}`;

    // Call Claude API
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [
          { role: "user", content: prompt }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status}`);
    }

    const data = await response.json();
    let responseText = data.content[0].text;
    
    // Clean up response (remove any markdown)
    responseText = responseText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    
    const analysis = JSON.parse(responseText);
    
    return {
      leadScore: analysis.leadScore || 50,
      conversationStarters: analysis.conversationStarters || [],
      sellingPoints: analysis.sellingPoints || [],
      urgencyLevel: analysis.urgencyLevel || 'medium',
      nextAction: analysis.nextAction || 'Follow up as needed',
      insights: analysis.insights || {},
      confidence_score: analysis.confidence || 0.5,
      recommendations: analysis.conversationStarters || []
    };

  } catch (error) {
    console.error('Claude API analysis failed:', error);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Preflight
// ─────────────────────────────────────────────────────────────────────────────
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
  res.header('Access-Control-Max-Age', '86400');
  res.sendStatus(200);
});

// ─────────────────────────────────────────────────────────────────────────────
// Main Routes
// ─────────────────────────────────────────────────────────────────────────────

// Webhook: create inquiry + generate prospectus
app.post(['/webhook', '/api/inquiry'], async (req, res) => {
  try {
    const data = req.body || {};
    const required = ['firstName','familySurname','parentEmail','ageGroup','entryYear'];
    const missing = required.filter(k => !data[k]);
    if (missing.length) return res.status(400).json({ success:false, error:'Missing required fields', missingFields: missing });

    const now = new Date().toISOString();
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

    // Best-effort DB insert
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
            received_at, status, user_agent, referrer, ip_address, slug
          ) VALUES (
            $1,$2,$3,$4,$5,$6,
            $7,$8,$9,$10,$11,$12,
            $13,$14,$15,$16,
            $17,$18,$19,$20,
            $21,$22,$23,$24,$25,$26,
            $27,$28,$29,$30,$31,$32
          )
          ON CONFLICT (id) DO NOTHING
        `, [
          record.id, record.firstName, record.familySurname, record.parentEmail, record.ageGroup, record.entryYear,

          !!record.sciences, !!record.mathematics, !!record.english, !!record.languages, !!record.humanities, !!record.business,
          !!record.drama, !!record.music, !!record.art, !!record.creative_writing,
          !!record.sport, !!record.leadership, !!record.community_service, !!record.outdoor_education,
          !!record.academic_excellence, !!record.pastoral_care, !!record.university_preparation,
          !!record.personal_development, !!record.career_guidance, !!record.extracurricular_opportunities,

          new Date(record.receivedAt), record.status, record.userAgent, record.referrer, record.ip, null
        ]);
      } catch (e) { console.warn('DB insert failed (non-fatal):', e.message); }
    }

    // Generate prospectus
    const p = await generateProspectus(record);
    await updateInquiryStatus(record.id, p);

    const base = getBaseUrl(req);
    return res.json({
      success: true,
      inquiryId: record.id,
      receivedAt: record.receivedAt,
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
    return res.status(500).json({ success:false, error:e.message });
  }
});

// Manual (re)generate for an existing inquiry
app.post('/api/generate-prospectus/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    const files = await fs.readdir(path.join(__dirname, 'data'));
    let inquiry = null;
    for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
      const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
      if (j.id === inquiryId) { inquiry = j; break; }
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

// ─────────────────────────────────────────────────────────────────────────────
// TRACKING ENDPOINT (UNIFIED - NO CONFLICTS)
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// AI ANALYSIS ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/ai/analyze-all-families', async (req, res) => {
  try {
    console.log('🤖 Starting AI analysis for all families...');
    
    // Get all inquiries
    const files = await fs.readdir(path.join(__dirname, 'data'));
    const inquiries = [];
    for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
      try {
        const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
        inquiries.push(j);
      } catch {}
    }

    console.log(`📊 Found ${inquiries.length} families to analyze`);

    let analysisCount = 0;
    const errors = [];

    for (const inquiry of inquiries) {
      try {
        // Get engagement data if available
        let engagementData = null;
        if (db) {
          const r = await db.query(`
            SELECT time_on_page, scroll_depth, clicks_on_links, total_visits, last_visit
            FROM engagement_metrics
            WHERE inquiry_id = $1
            ORDER BY last_visit DESC
            LIMIT 1
          `, [inquiry.id]);
          if (r.rows.length) {
            engagementData = r.rows[0];
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
                  recommendations, generated_at
                ) VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (inquiry_id, analysis_type) DO UPDATE SET
                  insights_json = EXCLUDED.insights_json,
                  confidence_score = EXCLUDED.confidence_score,
                  recommendations = EXCLUDED.recommendations,
                  generated_at = EXCLUDED.generated_at
              `, [
                inquiry.id,
                'family_profile',
                JSON.stringify(analysis.insights),
                analysis.confidence_score,
                analysis.recommendations,
                new Date()
              ]);
            } catch (dbError) {
              console.warn(`DB insert failed for ${inquiry.id}:`, dbError.message);
            }
          }

          analysisCount++;
        }
      } catch (error) {
        console.error(`❌ Analysis failed for ${inquiry.id}:`, error.message);
        errors.push({ inquiryId: inquiry.id, error: error.message });
      }
    }

    console.log(`✅ AI analysis complete: ${analysisCount}/${inquiries.length} successful`);
    
    res.json({
      success: true,
      message: `AI analysis completed`,
      results: {
        total: inquiries.length,
        analyzed: analysisCount,
        errors: errors.length
      },
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('❌ AI analysis error:', error);
    res.status(500).json({
      success: false,
      error: 'AI analysis failed',
      message: error.message
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard APIs (DB first, JSON fallback)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/dashboard-data', async (req, res) => {
  try {
    const base = getBaseUrl(req);

    if (db) {
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
      const [{ c: highlyEngaged }] = (await db.query(`
        SELECT COUNT(*)::int AS c
        FROM engagement_metrics WHERE time_on_page > 300
      `)).rows;

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
          SUM(CASE WHEN community_service THEN 1 ELSE 0 END)::int AS community_service,
          SUM(CASE WHEN outdoor_education THEN 1 ELSE 0 END)::int AS outdoor_education,
          SUM(CASE WHEN academic_excellence THEN 1 ELSE 0 END)::int AS academic_excellence,
          SUM(CASE WHEN pastoral_care THEN 1 ELSE 0 END)::int AS pastoral_care,
          SUM(CASE WHEN university_preparation THEN 1 ELSE 0 END)::int AS university_preparation,
          SUM(CASE WHEN personal_development THEN 1 ELSE 0 END)::int AS personal_development,
          SUM(CASE WHEN career_guidance THEN 1 ELSE 0 END)::int AS career_guidance,
          SUM(CASE WHEN extracurricular_opportunities THEN 1 ELSE 0 END)::int AS extracurricular_opportunities
        FROM inquiries
      `)).rows[0];

      const topInterests = Object.entries(interestRow || {}).map(([subject, count]) => ({
        subject, count: Number(count||0)
      })).filter(x => x.count>0).sort((a,b)=>b.count-a.count).slice(0,10);

      const recentlyActive = (await db.query(`
        SELECT te.inquiry_id, te.event_type, te."timestamp",
               COALESCE(i.first_name,'') AS first_name,
               COALESCE(i.family_surname,'') AS family_surname
        FROM tracking_events te
        JOIN inquiries i ON i.id = te.inquiry_id
        WHERE te.event_type <> 'heartbeat'
        ORDER BY te."timestamp" DESC
        LIMIT 10
      `)).rows.map(r => ({
        name: `${r.first_name} ${r.family_surname}`.trim(),
        inquiryId: r.inquiry_id,
        activity: r.event_type,
        when: r.timestamp
      }));

      const priorityFamilies = (await db.query(`
        SELECT em.inquiry_id,
               MAX(em.time_on_page) AS time_on_page,
               MAX(em.total_visits) AS total_visits,
               MAX(em.last_visit) AS last_visit,
               COALESCE(i.first_name,'') AS first_name,
               COALESCE(i.family_surname,'') AS family_surname,
               COALESCE(i.age_group,'') AS age_group,
               COALESCE(i.entry_year,'') AS entry_year
        FROM engagement_metrics em
        JOIN inquiries i ON i.id = em.inquiry_id
        GROUP BY em.inquiry_id, i.first_name, i.family_surname, i.age_group, i.entry_year
        ORDER BY total_visits DESC NULLS LAST, time_on_page DESC NULLS LAST, last_visit DESC NULLS LAST
        LIMIT 10
      `)).rows.map(r => ({
        name: `${r.first_name} ${r.family_surname}`.trim(),
        inquiryId: r.inquiry_id,
        ageGroup: r.age_group,
        entryYear: r.entry_year,
        timeOnPage: Number(r.time_on_page||0),
        totalVisits: Number(r.total_visits||0),
        lastVisit: r.last_visit
      }));

      let latestProspectuses = [];
      try {
        const lp = (await db.query(`
          SELECT id, first_name, family_surname, prospectus_filename, prospectus_url, slug, prospectus_generated_at
          FROM inquiries
          WHERE prospectus_generated IS TRUE
          ORDER BY prospectus_generated_at DESC NULLS LAST
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
            prospectusDirectUrl: direct
          };
        });
      } catch {}

      return res.json({
        summary: { readyForContact, highlyEngaged, newInquiries7d, totalFamilies },
        topInterests, recentlyActive, priorityFamilies, latestProspectuses
      });
    }

    // JSON fallback
    const files = await fs.readdir(path.join(__dirname, 'data')).catch(() => []);
    const inquiries = [];
    for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
      try { inquiries.push(JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'))); } catch {}
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
      .sort((a,b)=>b[1]-a[1]).slice(0,10).map(([subject,count])=>({subject,count}));

    const recentlyActive = []; // not available without DB
    const priorityFamilies = []; // not available without DB

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

    return res.json({
      summary: { readyForContact, highlyEngaged: 0, newInquiries7d, totalFamilies },
      topInterests, recentlyActive, priorityFamilies, latestProspectuses
    });
  } catch (e) {
    console.error('dashboard-data error:', e);
    res.status(500).json({ error:'Failed to build dashboard data', message:e.message });
  }
});

// Analytics-friendly list for dashboard (with engagement when DB connected)
app.get('/api/analytics/inquiries', async (req, res) => {
  try {
    const base = getBaseUrl(req);
    const files = await fs.readdir(path.join(__dirname, 'data'));
    const out = [];
    for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
      const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
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
        engagement: null
      };

      if (db) {
        try {
          const r = await db.query(`
            SELECT time_on_page, scroll_depth, clicks_on_links, total_visits, last_visit
            FROM engagement_metrics
            WHERE inquiry_id = $1
            ORDER BY last_visit DESC
            LIMIT 1
          `, [j.id]);
          if (r.rows.length) {
            const em = r.rows[0];
            rec.engagement = {
              timeOnPage: em.time_on_page || 0,
              scrollDepth: em.scroll_depth || 0,
              clickCount: em.clicks_on_links || 0,
              totalVisits: em.total_visits || 0,
              lastVisit: em.last_visit
            };
          }
        } catch {}
      }
      out.push(rec);
    }
    out.sort((a,b)=> new Date(b.received_at) - new Date(a.received_at));
    res.json(out);
  } catch (e) {
    console.error('analytics/inquiries error:', e);
    res.status(500).json({ error:'Failed to get inquiries' });
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

// ─────────────────────────────────────────────────────────────────────────────
// Self-healing direct file route (serve/regenerate) — put BEFORE static
// ─────────────────────────────────────────────────────────────────────────────
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
      abs = path.join(__dirname, p.url);
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

// ─────────────────────────────────────────────────────────────────────────────
// Admin: rebuild slug mappings on click
// ─────────────────────────────────────────────────────────────────────────────
app.get('/admin/rebuild-slugs', async (req, res) => {
  const before = Object.keys(slugIndex).length;
  const added = await rebuildSlugIndexFromData();
  const after = Object.keys(slugIndex).length;
  res.json({ success:true, before, added, after });
});

// ─────────────────────────────────────────────────────────────────────────────
// Root/info endpoints
// ─────────────────────────────────────────────────────────────────────────────
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
    version: '3.4.0',
    features: {
      analytics: 'enabled',
      tracking: 'enabled',
      dashboard: 'enabled',
      database: db ? 'connected' : 'json-only',
      prettyUrls: true,
      selfHealing: true,
      aiAnalysis: 'enabled'
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
  <ul>
    <li>Health: <a href="${base}/health">${base}/health</a></li>
    <li>Webhook (POST JSON): <code>${base}/webhook</code></li>
    <li>Dashboard: <a href="${base}/smart_analytics_dashboard.html">${base}/smart_analytics_dashboard.html</a></li>
    <li>Inquiries (JSON): <a href="${base}/api/analytics/inquiries">${base}/api/analytics/inquiries</a></li>
    <li>Dashboard data (JSON): <a href="${base}/api/dashboard-data">${base}/api/dashboard-data</a></li>
    <li>Rebuild slugs: <a href="${base}/admin/rebuild-slugs">${base}/admin/rebuild-slugs</a></li>
  </ul>
  <p>Pretty links look like: <code>${base}/the-smith-family-abc123</code></p>
  <p>🤖 AI Analysis: <code>POST ${base}/api/ai/analyze-all-families</code></p>
</body></html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Pretty URL resolver (self-healing)
// ─────────────────────────────────────────────────────────────────────────────
const RESERVED = new Set(['api','prospectuses','health','tracking','dashboard','favicon','robots','sitemap','metrics','config','webhook','admin','smart_analytics_dashboard.html']);
app.get('/:slug', async (req, res, next) => {
  const slug = String(req.params.slug || '').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) return next();
  if (RESERVED.has(slug)) return next();

  let rel = slugIndex[slug];
  if (!rel) {
    await rebuildSlugIndexFromData();
    rel = slugIndex[slug];
  }

  if (!rel) {
    const inquiry = await findInquiryBySlug(slug);
    if (inquiry) {
      try {
        const p = await generateProspectus(inquiry);
        await updateInquiryStatus(inquiry.id, p);
        rel = p.url;
        slugIndex[slug] = rel;
        await saveSlugIndex();
      } catch (e) {
        console.error('Auto-regen failed for slug', slug, e.message);
      }
    }
  }

  if (!rel) return res.status(404).send('Prospectus link not found');

  let abs = path.join(__dirname, rel);
  try {
    await fs.access(abs).catch(async () => {
      const inquiry = await findInquiryBySlug(slug);
      if (inquiry) {
        const p = await generateProspectus(inquiry);
        await updateInquiryStatus(inquiry.id, p);
        slugIndex[slug] = p.url;
        await saveSlugIndex();
        abs = path.join(__dirname, p.url);
      }
    });
    return res.sendFile(abs);
  } catch (e) {
    console.error('Serve slug failed:', e);
    return res.status(500).send('Failed to load prospectus');
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({ success:false, error:'Not found', message:`Route ${req.method} ${req.path} not found` });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start-up
// ─────────────────────────────────────────────────────────────────────────────
async function startServer() {
  const dbConnected = await initializeDatabase();
  await ensureDirectories();
  await loadSlugIndex();
  await rebuildSlugIndexFromData();

  app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 MORE HOUSE SCHOOL SYSTEM STARTED');
    console.log('═══════════════════════════════════════');
    console.log(`🌐 Server: http://localhost:${PORT}`);
    console.log(`📋 Webhook: http://localhost:${PORT}/webhook`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/smart_analytics_dashboard.html`);
    console.log(`🤖 AI Analysis: POST http://localhost:${PORT}/api/ai/analyze-all-families`);
    console.log(`🔗 Pretty URL pattern: http://localhost:${PORT}/the-<family>-family-<shortid>`);
    console.log(`📊 DB: ${dbConnected ? 'Connected' : 'JSON-only'}`);
    console.log('═══════════════════════════════════════');
  });
}

process.on('SIGINT', async () => { if (db) await db.end(); process.exit(0); });
process.on('SIGTERM', async () => { if (db) await db.end(); process.exit(0); });

startServer();

module.exports = {
  generateProspectus,
  updateInquiryStatus,
  generateFilename,
  trackEngagementEvent,
  updateEngagementMetrics,
  analyzeFamily
};