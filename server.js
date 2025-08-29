// server.js — More House Personalised Prospectus
// ✅ Uses DATABASE_URL with SSL
// ✅ Keeps original endpoints + shapes for the dashboard
// ✅ Adds missing routes (video-metrics, section-data, AI analysis)
// ✅ Injects Option B tracking config into generated prospectuses
// ✅ Fixes async bug in updateInquiryStatus (no await in Array.find predicate)
// ✅ British spelling

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { Client } = require('pg');

// =============== OpenAI (optional but enabled if key present) ===============
let openai = null;
try {
  const { OpenAI } = require('openai');
  if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log('🤖 OpenAI: enabled');
  } else {
    console.log('🤖 OpenAI: no API key — AI endpoints will return graceful fallbacks');
  }
} catch {
  console.log('🤖 OpenAI SDK not installed — run: npm i openai (AI will fallback meanwhile)');
}

const app = express();
const PORT = process.env.PORT || 10000;

// =============== DB ===============
let db = null;
async function initializeDatabase() {
  try {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
    db = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { require: true, rejectUnauthorized: false }
    });
    await db.connect();
    console.log('✅ PostgreSQL connected');
    return true;
  } catch (err) {
    console.warn('⚠️ DB unavailable:', err.message);
    db = null;
    return false;
  }
}

// =============== App setup ===============
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));                        // serve /public/*
app.use('/prospectuses', express.static('prospectuses')); // serve generated files
app.get('/tracking.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tracking.js')));

// =============== Utils ===============
function generateInquiryId() {
  const ts = Date.now();
  const r = Math.floor(Math.random() * 1000);
  return `INQ-${ts}${r}`;
}
function generateFilename(inquiry) {
  const date = new Date().toISOString().split('T')[0];
  const safeSurname = (inquiry.familySurname || '').replace(/[^a-zA-Z0-9]/g, '-');
  const safeFirst = (inquiry.firstName || '').replace(/[^a-zA-Z0-9]/g, '-');
  return `More-House-School-${safeSurname}-Family-${safeFirst}-${inquiry.entryYear}-${date}.html`;
}
async function ensureDirectories() {
  await fs.mkdir('data', { recursive: true });
  await fs.mkdir('prospectuses', { recursive: true });
}

async function saveInquiryData(formData) {
  const id = generateInquiryId();
  const receivedAt = new Date().toISOString();
  const record = { id, receivedAt, status: 'received', prospectusGenerated: false, ...formData };
  const file = `inquiry-${receivedAt}.json`;
  await fs.writeFile(path.join('data', file), JSON.stringify(record, null, 2));
  return record;
}

async function saveInquiryToDatabase(inquiry) {
  if (!db) return null;
  try {
    const q = `
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
      ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = CURRENT_TIMESTAMP
    `;
    const v = [
      inquiry.id,
      inquiry.firstName, inquiry.familySurname, inquiry.parentEmail,
      inquiry.ageGroup, inquiry.entryYear,
      !!inquiry.sciences, !!inquiry.mathematics, !!inquiry.english,
      !!inquiry.languages, !!inquiry.humanities, !!inquiry.business,
      !!inquiry.drama, !!inquiry.music, !!inquiry.art, !!inquiry.creative_writing,
      !!inquiry.sport, !!inquiry.leadership, !!inquiry.community_service, !!inquiry.outdoor_education,
      !!inquiry.academic_excellence, !!inquiry.pastoral_care, !!inquiry.university_preparation,
      !!inquiry.personal_development, !!inquiry.career_guidance, !!inquiry.extracurricular_opportunities,
      new Date(inquiry.receivedAt), inquiry.status,
      inquiry.userAgent || null, inquiry.referrer || null, inquiry.ip || null
    ];
    await db.query(q, v);
    return true;
  } catch (e) {
    console.warn('DB insert inquiry failed:', e.message);
    return false;
  }
}

async function trackEngagementEvent(eventData) {
  if (!db) return null;
  try {
    const q = `
      INSERT INTO tracking_events (
        inquiry_id, session_id, event_type, timestamp, page_url,
        user_agent, ip_address, event_data
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `;
    const v = [
      eventData.inquiryId,
      eventData.sessionId,
      eventData.eventType,
      eventData.timestamp ? new Date(eventData.timestamp) : new Date(),
      eventData.url || null,
      eventData.deviceInfo?.userAgent || null,
      eventData.ip || null,
      JSON.stringify(eventData.eventData || eventData.data || {})
    ];
    await db.query(q, v);
    return true;
  } catch (e) {
    console.warn('DB track event failed:', e.message);
    return false;
  }
}

async function updateEngagementMetrics(metrics) {
  if (!db) return null;
  try {
    const q = `
      INSERT INTO engagement_metrics (
        inquiry_id, session_id, time_on_page, scroll_depth, clicks_on_links,
        prospectus_filename, device_type, browser, operating_system, last_visit, total_visits
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)
      ON CONFLICT (inquiry_id, session_id) DO UPDATE SET
        time_on_page = GREATEST(engagement_metrics.time_on_page, EXCLUDED.time_on_page),
        scroll_depth = GREATEST(engagement_metrics.scroll_depth, EXCLUDED.scroll_depth),
        clicks_on_links = GREATEST(engagement_metrics.clicks_on_links, EXCLUDED.clicks_on_links),
        last_visit = EXCLUDED.last_visit,
        total_visits = engagement_metrics.total_visits + 1
    `;
    const v = [
      metrics.inquiryId,
      metrics.sessionId || 'unknown',
      Math.round(metrics.timeOnPage || 0),
      Math.round(metrics.maxScrollDepth || 0),
      Math.round(metrics.clickCount || 0),
      metrics.prospectusFilename || null,
      metrics.deviceInfo?.deviceType || 'unknown',
      metrics.deviceInfo?.browser || 'unknown',
      metrics.deviceInfo?.operatingSystem || 'unknown',
      new Date()
    ];
    await db.query(q, v);
    return true;
  } catch (e) {
    console.warn('DB metrics failed:', e.message);
    return false;
  }
}

// =============== Prospectus generation (Option B injection) ===============
async function generateProspectus(inquiry) {
  const templatePath = path.join(__dirname, 'public', 'prospectus_template.html');
  let html = await fs.readFile(templatePath, 'utf8');

  const meta = `
    <meta name="inquiry-id" content="${inquiry.id}">
    <meta name="generated-date" content="${new Date().toISOString()}">
    <meta name="student-name" content="${inquiry.firstName} ${inquiry.familySurname}">
    <meta name="entry-year" content="${inquiry.entryYear}">
    <meta name="age-group" content="${inquiry.ageGroup}">
  `;
  html = html.replace('</head>', `${meta}\n</head>`);

  const personalisedTitle = `${inquiry.firstName} ${inquiry.familySurname} – More House School Prospectus ${inquiry.entryYear}`;
  html = html.replace(/<title>.*<\/title>/, `<title>${personalisedTitle}</title>`);

  const personalisationScript = `
<script>
document.addEventListener('DOMContentLoaded', function() {
  const userData = ${JSON.stringify(inquiry, null, 2)};
  if (typeof initializeProspectus === 'function') {
    initializeProspectus(userData);
  } else {
    console.error('initializeProspectus missing');
  }
});
</script>`;

  const trackingConfigScript = `
<!-- SMART Prospectus Tracking Config (Option B) -->
<script>
  window.PROSPECTUS_ID = '${inquiry.id}';
  window.TRACK_ENDPOINT = '/api/track-engagement';
  window.PROSPECTUS_SECTIONS = [
    { id: "cover",             selector: ".cover-page, .cover, #cover" },
    { id: "heads_welcome",     selector: ".heads-welcome, #headsWelcome, .welcome" },
    { id: "academic",          selector: "#academic, .section-academic, .academic" },
    { id: "creative",          selector: "#creative, .section-creative, .creative" },
    { id: "london_curriculum", selector: "#londonHero, .london-curriculum, .city-curriculum" },
    { id: "video_showcase",    selector: ".video-hero, #videoShowcase, .hero-video" },
    { id: "discovery_videos",  selector: "#discoveryVideos, .discovery-videos" },
    { id: "pastoral",          selector: "#pastoral, .section-pastoral, .pastoral" },
    { id: "sport_wellbeing",   selector: "#sport, .section-sport, .wellbeing" },
    { id: "enquire_cta",       selector: ".enquire-cta, a[data-track='enquire']" }
  ];
  console.log('🔊 Tracking configured for', window.PROSPECTUS_ID);
</script>
<script src="/tracking.js" defer></script>`;

  const finalHtml = html.replace('</body>', `${personalisationScript}\n${trackingConfigScript}\n</body>`);
  const filename = generateFilename(inquiry);
  const outPath = path.join(__dirname, 'prospectuses', filename);
  await fs.writeFile(outPath, finalHtml, 'utf8');

  return { filename, path: outPath, url: `/prospectuses/${filename}`, generatedAt: new Date().toISOString() };
}

// NOTE: fixed — no async in Array.find predicate
async function updateInquiryStatus(inquiryId, prospectusInfo) {
  try {
    const files = await fs.readdir('data');
    let updated = null;

    for (const file of files) {
      if (!file.startsWith('inquiry-') || !file.endsWith('.json')) continue;
      const fp = path.join('data', file);
      const content = await fs.readFile(fp, 'utf8');
      let inquiry;
      try { inquiry = JSON.parse(content); } catch { continue; }

      if (inquiry.id === inquiryId) {
        inquiry.prospectusGenerated = true;
        inquiry.prospectusFilename = prospectusInfo.filename;
        inquiry.prospectusUrl = prospectusInfo.url;
        inquiry.prospectusGeneratedAt = prospectusInfo.generatedAt;
        inquiry.status = 'prospectus_generated';
        await fs.writeFile(fp, JSON.stringify(inquiry, null, 2));
        updated = inquiry;
        break;
      }
    }

    if (!updated) throw new Error(`Inquiry ${inquiryId} not found`);

    if (db) {
      try {
        await db.query(
          `UPDATE inquiries 
             SET status='prospectus_generated',
                 prospectus_generated=true,
                 prospectus_filename=$2,
                 prospectus_url=$3,
                 prospectus_generated_at=$4,
                 updated_at=CURRENT_TIMESTAMP
           WHERE id=$1`,
          [inquiryId, prospectusInfo.filename, prospectusInfo.url, new Date(prospectusInfo.generatedAt)]
        );
      } catch (e) { console.warn('⚠️ Failed to update database:', e.message); }
    }

    return updated;
  } catch (error) {
    console.error('❌ Error updating inquiry status:', error.message);
    throw error;
  }
}

// =============== Webhook (create inquiry + generate prospectus) ===============
app.post('/webhook', async (req, res) => {
  try {
    const form = req.body || {};
    const required = ['firstName', 'familySurname', 'parentEmail', 'ageGroup', 'entryYear'];
    const missing = required.filter(k => !form[k]);
    if (missing.length) return res.status(400).json({ success: false, error: 'Missing fields', missing });

    const inquiry = await saveInquiryData({
      ...form,
      userAgent: req.headers['user-agent'],
      referrer: req.headers.referer,
      ip: req.ip || req.connection?.remoteAddress
    });

    await saveInquiryToDatabase({
      ...form,
      id: inquiry.id,
      receivedAt: inquiry.receivedAt,
      status: 'received',
      userAgent: req.headers['user-agent'],
      referrer: req.headers.referer,
      ip: req.ip || req.connection?.remoteAddress
    });

    const prospectus = await generateProspectus(inquiry);
    await updateInquiryStatus(inquiry.id, prospectus);

    res.json({
      success: true,
      inquiryId: inquiry.id,
      prospectus: {
        filename: prospectus.filename,
        url: `http://localhost:${PORT}${prospectus.url}`,
        generatedAt: prospectus.generatedAt
      }
    });
  } catch (e) {
    console.error('WEBHOOK error:', e);
    res.status(500).json({ success: false, error: 'Internal error', message: e.message });
  }
});

// =============== Tracking endpoints ===============
// Legacy (kept)
app.post('/api/track', async (req, res) => {
  try {
    const { events, engagementMetrics } = req.body || {};
    const ip = req.ip || req.connection?.remoteAddress;

    if (Array.isArray(events)) {
      for (const ev of events) await trackEngagementEvent({ ...ev, ip });
    }
    if (engagementMetrics) await updateEngagementMetrics(engagementMetrics);

    res.json({ success: true, eventsProcessed: events?.length || 0 });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to record tracking' });
  }
});

// New simplified (used by tracking.js)
app.post('/api/track-engagement', async (req, res) => {
  try {
    const ip = req.ip || req.connection?.remoteAddress;
    const payload = req.body || {};
    const list = Array.isArray(payload.events) ? payload.events : [payload];

    for (const ev of list) {
      if (!ev || !ev.inquiryId || !ev.sessionId || !ev.eventType) continue;
      await trackEngagementEvent({
        inquiryId: ev.inquiryId,
        sessionId: ev.sessionId,
        eventType: ev.eventType,
        timestamp: ev.timestamp,
        url: ev.url,
        eventData: ev.data || ev.eventData || {},
        deviceInfo: ev.deviceInfo,
        ip
      });
    }

    if (payload.sessionInfo && payload.sessionInfo.inquiryId) {
      await updateEngagementMetrics({
        inquiryId: payload.sessionInfo.inquiryId,
        sessionId: payload.sessionInfo.sessionId,
        timeOnPage: payload.sessionInfo.timeOnPage,
        maxScrollDepth: payload.sessionInfo.maxScrollDepth,
        clickCount: payload.sessionInfo.clickCount,
        deviceInfo: payload.sessionInfo.deviceInfo,
        prospectusFilename: payload.sessionInfo.prospectusFilename
      });
    }

    res.json({ success: true, eventsProcessed: list.length });
  } catch (e) {
    console.error('track-engagement error:', e.message);
    res.status(500).json({ success: false, error: 'track-engagement failed' });
  }
});

// =============== Dashboard analytics (original shape kept) ===============
app.get('/api/analytics/stats', async (req, res) => {
  if (!db) {
    return res.json({ totalInquiries: 0, activeEngagements: 0, avgEngagementTime: 0, highInterest: 0 });
  }
  try {
    const q = `
      SELECT 
        COUNT(*) AS total_inquiries,
        COUNT(CASE WHEN status='prospectus_generated' THEN 1 END) AS prospectus_generated,
        AVG(NULLIF(em.time_on_page,0)) AS avg_engagement_time,
        COUNT(CASE WHEN em.time_on_page > 300 THEN 1 END) AS high_interest
      FROM inquiries i
      LEFT JOIN engagement_metrics em ON i.id = em.inquiry_id
    `;
    const r = await db.query(q);
    const row = r.rows[0] || {};
    res.json({
      totalInquiries: Number(row.total_inquiries || 0),
      activeEngagements: Number(row.prospectus_generated || 0),
      avgEngagementTime: (Number(row.avg_engagement_time || 0) / 60),
      highInterest: Number(row.high_interest || 0)
    });
  } catch {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

app.get('/api/analytics/inquiries', async (req, res) => {
  if (!db) return res.json([]);
  try {
    const q = `
      SELECT i.*,
             COALESCE(em.time_on_page,0) AS time_on_page,
             COALESCE(em.scroll_depth,0) AS scroll_depth,
             COALESCE(em.clicks_on_links,0) AS click_count,
             COALESCE(em.total_visits,0) AS total_visits,
             em.last_visit
      FROM inquiries i
      LEFT JOIN LATERAL (
        SELECT * FROM engagement_metrics em
        WHERE em.inquiry_id = i.id
        ORDER BY last_visit DESC NULLS LAST
        LIMIT 1
      ) em ON true
      ORDER BY i.received_at DESC
      LIMIT 50
    `;
    const r = await db.query(q);
    const out = r.rows.map(row => ({
      ...row,
      engagement: row.time_on_page ? {
        timeOnPage: Number(row.time_on_page),
        scrollDepth: Number(row.scroll_depth),
        clickCount: Number(row.click_count),
        totalVisits: Number(row.total_visits)
      } : null
    }));
    res.json(out);
  } catch {
    res.status(500).json({ error: 'Failed to get inquiries' });
  }
});

app.get('/api/analytics/activity', async (req, res) => {
  if (!db) return res.json([]);
  try {
    const q = `
      SELECT 
        te.*,
        i.first_name,
        i.family_surname
      FROM tracking_events te
      LEFT JOIN inquiries i ON te.inquiry_id = i.id
      ORDER BY te.timestamp DESC
      LIMIT 20
    `;
    const { rows } = await db.query(q);
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Failed to get activity' });
  }
});

// =============== Extra dashboard routes that were missing ===============
app.get('/api/analytics/video-metrics', async (req, res) => {
  if (!db) return res.json([]);
  try {
    const q = `
      SELECT 
        inquiry_id AS family_id,
        (event_data->>'video_id') AS video_id,
        COALESCE(event_data->>'title','') AS title,
        SUM(((event_data->>'duration_ms')::bigint)) AS total_ms,
        COUNT(*) FILTER (WHERE (event_data->>'reason') = 'back_to_prospectus') AS back_closes
      FROM tracking_events
      WHERE event_type = 'video_close'
      GROUP BY inquiry_id, (event_data->>'video_id'), COALESCE(event_data->>'title','')
      ORDER BY family_id, video_id
    `;
    const { rows } = await db.query(q);
    const out = rows.map(r => ({
      family_id: r.family_id,
      video_id: r.video_id || 'unknown',
      title: r.title || 'Video',
      totalWatchTime: Math.round((Number(r.total_ms) || 0) / 1000),
      completionRate: null,
      pauseCount: 0,
      replayCount: 0
    }));
    res.json(out);
  } catch {
    res.status(500).json({ error: 'Failed to load video metrics' });
  }
});

app.get('/api/section-data/:inquiryId', async (req, res) => {
  const { inquiryId } = req.params;
  if (!db) return res.json({ hasData: false, totalDwellMs: 0, visitCount: 0, engagementScore: 0, sections: [] });
  try {
    const q = `
      WITH secs AS (
        SELECT
          inquiry_id,
          session_id,
          (event_data->>'section_id') AS section_id,
          COALESCE((event_data->>'duration_ms')::bigint,0) AS dur_ms,
          COALESCE((event_data->>'max_scroll_pct')::int,0) AS max_scroll
        FROM tracking_events
        WHERE inquiry_id = $1 AND event_type = 'section_time'
      )
      SELECT section_id,
             SUM(dur_ms) AS total_ms,
             MAX(max_scroll) AS max_scroll_pct,
             COUNT(DISTINCT session_id) AS sessions
      FROM secs
      GROUP BY section_id
      ORDER BY total_ms DESC
    `;
    const { rows } = await db.query(q, [inquiryId]);
    const totalDwellMs = rows.reduce((s, r) => s + Number(r.total_ms || 0), 0);
    const visits = Number((await db.query(
      `SELECT COUNT(DISTINCT session_id) AS visits FROM tracking_events WHERE inquiry_id=$1`, [inquiryId]
    )).rows?.[0]?.visits || 0);

    const dwellMin = totalDwellMs / 60000;
    const dwellScore = Math.min(60, Math.round(dwellMin * 4));
    const breadthScore = Math.min(20, rows.length * 4);
    const visitScore = Math.min(20, visits * 5);
    const engagementScore = Math.min(100, dwellScore + breadthScore + visitScore);

    res.json({
      hasData: rows.length > 0,
      totalDwellMs,
      visitCount: visits,
      engagementScore,
      sections: rows.map(r => ({
        section_id: r.section_id,
        section_name: (r.section_id || 'section').replace(/_/g, ' '),
        dwell_seconds: Math.round(Number(r.total_ms || 0) / 1000),
        dwell_minutes: Math.round(Number(r.total_ms || 0) / 60000),
        max_scroll_pct: Number(r.max_scroll_pct || 0),
        clicks: 0
      }))
    });
  } catch {
    res.status(500).json({ error: 'Failed to load section data' });
  }
});

// =============== Basic dashboard data (kept) ===============
app.get('/api/dashboard-data', async (req, res) => {
  try {
    const dashboardData = {
      metrics: { readyForContact: 1, highlyEngaged: 2, newInquiries: 3, totalFamilies: 5 },
      priorityFamilies: [],
      recentlyActive: [],
      analytics: {
        totalInquiries: 8,
        thisWeekInquiries: 3,
        conversionRate: 23.5,
        averageEngagementScore: 67,
        topInterests: [
          { subject: 'Science & STEM', count: 5 },
          { subject: 'Arts & Creative', count: 3 },
          { subject: 'Sports & Wellbeing', count: 4 }
        ]
      },
      lastUpdated: new Date().toISOString()
    };
    res.json(dashboardData);
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to generate dashboard data', message: e.message });
  }
});

// =============== “Plain array” inquiries for places that expect it ===============
app.get('/api/inquiries', async (req, res) => {
  try {
    const files = await fs.readdir('data');
    const list = [];
    for (const f of files) {
      if (!f.startsWith('inquiry-') || !f.endsWith('.json')) continue;
      const obj = JSON.parse(await fs.readFile(path.join('data', f), 'utf8'));
      list.push({
        id: obj.id,
        customerId: obj.id, // make the ID explicit for the UI
        firstName: obj.firstName,
        familySurname: obj.familySurname,
        parentEmail: obj.parentEmail,
        ageGroup: obj.ageGroup,
        entryYear: obj.entryYear,
        status: obj.status,
        receivedAt: obj.receivedAt,
        prospectusGenerated: !!obj.prospectusGenerated,
        prospectusFilename: obj.prospectusFilename || null,
        prospectusUrl: obj.prospectusUrl || null,
        prospectusGeneratedAt: obj.prospectusGeneratedAt || null
      });
    }
    list.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    res.json(list);
  } catch (e) {
    console.error('inquiries list error:', e.message);
    res.json([]); // dashboard expects an array
  }
});

app.get('/api/inquiries/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // DB first
    if (db) {
      try {
        const { rows } = await db.query('SELECT * FROM inquiries WHERE id = $1 LIMIT 1', [id]);
        if (rows && rows[0]) {
          const r = rows[0];
          return res.json({
            id: r.id, customerId: r.id,
            firstName: r.first_name, familySurname: r.family_surname,
            parentEmail: r.parent_email, ageGroup: r.age_group, entryYear: r.entry_year,
            status: r.status, receivedAt: r.received_at
          });
        }
      } catch (dbErr) { console.warn('DB single inquiry lookup failed:', dbErr.message); }
    }

    // JSON fallback
    const files = await fs.readdir('data');
    for (const f of files) {
      if (!f.startsWith('inquiry-') || !f.endsWith('.json')) continue;
      const obj = JSON.parse(await fs.readFile(path.join('data', f), 'utf8'));
      if (obj.id === id) {
        return res.json({
          id: obj.id, customerId: obj.id,
          firstName: obj.firstName, familySurname: obj.familySurname,
          parentEmail: obj.parentEmail, ageGroup: obj.ageGroup, entryYear: obj.entryYear,
          status: obj.status, receivedAt: obj.receivedAt,
          prospectusGenerated: !!obj.prospectusGenerated,
          prospectusFilename: obj.prospectusFilename || null,
          prospectusUrl: obj.prospectusUrl || null
        });
      }
    }

    res.status(404).json({ success: false, error: 'Inquiry not found' });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to retrieve inquiry', message: e.message });
  }
});

// Robust (DB or JSON) generate route used by the dashboard button
app.post('/api/generate-prospectus/:inquiryId', async (req, res) => {
  const { inquiryId } = req.params;
  try {
    let inquiry = null;

    // DB first (dashboard often reads from DB)
    if (db) {
      try {
        const { rows } = await db.query('SELECT * FROM inquiries WHERE id = $1 LIMIT 1', [inquiryId]);
        if (rows && rows[0]) {
          const r = rows[0];
          inquiry = {
            id: r.id,
            firstName: r.first_name,
            familySurname: r.family_surname,
            parentEmail: r.parent_email,
            ageGroup: r.age_group,
            entryYear: r.entry_year,
            receivedAt: r.received_at,
            status: r.status
          };
        }
      } catch (dbErr) {
        console.warn('DB lookup failed (generate):', dbErr.message);
      }
    }

    // JSON fallback
    if (!inquiry) {
      const files = await fs.readdir('data');
      for (const f of files) {
        if (!f.startsWith('inquiry-') || !f.endsWith('.json')) continue;
        const obj = JSON.parse(await fs.readFile(path.join('data', f), 'utf8'));
        if (obj.id === inquiryId) { inquiry = obj; break; }
      }
    }

    if (!inquiry) return res.status(404).json({ success: false, error: 'Inquiry not found' });

    const prospectus = await generateProspectus(inquiry);
    await updateInquiryStatus(inquiry.id, prospectus);

    res.json({
      success: true,
      inquiryId: inquiry.id,
      prospectus: {
        filename: prospectus.filename,
        url: `http://localhost:${PORT}${prospectus.url}`,
        generatedAt: prospectus.generatedAt
      }
    });
  } catch (e) {
    console.error('generate-prospectus error:', e);
    res.status(500).json({ success: false, error: 'Failed to generate prospectus', message: e.message });
  }
});

// =============== AI Analysis routes ===============
async function fetchFamilyEngagement(inquiryId) {
  if (!db) return null;
  const out = { inquiry: null, totals: {}, sections: [], videos: [], visits: 0, lastVisit: null };

  const iq = `SELECT * FROM inquiries WHERE id=$1 LIMIT 1`;
  const ir = await db.query(iq, [inquiryId]);
  out.inquiry = ir.rows?.[0] || null;

  const sq = `
    SELECT
      (event_data->>'section_id') AS section_id,
      SUM(COALESCE((event_data->>'duration_ms')::bigint,0)) AS total_ms,
      MAX(COALESCE((event_data->>'max_scroll_pct')::int,0)) AS max_scroll
    FROM tracking_events
    WHERE inquiry_id=$1 AND event_type='section_time'
    GROUP BY section_id
    ORDER BY total_ms DESC
  `;
  out.sections = (await db.query(sq, [inquiryId])).rows;

  const vq = `
    SELECT
      (event_data->>'video_id') AS video_id,
      SUM(COALESCE((event_data->>'duration_ms')::bigint,0)) AS total_ms,
      COUNT(*) AS plays
    FROM tracking_events
    WHERE inquiry_id=$1 AND event_type='video_close'
    GROUP BY video_id
    ORDER BY total_ms DESC
  `;
  out.videos = (await db.query(vq, [inquiryId])).rows;

  const tq = `
    SELECT 
      COUNT(DISTINCT session_id) AS visits,
      MAX(timestamp) AS last_visit,
      SUM(CASE WHEN event_type='prospectus_close'
               THEN COALESCE((event_data->>'duration_ms')::bigint,0)
               ELSE 0 END) AS total_dur_ms
    FROM tracking_events
    WHERE inquiry_id=$1
  `;
  const tr = (await db.query(tq, [inquiryId])).rows?.[0] || {};
  out.visits = Number(tr.visits || 0);
  out.lastVisit = tr.last_visit;
  out.totals.total_dur_ms = Number(tr.total_dur_ms || 0);
  return out;
}

function buildAIInstructionsUK() {
  return `You are an admissions data analyst for an independent school in the UK.
Write a concise, parent-sensitive analysis to help the admissions team prioritise follow-up.
Use British spelling, keep the tone warm but professional, and avoid jargon.

Return JSON with exactly these keys:
- "summary": 2–3 sentences
- "engagement_score": integer 0–100
- "signals": array of short bullet strings (3–6 items)
- "next_steps": array of 3 specific actions
- "risk_flags": array (may be empty)
- "sections_ranked": array of {section_id, dwell_minutes, max_scroll_pct}
- "videos": array of {video_id, watch_minutes, plays}

Scoring guideline:
- Dwell time: 0–60 points (15+ minutes ≈ 60)
- Breadth (distinct sections): 0–20 (5+ sections ≈ 20)
- Revisit count: 0–20 (4+ sessions ≈ 20)`;
}

async function analyseWithOpenAI(payload) {
  // Fallback if AI unavailable
  if (!openai || !process.env.OPENAI_API_KEY) {
    return {
      summary: 'AI unavailable: no API key or SDK not installed.',
      engagement_score: 0,
      signals: [],
      next_steps: [],
      risk_flags: [],
      sections_ranked: payload.sections.map(s => ({
        section_id: s.section_id,
        dwell_minutes: Math.round((Number(s.total_ms || 0))/60000),
        max_scroll_pct: Number(s.max_scroll || 0)
      })),
      videos: payload.videos.map(v => ({
        video_id: v.video_id,
        watch_minutes: Math.round((Number(v.total_ms || 0))/60000),
        plays: Number(v.plays || 0)
      }))
    };
  }

  const engagementMinutes = Math.round((payload.totals.total_dur_ms || 0) / 60000);
  const breadth = payload.sections.length;
  const visits = payload.visits || 0;
  const dwellScore = Math.min(60, Math.round(engagementMinutes * 4));
  const breadthScore = Math.min(20, breadth * 4);
  const visitScore = Math.min(20, visits * 5);
  const engagementScore = Math.min(100, dwellScore + breadthScore + visitScore);

  const system = buildAIInstructionsUK();
  const user = {
    school: 'More House School',
    inquiry: {
      id: payload.inquiry?.id,
      first_name: payload.inquiry?.first_name || payload.inquiry?.firstName,
      family_surname: payload.inquiry?.family_surname || payload.inquiry?.familySurname,
      age_group: payload.inquiry?.age_group || payload.inquiry?.ageGroup,
      entry_year: payload.inquiry?.entry_year || payload.inquiry?.entryYear,
      received_at: payload.inquiry?.received_at || payload.inquiry?.receivedAt
    },
    engagement: {
      visits,
      last_visit: payload.lastVisit,
      engagement_minutes: engagementMinutes,
      derived_engagement_score: engagementScore
    },
    sections: payload.sections,
    videos: payload.videos
  };

  const prompt = `DATA:\n${JSON.stringify(user, null, 2)}\n\nPlease respond with the required JSON only.`;

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt }
    ],
    response_format: { type: 'json_object' }
  });

  let parsed;
  try { parsed = JSON.parse(completion.choices[0].message.content); }
  catch { parsed = { summary: completion.choices[0].message.content }; }

  if (!Array.isArray(parsed.sections_ranked)) {
    parsed.sections_ranked = payload.sections.map(s => ({
      section_id: s.section_id,
      dwell_minutes: Math.round((Number(s.total_ms || 0))/60000),
      max_scroll_pct: Number(s.max_scroll || 0)
    }));
  }
  if (!Array.isArray(parsed.videos)) {
    parsed.videos = payload.videos.map(v => ({
      video_id: v.video_id,
      watch_minutes: Math.round((Number(v.total_ms || 0))/60000),
      plays: Number(v.plays || 0)
    }));
  }
  if (typeof parsed.engagement_score !== 'number') {
    parsed.engagement_score = engagementScore;
  }
  return parsed;
}

app.post('/api/ai/analyze-family/:inquiryId', async (req, res) => {
  const { inquiryId } = req.params;
  try {
    const payload = await fetchFamilyEngagement(inquiryId);
    if (!payload) {
      return res.json({
        success: true,
        ai: {
          summary: 'No database connection; unable to fetch engagement. Please try again later.',
          engagement_score: 0,
          signals: [],
          next_steps: [],
          risk_flags: [],
          sections_ranked: [],
          videos: []
        }
      });
    }
    const ai = await analyseWithOpenAI(payload);
    res.json({ success: true, ai });
  } catch (e) {
    console.error('AI analyse-family error:', e);
    res.status(500).json({ success: false, error: 'AI analysis failed' });
  }
});

app.post('/api/ai/analyze-all-families', async (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.body?.limit || 10), 50));
  if (!db) return res.json({ success: true, count: 0, results: [], note: 'DB not connected' });
  try {
    const { rows } = await db.query(`SELECT id FROM inquiries ORDER BY received_at DESC LIMIT $1`, [limit]);
    const results = [];
    for (const r of rows) {
      const payload = await fetchFamilyEngagement(r.id);
      const ai = await analyseWithOpenAI(payload);
      results.push({ inquiryId: r.id, ai });
    }
    res.json({ success: true, count: results.length, results });
  } catch (e) {
    console.error('AI analyse-all error:', e);
    res.status(500).json({ success: false, error: 'AI batch analysis failed' });
  }
});

// =============== Health + root ===============
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: '3.2.0',
    features: {
      analytics: !!db,
      tracking: true,
      dashboard: true,
      ai: !!(openai && process.env.OPENAI_API_KEY)
    }
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'More House School Analytics System',
    status: 'running',
    version: '3.2.0',
    endpoints: {
      webhook: 'POST /webhook',
      inquiries: 'GET /api/inquiries',
      inquiry: 'GET /api/inquiries/:id',
      generateProspectus: 'POST /api/generate-prospectus/:inquiryId',
      prospectuses: 'GET /prospectuses/{filename}',
      analytics: 'GET /api/analytics/*',
      tracking_legacy: 'POST /api/track',
      trackEngagement: 'POST /api/track-engagement',
      dashboard: 'GET /dashboard.html',
      health: 'GET /health',
      aiAnalyseFamily: 'POST /api/ai/analyze-family/:inquiryId',
      aiAnalyseAll: 'POST /api/ai/analyze-all-families'
    },
    ai: !!(openai && process.env.OPENAI_API_KEY)
  });
});

// =============== Start ===============
app.use((req, res) => res.status(404).json({ success: false, error: 'Not found', message: `${req.method} ${req.path} not found` }));

process.on('SIGINT', async () => { if (db) await db.end(); process.exit(0); });
process.on('SIGTERM', async () => { if (db) await db.end(); process.exit(0); });

(async function start() {
  const connected = await initializeDatabase();
  await ensureDirectories();
  app.listen(PORT, () => {
    console.log(`🚀 Server on http://localhost:${PORT} | DB: ${connected ? 'connected' : 'disabled'} | AI: ${openai && process.env.OPENAI_API_KEY ? 'enabled' : 'disabled'}`);
  });
})();

// Exports
module.exports = {
  generateProspectus,
  updateInquiryStatus,
  generateFilename,
  saveInquiryToDatabase,
  trackEngagementEvent,
  updateEngagementMetrics
};
