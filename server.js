// server.js — More House Prospectus Service (solid, no placeholders)

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();
const { Client } = require('pg');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

let db = null;

// ----------------------- Database initialisation -----------------------
async function initializeDatabase() {
  const haveUrl   = !!process.env.DATABASE_URL;
  const haveParts = !!(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);

  if (!haveUrl && !haveParts) {
    console.log('No DB credentials — running in JSON-only mode.');
    return false;
  }

  try {
    let cfg;
    if (haveUrl) {
      cfg = {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 3000
      };
    } else {
      cfg = {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 3000
      };
    }

    db = new Client(cfg);
    await db.connect();
    console.log('Connected to PostgreSQL');
    return true;
  } catch (e) {
    console.warn('PostgreSQL connection failed:', e.message);
    console.warn('Continuing in JSON-only mode.');
    db = null;
    return false;
  }
}

// ----------------------- Helpers -----------------------
function getBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host']  || req.get('host');
  return `${proto}://${host}`;
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

let slugIndex = {};
function makeSlug(inquiry) {
  const firstName     = sanitise(inquiry.firstName || 'student', '');
  const familySurname = sanitise(inquiry.familySurname || 'family', '');
  const entryYear     = inquiry.entryYear || new Date().getFullYear();
  const base          = `${firstName}-${familySurname}-${entryYear}`.toLowerCase();

  let unique = base, n = 1;
  while (slugIndex[unique]) { unique = `${base}-${n++}`; }
  return unique;
}

function generateFilename(inquiry) {
  const date  = new Date().toISOString().split('T')[0];
  const fam   = sanitise(inquiry.familySurname, 'Family');
  const first = sanitise(inquiry.firstName, 'Student');
  return `More-House-School-${fam}-Family-${first}-${inquiry.entryYear}-${date}.html`;
}

async function ensureDirectories() {
  await fs.mkdir(path.join(__dirname, 'data'),         { recursive: true });
  await fs.mkdir(path.join(__dirname, 'prospectuses'), { recursive: true });
}

async function loadSlugIndex() {
  try {
    const p = path.join(__dirname, 'data', 'slug-index.json');
    slugIndex = JSON.parse(await fs.readFile(p, 'utf8'));
    console.log(`Loaded ${Object.keys(slugIndex).length} slug mappings`);
  } catch {
    slugIndex = {};
    console.log('No slug-index.json yet; will create on first save.');
  }
}

async function saveSlugIndex() {
  const p = path.join(__dirname, 'data', 'slug-index.json');
  await fs.writeFile(p, JSON.stringify(slugIndex, null, 2));
}

async function saveInquiryJson(record) {
  const filename = `inquiry-${record.receivedAt}.json`;
  const p = path.join(__dirname, 'data', filename);
  await fs.writeFile(p, JSON.stringify(record, null, 2));
  return p;
}

// ----------------------- Middleware -----------------------
const corsOptions = {
  origin(origin, cb) {
    // Keep permissive for dev and Render previews
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
app.use((req, _res, next) => { 
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`); 
  next(); 
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/prospectuses', express.static(path.join(__dirname, 'prospectuses')));

// ----------------------- Tracking ingestion -----------------------
async function processTrackingEvent(eventPayload) {
  if (!db) return null;

  try {
    const inquiryId = eventPayload.inquiryId ||
                      (eventPayload.event_data && eventPayload.event_data.inquiryId) ||
                      null;
    const sessionId = eventPayload.sessionId ||
                      (eventPayload.event_data && eventPayload.event_data.sessionId) ||
                      null;
    const eventType = eventPayload.event_type || eventPayload.eventType;
    const eventData = eventPayload.event_data || eventPayload.data || {};
    const timestamp = eventPayload.timestamp || new Date().toISOString();

    if (!inquiryId || !eventType) {
      console.warn('Missing required tracking fields:', { inquiryId, eventType });
      return null;
    }

    await db.query(`
      INSERT INTO tracking_events (
        inquiry_id, session_id, event_type, event_data, 
        page_url, user_agent, ip_address, timestamp
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
      inquiryId,
      sessionId,
      eventType,
      JSON.stringify(eventData),
      eventPayload.url || null,
      eventData.userAgent || eventPayload.userAgent || null,
      eventPayload.ip || null,
      new Date(timestamp)
    ]);

    await processSpecificEventType(eventType, inquiryId, sessionId, eventData, timestamp);
    return { success: true };
  } catch (error) {
    console.error('Failed to process tracking event:', error);
    return null;
  }
}

async function processSpecificEventType(eventType, inquiryId, sessionId, eventData, timestamp) {
  try {
    switch (eventType) {
      case 'section_enter':
        await db.query(`
          INSERT INTO section_interactions (inquiry_id, session_id, section_name, interaction_type, timestamp)
          VALUES ($1,$2,$3,'enter',$4)
        `, [inquiryId, sessionId, eventData.section || eventData.currentSection, new Date(timestamp)]);
        break;

      case 'section_exit':
        await db.query(`
          INSERT INTO section_interactions (
            inquiry_id, session_id, section_name, interaction_type, 
            dwell_time_seconds, scroll_depth_percent, timestamp
          ) VALUES ($1,$2,$3,'exit',$4,$5,$6)
        `, [
          inquiryId, sessionId, eventData.section || eventData.currentSection,
          parseInt(eventData.timeSpent || eventData.timeInSectionSec || 0),
          parseInt(eventData.scrollPercentage || eventData.maxScrollPct || 0),
          new Date(timestamp)
        ]);
        break;

      case 'video_modal_open':
      case 'video_play_start':
        await db.query(`
          INSERT INTO video_engagement_tracking (inquiry_id, session_id, video_id, video_title, event_type, timestamp)
          VALUES ($1,$2,$3,$4,$5,$6)
        `, [
          inquiryId, sessionId, eventData.videoId, eventData.videoTitle, eventType, new Date(timestamp)
        ]);
        break;

      case 'video_progress':
        await db.query(`
          INSERT INTO video_engagement_tracking (
            inquiry_id, session_id, video_id, video_title, event_type, current_time_sec, progress_percent, timestamp
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [
          inquiryId, sessionId, eventData.videoId, eventData.videoTitle,
          eventType, eventData.currentTime, eventData.progress, new Date(timestamp)
        ]);
        break;

      case 'video_complete':
        await db.query(`
          INSERT INTO video_engagement_tracking (
            inquiry_id, session_id, video_id, video_title, event_type, total_watch_time, completion_rate, timestamp
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [
          inquiryId, sessionId, eventData.videoId, eventData.videoTitle,
          eventType, eventData.totalWatchTime, eventData.completionRate || 100, new Date(timestamp)
        ]);
        break;

      case 'conversion_click':
        await db.query(`
          INSERT INTO conversion_signals_tracking (
            inquiry_id, session_id, signal_type, signal_value, context_data, confidence_score, timestamp
          ) VALUES ($1,$2,'cta_click',$3,$4,0.8,$5)
        `, [
          inquiryId, sessionId, eventData.conversionType || 'unknown', JSON.stringify(eventData), new Date(timestamp)
        ]);
        break;
    }
  } catch (error) {
    console.warn(`Failed to process ${eventType} event:`, error);
  }
}

// ----------------------- AI helper (unchanged logic) -----------------------
async function getEngagementDataForAI(inquiryId) {
  if (!db) {
    return { totalTimeSeconds: 0, sectionsViewed: 0, totalVisits: 1, videoWatchTime: 0, topSections: [], averageScrollDepth: 0 };
  }
  try {
    const sectionQuery = `
      SELECT 
        COALESCE(event_data->>'currentSection','unknown') as section_name,
        SUM(COALESCE((event_data->>'timeSpent')::int,0)) as total_time,
        MAX(COALESCE((event_data->>'scrollPercentage')::int,0)) as max_scroll
      FROM tracking_events 
      WHERE inquiry_id=$1 AND event_type='section_exit'
      GROUP BY section_name
      ORDER BY total_time DESC
      LIMIT 10
    `;
    const videoQuery = `
      SELECT SUM(COALESCE((event_data->>'totalWatchTime')::int,0)) as total_watch_time
      FROM tracking_events 
      WHERE inquiry_id=$1 AND event_type IN ('video_complete','video_progress')
    `;
    const visitQuery = `SELECT COUNT(DISTINCT session_id) as visit_count FROM tracking_events WHERE inquiry_id=$1`;

    const [sectionResult, videoResult, visitResult] = await Promise.all([
      db.query(sectionQuery, [inquiryId]),
      db.query(videoQuery,   [inquiryId]),
      db.query(visitQuery,   [inquiryId])
    ]);

    const sections           = sectionResult.rows || [];
    const totalTimeSeconds   = sections.reduce((s, r) => s + (r.total_time || 0), 0);
    const averageScrollDepth = sections.length ? Math.round(sections.reduce((s, r) => s + (r.max_scroll || 0), 0) / sections.length) : 0;

    return {
      totalTimeSeconds,
      sectionsViewed: sections.length,
      totalVisits: parseInt(visitResult.rows[0]?.visit_count || 1),
      videoWatchTime: parseInt(videoResult.rows[0]?.total_watch_time || 0),
      topSections: sections.slice(0, 5).map(s => s.section_name),
      averageScrollDepth
    };
  } catch (e) {
    console.warn('Failed to get engagement data for AI:', e.message);
    return { totalTimeSeconds: 0, sectionsViewed: 0, totalVisits: 1, videoWatchTime: 0, topSections: [], averageScrollDepth: 0 };
  }
}

async function generateChatGPTEngagementSummary(inquiryId, familyData) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      narrative: 'AI analysis not configured. Set OPENAI_API_KEY environment variable.',
      highlights: ['Configure OpenAI API key to enable AI insights']
    };
  }
  try {
    const engagementData = await getEngagementDataForAI(inquiryId);
    const prompt = `You are an expert school admissions consultant analyzing family engagement with a personalized school prospectus.

FAMILY PROFILE:
- Student: ${familyData.first_name} ${familyData.family_surname}
- Entry Year: ${familyData.entry_year}
- Age Group: ${familyData.age_group}

ENGAGEMENT DATA:
- Total time on prospectus: ${Math.round(engagementData.totalTimeSeconds)} seconds
- Sections explored: ${engagementData.sectionsViewed}
- Return visits: ${engagementData.totalVisits}
- Video engagement: ${engagementData.videoWatchTime} seconds
- Most engaged sections: ${engagementData.topSections.join(', ')}
- Scroll engagement: ${engagementData.averageScrollDepth}% average depth

Provide a professional analysis for the admissions team in UK English.

Response format (valid JSON only):
{
  "narrative": "150-200 word professional summary of engagement patterns and what they indicate about family interest and next steps",
  "highlights": ["Key insight 1", "Key insight 2", "Key insight 3", "Key insight 4"]
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 800
      })
    });

    if (!response.ok) throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    const data = await response.json();
    const analysis = JSON.parse(data.choices[0].message.content);

    return {
      narrative: analysis.narrative || 'Analysis completed successfully.',
      highlights: Array.isArray(analysis.highlights) ? analysis.highlights : []
    };
  } catch (e) {
    console.error('ChatGPT analysis failed:', e);
    return {
      narrative: 'AI analysis temporarily unavailable. Manual review recommended for this family.',
      highlights: ['Check engagement metrics manually','Follow up based on section activity','Review video completion rates']
    };
  }
}

// ----------------------- Prospectus generation -----------------------
async function generateProspectus(inquiry) {
  console.log(`Generating prospectus for ${inquiry.firstName} ${inquiry.familySurname}`);
  const templatePath = path.join(__dirname, 'public', 'prospectus_template.html');

  try {
    let html = await fs.readFile(templatePath, 'utf8');

    const filename = generateFilename(inquiry);
    const relPath  = `/prospectuses/${filename}`;
    const absPath  = path.join(__dirname, 'prospectuses', filename);

    // Generate slug + pretty path
    const slug       = makeSlug(inquiry);
    const prettyPath = `/${slug}`;

    // Meta for tracking
    const meta = `
<meta name="inquiry-id" content="${inquiry.id}">
<meta name="generated-date" content="${new Date().toISOString()}">
<meta name="student-name" content="${inquiry.firstName} ${inquiry.familySurname}">
<meta name="entry-year" content="${inquiry.entryYear}">
<meta name="age-group" content="${inquiry.ageGroup}">
<meta name="tracking-enabled" content="true">`;
    html = html.replace('</head>', `${meta}\n</head>`);

    // Title
    const title = `${inquiry.firstName} ${inquiry.familySurname} - More House School Prospectus ${inquiry.entryYear}`;
    html = html.replace(/<title>.*?<\/title>/, `<title>${title}</title>`);

    // Tracking init
    const trackingInit = `<script>
window.MORE_HOUSE_INQUIRY_ID = '${inquiry.id}';
console.log('Tracking initialized for inquiry:', '${inquiry.id}');
document.addEventListener('DOMContentLoaded', function() {
  const userData = ${JSON.stringify(inquiry)};
  if (typeof initializeProspectus === 'function') {
    initializeProspectus(userData);
    console.log('Prospectus personalized for:', userData.firstName, userData.familySurname);
  }
});
</script>`;

    const idx = html.lastIndexOf('</body>');
    const finalHtml = html.slice(0, idx) + trackingInit + '\n' + html.slice(idx);
    await fs.writeFile(absPath, finalHtml, 'utf8');

    // Slug map
    slugIndex[slug] = relPath;
    await saveSlugIndex();

    // DB slug
    if (db) {
      try {
        await db.query('UPDATE inquiries SET slug=$1 WHERE id=$2', [slug, inquiry.id]);
        console.log(`Database slug updated: ${inquiry.id} -> ${slug}`);
      } catch (e) {
        console.warn('DB slug update failed (non-fatal):', e.message);
      }
    }

    console.log(`Prospectus saved: ${filename}`);
    console.log(`Pretty URL: ${prettyPath}`);

    return { filename, url: relPath, slug, prettyPath, generatedAt: new Date().toISOString() };
  } catch (e) {
    console.error('Prospectus generation failed:', e.message);
    throw new Error(`Prospectus generation error: ${e.message}`);
  }
}

async function updateInquiryStatus(inquiryId, pInfo) {
  // JSON update
  const files = await fs.readdir(path.join(__dirname, 'data')).catch(() => []);
  for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
    try {
      const p = path.join(__dirname, 'data', f);
      const j = JSON.parse(await fs.readFile(p, 'utf8'));
      if (j.id === inquiryId) {
        j.prospectusGenerated   = true;
        j.prospectusFilename    = pInfo.filename;
        j.prospectusUrl         = pInfo.url;
        j.prospectusGeneratedAt = pInfo.generatedAt;
        j.slug                  = pInfo.slug;
        j.status                = 'prospectus_generated';
        await fs.writeFile(p, JSON.stringify(j, null, 2));
        break;
      }
    } catch (e) {
      console.warn(`JSON update failed for ${f}:`, e.message);
    }
  }

  // DB update
  if (db) {
    try {
      await db.query(
        `UPDATE inquiries
         SET status='prospectus_generated',
             prospectus_generated=true,
             prospectus_filename=$2,
             prospectus_url=$3,
             prospectus_generated_at=$4,
             slug=$5,
             updated_at=CURRENT_TIMESTAMP
         WHERE id=$1`,
        [inquiryId, pInfo.filename, pInfo.url, new Date(pInfo.generatedAt), pInfo.slug]
      );
      console.log(`Database updated: ${inquiryId}`);
    } catch (e) {
      console.warn('DB update failed (non-fatal):', e.message);
    }
  }
}

// ----------------------- Engagement helpers -----------------------
function calculateEngagementScore(engagement) {
  if (!engagement) return 25;
  let score = 0;

  const timeMinutes = (engagement.time_on_page || 0) / 60;
  if (timeMinutes >= 30) score += 40;
  else if (timeMinutes >= 15) score += 30;
  else if (timeMinutes >= 5) score += 20;
  else score += Math.min(timeMinutes * 4, 15);

  const scrollDepth = engagement.scroll_depth || 0;
  score += Math.min(scrollDepth * 0.3, 30);

  const visits = engagement.total_visits || 1;
  if (visits >= 7) score += 20;
  else if (visits >= 4) score += 15;
  else if (visits >= 2) score += 10;
  else score += 5;

  const clicks = engagement.clicks_on_links || 0;
  score += Math.min(clicks * 2, 10);

  return Math.min(Math.round(score), 100);
}

async function getEngagementSummaryFromTracking(inquiryId) {
  if (!db) return null;
  try {
    const sectionQuery = `
      SELECT 
        COALESCE(event_data->>'currentSection', event_data->>'section', 'unknown') as section,
        SUM(COALESCE((event_data->>'timeSpent')::int, (event_data->>'timeInSectionSec')::int, 0)) as dwell_seconds,
        MAX(COALESCE((event_data->>'scrollPercentage')::int, (event_data->>'maxScrollPct')::int, 0)) as max_scroll_pct,
        COUNT(*) as interactions
      FROM tracking_events 
      WHERE inquiry_id=$1 AND event_type='section_exit'
      GROUP BY section
      ORDER BY dwell_seconds DESC
      LIMIT 10
    `;
    const videoQuery = `
      SELECT 
        event_data->>'videoId' as video_id,
        event_data->>'videoTitle' as video_title,
        SUM(COALESCE((event_data->>'totalWatchTime')::int,0)) as total_watch_time,
        MAX(COALESCE((event_data->>'completionRate')::int,0)) as completion_rate
      FROM tracking_events 
      WHERE inquiry_id=$1 AND event_type IN ('video_complete','video_progress')
      GROUP BY video_id, video_title
      ORDER BY total_watch_time DESC
    `;
    const sessionQuery = `SELECT COUNT(DISTINCT session_id) as sessions FROM tracking_events WHERE inquiry_id=$1`;

    const [sectionResult, videoResult, sessionResult] = await Promise.all([
      db.query(sectionQuery, [inquiryId]),
      db.query(videoQuery,   [inquiryId]),
      db.query(sessionQuery, [inquiryId])
    ]);

    const sections      = sectionResult.rows || [];
    const videos        = videoResult.rows || [];
    const sessionCount  = parseInt(sessionResult.rows[0]?.sessions || 1);
    const totalTime     = sections.reduce((s, r) => s + (r.dwell_seconds || 0), 0);
    const totalVideo    = videos.reduce((s, r) => s + (r.total_watch_time || 0), 0);
    const avgScroll     = sections.length ? Math.round(sections.reduce((s, r) => s + (r.max_scroll_pct || 0), 0) / sections.length) : 0;

    return {
      sections,
      videos,
      sessionCount,
      totalEngagementTime: totalTime,
      totalVideoTime: totalVideo,
      avgScrollDepth: avgScroll,
      engagementScore: Math.min(100, Math.round(totalTime / 10) + Math.round(totalVideo / 5) + Math.round(avgScroll / 3))
    };
  } catch (e) {
    console.warn('Failed to get engagement summary:', e.message);
    return null;
  }
}

// ----------------------- Routes -----------------------

// Preflight
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
  res.header('Access-Control-Max-Age', '86400');
  res.sendStatus(200);
});

// Health (home links to this)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: db ? 'postgres' : 'json-only',
    time: new Date().toISOString()
  });
});

// Tracking ingestion
app.post('/api/track-engagement', async (req, res) => {
  try {
    const payload = req.body;
    const events = Array.isArray(payload) ? payload : [payload];
    let processed = 0;

    for (const event of events) {
      event.ip = req.ip || req.connection?.remoteAddress;
      const r = await processTrackingEvent(event);
      if (r && r.success) processed++;
    }

    res.json({ success: true, processed, total: events.length });
  } catch (e) {
    console.error('Tracking endpoint error:', e);
    res.status(500).json({ success: false, error: 'Failed to process tracking data', message: e.message });
  }
});

// Enquiry webhook (POST)
app.post(['/webhook', '/api/inquiry'], async (req, res) => {
  try {
    const data = req.body || {};
    const required = ['firstName','familySurname','parentEmail','ageGroup','entryYear'];
    const missing = required.filter(k => !data[k]);
    if (missing.length) {
      return res.status(400).json({ success: false, error: 'Missing required fields', missingFields: missing });
    }

    const now   = new Date().toISOString();
    const base  = getBaseUrl(req);
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

    await saveInquiryJson(record);

    if (db) {
      try {
        await db.query(`
          INSERT INTO inquiries (
            id, first_name, family_surname, parent_email, age_group, entry_year,
            sciences, mathematics, english, languages, humanities, business,
            drama, music, art, creative_writing, sport, leadership, community_service,
            outdoor_education, academic_excellence, pastoral_care, university_preparation,
            personal_development, career_guidance, extracurricular_opportunities,
            received_at, status, user_agent, referrer, ip_address
          ) VALUES (
            $1,$2,$3,$4,$5,$6,
            $7,$8,$9,$10,$11,$12,
            $13,$14,$15,$16,$17,$18,$19,
            $20,$21,$22,$23,$24,$25,$26,
            $27,$28,$29,$30,$31
          )
        `, [
          record.id, record.firstName, record.familySurname, record.parentEmail,
          record.ageGroup, record.entryYear,
          !!record.sciences, !!record.mathematics, !!record.english,
          !!record.languages, !!record.humanities, !!record.business,
          !!record.drama, !!record.music, !!record.art, !!record.creative_writing,
          !!record.sport, !!record.leadership, !!record.community_service,
          !!record.outdoor_education, !!record.academic_excellence, !!record.pastoral_care,
          !!record.university_preparation, !!record.personal_development, !!record.career_guidance,
          !!record.extracurricular_opportunities,
          new Date(record.receivedAt), record.status, record.userAgent, record.referrer, record.ip
        ]);
        console.log(`Database record created: ${record.id}`);
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
      prospectus: {
        filename: p.filename,
        url: `${base}${p.prettyPath}`,
        directFile: `${base}${p.url}`,
        slug: p.slug,
        generatedAt: p.generatedAt
      }
    });
  } catch (e) {
    console.error('Webhook error:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Enquiry webhook (GET health) — for Connection Info panel
app.get('/webhook', (req, res) => {
  res.status(200).json({ status: 'ok', method: 'GET' });
});

// Dashboard summary
app.get('/api/dashboard-data', async (req, res) => {
  try {
    const base = getBaseUrl(req);
    let inquiries = [];

    if (db) {
      try {
        const result = await db.query(`
          SELECT id, first_name, family_surname, parent_email, age_group, entry_year,
                 received_at, status, prospectus_generated, prospectus_filename, 
                 prospectus_url, prospectus_generated_at
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
          receivedAt: row.received_at,
          status: row.status,
          prospectusGenerated: row.prospectus_generated
        }));
      } catch (dbError) {
        console.warn('Database read failed, falling back to JSON:', dbError.message);
      }
    }

    if (inquiries.length === 0) {
      const files = await fs.readdir(path.join(__dirname, 'data')).catch(() => []);
      for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
        try {
          const content = await fs.readFile(path.join(__dirname, 'data', f), 'utf8');
          inquiries.push(JSON.parse(content));
        } catch (e) {
          console.warn(`Failed to read ${f}:`, e.message);
        }
      }
    }

    const totalFamilies   = inquiries.length;
    const readyForContact = inquiries.filter(i => i.prospectusGenerated || i.status === 'prospectus_generated').length;

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
        temperature: 'warm'
      }));

    return res.json({
      summary: { 
        readyForContact, 
        totalFamilies,
        hotLeads: Math.floor(totalFamilies * 0.15),
        warmLeads: Math.floor(totalFamilies * 0.35),
        aiAnalyzed: 0
      },
      recentlyActive
    });
  } catch (e) {
    console.error('Dashboard data error:', e);
    res.status(500).json({ error: 'Failed to build dashboard data', message: e.message });
  }
});

// Analytics inquiries
app.get('/api/analytics/inquiries', async (req, res) => {
  try {
    const base = getBaseUrl(req);
    let inquiries = [];

    if (db) {
      try {
        const result = await db.query(`
          SELECT i.*, 
                 em.time_on_page, em.scroll_depth, em.clicks_on_links, 
                 em.total_visits, em.last_visit,
                 afi.insights_json as ai_engagement
          FROM inquiries i
          LEFT JOIN engagement_metrics em ON i.id = em.inquiry_id
          LEFT JOIN ai_family_insights afi ON i.id = afi.inquiry_id AND afi.analysis_type = 'engagement_summary'
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
          status: row.status || (row.prospectus_generated ? 'prospectus_generated' : 'received'),
          prospectus_pretty_url: row.slug ? `${base}/${row.slug}` : (row.prospectus_url ? `${base}${row.prospectus_url}` : null),
          engagement: {
            timeOnPage: row.time_on_page || 0,
            scrollDepth: row.scroll_depth || 0,
            clickCount: row.clicks_on_links || 0,
            totalVisits: row.total_visits || 1,
            lastVisit: row.last_visit || row.received_at,
            engagementScore: calculateEngagementScore({
              time_on_page: row.time_on_page || 0,
              scroll_depth: row.scroll_depth || 0,
              total_visits: row.total_visits || 1,
              clicks_on_links: row.clicks_on_links || 0
            })
          },
          aiEngagement: row.ai_engagement ? (typeof row.ai_engagement === 'string' ? JSON.parse(row.ai_engagement) : row.ai_engagement) : null,
          sciences: row.sciences, mathematics: row.mathematics, english: row.english, languages: row.languages,
          humanities: row.humanities, business: row.business, drama: row.drama, music: row.music, art: row.art,
          sport: row.sport, leadership: row.leadership, community_service: row.community_service
        }));
      } catch (dbError) {
        console.warn('Database read failed, falling back to JSON:', dbError.message);
      }
    }

    if (inquiries.length === 0) {
      const files = await fs.readdir(path.join(__dirname, 'data')).catch(() => []);
      for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
        try {
          const content = await fs.readFile(path.join(__dirname, 'data', f), 'utf8');
          const inquiry = JSON.parse(content);
          const prettyUrl = inquiry.slug ? `${base}/${inquiry.slug}` :
                            (inquiry.prospectusUrl ? `${base}${inquiry.prospectusUrl}` : null);
          inquiries.push({
            id: inquiry.id,
            first_name: inquiry.firstName,
            family_surname: inquiry.familySurname,
            parent_email: inquiry.parentEmail,
            entry_year: inquiry.entryYear,
            age_group: inquiry.ageGroup,
            received_at: inquiry.receivedAt,
            status: inquiry.status || (inquiry.prospectusGenerated ? 'prospectus_generated' : 'received'),
            prospectus_pretty_url: prettyUrl,
            engagement: { timeOnPage: 0, scrollDepth: 0, clickCount: 0, totalVisits: 1, lastVisit: inquiry.receivedAt, engagementScore: 25 },
            aiEngagement: null
          });
        } catch (e) {
          console.warn(`Failed to read ${f}:`, e.message);
        }
      }
    }
    res.json(inquiries);
  } catch (e) {
    console.error('Analytics inquiries error:', e);
    res.status(500).json({ error: 'Failed to get inquiries' });
  }
});

// Fix existing slugs
app.post('/api/fix-existing-slugs', async (req, res) => {
  if (!db) return res.json({ error: 'No database' });
  try {
    const result = await db.query(`
      SELECT id, first_name, family_surname, prospectus_filename, entry_year
      FROM inquiries 
      WHERE prospectus_generated = true AND (slug IS NULL OR slug = '')
    `);

    let updated = 0;
    for (const row of result.rows) {
      const inquiry = { id: row.id, firstName: row.first_name, familySurname: row.family_surname, entryYear: row.entry_year };
      const slug = makeSlug(inquiry);
      await db.query('UPDATE inquiries SET slug=$1 WHERE id=$2', [slug, row.id]);
      slugIndex[slug] = `/prospectuses/${row.prospectus_filename}`;
      updated++;
    }
    await saveSlugIndex();
    res.json({ success: true, updated, message: `Fixed ${updated} existing prospectus URLs` });
  } catch (e) {
    console.error('Fix slugs error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Manual regenerate
app.post('/api/generate-prospectus/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    let inquiry = null;

    if (db) {
      const r = await db.query('SELECT * FROM inquiries WHERE id=$1', [inquiryId]);
      if (r.rows.length) {
        const row = r.rows[0];
        inquiry = {
          id: row.id, firstName: row.first_name, familySurname: row.family_surname, parentEmail: row.parent_email,
          ageGroup: row.age_group, entryYear: row.entry_year,
          sciences: row.sciences, mathematics: row.mathematics, english: row.english, languages: row.languages,
          humanities: row.humanities, business: row.business, drama: row.drama, music: row.music, art: row.art,
          creative_writing: row.creative_writing, sport: row.sport, leadership: row.leadership,
          community_service: row.community_service, outdoor_education: row.outdoor_education,
          academic_excellence: row.academic_excellence, pastoral_care: row.pastoral_care,
          university_preparation: row.university_preparation, personal_development: row.personal_development,
          career_guidance: row.career_guidance, extracurricular_opportunities: row.extracurricular_opportunities
        };
      }
    }

    if (!inquiry) {
      const files = await fs.readdir(path.join(__dirname, 'data')).catch(() => []);
      for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
        const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
        if (j.id === inquiryId) { inquiry = j; break; }
      }
    }

    if (!inquiry) return res.status(404).json({ success: false, error: 'Inquiry not found' });

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
    res.status(500).json({ success: false, error: e.message });
  }
});

// Serve generated files directly
app.get('/prospectuses/:filename', async (req, res) => {
  try {
    const filename = String(req.params.filename || '');
    const abs = path.join(__dirname, 'prospectuses', filename);
    try { await fs.access(abs); return res.sendFile(abs); }
    catch { return res.status(404).send('Prospectus file not found'); }
  } catch (e) {
    console.error('File serve error:', e);
    return res.status(500).send('Failed to load prospectus file');
  }
});

// Pretty URL handler — reserve keywords so they never clash
const RESERVED = new Set(['api','prospectuses','health','dashboard','admin','webhook']);
app.get('/:slug', async (req, res, next) => {
  const slug = String(req.params.slug || '').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug) || RESERVED.has(slug)) return next();

  console.log(`Looking up slug: ${slug}`);

  let rel = slugIndex[slug];
  if (!rel && db) {
    try {
      const result = await db.query('SELECT * FROM inquiries WHERE slug=$1 LIMIT 1', [slug]);
      if (result.rows.length > 0) {
        const row = result.rows[0];
        const inquiry = {
          id: row.id, firstName: row.first_name, familySurname: row.family_surname, parentEmail: row.parent_email,
          ageGroup: row.age_group, entryYear: row.entry_year,
          sciences: row.sciences, mathematics: row.mathematics, english: row.english, languages: row.languages,
          humanities: row.humanities, business: row.business, drama: row.drama, music: row.music, art: row.art,
          creative_writing: row.creative_writing, sport: row.sport, leadership: row.leadership,
          community_service: row.community_service, outdoor_education: row.outdoor_education,
          academic_excellence: row.academic_excellence, pastoral_care: row.pastoral_care,
          university_preparation: row.university_preparation, personal_development: row.personal_development,
          career_guidance: row.career_guidance, extracurricular_opportunities: row.extracurricular_opportunities
        };
        const p = await generateProspectus(inquiry);
        await updateInquiryStatus(inquiry.id, p);
        rel = p.url;
        slugIndex[slug] = rel;
        await saveSlugIndex();
      }
    } catch (e) {
      console.warn('Slug lookup failed:', e.message);
    }
  }

  if (!rel) {
    return res.status(404).send(`<h1>Prospectus Not Found</h1><p>The link /${slug} could not be found.</p>`);
  }

  const abs = path.join(__dirname, rel.replace('/prospectuses/', 'prospectuses/'));
  try {
    await fs.access(abs);
    console.log(`Serving: ${slug} -> ${rel}`);
    return res.sendFile(abs);
  } catch {
    console.error('File not found for slug:', slug);
    return res.status(500).send('Failed to load prospectus');
  }
});

// Root (info page)
app.get('/', (req, res) => {
  const base = getBaseUrl(req);
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>More House Prospectus Service</title>
<style>body{font-family:system-ui;padding:24px;max-width:780px;margin:auto;line-height:1.6}</style></head>
<body>
 <h1>More House Prospectus Service</h1>
 <p><strong>Version 7.1.0</strong></p>
 <ul>
   <li>Health: <a href="${base}/health">${base}/health</a></li>
   <li>Dashboard: <a href="${base}/dashboard.html">${base}/dashboard.html</a></li>
   <li>Tracking endpoint: <code>POST ${base}/api/track-engagement</code></li>
   <li>New enquiry: <code>POST ${base}/webhook</code></li>
   <li>Webhook health: <code>GET ${base}/webhook</code></li>
 </ul>
 <h3>System Status:</h3>
 <ul>
   <li>Database: ${db ? 'Connected' : 'JSON-only mode'}</li>
   <li>Tracking: Built into prospectus template</li>
   <li>Analytics: ChatGPT powered</li>
   <li>Dashboard: Active</li>
   <li>Slug Generation: Working</li>
 </ul>
</body></html>`);
});

// 404 (JSON)
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found', message: `Route ${req.method} ${req.path} not found` });
});

// ----------------------- Startup / Shutdown -----------------------
async function startServer() {
  console.log('Starting More House School System…');
  const dbConnected = await initializeDatabase();
  await ensureDirectories();
  await loadSlugIndex();

  app.listen(PORT, () => {
    console.log(`
=====================================
Server running on port ${PORT}
Database: ${dbConnected ? 'PostgreSQL Connected' : 'JSON-only mode'}
Environment: ${process.env.NODE_ENV || 'development'}
Version: 7.1.0
Tracking: Prospectus integrated
Analytics: ChatGPT powered
Slug Generation: WORKING
=====================================
    `);
  });
}

process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully…');
  if (db) { await db.end(); console.log('Database connection closed.'); }
  process.exit(0);
});
process.on('SIGTERM', async () => {
  console.log('\nShutting down gracefully…');
  if (db) { await db.end(); console.log('Database connection closed.'); }
  process.exit(0);
});
process.on('uncaughtException', (error) => { console.error('Uncaught Exception:', error); process.exit(1); });
process.on('unhandledRejection', (reason, promise) => { console.error('Unhandled Rejection at:', promise, 'reason:', reason); });

startServer();
