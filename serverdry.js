// server.js - Refactored Version 5.0.0
// More House School Prospectus Service with Analytics & AI

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();
const { Client } = require('pg');

// ===================== INITIALIZATION =====================
const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

// Global variables
let db = null;
let slugIndex = {};

// ===================== CONSTANTS & CONFIG =====================
const CONFIG = {
  VERSION: '5.0.0-COMPLETE',
  SERVICE_NAME: 'More House School Prospectus Service',
  ENVIRONMENT: process.env.NODE_ENV || 'development',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex')
};

const ENDPOINTS = {
  health: '/health',
  webhook: '/webhook',
  dashboard: '/dashboard.html',
  inquiries: '/api/analytics/inquiries',
  dashboardData: '/api/dashboard-data',
  aiEngagementSummary: '/api/ai/engagement-summary/:inquiryId',
  aiAnalyzeFamily: '/api/ai/analyze-family/:inquiryId',
  aiAnalyzeAll: '/api/ai/analyze-all-families',
  rebuildSlugs: '/admin/rebuild-slugs',
  trackEngagement: '/api/track-engagement',
  trackLegacy: '/api/track'
};

// ===================== UTILITY FUNCTIONS =====================
const utils = {
  // Get base URL for the application
  getBaseUrl(req) {
    if (process.env.PUBLIC_BASE_URL) {
      return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
    }
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    return `${proto}://${host}`;
  },

  // Generate unique inquiry ID
  generateInquiryId() {
    return `INQ-${Date.now()}${Math.floor(Math.random() * 1000)}`;
  },

  // Sanitize string for filenames
  sanitise(s, fallback = '') {
    return (s || fallback)
      .toString()
      .replace(/[^a-z0-9\- ]/gi, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  },

  // Normalize segment for slugs
  normaliseSegment(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  },

  // Create slug from inquiry data
  makeSlug(inquiry) {
    const fam = (inquiry.familySurname || 'Family')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const shortId = String(inquiry.id || '')
      .replace(/[^a-z0-9]/gi, '')
      .slice(-6)
      .toLowerCase() || Math.random().toString(36).slice(-6);
    return `the-${fam}-family-${shortId}`;
  },

  // Generate prospectus filename
  generateFilename(inquiry) {
    const date = new Date().toISOString().split('T')[0];
    const fam = this.sanitise(inquiry.familySurname, 'Family');
    const first = this.sanitise(inquiry.firstName, 'Student');
    return `More-House-School-${fam}-Family-${first}-${inquiry.entryYear}-${date}.html`;
  },

  // Parse prospectus filename
  parseProspectusFilename(filename) {
    const m = String(filename).match(/^More-House-School-(.+?)-Family-(.+?)-(20\d{2})-(.+?)\.html$/);
    if (!m) return null;
    return {
      familySurname: m[1].replace(/-/g, ' '),
      firstName: m[2].replace(/-/g, ' '),
      entryYear: m[3],
      date: m[4]
    };
  },

  // Get system status
  getSystemStatus() {
    return {
      database: db ? 'connected' : 'json-only',
      environment: CONFIG.ENVIRONMENT,
      version: CONFIG.VERSION,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    };
  },

  // Extract location from IP
  extractLocation(req) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const geo = req.headers['x-vercel-ip-country'] ? {
      country: req.headers['x-vercel-ip-country'],
      region: req.headers['x-vercel-ip-country-region'],
      city: req.headers['x-vercel-ip-city'],
      ll: [
        req.headers['x-vercel-ip-latitude'],
        req.headers['x-vercel-ip-longitude']
      ].filter(Boolean),
      timezone: req.headers['x-vercel-ip-timezone']
    } : {};

    return {
      ip,
      country: geo.country || 'GB',
      region: geo.region || 'England',
      city: geo.city || 'London',
      latitude: geo.ll ? geo.ll[0] : null,
      longitude: geo.ll ? geo.ll[1] : null,
      timezone: geo.timezone || 'Europe/London',
      isp: 'Unknown'
    };
  }
};

// ===================== ENCRYPTION FUNCTIONS =====================
const encryption = {
  encrypt(id) {
    try {
      const cipher = crypto.createCipher('aes256', CONFIG.ENCRYPTION_KEY);
      let encrypted = cipher.update(id, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      return encrypted;
    } catch (e) {
      console.warn('Encryption failed, using plain ID:', e.message);
      return id;
    }
  },

  decrypt(encrypted) {
    try {
      const decipher = crypto.createDecipher('aes256', CONFIG.ENCRYPTION_KEY);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (e) {
      return encrypted;
    }
  }
};

// ===================== DATABASE FUNCTIONS =====================
const database = {
  async initialize() {
    const haveUrl = !!process.env.DATABASE_URL;
    const haveParts = !!(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);
    
    if (!haveUrl && !haveParts) {
      console.log('📉 No DB credentials – running in JSON-only mode.');
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
        ssl: CONFIG.ENVIRONMENT === 'production' ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 3000
      });
      
      await db.connect();
      console.log('✅ Connected to PostgreSQL');
      return true;
    } catch (e) {
      console.warn('⚠️ PostgreSQL connection failed:', e.message);
      console.warn('➡️ Continuing in JSON-only mode.');
      db = null;
      return false;
    }
  },

  async saveInquiry(inquiry) {
    if (!db) return null;
    
    try {
      const query = `
        INSERT INTO inquiries (
          id, first_name, family_surname, parent_email, phone,
          age_group, entry_year, additional_info, status, slug,
          prospectus_filename, prospectus_url, received_at,
          user_agent, referrer, ip_address, location_data
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          prospectus_filename = EXCLUDED.prospectus_filename,
          prospectus_url = EXCLUDED.prospectus_url
        RETURNING id;
      `;
      
      const values = [
        inquiry.id, inquiry.firstName, inquiry.familySurname,
        inquiry.parentEmail, inquiry.phone || null,
        inquiry.ageGroup, inquiry.entryYear,
        inquiry.additionalInfo || null, inquiry.status,
        inquiry.slug, inquiry.prospectusFilename || null,
        inquiry.prospectusUrl || null, inquiry.receivedAt,
        inquiry.userAgent || null, inquiry.referrer || null,
        inquiry.ip || null, JSON.stringify(inquiry.location || {})
      ];
      
      const result = await db.query(query, values);
      console.log(`✅ Inquiry ${result.rows[0].id} saved to database`);
      return result.rows[0].id;
    } catch (e) {
      console.error('Failed to save inquiry to database:', e.message);
      return null;
    }
  },

  async trackEngagementEvent(eventData) {
    if (!db) return null;
    
    try {
      const query = `
        INSERT INTO tracking_events (
          inquiry_id, event_type, event_data, page_url,
          user_agent, ip_address, session_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id;
      `;
      
      const values = [
        eventData.inquiryId, eventData.eventType,
        JSON.stringify(eventData.eventData || {}),
        eventData.pageUrl || null, eventData.userAgent || null,
        eventData.ipAddress || null, eventData.sessionId || null
      ];
      
      const result = await db.query(query, values);
      return result.rows[0].id;
    } catch (e) {
      console.error('Failed to track event:', e.message);
      return null;
    }
  },

  async updateEngagementMetrics(inquiryId, metrics) {
    if (!db) return null;
    
    try {
      const query = `
        INSERT INTO engagement_metrics (
          inquiry_id, time_on_page, pages_viewed, scroll_depth,
          clicks_on_links, session_id, device_type, browser
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (inquiry_id, session_id) DO UPDATE SET
          time_on_page = engagement_metrics.time_on_page + EXCLUDED.time_on_page,
          pages_viewed = engagement_metrics.pages_viewed + EXCLUDED.pages_viewed,
          scroll_depth = GREATEST(engagement_metrics.scroll_depth, EXCLUDED.scroll_depth),
          clicks_on_links = engagement_metrics.clicks_on_links + EXCLUDED.clicks_on_links,
          last_visit = CURRENT_TIMESTAMP,
          total_visits = engagement_metrics.total_visits + 1
        RETURNING *;
      `;
      
      const values = [
        inquiryId, metrics.timeOnPage || 0, metrics.pagesViewed || 0,
        metrics.scrollDepth || 0, metrics.clicksOnLinks || 0,
        metrics.sessionId, metrics.deviceType || null, metrics.browser || null
      ];
      
      const result = await db.query(query, values);
      return result.rows[0];
    } catch (e) {
      console.error('Failed to update metrics:', e.message);
      return null;
    }
  }
};

// ===================== FILE SYSTEM OPERATIONS =====================
const fileSystem = {
  async ensureDirectories() {
    try {
      await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
      await fs.mkdir(path.join(__dirname, 'prospectuses'), { recursive: true });
      await fs.mkdir(path.join(__dirname, 'public'), { recursive: true });
    } catch (e) {
      console.error('Failed to create directories:', e.message);
      throw e;
    }
  },

  async loadSlugIndex() {
    try {
      const p = path.join(__dirname, 'data', 'slug-index.json');
      slugIndex = JSON.parse(await fs.readFile(p, 'utf8'));
      console.log(`Loaded ${Object.keys(slugIndex).length} slug mappings`);
    } catch (e) {
      slugIndex = {};
      console.log('No slug-index.json yet; will create on first save.');
    }
  },

  async saveSlugIndex() {
    try {
      const p = path.join(__dirname, 'data', 'slug-index.json');
      await fs.writeFile(p, JSON.stringify(slugIndex, null, 2));
    } catch (e) {
      console.error('Failed to save slug index:', e.message);
    }
  },

  async saveInquiryJson(record) {
    try {
      const filename = `inquiry-${record.receivedAt}.json`;
      const p = path.join(__dirname, 'data', filename);
      await fs.writeFile(p, JSON.stringify(record, null, 2));
      return p;
    } catch (e) {
      console.error('Failed to save inquiry JSON:', e.message);
      throw e;
    }
  },

  async rebuildSlugIndexFromData() {
    let added = 0;
    try {
      const files = await fs.readdir(path.join(__dirname, 'data'));
      const jsonFiles = files.filter(f => f.startsWith('inquiry-') && f.endsWith('.json'));
      
      for (const file of jsonFiles) {
        try {
          const content = await fs.readFile(path.join(__dirname, 'data', file), 'utf8');
          const inquiry = JSON.parse(content);
          const slug = (inquiry.slug || '').toLowerCase();
          
          if (!slug) continue;
          
          let url = inquiry.prospectusUrl;
          if (!url && inquiry.prospectusFilename) {
            url = `/prospectuses/${inquiry.prospectusFilename}`;
          }
          
          if (url && !slugIndex[slug]) {
            slugIndex[slug] = url;
            added++;
          }
        } catch (e) {
          console.warn(`Skipping invalid file ${file}:`, e.message);
        }
      }
      
      if (added > 0) {
        await this.saveSlugIndex();
        console.log(`Added ${added} new slug mappings`);
      }
      
      return added;
    } catch (e) {
      console.error('Failed to rebuild slug index:', e.message);
      return 0;
    }
  }
};

// ===================== INQUIRY OPERATIONS =====================
const inquiryOps = {
  async findBySlug(slug) {
    try {
      // Try database first
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
            slug: row.slug,
            prospectusFilename: row.prospectus_filename,
            prospectusUrl: row.prospectus_url
          };
        }
      }
      
      // Fallback to JSON files
      const files = await fs.readdir(path.join(__dirname, 'data'));
      for (const file of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
        const content = await fs.readFile(path.join(__dirname, 'data', file), 'utf8');
        const inquiry = JSON.parse(content);
        if (inquiry.slug === slug) return inquiry;
      }
      
      return null;
    } catch (e) {
      console.error('Error finding inquiry by slug:', e.message);
      return null;
    }
  },

  async findById(id) {
    try {
      // Try database first
      if (db) {
        const result = await db.query('SELECT * FROM inquiries WHERE id = $1 LIMIT 1', [id]);
        if (result.rows.length > 0) {
          return result.rows[0];
        }
      }
      
      // Fallback to JSON files
      const files = await fs.readdir(path.join(__dirname, 'data'));
      for (const file of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
        const content = await fs.readFile(path.join(__dirname, 'data', file), 'utf8');
        const inquiry = JSON.parse(content);
        if (inquiry.id === id) return inquiry;
      }
      
      return null;
    } catch (e) {
      console.error('Error finding inquiry by ID:', e.message);
      return null;
    }
  },

  async getAllInquiries() {
    const inquiries = [];
    
    try {
      // Get from database if available
      if (db) {
        const result = await db.query('SELECT * FROM inquiries ORDER BY received_at DESC');
        inquiries.push(...result.rows.map(row => ({
          id: row.id,
          firstName: row.first_name,
          familySurname: row.family_surname,
          parentEmail: row.parent_email,
          ageGroup: row.age_group,
          entryYear: row.entry_year,
          receivedAt: row.received_at,
          status: row.status,
          slug: row.slug,
          prospectusGenerated: !!row.prospectus_filename,
          prospectusFilename: row.prospectus_filename,
          prospectusUrl: row.prospectus_url
        })));
      } else {
        // Fallback to JSON files
        const files = await fs.readdir(path.join(__dirname, 'data'));
        for (const file of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
          const content = await fs.readFile(path.join(__dirname, 'data', file), 'utf8');
          inquiries.push(JSON.parse(content));
        }
      }
      
      return inquiries.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
    } catch (e) {
      console.error('Error getting all inquiries:', e.message);
      return inquiries;
    }
  },

  async updateStatus(inquiryId, updates) {
    try {
      // Update in database if available
      if (db) {
        const query = `
          UPDATE inquiries SET
            status = $2,
            prospectus_filename = $3,
            prospectus_url = $4
          WHERE id = $1
          RETURNING *;
        `;
        
        const values = [
          inquiryId,
          updates.status || 'prospectus-generated',
          updates.filename || null,
          updates.url || null
        ];
        
        await db.query(query, values);
      }
      
      // Also update JSON file
      const files = await fs.readdir(path.join(__dirname, 'data'));
      for (const file of files.filter(x => x.startsWith('inquiry-') && x.endsWith('.json'))) {
        const filePath = path.join(__dirname, 'data', file);
        const content = await fs.readFile(filePath, 'utf8');
        const inquiry = JSON.parse(content);
        
        if (inquiry.id === inquiryId) {
          Object.assign(inquiry, updates);
          await fs.writeFile(filePath, JSON.stringify(inquiry, null, 2));
          break;
        }
      }
      
      return true;
    } catch (e) {
      console.error('Failed to update inquiry status:', e.message);
      return false;
    }
  }
};

// ===================== PROSPECTUS GENERATION =====================
async function generateProspectus(inquiry) {
  try {
    const filename = utils.generateFilename(inquiry);
    const filePath = path.join(__dirname, 'prospectuses', filename);
    const baseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
    const trackingId = encryption.encrypt(inquiry.id);
    
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>More House School - ${inquiry.familySurname} Family Prospectus</title>
  <style>
    body { font-family: Georgia, serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 40px; text-align: center; border-radius: 10px; margin-bottom: 30px; }
    h1 { margin: 0; font-size: 2.5em; }
    .subtitle { opacity: 0.95; margin-top: 10px; }
    .content { background: white; padding: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); border-radius: 10px; }
    .section { margin-bottom: 30px; }
    .cta { background: #667eea; color: white; padding: 15px 30px; text-decoration: none; display: inline-block; border-radius: 5px; margin-top: 20px; }
    .cta:hover { background: #764ba2; }
  </style>
  <script>
    (function() {
      const trackingId = '${trackingId}';
      const sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      const startTime = Date.now();
      let maxScrollDepth = 0;
      let clickCount = 0;
      
      // Track page view
      fetch('${baseUrl}/api/track-engagement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inquiryId: trackingId,
          eventType: 'page_view',
          sessionId: sessionId,
          pageUrl: window.location.href
        })
      });
      
      // Track scroll depth
      window.addEventListener('scroll', function() {
        const scrollPercent = Math.round((window.scrollY + window.innerHeight) / document.body.scrollHeight * 100);
        maxScrollDepth = Math.max(maxScrollDepth, scrollPercent);
      });
      
      // Track clicks
      document.addEventListener('click', function(e) {
        if (e.target.tagName === 'A') {
          clickCount++;
          fetch('${baseUrl}/api/track-engagement', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              inquiryId: trackingId,
              eventType: 'link_click',
              sessionId: sessionId,
              eventData: { href: e.target.href, text: e.target.innerText }
            })
          });
        }
      });
      
      // Send metrics on page unload
      window.addEventListener('beforeunload', function() {
        const timeOnPage = Math.round((Date.now() - startTime) / 1000);
        navigator.sendBeacon('${baseUrl}/api/track-engagement', JSON.stringify({
          inquiryId: trackingId,
          eventType: 'page_exit',
          sessionId: sessionId,
          metrics: {
            timeOnPage: timeOnPage,
            scrollDepth: maxScrollDepth,
            clicksOnLinks: clickCount
          }
        }));
      });
    })();
  </script>
</head>
<body>
  <div class="header">
    <h1>Welcome to More House School</h1>
    <div class="subtitle">Personalized Prospectus for the ${inquiry.familySurname} Family</div>
  </div>
  
  <div class="content">
    <div class="section">
      <h2>Dear ${inquiry.firstName},</h2>
      <p>Thank you for your interest in More House School. We're excited to share how our unique approach to education can support your journey.</p>
    </div>
    
    <div class="section">
      <h2>Why More House is Perfect for ${inquiry.firstName}</h2>
      <p>Based on your interest in our <strong>${inquiry.ageGroup}</strong> program for <strong>${inquiry.entryYear}</strong> entry, we've prepared this personalized prospectus highlighting the most relevant aspects of our school for your family.</p>
    </div>
    
    <div class="section">
      <h2>Our ${inquiry.ageGroup} Program</h2>
      <p>Our ${inquiry.ageGroup} curriculum is designed to challenge and inspire students, preparing them for success in their academic journey and beyond.</p>
      <ul>
        <li>Small class sizes ensuring personalized attention</li>
        <li>Innovative teaching methods tailored to different learning styles</li>
        <li>Comprehensive support system for academic and personal development</li>
        <li>Rich extracurricular programs to develop well-rounded individuals</li>
      </ul>
    </div>
    
    <div class="section">
      <h2>Next Steps for ${inquiry.entryYear} Entry</h2>
      <p>We would love to welcome ${inquiry.firstName} to our community. Here are your next steps:</p>
      <ol>
        <li>Schedule a personal tour of our campus</li>
        <li>Meet with our admissions team to discuss ${inquiry.firstName}'s specific needs and interests</li>
        <li>Attend one of our open days to experience More House in action</li>
        <li>Submit your application for ${inquiry.entryYear} entry</li>
      </ol>
    </div>
    
    <div class="section">
      <a href="mailto:admissions@morehouse.edu?subject=Follow-up for ${inquiry.familySurname} Family&body=Dear Admissions Team,%0D%0A%0D%0AI would like to schedule a visit to discuss ${inquiry.firstName}'s application for ${inquiry.entryYear} entry to the ${inquiry.ageGroup} program." class="cta">Schedule Your Visit</a>
    </div>
  </div>
</body>
</html>`;
    
    await fs.writeFile(filePath, html);
    console.log(`✅ Generated prospectus: ${filename}`);
    
    return {
      filename: filename,
      url: `/prospectuses/${filename}`,
      fullPath: filePath
    };
  } catch (error) {
    console.error('Failed to generate prospectus:', error.message);
    throw error;
  }
}

// ===================== AI ANALYSIS FUNCTIONS =====================
async function analyzeEngagementForInquiry(inquiryId) {
  try {
    const inquiry = await inquiryOps.findById(inquiryId);
    if (!inquiry) {
      return { error: 'Inquiry not found', inquiryId };
    }

    let engagementData = null;
    let engagementScore = 0;

    if (db) {
      const metricsResult = await db.query(
        'SELECT * FROM engagement_metrics WHERE inquiry_id = $1',
        [inquiryId]
      );

      if (metricsResult.rows.length > 0) {
        const metrics = metricsResult.rows[0];
        engagementScore = Math.min(100, 
          (metrics.time_on_page / 10) + 
          (metrics.pages_viewed * 10) + 
          (metrics.scroll_depth * 0.5) + 
          (metrics.clicks_on_links * 5) + 
          (metrics.total_visits * 15)
        );
        engagementData = metrics;
      }
    }

    // In a real implementation, this would call an AI API
    // For now, return a structured analysis based on available data
    return {
      inquiryId: inquiryId,
      familyName: `${inquiry.first_name || inquiry.firstName} ${inquiry.family_surname || inquiry.familySurname}`,
      status: inquiry.status,
      engagementLevel: engagementScore > 70 ? 'high' : engagementScore > 40 ? 'medium' : 'low',
      leadTemperature: engagementScore > 70 ? 'hot' : engagementScore > 40 ? 'warm' : 'cold',
      conversationStarters: [
        `Follow up on ${inquiry.first_name || inquiry.firstName}'s interest in the ${inquiry.age_group || inquiry.ageGroup} program`,
        `Discuss ${inquiry.entry_year || inquiry.entryYear} entry requirements`,
        'Schedule a campus visit'
      ],
      sellingPoints: [
        'Small class sizes for personalized attention',
        'Strong academic track record',
        'Comprehensive support system',
        'Vibrant school community'
      ],
      nextActions: [
        'Send personalized follow-up email',
        'Schedule phone consultation',
        'Invite to upcoming open day'
      ],
      insights: {
        studentProfile: `Interested in ${inquiry.age_group || inquiry.ageGroup} program for ${inquiry.entry_year || inquiry.entryYear} entry`,
        familyPriorities: 'Quality education with individual attention',
        engagementPattern: engagementData ? `Engagement score: ${engagementScore.toFixed(1)}/100` : 'No engagement data yet',
        recommendedApproach: 'Personal, warm follow-up emphasizing community and individual growth'
      },
      keyObservations: [
        `Family showed interest on ${new Date(inquiry.received_at || inquiry.receivedAt).toLocaleDateString()}`,
        engagementData ? `Has engaged with prospectus ${engagementData.total_visits} time(s)` : 'Awaiting prospectus engagement',
        'Ready for next stage of admissions process'
      ],
      confidence_score: engagementData ? 0.85 : 0.6,
      recommendations: [
        'Prioritize for follow-up within 48 hours',
        'Prepare tailored information package',
        'Assign dedicated admissions counselor'
      ],
      engagementScore: engagementScore,
      analysisDate: new Date().toISOString()
    };
  } catch (error) {
    console.error('AI analysis error:', error);
    return {
      error: error.message,
      inquiryId: inquiryId,
      engagementLevel: 'unknown',
      leadTemperature: 'cold',
      recommendations: ['Manual review required'],
      analysisDate: new Date().toISOString()
    };
  }
}

// ===================== MIDDLEWARE SETUP =====================
const corsOptions = {
  origin(origin, cb) {
    // Allow all origins for development, restrict in production
    if (!origin || 
        origin.includes('.onrender.com') || 
        origin.includes('localhost') || 
        origin.includes('127.0.0.1') || 
        origin.includes('.github.io')) {
      return cb(null, true);
    }
    return cb(null, true); // Allow all for now
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  credentials: false,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => { 
  console.log(`→ ${req.method} ${req.url}`);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/prospectuses', express.static(path.join(__dirname, 'prospectuses')));

// ===================== ROUTE HANDLERS =====================

// Health check endpoint
app.get(ENDPOINTS.health, (req, res) => {
  res.json({
    status: 'healthy',
    ...utils.getSystemStatus()
  });
});

// Root endpoint with service information
app.get('/', (req, res) => {
  const base = utils.getBaseUrl(req);
  const status = utils.getSystemStatus();
  
  res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${CONFIG.SERVICE_NAME}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; padding: 24px; max-width: 780px; margin: auto; line-height: 1.55; }
    h1 { color: #2563eb; }
    .status { background: #f0f9ff; padding: 15px; border-radius: 8px; margin: 20px 0; }
    .endpoints { background: #fafafa; padding: 15px; border-radius: 8px; }
    code { background: #e5e7eb; padding: 2px 6px; border-radius: 3px; }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <h1>${CONFIG.SERVICE_NAME}</h1>
  <p><strong>Version ${CONFIG.VERSION}</strong></p>
  
  <div class="status">
    <h3>System Status:</h3>
    <ul>
      <li>Database: ${status.database}</li>
      <li>Environment: ${status.environment}</li>
      <li>Uptime: ${Math.floor(status.uptime / 60)} minutes</li>
    </ul>
  </div>
  
  <div class="endpoints">
    <h3>Available Endpoints:</h3>
    <ul>
      <li>Health: <a href="${base}${ENDPOINTS.health}">${base}${ENDPOINTS.health}</a></li>
      <li>Webhook: <code>POST ${base}${ENDPOINTS.webhook}</code></li>
      <li>Dashboard: <a href="${base}${ENDPOINTS.dashboard}">${base}${ENDPOINTS.dashboard}</a></li>
      <li>Inquiries: <a href="${base}${ENDPOINTS.inquiries}">${base}${ENDPOINTS.inquiries}</a></li>
      <li>Dashboard Data: <a href="${base}${ENDPOINTS.dashboardData}">${base}${ENDPOINTS.dashboardData}</a></li>
      <li>AI Analysis: <code>POST ${base}/api/ai/engagement-summary/:inquiryId</code></li>
      <li>Rebuild Slugs: <a href="${base}${ENDPOINTS.rebuildSlugs}">${base}${ENDPOINTS.rebuildSlugs}</a></li>
    </ul>
  </div>
  
  <p style="margin-top: 20px;">Pretty URLs: <code>${base}/the-smith-family-abc123</code></p>
</body>
</html>`);
});

// Webhook endpoint
app.post(ENDPOINTS.webhook, async (req, res) => {
  try {
    const data = req.body || {};
    const required = ['firstName', 'familySurname', 'parentEmail', 'ageGroup', 'entryYear'];
    const missing = required.filter(k => !data[k]);
    
    if (missing.length) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        missingFields: missing
      });
    }

    const now = new Date().toISOString();
    const base = utils.getBaseUrl(req);
    
    const record = {
      id: utils.generateInquiryId(),
      receivedAt: now,
      status: 'received',
      prospectusGenerated: false,
      userAgent: req.headers['user-agent'],
      referrer: req.headers.referer,
      ip: req.ip || req.connection.remoteAddress,
      location: utils.extractLocation(req),
      ...data
    };

    record.slug = utils.makeSlug(record);
    
    // Save to JSON file
    await fileSystem.saveInquiryJson(record);
    
    // Save to database if available
    if (db) {
      await database.saveInquiry(record);
    }
    
    // Generate prospectus
    const prospectus = await generateProspectus(record);
    record.prospectusGenerated = true;
    record.prospectusFilename = prospectus.filename;
    record.prospectusUrl = prospectus.url;
    record.status = 'prospectus-generated';
    
    // Update status
    await inquiryOps.updateStatus(record.id, {
      status: 'prospectus-generated',
      prospectusFilename: prospectus.filename,
      prospectusUrl: prospectus.url
    });
    
    // Update slug index
    slugIndex[record.slug] = prospectus.url;
    await fileSystem.saveSlugIndex();
    
    res.json({
      success: true,
      message: 'Inquiry received and prospectus generated',
      inquiryId: record.id,
      slug: record.slug,
      prospectusUrl: `${base}${prospectus.url}`,
      prettyUrl: `${base}/${record.slug}`
    });
    
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Get all inquiries
app.get(ENDPOINTS.inquiries, async (req, res) => {
  try {
    const inquiries = await inquiryOps.getAllInquiries();
    res.json({
      success: true,
      count: inquiries.length,
      inquiries
    });
  } catch (error) {
    console.error('Error fetching inquiries:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch inquiries'
    });
  }
});

// Dashboard data endpoint
app.get(ENDPOINTS.dashboardData, async (req, res) => {
  try {
    const inquiries = await inquiryOps.getAllInquiries();
    const totalInquiries = inquiries.length;
    const prospectusGenerated = inquiries.filter(i => i.prospectusGenerated).length;
    
    // Get engagement data if database is available
    let engagementStats = null;
    if (db) {
      const engagementResult = await db.query(`
        SELECT 
          COUNT(DISTINCT inquiry_id) as engaged_families,
          AVG(time_on_page) as avg_time_on_page,
          AVG(scroll_depth) as avg_scroll_depth,
          SUM(clicks_on_links) as total_clicks
        FROM engagement_metrics
      `);
      engagementStats = engagementResult.rows[0];
    }
    
    res.json({
      success: true,
      summary: {
        totalInquiries,
        prospectusGenerated,
        conversionRate: totalInquiries > 0 ? ((prospectusGenerated / totalInquiries) * 100).toFixed(1) : 0,
        engagementStats
      },
      recentInquiries: inquiries.slice(0, 10),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Dashboard data error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate dashboard data'
    });
  }
});

// Track engagement endpoint
app.post([ENDPOINTS.trackEngagement, ENDPOINTS.trackLegacy], async (req, res) => {
  try {
    const data = req.body;
    
    // Decrypt inquiry ID if encrypted
    const inquiryId = encryption.decrypt(data.inquiryId);
    
    // Track the event
    if (data.eventType) {
      await database.trackEngagementEvent({
        ...data,
        inquiryId,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent']
      });
    }
    
    // Update metrics if provided
    if (data.metrics) {
      await database.updateEngagementMetrics(inquiryId, {
        ...data.metrics,
        sessionId: data.sessionId
      });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Tracking error:', error);
    res.status(500).json({ success: false });
  }
});

// AI endpoints
app.post('/api/ai/engagement-summary/:inquiryId', async (req, res) => {
  try {
    const { inquiryId } = req.params;
    const analysis = await analyzeEngagementForInquiry(inquiryId);
    res.json({ success: true, analysis });
  } catch (error) {
    console.error('AI analysis error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to analyze engagement'
    });
  }
});

app.post('/api/ai/analyze-family/:inquiryId', async (req, res) => {
  try {
    const { inquiryId } = req.params;
    const analysis = await analyzeEngagementForInquiry(inquiryId);
    res.json({ success: true, analysis });
  } catch (error) {
    console.error('AI analysis error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to analyze family'
    });
  }
});

app.post('/api/ai/analyze-all-families', async (req, res) => {
  try {
    const inquiries = await inquiryOps.getAllInquiries();
    const analyses = await Promise.all(
      inquiries.slice(0, 10).map(inquiry => analyzeEngagementForInquiry(inquiry.id))
    );
    
    res.json({
      success: true,
      totalAnalyzed: analyses.length,
      analyses,
      summary: {
        hotLeads: analyses.filter(a => a.leadTemperature === 'hot').length,
        warmLeads: analyses.filter(a => a.leadTemperature === 'warm').length,
        coldLeads: analyses.filter(a => a.leadTemperature === 'cold').length
      }
    });
  } catch (error) {
    console.error('Bulk AI analysis error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to analyze all families'
    });
  }
});

// Admin endpoints
app.get(ENDPOINTS.rebuildSlugs, async (req, res) => {
  const before = Object.keys(slugIndex).length;
  const added = await fileSystem.rebuildSlugIndexFromData();
  const after = Object.keys(slugIndex).length;
  
  res.json({
    success: true,
    before,
    added,
    after,
    message: `Rebuilt slug index: ${added} new mappings added`
  });
});

// Pretty URL handler (slug-based routing)
app.get('/:slug', async (req, res, next) => {
  const slug = req.params.slug.toLowerCase();
  
  // Skip if it looks like a file or API route
  if (slug.includes('.') || slug.startsWith('api')) {
    return next();
  }
  
  try {
    // Check slug index first
    if (slugIndex[slug]) {
      const prospectusPath = path.join(__dirname, slugIndex[slug]);
      return res.sendFile(prospectusPath);
    }
    
    // Try to find inquiry and generate prospectus if needed
    const inquiry = await inquiryOps.findBySlug(slug);
    if (inquiry) {
      if (!inquiry.prospectusFilename) {
        const prospectus = await generateProspectus(inquiry);
        await inquiryOps.updateStatus(inquiry.id, {
          status: 'prospectus-generated',
          prospectusFilename: prospectus.filename,
          prospectusUrl: prospectus.url
        });
        slugIndex[slug] = prospectus.url;
        await fileSystem.saveSlugIndex();
        return res.sendFile(path.join(__dirname, prospectus.url));
      } else {
        const prospectusPath = path.join(__dirname, 'prospectuses', inquiry.prospectusFilename);
        return res.sendFile(prospectusPath);
      }
    }
    
    next();
  } catch (error) {
    console.error('Slug routing error:', error);
    next();
  }
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

// 404 handler - must be last
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
    message: `Route ${req.method} ${req.path} not found`
  });
});

// ===================== SERVER LIFECYCLE =====================

// Unified shutdown handler
async function handleShutdown(signal) {
  console.log(`\nShutting down gracefully (${signal})...`);
  
  if (db) {
    await db.end();
    console.log('Database connection closed.');
  }
  
  process.exit(0);
}

// Server startup
async function startServer() {
  console.log('Starting More House School System...');
  
  try {
    const dbConnected = await database.initialize();
    await fileSystem.ensureDirectories();
    await fileSystem.loadSlugIndex();
    await fileSystem.rebuildSlugIndexFromData();
    
    app.listen(PORT, () => {
      console.log(`
╔════════════════════════════════════════════════════════╗
║           MORE HOUSE SCHOOL SYSTEM v${CONFIG.VERSION}           ║
╠════════════════════════════════════════════════════════╣
║ Server:      http://localhost:${PORT}                      ║
║ Database:    ${dbConnected ? '✅ PostgreSQL Connected' : '📁 JSON-only mode      '}      ║
║ Environment: ${CONFIG.ENVIRONMENT.padEnd(26)} ║
║ Status:      🟢 All systems operational               ║
╚════════════════════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// Start the server
startServer();

// Export for testing or external use
module.exports = {
  app,
  utils,
  database,
  encryption,
  fileSystem,
  inquiryOps,
  generateProspectus,
  analyzeEngagementForInquiry
};