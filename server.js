// server.js — unified, fixed & production-ready

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const fssync = require('fs');
const path = require('path');
require('dotenv').config();
const { Client } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

let db = null;

// ---------------- Database (optional) ----------------
async function initializeDatabase() {
  try {
    const hasCreds = !!(process.env.DATABASE_URL || (process.env.DB_USER && process.env.DB_NAME));
    if (!hasCreds) {
      console.warn('⚠️ No DB credentials set; running in JSON-only mode.');
      return false;
    }

    db = new Client({
      connectionString: process.env.DATABASE_URL,
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
      database: process.env.DB_NAME || 'prospectus_analytics',
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });

    await db.connect();
    console.log('✅ Connected to PostgreSQL');
    await runMigrations(db);

    // Inquiries
    await db.query(`
      CREATE TABLE IF NOT EXISTS inquiries (
        id TEXT PRIMARY KEY,
        first_name TEXT,
        family_surname TEXT,
        parent_email TEXT,
        entry_year TEXT,
        age_group TEXT,

        -- Academic
        sciences BOOLEAN DEFAULT FALSE,
        mathematics BOOLEAN DEFAULT FALSE,
        english BOOLEAN DEFAULT FALSE,
        languages BOOLEAN DEFAULT FALSE,
        humanities BOOLEAN DEFAULT FALSE,
        business BOOLEAN DEFAULT FALSE,

        -- Creative
        drama BOOLEAN DEFAULT FALSE,
        music BOOLEAN DEFAULT FALSE,
        art BOOLEAN DEFAULT FALSE,
        creative_writing BOOLEAN DEFAULT FALSE,

        -- Co-curricular
        sport BOOLEAN DEFAULT FALSE,
        leadership BOOLEAN DEFAULT FALSE,
        community_service BOOLEAN DEFAULT FALSE,
        outdoor_education BOOLEAN DEFAULT FALSE,
        debating BOOLEAN DEFAULT FALSE,

        -- Family priorities
        academic_excellence BOOLEAN DEFAULT FALSE,
        pastoral_care BOOLEAN DEFAULT FALSE,
        university_preparation BOOLEAN DEFAULT FALSE,
        personal_development BOOLEAN DEFAULT FALSE,
        career_guidance BOOLEAN DEFAULT FALSE,
        extracurricular_opportunities BOOLEAN DEFAULT FALSE,
        small_classes BOOLEAN DEFAULT FALSE,
        london_location BOOLEAN DEFAULT FALSE,
        values_based BOOLEAN DEFAULT FALSE,
        university_prep BOOLEAN DEFAULT FALSE,

        -- System
        received_at TIMESTAMP,
        status TEXT,
        prospectus_generated BOOLEAN DEFAULT FALSE,
        prospectus_filename TEXT,
        prospectus_url TEXT,
        prospectus_generated_at TIMESTAMP,

        -- Analytics
        user_agent TEXT,
        referrer TEXT,
        ip_address TEXT,
        contact_ready BOOLEAN DEFAULT FALSE,

        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Events
    await db.query(`
      CREATE TABLE IF NOT EXISTS tracking_events (
        id SERIAL PRIMARY KEY,
        inquiry_id TEXT,
        session_id TEXT,
        event_type TEXT,
        timestamp TIMESTAMP,
        event_data JSONB,
        url TEXT,
        current_section TEXT,
        device_info JSONB,
        user_agent TEXT,
        ip_address TEXT
      );
    `);

    // Engagement
    await db.query(`
      CREATE TABLE IF NOT EXISTS engagement_metrics (
        id SERIAL PRIMARY KEY,
        inquiry_id TEXT,
        session_id TEXT,
        prospectus_filename TEXT,
        time_on_page INTEGER DEFAULT 0,
        pages_viewed INTEGER DEFAULT 1,
        scroll_depth INTEGER DEFAULT 0,
        clicks_on_links INTEGER DEFAULT 0,
        device_type TEXT,
        browser TEXT,
        operating_system TEXT,
        total_visits INTEGER DEFAULT 1,
        last_visit TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (inquiry_id, session_id)
      );
    `);

    return true;
  } catch (err) {
    console.warn('⚠️ DB init failed:', err.message);
    db = null;
    return false;
  }
}

// ---------------- Middleware & static ----------------
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Static
app.use(express.static(path.join(__dirname, 'public')));
app.use('/prospectuses', express.static(path.join(__dirname, 'prospectuses')));
app.get('/tracking.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'tracking.js'))
);

// Convenience HTML routes
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/inquiry-form.html', (req, res) => res.sendFile(path.join(__dirname, 'inquiry-form.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// Directory listing for /prospectuses (no extra deps)
app.get('/prospectuses/', async (req, res) => {
  try {
    const dir = path.join(__dirname, 'prospectuses');
    const files = (await fs.readdir(dir))
      .filter(name => name.toLowerCase().endsWith('.html'))
      .sort()
      .reverse();

    const rows = files.length
      ? files.map(f => `<li><a href="/prospectuses/${encodeURIComponent(f)}">${f}</a></li>`).join('')
      : '<li style="color:#888">No prospectuses yet.</li>';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Prospectuses</title>
<style>body{font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial;margin:20px} a{text-decoration:none} li{margin:6px 0}</style>
</head><body>
<h1>Prospectuses</h1>
<ul>${rows}</ul>
</body></html>`);
  } catch (e) {
    res.status(500).send('Failed to list prospectuses');
  }
});


// ---------------- Folders ----------------
async function ensureDirectories() {
  await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
  await fs.mkdir(path.join(__dirname, 'prospectuses'), { recursive: true });
  await fs.mkdir(path.join(__dirname, 'public'), { recursive: true });
}

// ---------------- Helpers ----------------
function generateInquiryId() {
  return `INQ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeSlug(s) { return (s || '').toString().replace(/[^a-z0-9]+/gi, '-'); }

function generateFilename(inquiryData) {
  const date = new Date().toISOString().split('T')[0];
  return `More-House-School-${safeSlug(inquiryData.familySurname)}-Family-${safeSlug(inquiryData.firstName)}-${inquiryData.entryYear}-${date}.html`;
}

async function saveInquiryData(formData) {
  const id = generateInquiryId();
  const receivedAt = new Date().toISOString();
  const record = { id, receivedAt, status: 'received', prospectusGenerated: false, ...formData };
  const filename = `inquiry-${receivedAt}.json`;
  await fs.writeFile(path.join(__dirname, 'data', filename), JSON.stringify(record, null, 2));
  return record;
}

async function saveInquiryToDatabase(inq) {
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO inquiries (
        id, first_name, family_surname, parent_email, entry_year, age_group,
        sciences, mathematics, english, languages, humanities, business,
        drama, music, art, creative_writing,
        sport, leadership, community_service, outdoor_education, debating,
        academic_excellence, pastoral_care, university_preparation, personal_development,
        career_guidance, extracurricular_opportunities, small_classes, london_location,
        values_based, university_prep,
        received_at, status, user_agent, referrer, ip_address, prospectus_generated
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37
      )
      ON CONFLICT (id) DO UPDATE SET
        first_name=EXCLUDED.first_name,
        family_surname=EXCLUDED.family_surname,
        parent_email=EXCLUDED.parent_email,
        entry_year=EXCLUDED.entry_year,
        age_group=EXCLUDED.age_group,
        status=EXCLUDED.status,
        updated_at=CURRENT_TIMESTAMP`,
      [
        inq.id, inq.firstName || '', inq.familySurname || '', inq.parentEmail || '',
        inq.entryYear || '', inq.ageGroup || '',
        !!inq.sciences, !!inq.mathematics, !!inq.english, !!inq.languages, !!inq.humanities, !!inq.business,
        !!inq.drama, !!inq.music, !!inq.art, !!inq.creative_writing,
        !!inq.sport, !!inq.leadership, !!inq.community_service, !!inq.outdoor_education, !!inq.debating,
        !!inq.academic_excellence, !!inq.pastoral_care, !!inq.university_preparation, !!inq.personal_development,
        !!inq.career_guidance, !!inq.extracurricular_opportunities, !!inq.small_classes, !!inq.london_location,
        !!inq.values_based, !!inq.university_prep,
        inq.receivedAt ? new Date(inq.receivedAt) : new Date(),
        inq.status || 'received',
        inq.userAgent, inq.referrer, inq.ip,
        !!inq.prospectusGenerated
      ]
    );
  } catch (err) {
    console.warn('⚠️ saveInquiryToDatabase failed:', err.message);
  }
}

async function updateInquiryStatus(inquiryId, prospectusInfo) {
  // Update JSON
  const files = await fs.readdir(path.join(__dirname, 'data'));
  for (const file of files.filter(f => f.startsWith('inquiry-') && f.endsWith('.json'))) {
    const fp = path.join(__dirname, 'data', file);
    const obj = JSON.parse(await fs.readFile(fp, 'utf8'));
    if (obj.id === inquiryId) {
      obj.prospectusGenerated = true;
      obj.prospectusFilename = prospectusInfo.filename;
      obj.prospectusUrl = prospectusInfo.url;
      obj.prospectusGeneratedAt = prospectusInfo.generatedAt;
      obj.status = 'prospectus_generated';
      await fs.writeFile(fp, JSON.stringify(obj, null, 2));
      break;
    }
  }
  // Update DB
  if (db) {
    try {
      await db.query(
        `UPDATE inquiries SET status='prospectus_generated', prospectus_generated=true,
         prospectus_filename=$2, prospectus_url=$3, prospectus_generated_at=$4, updated_at=CURRENT_TIMESTAMP
         WHERE id=$1`,
        [inquiryId, prospectusInfo.filename, prospectusInfo.url, new Date(prospectusInfo.generatedAt)]
      );
    } catch (err) {
      console.warn('⚠️ updateInquiryStatus DB failed:', err.message);
    }
  }
}

async function trackEngagementEvent(event) {
  if (db) {
    try {
      await db.query(
        `INSERT INTO tracking_events (inquiry_id, session_id, event_type, timestamp, event_data, url, current_section, device_info, user_agent, ip_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          event.inquiryId || null,
          event.sessionId || null,
          event.eventType || null,
          event.timestamp ? new Date(event.timestamp) : new Date(),
          event.eventData || event.data || {},
          event.url || null,
          event.currentSection || null,
          event.deviceInfo || null,
          event.userAgent || null,
          event.ip || null
        ]
      );
    } catch (err) {
      console.warn('⚠️ trackEngagementEvent DB failed:', err.message);
    }
  } else {
    const line = JSON.stringify({ ...event, loggedAt: new Date().toISOString() }) + '\n';
    fssync.appendFileSync(path.join(__dirname, 'data', 'tracking.log'), line);
  }
}

async function updateEngagementMetrics(metrics) {
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO engagement_metrics (inquiry_id, session_id, prospectus_filename, time_on_page, pages_viewed, scroll_depth, clicks_on_links, device_type, browser, operating_system, last_visit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (inquiry_id, session_id) DO UPDATE SET 
         time_on_page = GREATEST(engagement_metrics.time_on_page, EXCLUDED.time_on_page),
         scroll_depth = GREATEST(engagement_metrics.scroll_depth, EXCLUDED.scroll_depth),
         clicks_on_links = GREATEST(engagement_metrics.clicks_on_links, EXCLUDED.clicks_on_links),
         pages_viewed = engagement_metrics.pages_viewed + 1,
         total_visits = engagement_metrics.total_visits + 1,
         last_visit = EXCLUDED.last_visit`,
      [
        metrics.inquiryId,
        metrics.sessionId,
        metrics.prospectusFilename || 'unknown',
        Math.round(metrics.timeOnPage || 0),
        metrics.pageViews || 1,
        Math.round(metrics.maxScrollDepth || 0),
        metrics.clickCount || 0,
        metrics.deviceInfo?.deviceType || 'unknown',
        metrics.deviceInfo?.browser || 'unknown',
        metrics.deviceInfo?.operatingSystem || 'unknown',
        new Date()
      ]
    );
  } catch (err) {
    console.warn('⚠️ updateEngagementMetrics DB failed:', err.message);
  }
}

// ---------------- Prospectus generation ----------------
async function readProspectusTemplate() {
  const templatePath = path.join(__dirname, 'public', 'prospectus_template.html');
  try {
    return await fs.readFile(templatePath, 'utf8');
  } catch {
    const html = `<!doctype html><html><head>
      <meta charset="utf-8"><title>Prospectus</title>
    </head><body>
      <h1 data-section="hero">Prospectus</h1>
      <p data-section="intro">Add your real template in /public/prospectus_template.html.</p>
      <script>window.initializeProspectus = function(d){ console.log('init prospectus', d); };</script>
    </body></html>`;
    await fs.writeFile(templatePath, html, 'utf8');
    return html;
  }
}

// Inject tracking (YouTube + event batching) directly into generated HTML
function injectTrackingScript(htmlContent, inquiryId) {
  const youtubeAPIScript = `
  <script>
    var tag=document.createElement('script');tag.src="https://www.youtube.com/iframe_api";
    var firstScriptTag=document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
  </script>`;

  const trackingScript = `
  <script>(function(){
    'use strict';
    const TRACKING={inquiryId:'${inquiryId}',sessionId:'session_'+Date.now()+'_'+Math.random().toString(36).slice(2,9),endpoint:'/api/track-engagement',batchSize:5,flushInterval:10000};
    const state={events:[],videoStates:{},sessionStart:Date.now()};
    async function send(batch){ if(!batch.length) return;
      try{ await fetch(TRACKING.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({events:batch,sessionInfo:{inquiryId:TRACKING.inquiryId,sessionId:TRACKING.sessionId,timeOnPage:Math.round((Date.now()-state.sessionStart)/1000)}})});
      }catch(e){ console.error('send fail',e);}
    }
    function track(type,data={}){
      const ev={inquiryId:TRACKING.inquiryId,sessionId:TRACKING.sessionId,eventType:type,timestamp:new Date().toISOString(),data,url:location.href};
      state.events.push(ev); if(state.events.length>=TRACKING.batchSize){const b=state.events.splice(0,TRACKING.batchSize);send(b);}
    }
    window.onYouTubeIframeAPIReady=function(){
      document.querySelectorAll('iframe[src*="youtube.com"]').forEach((iframe,idx)=>{
        const m=(iframe.src||'').match(/embed\\/([^?]+)/); const vid=m?m[1]:'unknown';
        if(!iframe.src.includes('enablejsapi=1')) iframe.src=iframe.src+(iframe.src.includes('?')?'&':'?')+'enablejsapi=1';
        iframe.id='yt_'+idx;
        new YT.Player(iframe.id,{events:{onReady:()=>{state.videoStates[vid]={t:null,watch:0,pc:0,pause:0,Q:{q25:false,q50:false,q75:false}};},
          onStateChange:(e)=>{const p=e.target; const dur=p.getDuration(); const cur=p.getCurrentTime(); const st=state.videoStates[vid];
            if(e.data===YT.PlayerState.PLAYING){ if(!st.t){st.t=Date.now(); st.pc++; track('youtube_video_start',{videoId:vid,duration:Math.round(dur)})}
              st.i&&clearInterval(st.i); st.i=setInterval(()=>{const pct=(p.getCurrentTime()/Math.max(1,dur))*100;
                [['q25',25],['q50',50],['q75',75]].forEach(([k,val])=>{ if(pct>=val && !st.Q[k]){ st.Q[k]=true; track('youtube_video_progress',{videoId:vid,milestone:val+'%'})}});
              },2000);
            } else if(e.data===YT.PlayerState.PAUSED){ st.pause++; if(st.t){st.watch+=(Date.now()-st.t)/1000; st.t=null;}
              track('youtube_video_pause',{videoId:vid,currentTime:Math.round(cur),totalWatchTime:Math.round(st.watch),pauseCount:st.pause}); clearInterval(st.i);
            } else if(e.data===YT.PlayerState.ENDED){ if(st.t){st.watch+=(Date.now()-st.t)/1000; st.t=null;}
              track('youtube_video_complete',{videoId:vid,totalWatchTime:Math.round(st.watch),completionRate:100}); clearInterval(st.i);
            }
          }}});});
    };
    track('page_load',{referrer:document.referrer,viewport:innerWidth+'x'+innerHeight});
    document.addEventListener('visibilitychange',()=>{ if(document.hidden){ track('page_hidden',{totalTimeVisible:Math.round((Date.now()-state.sessionStart)/1000)});} else {track('page_visible',{});} });
    window.addEventListener('beforeunload',()=>{ if(state.events.length){ navigator.sendBeacon(TRACKING.endpoint,JSON.stringify({events:state.events,sessionInfo:{inquiryId:TRACKING.inquiryId,sessionId:TRACKING.sessionId,sessionComplete:true,timeOnPage:Math.round((Date.now()-state.sessionStart)/1000)}})); }});
    setInterval(()=>{ if(state.events.length){ const b=state.events.splice(0,state.events.length); send(b);} },TRACKING.flushInterval);
  })();</script>`;

  return htmlContent.replace(/<\/body>/i, youtubeAPIScript + trackingScript + '</body>');
}

async function generateProspectus(inquiryData) {
  try {
    const templatePath = path.join(__dirname, 'public', 'prospectus_template.html');
    let html = await fs.readFile(templatePath, 'utf8').catch(() => readProspectusTemplate());

    // Personalise head
    const headMeta = `
      <meta name="inquiry-id" content="${inquiryData.id}">
      <meta name="generated-date" content="${new Date().toISOString()}">
      <meta name="student-name" content="${inquiryData.firstName} ${inquiryData.familySurname}">
      <meta name="entry-year" content="${inquiryData.entryYear}">
      <meta name="age-group" content="${inquiryData.ageGroup}">
      <meta name="tracking-enabled" content="true">`;
    html = html.replace('</head>', headMeta + '\n</head>');

    // Title
    const title = `${inquiryData.firstName} ${inquiryData.familySurname} – More House School Prospectus ${inquiryData.entryYear}`;
    html = html.replace(/<title>.*?<\/title>/i, `<title>${title}</title>`);

    // Personalisation hook (keeps your original initialise function if present)
    const personaliseScript = `<script>document.addEventListener('DOMContentLoaded',function(){
      const data=${JSON.stringify(inquiryData)};
      if(typeof initializeProspectus==='function'){ initializeProspectus(data); }
    });</script>`;

    // Inject scripts
    html = html.replace(/<\/body>/i, personaliseScript + '</body>');
    html = injectTrackingScript(html, inquiryData.id);

    // Save file
    const filename = generateFilename(inquiryData);
    const filepath = path.join(__dirname, 'prospectuses', filename);
    await fs.writeFile(filepath, html, 'utf8');

    return { filename, url: `/prospectuses/${filename}`, generatedAt: new Date().toISOString() };
  } catch (error) {
    console.error('❌ Error generating prospectus:', error);
    throw error;
  }
}

// ---------------- Webhook / APIs ----------------
app.post('/webhook', async (req, res) => {
  try {
    const formData = req.body || {};
    const required = ['firstName', 'familySurname', 'parentEmail', 'ageGroup', 'entryYear'];
    const missing = required.filter(k => !formData[k]);
    if (missing.length) return res.status(400).json({ success:false, error:'Missing required fields', missing });

    const inquiry = await saveInquiryData(formData);

    await saveInquiryToDatabase({
      ...formData,
      id: inquiry.id,
      receivedAt: inquiry.receivedAt,
      status: 'received',
      userAgent: formData.userAgent || req.headers['user-agent'],
      referrer: formData.referrer || req.headers.referer,
      ip: req.ip || req.connection.remoteAddress
    });

    const prospectusInfo = await generateProspectus(inquiry);
    await updateInquiryStatus(inquiry.id, prospectusInfo);

    res.json({
      success: true,
      inquiryId: inquiry.id,
      prospectus: {
        filename: prospectusInfo.filename,
        url: `${PUBLIC_BASE_URL}${prospectusInfo.url}`,
        generatedAt: prospectusInfo.generatedAt
      }
    });
  } catch (err) {
    console.error('❌ WEBHOOK ERROR:', err);
    res.status(500).json({ success:false, error:'Internal server error', message: err.message });
  }
});

app.post('/api/generate-prospectus/:inquiryId', async (req, res) => {
  try {
    const inquiryId = req.params.inquiryId;
    const files = await fs.readdir(path.join(__dirname, 'data'));
    let inquiryData = null;
    for (const file of files.filter(f => f.startsWith('inquiry-') && f.endsWith('.json'))) {
      const obj = JSON.parse(await fs.readFile(path.join(__dirname, 'data', file), 'utf8'));
      if (obj.id === inquiryId) { inquiryData = obj; break; }
    }
    if (!inquiryData) return res.status(404).json({ success:false, error:'Inquiry not found' });

    const prospectusInfo = await generateProspectus(inquiryData);
    await updateInquiryStatus(inquiryId, prospectusInfo);

    res.json({
      success:true,
      inquiryId,
      prospectus: {
        filename: prospectusInfo.filename,
        url: `${PUBLIC_BASE_URL}${prospectusInfo.url}`,
        generatedAt: prospectusInfo.generatedAt
      }
    });
  } catch (err) {
    console.error('❌ manual generate error:', err);
    res.status(500).json({ success:false, error:'Failed to generate prospectus', message: err.message });
  }
});

// ============ TRACKING ENDPOINTS ============
app.post('/api/track', async (req, res) => {
  try {
    const { events, engagementMetrics } = req.body || {};
    const clientIP = req.ip || req.connection.remoteAddress;

    if (Array.isArray(events)) {
      for (const ev of events) {
        await trackEngagementEvent({
          ...ev,
          ip: clientIP,
          userAgent: req.headers['user-agent']
        });
      }
    }
    if (engagementMetrics) await updateEngagementMetrics(engagementMetrics);

    res.json({ success:true, message:'Tracking data recorded', eventsProcessed: Array.isArray(events) ? events.length : 0 });
  } catch (error) {
    console.error('❌ Legacy tracking error:', error.message);
    res.status(500).json({ success:false, error:'Failed to record tracking data' });
  }
});

app.post('/api/track-engagement', async (req, res) => {
  try {
    const { events, sessionInfo } = req.body || {};
    const list = Array.isArray(events) ? events : (req.body && req.body.eventType ? [req.body] : []);
    for (const ev of list) {
      const rec = {
        inquiryId: ev.inquiryId,
        sessionId: ev.sessionId,
        eventType: ev.eventType,
        timestamp: ev.timestamp || new Date().toISOString(),
        eventData: ev.data || ev.eventData || {},
        url: ev.url,
        currentSection: ev.currentSection,
        deviceInfo: ev.deviceInfo || (ev.data && ev.data.deviceInfo) || null,
        userAgent: req.headers['user-agent'],
        ip: req.ip || req.connection.remoteAddress
      };
      await trackEngagementEvent(rec);
    }

    if (sessionInfo && sessionInfo.inquiryId) {
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

    res.json({ success:true, eventsProcessed: list.length || 0 });
  } catch (err) {
    console.error('❌ track-engagement error:', err);
    res.status(500).json({ success:false, error:'Failed to track engagement', message: err.message });
  }
});

// ============ DASHBOARD ENDPOINTS ============
async function getDashboardMetrics() {
  try {
    if (!db) {
      const files = await fs.readdir(path.join(__dirname, 'data'));
      const inquiryFiles = files.filter(f => f.startsWith('inquiry-') && f.endsWith('.json'));
      let readyForContact = 0, highlyEngaged = 0, newInquiries = 0, totalFamilies = inquiryFiles.length;
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      for (const f of inquiryFiles) {
        const i = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
        if (new Date(i.receivedAt) > oneWeekAgo) newInquiries++;
        if (i.prospectusGenerated) { highlyEngaged++; }
      }
      return { readyForContact, highlyEngaged, newInquiries, totalFamilies };
    }

    const readyForContactResult = await db.query(`SELECT COUNT(*) AS c FROM inquiries WHERE contact_ready=false AND prospectus_generated=true`);
    const highlyEngagedResult = await db.query(`SELECT COUNT(*) AS c FROM engagement_metrics WHERE time_on_page > 300`);
    const newInquiriesResult = await db.query(`SELECT COUNT(*) AS c FROM inquiries WHERE received_at > CURRENT_DATE - INTERVAL '7 days'`);
    const totalFamiliesResult = await db.query(`SELECT COUNT(*) AS c FROM inquiries`);

    return {
      readyForContact: Number(readyForContactResult.rows[0]?.c || 0),
      highlyEngaged: Number(highlyEngagedResult.rows[0]?.c || 0),
      newInquiries: Number(newInquiriesResult.rows[0]?.c || 0),
      totalFamilies: Number(totalFamiliesResult.rows[0]?.c || 0)
    };
  } catch (e) {
    console.error('❌ getDashboardMetrics:', e);
    return { readyForContact:0, highlyEngaged:0, newInquiries:0, totalFamilies:0 };
  }
}

function formatSubject(subject) {
  const map = { sciences:'Science & STEM', mathematics:'Mathematics', english:'English', languages:'Languages', humanities:'Humanities', business:'Business', drama:'Drama', music:'Music', art:'Art', creative_writing:'Creative Writing', sport:'Sports & Wellbeing', leadership:'Leadership' };
  return map[subject] || subject;
}

async function getAnalyticsData() {
  try {
    const files = await fs.readdir(path.join(__dirname, 'data'));
    const inquiryFiles = files.filter(f => f.startsWith('inquiry-') && f.endsWith('.json'));
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    let totalInquiries = inquiryFiles.length, thisWeekInquiries = 0;
    const counts = {};
    for (const f of inquiryFiles) {
      const i = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
      if (new Date(i.receivedAt) > oneWeekAgo) thisWeekInquiries++;
      for (const k of ['sciences','mathematics','english','languages','humanities','business','drama','music','art','creative_writing','sport','leadership']) {
        if (i[k]) counts[k] = (counts[k] || 0) + 1;
      }
    }
    const topInterests = Object.entries(counts).map(([k,v])=>({subject:formatSubject(k),count:v})).sort((a,b)=>b.count-a.count).slice(0,5);
    return { totalInquiries, thisWeekInquiries, conversionRate: totalInquiries ? Math.round((thisWeekInquiries/totalInquiries)*100) : 0, averageEngagementScore: 67, topInterests };
  } catch (e) {
    return { totalInquiries:0, thisWeekInquiries:0, conversionRate:0, averageEngagementScore:0, topInterests:[] };
  }
}

async function getPriorityFamilies() {
  try {
    if (!db) return [];
    const r = await db.query(`
      SELECT i.*, em.time_on_page, em.scroll_depth, em.clicks_on_links, em.total_visits, em.last_visit
      FROM inquiries i LEFT JOIN engagement_metrics em ON i.id=em.inquiry_id
      WHERE i.prospectus_generated = true
      ORDER BY em.time_on_page DESC NULLS LAST, i.received_at DESC LIMIT 10`);
    return r.rows.map(row=>({
      id: row.id,
      name: `${row.first_name} ${row.family_surname}`,
      email: row.parent_email,
      childName: row.first_name,
      ageGroup: row.age_group,
      entryYear: row.entry_year,
      engagementScore: Math.min(100, Math.round((row.time_on_page || 0)/10)),
      contactReadinessScore: Math.min(100, Math.round((row.time_on_page || 0)/8)),
      lastActivity: row.last_visit || row.received_at,
      status: (row.time_on_page||0) > 300 ? 'high_priority' : 'moderate_interest',
      insights: []
    }));
  } catch (e) { return []; }
}

async function getRecentlyActiveFamilies() {
  try {
    if (!db) return [];
    const r = await db.query(`
      SELECT i.id, i.first_name, i.family_surname, te.event_type, te.timestamp, em.time_on_page
      FROM inquiries i
      LEFT JOIN tracking_events te ON i.id = te.inquiry_id
      LEFT JOIN engagement_metrics em ON i.id = em.inquiry_id
      WHERE te.timestamp > CURRENT_TIMESTAMP - INTERVAL '24 hours'
      ORDER BY te.timestamp DESC LIMIT 20`);
    return r.rows.map(row=>({
      id: row.id,
      name: `${row.first_name} ${row.family_surname}`,
      activity: row.event_type,
      timestamp: row.timestamp,
      engagementScore: Math.min(100, Math.round((row.time_on_page || 0)/10))
    }));
  } catch (e) { return []; }
}

// Single payload for dashboard
app.get('/api/dashboard-data', async (req, res) => {
  try {
    const metrics = await getDashboardMetrics();
    const priorityFamilies = await getPriorityFamilies();
    const recentlyActive = await getRecentlyActiveFamilies();
    const analytics = await getAnalyticsData();
    res.json({ metrics, priorityFamilies, recentlyActive, analytics, lastUpdated: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success:false, error:'Failed to generate dashboard data', message:error.message });
  }
});

// Classic dashboard endpoints (still used by your HTML)
app.get('/api/analytics/stats', async (req, res) => {
  try {
    const files = await fs.readdir(path.join(__dirname, 'data'));
    const inquiryFiles = files.filter(f => f.startsWith('inquiry-') && f.endsWith('.json'));
    let totalInquiries = inquiryFiles.length, prospectusGenerated = 0;
    for (const f of inquiryFiles) {
      try { const obj = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f),'utf8'));
        if (obj.prospectusGenerated || obj.status === 'prospectus_generated') prospectusGenerated++;
      } catch {}
    }
    let avgEngagementTime = 0, highInterest = 0;
    if (db) {
      try {
        const r = await db.query(`SELECT AVG(NULLIF(time_on_page,0)) AS avg_time, COUNT(CASE WHEN time_on_page>300 THEN 1 END) AS high_interest FROM engagement_metrics`);
        avgEngagementTime = Math.round((Number(r.rows[0]?.avg_time || 0)/60)*10)/10;
        highInterest = Number(r.rows[0]?.high_interest || 0);
      } catch (e) { console.warn('⚠️ stats DB query failed:', e.message); }
    }
    res.json({ totalInquiries, activeEngagements: prospectusGenerated, avgEngagementTime, highInterest });
  } catch (err) {
    res.status(500).json({ totalInquiries:0, activeEngagements:0, avgEngagementTime:0, highInterest:0 });
  }
});

app.get('/api/analytics/inquiries', async (req, res) => {
  try {
    const files = await fs.readdir(path.join(__dirname, 'data'));
    const inquiryFiles = files.filter(f => f.startsWith('inquiry-') && f.endsWith('.json'));
    const list = [];
    for (const f of inquiryFiles) {
      const i = JSON.parse(await fs.readFile(path.join(__dirname, 'data', f), 'utf8'));
      const item = {
        id: i.id,
        first_name: i.firstName,
        family_surname: i.familySurname,
        parent_email: i.parentEmail,
        entry_year: i.entryYear,
        age_group: i.ageGroup,
        received_at: i.receivedAt,
        updated_at: i.prospectusGeneratedAt || i.receivedAt,
        status: i.status || (i.prospectusGenerated ? 'prospectus_generated' : 'received'),
        engagement: null
      };
      if (db) {
        try {
          const r = await db.query(
            `SELECT time_on_page, scroll_depth, clicks_on_links, total_visits, last_visit
             FROM engagement_metrics WHERE inquiry_id=$1 ORDER BY last_visit DESC LIMIT 1`,
            [i.id]
          );
          if (r.rows.length) {
            const e = r.rows[0];
            item.engagement = {
              timeOnPage: e.time_on_page || 0,
              scrollDepth: e.scroll_depth || 0,
              clickCount: e.clicks_on_links || 0,
              totalVisits: e.total_visits || 0,
              lastVisit: e.last_visit
            };
          }
        } catch (e) { console.warn('⚠️ inquiries engagement DB query failed:', e.message); }
      }
      list.push(item);
    }
    list.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get inquiries data' });
  }
});

app.get('/api/analytics/activity', async (req, res) => {
  try {
    if (!db) return res.json([]);
    const result = await db.query(`
      SELECT te.inquiry_id, te.event_type, te.timestamp, te.event_data, i.first_name, i.family_surname
      FROM tracking_events te LEFT JOIN inquiries i ON te.inquiry_id=i.id
      ORDER BY te.timestamp DESC LIMIT 20`);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get activity data' });
  }
});

// Inquiries + health + root
app.get('/api/inquiries', async (req, res) => {
  try {
    const files = await fs.readdir(path.join(__dirname, 'data'));
    const inquiryFiles = files.filter(file => file.startsWith('inquiry-') && file.endsWith('.json'));
    const inquiries = [];
    for (const file of inquiryFiles) {
      const inquiry = JSON.parse(await fs.readFile(path.join(__dirname, 'data', file), 'utf8'));
      inquiries.push(inquiry);
    }
    inquiries.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    res.json({ success:true, count: inquiries.length, inquiries });
  } catch (error) {
    res.status(500).json({ success:false, error:'Failed to list inquiries', message:error.message });
  }
});

app.get('/api/inquiries/:id', async (req, res) => {
  try {
    const inquiryId = req.params.id;
    const files = await fs.readdir(path.join(__dirname, 'data'));
    const inquiryFiles = files.filter(file => file.startsWith('inquiry-') && file.endsWith('.json'));
    for (const file of inquiryFiles) {
      const inquiry = JSON.parse(await fs.readFile(path.join(__dirname, 'data', file), 'utf8'));
      if (inquiry.id === inquiryId) return res.json({ success:true, inquiry });
    }
    res.status(404).json({ success:false, error:'Inquiry not found' });
  } catch (error) {
    res.status(500).json({ success:false, error:'Failed to retrieve inquiry', message:error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: '5.0.0-youtube-tracking',
    features: {
      analytics: 'enabled',
      tracking: 'enabled',
      dashboard: 'enabled',
      database: db ? 'connected' : 'json-only',
      youtubeTracking: 'enabled'
    }
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'More House School Analytics System',
    status: 'running',
    version: '5.0.0-youtube-tracking',
    endpoints: {
      webhook: 'POST /webhook',
      inquiries: 'GET /api/analytics/inquiries',
      stats: 'GET /api/analytics/stats',
      activity: 'GET /api/analytics/activity',
      trackEngagement: 'POST /api/track-engagement',
      track: 'POST /api/track (legacy)',
      prospectuses: 'GET /prospectuses/{filename}',
      dashboard: 'GET /dashboard.html',
      dashboardData: 'GET /api/dashboard-data'
    },
    timestamp: new Date().toISOString(),
    analytics: db ? 'enabled' : 'disabled',
    features: { youtubeTracking:'enabled', videoQuartiles:'enabled', sessionTracking:'enabled' }
  });
});

// --- BEGIN: bootstrap migrations (public schema) ---
async function runMigrations(db) {
  const stmts = [
    `SET search_path TO public;`,
    `ALTER TABLE public.inquiries
       ADD COLUMN IF NOT EXISTS sciences BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS mathematics BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS english BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS languages BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS humanities BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS business BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS drama BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS music BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS art BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS creative_writing BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS sport BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS leadership BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS community_service BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS outdoor_education BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS debating BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS academic_excellence BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS pastoral_care BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS university_preparation BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS personal_development BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS career_guidance BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS extracurricular_opportunities BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS small_classes BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS london_location BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS values_based BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS university_prep BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS contact_ready BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS prospectus_generated BOOLEAN DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS prospectus_filename TEXT,
       ADD COLUMN IF NOT EXISTS prospectus_url TEXT,
       ADD COLUMN IF NOT EXISTS prospectus_generated_at TIMESTAMP,
       ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       ADD COLUMN IF NOT EXISTS user_agent TEXT,
       ADD COLUMN IF NOT EXISTS referrer TEXT,
       ADD COLUMN IF NOT EXISTS ip_address TEXT,
       ADD COLUMN IF NOT EXISTS status TEXT,
       ADD COLUMN IF NOT EXISTS received_at TIMESTAMP;`,
    `ALTER TABLE public.engagement_metrics
       ADD COLUMN IF NOT EXISTS time_on_page INTEGER DEFAULT 0,
       ADD COLUMN IF NOT EXISTS pages_viewed INTEGER DEFAULT 1,
       ADD COLUMN IF NOT EXISTS scroll_depth INTEGER DEFAULT 0,
       ADD COLUMN IF NOT EXISTS clicks_on_links INTEGER DEFAULT 0,
       ADD COLUMN IF NOT EXISTS device_type TEXT,
       ADD COLUMN IF NOT EXISTS browser TEXT,
       ADD COLUMN IF NOT EXISTS operating_system TEXT,
       ADD COLUMN IF NOT EXISTS total_visits INTEGER DEFAULT 1,
       ADD COLUMN IF NOT EXISTS last_visit TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`,
    `ALTER TABLE public.tracking_events
       ADD COLUMN IF NOT EXISTS inquiry_id TEXT,
       ADD COLUMN IF NOT EXISTS session_id TEXT,
       ADD COLUMN IF NOT EXISTS event_type TEXT,
       ADD COLUMN IF NOT EXISTS timestamp TIMESTAMP,
       ADD COLUMN IF NOT EXISTS event_data JSONB,
       ADD COLUMN IF NOT EXISTS url TEXT,
       ADD COLUMN IF NOT EXISTS current_section TEXT,
       ADD COLUMN IF NOT EXISTS device_info JSONB,
       ADD COLUMN IF NOT EXISTS user_agent TEXT,
       ADD COLUMN IF NOT EXISTS ip_address TEXT;`
  ];
  for (const sql of stmts) { try { await db.query(sql); } catch (e) { console.warn('Migration warn:', e.message); } }
}
// --- END: bootstrap migrations (public schema) ---

// Temporary DB diagnostic route (remove later)
app.get('/__dbdiag', async (req, res) => {
  try {
    if (!db) return res.json({ dbinfo: null, debating_present: false, note: 'No DB connection' });
    const a = await db.query(`SELECT current_database() AS db, current_schema() AS schema`);
    const b = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name='inquiries' AND column_name='debating'`);
    res.json({ dbinfo: a.rows[0], debating_present: b.rowCount > 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ---------------- Start ----------------
async function startServer() {
  const dbConnected = await initializeDatabase();
  await ensureDirectories();
  app.listen(PORT, () => {
    console.log('\n🚀 MORE HOUSE ANALYTICS SERVER – v5 with YouTube tracking');
    console.log('══════════════════════════════════════════════════════════════════════');
    console.log(`🌐 Server: ${PUBLIC_BASE_URL}`);
    console.log(`📋 Webhook: ${PUBLIC_BASE_URL}/webhook`);
    console.log(`📈 Dashboard: ${PUBLIC_BASE_URL}/dashboard.html`);
    console.log(`📄 Prospectuses: ${PUBLIC_BASE_URL}/prospectuses/`);
    console.log(`🎯 Tracking endpoint: ${PUBLIC_BASE_URL}/api/track-engagement`);
    console.log(`📄 Legacy tracking: ${PUBLIC_BASE_URL}/api/track`);
    console.log(`📊 Dashboard data: ${PUBLIC_BASE_URL}/api/dashboard-data`);
    console.log(`🗄️ Database: ${dbConnected ? 'Connected' : 'Disabled (JSON only)'}`);
    console.log('══════════════════════════════════════════════════════════════════════\n');
  });
}
startServer();

process.on('SIGINT', async () => { if (db) await db.end().catch(()=>{}); process.exit(0); });
process.on('SIGTERM', async () => { if (db) await db.end().catch(()=>{}); process.exit(0); });

module.exports = {
  generateProspectus,
  updateInquiryStatus,
  generateFilename,
  saveInquiryToDatabase,
  trackEngagementEvent,
  updateEngagementMetrics,
  injectTrackingScript
};
