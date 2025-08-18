// server.js
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

// ✅ Load environment variables and DB client
require('dotenv').config();
const { Client } = require('pg');

// ✅ Base URL for links and webhooks (trims trailing slashes)
const PUBLIC_BASE_URL =
  (process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL.replace(/\/+$/, '')) ||
  `http://localhost:${process.env.PORT || 3000}`;

// ✅ Dashboard base URL (optional; trims trailing slashes)
const DASHBOARD_URL =
  (process.env.DASHBOARD_URL && process.env.DASHBOARD_URL.replace(/\/+$/, '')) || null;

const app = express();

// IMPORTANT: Render assigns the port via env var
const PORT = process.env.PORT || 3000;

// Trust Render's proxy so req.ip, protocol etc. are correct
app.set('trust proxy', 1);

// ---- Database connection (Render-compatible: SSL on) ----
let db = null;

const initializeDatabase = async () => {
  try {
    // Prefer single DATABASE_URL (Render), fall back to individual vars for local/dev
    const hasUrl = !!process.env.DATABASE_URL;
    const clientConfig = hasUrl
      ? {
          connectionString: process.env.DATABASE_URL,
          ssl: { rejectUnauthorized: false }, // Render Postgres requires SSL
        }
      : {
          host: process.env.DB_HOST || 'localhost',
          port: Number(process.env.DB_PORT || 5432),
          database: process.env.DB_NAME || 'morehouse_analytics',
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
        };

    db = new Client(clientConfig);
    await db.connect();
    console.log('✅ Connected to PostgreSQL analytics database');
    return true;
  } catch (error) {
    console.warn('⚠️ PostgreSQL connection failed:', error.message);
    console.warn('📊 Analytics will use JSON files, but core functionality remains');
    return false;
  }
};

// ---- Middleware ----
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Serve tracking.js explicitly
app.get('/tracking.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tracking.js'));
});

// ---- Helpers ----
const generateInquiryId = () => {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000);
  return `INQ-${timestamp}${random}`;
};

const generateFilename = (inquiryData) => {
  const date = new Date().toISOString().split('T')[0];
  const safeFamilyName = (inquiryData.familySurname || '').replace(/[^a-zA-Z0-9]/g, '-');
  const safeFirstName = (inquiryData.firstName || '').replace(/[^a-zA-Z0-9]/g, '-');
  return `More-House-School-${safeFamilyName}-Family-${safeFirstName}-${inquiryData.entryYear}-${date}.html`;
};

const ensureDirectories = async () => {
  try {
    await fs.mkdir('data', { recursive: true });
    await fs.mkdir('prospectuses', { recursive: true });
    console.log('📁 Directory structure verified');
  } catch (error) {
    console.error('❌ Error creating directories:', error.message);
  }
};

// Build an absolute base URL for responses/logs (no localhost leakage on Render)
const getBaseUrl = (req) => {
  // Prefer explicit env (set this in Render for exact host you want, e.g. https://morehouse.pen.ai)
  const fromEnv = PUBLIC_BASE_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');

  // Derive from request (supports HTTPS behind proxy)
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
};

// 🔗 Push the prospectus URL to the dashboard (if configured)
const pushProspectusToDashboard = async ({ inquiryId, familyName, prospectusUrl }) => {
  if (!DASHBOARD_URL) {
    console.log('ℹ️ DASHBOARD_URL not set; skipping dashboard notify');
    return;
  }
  try {
    // Node 18+ has fetch globally
    const res = await fetch(`${DASHBOARD_URL}/api/prospectus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inquiryId, familyName, prospectusUrl }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Dashboard responded ${res.status} ${res.statusText} ${text}`);
    }
    console.log('📊 Prospectus URL pushed to dashboard');
  } catch (err) {
    console.warn('⚠️ Failed to push URL to dashboard:', err.message);
  }
};

// ---- Persistence helpers ----
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
      ...formData,
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
        received_at, status, user_agent, referrer, ip_address
      ) VALUES (
        $1,$2,$3,$4,$5,$6,
        $7,$8,$9,$10,$11,$12,
        $13,$14,$15,$16,
        $17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,
        $27,$28,$29,$30,$31
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
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

      // Academic interests
      !!inquiryData.sciences,
      !!inquiryData.mathematics,
      !!inquiryData.english,
      !!inquiryData.languages,
      !!inquiryData.humanities,
      !!inquiryData.business,

      // Creative interests
      !!inquiryData.drama,
      !!inquiryData.music,
      !!inquiryData.art,
      !!inquiryData.creative_writing,

      // Co-curricular interests
      !!inquiryData.sport,
      !!inquiryData.leadership,
      !!inquiryData.community_service,
      !!inquiryData.outdoor_education,

      // Family priorities
      !!inquiryData.academic_excellence,
      !!inquiryData.pastoral_care,
      !!inquiryData.university_preparation,
      !!inquiryData.personal_development,
      !!inquiryData.career_guidance,
      !!inquiryData.extracurricular_opportunities,

      // System fields
      new Date(inquiryData.receivedAt),
      inquiryData.status,
      inquiryData.userAgent,
      inquiryData.referrer,
      inquiryData.ip || null,
    ];

    const result = await db.query(query, values);
    console.log('📊 Inquiry saved to analytics database');
    return result.rows[0];
  } catch (error) {
    console.error('❌ Failed to save inquiry to database:', error.message);
    return null;
  }
};

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
      eventData.ip || null,
      eventData.sessionId,
      new Date(eventData.timestamp),
    ];
    const result = await db.query(query, values);
    return result.rows[0];
  } catch (error) {
    console.error('❌ Failed to track event:', error.message);
    return null;
  }
};

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
        time_on_page     = GREATEST(engagement_metrics.time_on_page, EXCLUDED.time_on_page),
        scroll_depth     = GREATEST(engagement_metrics.scroll_depth, EXCLUDED.scroll_depth),
        clicks_on_links  = GREATEST(engagement_metrics.clicks_on_links, EXCLUDED.clicks_on_links),
        pages_viewed     = engagement_metrics.pages_viewed + 1,
        last_visit       = EXCLUDED.last_visit,
        total_visits     = engagement_metrics.total_visits + 1
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
      new Date(),
    ];

    const result = await db.query(query, values);
    return result.rows[0];
  } catch (error) {
    console.error('❌ Failed to update engagement metrics:', error.message);
    return null;
  }
};

// ---- Prospectus generation (injects tracking + personalisation) ----
const generateProspectus = async (inquiryData) => {
  try {
    console.log(`\n🎨 GENERATING PROSPECTUS WITH TRACKING FOR: ${inquiryData.firstName} ${inquiryData.familySurname}`);
    console.log('══════════════════════════════════════════════════════════════════════');

    // Read the prospectus template
    const templatePath = path.join(__dirname, 'public', 'prospectus_template.html');
    let templateHtml = await fs.readFile(templatePath, 'utf8');

    console.log('📄 Template loaded successfully');

    // Generate the personalised filename
    const filename = generateFilename(inquiryData);
    const outputPath = path.join(__dirname, 'prospectuses', filename);

    // STEP 1: Add meta tags to <head>
    const metaTags = `
<meta name="inquiry-id" content="${inquiryData.id}">
<meta name="generated-date" content="${new Date().toISOString()}">
<meta name="student-name" content="${inquiryData.firstName} ${inquiryData.familySurname}">
<meta name="entry-year" content="${inquiryData.entryYear}">
<meta name="age-group" content="${inquiryData.ageGroup}">
<meta name="tracking-enabled" content="true">`;
    templateHtml = templateHtml.replace('</head>', metaTags + '\n</head>');

    // STEP 2: Update page title
    const personalizedTitle = `${inquiryData.firstName} ${inquiryData.familySurname} - More House School Prospectus ${inquiryData.entryYear}`;
    templateHtml = templateHtml.replace(/<title>.*?<\/title>/, `<title>${personalizedTitle}</title>`);

    // STEP 3: Personalisation script
    const personalizationScript = `<script>
document.addEventListener('DOMContentLoaded', function() {
  const userData = ${JSON.stringify(inquiryData, null, 2)};
  console.log('🎯 Initialising prospectus with data:', userData);
  if (typeof initializeProspectus === 'function') {
    initializeProspectus(userData);
    console.log('✅ Prospectus personalised for:', userData.firstName, userData.familySurname);
  } else {
    console.error('❌ initializeProspectus function not found');
  }
});
</script>`;

    // STEP 4: Tracking script injection
    const trackingScriptInjection = `<!-- More House Analytics Tracking -->
<script>
  window.MORE_HOUSE_INQUIRY_ID = '${inquiryData.id}';
  console.log('📊 Inquiry ID set for tracking:', window.MORE_HOUSE_INQUIRY_ID);
</script>
<script src="/tracking.js"></script>`;

    // STEP 5: Inject before </body>
    const bodyCloseIndex = templateHtml.lastIndexOf('</body>');
    if (bodyCloseIndex === -1) throw new Error('❌ No closing </body> tag found in template!');

    const scriptsToInject = personalizationScript + '\n' + trackingScriptInjection + '\n';
    const finalHtml = templateHtml.slice(0, bodyCloseIndex) + scriptsToInject + templateHtml.slice(bodyCloseIndex);

    // STEP 6: Save final HTML
    await fs.writeFile(outputPath, finalHtml, 'utf8');

    // STEP 7: Verification
    const savedContent = await fs.readFile(outputPath, 'utf8');
    const hasTrackingJs = savedContent.includes('<script src="/tracking.js"></script>');
    const hasInquiryId = savedContent.includes(`window.MORE_HOUSE_INQUIRY_ID = '${inquiryData.id}'`);
    const hasPersonalization = savedContent.includes('initializeProspectus');

    console.log(`📁 Prospectus saved: ${filename}`);
    console.log(`📊 tracking.js script: ${hasTrackingJs ? '✅ FOUND' : '❌ MISSING'}`);
    console.log(`🔑 Inquiry ID variable: ${hasInquiryId ? '✅ FOUND' : '❌ MISSING'}`);
    console.log(`🎯 Personalisation script: ${hasPersonalization ? '✅ FOUND' : '❌ MISSING'}`);

    if (!hasTrackingJs || !hasInquiryId) {
      console.error('🚨 CRITICAL: Tracking script injection FAILED!');
      throw new Error('Tracking script injection failed');
    } else {
      console.log('🎉 SUCCESS: All tracking scripts properly injected!');
    }

    return {
      filename,
      path: outputPath,
      url: `/prospectuses/${filename}`,
      generatedAt: new Date().toISOString(),
      trackingEnabled: hasTrackingJs && hasInquiryId,
    };
  } catch (error) {
    console.error('❌ Error generating prospectus:', error.message);
    throw error;
  }
};

// Update inquiry status after prospectus generation
const updateInquiryStatus = async (inquiryId, prospectusInfo) => {
  try {
    const files = await fs.readdir('data');
    const inquiryFiles = files.filter((file) => file.startsWith('inquiry-') && file.endsWith('.json'));

    for (const file of inquiryFiles) {
      const filepath = path.join('data', file);
      const content = await fs.readFile(filepath, 'utf8');
      const inquiry = JSON.parse(content);

      if (inquiry.id === inquiryId) {
        inquiry.prospectusGenerated = true;
        inquiry.prospectusFilename = prospectusInfo.filename;
        inquiry.prospectusUrl = prospectusInfo.url;
        inquiry.prospectusGeneratedAt = prospectusInfo.generatedAt;
        inquiry.status = 'prospectus_generated';

        await fs.writeFile(filepath, JSON.stringify(inquiry, null, 2));
        console.log(`📝 Updated inquiry record: ${inquiryId}`);

        if (db) {
          try {
            await db.query(
              `
              UPDATE inquiries 
              SET status = 'prospectus_generated', 
                  prospectus_generated = true,
                  prospectus_filename = $2,
                  prospectus_url = $3,
                  prospectus_generated_at = $4,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = $1
              `,
              [inquiryId, prospectusInfo.filename, prospectusInfo.url, new Date(prospectusInfo.generatedAt)]
            );
            console.log('📊 Database updated with prospectus info');
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

// ---- Routes ----

// Webhook: save inquiry → generate prospectus → respond with absolute URL
app.post('/webhook', async (req, res) => {
  console.log('\n🎯 WEBHOOK RECEIVED');
  console.log('📅 Timestamp:', new Date().toISOString());

  try {
    const formData = req.body;

    const requiredFields = ['firstName', 'familySurname', 'parentEmail', 'ageGroup', 'entryYear'];
    const missingFields = requiredFields.filter((f) => !formData[f]);
    if (missingFields.length > 0) {
      console.log('❌ Missing required fields:', missingFields);
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        missingFields,
        received: Object.keys(formData),
      });
    }

    // Log summary (trimmed for brevity)
    console.log(`👨‍👩‍👧 Family: ${formData.firstName} ${formData.familySurname} | Age Group: ${formData.ageGroup} | Entry: ${formData.entryYear}`);

    // Persist
    const inquiryRecord = await saveInquiryData(formData);

    // Save to DB (if connected)
    await saveInquiryToDatabase({
      ...formData,
      id: inquiryRecord.id,
      receivedAt: inquiryRecord.receivedAt,
      status: 'received',
      userAgent: req.headers['user-agent'],
      referrer: req.headers.referer,
      ip: req.ip || req.connection?.remoteAddress,
    });

    // Generate prospectus
    const prospectusInfo = await generateProspectus(inquiryRecord);

    // Update status
    await updateInquiryStatus(inquiryRecord.id, prospectusInfo);

    // Absolute URL for response
    const base = getBaseUrl(req);
    const absoluteUrl = `${base}${prospectusInfo.url}`;

    // 🔗 Notify dashboard (if configured)
    await pushProspectusToDashboard({
      inquiryId: inquiryRecord.id,
      familyName: inquiryRecord.familySurname,
      prospectusUrl: absoluteUrl,
    });

    const response = {
      success: true,
      message: 'Inquiry received and prospectus generated successfully',
      inquiryId: inquiryRecord.id,
      prospectus: {
        filename: prospectusInfo.filename,
        url: absoluteUrl,
        generatedAt: prospectusInfo.generatedAt,
      },
      receivedAt: inquiryRecord.receivedAt,
    };

    console.log('✅ WEBHOOK RESPONSE SENT:', response.inquiryId);
    console.log(`🎯 PROSPECTUS URL: ${absoluteUrl}`);
    console.log('📊 Analytics tracking enabled on prospectus\n');

    res.json(response);
  } catch (error) {
    console.error('❌ WEBHOOK ERROR:', error.message);
    res.status(500).json({ success: false, error: 'Internal server error', message: error.message });
  }
});

// Legacy/batch tracking (kept as you had it)
app.post('/api/track', async (req, res) => {
  try {
    const { events, engagementMetrics } = req.body;
    const clientIP = req.ip || req.connection?.remoteAddress;

    console.log(`📊 Tracking data received for inquiry: ${engagementMetrics?.inquiryId}`);

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

    console.log(`📊 Received ${eventList.length} tracking events`);

    for (const event of eventList) {
      const { inquiryId, sessionId, eventType, timestamp, data = {}, url, currentSection } = event;
      if (!inquiryId || !sessionId || !eventType) {
        console.warn('⚠️ Invalid tracking event - missing required fields');
        continue;
      }

      if (db) {
        await trackEngagementEvent({
          inquiryId,
          sessionId,
          eventType,
          timestamp: timestamp || new Date().toISOString(),
          eventData: data,
          url,
          currentSection,
          deviceInfo: data.deviceInfo,
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
        prospectusFilename: 'unknown',
      });
    }

    res.json({ success: true, message: `Tracked ${eventList.length} events successfully`, eventsProcessed: eventList.length });
  } catch (error) {
    console.error('❌ Error tracking engagement:', error);
    res.status(500).json({ success: false, error: 'Failed to track engagement', message: error.message });
  }
});

// Stats for dashboard (JSON-first, DB if present)
app.get('/api/analytics/stats', async (req, res) => {
  try {
    const files = await fs.readdir('data');
    const inquiryFiles = files.filter((f) => f.startsWith('inquiry-') && f.endsWith('.json'));

    let totalInquiries = 0;
    let prospectusGenerated = 0;

    for (const file of inquiryFiles) {
      try {
        const content = await fs.readFile(path.join('data', file), 'utf8');
        const inquiry = JSON.parse(content);
        totalInquiries++;
        if (inquiry.prospectusGenerated || inquiry.status === 'prospectus_generated') prospectusGenerated++;
      } catch {
        // ignore file parse errors
      }
    }

    let avgEngagementTime = 0;
    let highInterest = 0;

    if (db) {
      try {
        const result = await db.query(`
          SELECT 
            AVG(CASE WHEN time_on_page > 0 THEN time_on_page END) as avg_engagement_time,
            COUNT(CASE WHEN time_on_page > 300 THEN 1 END) as high_interest
          FROM engagement_metrics
        `);
        const stats = result.rows[0] || {};
        avgEngagementTime = (parseFloat(stats.avg_engagement_time) || 0) / 60;
        highInterest = parseInt(stats.high_interest || 0, 10);
      } catch (e) {
        // ignore db error and keep JSON-only stats
      }
    }

    res.json({
      totalInquiries,
      activeEngagements: prospectusGenerated,
      avgEngagementTime,
      highInterest,
    });
  } catch (error) {
    res.status(500).json({
      totalInquiries: 0,
      activeEngagements: 0,
      avgEngagementTime: 0,
      highInterest: 0,
    });
  }
});

// Inquiries list for dashboard
app.get('/api/analytics/inquiries', async (req, res) => {
  try {
    const files = await fs.readdir('data');
    const inquiryFiles = files.filter((f) => f.startsWith('inquiry-') && f.endsWith('.json'));

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
          engagement: null,
        };

        if (db) {
          try {
            const result = await db.query(
              `
              SELECT time_on_page, scroll_depth, clicks_on_links, total_visits, last_visit
              FROM engagement_metrics 
              WHERE inquiry_id = $1
              ORDER BY last_visit DESC
              LIMIT 1
              `,
              [inquiry.id]
            );
            if (result.rows.length > 0) {
              const e = result.rows[0];
              dashboardInquiry.engagement = {
                timeOnPage: e.time_on_page || 0,
                scrollDepth: e.scroll_depth || 0,
                clickCount: e.clicks_on_links || 0,
                totalVisits: e.total_visits || 0,
                lastVisit: e.last_visit,
              };
            }
          } catch {
            // ignore db error per row
          }
        }

        inquiries.push(dashboardInquiry);
      } catch {
        // ignore bad file
      }
    }

    inquiries.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
    res.json(inquiries);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get inquiries data' });
  }
});

// Recent activity (DB only)
app.get('/api/analytics/activity', async (req, res) => {
  try {
    if (!db) return res.json([]);
    const result = await db.query(`
      SELECT 
        te.inquiry_id,
        te.event_type,
        te.timestamp,
        te.event_data,
        i.first_name,
        i.family_surname
      FROM tracking_events te
      LEFT JOIN inquiries i ON te.inquiry_id = i.id
      ORDER BY te.timestamp DESC
      LIMIT 20
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get activity data' });
  }
});

// Serve prospectus files
app.use('/prospectuses', express.static(path.join(__dirname, 'prospectuses')));

// Manual re-gen for existing inquiry (returns absolute URL)
app.post('/api/generate-prospectus/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;

    const files = await fs.readdir('data');
    const inquiryFiles = files.filter((f) => f.startsWith('inquiry-') && f.endsWith('.json'));

    let inquiryData = null;
    for (const file of inquiryFiles) {
      const content = await fs.readFile(path.join('data', file), 'utf8');
      const inquiry = JSON.parse(content);
      if (inquiry.id === inquiryId) {
        inquiryData = inquiry;
        break;
      }
    }

    if (!inquiryData) {
      return res.status(404).json({ success: false, error: 'Inquiry not found' });
    }

    const prospectusInfo = await generateProspectus(inquiryData);
    await updateInquiryStatus(inquiryId, prospectusInfo);

    const absoluteUrl = `${getBaseUrl(req)}${prospectusInfo.url}`;

    // 🔗 Notify dashboard (if configured)
    await pushProspectusToDashboard({
      inquiryId,
      familyName: inquiryData.familySurname,
      prospectusUrl: absoluteUrl,
    });

    res.json({
      success: true,
      message: 'Prospectus generated successfully',
      inquiryId,
      prospectus: {
        filename: prospectusInfo.filename,
        url: absoluteUrl,
        generatedAt: prospectusInfo.generatedAt,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to generate prospectus', message: error.message });
  }
});

// Health
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: '3.0.0',
    features: {
      analytics: 'enabled',
      tracking: 'enabled',
      dashboard: 'enabled',
      database: db ? 'connected' : 'json-only',
    },
  });
});

// Root
app.get('/', (req, res) => {
  res.json({
    service: 'More House School Analytics System',
    status: 'running',
    version: '3.0.0',
    endpoints: {
      webhook: 'POST /webhook',
      inquiries: 'GET /api/inquiries',
      inquiry: 'GET /api/inquiries/:id',
      generateProspectus: 'POST /api/generate-prospectus/:inquiryId',
      prospectuses: 'GET /prospectuses/{filename}',
      analytics: 'GET /api/analytics/*',
      tracking: 'POST /api/track',
      trackEngagement: 'POST /api/track-engagement',
      dashboard: 'GET /dashboard.html',
      health: 'GET /health',
    },
    timestamp: new Date().toISOString(),
    analytics: db ? 'enabled' : 'disabled',
  });
});

// 404 + Error handlers
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
    message: `Route ${req.method} ${req.path} not found`,
  });
});

app.use((err, req, res, next) => {
  console.error('🚨 Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error', message: err.message });
});

// Start server
const startServer = async () => {
  try {
    const dbConnected = await initializeDatabase();
    await ensureDirectories();

    app.listen(PORT, () => {
      console.log('\n🚀 MORE HOUSE WEBHOOK SERVER STARTED - PHASE 3 ANALYTICS');
      console.log('════════════════════════════════════════════════════════════════════════');
      console.log(`🌐 Listening on PORT ${PORT}`);
      console.log(`📊 Health check: /health`);
      console.log(`📋 Webhook endpoint: POST /webhook`);
      console.log(`📝 List inquiries: GET /api/inquiries`);
      console.log(`🎨 Prospectus files: /prospectuses/`);
      console.log(`📈 Analytics dashboard: /dashboard.html`);
      console.log(`📄 Manual generation: POST /api/generate-prospectus/:inquiryId`);
      console.log(`📊 Analytics API: /api/analytics/*`);
      console.log('════════════════════════════════════════════════════════════════════════');
      console.log(`📊 Analytics database: ${dbConnected ? 'Connected' : 'JSON files only'}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
};

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down webhook server...');
  if (db) {
    await db.end();
    console.log('📊 Database connection closed');
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down webhook server...');
  if (db) {
    await db.end();
    console.log('📊 Database connection closed');
  }
  process.exit(0);
});

startServer();

// Exports (optional)
module.exports = {
  generateProspectus,
  updateInquiryStatus,
  generateFilename,
  saveInquiryToDatabase,
  trackEngagementEvent,
  updateEngagementMetrics,
};
