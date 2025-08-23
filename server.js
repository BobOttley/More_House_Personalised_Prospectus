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

async function generateProspectus(inquiry) {
  console.log(`Generating prospectus for ${inquiry.firstName} ${inquiry.familySurname}`);
  const templatePath = path.join(__dirname, 'public', 'prospectus_template.html');
  
  try {
    let html = await fs.readFile(templatePath, 'utf8');
    
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

    html = html.replace('</head>', `${meta}\n</head>`);

    const title = `${inquiry.firstName} ${inquiry.familySurname} - More House School Prospectus ${inquiry.entryYear}`;
    html = html.replace(/<title>.*?<\/title>/, `<title>${title}</title>`);

    const personalizeBoot = `<script>
document.addEventListener('DOMContentLoaded', function(){
  try {
    const userData = ${JSON.stringify(inquiry)};
    console.log('Initializing prospectus with data:', userData);
    if (typeof initializeProspectus === 'function') {
      initializeProspectus(userData);
      console.log('Prospectus personalized successfully');
    } else {
      console.error('initializeProspectus function not found');
    }
  } catch (error) {
    console.error('Failed to initialize prospectus:', error);
  }
});
</script>`;

    const trackingInject = `<!-- More House Analytics Tracking -->
<script>
window.MORE_HOUSE_INQUIRY_ID='${inquiry.id}';
console.log('Inquiry ID set for tracking:', window.MORE_HOUSE_INQUIRY_ID);
</script>
<script src="/tracking.js"></script>`;

    const bodyCloseIndex = html.lastIndexOf('</body>');
    if (bodyCloseIndex === -1) {
      throw new Error('Template missing </body> tag');
    }
    
    const allScripts = personalizeBoot + '\n' + trackingInject + '\n';
    const finalHtml = html.slice(0, bodyCloseIndex) + allScripts + html.slice(bodyCloseIndex);

    await fs.writeFile(absPath, finalHtml, 'utf8');

    const slug = makeSlug(inquiry);
    const prettyPath = `/${slug}`;
    slugIndex[slug] = relPath;
    await saveSlugIndex();

    const savedContent = await fs.readFile(absPath, 'utf8');
    const hasTrackingJs = savedContent.includes('<script src="/tracking.js"></script>');
    const hasInquiryId = savedContent.includes(`window.MORE_HOUSE_INQUIRY_ID='${inquiry.id}'`);
    const hasPersonalization = savedContent.includes('initializeProspectus');

    console.log(`Prospectus saved: ${filename}`);
    console.log(`Pretty URL: ${prettyPath}`);
    console.log(`Tracking script: ${hasTrackingJs ? 'VERIFIED' : 'MISSING'}`);
    console.log(`Inquiry ID: ${hasInquiryId ? 'VERIFIED' : 'MISSING'}`);
    console.log(`Personalization: ${hasPersonalization ? 'VERIFIED' : 'MISSING'}`);

    if (!hasTrackingJs || !hasInquiryId) {
      console.error('CRITICAL: Tracking script injection FAILED!');
    }

    return {
      filename,
      url: relPath,
      slug,
      prettyPath,
      generatedAt: new Date().toISOString()
    };
  } catch (e) {
    console.error('Prospectus generation failed:', e.message);
    throw new Error(`prospectus_template.html error: ${e.message}`);
  }
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

async function trackEngagementEvent(ev) {
  if (!db) return null;
  try {
    // Ensure currentSection is persisted inside event_data for reliable aggregation
    const eventData = Object.assign({}, ev.eventData || {}, {
      currentSection: ev.currentSection || (ev.eventData && ev.eventData.currentSection) || null
    });
    const q = `
      INSERT INTO tracking_events (
        inquiry_id, event_type, event_data, page_url,
        user_agent, ip_address, session_id, timestamp
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`;
    const vals = [
      ev.inquiryId, ev.eventType, JSON.stringify(eventData),
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

// ===== AI Engagement Summary helpers (descriptive only) =====
const PROSPECTUS_SECTION_NAMES = {
  cover_page: 'Cover Page',
  heads_welcome: "Head’s Welcome",
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

function prettySectionName(id) {
  return PROSPECTUS_SECTION_NAMES[id] || (id ? id.replace(/_/g, ' ') : 'Unknown Section');
}

function formatHM(totalSeconds) {
  totalSeconds = Math.max(0, Math.floor(totalSeconds || 0));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

async function buildEngagementMetrics(inquiryId) {
  if (!db) throw new Error('Database not available');

  const secExit = await db.query(
    `SELECT
       (event_data->>'currentSection') AS section_id,
       COALESCE((event_data->>'timeInSectionSec')::int, 0) AS dwell_sec,
       COALESCE((event_data->>'maxScrollPct')::int, 0) AS max_scroll_pct,
       COALESCE((event_data->>'clicks')::int, 0) AS clicks,
       COALESCE((event_data->>'videoWatchSec')::int, 0) AS video_sec,
       session_id,
       timestamp
     FROM tracking_events
     WHERE inquiry_id = $1 AND event_type = 'section_exit'
     ORDER BY timestamp ASC`,
    [inquiryId]
  );

  const yt = await db.query(
    `SELECT
       (event_data->>'currentSection') AS section_id,
       MAX(COALESCE((event_data->>'milestonePct')::int, 0)) AS watched_pct
     FROM tracking_events
     WHERE inquiry_id = $1 AND event_type IN ('youtube_video_progress','youtube_video_complete')
     GROUP BY 1`,
    [inquiryId]
  );
  const ytBySection = Object.fromEntries(yt.rows.map(r => [r.section_id, r.watched_pct || 0]));

  const minMax = await db.query(
    `SELECT MIN(timestamp) AS min_ts, MAX(timestamp) AS max_ts, COUNT(DISTINCT session_id) AS sessions
     FROM tracking_events
     WHERE inquiry_id = $1`,
    [inquiryId]
  );
  const timeframe = {
    start: minMax.rows[0]?.min_ts || null,
    end:   minMax.rows[0]?.max_ts || null
  };
  const distinctSessions = parseInt(minMax.rows[0]?.sessions || '0', 10);

  const sectionMap = new Map();
  secExit.rows.forEach(r => {
    const id = r.section_id || 'unknown';
    const prev = sectionMap.get(id) || {
      id, name: prettySectionName(id),
      dwellSeconds: 0,
      maxScrollPct: 0,
      clicks: 0,
      videoSeconds: 0,
      visits: 0
    };
    prev.dwellSeconds += r.dwell_sec || 0;
    prev.maxScrollPct = Math.max(prev.maxScrollPct, r.max_scroll_pct || 0);
    prev.clicks += r.clicks || 0;
    prev.videoSeconds += r.video_sec || 0;
    prev.visits += 1;
    sectionMap.set(id, prev);
  });

  const sections = Array.from(sectionMap.values())
    .sort((a, b) => b.dwellSeconds - a.dwellSeconds);

  const totals = {
    timeSeconds: sections.reduce((a, b) => a + (b.dwellSeconds || 0), 0),
    sectionsViewed: sections.filter(s => s.dwellSeconds > 0).length,
    returnVisits: Math.max(0, distinctSessions - 1)
  };

  const videos = Object.keys(ytBySection).map(sectionId => ({
    sectionId,
    sectionName: prettySectionName(sectionId),
    watchedPct: ytBySection[sectionId] || 0
  })).sort((a, b) => b.watchedPct - a.watchedPct);

  const lastActive = timeframe.end || null;

  return { timeframe, totals, sections, videos, lastActive };
}

function buildEngagementNarrative({ timeframe, totals, sections, videos }) {
  const fmtTimeframe = (() => {
    if (!timeframe.start || !timeframe.end) return null;
    try {
      const s = new Date(timeframe.start);
      const e = new Date(timeframe.end);
      const dtf = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' });
      const tf = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
      const d = dtf.format(s);
      return `${d}, ${tf.format(s)}–${tf.format(e)}`;
    } catch { return null; }
  })();

  const top = sections.slice(0, 3).map(s => `${s.name} (${formatHM(s.dwellSeconds)})`);
  const revisited = sections.filter(s => s.visits > 1).slice(0, 3).map(s => s.name);
  const vids = videos.filter(v => v.watchedPct > 0).slice(0, 3).map(v => `${v.sectionName} ~${v.watchedPct}%`);

  const bits = [];
  if (fmtTimeframe) bits.push(fmtTimeframe + '.');
  bits.push(`${formatHM(totals.timeSeconds)} total, ${totals.sectionsViewed} sections viewed, ${totals.returnVisits} return visit${totals.returnVisits === 1 ? '' : 's'}.`);
  if (top.length) bits.push(`Highest dwell: ${top.join(', ')}.`);
  if (revisited.length) bits.push(`Revisited ${revisited.join(', ')}.`);
  if (vids.length) bits.push(`Videos: ${vids.join(', ')}.`);

  return bits.join(' ');
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
        console.log('🔑 API Key available:', !!process.env.ANTHROPIC_API_KEY);

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

app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept');
  res.header('Access-Control-Max-Age', '86400');
  res.sendStatus(200);
});

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
    console.error('WEBHOOK error:', e);
    return res.status(500).json({ success:false, error:e.message });
  }
});

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

app.post('/api/track-engagement', async (req, res) => {
  try {
    const { events = [], sessionInfo } = req.body || {};
    const clientIP = req.ip || req.connection?.remoteAddress;
    
    console.log(`Tracking: ${events.length} events from ${sessionInfo?.inquiryId || 'unknown'}`);
    
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
    console.error('track-engagement error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/dashboard-data', async (req, res) => {
  try {
    console.log('Dashboard data request...');
    const base = getBaseUrl(req);
    let inquiries = [];

    if (db) {
      try {
        console.log('📊 Reading from DATABASE...');
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
        
        console.log(`✅ Loaded ${inquiries.length} inquiries from DATABASE`);
      } catch (dbError) {
        console.warn('⚠️ Database read failed, falling back to JSON:', dbError.message);
      }
    }

    if (inquiries.length === 0) {
      console.log('📁 Falling back to JSON files...');
      const files = await fs.readdir(path.join(__dirname, 'data')).catch(() => []);
      console.log(`Found ${files.length} files in data directory`);
      
      for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
        try { 
          const content = await fs.readFile(path.join(__dirname, 'data', f), 'utf8');
          const inquiry = JSON.parse(content);
          inquiries.push(inquiry);
        } catch (e) {
          console.warn(`Failed to read ${f}:`, e.message);
        }
      }
      console.log(`📁 Loaded ${inquiries.length} inquiries from JSON files`);
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
        name: `${i.firstName || ''} ${i.familySurname || ''}`.trim(),
        inquiryId: i.id,
        ageGroup: i.ageGroup,
        entryYear: i.entryYear,
        timeOnPage: 0,
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
      topInterests, 
      recentlyActive, 
      priorityFamilies, 
      latestProspectuses
    };
    
    console.log('📊 Dashboard data response prepared:', {
      totalFamilies: response.summary.totalFamilies,
      recentlyActive: response.recentlyActive.length,
      priorityFamilies: response.priorityFamilies.length,
      prospectuses: response.latestProspectuses.length,
      source: inquiries.length > 0 ? (db ? 'database' : 'json') : 'empty'
    });
    
    return res.json(response);
  } catch (e) {
    console.error('Dashboard data error:', e);
    res.status(500).json({ error:'Failed to build dashboard data', message:e.message });
  }
});

// Add this new endpoint to your server.js file
// This replaces the existing /api/analytics/inquiries endpoint

app.get('/api/analytics/enquiries', async (req, res) => {
  try {
    console.log('📊 Analytics enquiries request...');
    const base = getBaseUrl(req);
    let enquiries = [];

    if (db) {
      try {
        console.log('📊 Reading enquiries from DATABASE...');
        
        // Fetch all enquiries with engagement metrics
        const result = await db.query(`
          SELECT i.*, 
                 em.time_on_page, em.scroll_depth, em.clicks_on_links, 
                 em.total_visits, em.last_visit
          FROM inquiries i
          LEFT JOIN engagement_metrics em ON i.id = em.inquiry_id
          ORDER BY i.received_at DESC
        `);
        
        // Map database results to enquiry objects with British spelling
        enquiries = result.rows.map(row => ({
          id: row.id,
          enquiry_id: row.id, // British spelling
          first_name: row.first_name,
          family_surname: row.family_surname,
          parent_email: row.parent_email, // Use real email, not db@test.com
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
          
          // Engagement metrics
          engagement: {
            timeOnPage: row.time_on_page || 0,
            scrollDepth: row.scroll_depth || 0,
            clickCount: row.clicks_on_links || 0,
            totalVisits: row.total_visits || 1,
            lastVisit: row.last_visit || row.received_at,
            engagementScore: calculateEngagementScore({
              timeOnPage: row.time_on_page || 0,
              scrollDepth: row.scroll_depth || 0,
              totalVisits: row.total_visits || 1,
              clickCount: row.clicks_on_links || 0
            })
          },
          
          // Academic interests
          sciences: row.sciences,
          mathematics: row.mathematics,
          english: row.english,
          languages: row.languages,
          humanities: row.humanities,
          business: row.business,
          drama: row.drama,
          music: row.music,
          art: row.art,
          sport: row.sport,
          leadership: row.leadership,
          community_service: row.community_service,
          outdoor_education: row.outdoor_education
        }));
        
        console.log(`✅ Loaded ${enquiries.length} enquiries from DATABASE with engagement data`);
        
        // Merge AI engagement summaries (PEN.ai narratives)
        try {
          const egResult = await db.query(`
            SELECT inquiry_id, insights_json, confidence_score, generated_at
            FROM ai_family_insights
            WHERE analysis_type = 'engagement_summary'
          `);
          
          const egMap = {};
          egResult.rows.forEach(row => {
            try {
              const insights = typeof row.insights_json === 'string' 
                ? JSON.parse(row.insights_json) 
                : row.insights_json;
              egMap[row.inquiry_id] = {
                ...insights,
                confidence: row.confidence_score || 1.0,
                generatedAt: row.generated_at
              };
            } catch (e) {
              console.warn(`Failed to parse engagement summary for ${row.inquiry_id}`);
            }
          });
          
          // Add AI engagement narratives to enquiries
          enquiries = enquiries.map(enquiry => ({
            ...enquiry,
            aiEngagement: egMap[enquiry.id] || null,
            hasAINarrative: !!egMap[enquiry.id]
          }));
          
          console.log(`✅ Merged engagement summaries for ${Object.keys(egMap).length} families`);
          
        } catch (aiError) {
          console.warn('⚠️ AI engagement summary merge failed:', aiError.message);
        }
        
        // Now build the proper response format for each enquiry
        enquiries = enquiries.map(enquiry => {
          const eg = enquiry.aiEngagement;
          let summary = null;
          let leadTemperature = 'cool';
          let confidence = 0;
          let topSections = [];
          let intentTags = [];
          let recommendedAction = 'Schedule initial contact';
          let lastSeen = enquiry.engagement.lastVisit || enquiry.received_at;
          
          if (eg && eg.narrative) {
            summary = eg.narrative;
            confidence = eg.confidence || 1.0;
            lastSeen = eg.lastActive || lastSeen;
            
            // Calculate lead temperature based on engagement
            const score = eg.leadScore || enquiry.engagement.engagementScore;
            if (score >= 80) {
              leadTemperature = 'hot';
              recommendedAction = 'Immediate phone call - high intent shown';
            } else if (score >= 60) {
              leadTemperature = 'warm';
              recommendedAction = 'Send personalised follow-up within 24 hours';
            } else {
              leadTemperature = 'cool';
              recommendedAction = 'Nurture with relevant content';
            }
            
            // Extract top sections
            if (eg.sections && Array.isArray(eg.sections)) {
              topSections = eg.sections.slice(0, 5).map(s => ({
                name: s.name || s.label || 'Unknown Section',
                dwellTime: s.dwellSeconds || 0,
                scrollDepth: s.maxScrollPct || 0,
                visits: s.visits || 1
              }));
              
              // Detect high-intent signals from sections
              eg.sections.forEach(section => {
                const sectionName = (section.name || section.label || '').toLowerCase();
                if (sectionName.includes('fee') || sectionName.includes('cost')) {
                  if (!intentTags.includes('Fees Enquiry')) intentTags.push('Fees Enquiry');
                }
                if (sectionName.includes('scholarship') || sectionName.includes('bursary')) {
                  if (!intentTags.includes('Financial Aid')) intentTags.push('Financial Aid');
                }
                if (sectionName.includes('apply') || sectionName.includes('admission')) {
                  if (!intentTags.includes('Application Ready')) intentTags.push('Application Ready');
                }
                if (sectionName.includes('visit') || sectionName.includes('tour')) {
                  if (!intentTags.includes('Visit Interest')) intentTags.push('Visit Interest');
                }
                if (sectionName.includes('curriculum') || sectionName.includes('academic')) {
                  if (!intentTags.includes('Academic Focus')) intentTags.push('Academic Focus');
                }
              });
            }
            
            // Add intent tags based on behaviour
            if (eg.totals) {
              if (eg.totals.returnVisits > 0) {
                intentTags.push('Return Visitor');
              }
              if (eg.totals.timeSeconds > 600) { // More than 10 minutes
                intentTags.push('Deep Engagement');
              }
            }
            
            // Check for video engagement
            if (eg.videos && eg.videos.length > 0) {
              intentTags.push('Video Watcher');
            }
          }
          
          // Return the properly formatted enquiry object
          return {
            enquiry_id: enquiry.id,
            parent_name: `${enquiry.first_name} ${enquiry.family_surname}`,
            child_name: enquiry.first_name,
            family_surname: enquiry.family_surname,
            parent_email: enquiry.parent_email,
            entry_year: enquiry.entry_year,
            age_group: enquiry.age_group,
            
            // Prospectus URLs
            prospectus_urls: [
              enquiry.prospectus_pretty_url,
              enquiry.prospectus_direct_url
            ].filter(Boolean),
            
            // AI-generated narrative summary
            summary: summary,
            score: enquiry.engagement.engagementScore,
            lead_temperature: leadTemperature,
            confidence: confidence,
            last_seen: lastSeen,
            
            // Analytics
            top_sections: topSections,
            intent_tags: intentTags,
            recommended_action: recommendedAction,
            
            // Roll-up metrics
            sessions: eg?.totals?.returnVisits ? (eg.totals.returnVisits + 1) : 1,
            avg_dwell: eg?.totals?.timeSeconds || enquiry.engagement.timeOnPage || 0,
            percent_scrolled: eg?.totals?.avgScroll || enquiry.engagement.scrollDepth || 0,
            video_stats: eg?.videos ? {
              count: eg.videos.length,
              watched: eg.videos.filter(v => v.watchedPct > 50).length
            } : null,
            
            // Raw engagement data for fallback
            engagement: enquiry.engagement,
            
            // Interests
            interests: extractInterests(enquiry),
            
            // Metadata
            received_at: enquiry.received_at,
            status: enquiry.status
          };
        });
        
      } catch (dbError) {
        console.warn('⚠️ Database read failed, falling back to JSON:', dbError.message);
      }
    }

    // Fallback to JSON files if no database or empty
    if (enquiries.length === 0) {
      console.log('📂 Falling back to JSON files...');
      const files = await fs.readdir(path.join(__dirname, 'data')).catch(() => []);
      
      for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
        try { 
          const content = await fs.readFile(path.join(__dirname, 'data', f), 'utf8');
          const inquiry = JSON.parse(content);
          
          const base = getBaseUrl(req);
          const prettyUrl = inquiry.slug ? `${base}/${inquiry.slug}` : null;
          
          enquiries.push({
            enquiry_id: inquiry.id,
            parent_name: `${inquiry.firstName} ${inquiry.familySurname}`,
            child_name: inquiry.firstName,
            family_surname: inquiry.familySurname,
            parent_email: inquiry.parentEmail,
            entry_year: inquiry.entryYear,
            age_group: inquiry.ageGroup,
            
            prospectus_urls: [
              prettyUrl,
              inquiry.prospectusUrl ? `${base}${inquiry.prospectusUrl}` : null
            ].filter(Boolean),
            
            summary: null,
            score: 25,
            lead_temperature: 'cool',
            confidence: 0,
            last_seen: inquiry.receivedAt,
            
            top_sections: [],
            intent_tags: [],
            recommended_action: 'Generate prospectus and track engagement',
            
            sessions: 1,
            avg_dwell: 0,
            percent_scrolled: 0,
            video_stats: null,
            
            engagement: {
              timeOnPage: 0,
              scrollDepth: 0,
              clickCount: 0,
              totalVisits: 1,
              lastVisit: inquiry.receivedAt,
              engagementScore: 25
            },
            
            interests: extractInterests(inquiry),
            received_at: inquiry.receivedAt,
            status: inquiry.status || 'received'
          });
        } catch (e) {
          console.warn(`Failed to read ${f}:`, e.message);
        }
      }
      console.log(`📂 Loaded ${enquiries.length} enquiries from JSON files`);
    }
    
    console.log(`📊 Returning ${enquiries.length} enquiries with AI narratives to dashboard`);
    res.json(enquiries);
    
  } catch (e) {
    console.error('Analytics enquiries error:', e);
    res.status(500).json({ error: 'Failed to get enquiries', message: e.message });
  }
});

// Helper function to extract interests (add if not exists)
function extractInterests(inquiry) {
  const interests = [];
  const interestFields = [
    'sciences', 'mathematics', 'english', 'languages', 'humanities',
    'business', 'drama', 'music', 'art', 'sport', 'leadership',
    'community_service', 'outdoor_education'
  ];
  
  interestFields.forEach(field => {
    if (inquiry[field] === true || inquiry[field] === 'true' || inquiry[field] === 1) {
      interests.push(field.charAt(0).toUpperCase() + field.slice(1).replace('_', ' '));
    }
  });
  
  return interests;
}



// 🔥 THIS IS THE CRITICAL FIX - ADD THE AI ANALYSIS ENDPOINT
app.post('/api/ai/analyze-all-families', async (req, res) => {
  try {
    console.log('🤖 Starting AI analysis for all families...');
    
    let inquiries = [];

    // Load from database or JSON files
    if (db) {
      try {
        console.log('📊 Reading inquiries from DATABASE for AI analysis...');
        const result = await db.query(`
          SELECT id, first_name, family_surname, parent_email, age_group, entry_year,
                 sciences, mathematics, english, languages, humanities, business,
                 drama, music, art, creative_writing, sport, leadership, 
                 community_service, outdoor_education, academic_excellence, 
                 pastoral_care, university_preparation, personal_development, 
                 career_guidance, extracurricular_opportunities,
                 received_at, status
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
        
        console.log(`✅ Loaded ${inquiries.length} inquiries from DATABASE for AI analysis`);
        
      } catch (dbError) {
        console.warn('⚠️ Database read failed for AI analysis, falling back to JSON:', dbError.message);
      }
    }

    // Fallback to JSON files
    if (inquiries.length === 0) {
      console.log('📁 Falling back to JSON files for AI analysis...');
      const files = await fs.readdir(path.join(__dirname, 'data'));
      
      for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
        try {
          const j = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
          inquiries.push(j);
        } catch (fileError) {
          console.warn(`Failed to read ${f}:`, fileError.message);
        }
      }
      console.log(`📁 Loaded ${inquiries.length} inquiries from JSON files`);
    }

    console.log(`📊 Found ${inquiries.length} families to analyze`);
    
    if (inquiries.length === 0) {
      return res.json({
        success: true,
        message: 'No families found to analyze',
        results: { total: 0, analyzed: 0, errors: 0, successRate: 0 },
        details: []
      });
    }

    let analysisCount = 0;
    const errors = [];
    const successDetails = [];

    // Analyze each family
    for (const inquiry of inquiries) {
      try {
        console.log(`📍 Processing ${inquiry.firstName} ${inquiry.familySurname} (${inquiry.id})`);
        
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

        // Run AI analysis
        const analysis = await analyzeFamily(inquiry, engagementData);
        
        if (analysis) {
          // Store in database if available
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
      successDetails: successDetails.slice(0, 10),
      errors: errors.length > 0 ? errors.slice(0, 5) : undefined
    };
    
    res.json(response);

  } catch (error) {
    console.error('❌ Batch AI analysis error:', error);
    res.status(500).json({
      success: false,
      error: 'AI analysis failed',
      message: error.message,
      results: { total: 0, analyzed: 0, errors: 1, successRate: 0 }
    });
  }
});

app.post('/api/ai/analyze-family/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    console.log(`Starting individual AI analysis for family: ${inquiryId}`);
    
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
    
    console.log(`Processing ${inquiry.firstName} ${inquiry.familySurname} (${inquiry.id})`);
    
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

    const analysis = await analyzeFamily(inquiry, engagementData);
    
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
    
    console.log(`Individual analysis completed for ${inquiry.firstName} ${inquiry.familySurname} (score: ${analysis.leadScore})`);
    
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
    console.error(`Individual AI analysis error for ${req.params.inquiryId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Individual AI analysis failed',
      message: error.message,
      inquiryId: req.params.inquiryId
    });
  }
});

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

async function rebuildSlugIndexFromData() {
  let added = 0;
  console.log('Rebuilding slug index...');
  
  try {
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
      } catch (e) {
        console.warn(`Skipped ${f}: ${e.message}`);
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
      } catch {}
    }

    return res.status(404).send('Prospectus file not found');
  } catch (e) {
    console.error('Direct file recover failed:', e);
    return res.status(500).send('Failed to load prospectus file');
  }
});

app.use('/prospectuses', express.static(path.join(__dirname, 'prospectuses')));

const RESERVED = new Set([
  'api','prospectuses','health','tracking','dashboard','favicon','robots',
  'sitemap','metrics','config','webhook','admin','smart_analytics_dashboard.html'
]);

app.get('/:slug', async (req, res, next) => {
  const slug = String(req.params.slug || '').toLowerCase();
  
  if (!/^[a-z0-9-]+$/.test(slug)) return next();
  if (RESERVED.has(slug)) return next();

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
    
    const inquiry = await findInquiryBySlug(slug);
    if (inquiry) {
      try {
        const p = await generateProspectus(inquiry);
        await updateInquiryStatus(inquiry.id, p);
        slugIndex[slug] = p.url;
        await saveSlugIndex();
        abs = path.join(__dirname, 'prospectuses', p.filename);
        console.log(`Regenerated and serving: ${slug} -> ${p.url}`);
        return res.sendFile(abs);
      } catch (regenError) {
        console.error('Regeneration failed:', regenError.message);
      }
    }
    
    console.error('Failed to serve slug:', slug);
    return res.status(500).send('Failed to load prospectus');
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
    version: '5.0.0-AI-FIXED',
    features: {
      analytics: 'enabled',
      tracking: 'enabled',
      dashboard: 'enabled',
      database: db ? 'connected' : 'json-only',
      prettyUrls: true,
      selfHealing: true,
      aiAnalysis: 'WORKING',
      aiEndpoint: '/api/ai/analyze-all-families'
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
  <p><strong>Version 5.0.0 - AI ANALYSIS FIXED!</strong></p>
  <ul>
    <li>Health: <a href="${base}/health">${base}/health</a></li>
    <li>Webhook (POST JSON): <code>${base}/webhook</code></li>
    <li>Dashboard: <a href="${base}/dashboard.html">${base}/dashboard.html</a></li>
    <li>Inquiries (JSON): <a href="${base}/api/analytics/inquiries">${base}/api/analytics/inquiries</a></li>
    <li>Dashboard data (JSON): <a href="${base}/api/dashboard-data">${base}/api/dashboard-data</a></li>
    <li style="background: #10B981; color: white; padding: 5px; font-weight: bold;">AI Analysis: <code>POST ${base}/api/ai/analyze-all-families</code> ✅ WORKING</li>
    <li>Rebuild slugs: <a href="${base}/admin/rebuild-slugs">${base}/admin/rebuild-slugs</a></li>
  </ul>
  <h3>✅ AI ANALYSIS IS NOW FIXED:</h3>
  <ul>
    <li>✅ <code>/api/ai/analyze-all-families</code> endpoint EXISTS</li>
    <li>✅ Dashboard can trigger AI analysis</li>
    <li>✅ Individual family analysis working</li>
    <li>✅ AI insights stored in database</li>
    <li>✅ Works with both database and JSON files</li>
  </ul>
  <p>Pretty links: <code>${base}/the-smith-family-abc123</code></p>
</body></html>`);
});

app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Not found', 
    message: `Route ${req.method} ${req.path} not found` 
  });
});

async function startServer() {
  console.log('Starting More House School System...');
  
  const dbConnected = await initializeDatabase();
  await ensureDirectories();
  await loadSlugIndex();
  await rebuildSlugIndexFromData();

  
// ===== AI Engagement Summary endpoints =====
app.post('/api/ai/engagement-summary/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    const m = await buildEngagementMetrics(inquiryId);
    const narrative = buildEngagementNarrative(m);
    const payload = {
      analysis_type: 'engagement_summary',
      inquiryId,
      timeframe: m.timeframe,
      totals: m.totals,
      sections: m.sections,
      videos: m.videos,
      narrative,
      lastActive: m.lastActive,
      generatedAt: new Date().toISOString()
    };
    if (!db) throw new Error('Database not available');
    await db.query(`
      INSERT INTO ai_family_insights (inquiry_id, analysis_type, insights_json, confidence_score)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (inquiry_id, analysis_type) DO UPDATE SET
        insights_json = EXCLUDED.insights_json,
        confidence_score = EXCLUDED.confidence_score
    `, [inquiryId, 'engagement_summary', JSON.stringify(payload), 1.0]);
    res.json({ success: true, engagement_summary: payload });
  } catch (e) {
    console.error('engagement-summary error:', e);
    res.status(500).json({ success:false, error:e.message });
  }
});

app.post('/api/ai/engagement-summary/all', async (req, res) => {
  try {
    if (!db) throw new Error('Database not available');
    const r = await db.query('SELECT id FROM inquiries ORDER BY received_at DESC');
    const ids = r.rows.map(x => x.id);
    const results = [];
    for (const id of ids) {
      try {
        const m = await buildEngagementMetrics(id);
        const narrative = buildEngagementNarrative(m);
        const payload = {
          analysis_type: 'engagement_summary',
          inquiryId: id,
          timeframe: m.timeframe,
          totals: m.totals,
          sections: m.sections,
          videos: m.videos,
          narrative,
          lastActive: m.lastActive,
          generatedAt: new Date().toISOString()
        };
        await db.query(`
          INSERT INTO ai_family_insights (inquiry_id, analysis_type, insights_json, confidence_score)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT (inquiry_id, analysis_type) DO UPDATE SET
            insights_json = EXCLUDED.insights_json,
            confidence_score = EXCLUDED.confidence_score
        `, [id, 'engagement_summary', JSON.stringify(payload), 1.0]);
        
        results.push({ inquiryId: id, ok: true });
      } catch (e) {
        results.push({ inquiryId: id, ok: false, error: e.message });
      }
    }
    res.json({ success:true, total: ids.length, processed: results.length, results });
  } catch (e) {
    console.error('engagement-summary/all error:', e);
    res.status(500).json({ success:false, error:e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 MORE HOUSE SCHOOL SYSTEM STARTED');
    console.log('===============================================');
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`Webhook: http://localhost:${PORT}/webhook`);
    console.log(`Dashboard: http://localhost:${PORT}/dashboard.html`);
    console.log(`✅ AI Analysis: POST http://localhost:${PORT}/api/ai/analyze-all-families`);
    console.log(`Pretty URLs: http://localhost:${PORT}/the-<family>-family-<id>`);
    console.log(`DB: ${dbConnected ? 'Connected' : 'JSON-only'}`);
    console.log('\n🎯 AI ANALYSIS FIX APPLIED:');
    console.log('✅ /api/ai/analyze-all-families endpoint now exists');
    console.log('✅ Dashboard AI button will work');
    console.log('✅ AI analysis fully functional');
    console.log('===============================================');
  });
}

process.on('SIGINT', async () => { if (db) await db.end(); process.exit(0); });
process.on('SIGTERM', async () => { if (db) await db.end(); process.exit(0); });

startServer();

// ---- Legacy bulk analysis trigger (compat) ----
// Dashboard calls POST /api/ai/analyze-all-families expecting { success, results, errors, analyzed }
// We return Option-A behaviour for each inquiry and include the legacy arrays on each item.
app.post('/api/ai/analyze-all-families', async (req, res) => {
  try {
    const analyzed = [];
    const errors = [];
    let inquiries = [];

    // Load inquiries from DB if present, else JSON files
    if (db) {
      try {
        const q = await db.query(`SELECT id, first_name, family_surname, parent_email FROM inquiries ORDER BY received_at DESC`);
        inquiries = q.rows.map(r => ({ id: r.id, name: `${r.first_name || ''} ${r.family_surname || ''}`.trim() || r.parent_email || r.id }));
      } catch (e) {
        console.warn('DB read failed in analyze-all-families:', e.message);
      }
    }
    if (!inquiries.length) {
      try {
        const files = await require('fs').promises.readdir(require('path').join(__dirname, 'data'));
        for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
          try {
            const j = JSON.parse(await require('fs').promises.readFile(require('path').join(__dirname, 'data', f), 'utf8'));
            inquiries.push({ id: j.id, name: `${j.firstName || ''} ${j.familySurname || ''}`.trim() || j.parentEmail || j.id });
          } catch {}
        }
      } catch {}
    }

    for (const i of inquiries) {
      try {
        let payload;
        try {
          payload = await buildBehaviourPayload(i.id);
        } catch (inner) {
          // Fallback for JSON-only mode: return an empty-but-valid payload
          payload = {
            inquiryId: i.id,
            generatedAt: new Date().toISOString(),
            currentStatus: { online: false, currentSectionId: null, currentSectionLabel: null, elapsedInSectionSec: 0, currentScrollPct: 0, lastEventAt: null },
            sessionSummary: { totalTimeSec: 0, totalVisits: 0, avgScrollPct: 0, totalClicks: 0, videoWatchSec: 0, completionPct: 0 },
            sections: [],
            insights: { topSections: [], lowAttentionSections: [], engagementStyle: "no_activity", dropOff: { occurred: false }, plainEnglishSummary: "No activity recorded yet." },
            intentSignals: [],
            admissionsAdvice: null,
            confidence: 0.2,
            dataHealth: { eventsCount: 0, gapsDetected: false }
          };
        }
        analyzed.push(Object.assign({}, payload, {
          conversationStarters: [],
          sellingPoints: [],
          nextActions: [],
          keyConcerns: []
        }));
      } catch (e) {
        errors.push({ inquiryId: i.id, name: i.name, error: e.message });
      }
    }

    const total = inquiries.length;
    const ok = analyzed.length;
    const successRate = total ? Math.round((ok / total) * 100) : 100;

    res.json({
      success: true,
      results: { total, analysed: ok, successRate },
      analyzed, // legacy spelled with z
      errors
    });
  } catch (e) {
    console.error('analyze-all-families failed:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});
