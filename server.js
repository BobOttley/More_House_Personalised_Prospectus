/**
 * server.js — Behaviour-first analytics (Option A)
 * Keeps your existing functionality (webhook, prospectus generation,
 * pretty URLs, dashboard feeds), replaces the marketing AI analysis with
 * descriptive section-level behaviour analysis based on tracking events.
 *
 * British spelling used throughout.
 */
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { Client } = require('pg');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

let db = null;

/* -------------------------------------------------------------------------- */
/*                              Database bootstrap                             */
/* -------------------------------------------------------------------------- */

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
  } catch (e) {
    console.warn('Postgres connection failed:', e.message);
    console.warn('Continuing in JSON-only mode.');
    db = null;
    return false;
  }

  // Create/upgrade tables as needed.
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS inquiries (
        id VARCHAR(64) PRIMARY KEY,
        first_name TEXT,
        family_surname TEXT,
        parent_email TEXT,
        age_group TEXT,
        entry_year TEXT,
        sciences BOOLEAN,
        mathematics BOOLEAN,
        english BOOLEAN,
        languages BOOLEAN,
        humanities BOOLEAN,
        business BOOLEAN,
        drama BOOLEAN,
        music BOOLEAN,
        art BOOLEAN,
        creative_writing BOOLEAN,
        sport BOOLEAN,
        leadership BOOLEAN,
        community_service BOOLEAN,
        outdoor_education BOOLEAN,
        academic_excellence BOOLEAN,
        pastoral_care BOOLEAN,
        university_preparation BOOLEAN,
        personal_development BOOLEAN,
        career_guidance BOOLEAN,
        extracurricular_opportunities BOOLEAN,
        received_at TIMESTAMPTZ,
        status TEXT,
        prospectus_generated BOOLEAN DEFAULT FALSE,
        prospectus_filename TEXT,
        prospectus_url TEXT,
        slug TEXT UNIQUE,
        prospectus_generated_at TIMESTAMPTZ,
        user_agent TEXT,
        referrer TEXT,
        ip_address TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS tracking_events (
        id BIGSERIAL PRIMARY KEY,
        inquiry_id VARCHAR(64) NOT NULL,
        session_id VARCHAR(128),
        event_type TEXT NOT NULL,
        current_section TEXT,
        page_url TEXT,
        user_agent TEXT,
        ip_address TEXT,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        event_data JSONB DEFAULT '{}'::jsonb
      );
      CREATE INDEX IF NOT EXISTS idx_tracking_events_inquiry_ts
        ON tracking_events (inquiry_id, timestamp);
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS engagement_metrics (
        id BIGSERIAL PRIMARY KEY,
        inquiry_id VARCHAR(64) NOT NULL,
        session_id VARCHAR(128) NOT NULL,
        prospectus_filename TEXT,
        time_on_page INTEGER DEFAULT 0,
        pages_viewed INTEGER DEFAULT 0,
        scroll_depth INTEGER DEFAULT 0,
        clicks_on_links INTEGER DEFAULT 0,
        total_visits INTEGER DEFAULT 1,
        device_type TEXT,
        browser TEXT,
        operating_system TEXT,
        last_visit TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (inquiry_id, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_engagement_metrics_inquiry
        ON engagement_metrics (inquiry_id, last_visit DESC);
    `);

    // New: section-level rollup for behaviour analysis
    await db.query(`
      CREATE TABLE IF NOT EXISTS section_rollup (
        id BIGSERIAL PRIMARY KEY,
        inquiry_id VARCHAR(64) NOT NULL,
        session_id VARCHAR(128) NOT NULL,
        section_id TEXT NOT NULL,
        time_sec INTEGER DEFAULT 0,
        max_scroll_pct INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        video_watch_sec INTEGER DEFAULT 0,
        views INTEGER DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (inquiry_id, session_id, section_id)
      );
      CREATE INDEX IF NOT EXISTS idx_section_rollup_inquiry
        ON section_rollup (inquiry_id, session_id);
    `);
  } catch (e) {
    console.error('DB bootstrap failed:', e);
  }

  return true;
}

/* -------------------------------------------------------------------------- */
/*                            Utility/helper functions                         */
/* -------------------------------------------------------------------------- */

function getBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
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

function generateFilename(inquiry) {
  const date = new Date().toISOString().split('T')[0];
  const fam = sanitise(inquiry.familySurname, 'Family');
  const first = sanitise(inquiry.firstName, 'Student');
  return `More-House-School-${fam}-Family-${first}-${inquiry.entryYear}-${date}.html`
    .replace(/-+/g,'-');
}

function makeSlug(inquiry) {
  const familyName = (inquiry.familySurname || inquiry.family_surname || 'Family')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const shortId = String(inquiry.id || '').replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase()
                  || Math.random().toString(36).slice(-6);
  return `the-${familyName}-family-${shortId}`;
}

let slugIndex = {};

async function ensureDirectories() {
  await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
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

/* -------------------------------------------------------------------------- */
/*                                Middleware                                   */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*                          Prospectus generation                              */
/* -------------------------------------------------------------------------- */

async function generateProspectus(inquiry) {
  console.log(`Generating prospectus for ${inquiry.firstName} ${inquiry.familySurname}`);
  const templatePath = path.join(__dirname, 'public', 'prospectus_template.html');
  const html = await fs.readFile(templatePath, 'utf8');

  const filename = generateFilename(inquiry);
  const relPath = `/prospectuses/${filename}`;
  const absPath = path.join(__dirname, 'prospectuses', filename);

  const meta = `
<meta name="inquiry-id" content="${inquiry.id}">
<meta name="generated-date" content="${new Date().toISOString()}">
<meta name="student-name" content="${inquiry.firstName} ${inquiry.familySurname}">
<meta name="entry-year" content="${inquiry.entryYear}">
<meta name="age-group" content="${inquiry.ageGroup}">
<meta name="tracking-enabled" content="true">`;

  let out = html.replace('</head>', `${meta}\n</head>`);

  const title = `${inquiry.firstName} ${inquiry.familySurname} - More House School Prospectus ${inquiry.entryYear}`;
  out = out.replace(/<title>.*?<\/title>/, `<title>${title}</title>`);

  const personalizeBoot = `<script>
document.addEventListener('DOMContentLoaded', function(){
  try {
    const userData = ${JSON.stringify(inquiry)};
    if (typeof initializeProspectus === 'function') {
      initializeProspectus(userData);
    }
  } catch (error) { console.error('Failed to initialise prospectus:', error); }
});
</script>`;

  const trackingInject = `<!-- More House Analytics Tracking -->
<script>window.MORE_HOUSE_INQUIRY_ID='${inquiry.id}';</script>
<script src="/tracking.js"></script>`;

  const bodyCloseIndex = out.lastIndexOf('</body>');
  if (bodyCloseIndex === -1) throw new Error('Template missing </body> tag');
  out = out.slice(0, bodyCloseIndex) + personalizeBoot + '\n' + trackingInject + '\n' + out.slice(bodyCloseIndex);

  await fs.writeFile(absPath, out, 'utf8');

  const slug = makeSlug(inquiry);
  const prettyPath = `/${slug}`;
  slugIndex[slug] = relPath;
  await saveSlugIndex();

  return { filename, url: relPath, slug, prettyPath, generatedAt: new Date().toISOString() };
}

async function updateInquiryStatus(inquiryId, pInfo) {
  const files = await fs.readdir(path.join(__dirname, 'data'));
  for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
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
    } catch (e) {
      console.warn('DB update failed (non-fatal):', e.message);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                        Tracking ingest + rollups                            */
/* -------------------------------------------------------------------------- */

async function trackEngagementEvent(ev) {
  if (!db) return null;
  try {
    const q = `
      INSERT INTO tracking_events (
        inquiry_id, session_id, event_type, current_section, page_url,
        user_agent, ip_address, timestamp, event_data
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
    const vals = [
      ev.inquiryId, ev.sessionId || null, ev.eventType, ev.currentSection || null,
      ev.url || null, ev.deviceInfo?.userAgent || null, ev.ip || null,
      new Date(ev.timestamp || Date.now()), JSON.stringify(ev.eventData || {})
    ];
    await db.query(q, vals);
  } catch (e) {
    console.warn('trackEngagementEvent failed:', e.message);
  }
}

async function updateEngagementMetrics(m) {
  if (!db) return null;
  try {
    const q = `
      INSERT INTO engagement_metrics (
        inquiry_id, session_id, prospectus_filename, time_on_page, pages_viewed,
        scroll_depth, clicks_on_links, total_visits, device_type,
        browser, operating_system, last_visit
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (inquiry_id, session_id) DO UPDATE SET
        time_on_page   = GREATEST(engagement_metrics.time_on_page, EXCLUDED.time_on_page),
        scroll_depth   = GREATEST(engagement_metrics.scroll_depth, EXCLUDED.scroll_depth),
        clicks_on_links= GREATEST(engagement_metrics.clicks_on_links, EXCLUDED.clicks_on_links),
        pages_viewed   = engagement_metrics.pages_viewed + 1,
        last_visit     = EXCLUDED.last_visit,
        total_visits   = GREATEST(engagement_metrics.total_visits, EXCLUDED.total_visits),
        device_type    = COALESCE(EXCLUDED.device_type, engagement_metrics.device_type),
        browser        = COALESCE(EXCLUDED.browser, engagement_metrics.browser),
        operating_system = COALESCE(EXCLUDED.operating_system, engagement_metrics.operating_system)
      RETURNING *`;
    const d = m.deviceInfo || {};
    const vals = [
      m.inquiryId, m.sessionId || 'unknown', m.prospectusFilename || null,
      Math.round(m.timeOnPage || 0), m.pageViews || 1,
      Math.round(m.maxScrollDepth || 0), m.clickCount || 0,
      m.totalVisits || 1, d.deviceType || 'unknown',
      d.browser || 'unknown', d.operatingSystem || 'unknown',
      new Date()
    ];
    await db.query(q, vals);
  } catch (e) {
    console.warn('updateEngagementMetrics failed:', e.message);
  }
}

// Section rollup updates
async function updateSectionRollup(inquiryId, sessionId, sectionId, patch) {
  if (!db || !sectionId) return;
  const timeSec = Number.isFinite(patch.timeSec) ? Math.max(0, Math.round(patch.timeSec)) : 0;
  const maxScrollPct = Number.isFinite(patch.maxScrollPct) ? Math.max(0, Math.min(100, Math.round(patch.maxScrollPct))) : 0;
  const clicks = Number.isFinite(patch.clicks) ? Math.max(0, Math.round(patch.clicks)) : 0;
  const videoWatchSec = Number.isFinite(patch.videoWatchSec) ? Math.max(0, Math.round(patch.videoWatchSec)) : 0;
  const views = Number.isFinite(patch.views) ? Math.max(0, Math.round(patch.views)) : 0;

  try {
    await db.query(
      `INSERT INTO section_rollup (inquiry_id, session_id, section_id, time_sec, max_scroll_pct, clicks, video_watch_sec, views)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (inquiry_id, session_id, section_id) DO UPDATE SET
         time_sec = section_rollup.time_sec + EXCLUDED.time_sec,
         max_scroll_pct = GREATEST(section_rollup.max_scroll_pct, EXCLUDED.max_scroll_pct),
         clicks = section_rollup.clicks + EXCLUDED.clicks,
         video_watch_sec = section_rollup.video_watch_sec + EXCLUDED.video_watch_sec,
         views = section_rollup.views + EXCLUDED.views,
         updated_at = NOW()`,
      [inquiryId, sessionId || 'unknown', sectionId, timeSec, maxScrollPct, clicks, videoWatchSec, views]
    );
  } catch (e) {
    console.warn('updateSectionRollup failed:', e.message);
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Routes                                    */
/* -------------------------------------------------------------------------- */

app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
  res.header('Access-Control-Max-Age', '86400');
  res.sendStatus(200);
});

// Webhook / Inquiry intake (unchanged behaviour)
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

    await saveInquiryJson(record);

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
          ) ON CONFLICT (id) DO NOTHING
        `, [
          record.id, record.firstName, record.familySurname, record.parentEmail, record.ageGroup, record.entryYear,
          !!record.sciences, !!record.mathematics, !!record.english, !!record.languages, !!record.humanities, !!record.business,
          !!record.drama, !!record.music, !!record.art, !!record.creative_writing,
          !!record.sport, !!record.leadership, !!record.community_service, !!record.outdoor_education,
          !!record.academic_excellence, !!record.pastoral_care, !!record.university_preparation,
          !!record.personal_development, !!record.career_guidance, !!record.extracurricular_opportunities,
          new Date(record.receivedAt), record.status, record.userAgent, record.referrer, record.ip
        ]);
      } catch (e) { console.warn('DB insert failed (non-fatal):', e.message); }
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
    console.error('WEBHOOK error:', e);
    return res.status(500).json({ success:false, error:e.message });
  }
});

// Manual prospectus (unchanged)
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
      const files = await fs.readdir(path.join(__dirname, 'data')).catch(()=>[]);
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

// Tracking ingest — now also updates section_rollup
app.post('/api/track-engagement', async (req, res) => {
  try {
    const { events = [], sessionInfo } = req.body || {};
    const clientIP = req.ip || req.connection?.remoteAddress;
    const all = events.length ? events : [req.body]; // support single event post

    for (const e of all) {
      const { inquiryId, sessionId, eventType, timestamp, data = {}, url, currentSection } = e;
      if (!inquiryId || !sessionId || !eventType) continue;

      await trackEngagementEvent({
        inquiryId, sessionId, eventType,
        timestamp: timestamp || new Date().toISOString(),
        eventData: data, url, currentSection,
        deviceInfo: data.deviceInfo, ip: clientIP
      });

      // Maintain section rollups deterministically on server
      if (currentSection) {
        if (eventType === 'section_enter') {
          await updateSectionRollup(inquiryId, sessionId, currentSection, { views: 1 });
        } else if (eventType === 'section_scroll') {
          await updateSectionRollup(inquiryId, sessionId, currentSection, { maxScrollPct: Number(data.maxScrollPct) || 0 });
        } else if (eventType === 'section_exit') {
          await updateSectionRollup(inquiryId, sessionId, currentSection, {
            timeSec: Number(data.timeInSectionSec) || 0,
            maxScrollPct: Number(data.maxScrollPct) || 0,
            clicks: Number(data.clicks) || 0,
            videoWatchSec: Number(data.videoWatchSec) || 0,
            views: 1
          });
        } else if (String(eventType).startsWith('youtube_')) {
          // Accumulation for video seconds is already handled on exit by the tracker;
          // nothing to add here except future extensions if needed.
        }
      }
    }

    if (sessionInfo?.inquiryId) {
      await updateEngagementMetrics({
        inquiryId: sessionInfo.inquiryId,
        sessionId: sessionInfo.sessionId,
        timeOnPage: sessionInfo.timeOnPage,
        maxScrollDepth: sessionInfo.maxScrollDepth,
        clickCount: sessionInfo.clickCount,
        deviceInfo: sessionInfo.deviceInfo,
        prospectusFilename: 'unknown',
        totalVisits: sessionInfo.totalVisits || 1
      });
    }

    res.json({ success: true, eventsProcessed: all.length });
  } catch (e) {
    console.error('track-engagement error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Dashboard list data (kept as-is, no salesy AI)
app.get('/api/dashboard-data', async (req, res) => {
  try {
    const base = getBaseUrl(req);
    let inquiries = [];

    if (db) {
      try {
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
          parentEmail: row.parent_email,
          ageGroup: row.age_group,
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
      } catch (dbError) {
        console.warn('Database read failed, falling back to JSON:', dbError.message);
      }
    }

    if (inquiries.length === 0) {
      const files = await fs.readdir(path.join(__dirname, 'data')).catch(() => []);
      for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
        try { 
          const inquiry = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
          inquiries.push(inquiry);
        } catch (e) {
          console.warn(`Failed to read ${f}:`, e.message);
        }
      }
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
    for (const i of inquiries) for (const k of interestKeys) if (i[k]) counts[k]++;

    const topInterests = Object.entries(counts).filter(([,c])=>c>0)
      .sort((a,b)=>b[1]-a[1]).slice(0,10).map(([subject,count])=>({
        subject: subject.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        count
      }));

    const response = {
      summary: { 
        readyForContact, 
        highlyEngaged, 
        newInquiries7d, 
        totalFamilies,
        hotLeads: Math.floor(totalFamilies * 0.1),
        warmLeads: Math.floor(totalFamilies * 0.2),
        coldLeads: Math.floor(totalFamilies * 0.7),
        avgEngagement: 5,
        aiAnalyzed: 0
      },
      topInterests
    };
    
    res.json(response);
  } catch (e) {
    console.error('Dashboard data error:', e);
    res.status(500).json({ error:'Failed to build dashboard data', message:e.message });
  }
});

// Stable feed for admin/analytics (kept; AI fields removed)
app.get('/api/analytics/inquiries', async (req, res) => {
  try {
    const base = getBaseUrl(req);
    let inquiries = [];

    if (db) {
      const result = await db.query(`
        SELECT i.*, 
               em.time_on_page, em.scroll_depth, em.clicks_on_links, 
               em.total_visits, em.last_visit
        FROM inquiries i
        LEFT JOIN engagement_metrics em ON i.id = em.inquiry_id
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
        updated_at: row.prospectus_generated_at || row.received_at,
        status: row.status || (row.prospectus_generated ? 'prospectus_generated' : 'received'),
        prospectus_filename: row.prospectus_filename,
        slug: row.slug,
        prospectus_generated_at: row.prospectus_generated_at,
        prospectus_pretty_path: row.slug ? `/${row.slug}` : null,
        prospectus_pretty_url: row.slug ? `${base}/${row.slug}` : null,
        prospectus_direct_url: row.prospectus_url ? `${base}${row.prospectus_url}` : null,
        engagement: {
          timeOnPage: row.time_on_page || 0,
          scrollDepth: row.scroll_depth || 0,
          clickCount: row.clicks_on_links || 0,
          totalVisits: row.total_visits || 1,
          lastVisit: row.last_visit || row.received_at
        },
        // No AI fields here anymore
      }));
    } else {
      const files = await fs.readdir(path.join(__dirname, 'data')).catch(() => []);
      for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
        const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
        inquiries.push({
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
          prospectus_pretty_path: j.prospectusPrettyPath || (j.slug ? `/${j.slug}` : null),
          prospectus_pretty_url: j.prospectusPrettyPath ? `${base}${j.prospectusPrettyPath}` : null,
          prospectus_direct_url: j.prospectusUrl ? `${base}${j.prospectusUrl}` : null,
          engagement: { timeOnPage: 0, scrollDepth: 0, clickCount: 0, totalVisits: 1, lastVisit: j.receivedAt }
        });
      }
    }

    res.json(inquiries);
  } catch (e) {
    console.error('Analytics inquiries error:', e);
    res.status(500).json({ error: 'Failed to get inquiries' });
  }
});

// NEW: Option A Behaviour analysis endpoint
app.get('/api/analysis/behaviour/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    if (!db) {
      return res.status(503).json({ error: 'Database required for behaviour analysis' });
    }

    // Latest session for this inquiry
    const em = await db.query(
      `SELECT session_id, last_visit FROM engagement_metrics 
       WHERE inquiry_id=$1 ORDER BY last_visit DESC LIMIT 1`, [inquiryId]
    );
    if (!em.rows.length) {
      return res.json({
        inquiryId,
        generatedAt: new Date().toISOString(),
        currentStatus: { online: false, currentSectionId: null, currentSectionLabel: null, elapsedInSectionSec: 0, currentScrollPct: 0, lastEventAt: null },
        sessionSummary: { totalTimeSec: 0, totalVisits: 0, avgScrollPct: 0, totalClicks: 0, videoWatchSec: 0, completionPct: 0 },
        sections: [],
        insights: { topSections: [], lowAttentionSections: [], engagementStyle: "no_activity", dropOff: { occurred: false }, plainEnglishSummary: "No activity recorded yet." },
        intentSignals: [],
        admissionsAdvice: null,
        confidence: 0.2,
        dataHealth: { eventsCount: 0, gapsDetected: false }
      });
    }
    const sessionId = em.rows[0].session_id;

    // Pull events and rollups
    const evs = await db.query(
      `SELECT event_type, current_section, timestamp AS ts, event_data AS data
         FROM tracking_events WHERE inquiry_id=$1 AND session_id=$2
         ORDER BY ts ASC`,
      [inquiryId, sessionId]
    );
    const rolls = await db.query(
      `SELECT section_id, time_sec, max_scroll_pct, clicks, video_watch_sec, views, updated_at
         FROM section_rollup
        WHERE inquiry_id=$1 AND session_id=$2`,
      [inquiryId, sessionId]
    );

    // Determine current section (last enter not followed by exit)
    let currentSection = null;
    const stack = [];
    for (const ev of evs.rows) {
      if (ev.event_type === 'section_enter' && ev.current_section) {
        stack.push(ev.current_section);
        currentSection = ev.current_section;
      }
      if (ev.event_type === 'section_exit' && ev.current_section) {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i] === ev.current_section) { stack.splice(i, 1); break; }
        }
        currentSection = stack.length ? stack[stack.length - 1] : null;
      }
    }

    // elapsed in current section estimate
    let elapsedInSectionSec = 0;
    let currentScrollPct = 0;
    if (currentSection) {
      const lastEnter = evs.rows.filter(e => e.event_type === 'section_enter' && e.current_section === currentSection).pop();
      const lastScroll = evs.rows.filter(e => e.event_type === 'section_scroll' && e.current_section === currentSection).pop();
      const lastExit = evs.rows.filter(e => e.event_type === 'section_exit' && e.current_section === currentSection).pop();
      if (lastEnter && !lastExit) {
        const lastTs = new Date(evs.rows[evs.rows.length - 1].ts).getTime();
        const enterTs = new Date(lastEnter.ts).getTime();
        elapsedInSectionSec = Math.max(0, Math.round((lastTs - enterTs) / 1000));
      }
      currentScrollPct = lastScroll?.data?.maxScrollPct ?? (rolls.rows.find(r => r.section_id === currentSection)?.max_scroll_pct || 0);
    }

    const lastEventAt = evs.rows.length ? new Date(evs.rows[evs.rows.length - 1].ts) : null;
    const online = lastEventAt ? (Date.now() - lastEventAt.getTime()) <= 30000 : false;

    let totalTimeSec = 0, totalClicks = 0, videoWatchSec = 0;
    let sumScroll = 0, scrollCount = 0;
    const sections = rolls.rows.map(r => {
      totalTimeSec += r.time_sec;
      totalClicks += r.clicks;
      videoWatchSec += r.video_watch_sec;
      sumScroll += r.max_scroll_pct; scrollCount += 1;
      return {
        id: r.section_id,
        label: humanise(r.section_id),
        views: r.views,
        timeSec: r.time_sec,
        avgScrollPct: r.max_scroll_pct,
        maxScrollPct: r.max_scroll_pct,
        clicks: r.clicks,
        videoWatchSec: r.video_watch_sec,
        enteredAt: null,
        lastSeenAt: r.updated_at
      };
    });
    const avgScrollPct = scrollCount ? Math.round(sumScroll / scrollCount) : 0;
    const completed = rolls.rows.filter(r => r.max_scroll_pct >= 90).length;
    const completionPct = sections.length ? Math.round((completed / sections.length) * 100) : 0;

    const topSections = sections
      .slice()
      .sort((a,b) => (b.timeSec + b.clicks*5 + b.videoWatchSec) - (a.timeSec + a.clicks*5 + a.videoWatchSec))
      .slice(0, 3).map(s => ({ id: s.id, label: s.label, reason: reasonForTop(s) }));

    const lowAttentionSections = sections
      .filter(s => s.timeSec < 20 && s.maxScrollPct < 40)
      .slice(0, 3)
      .map(s => ({ id: s.id, label: s.label, reason: 'Brief skim' }));

    const engagementStyle = deriveStyle(totalTimeSec, sections);
    const dropOff = detectDropOff(evs.rows);

    const plainEnglishSummary = buildSummary({ totalTimeSec, topSections, lowAttentionSections, dropOff });

    res.json({
      inquiryId,
      generatedAt: new Date().toISOString(),
      currentStatus: {
        online,
        currentSectionId: currentSection,
        currentSectionLabel: currentSection ? humanise(currentSection) : null,
        elapsedInSectionSec,
        currentScrollPct,
        lastEventAt: lastEventAt ? lastEventAt.toISOString() : null
      },
      sessionSummary: {
        totalTimeSec,
        totalVisits: 1,
        avgScrollPct,
        totalClicks,
        videoWatchSec,
        completionPct
      },
      sections,
      insights: { topSections, lowAttentionSections, engagementStyle, dropOff, plainEnglishSummary },
      intentSignals: deriveSignals(sections),
      admissionsAdvice: null,
      confidence: Math.min(0.2 + Math.log10(1 + sections.length), 0.95),
      dataHealth: { eventsCount: evs.rows.length, gapsDetected: false }
    });
  } catch (e) {
    console.error('behaviour analysis failed:', e);
    res.status(500).json({ error: 'analysis failed', message: e.message });
  }
});

/* --------------------------- Behaviour helpers ---------------------------- */

function humanise(sectionId) {
  return (sectionId || 'Section').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function reasonForTop(s) {
  const parts = [];
  if (s.timeSec >= 120) parts.push('sustained dwell');
  if (s.clicks >= 2) parts.push('multiple clicks');
  if (s.videoWatchSec >= 60) parts.push('video watch');
  return parts.length ? parts.join(' + ') : 'high engagement';
}
function deriveStyle(totalTimeSec, sections) {
  if (totalTimeSec < 60) return 'quick skim';
  const deep = sections.filter(s => s.timeSec >= 120 || s.maxScrollPct >= 90).length;
  if (deep >= Math.max(2, Math.ceil(sections.length * 0.3))) return 'focused, selective reading';
  return 'moderate skim';
}
function detectDropOff(evRows) {
  const last = evRows[evRows.length - 1];
  const lastScroll = [...evRows].reverse().find(e => e.event_type === 'section_scroll');
  if (lastScroll && last && (new Date(last.ts).getTime() - new Date(lastScroll.ts).getTime()) > 15000) {
    return { occurred: true, sectionId: lastScroll.current_section, atScrollPct: (lastScroll.data && lastScroll.data.maxScrollPct) || 0 };
  }
  return { occurred: false };
}
function deriveSignals(sections) {
  const signals = [];
  const sports = sections.filter(s => /sport|wellbeing|co.?curricular/i.test(s.id));
  if (sports.some(s => s.timeSec >= 120 || s.videoWatchSec >= 60)) signals.push({ signal: 'co_curricular_interest', strength: 'high' });
  const pastoral = sections.filter(s => /pastoral|wellbeing/i.test(s.id));
  if (pastoral.some(s => s.maxScrollPct >= 80)) signals.push({ signal: 'pastoral_focus', strength: 'medium' });
  const academic = sections.filter(s => /academic|curriculum/i.test(s.id));
  if (academic.every(s => s.maxScrollPct < 40)) signals.push({ signal: 'academic_low_priority', strength: 'low' });
  return signals;
}
function buildSummary({ totalTimeSec, topSections, lowAttentionSections, dropOff }) {
  function fmtSec(s){ const m = Math.floor(s/60), sec = s%60; return m ? `${m}m ${sec}s` : `${sec}s`; }
  const mins = fmtSec(totalTimeSec);
  const top = topSections.map(t => t.label).join(' and ');
  const low = lowAttentionSections.map(t => t.label).join(', ');
  let s = `Spent ${mins} overall`;
  if (top) s += `, mostly in ${top}`;
  if (low) s += `; skimmed ${low}`;
  if (dropOff.occurred) s += `; dropped off in ${humanise(dropOff.sectionId)} at ~${dropOff.atScrollPct}% scroll`;
  return s + '.';
}

/* ------------------------------ Misc routes ------------------------------- */

app.get('/api/inquiries', async (_req, res) => {
  try {
    const files = await fs.readdir(path.join(__dirname, 'data')).catch(()=>[]);
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
          parentEmail: row.parent_email,
          ageGroup: row.age_group,
          entryYear: row.entry_year,
          receivedAt: row.received_at,
          status: row.status,
          slug: row.slug
        };
      }
    }
    const files = await fs.readdir(path.join(__dirname, 'data')).catch(()=>[]);
    for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
      const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
      if ((j.slug || '').toLowerCase() === slug) return j;
    }
  } catch (e) { console.warn('findInquiryBySlug error:', e.message); }
  return null;
}

async function rebuildSlugIndexFromData() {
  let added = 0;
  try {
    const files = await fs.readdir(path.join(__dirname, 'data')).catch(()=>[]);
    const js = files.filter(f => f.startsWith('inquiry-') && f.endsWith('.json'));
    for (const f of js) {
      try {
        const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
        let slug = j.slug;
        if (!slug) {
          slug = makeSlug(j);
          j.slug = slug;
          await fs.writeFile(path.join(__dirname, 'data', f), JSON.stringify(j, null, 2));
        }
        slug = slug.toLowerCase();
        let rel = j.prospectusUrl;
        if (!rel && j.prospectusFilename) rel = `/prospectuses/${j.prospectusFilename}`;
        if (rel && !slugIndex[slug]) { slugIndex[slug] = rel; added++; }
      } catch (e) { console.warn(`Skipped ${f}: ${e.message}`); }
    }
    if (added > 0) await saveSlugIndex();
    console.log(`Slug index rebuilt: +${added}, total=${Object.keys(slugIndex).length}`);
    return added;
  } catch (e) {
    console.error('rebuildSlugIndexFromData error:', e.message);
    return 0;
  }
}

app.get('/prospectuses/:filename', async (req, res) => {
  try {
    const filename = String(req.params.filename || '');
    let abs = path.join(__dirname, 'prospectuses', filename);

    try { await fs.access(abs); return res.sendFile(abs); } catch {}

    const files = await fs.readdir(path.join(__dirname, 'data')).catch(()=>[]);
    for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
      const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
      if (j.prospectusFilename === filename) {
        const p = await generateProspectus(j);
        await updateInquiryStatus(j.id, p);
        abs = path.join(__dirname, 'prospectuses', p.filename);
        return res.sendFile(abs);
      }
    }
    return res.status(404).send('Prospectus file not found');
  } catch (e) {
    console.error('Direct file recover failed:', e);
    return res.status(500).send('Failed to load prospectus file');
  }
});

app.use('/prospectuses', express.static(path.join(__dirname, 'prospectuses')));

const RESERVED = new Set(['api','prospectuses','health','tracking','dashboard','favicon','robots','sitemap','metrics','config','webhook','admin','smart_analytics_dashboard.html']);

app.get('/:slug', async (req, res, next) => {
  const slug = String(req.params.slug || '').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) return next();
  if (RESERVED.has(slug)) return next();

  let rel = slugIndex[slug];
  if (!rel) { await rebuildSlugIndexFromData(); rel = slugIndex[slug]; }

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
        return res.status(500).send('Failed to generate prospectus');
      }
    }
  }

  if (!rel) return res.status(404).send(`<h1>Prospectus Not Found</h1><p>The link /${slug} could not be found.</p>`);

  let abs = path.join(__dirname, rel);
  try {
    await fs.access(abs);
    return res.sendFile(abs);
  } catch {
    const inquiry = await findInquiryBySlug(slug);
    if (inquiry) {
      const p = await generateProspectus(inquiry);
      await updateInquiryStatus(inquiry.id, p);
      slugIndex[slug] = p.url;
      await saveSlugIndex();
      abs = path.join(__dirname, 'prospectuses', p.filename);
      return res.sendFile(abs);
    }
    return res.status(500).send('Failed to load prospectus');
  }
});

app.get('/admin/rebuild-slugs', async (_req, res) => {
  try {
    const added = await rebuildSlugIndexFromData();
    res.json({ success: true, newMappings: added, totalMappings: Object.keys(slugIndex).length, sample: Object.keys(slugIndex).slice(0,10) });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Slug rebuild failed', message: e.message });
  }
});

app.get('/admin/debug-database', async (_req, res) => {
  try {
    if (!db) return res.json({ error: 'Database not connected' });
    const columns = await db.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name IN ('inquiries','tracking_events','engagement_metrics','section_rollup') ORDER BY table_name, column_name`);
    const [{ count }] = (await db.query(`SELECT COUNT(*) as count FROM inquiries`)).rows;
    const [{ count: te }] = (await db.query(`SELECT COUNT(*) as count FROM tracking_events`)).rows;
    const [{ count: em }] = (await db.query(`SELECT COUNT(*) as count FROM engagement_metrics`)).rows;
    const [{ count: sr }] = (await db.query(`SELECT COUNT(*) as count FROM section_rollup`)).rows;
    res.json({ tables: columns.rows, counts: { inquiries: count, tracking_events: te, engagement_metrics: em, section_rollup: sr } });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/config.json', (req, res) => {
  const base = getBaseUrl(req);
  res.json({ baseUrl: base, webhook: `${base}/webhook`, health: `${base}/health` });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: '6.0.0-Behaviour-Only',
    features: {
      analytics: 'enabled',
      tracking: 'enabled',
      dashboard: 'enabled',
      database: db ? 'connected' : 'json-only',
      prettyUrls: true,
      analysis: 'behaviour-only',
      behaviourEndpoint: '/api/analysis/behaviour/:inquiryId'
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
  <p><strong>Version 6.0.0 — Behaviour-first analysis</strong></p>
  <ul>
    <li>Health: <a href="${base}/health">${base}/health</a></li>
    <li>Webhook (POST JSON): <code>${base}/webhook</code></li>
    <li>Dashboard feed: <a href="${base}/api/analytics/inquiries">${base}/api/analytics/inquiries</a></li>
    <li>Behaviour analysis (JSON): <code>GET ${base}/api/analysis/behaviour/:inquiryId</code></li>
    <li>Rebuild slugs: <a href="${base}/admin/rebuild-slugs">${base}/admin/rebuild-slugs</a></li>
  </ul>
  <p>Pretty links: <code>${base}/the-smith-family-abc123</code></p>
</body></html>`);
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found', message: `Route ${req.method} ${req.path} not found` });
});

/* -------------------------------------------------------------------------- */
/*                               Server start-up                               */
/* -------------------------------------------------------------------------- */

async function startServer() {
  console.log('Starting More House School System...');
  const dbConnected = await initializeDatabase();
  await ensureDirectories();
  await loadSlugIndex();
  await rebuildSlugIndexFromData();

  app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 MORE HOUSE SCHOOL — Behaviour-only analytics ready');
    console.log('===============================================');
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`Webhook: http://localhost:${PORT}/webhook`);
    console.log(`Dashboard: http://localhost:${PORT}/dashboard.html`);
    console.log(`Behaviour API: http://localhost:${PORT}/api/analysis/behaviour/:inquiryId`);
    console.log(`Pretty URLs: http://localhost:${PORT}/the-<family>-family-<id>`);
    console.log(`DB: ${dbConnected ? 'Connected' : 'JSON-only'}`);
    console.log('===============================================');
  });
}

process.on('SIGINT', async () => { if (db) await db.end(); process.exit(0); });
process.on('SIGTERM', async () => { if (db) await db.end(); process.exit(0); });

startServer();
