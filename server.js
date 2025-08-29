// server.js — More House Prospectus + Simplified Tracking (Option B)
// Keeps all existing behaviour, adds runtime-injected tracking config:
//   window.PROSPECTUS_ID
//   window.TRACK_ENDPOINT
//   window.PROSPECTUS_SECTIONS (Option B mapping)

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

// Load environment variables
require('dotenv').config();
const { Client } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
let db = null;

// Initialize database connection
const initializeDatabase = async () => {
  try {
    db = new Client({
      connectionString: process.env.DATABASE_URL,
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'morehouse_analytics',
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });

    await db.connect();
    console.log('✅ Connected to PostgreSQL analytics database');
    return true;
  } catch (error) {
    console.warn('⚠️ PostgreSQL connection failed:', error.message);
    console.warn('📊 Analytics will be disabled, but core functionality remains');
    return false;
  }
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Serve tracking.js explicitly from /public (aligns with your asset layout)
app.get('/tracking.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tracking.js'));
});

// Generate unique inquiry ID
const generateInquiryId = () => {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000);
  return `INQ-${timestamp}${random}`;
};

// Generate filename for prospectus
const generateFilename = (inquiryData) => {
  const date = new Date().toISOString().split('T')[0];
  const safeFamilyName = inquiryData.familySurname.replace(/[^a-zA-Z0-9]/g, '-');
  const safeFirstName = inquiryData.firstName.replace(/[^a-zA-Z0-9]/g, '-');

  return `More-House-School-${safeFamilyName}-Family-${safeFirstName}-${inquiryData.entryYear}-${date}.html`;
};

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
        received_at, status, user_agent, referrer, ip_address
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16,
        $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26,
        $27, $28, $29, $30, $31
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
      inquiryData.ip || null
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
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;

    const values = [
      eventData.inquiryId,
      eventData.eventType,
      JSON.stringify(eventData.eventData || {}),
      eventData.url,
      eventData.deviceInfo?.userAgent || null,
      null, // IP will be added later
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
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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

// ==== Prospectus generation with tracking config injection (Option B) ====
const generateProspectus = async (inquiryData) => {
  try {
    console.log(`\n🎨 GENERATING PROSPECTUS FOR: ${inquiryData.firstName} ${inquiryData.familySurname}`);
    console.log('════════════════════════════════════════════════');

    // Read the prospectus template
    const templatePath = path.join(__dirname, 'public', 'prospectus_template.html');
    let templateHtml = await fs.readFile(templatePath, 'utf8');

    console.log('📄 Template loaded successfully');

    // Generate the personalised filename
    const filename = generateFilename(inquiryData);
    const outputPath = path.join(__dirname, 'prospectuses', filename);

    // Add meta tags with inquiry information FIRST
    const metaTags = `
    <meta name="inquiry-id" content="${inquiryData.id}">
    <meta name="generated-date" content="${new Date().toISOString()}">
    <meta name="student-name" content="${inquiryData.firstName} ${inquiryData.familySurname}">
    <meta name="entry-year" content="${inquiryData.entryYear}">
    <meta name="age-group" content="${inquiryData.ageGroup}">`;

    templateHtml = templateHtml.replace('</head>', metaTags + '\n</head>');

    // Update page title
    const personalisedTitle = `${inquiryData.firstName} ${inquiryData.familySurname} - More House School Prospectus ${inquiryData.entryYear}`;
    templateHtml = templateHtml.replace(/<title>.*<\/title>/, `<title>${personalisedTitle}</title>`);

    // Personalisation script (unchanged behaviour)
    const personalizationScript = `
<script>
// Auto-initialise prospectus with form data
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

    // === Tracking config injection (Option B mapping + endpoint + id) ===
    // Adjust selectors to match your template; unmatched selectors are harmless.
    const trackingConfigScript = `
<!-- SMART Prospectus Tracking Config (Option B) -->
<script>
  window.PROSPECTUS_ID = '${inquiryData.id}';
  window.TRACK_ENDPOINT = '/api/track-engagement';

  // Map logical sections to CSS selectors present in this prospectus render.
  // Feel free to refine/extend this list as your template evolves.
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

    // Combine scripts and inject before </body>
    const allScripts = personalizationScript + '\n' + trackingConfigScript;
    const finalHtml = templateHtml.replace('</body>', allScripts + '\n</body>');

    // Save the final HTML
    await fs.writeFile(outputPath, finalHtml, 'utf8');

    console.log(`📁 Prospectus saved: ${filename}`);
    console.log(`🌐 Will be available at: http://localhost:${PORT}/prospectuses/${filename}`);
    console.log('📊 Analytics tracking ENABLED with PROSPECTUS_ID:', inquiryData.id);
    console.log('✅ Personalisation + tracking scripts injected');

    return {
      filename,
      path: outputPath,
      url: `/prospectuses/${filename}`,
      generatedAt: new Date().toISOString()
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
    const inquiryFiles = files.filter(file => file.startsWith('inquiry-') && file.endsWith('.json'));

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
            await db.query(`
              UPDATE inquiries 
              SET status = 'prospectus_generated', 
                  prospectus_generated = true,
                  prospectus_filename = $2,
                  prospectus_url = $3,
                  prospectus_generated_at = $4,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = $1
            `, [inquiryId, prospectusInfo.filename, prospectusInfo.url, new Date(prospectusInfo.generatedAt)]);
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

// Enhanced webhook endpoint with prospectus generation and analytics
app.post('/webhook', async (req, res) => {
  console.log('\n🎯 WEBHOOK RECEIVED');
  console.log('📅 Timestamp:', new Date().toISOString());

  try {
    const formData = req.body;

    const requiredFields = ['firstName', 'familySurname', 'parentEmail', 'ageGroup', 'entryYear'];
    const missingFields = requiredFields.filter(field => !formData[field]);

    if (missingFields.length > 0) {
      console.log('❌ Missing required fields:', missingFields);
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        missingFields,
        received: Object.keys(formData)
      });
    }

    console.log('\n📋 FORM DATA RECEIVED:');
    console.log('════════════════════════════════════════');

    console.log('👨‍👩‍👧 FAMILY INFORMATION:');
    console.log(`   Name: ${formData.firstName} ${formData.familySurname}`);
    console.log(`   Email: ${formData.parentEmail}`);
    console.log(`   Age Group: ${formData.ageGroup}`);
    console.log(`   Entry Year: ${formData.entryYear}`);

    const academicInterests = [];
    ['sciences', 'mathematics', 'english', 'languages', 'humanities', 'business'].forEach(interest => {
      if (formData[interest]) academicInterests.push(interest);
    });
    console.log('\n📚 ACADEMIC INTERESTS:');
    console.log(`   ${academicInterests.length > 0 ? academicInterests.join(', ') : 'None selected'}`);

    const creativeInterests = [];
    ['drama', 'music', 'art', 'creative_writing'].forEach(interest => {
      if (formData[interest]) creativeInterests.push(interest);
    });
    console.log('\n🎨 CREATIVE INTERESTS:');
    console.log(`   ${creativeInterests.length > 0 ? creativeInterests.join(', ') : 'None selected'}`);

    const coCurricularInterests = [];
    ['sport', 'leadership', 'community_service', 'debating'].forEach(interest => {
      if (formData[interest]) coCurricularInterests.push(interest);
    });
    console.log('\n🏃‍♀️ CO-CURRICULAR INTERESTS:');
    console.log(`   ${coCurricularInterests.length > 0 ? coCurricularInterests.join(', ') : 'None selected'}`);

    const familyPriorities = [];
    ['academic_excellence', 'pastoral_care', 'small_classes', 'london_location', 'values_based', 'university_prep'].forEach(priority => {
      if (formData[priority]) familyPriorities.push(priority);
    });
    console.log('\n🏠 FAMILY PRIORITIES:');
    console.log(`   ${familyPriorities.length > 0 ? familyPriorities.join(', ') : 'None selected'}`);

    console.log('\n🔧 TECHNICAL METADATA:');
    console.log(`   User Agent: ${formData.userAgent || 'Not provided'}`);
    console.log(`   Referrer: ${formData.referrer || 'Not provided'}`);
    console.log(`   Submission Time: ${formData.submissionTimestamp || 'Not provided'}`);
    console.log('════════════════════════════════════════\n');

    const inquiryRecord = await saveInquiryData(formData);

    await saveInquiryToDatabase({
      ...formData,
      id: inquiryRecord.id,
      receivedAt: inquiryRecord.receivedAt,
      status: 'received',
      userAgent: req.headers['user-agent'],
      referrer: req.headers.referer,
      ip: req.ip || req.connection.remoteAddress
    });

    const prospectusInfo = await generateProspectus(inquiryRecord);

    await updateInquiryStatus(inquiryRecord.id, prospectusInfo);

    const response = {
      success: true,
      message: 'Inquiry received and prospectus generated successfully',
      inquiryId: inquiryRecord.id,
      prospectus: {
        filename: prospectusInfo.filename,
        url: `http://localhost:${PORT}${prospectusInfo.url}`,
        generatedAt: prospectusInfo.generatedAt
      },
      receivedAt: inquiryRecord.receivedAt,
      summary: {
        family: `${formData.firstName} ${formData.familySurname}`,
        email: formData.parentEmail,
        ageGroup: formData.ageGroup,
        entryYear: formData.entryYear,
        totalInterests: academicInterests.length + creativeInterests.length + coCurricularInterests.length,
        familyPriorities: familyPriorities.length
      }
    };

    console.log('✅ WEBHOOK RESPONSE SENT:', response.inquiryId);
    console.log(`🎯 PROSPECTUS URL: ${response.prospectus.url}`);
    console.log('📊 Analytics tracking enabled on prospectus\n');

    res.json(response);

  } catch (error) {
    console.error('❌ WEBHOOK ERROR:', error.message);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Legacy analytics tracking endpoint (kept)
app.post('/api/track', async (req, res) => {
  try {
    const { events, engagementMetrics } = req.body;
    const clientIP = req.ip || req.connection.remoteAddress;

    console.log(`📊 Tracking data received for inquiry: ${engagementMetrics?.inquiryId}`);

    if (events && events.length > 0) {
      for (const event of events) {
        await trackEngagementEvent({
          ...event,
          ip: clientIP
        });
      }
    }

    if (engagementMetrics) {
      await updateEngagementMetrics(engagementMetrics);
    }

    res.json({
      success: true,
      message: 'Tracking data recorded',
      eventsProcessed: events?.length || 0
    });

  } catch (error) {
    console.error('❌ Analytics tracking error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to record tracking data'
    });
  }
});

// New simplified batch tracking endpoint used by tracking.js
app.post('/api/track-engagement', async (req, res) => {
  try {
    const { events, sessionInfo } = req.body;

    const eventList = events || [req.body];

    console.log(`📊 Received ${eventList.length} tracking events`);

    for (const event of eventList) {
      const {
        inquiryId,
        sessionId,
        eventType,
        timestamp,
        data = {},
        url,
        currentSection
      } = event;

      if (!inquiryId || !sessionId || !eventType) {
        console.warn('⚠️ Invalid tracking event - missing required fields');
        continue;
      }

      console.log(`📈 ${eventType} | ${inquiryId} | ${currentSection || 'no-section'}`);

      if (eventType === 'page_load') {
        console.log(`   👤 Device: ${data.isMobile ? 'Mobile' : 'Desktop'} | ${data.viewport}`);
        console.log(`   🔗 Referrer: ${data.referrer || 'Direct'}`);
      } else if (eventType === 'section_view') {
        console.log(`   📖 Section: ${data.section} | View #${data.viewCount}`);
      } else if (eventType === 'scroll_depth') {
        console.log(`   📜 Scroll: ${data.milestone} (${data.depth}%)`);
      } else if (eventType === 'heartbeat') {
        console.log(`   ⏱️  Time: ${data.timeOnPage}s | Scroll: ${data.maxScrollDepth}% | Clicks: ${data.clickCount}`);
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
          deviceInfo: data.deviceInfo
        });
      }
    }

    if (sessionInfo) {
      console.log(`📊 Session Summary for ${sessionInfo.inquiryId}:`);
      console.log(`   ⏱️  Total time: ${sessionInfo.timeOnPage}s`);
      console.log(`   📜 Max scroll: ${sessionInfo.maxScrollDepth}%`);
      console.log(`   🖱️  Clicks: ${sessionInfo.clickCount}`);
      console.log(`   📖 Sections viewed: ${Object.keys(sessionInfo.sectionViews || {}).length}`);

      if (db && sessionInfo.inquiryId) {
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
    }

    res.json({
      success: true,
      message: `Tracked ${eventList.length} events successfully`,
      eventsProcessed: eventList.length
    });

  } catch (error) {
    console.error('❌ Error tracking engagement:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to track engagement',
      message: error.message
    });
  }
});

// Analytics dashboard data endpoints (unchanged)
app.get('/api/analytics/stats', async (req, res) => {
  if (!db) {
    return res.json({
      totalInquiries: 0,
      activeEngagements: 0,
      avgEngagementTime: 0,
      highInterest: 0
    });
  }

  try {
    const statsQuery = `
      SELECT 
        COUNT(*) as total_inquiries,
        COUNT(CASE WHEN status = 'prospectus_generated' THEN 1 END) as prospectus_generated,
        AVG(CASE WHEN em.time_on_page > 0 THEN em.time_on_page END) as avg_engagement_time,
        COUNT(CASE WHEN em.time_on_page > 300 THEN 1 END) as high_interest
      FROM inquiries i
      LEFT JOIN engagement_metrics em ON i.id = em.inquiry_id
    `;

    const result = await db.query(statsQuery);
    const stats = result.rows[0];

    res.json({
      totalInquiries: parseInt(stats.total_inquiries) || 0,
      activeEngagements: parseInt(stats.prospectus_generated) || 0,
      avgEngagementTime: parseFloat(stats.avg_engagement_time) / 60 || 0,
      highInterest: parseInt(stats.high_interest) || 0
    });

  } catch (error) {
    console.error('❌ Failed to get analytics stats:', error.message);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

app.get('/api/analytics/inquiries', async (req, res) => {
  if (!db) {
    return res.json([]);
  }

  try {
    const query = `
      SELECT 
        i.*,
        em.time_on_page,
        em.scroll_depth,
        em.clicks_on_links as click_count,
        em.total_visits,
        em.last_visit
      FROM inquiries i
      LEFT JOIN engagement_metrics em ON i.id = em.inquiry_id
      ORDER BY i.received_at DESC
      LIMIT 50
    `;

    const result = await db.query(query);

    const inquiries = result.rows.map(row => ({
      ...row,
      engagement: row.time_on_page ? {
        timeOnPage: row.time_on_page,
        scrollDepth: row.scroll_depth || 0,
        clickCount: row.click_count || 0,
        totalVisits: row.total_visits || 0
      } : null
    }));

    res.json(inquiries);

  } catch (error) {
    console.error('❌ Failed to get inquiries:', error.message);
    res.status(500).json({ error: 'Failed to get inquiries' });
  }
});

app.get('/api/analytics/activity', async (req, res) => {
  if (!db) {
    return res.json([]);
  }

  try {
    const query = `
      SELECT 
        te.*,
        i.first_name,
        i.family_surname
      FROM tracking_events te
      LEFT JOIN inquiries i ON te.inquiry_id = i.id
      ORDER BY te.timestamp DESC
      LIMIT 20
    `;

    const result = await db.query(query);
    res.json(result.rows);

  } catch (error) {
    console.error('❌ Failed to get activity:', error.message);
    res.status(500).json({ error: 'Failed to get activity' });
  }
});

// Dashboard data endpoint (unchanged)
app.get('/api/dashboard-data', async (req, res) => {
  try {
    console.log('📊 Dashboard data requested');

    const dashboardData = {
      metrics: {
        readyForContact: 1,
        highlyEngaged: 2,
        newInquiries: 3,
        totalFamilies: 5
      },
      priorityFamilies: [
        {
          id: 'INQ-' + Date.now(),
          name: 'Johnson Family',
          email: 'sarah.johnson@example.com',
          childName: 'Emma',
          ageGroup: '11-16',
          entryYear: 2025,
          engagementScore: 85,
          contactReadinessScore: 78,
          lastActivity: '2 hours ago',
          status: 'high_priority',
          insights: [
            { icon: '📊', title: 'High Engagement', description: 'Spent 15+ minutes reviewing curriculum' },
            { icon: '🎯', title: 'Strong Science Interest', description: 'Focused on STEM programs and facilities' },
            { icon: '📞', title: 'Contact Ready', description: 'Ready for admissions call' }
          ],
          engagementHistory: [
            { date: '2025-08-17', score: 85, activity: 'Prospectus review' },
            { date: '2025-08-16', score: 72, activity: 'Initial inquiry' }
          ]
        },
        {
          id: 'INQ-' + (Date.now() - 1000),
          name: 'Williams Family',
          email: 'mark.williams@example.com',
          childName: 'Sophie',
          ageGroup: '16-18',
          entryYear: 2025,
          engagementScore: 72,
          contactReadinessScore: 65,
          lastActivity: '1 day ago',
          status: 'moderate_interest',
          insights: [
            { icon: '🎨', title: 'Arts Focus', description: 'Interested in creative subjects and drama' },
            { icon: '⏰', title: 'Recent Inquiry', description: 'Just submitted form yesterday' }
          ],
          engagementHistory: [
            { date: '2025-08-16', score: 72, activity: 'Form submission' }
          ]
        }
      ],
      recentlyActive: [
        {
          id: 'INQ-' + (Date.now() - 2000),
          name: 'Chen Family',
          activity: 'Downloaded prospectus',
          timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          engagementScore: 58
        },
        {
          id: 'INQ-' + (Date.now() - 3000),
          name: 'Davies Family',
          activity: 'Viewed science facilities',
          timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          engagementScore: 45
        }
      ],
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

    console.log('✅ Dashboard data generated successfully');
    res.json(dashboardData);

  } catch (error) {
    console.error('❌ Error generating dashboard data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate dashboard data',
      message: error.message
    });
  }
});

// Serve prospectus files
app.use('/prospectuses', express.static(path.join(__dirname, 'prospectuses')));

// API endpoint to generate prospectus for existing inquiry
app.post('/api/generate-prospectus/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    console.log(`\n📄 MANUAL PROSPECTUS GENERATION REQUEST: ${inquiryId}`);

    const files = await fs.readdir('data');
    const inquiryFiles = files.filter(file => file.startsWith('inquiry-') && file.endsWith('.json'));

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
      return res.status(404).json({
        success: false,
        error: 'Inquiry not found'
      });
    }

    const prospectusInfo = await generateProspectus(inquiryData);

    await updateInquiryStatus(inquiryId, prospectusInfo);

    res.json({
      success: true,
      message: 'Prospectus generated successfully',
      inquiryId,
      prospectus: {
        filename: prospectusInfo.filename,
        url: `http://localhost:${PORT}${prospectusInfo.url}`,
        generatedAt: prospectusInfo.generatedAt
      }
    });

  } catch (error) {
    console.error('❌ Error generating prospectus:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to generate prospectus',
      message: error.message
    });
  }
});

// Get all inquiries
app.get('/api/inquiries', async (req, res) => {
  try {
    const files = await fs.readdir('data');
    const inquiryFiles = files.filter(file => file.startsWith('inquiry-') && file.endsWith('.json'));

    const inquiries = [];
    for (const file of inquiryFiles) {
      const content = await fs.readFile(path.join('data', file), 'utf8');
      const inquiry = JSON.parse(content);
      inquiries.push(inquiry);
    }

    inquiries.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));

    res.json({
      success: true,
      count: inquiries.length,
      inquiries
    });

  } catch (error) {
    console.error('❌ Error listing inquiries:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to list inquiries',
      message: error.message
    });
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

      if (inquiry.id === inquiryId) {
        return res.json({
          success: true,
          inquiry
        });
      }
    }

    res.status(404).json({
      success: false,
      error: 'Inquiry not found'
    });

  } catch (error) {
    console.error('❌ Error retrieving inquiry:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve inquiry',
      message: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: '3.0.1',
    features: {
      analytics: 'enabled',
      tracking: 'enabled',
      dashboard: 'enabled',
      database: db ? 'connected' : 'json-only'
    }
  });
});

// Root endpoint with basic info
app.get('/', (req, res) => {
  res.json({
    service: 'More House School Analytics System',
    status: 'running',
    version: '3.0.1',
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
      health: 'GET /health'
    },
    timestamp: new Date().toISOString(),
    analytics: db ? 'enabled' : 'disabled'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('🚨 Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
    message: `Route ${req.method} ${req.path} not found`
  });
});

// Start server
const startServer = async () => {
  try {
    const dbConnected = await initializeDatabase();

    await ensureDirectories();

    app.listen(PORT, () => {
      console.log('\n🚀 MORE HOUSE WEBHOOK SERVER STARTED - PHASE 3 ANALYTICS');
      console.log('════════════════════════════════════════════════════');
      console.log(`🌐 Server running on: http://localhost:${PORT}`);
      console.log(`📋 Webhook endpoint: http://localhost:${PORT}/webhook`);
      console.log(`📊 Health check: http://localhost:${PORT}/health`);
      console.log(`📝 List inquiries: http://localhost:${PORT}/api/inquiries`);
      console.log(`🎨 Prospectus files: http://localhost:${PORT}/prospectuses/`);
      console.log(`📈 Analytics dashboard: http://localhost:${PORT}/dashboard.html`);
      console.log(`📄 Manual generation: POST /api/generate-prospectus/:inquiryId`);
      console.log(`📊 Analytics API: http://localhost:${PORT}/api/analytics/`);
      console.log('════════════════════════════════════════════════════');
      console.log('✅ Ready to receive form submissions AND track analytics!');
      console.log(`📊 Analytics database: ${dbConnected ? 'Connected' : 'Disabled (JSON only)'}`);
      console.log('🎯 Prospectus render now injects PROSPECTUS_ID, TRACK_ENDPOINT, and PROSPECTUS_SECTIONS (Option B)\n');
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
};

// Handle graceful shutdown
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

// Start the server
startServer();

// Export functions (if needed)
module.exports = {
  generateProspectus,
  updateInquiryStatus,
  generateFilename,
  saveInquiryToDatabase,
  trackEngagementEvent,
  updateEngagementMetrics
};
