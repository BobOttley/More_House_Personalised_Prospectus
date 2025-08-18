const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

// Load environment variables
require('dotenv').config();
const { Client } = require('pg');

// Base URL for links (Render or local)
function getBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host']  || req.get('host');
  return `${proto}://${host}`;
}

const app = express();
app.set('trust proxy', true); // IMPORTANT for Render/X-Forwarded-* headers
const PORT = process.env.PORT || 3000; // leave as-is; Render injects PORT

// ---- In-memory slug index (loaded from /data/slug-index.json) ----
let slugIndex = {}; // { [slug]: "/prospectuses/file.html" }
async function loadSlugIndex() {
  try {
    const p = path.join('data', 'slug-index.json');
    const txt = await fs.readFile(p, 'utf8');
    slugIndex = JSON.parse(txt);
    console.log(`🔎 Loaded ${Object.keys(slugIndex).length} slug mappings`);
  } catch {
    slugIndex = {};
    console.log('ℹ️ No slug-index.json yet; will create on first prospectus.');
  }
}
async function saveSlugIndex() {
  const p = path.join('data', 'slug-index.json');
  await fs.writeFile(p, JSON.stringify(slugIndex, null, 2));
}

// Database connection
let db = null;

// Initialize database connection
const initializeDatabase = async () => {
  const haveUrl   = !!process.env.DATABASE_URL;
  const haveParts = !!(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);

  // If no credentials, run in JSON-only mode (no DB)
  if (!haveUrl && !haveParts) {
    console.log('📉 No DB credentials present — skipping database connection (JSON-only mode).');
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
      connectionTimeoutMillis: 3000 // fast-fail if DB is unreachable
    });
    await db.connect();
    console.log('✅ Connected to PostgreSQL analytics database');
    return true;
  } catch (error) {
    console.warn('⚠️ PostgreSQL connection failed quickly:', error.message);
    console.warn('📊 Falling back to JSON-only analytics (non-blocking).');
    return false;
  }
};


// **RENDER FIX**: Enhanced CORS for cross-origin requests
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // allow no-origin (native apps)
    if (origin.includes('.onrender.com')) return callback(null, true);
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) return callback(null, true);
    if (origin.includes('.github.io')) return callback(null, true);
    console.log('CORS: Allowing origin:', origin);
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  credentials: false,
  optionsSuccessStatus: 200
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use((req, _res, next) => { console.log('→', req.method, req.url); next(); });

// Serve tracking.js explicitly
app.get('/tracking.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tracking.js'));
});

// Generate unique inquiry ID
const generateInquiryId = () => {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000);
  return `INQ-${timestamp}${random}`;
};

// Generate filename for prospectus (kept on disk)
const generateFilename = (inquiryData) => {
  const date = new Date().toISOString().split('T')[0];
  const safeFamilyName = (inquiryData.familySurname || 'Family').replace(/[^a-zA-Z0-9]/g, '-');
  const safeFirstName = (inquiryData.firstName || 'Student').replace(/[^a-zA-Z0-9]/g, '-');
  return `More-House-School-${safeFamilyName}-Family-${safeFirstName}-${inquiryData.entryYear}-${date}.html`;
};

// Make a pretty slug: "the-smith-family-72a9f3"
function makeSlug(inquiry) {
  const fam = String(inquiry.familySurname || 'Family').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g,'');
  const namePart = `the-${fam}-family`.replace(/-+/g,'-');
  const shortId = String(inquiry.id || '').replace(/[^a-z0-9]/gi,'').slice(-6).toLowerCase() || Math.random().toString(36).slice(-6);
  return `${namePart}-${shortId}`;
}

// Ensure required directories exist
const ensureDirectories = async () => {
  try {
    await fs.mkdir('data', { recursive: true });
    await fs.mkdir('prospectuses', { recursive: true });
    console.log('📁 Directory structure verified');
  } catch (error) {
    console.error('❌ Error creating directories:', error.message);
  }
};

// Save inquiry data to JSON file
const saveInquiryData = async (formData) => {
  try {
    const inquiryId = generateInquiryId();
    const timestamp = new Date().toISOString();
    const filename = `inquiry-${timestamp}.json`;

    const inquiryRecord = {
      id: inquiryId,
      receivedAt: timestamp,
      status: 'received',
      prospectusGenerated: false,
      ...formData
    };

    const filepath = path.join('data', filename);
    await fs.writeFile(filepath, JSON.stringify(inquiryRecord, null, 2));

    console.log(`💾 Inquiry saved: ${filename}`);
    console.log(`📄 Suggested prospectus filename: ${generateFilename(inquiryRecord)}`);

    return inquiryRecord;

  } catch (error) {
    console.error('❌ Error saving inquiry:', error.message);
    throw error;
  }
};

// Save inquiry to analytics database
const saveInquiryToDatabase = async (inquiryData) => {
  if (!db) return null;
  try {
    const query = `
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
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        slug = COALESCE(EXCLUDED.slug, inquiries.slug),
        updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;
    const values = [
      inquiryData.id,
      inquiryData.firstName,
      inquiryData.familySurname,
      inquiryData.parentEmail,
      inquiryData.ageGroup,
      inquiryData.entryYear,

      !!inquiryData.sciences,
      !!inquiryData.mathematics,
      !!inquiryData.english,
      !!inquiryData.languages,
      !!inquiryData.humanities,
      !!inquiryData.business,

      !!inquiryData.drama,
      !!inquiryData.music,
      !!inquiryData.art,
      !!inquiryData.creative_writing,

      !!inquiryData.sport,
      !!inquiryData.leadership,
      !!inquiryData.community_service,
      !!inquiryData.outdoor_education,

      !!inquiryData.academic_excellence,
      !!inquiryData.pastoral_care,
      !!inquiryData.university_preparation,
      !!inquiryData.personal_development,
      !!inquiryData.career_guidance,
      !!inquiryData.extracurricular_opportunities,

      new Date(inquiryData.receivedAt),
      inquiryData.status,
      inquiryData.userAgent,
      inquiryData.referrer,
      inquiryData.ip || null,
      inquiryData.slug || null
    ];
    const result = await db.query(query, values);
    console.log('📊 Inquiry saved to analytics database');
    return result.rows[0];
  } catch (error) {
    console.error('❌ Failed to save inquiry to database:', error.message);
    return null;
  }
};

// Track engagement event
const trackEngagementEvent = async (eventData) => {
  if (!db) return null;
  try {
    const query = `
      INSERT INTO tracking_events (
        inquiry_id, event_type, event_data, page_url, 
        user_agent, ip_address, session_id, timestamp
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *;
    `;
    const values = [
      eventData.inquiryId,
      eventData.eventType,
      JSON.stringify(eventData.eventData || {}),
      eventData.url,
      eventData.deviceInfo?.userAgent || null,
      null,
      eventData.sessionId,
      new Date(eventData.timestamp)
    ];
    const result = await db.query(query, values);
    return result.rows[0];
  } catch (error) {
    console.error('❌ Failed to track event:', error.message);
    return null;
  }
};

// Update engagement metrics
const updateEngagementMetrics = async (metricsData) => {
  if (!db) return null;
  try {
    const query = `
      INSERT INTO engagement_metrics (
        inquiry_id, prospectus_filename, time_on_page, pages_viewed, 
        scroll_depth, clicks_on_links, session_id, device_type, 
        browser, operating_system, last_visit
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (inquiry_id, session_id) DO UPDATE SET
        time_on_page = GREATEST(engagement_metrics.time_on_page, EXCLUDED.time_on_page),
        scroll_depth = GREATEST(engagement_metrics.scroll_depth, EXCLUDED.scroll_depth),
        clicks_on_links = GREATEST(engagement_metrics.clicks_on_links, EXCLUDED.clicks_on_links),
        pages_viewed = engagement_metrics.pages_viewed + 1,
        last_visit = EXCLUDED.last_visit,
        total_visits = engagement_metrics.total_visits + 1
      RETURNING *;
    `;
    const deviceInfo = metricsData.deviceInfo || {};
    const values = [
      metricsData.inquiryId,
      metricsData.prospectusFilename,
      Math.round(metricsData.timeOnPage || 0),
      metricsData.pageViews || 1,
      Math.round(metricsData.maxScrollDepth || 0),
      metricsData.clickCount || 0,
      metricsData.sessionId,
      deviceInfo.deviceType || 'unknown',
      deviceInfo.browser || 'unknown',
      deviceInfo.operatingSystem || 'unknown',
      new Date()
    ];
    const result = await db.query(query, values);
    return result.rows[0];
  } catch (error) {
    console.error('❌ Failed to update engagement metrics:', error.message);
    return null;
  }
};

// 🔥 generateProspectus with personalisation + tracking + slug mapping
const generateProspectus = async (inquiryData) => {
  try {
    console.log(`\n🎨 GENERATING PROSPECTUS FOR: ${inquiryData.firstName} ${inquiryData.familySurname}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Read template
    const templatePath = path.join(__dirname, 'public', 'prospectus_template.html');
    let templateHtml = await fs.readFile(templatePath, 'utf8');

    // Personalised filename (disk)
    const filename = generateFilename(inquiryData);
    const outputPath = path.join(__dirname, 'prospectuses', filename);

    // Inject meta into <head>
    const metaTags = `
<meta name="inquiry-id" content="${inquiryData.id}">
<meta name="generated-date" content="${new Date().toISOString()}">
<meta name="student-name" content="${inquiryData.firstName} ${inquiryData.familySurname}">
<meta name="entry-year" content="${inquiryData.entryYear}">
<meta name="age-group" content="${inquiryData.ageGroup}">
<meta name="tracking-enabled" content="true">`;
    templateHtml = templateHtml.replace('</head>', `${metaTags}\n</head>`);

    // Update title
    const personalizedTitle = `${inquiryData.firstName} ${inquiryData.familySurname} - More House School Prospectus ${inquiryData.entryYear}`;
    templateHtml = templateHtml.replace(/<title>.*?<\/title>/, `<title>${personalizedTitle}</title>`);

    // Personalisation init
    const personalizationScript = `<script>
document.addEventListener('DOMContentLoaded', function() {
  const userData = ${JSON.stringify(inquiryData, null, 2)};
  if (typeof initializeProspectus === 'function') {
    initializeProspectus(userData);
  }
});
</script>`;

    // Tracking injection
    const trackingScriptInjection = `<!-- Tracking -->
<script>window.MORE_HOUSE_INQUIRY_ID='${inquiryData.id}';</script>
<script src="/tracking.js"></script>`;

    // Inject before </body>
    const bodyCloseIndex = templateHtml.lastIndexOf('</body>');
    if (bodyCloseIndex === -1) throw new Error('Template missing </body>');
    const finalHtml = templateHtml.slice(0, bodyCloseIndex) +
                      personalizationScript + '\n' + trackingScriptInjection + '\n' +
                      templateHtml.slice(bodyCloseIndex);

    // Write file
    await fs.writeFile(outputPath, finalHtml, 'utf8');

    // Build slug + map to file
    const slug = makeSlug(inquiryData);
    const relPath = `/prospectuses/${filename}`;
    slugIndex[slug] = relPath;
    await saveSlugIndex();

    console.log(`📁 Prospectus saved: ${filename}`);
    console.log(`🔗 Pretty path: /${slug} → ${relPath}`);

    return {
      filename,
      path: outputPath,
      url: relPath,              // direct file path
      slug,                      // pretty slug
      prettyPath: `/${slug}`,    // pretty URL path
      generatedAt: new Date().toISOString(),
      trackingEnabled: true
    };

  } catch (error) {
    console.error('❌ Error generating prospectus:', error.message);
    throw error;
  }
};

// Update inquiry status after prospectus generation (+ store slug)
const updateInquiryStatus = async (inquiryId, prospectusInfo) => {
  try {
    const files = await fs.readdir('data');
    const inquiryFiles = files.filter(file => file.startsWith('inquiry-') && file.endsWith('.json'));

    for (const file of inquiryFiles) {
      const filepath = path.join('data', file);
      const content = await fs.readFile(filepath, 'utf8');
      const inquiry = JSON.parse(content);

      if (inquiry.id === inquiryId) {
        inquiry.prospectusGenerated = true;
        inquiry.prospectusFilename = prospectusInfo.filename;
        inquiry.prospectusUrl = prospectusInfo.url;
        inquiry.prospectusPrettyPath = prospectusInfo.prettyPath; // "/the-smith-family-72a9f3"
        inquiry.slug = prospectusInfo.slug;
        inquiry.prospectusGeneratedAt = prospectusInfo.generatedAt;
        inquiry.status = 'prospectus_generated';

        await fs.writeFile(filepath, JSON.stringify(inquiry, null, 2));
        console.log(`📝 Updated inquiry record: ${inquiryId}`);

        if (db) {
          try {
            await db.query(`
              UPDATE inquiries 
              SET status='prospectus_generated',
                  prospectus_generated=true,
                  prospectus_filename=$2,
                  prospectus_url=$3,
                  slug=$4,
                  prospectus_generated_at=$5,
                  updated_at=CURRENT_TIMESTAMP
              WHERE id=$1
            `, [inquiryId, prospectusInfo.filename, prospectusInfo.url, prospectusInfo.slug, new Date(prospectusInfo.generatedAt)]);
            console.log('📊 Database updated with prospectus info + slug');
          } catch (dbError) {
            console.warn('⚠️ Failed to update database:', dbError.message);
          }
        }
        return inquiry;
      }
    }
    throw new Error(`Inquiry ${inquiryId} not found`);
  } catch (error) {
    console.error('❌ Error updating inquiry status:', error.message);
    throw error;
  }
};

// **RENDER FIX**: Handle preflight requests explicitly
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
  res.header('Access-Control-Max-Age', '86400');
  res.sendStatus(200);
});

// ✅ Webhook route (also supports /api/inquiry)
app.post(['/webhook', '/api/inquiry'], async (req, res) => {
  console.log('WEBHOOK start', new Date().toISOString());
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  try {
    const data = req.body || {};
    const required = ['firstName','familySurname','parentEmail','ageGroup','entryYear'];
    const missing = required.filter(k => !data[k]);
    if (missing.length) return res.status(400).json({ success:false, error:'Missing required fields', missingFields: missing });

    const rec = await saveInquiryData(data);
    rec.slug = makeSlug(rec); // preassign for DB row
    await saveInquiryToDatabase({
      ...data,
      id: rec.id,
      slug: rec.slug,
      receivedAt: rec.receivedAt,
      status: 'received',
      userAgent: req.headers['user-agent'],
      referrer: req.headers.referer,
      ip: req.ip || req.connection?.remoteAddress
    });

    const prospectus = await generateProspectus(rec);
    await updateInquiryStatus(rec.id, prospectus);

    const base = getBaseUrl(req);
    const prettyUrl = `${base}${prospectus.prettyPath}`;

    console.log('WEBHOOK done', rec.id, prettyUrl);
    return res.json({
      success:true,
      inquiryId: rec.id,
      prospectus:{
        filename: prospectus.filename,
        url: prettyUrl,                  // return pretty URL
        directFile: `${base}${prospectus.url}`, // (debug) direct file if needed
        slug: prospectus.slug,
        generatedAt: prospectus.generatedAt
      },
      receivedAt: rec.receivedAt
    });
  } catch (e) {
    console.error('WEBHOOK error', e);
    return res.status(500).json({ success:false, error:e.message });
  }
});

// Analytics tracking endpoints
app.post('/api/track', async (req, res) => {
  try {
    const { events, engagementMetrics } = req.body;
    const clientIP = req.ip || req.connection?.remoteAddress;

    if (events && events.length > 0) {
      for (const event of events) {
        await trackEngagementEvent({ ...event, ip: clientIP });
      }
    }
    if (engagementMetrics) {
      await updateEngagementMetrics(engagementMetrics);
    }
    res.json({ success: true, message: 'Tracking data recorded', eventsProcessed: events?.length || 0 });
  } catch (error) {
    console.error('❌ Analytics tracking error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to record tracking data' });
  }
});

app.post('/api/track-engagement', async (req, res) => {
  try {
    const { events, sessionInfo } = req.body;
    const eventList = events || [req.body];

    for (const event of eventList) {
      const { inquiryId, sessionId, eventType, timestamp, data = {}, url, currentSection } = event;
      if (!inquiryId || !sessionId || !eventType) continue;

      if (db) {
        await trackEngagementEvent({
          inquiryId,
          sessionId,
          eventType,
          timestamp: timestamp || new Date().toISOString(),
          eventData: data,
          url,
          currentSection,
          deviceInfo: data.deviceInfo
        });
      }
    }

    if (sessionInfo && db && sessionInfo.inquiryId) {
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

    res.json({ success: true, message: `Tracked ${eventList.length} events successfully`, eventsProcessed: eventList.length });
  } catch (error) {
    console.error('❌ Error tracking engagement:', error);
    res.status(500).json({ success: false, error: 'Failed to track engagement', message: error.message });
  }
});

// ---- Dashboard aggregate API ----
// ---- Dashboard aggregate API (DB-first, with JSON fallback) ----
app.get('/api/dashboard-data', async (_req, res) => {
  try {
    // If DB is connected, use it for all aggregates
    if (db) {
      // Summary tiles
      const [{ c: totalFamilies }] =
        (await db.query(`SELECT COUNT(*)::int AS c FROM inquiries`)).rows;

      const [{ c: newInquiries7d }] = (await db.query(`
        SELECT COUNT(*)::int AS c
        FROM inquiries
        WHERE COALESCE(received_at, created_at) >= NOW() - INTERVAL '7 days'
      `)).rows;

      const [{ c: readyForContact }] = (await db.query(`
        SELECT COUNT(*)::int AS c
        FROM inquiries
        WHERE status = 'prospectus_generated' OR prospectus_generated IS TRUE
      `)).rows;

      const [{ c: highlyEngaged }] =
        (await db.query(`SELECT COUNT(*)::int AS c FROM engagement_metrics WHERE time_on_page > 300`)).rows;

      // Top interests (sum boolean columns)
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

      const topInterests = Object.entries(interestRow)
        .map(([subject, count]) => ({ subject, count: Number(count || 0) }))
        .filter(({ count }) => count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      // Recently active (exclude heartbeats, join to inquiries)
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

      // Priority families (highest engagement)
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
        timeOnPage: Number(r.time_on_page || 0),
        totalVisits: Number(r.total_visits || 0),
        lastVisit: r.last_visit
      }));

      return res.json({
        summary: { readyForContact, highlyEngaged, newInquiries7d, totalFamilies },
        topInterests, recentlyActive, priorityFamilies
      });
    }

    // ------- Fallback: JSON files (no DB) -------
    const files = await fs.readdir('data').catch(err => (err.code === 'ENOENT' ? [] : Promise.reject(err)));
    const inquiries = [];
    for (const f of files.filter(f => f.startsWith('inquiry-') && f.endsWith('.json'))) {
      try { inquiries.push(JSON.parse(await fs.readFile(path.join('data', f), 'utf8'))); } catch {}
    }

    const now = Date.now();
    const totalFamilies = inquiries.length;
    const newInquiries7d = inquiries.filter(i => {
      const t = Date.parse(i.receivedAt || i.received_at || 0);
      return t && (now - t) <= 7 * 24 * 60 * 60 * 1000;
    }).length;
    const readyForContact = inquiries.filter(i => i.prospectusGenerated || i.status === 'prospectus_generated').length;

    const interestKeys = [
      'sciences','mathematics','english','languages','humanities','business',
      'drama','music','art','creative_writing','sport','leadership','community_service','outdoor_education',
      'academic_excellence','pastoral_care','university_preparation','personal_development','career_guidance','extracurricular_opportunities'
    ];
    const interestCounts = Object.fromEntries(interestKeys.map(k => [k, 0]));
    for (const i of inquiries) for (const k of interestKeys) if (i[k]) interestCounts[k]++;
    const topInterests = Object.entries(interestCounts).filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([subject, count]) => ({ subject, count }));

    res.json({
      summary: { readyForContact, highlyEngaged: 0, newInquiries7d, totalFamilies },
      topInterests,
      recentlyActive: [],       // not available without DB
      priorityFamilies: []      // not available without DB
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to build dashboard data', message: e.message });
  }
});

// 🔥 Dashboard inquiries
app.get('/api/analytics/inquiries', async (_req, res) => {
  try {
    const files = await fs.readdir('data');
    const inquiryFiles = files.filter(file => file.startsWith('inquiry-') && file.endsWith('.json'));

    const inquiries = [];
    for (const file of inquiryFiles) {
      try {
        const content = await fs.readFile(path.join('data', file), 'utf8');
        const inquiry = JSON.parse(content);
        const dashboardInquiry = {
          id: inquiry.id,
          first_name: inquiry.firstName,
          family_surname: inquiry.familySurname,
          parent_email: inquiry.parentEmail,
          entry_year: inquiry.entryYear,
          age_group: inquiry.ageGroup,
          received_at: inquiry.receivedAt,
          updated_at: inquiry.prospectusGeneratedAt || inquiry.receivedAt,
          status: inquiry.status || (inquiry.prospectusGenerated ? 'prospectus_generated' : 'received'),
          engagement: null
        };
        if (db) {
          try {
            const result = await db.query(`
              SELECT time_on_page, scroll_depth, clicks_on_links, total_visits, last_visit
              FROM engagement_metrics 
              WHERE inquiry_id = $1
              ORDER BY last_visit DESC
              LIMIT 1
            `, [inquiry.id]);
            if (result.rows.length > 0) {
              const em = result.rows[0];
              dashboardInquiry.engagement = {
                timeOnPage: em.time_on_page || 0,
                scrollDepth: em.scroll_depth || 0,
                clickCount: em.clicks_on_links || 0,
                totalVisits: em.total_visits || 0,
                lastVisit: em.last_visit
              };
            }
          } catch {}
        }
        inquiries.push(dashboardInquiry);
      } catch {}
    }
    inquiries.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
    res.json(inquiries);
  } catch (error) {
    console.error('❌ Failed to get inquiries for dashboard:', error.message);
    res.status(500).json({ error: 'Failed to get inquiries data' });
  }
});

// Serve prospectus files (direct path)
app.use('/prospectuses', express.static(path.join(__dirname, 'prospectuses')));

// API endpoint to generate prospectus for existing inquiry (returns pretty URL)
app.post('/api/generate-prospectus/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    console.log(`\n📄 MANUAL PROSPECTUS GENERATION REQUEST: ${inquiryId}`);

    // Find the inquiry
    const files = await fs.readdir('data');
    const inquiryFiles = files.filter(file => file.startsWith('inquiry-') && file.endsWith('.json'));
    let inquiryData = null;
    for (const file of inquiryFiles) {
      const content = await fs.readFile(path.join('data', file), 'utf8');
      const inquiry = JSON.parse(content);
      if (inquiry.id === inquiryId) { inquiryData = inquiry; break; }
    }
    if (!inquiryData) return res.status(404).json({ success: false, error: 'Inquiry not found' });

    // Generate the prospectus
    const prospectusInfo = await generateProspectus(inquiryData);
    await updateInquiryStatus(inquiryId, prospectusInfo);

    const base = getBaseUrl(req);
    res.json({
      success: true,
      message: 'Prospectus generated successfully',
      inquiryId,
      prospectus: {
        filename: prospectusInfo.filename,
        url: `${base}${prospectusInfo.prettyPath}`,     // pretty URL
        directFile: `${base}${prospectusInfo.url}`,     // direct file (debug)
        slug: prospectusInfo.slug,
        generatedAt: prospectusInfo.generatedAt
      }
    });
  } catch (error) {
    console.error('❌ Error generating prospectus:', error.message);
    res.status(500).json({ success: false, error: 'Failed to generate prospectus', message: error.message });
  }
});

// Get all inquiries
app.get('/api/inquiries', async (_req, res) => {
  try {
    const files = await fs.readdir('data');
    const inquiryFiles = files.filter(file => file.startsWith('inquiry-') && file.endsWith('.json'));
    const inquiries = [];
    for (const file of inquiryFiles) {
      const content = await fs.readFile(path.join('data', file), 'utf8');
      inquiries.push(JSON.parse(content));
    }
    inquiries.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    res.json({ success: true, count: inquiries.length, inquiries });
  } catch (error) {
    console.error('❌ Error listing inquiries:', error.message);
    res.status(500).json({ success: false, error: 'Failed to list inquiries', message: error.message });
  }
});

// Get specific inquiry
app.get('/api/inquiries/:id', async (req, res) => {
  try {
    const inquiryId = req.params.id;
    const files = await fs.readdir('data');
    const inquiryFiles = files.filter(file => file.startsWith('inquiry-') && file.endsWith('.json'));
    for (const file of inquiryFiles) {
      const content = await fs.readFile(path.join('data', file), 'utf8');
      const inquiry = JSON.parse(content);
      if (inquiry.id === inquiryId) return res.json({ success: true, inquiry });
    }
    res.status(404).json({ success: false, error: 'Inquiry not found' });
  } catch (error) {
    console.error('❌ Error retrieving inquiry:', error.message);
    res.status(500).json({ success: false, error: 'Failed to retrieve inquiry', message: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: '3.1.0',
    features: {
      analytics: 'enabled',
      tracking: 'enabled', 
      dashboard: 'enabled',
      database: db ? 'connected' : 'json-only',
      prettyUrls: true
    }
  });
});

// ---- New discoverability endpoints ----
app.get('/config.json', (req, res) => {
  const base = getBaseUrl(req);
  res.json({ baseUrl: base, webhook: `${base}/webhook`, health: `${base}/health` });
});

app.get('/webhook', (_req, res) => {
  res.status(405).json({
    success: false,
    error: 'Method not allowed',
    message: 'Send a POST with JSON to this endpoint.'
  });
});

app.get('/', (req, res) => {
  const base = getBaseUrl(req);
  res.type('html').send(`
<!doctype html>
<html><head><meta charset="utf-8"><title>More House Prospectus Service</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:24px;max-width:780px;margin:auto;line-height:1.55}</style>
</head><body>
  <h1>More House Prospectus Service</h1>
  <p>Service is running. Useful endpoints:</p>
  <ul>
    <li>Health: <a href="${base}/health">${base}/health</a></li>
    <li>Webhook (POST JSON): <code>${base}/webhook</code></li>
    <li>Inquiries: <a href="${base}/api/inquiries">${base}/api/inquiries</a></li>
    <li>Dashboard data: <a href="${base}/api/dashboard-data">${base}/api/dashboard-data</a></li>
  </ul>
  <p>Pretty links (slugs) will look like: <code>${base}/the-smith-family-abc123</code></p>
</body></html>`);
});

// ---- Pretty URL resolver (must be after other routes, before 404) ----
const RESERVED = new Set(['api','prospectuses','health','tracking','dashboard','favicon','robots','sitemap','metrics','config','webhook']);
app.get('/:slug', async (req, res, next) => {
  const slug = String(req.params.slug || '').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) return next();
  if (RESERVED.has(slug)) return next();

  const rel = slugIndex[slug];
  if (!rel) return res.status(404).send('Prospectus link not found');
  const abs = path.join(__dirname, rel);
  try {
    return res.sendFile(abs);
  } catch (e) {
    console.error('❌ Failed to serve slug', slug, e.message);
    return res.status(500).send('Failed to load prospectus');
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found', message: `Route ${req.method} ${req.path} not found` });
});

// Start server
const startServer = async () => {
  try {
    const dbConnected = await initializeDatabase();
    await ensureDirectories();
    await loadSlugIndex();

    // **RENDER FIX**: Bind to 0.0.0.0 for Render deployment
    app.listen(PORT, '0.0.0.0', () => {
      console.log('\n🚀 MORE HOUSE WEBHOOK SERVER STARTED - PRETTY URLS ENABLED');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`🌐 Server running on: 0.0.0.0:${PORT}`);
      console.log(`📋 Webhook endpoint: /webhook`);
      console.log(`🔗 Pretty URL pattern: /the-<family>-family-<shortid>`);
      console.log(`📊 Health: /health`);
      console.log(`📝 List inquiries: /api/inquiries`);
      console.log(`🎨 Prospectus files: /prospectuses/`);
      console.log(`📈 Dashboard aggregate: /api/dashboard-data`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`📊 Analytics database: ${dbConnected ? 'Connected' : 'JSON files only'}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGINT', async () => { if (db) await db.end(); process.exit(0); });
process.on('SIGTERM', async () => { if (db) await db.end(); process.exit(0); });

// Start
startServer();

// Export (optional)
module.exports = {
  generateProspectus,
  updateInquiryStatus,
  generateFilename,
  saveInquiryToDatabase,
  trackEngagementEvent,
  updateEngagementMetrics
};
