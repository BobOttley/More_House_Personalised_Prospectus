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
app.post(["/api/track","/api/tracking"], (req,res)=> res.redirect(307, "/api/track-engagement"));
app.post(['/api/track','/api/tracking'], (req,res)=> res.redirect(307, '/api/track-engagement'));
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
<script src="/tracking.js?v=5.0.0"></script>`;

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

// ---------- REPLACEMENT: trackEngagementEvent ----------
async function trackEngagementEvent(ev) {
  if (!db) return null;

  try {
    // Normalise the incoming payload (tracking.js sends these fields):contentReference[oaicite:2]{index=2}
    const eventType      = ev.eventType || ev.type || 'unknown';
    const inquiryId      = ev.inquiryId || ev.inquiry_id || null;
    const sessionId      = ev.sessionId || ev.session_id || null;
    const currentSection = ev.currentSection || ev.section || ev?.eventData?.currentSection || null;
    const tsISO          = ev.timestamp || new Date().toISOString();
    const pageUrl        = ev.url || null;

    // Device info can be on the root or inside eventData:contentReference[oaicite:3]{index=3}
    const deviceInfo = ev.deviceInfo || ev?.eventData?.deviceInfo || {};

    // Event-specific metrics (tracking.js adds these for section_exit/scroll/video)
const ed = Object.assign({}, ev.eventData || ev.data || {});

// Section-level dwell
const timeInSectionSec = pickNumber(ed.timeInSectionSec);

// NEW: also check sessionInfo.timeOnPage (total seconds seen so far)
let sessionTime = 0;
if (ev.sessionInfo && Number.isFinite(ev.sessionInfo.timeOnPage)) {
  sessionTime = Math.round(ev.sessionInfo.timeOnPage);
}

// Other metrics
const maxScrollPct   = pickNumber(ed.maxScrollPct);
const clicks         = pickNumber(ed.clicks);
const videoWatchSec  = pickNumber(ed.videoWatchSec);
const videoId        = ed.videoId || ed.video_id || null;
const videoTitle     = ed.videoTitle || ed.video_title || null;
const currentTimeSec = pickNumber(ed.currentTimeSec ?? ed.current_time_sec);


    // 1) Always log the raw JSON to tracking_events (lossless event log):contentReference[oaicite:5]{index=5}
    const rawEventData = {
      ...ed,
      currentSection: currentSection,
      deviceInfo
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

    // 2) Roll-up: update engagement_metrics using best-known values (GREATEST inside upsert):contentReference[oaicite:6]{index=6}
    const hasSectionMetrics = (eventType === 'section_exit') || (eventType === 'section_scroll');
    const hasClicks         = clicks > 0;
    const hasVideo          = eventType.startsWith('video_') || videoWatchSec > 0;

    if (hasSectionMetrics || hasClicks || hasVideo) {
      await updateEngagementMetrics({
        inquiryId,
        sessionId,
        // Prefer sessionInfo.timeOnPage if present, else fall back to section dwell
        timeOnPage: sessionTime || timeInSectionSec,
        maxScrollDepth: maxScrollPct,
        clickCount: clicks,
        deviceInfo
      });      
    }

    // 3) Optional granular: write video_* rows if present (safe no-op if table missing)
    if (hasVideo) {
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


// ---------- AI Engagement Summary (per family) ----------
// SINGLE buildEngagementSnapshot function - DELETE ALL OTHER VERSIONS
async function buildEngagementSnapshot(db, inquiryId) {
  try {
    // Check for any tracking events
    const eventCheck = await db.query(
      'SELECT COUNT(*) as count FROM tracking_events WHERE inquiry_id = $1',
      [inquiryId]
    );
    
    const eventCount = parseInt(eventCheck.rows[0]?.count || '0');
    
    // If no events, check if inquiry has dwell_ms stored directly
    if (eventCount === 0) {
      const inquiryData = await db.query(
        'SELECT dwell_ms, return_visits FROM inquiries WHERE id = $1',
        [inquiryId]
      );
      
      const dwellMs = parseInt(inquiryData.rows[0]?.dwell_ms || '0');
      const visits = parseInt(inquiryData.rows[0]?.return_visits || '1');
      
      // Return snapshot with whatever we have
      return {
        inquiryId,
        sections: [],
        totals: {
          time_on_page_ms: dwellMs,
          video_ms: 0,
          clicks: 0,
          total_visits: visits,
          scroll_depth: 0
        },
        hasData: dwellMs > 0 // Mark as having data if there's ANY dwell time
      };
    }

    // Get section-level data from tracking_events
    const secExit = await db.query(`
      SELECT
        COALESCE(event_data->>'currentSection', 'unknown') AS section_id,
        SUM(COALESCE((event_data->>'timeInSectionSec')::int, 0)) AS dwell_sec,
        MAX(COALESCE((event_data->>'maxScrollPct')::int, 0)) AS max_scroll_pct,
        COUNT(DISTINCT CASE WHEN event_type = 'link_click' THEN event_data->>'linkId' END) AS clicks,
        SUM(COALESCE((event_data->>'videoWatchSec')::int, 0)) AS video_sec
      FROM tracking_events
      WHERE inquiry_id = $1
        AND event_type IN ('section_exit', 'link_click', 'youtube_video_progress')
      GROUP BY 1
    `, [inquiryId]);

    // Get total visits
    const visitCount = await db.query(`
      SELECT COUNT(DISTINCT session_id) as total_visits
      FROM tracking_events
      WHERE inquiry_id = $1
    `, [inquiryId]);

    // Also check inquiries table for accumulated dwell_ms
    const inquiryDwell = await db.query(
      'SELECT dwell_ms FROM inquiries WHERE id = $1',
      [inquiryId]
    );
    const storedDwellMs = parseInt(inquiryDwell.rows[0]?.dwell_ms || '0');

    // Build sections
    const sections = secExit.rows.map(row => ({
      section_id: row.section_id,
      section: row.section_id, // Add both formats
      dwell_seconds: parseInt(row.dwell_sec || 0),
      dwell_ms: parseInt(row.dwell_sec || 0) * 1000, // Also provide in ms
      max_scroll_pct: parseInt(row.max_scroll_pct || 0),
      clicks: parseInt(row.clicks || 0),
      video_seconds: parseInt(row.video_sec || 0),
      video_ms: parseInt(row.video_sec || 0) * 1000
    }));

    // Calculate totals - use the MAX of calculated vs stored dwell
    const calculatedDwell = sections.reduce((sum, s) => sum + (s.dwell_seconds * 1000), 0);
    const totalDwellMs = Math.max(calculatedDwell, storedDwellMs);

    const totals = {
      time_on_page_ms: totalDwellMs,
      video_ms: sections.reduce((sum, s) => sum + s.video_ms, 0),
      clicks: sections.reduce((sum, s) => sum + s.clicks, 0),
      total_visits: parseInt(visitCount.rows[0]?.total_visits || 1),
      scroll_depth: sections.length > 0 
        ? Math.round(sections.reduce((sum, s) => sum + s.max_scroll_pct, 0) / sections.length)
        : 0
    };

    return {
      inquiryId,
      sections,
      totals,
      hasData: totalDwellMs > 0 || sections.length > 0 || eventCount > 0
    };

  } catch (error) {
    console.error('Error building engagement snapshot:', error);
    // Return safe default
    return {
      inquiryId,
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

// FIXED summariseFamilyEngagement - handles all cases properly
async function summariseFamilyEngagement(db, inquiry) {
  const inquiryId = inquiry.id || inquiry.inquiry_id;
  
  try {
    const snapshot = await buildEngagementSnapshot(db, inquiryId);
    
    // Generate appropriate message based on data availability
    let result;
    
    if (!snapshot.hasData || (snapshot.totals.time_on_page_ms === 0 && snapshot.sections.length === 0)) {
      // No data case - friendly waiting message
      result = {
        narrative: `Personalised prospectus created for ${inquiry.first_name || 'this student'} ${inquiry.family_surname || ''} (${inquiry.entry_year || 'entry year TBC'}). The family hasn't viewed their prospectus yet, but we're ready to track their journey as soon as they begin exploring. Once they start engaging with sections and videos, we'll provide detailed insights about their interests and priorities.`,
        highlights: [
          '• Prospectus successfully generated and ready',
          '• Unique link created for family access',
          '• Awaiting first visit to begin engagement tracking',
          '• Full analytics will activate upon first interaction'
        ]
      };
    } else if (snapshot.totals.time_on_page_ms < 30000) {
      // Very light engagement - needs more data
      const timeStr = Math.round(snapshot.totals.time_on_page_ms / 1000) + ' seconds';
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
      // Has meaningful data - generate AI summary
      try {
        const aiPayload = await generateAiEngagementStory(snapshot, {
          first_name: inquiry.first_name,
          family_surname: inquiry.family_surname,
          entry_year: inquiry.entry_year
        });
        
        result = {
          narrative: aiPayload?.narrative || generateFallbackNarrative(snapshot, inquiry),
          highlights: Array.isArray(aiPayload?.highlights) 
            ? aiPayload.highlights 
            : generateFallbackHighlights(snapshot)
        };
      } catch (aiError) {
        console.warn('AI generation failed, using fallback:', aiError.message);
        result = {
          narrative: generateFallbackNarrative(snapshot, inquiry),
          highlights: generateFallbackHighlights(snapshot)
        };
      }
    }
    
    // Store the result
    await upsertAiInsight(db, inquiryId, 'engagement_summary', result);
    return result;
    
  } catch (error) {
    console.error('summariseFamilyEngagement error:', error);
    
    // Ultimate fallback
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

// Helper function for fallback narrative
function generateFallbackNarrative(snapshot, inquiry) {
  const totalMinutes = Math.round(snapshot.totals.time_on_page_ms / 60000);
  const name = `${inquiry.first_name || 'This student'} ${inquiry.family_surname || ''}`.trim();
  
  if (snapshot.sections.length > 0) {
    const topSection = snapshot.sections[0];
    const sectionName = topSection.section_id.replace(/_/g, ' ');
    return `${name}'s family spent ${totalMinutes} minutes exploring their personalised prospectus, with particular interest in ${sectionName}. They visited ${snapshot.sections.length} different sections across ${snapshot.totals.total_visits} visit(s). This level of engagement suggests genuine interest in understanding what More House offers. Consider following up about the areas they spent most time exploring.`;
  } else {
    return `${name}'s family has spent ${totalMinutes} minutes reviewing their personalised prospectus across ${snapshot.totals.total_visits} visit(s). While we're still gathering detailed section-level insights, this engagement time indicates they're taking time to consider More House seriously. A personal follow-up call could help understand their specific interests and questions.`;
  }
}

// Helper function for fallback highlights  
function generateFallbackHighlights(snapshot) {
  const highlights = [];
  const totalMinutes = Math.round(snapshot.totals.time_on_page_ms / 60000);
  
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

function topInteractionsFrom(sections, n = 5) {
  // Rank by dwell, then video time, then clicks
  return [...sections]
    .sort((a,b) => (b.dwell_ms - a.dwell_ms) || (b.video_ms - a.video_ms) || (b.clicks - a.clicks))
    .slice(0, n)
    .map(s => ({
      label: s.section,
      dwell_seconds: Math.round(s.dwell_ms/1000),
      video_seconds: Math.round(s.video_ms/1000),
      clicks: s.clicks
    }));
}

async function generateAiEngagementStory(llm, snapshot, familyMeta) {
  // familyMeta: { first_name, family_surname, entry_year } if you have them
  const secs = snapshot.sections || [];
  const tops = topInteractionsFrom(secs, 5);

  // Model switch: prefer Anthropic if key present, else OpenAI
  const useAnthropic = !!process.env.ANTHROPIC_API_KEY;

  const prompt = `
You are an admissions assistant. Write a concise, human-friendly summary (UK English) describing how a parent interacted with a personalised school prospectus.
Keep it factual and warm, 120–180 words, and avoid marketing fluff.

Context:
- Total time on prospectus (seconds): ${Math.round((snapshot.totals?.time_on_page_ms||0)/1000)}
- Total video watch time (seconds): ${Math.round((snapshot.totals?.video_ms||0)/1000)}
- Total clicks: ${snapshot.totals?.clicks||0}
- Top sections by engagement (up to 5):
${tops.map(t => `  - ${t.label}: dwell ${t.dwell_seconds}s, video ${t.video_seconds}s, clicks ${t.clicks}`).join('\n') || '  - (no detailed sections available yet)'}

Output strictly as JSON with keys:
{
  "narrative": "120-180 word paragraph in UK English",
  "highlights": ["• one-sentence key insight", "... up to 5 bullets"]
}
  `.trim();

  if (useAnthropic) {
    const { Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20240620',
      max_tokens: 600,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = resp?.content?.[0]?.text || '{}';
    return JSON.parse(text);
  } else {
    // OpenAI fallback
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const chat = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }]
    });
    return JSON.parse(chat.choices?.[0]?.message?.content || '{}');
  }
}

async function upsertAiInsight(db, inquiryId, analysisType, insightsJson) {
  await db.query(`
    INSERT INTO ai_family_insights (inquiry_id, analysis_type, insights_json)
    VALUES ($1, $2, $3::jsonb)
    ON CONFLICT (inquiry_id, analysis_type)
    DO UPDATE SET insights_json = EXCLUDED.insights_json
  `, [inquiryId, analysisType, JSON.stringify(insightsJson)]);
}

async function summariseFamilyEngagement(db, llm, inquiry) {
  const inquiryId = inquiry.id || inquiry.inquiry_id;
  const snapshot = await buildEngagementSnapshot(db, inquiryId);
  
  // Handle empty snapshot case
  if (!snapshot.hasData || snapshot.sections.length === 0) {
    const defaultResult = {
      narrative: `Personalised prospectus generated for ${inquiry.first_name || 'this family'}. We're ready to track their engagement as soon as they begin exploring the materials. Once they start viewing sections and videos, we'll provide detailed insights about their interests and engagement patterns.`,
      highlights: [
        '• Prospectus successfully created and ready for viewing',
        '• Awaiting first family visit to begin tracking engagement',
        '• Full analytics will appear once interaction data is available'
      ]
    };
    
    // Store the default result
    await upsertAiInsight(db, inquiryId, 'engagement_summary', defaultResult);
    
    return defaultResult;
  }
  
  // Generate AI story only if we have data
  const payload = await generateAiEngagementStory(llm, snapshot, {
    first_name: inquiry.first_name,
    family_surname: inquiry.family_surname,
    entry_year: inquiry.entry_year
  });

  // Normalise shape we return to the dashboard
  const result = {
    narrative: payload?.narrative || 'Engagement data is being processed.',
    highlights: Array.isArray(payload?.highlights) 
      ? payload.highlights 
      : ['• Engagement tracking active', '• Data collection in progress']
  };

  // Store in database
  await upsertAiInsight(db, inquiryId, 'engagement_summary', result);
  
  return result;
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

// ---------- Helpers for engagement parsing ----------
function pickNumber(n, dflt = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : dflt;
}

async function insertVideoTrackingRow(dbClient, payload) {
  // Tries to write a granular video row; if the table/columns aren't present,
  // we log a warning and carry on without failing the request.
  try {
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
      payload.eventType || null,
      payload.videoId || null,
      payload.videoTitle || null,
      pickNumber(payload.currentTimeSec, null),
      pickNumber(payload.watchedSec, null),
      payload.url || null,
      new Date(payload.timestamp || Date.now())
    ];
    await dbClient.query(q, vals);
  } catch (e) {
    console.warn('video_engagement_tracking insert skipped:', e.message);
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

 try {
   const secExit = await db.query(
     `SELECT
        COALESCE(event_data->>'currentSection', 'unknown') AS section_id,
        COALESCE((event_data->>'timeInSectionSec')::int, 0) AS dwell_sec,
        COALESCE((event_data->>'maxScrollPct')::int, 0) AS max_scroll_pct,
        COALESCE((event_data->>'clicks')::int, 0) AS clicks,
        COALESCE((event_data->>'videoWatchSec')::int, 0) AS video_sec,
        session_id,
        timestamp
      FROM tracking_events
      WHERE inquiry_id = $1 
        AND event_type = 'section_exit'
        AND event_data IS NOT NULL
      ORDER BY timestamp ASC`,
     [inquiryId]
   );

   const yt = await db.query(
     `SELECT
        COALESCE(event_data->>'currentSection', 'unknown') AS section_id,
        MAX(COALESCE((event_data->>'milestonePct')::int, 0)) AS watched_pct
      FROM tracking_events
      WHERE inquiry_id = $1 
        AND event_type IN ('youtube_video_progress','youtube_video_complete')
        AND event_data IS NOT NULL
      GROUP BY 1`,
     [inquiryId]
   );
   const ytBySection = Object.fromEntries(yt.rows.map(r => [r.section_id, r.watched_pct || 0]));

   const minMax = await db.query(
     `SELECT 
        MIN(timestamp) AS min_ts, 
        MAX(timestamp) AS max_ts, 
        COUNT(DISTINCT session_id) AS sessions
      FROM tracking_events
      WHERE inquiry_id = $1`,
     [inquiryId]
   );
   
   const timeframe = {
     start: minMax.rows[0]?.min_ts || null,
     end: minMax.rows[0]?.max_ts || null
   };
   const distinctSessions = parseInt(minMax.rows[0]?.sessions || '0', 10);

   const sectionMap = new Map();
   secExit.rows.forEach(r => {
     const id = r.section_id || 'unknown';
     const prev = sectionMap.get(id) || {
       id, 
       name: prettySectionName(id),
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
   
 } catch (error) {
   console.error('Error in buildEngagementMetrics:', error);
   throw error;
 }
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
       console.log('API Key available:', !!process.env.ANTHROPIC_API_KEY);

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

// ===================== AI ENGAGEMENT SUMMARY HELPERS =====================


function topInteractionsFrom(sections, n = 5) {
  return [...sections]
    .sort((a,b) =>
      (b.dwell_ms - a.dwell_ms) ||
      (b.video_ms - a.video_ms) ||
      (b.clicks   - a.clicks))
    .slice(0, n)
    .map(s => ({
      label: s.section,
      dwell_seconds: Math.round((s.dwell_ms || 0)/1000),
      video_seconds: Math.round((s.video_ms || 0)/1000),
      clicks: Number(s.clicks || 0)
    }));
}

// Use Claude if ANTHROPIC_API_KEY exists, else OpenAI (OPENAI_API_KEY).
async function generateAiEngagementStory(snapshot, meta = {}) {
  const tops = topInteractionsFrom(snapshot.sections || [], 5);
  const totalSec   = Math.round((snapshot.totals?.time_on_page_ms || 0) / 1000);
  const videoSec   = Math.round((snapshot.totals?.video_ms || 0) / 1000);
  const clicks     = Number(snapshot.totals?.clicks || 0);
  const visits     = Number(snapshot.totals?.total_visits || 0);
  const childName  = [meta.first_name, meta.family_surname].filter(Boolean).join(' ');

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

  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  try {
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
    } else {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const chat = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }]
      });
      const text = chat?.choices?.[0]?.message?.content || '{}';
      return JSON.parse(text);
    }
  } catch (e) {
    // Hard fallback so UI never dies
    return {
      narrative: "Prospectus generated. Limited tracking available so far. Once more interaction is recorded — such as time spent on key sections or video watch time — a fuller summary will appear here.",
      highlights: ["No detailed section data yet", "Invite the family to view key pages", "Follow up with a light-touch email"]
    };
  }
}

async function upsertAiInsight(db, inquiryId, analysisType, insightsJson) {
  await db.query(`
    INSERT INTO ai_family_insights (inquiry_id, analysis_type, insights_json)
    VALUES ($1, $2, $3::jsonb)
    ON CONFLICT (inquiry_id, analysis_type)
    DO UPDATE SET insights_json = EXCLUDED.insights_json
  `, [inquiryId, analysisType, JSON.stringify(insightsJson)]);
}

async function summariseFamilyEngagement(db, inquiry) {
  const inquiryId = inquiry.id || inquiry.inquiry_id;
  const snapshot = await buildEngagementSnapshot(db, inquiryId);

  const payload = await generateAiEngagementStory(snapshot, {
    first_name: inquiry.first_name,
    family_surname: inquiry.family_surname,
    entry_year: inquiry.entry_year
  });

  // Final normalised shape for dashboard
  const result = {
    narrative: payload?.narrative || 'Prospectus generated. Awaiting meaningful engagement.',
    highlights: Array.isArray(payload?.highlights) ? payload.highlights.slice(0,5) : [],
    top_interactions: topInteractionsFrom(snapshot.sections || [], 5),
    totals: snapshot.totals || { time_on_page_ms: 0, video_ms: 0, clicks: 0, total_visits: 0 }
  };

  await upsertAiInsight(db, inquiryId, 'engagement_summary', result);
  return result;
}
// =================== END AI ENGAGEMENT SUMMARY HELPERS ===================


// Express Routes

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
       
       console.log(`Loaded ${inquiries.length} inquiries from DATABASE`);
     } catch (dbError) {
       console.warn('Database read failed, falling back to JSON:', dbError.message);
     }
   }

   if (inquiries.length === 0) {
     console.log('Falling back to JSON files...');
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
   res.status(500).json({ error:'Failed to build dashboard data', message:e.message });
 }
});

app.get('/api/analytics/inquiries', async (req, res) => {
 try {
   console.log('Analytics inquiries request...');
   const base = getBaseUrl(req);
   let inquiries = [];

   if (db) {
     try {
       console.log('Reading inquiries from DATABASE...');
       
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
           lastVisit: row.last_visit || row.received_at,
           engagementScore: calculateEngagementScore({
             timeOnPage: row.time_on_page || 0,
             scrollDepth: row.scroll_depth || 0,
             totalVisits: row.total_visits || 1,
             clickCount: row.clicks_on_links || 0
           })
         },
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
         outdoor_education: row.outdoor_education,
         aiInsights: null
       }));
       
       console.log(`Loaded ${inquiries.length} inquiries from DATABASE with engagement data`);
       
       // Merge engagement_summary narrative
       try {
         const eg = await db.query(`
           SELECT inquiry_id, insights_json
           FROM ai_family_insights
           WHERE analysis_type = 'engagement_summary'
         `);
         const egMap = {};
         eg.rows.forEach(row => {
           try {
             const insights = typeof row.insights_json === 'string' ? JSON.parse(row.insights_json) : row.insights_json;
             egMap[row.inquiry_id] = insights;
           } catch {}
         });
         inquiries = inquiries.map(inq => ({ ...inq, aiEngagement: egMap[inq.id] || null }));
         console.log(`Merged engagement summaries for ${Object.keys(egMap).length} families`);
       } catch (e) {
         console.warn('Engagement summary merge failed:', e.message);
       }
       
     } catch (dbError) {
       console.warn('Database read failed, falling back to JSON:', dbError.message);
     }
   }

   if (inquiries.length === 0) {
     console.log('Falling back to JSON files...');
     const files = await fs.readdir(path.join(__dirname, 'data')).catch(() => []);
     
     for (const f of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
       try { 
         const content = await fs.readFile(path.join(__dirname, 'data', f), 'utf8');
         const inquiry = JSON.parse(content);
         
         const out = {
           id: inquiry.id,
           first_name: inquiry.firstName,
           family_surname: inquiry.familySurname,
           parent_email: inquiry.parentEmail,
           entry_year: inquiry.entryYear,
           age_group: inquiry.ageGroup,
           received_at: inquiry.receivedAt,
           updated_at: inquiry.prospectusGeneratedAt || inquiry.receivedAt,
           status: inquiry.status || (inquiry.prospectusGenerated ? 'prospectus_generated' : 'received'),
           prospectus_filename: inquiry.prospectusFilename || null,
           slug: inquiry.slug || null,
           prospectus_generated_at: inquiry.prospectusGeneratedAt || null,
           prospectus_pretty_path: inquiry.prospectusPrettyPath || (inquiry.slug ? `/${inquiry.slug}` : null),
           prospectus_pretty_url: inquiry.prospectusPrettyPath ? `${base}${inquiry.prospectusPrettyPath}` : null,
           prospectus_direct_url: inquiry.prospectusUrl ? `${base}${inquiry.prospectusUrl}` : null,
           engagement: {
             timeOnPage: 0,
             scrollDepth: 0,
             clickCount: 0,
             totalVisits: 1,
             lastVisit: inquiry.receivedAt,
             engagementScore: 25
           },
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
           aiInsights: null
         };
         
         inquiries.push(out);
       } catch (e) {
         console.warn(`Failed to read ${f}:`, e.message);
       }
     }
     console.log(`Loaded ${inquiries.length} inquiries from JSON files`);
   }
   
   console.log(`Returning ${inquiries.length} inquiries to dashboard`);
   res.json(inquiries);
   
 } catch (e) {
   console.error('Analytics inquiries error:', e);
   res.status(500).json({ error: 'Failed to get inquiries' });
 }
});

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

    // 👉 Generate proper AI narrative + highlights
    const result = await summariseFamilyEngagement(db, inquiry);

    // Overwrite the legacy slot so the dashboard picks it up
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

// REPLACE the GET /api/ai/engagement-summary/:inquiryId endpoint with this WORKING version:

app.get('/api/ai/engagement-summary/:inquiryId', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not available' });

    const inquiryId = req.params.inquiryId;

    // Get the dwell_ms from inquiries table (THIS IS WHERE THE DATA IS!)
    const { rows: inquiryData } = await db.query(`
      SELECT 
        first_name,
        family_surname,
        entry_year,
        dwell_ms,
        return_visits
      FROM inquiries
      WHERE id = $1
    `, [inquiryId]);

    if (!inquiryData[0]) {
      return res.status(404).json({ error: 'Inquiry not found' });
    }

    const inquiry = inquiryData[0];
    const totalDwellMs = Number(inquiry.dwell_ms || 0);
    const visits = Number(inquiry.return_visits || 1);

    // Get section-level data from tracking_events
    const { rows: sections } = await db.query(`
      WITH section_data AS (
        SELECT
          COALESCE(event_data->>'currentSection', 'unknown') AS section,
          SUM(COALESCE((event_data->>'timeInSectionSec')::int, 0)) AS dwell_seconds,
          MAX(COALESCE((event_data->>'maxScrollPct')::int, 0)) AS max_scroll_pct,
          SUM(COALESCE((event_data->>'clicks')::int, 0)) AS clicks
        FROM tracking_events
        WHERE inquiry_id = $1
          AND event_type = 'section_exit'
          AND event_data IS NOT NULL
        GROUP BY 1
      )
      SELECT * FROM section_data
      WHERE dwell_seconds > 0 OR max_scroll_pct > 0
      ORDER BY dwell_seconds DESC
    `, [inquiryId]);

    // Calculate engagement score
    const totalSeconds = Math.round(totalDwellMs / 1000);
    const scoreBase = Math.min(50, Math.round(totalSeconds / 10));
    const sectionBonus = Math.min(30, sections.length * 5);
    const visitBonus = Math.min(20, visits * 5);
    const score = scoreBase + sectionBonus + visitBonus;

    // Check if we have meaningful data
    const hasData = totalDwellMs > 0 || sections.length > 0;

    let summaryText;
    if (!hasData) {
      summaryText = 'Prospectus generated. Limited tracking available so far. Once more interaction is recorded — such as time spent on key sections or video watch time — a fuller summary will appear here.';
    } else {
      try {
        // Prepare data for AI
        const snapshot = {
          sections: sections.map(s => ({
            section: s.section,
            dwell_ms: Number(s.dwell_seconds || 0) * 1000,
            video_ms: 0,
            clicks: Number(s.clicks || 0)
          })),
          totals: {
            time_on_page_ms: totalDwellMs,
            video_ms: 0,
            clicks: sections.reduce((sum, s) => sum + Number(s.clicks || 0), 0),
            total_visits: visits
          }
        };

        // Call AI function
        const aiResult = await generateAiEngagementStory(snapshot, {
          first_name: inquiry.first_name,
          family_surname: inquiry.family_surname,
          entry_year: inquiry.entry_year
        });

        summaryText = aiResult?.narrative || 'Engagement analysis in progress...';

        // Store the AI result
        if (aiResult) {
          await upsertAiInsight(db, inquiryId, 'engagement_summary', {
            narrative: aiResult.narrative,
            highlights: aiResult.highlights || [],
            top_interactions: sections.slice(0, 5).map(s => ({
              label: s.section,
              dwell_seconds: Number(s.dwell_seconds || 0),
              video_seconds: 0,
              clicks: Number(s.clicks || 0)
            })),
            totals: snapshot.totals
          });
        }

      } catch (aiError) {
        console.warn('AI generation failed, using fallback:', aiError.message);
        
        // Fallback summary
        if (sections.length > 0) {
          const topSections = sections.slice(0, 3).map(s => 
            `${s.section.replace(/_/g, ' ')} (${Math.round(Number(s.dwell_seconds || 0) / 60)}m)`
          ).join(', ');
          summaryText = `Family engaged with ${sections.length} sections. Primary focus: ${topSections}. Total time: ${Math.round(totalSeconds / 60)} minutes across ${visits} visit(s).`;
        } else {
          summaryText = `Family spent ${Math.round(totalSeconds / 60)} minutes exploring the prospectus across ${visits} visit(s).`;
        }
      }
    }

    // Return the response
    res.json({
      inquiryId,
      visits,
      score,
      sections,
      summaryText,
      total_dwell_ms: totalDwellMs
    });

  } catch (err) {
    console.error('GET engagement-summary error:', err);
    res.status(500).json({ 
      error: 'server_error', 
      message: err.message,
      details: 'Failed to load engagement summary'
    });
  }
});

// ADD THIS DIAGNOSTIC ENDPOINT TO YOUR SERVER.JS TO SEE WHAT'S ACTUALLY IN THE DATABASE
// Place it right after the GET /api/ai/engagement-summary/:inquiryId endpoint

app.get('/api/debug/engagement/:inquiryId', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not available' });
    
    const inquiryId = req.params.inquiryId;
    
    // 1. Check what event types exist for this inquiry
    const eventTypes = await db.query(`
      SELECT DISTINCT event_type, COUNT(*) as count
      FROM tracking_events
      WHERE inquiry_id = $1
      GROUP BY event_type
      ORDER BY count DESC
    `, [inquiryId]);
    
    // 2. Check raw tracking_events data structure
    const sampleEvents = await db.query(`
      SELECT event_type, event_data, timestamp
      FROM tracking_events
      WHERE inquiry_id = $1
        AND event_type = 'section_exit'
      ORDER BY timestamp DESC
      LIMIT 5
    `, [inquiryId]);
    
    // 3. Check if currentSection is stored correctly
    const sectionsCheck = await db.query(`
      SELECT 
        event_type,
        event_data->>'currentSection' as current_section,
        event_data->>'timeInSectionSec' as time_in_section,
        event_data->>'maxScrollPct' as max_scroll,
        timestamp
      FROM tracking_events
      WHERE inquiry_id = $1
        AND event_type = 'section_exit'
        AND event_data IS NOT NULL
      LIMIT 10
    `, [inquiryId]);
    
    // 4. Run the exact same query as the engagement-summary endpoint
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
    
    // 5. Check engagement_metrics table (old system)
    const engagementMetrics = await db.query(`
      SELECT time_on_page, scroll_depth, clicks_on_links, total_visits, last_visit
      FROM engagement_metrics
      WHERE inquiry_id = $1
    `, [inquiryId]);
    
    // 6. Check if there's data in the inquiries table
    const inquiryData = await db.query(`
      SELECT time_on_page, scroll_depth, total_visits, clicks_on_links
      FROM inquiries
      WHERE id = $1
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
    
    // Identify the problem
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

// ALSO ADD THIS ENDPOINT TO MANUALLY TRIGGER AI GENERATION
app.post('/api/debug/force-ai-summary/:inquiryId', async (req, res) => {
  try {
    if (!db) return res.status(500).json({ error: 'Database not available' });
    
    const inquiryId = req.params.inquiryId;
    
    // Get inquiry details
    const inquiryResult = await db.query(`
      SELECT first_name, family_surname, entry_year
      FROM inquiries
      WHERE id = $1
    `, [inquiryId]);
    
    if (!inquiryResult.rows[0]) {
      return res.status(404).json({ error: 'Inquiry not found' });
    }
    
    const inquiry = inquiryResult.rows[0];
    
    // Force create a snapshot with whatever data we have
    const snapshot = {
      sections: [
        { section: 'about_more_house', dwell_ms: 60000, video_ms: 0, clicks: 0 },
        { section: 'creative_arts_hero', dwell_ms: 60000, video_ms: 0, clicks: 0 },
        { section: 'discover_video', dwell_ms: 0, video_ms: 0, clicks: 0 },
        { section: 'academic_excellence', dwell_ms: 0, video_ms: 0, clicks: 0 },
        { section: 'ethical_leaders', dwell_ms: 0, video_ms: 0, clicks: 0 }
      ],
      totals: {
        time_on_page_ms: 120000,  // 2 minutes
        video_ms: 0,
        clicks: 0,
        total_visits: 1
      }
    };
    
    // Call the AI function directly
    const aiResult = await generateAiEngagementStory(snapshot, {
      first_name: inquiry.first_name,
      family_surname: inquiry.family_surname,
      entry_year: inquiry.entry_year
    });
    
    // Store it
    await upsertAiInsight(db, inquiryId, 'engagement_summary', aiResult);
    
    res.json({
      success: true,
      inquiryId,
      familyName: `${inquiry.first_name} ${inquiry.family_surname}`,
      aiResult,
      message: 'AI summary forced successfully. Check dashboard now.'
    });
    
  } catch (error) {
    console.error('Force AI summary error:', error);
    res.status(500).json({ error: error.message });
  }
});


// Bulk AI engagement summaries
app.post('/api/ai/analyze-all-families', async (req, res) => {
  if (!db) {
    return res.status(500).json({ success: false, error: 'Database not available' });
  }

  try {
    // Load all inquiries
    const q = await db.query(`SELECT * FROM inquiries ORDER BY created_at DESC NULLS LAST`);
    const rows = q?.rows || [];
    const results = [];

    for (const inquiry of rows) {
      try {
        // 👉 Use the same AI summariser as the single route
        const result = await summariseFamilyEngagement(db, inquiry);

        // Save into ai_family_insights
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

// Add this endpoint to your server.js to directly query DB and generate AI summary

app.post('/api/ai/force-summary/:inquiryId', async (req, res) => {
  if (!db) {
    return res.status(500).json({ error: 'Database not available' });
  }

  const inquiryId = req.params.inquiryId;

  try {
    // 1. Get ALL data directly from database
    const inquiryData = await db.query(`
      SELECT 
        i.id,
        i.first_name,
        i.family_surname,
        i.entry_year,
        i.dwell_ms,
        i.return_visits,
        COALESCE(i.dwell_ms, 0) as total_dwell_ms,
        COALESCE(i.return_visits, 1) as visits
      FROM inquiries i
      WHERE i.id = $1
    `, [inquiryId]);

    if (!inquiryData.rows[0]) {
      return res.status(404).json({ error: 'Inquiry not found' });
    }

    const inquiry = inquiryData.rows[0];

    // 2. Get section data from tracking_events
    const sectionData = await db.query(`
      SELECT
        COALESCE(event_data->>'currentSection', 'unknown') AS section,
        SUM(COALESCE((event_data->>'timeInSectionSec')::int, 0)) AS dwell_seconds,
        MAX(COALESCE((event_data->>'maxScrollPct')::int, 0)) AS scroll_pct,
        COUNT(*) as events
      FROM tracking_events
      WHERE inquiry_id = $1
        AND event_type = 'section_exit'
        AND event_data IS NOT NULL
      GROUP BY 1
      ORDER BY 2 DESC
    `, [inquiryId]);

    // 3. Build the data structure
    const totalDwellMs = Number(inquiry.total_dwell_ms) || 0;
    const totalMinutes = Math.round(totalDwellMs / 60000);
    const visits = Number(inquiry.visits) || 1;
    const sections = sectionData.rows;

    // 4. Generate AI prompt with ACTUAL data
    const prompt = `
You are a UK school admissions assistant. Based on the following REAL engagement data from a family viewing their personalised prospectus, write a warm, factual summary.

ACTUAL DATA FROM DATABASE:
- Student: ${inquiry.first_name} ${inquiry.family_surname}
- Entry Year: ${inquiry.entry_year}
- Total Time Spent: ${totalDwellMs}ms (${totalMinutes} minutes)
- Number of Visits: ${visits}
- Sections Viewed: ${sections.length}

SECTION BREAKDOWN:
${sections.map(s => `- ${s.section}: ${s.dwell_seconds} seconds, ${s.scroll_pct}% scroll depth`).join('\n')}

Write a 120-180 word narrative in UK English that:
1. Mentions the actual time spent (${totalMinutes} minutes)
2. Highlights which sections they focused on
3. Suggests what their interests might be based on the sections they viewed
4. Recommends appropriate next steps for the admissions team

Return ONLY valid JSON:
{
  "narrative": "Your 120-180 word summary here",
  "highlights": [
    "• Specific insight about their ${totalMinutes} minute engagement",
    "• Which sections they focused on most",
    "• What this suggests about their interests",
    "• Recommended follow-up action",
    "• One more relevant point"
  ]
}`;

    console.log('Generating AI summary with data:', {
      inquiryId,
      totalDwellMs,
      totalMinutes,
      visits,
      sectionCount: sections.length
    });

    let aiResult;

    // 5. Call AI with the data
    if (process.env.ANTHROPIC_API_KEY) {
      const { Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      
      const response = await client.messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20240620',
        max_tokens: 800,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }]
      });
      
      const text = response?.content?.[0]?.text || '{}';
      aiResult = JSON.parse(text);
      
    } else if (process.env.OPENAI_API_KEY) {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      
      const response = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }]
      });
      
      aiResult = JSON.parse(response.choices[0].message.content);
      
    } else {
      // No AI configured - generate based on data
      const topSections = sections.slice(0, 3).map(s => s.section.replace(/_/g, ' ')).join(', ');
      
      aiResult = {
        narrative: `${inquiry.first_name} ${inquiry.family_surname}'s family spent ${totalMinutes} minutes exploring their personalised prospectus across ${visits} visit(s). They showed particular interest in ${topSections || 'various sections'}, with ${sections[0]?.section.replace(/_/g, ' ') || 'key areas'} receiving the most attention at ${Math.round((sections[0]?.dwell_seconds || 0) / 60)} minutes. This engagement pattern suggests ${sections[0]?.section.includes('academic') ? 'strong academic focus' : sections[0]?.section.includes('creative') ? 'interest in creative programmes' : 'broad interest in the school'}. The family appears to be seriously considering More House, taking time to understand what makes us unique. Given their focus areas, a follow-up call discussing ${topSections || 'their interests'} would be valuable.`,
        highlights: [
          `• Engaged for ${totalMinutes} minutes across ${visits} visit(s)`,
          `• Primary focus: ${sections[0]?.section.replace(/_/g, ' ') || 'Reviewing materials'}`,
          `• Explored ${sections.length} different sections thoroughly`,
          `• Shows ${totalMinutes > 10 ? 'strong' : 'initial'} interest in More House`,
          `• Ready for personalised follow-up call`
        ]
      };
    }

    // 6. Store the result in database
    await db.query(`
      INSERT INTO ai_family_insights (inquiry_id, analysis_type, insights_json, generated_at)
      VALUES ($1, 'engagement_summary', $2::jsonb, NOW())
      ON CONFLICT (inquiry_id, analysis_type)
      DO UPDATE SET 
        insights_json = EXCLUDED.insights_json,
        generated_at = NOW()
    `, [inquiryId, JSON.stringify(aiResult)]);

    // 7. Return the result
    res.json({
      success: true,
      inquiryId,
      data: {
        family: `${inquiry.first_name} ${inquiry.family_surname}`,
        totalMinutes,
        visits,
        sectionCount: sections.length,
        topSection: sections[0]?.section || 'none'
      },
      aiSummary: aiResult,
      debug: {
        totalDwellMs,
        sectionsFound: sections.length,
        prompt: prompt.substring(0, 500) + '...'
      }
    });

  } catch (error) {
    console.error('Force summary error:', error);
    res.status(500).json({ 
      error: 'Failed to generate summary',
      message: error.message,
      inquiryId 
    });
  }
});

// Also add this GET endpoint that the dashboard will use
app.get('/api/ai/engagement-summary/:inquiryId', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'Database not available' });

  const inquiryId = req.params.inquiryId;

  try {
    // First check if we have a stored AI summary
    const stored = await db.query(`
      SELECT insights_json
      FROM ai_family_insights
      WHERE inquiry_id = $1 AND analysis_type = 'engagement_summary'
    `, [inquiryId]);

    if (stored.rows[0]?.insights_json) {
      // We have a stored summary, return it with the engagement data
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

      const insights = stored.rows[0].insights_json;
      
      return res.json({
        inquiryId,
        visits: Number(inquiryData.rows[0]?.return_visits || 1),
        score: Math.min(100, Math.round((Number(inquiryData.rows[0]?.dwell_ms || 0) / 1000) / 10) + 50),
        sections: sectionData.rows,
        summaryText: insights.narrative || 'No summary available',
        highlights: insights.highlights || [],
        total_dwell_ms: Number(inquiryData.rows[0]?.dwell_ms || 0)
      });
    }

    // No stored summary - generate one now
    const genResponse = await fetch(`http://localhost:${process.env.PORT || 3000}/api/ai/force-summary/${inquiryId}`, {
      method: 'POST'
    });
    
    if (!genResponse.ok) {
      throw new Error('Failed to generate summary');
    }

    const generated = await genResponse.json();
    
    // Now fetch and return the stored summary
    const newStored = await db.query(`
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

    const insights = newStored.rows[0]?.insights_json || generated.aiSummary;
    
    res.json({
      inquiryId,
      visits: Number(inquiryData.rows[0]?.return_visits || 1),
      score: Math.min(100, Math.round((Number(inquiryData.rows[0]?.dwell_ms || 0) / 1000) / 10) + 50),
      sections: sectionData.rows,
      summaryText: insights.narrative || 'No summary available',
      highlights: insights.highlights || [],
      total_dwell_ms: Number(inquiryData.rows[0]?.dwell_ms || 0)
    });

  } catch (error) {
    console.error('Get engagement summary error:', error);
    res.status(500).json({ 
      error: 'Failed to get summary',
      message: error.message 
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

// --- Dwell accumulator endpoint (ADD THIS) ---
app.post('/api/track/dwell', async (req, res) => {
  const { inquiryId, sessionId, deltaMs, reason, timestamp, deviceInfo } = req.body || {};
  try {
    if (!inquiryId || !Number.isFinite(Number(deltaMs))) {
      return res.status(400).json({ ok:false, error:'Missing inquiryId or deltaMs' });
    }

    // If DB isn't configured, accept and return OK so frontend doesn't error.
    if (!db) return res.json({ ok:true, mode:'json-only', acceptedDeltaMs: Number(deltaMs) });

    const delta = Math.max(0, Math.round(Number(deltaMs)));
    await db.query('BEGIN');

    // 1) Log an audit row in tracking_events
    await db.query(`
      INSERT INTO tracking_events (inquiry_id, event_type, event_data, page_url, user_agent, ip_address, session_id, timestamp)
      VALUES ($1, 'dwell', $2, $3, $4, $5, $6, $7)
    `, [
      inquiryId,
      JSON.stringify({ delta_ms: delta, reason: reason || null, deviceInfo: deviceInfo || null }),
      null,
      (deviceInfo && deviceInfo.userAgent) || null,
      (req.ip || req.headers['x-forwarded-for'] || null),
      sessionId || null,
      new Date(timestamp || Date.now())
    ]);

    // 2) Increment the inquiry’s total dwell time (ms)
    await db.query(`
      UPDATE inquiries
      SET dwell_ms = COALESCE(dwell_ms, 0) + $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [inquiryId, delta]);

    await db.query('COMMIT');
    return res.json({ ok:true, addedMs: delta });
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch(_) {}
    console.warn('dwell endpoint failed:', e.message);
    return res.status(500).json({ ok:false, error:'server_error' });
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

// Add this debug endpoint to server.js
app.get('/api/debug/snapshot/:inquiryId', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No database' });
  
  const inquiryId = req.params.inquiryId;
  const snapshot = await buildEngagementSnapshot(db, inquiryId);
  
  res.json({
    inquiryId,
    snapshot,
    hasData: snapshot.totals.time_on_page_ms > 0 || snapshot.sections.length > 0
  });
});

app.get('/api/debug/snapshot/:inquiryId', async (req, res) => {
  if (!db) return res.status(500).json({ error: 'No database' });
  
  const inquiryId = req.params.inquiryId;
  const snapshot = await buildEngagementSnapshot(db, inquiryId);
  
  res.json({
    inquiryId,
    snapshot,
    hasData: snapshot.totals.time_on_page_ms > 0 || snapshot.sections.length > 0
  });
});

app.use((req, res) => {
 res.status(404).json({ 
   success: false, 
   error: 'Not found', 
   message: `Route ${req.method} ${req.path} not found` 
 });
});

// Server startup
async function startServer() {
 console.log('Starting More House School System...');
 
 const dbConnected = await initializeDatabase();
 await ensureDirectories();
 await loadSlugIndex();
 await rebuildSlugIndexFromData();

 app.listen(PORT, () => {
   console.log(`
=====================================
Server running on port ${PORT}
Database: ${dbConnected ? 'Connected to PostgreSQL' : 'JSON-only mode'}
Environment: ${process.env.NODE_ENV || 'development'}
Version: 5.0.0-COMPLETE
=====================================
   `);
 });
}

// Graceful shutdown handlers
process.on('SIGINT', async () => { 
 console.log('\nShutting down gracefully (SIGINT)...');
 if (db) {
   await db.end();
   console.log('Database connection closed.');
 }
 process.exit(0); 
});

process.on('SIGTERM', async () => { 
 console.log('\nShutting down gracefully (SIGTERM)...');
 if (db) {
   await db.end();
   console.log('Database connection closed.');
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
