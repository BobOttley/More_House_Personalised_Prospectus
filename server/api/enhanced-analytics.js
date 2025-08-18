// Enhanced API endpoints for AI-powered analytics
// File: server/api/enhanced-analytics.js

const express = require('express');
const { Pool } = require('pg');
const router = express.Router();

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ================================================
// ENHANCED TRACKING ENDPOINT
// ================================================

router.post('/track-engagement', async (req, res) => {
    try {
        const { events, sessionInfo } = req.body;
        
        if (!events || !Array.isArray(events)) {
            return res.status(400).json({ success: false, error: 'Invalid events data' });
        }

        console.log(`📊 Processing ${events.length} enhanced events for inquiry: ${sessionInfo?.inquiryId}`);

        // Process each event with enhanced data
        for (const event of events) {
            await insertEnhancedEvent(event, sessionInfo);
        }

        // Check for AI analysis triggers
        const shouldTriggerAI = await checkAIAnalysisTriggers(sessionInfo?.inquiryId);
        let aiAnalysisTriggered = false;

        if (shouldTriggerAI) {
            // Trigger background AI analysis
            setImmediate(() => performAIAnalysis(sessionInfo?.inquiryId));
            aiAnalysisTriggered = true;
        }

        // Update session summary with enhanced metrics
        if (sessionInfo?.sessionComplete) {
            await updateEnhancedSessionSummary(sessionInfo);
        }

        res.json({ 
            success: true, 
            message: 'Enhanced events tracked successfully',
            eventsProcessed: events.length,
            aiAnalysisTriggered: aiAnalysisTriggered
        });

    } catch (error) {
        console.error('❌ Error in enhanced tracking:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process enhanced tracking data',
            message: error.message
        });
    }
});

// ================================================
// AI ANALYTICS ENDPOINTS
// ================================================

// Get AI-enhanced statistics
router.get('/ai-stats', async (req, res) => {
    try {
        const stats = await calculateAIStats();
        res.json(stats);
    } catch (error) {
        console.error('❌ Error fetching AI stats:', error);
        res.status(500).json({ error: 'Failed to fetch AI statistics' });
    }
});

// Get families with AI scores and insights
router.get('/ai-inquiries', async (req, res) => {
    try {
        const families = await getFamiliesWithAIData();
        res.json(families);
    } catch (error) {
        console.error('❌ Error fetching AI families:', error);
        res.status(500).json({ error: 'Failed to fetch families with AI data' });
    }
});

// Get enhanced activity feed
router.get('/enhanced-activity', async (req, res) => {
    try {
        const activity = await getEnhancedActivity();
        res.json(activity);
    } catch (error) {
        console.error('❌ Error fetching enhanced activity:', error);
        res.status(500).json({ error: 'Failed to fetch enhanced activity' });
    }
});

// Analyze specific family with AI
router.post('/ai-analyze-family', async (req, res) => {
    try {
        const { familyId } = req.body;
        
        if (!familyId) {
            return res.status(400).json({ error: 'Family ID required' });
        }

        console.log(`🤖 AI analyzing family: ${familyId}`);
        
        const analysis = await performFamilyAIAnalysis(familyId);
        
        res.json({
            success: true,
            insights: analysis.insights,
            score: analysis.score,
            recommendedAction: analysis.recommendedAction,
            analysisTimestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Error in AI family analysis:', error);
        res.status(500).json({ error: 'AI analysis failed', message: error.message });
    }
});

// Analyze all families with AI
router.post('/ai-analyze-all', async (req, res) => {
    try {
        console.log('🤖 AI analyzing all families...');
        
        const result = await performBulkAIAnalysis();
        
        res.json({
            success: true,
            analyzed: result.analyzed,
            updated: result.updated,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Error in bulk AI analysis:', error);
        res.status(500).json({ error: 'Bulk AI analysis failed', message: error.message });
    }
});

// ================================================
// ENHANCED EVENT PROCESSING
// ================================================

async function insertEnhancedEvent(event, sessionInfo) {
    const query = `
        INSERT INTO tracking_events (
            inquiry_id, session_id, event_type, timestamp, event_data,
            url, user_agent, device_type, is_meaningful_event,
            engagement_score, current_section, scroll_depth,
            time_on_page, conversion_signals
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `;

    const values = [
        event.inquiryId,
        event.sessionId,
        event.eventType,
        event.timestamp,
        JSON.stringify(event.data || {}),
        event.url,
        sessionInfo?.deviceInfo?.userAgent || '',
        sessionInfo?.deviceInfo?.isMobile ? 'mobile' : 'desktop',
        event.isMeaningfulEvent || false,
        event.engagementScore || 0,
        event.currentSection || null,
        event.scrollDepth || 0,
        event.timeOnPage || 0,
        event.data?.conversionSignals || 0
    ];

    await pool.query(query, values);
}

async function updateEnhancedSessionSummary(sessionInfo) {
    const query = `
        INSERT INTO session_summaries (
            inquiry_id, session_id, start_time, end_time, duration_seconds,
            device_type, is_mobile, user_agent, total_events, meaningful_events,
            sections_visited, max_scroll_depth, engagement_score, conversion_signals,
            section_times, video_engagement, youtube_videos, behavioral_metrics
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        ON CONFLICT (inquiry_id, session_id) DO UPDATE SET
            end_time = EXCLUDED.end_time,
            duration_seconds = EXCLUDED.duration_seconds,
            total_events = EXCLUDED.total_events,
            meaningful_events = EXCLUDED.meaningful_events,
            engagement_score = EXCLUDED.engagement_score,
            conversion_signals = EXCLUDED.conversion_signals,
            section_times = EXCLUDED.section_times,
            video_engagement = EXCLUDED.video_engagement,
            youtube_videos = EXCLUDED.youtube_videos,
            behavioral_metrics = EXCLUDED.behavioral_metrics,
            updated_at = CURRENT_TIMESTAMP
    `;

    const values = [
        sessionInfo.inquiryId,
        sessionInfo.sessionId,
        new Date(sessionInfo.sessionStartTime),
        new Date(),
        sessionInfo.timeOnPage,
        sessionInfo.deviceInfo?.isMobile ? 'mobile' : 'desktop',
        sessionInfo.deviceInfo?.isMobile || false,
        sessionInfo.deviceInfo?.userAgent || '',
        sessionInfo.totalEvents,
        sessionInfo.meaningfulEvents || 0,
        Object.keys(sessionInfo.sectionViews || {}).length,
        sessionInfo.maxScrollDepth,
        sessionInfo.engagementScore,
        sessionInfo.conversionSignals,
        JSON.stringify(sessionInfo.sectionViews || {}),
        sessionInfo.videoEngagement || 0,
        JSON.stringify(sessionInfo.youtubeVideos || {}),
        JSON.stringify(sessionInfo.behavioralMetrics || {})
    ];

    await pool.query(query, values);
}

// ================================================
// AI ANALYSIS FUNCTIONS
// ================================================

async function performFamilyAIAnalysis(familyId) {
    console.log(`🤖 Performing AI analysis for family: ${familyId}`);

    // Get comprehensive family data
    const familyData = await getFamilyComprehensiveData(familyId);
    
    if (!familyData) {
        throw new Error('Family not found');
    }

    // AI Analysis Engine
    const analysis = await runAIAnalysisEngine(familyData);
    
    // Store AI insights
    await storeAIInsights(familyId, analysis);
    
    return analysis;
}

async function getFamilyComprehensiveData(familyId) {
    // Get basic family info
    const familyQuery = `
        SELECT i.*, fes.engagement_level, fes.contact_readiness_score, fes.last_calculated
        FROM inquiries i
        LEFT JOIN family_engagement_summary fes ON i.id = fes.inquiry_id
        WHERE i.id = $1
    `;
    
    const familyResult = await pool.query(familyQuery, [familyId]);
    if (familyResult.rows.length === 0) return null;
    
    const family = familyResult.rows[0];

    // Get session data
    const sessionsQuery = `
        SELECT * FROM session_summaries 
        WHERE inquiry_id = $1 
        ORDER BY start_time DESC
    `;
    const sessions = await pool.query(sessionsQuery, [familyId]);

    // Get recent meaningful events
    const eventsQuery = `
        SELECT * FROM tracking_events 
        WHERE inquiry_id = $1 AND is_meaningful_event = true
        ORDER BY timestamp DESC 
        LIMIT 100
    `;
    const events = await pool.query(eventsQuery, [familyId]);

    return {
        family: family,
        sessions: sessions.rows,
        events: events.rows,
        analysisTimestamp: new Date()
    };
}

async function runAIAnalysisEngine(familyData) {
    const { family, sessions, events } = familyData;
    
    // AI Analysis Calculations
    const engagementScore = calculateAIEngagementScore(family, sessions, events);
    const behaviorPattern = analyzeBehaviorPattern(events);
    const contentPreferences = analyzeContentPreferences(sessions, events);
    const conversionProbability = calculateConversionProbability(family, sessions, events);
    const recommendedAction = determineRecommendedAction(engagementScore, conversionProbability, behaviorPattern);
    
    // Generate AI insights
    const insights = generateAIInsights(family, {
        engagementScore,
        behaviorPattern,
        contentPreferences,
        conversionProbability,
        sessions,
        events
    });

    return {
        score: engagementScore,
        insights: insights,
        recommendedAction: recommendedAction,
        behaviorPattern: behaviorPattern,
        contentPreferences: contentPreferences,
        conversionProbability: conversionProbability,
        analysisMetadata: {
            sessionsAnalyzed: sessions.length,
            eventsAnalyzed: events.length,
            confidenceLevel: calculateConfidenceLevel(sessions, events)
        }
    };
}

function calculateAIEngagementScore(family, sessions, events) {
    let score = 0;
    
    if (sessions.length === 0) return 0;

    // Time engagement (30 points)
    const totalTime = sessions.reduce((sum, s) => sum + (s.duration_seconds || 0), 0);
    const avgSessionTime = totalTime / sessions.length;
    score += Math.min((avgSessionTime / 300) * 30, 30); // 5 minutes = 30 points

    // Content diversity (25 points) 
    const uniqueSections = new Set();
    sessions.forEach(s => {
        if (s.section_times) {
            Object.keys(s.section_times).forEach(section => uniqueSections.add(section));
        }
    });
    score += Math.min((uniqueSections.size / 8) * 25, 25); // 8 sections = 25 points

    // Video engagement (20 points)
    const videoEngagement = sessions.reduce((sum, s) => {
        if (s.youtube_videos) {
            return sum + Object.keys(s.youtube_videos).length;
        }
        return sum;
    }, 0);
    score += Math.min((videoEngagement / 5) * 20, 20); // 5 videos = 20 points

    // Conversion signals (15 points)
    const conversionSignals = sessions.reduce((sum, s) => sum + (s.conversion_signals || 0), 0);
    score += Math.min(conversionSignals * 5, 15); // 3 signals = 15 points

    // Return visits (10 points)
    const returnVisits = sessions.length - 1;
    score += Math.min((returnVisits / 3) * 10, 10); // 3 returns = 10 points

    return Math.round(score);
}

function analyzeBehaviorPattern(events) {
    const patterns = {
        readingSpeed: 'average',
        navigationStyle: 'linear',
        interactionLevel: 'medium',
        attentionSpan: 'normal',
        contentPreference: 'mixed'
    };

    if (events.length === 0) return patterns;

    // Analyze reading speed from scroll events
    const scrollEvents = events.filter(e => e.event_type === 'scroll_milestone');
    if (scrollEvents.length > 3) {
        const timeToComplete = scrollEvents[scrollEvents.length - 1].time_on_page - scrollEvents[0].time_on_page;
        patterns.readingSpeed = timeToComplete < 120 ? 'fast' : timeToComplete > 300 ? 'slow' : 'average';
    }

    // Analyze navigation style
    const navigationEvents = events.filter(e => ['section_enter', 'entry_point_interaction'].includes(e.event_type));
    if (navigationEvents.length > 5) {
        patterns.navigationStyle = 'exploratory';
    }

    // Analyze interaction level
    const interactionEvents = events.filter(e => e.is_meaningful_event);
    const interactionRate = interactionEvents.length / Math.max(events.length, 1);
    patterns.interactionLevel = interactionRate > 0.3 ? 'high' : interactionRate > 0.15 ? 'medium' : 'low';

    // Analyze content preference
    const videoEvents = events.filter(e => e.event_type.includes('video'));
    const textEvents = events.filter(e => ['section_enter', 'scroll_milestone'].includes(e.event_type));
    
    if (videoEvents.length > textEvents.length) {
        patterns.contentPreference = 'video';
    } else if (textEvents.length > videoEvents.length * 2) {
        patterns.contentPreference = 'text';
    }

    return patterns;
}

function analyzeContentPreferences(sessions, events) {
    const preferences = {
        preferredSections: [],
        videoEngagement: 'low',
        interactiveContent: 'medium',
        timeOfDayPreference: 'any'
    };

    // Analyze section preferences
    const sectionTimes = {};
    sessions.forEach(session => {
        if (session.section_times) {
            Object.entries(session.section_times).forEach(([section, time]) => {
                sectionTimes[section] = (sectionTimes[section] || 0) + time;
            });
        }
    });

    preferences.preferredSections = Object.entries(sectionTimes)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 3)
        .map(([section]) => section);

    // Analyze video engagement
    const videoEvents = events.filter(e => e.event_type.includes('youtube'));
    if (videoEvents.length > 5) {
        preferences.videoEngagement = 'high';
    } else if (videoEvents.length > 2) {
        preferences.videoEngagement = 'medium';
    }

    return preferences;
}

function calculateConversionProbability(family, sessions, events) {
    let probability = 0;

    // Base probability from engagement
    const totalTime = sessions.reduce((sum, s) => sum + (s.duration_seconds || 0), 0);
    if (totalTime > 600) probability += 20; // 10+ minutes total
    if (totalTime > 1200) probability += 20; // 20+ minutes total

    // Video completion signals high interest
    const videoCompleteEvents = events.filter(e => e.event_type === 'youtube_video_complete');
    probability += Math.min(videoCompleteEvents.length * 15, 30);

    // Entry point exploration
    const entryPointEvents = events.filter(e => e.event_type === 'entry_point_interaction');
    probability += Math.min(entryPointEvents.length * 10, 20);

    // Conversion signals
    const conversionSignals = sessions.reduce((sum, s) => sum + (s.conversion_signals || 0), 0);
    probability += Math.min(conversionSignals * 20, 40);

    // Return visits
    if (sessions.length > 1) probability += 15;
    if (sessions.length > 2) probability += 15;

    return Math.min(probability, 100);
}

function determineRecommendedAction(engagementScore, conversionProbability, behaviorPattern) {
    if (conversionProbability > 70 && engagementScore > 70) {
        return 'immediate_contact';
    } else if (conversionProbability > 50 || engagementScore > 60) {
        return 'priority_followup';
    } else if (engagementScore > 30) {
        return 'standard_followup';
    } else {
        return 'nurture_sequence';
    }
}

function generateAIInsights(family, analysisData) {
    const { engagementScore, behaviorPattern, contentPreferences, conversionProbability, sessions, events } = analysisData;
    
    let insights = {
        summary: '',
        recommendations: [],
        keyFindings: [],
        nextActions: []
    };

    // Generate summary
    if (engagementScore > 80) {
        insights.summary = `${family.first_name || 'This family'} shows exceptional engagement with ${engagementScore}/100 AI score. Strong conversion potential with ${conversionProbability}% probability.`;
    } else if (engagementScore > 60) {
        insights.summary = `${family.first_name || 'This family'} demonstrates high interest (${engagementScore}/100). Active exploration across multiple content areas.`;
    } else if (engagementScore > 40) {
        insights.summary = `${family.first_name || 'This family'} shows moderate engagement (${engagementScore}/100). Standard nurturing approach recommended.`;
    } else {
        insights.summary = `${family.first_name || 'This family'} has limited engagement so far (${engagementScore}/100). Early stage browsing behavior detected.`;
    }

    // Generate recommendations
    if (contentPreferences.videoEngagement === 'high') {
        insights.recommendations.push('Video-focused');
        insights.recommendations.push('Visual learner');
    }
    
    if (contentPreferences.preferredSections.includes('entry-points')) {
        insights.recommendations.push('Entry timing important');
    }
    
    if (behaviorPattern.interactionLevel === 'high') {
        insights.recommendations.push('Highly interactive');
        insights.recommendations.push('Engaged explorer');
    }

    if (sessions.length > 1) {
        insights.recommendations.push('Return visitor');
    }

    // Generate key findings
    if (conversionProbability > 60) {
        insights.keyFindings.push('High conversion probability detected');
    }
    
    const totalVideoTime = events.filter(e => e.event_type.includes('youtube')).length;
    if (totalVideoTime > 3) {
        insights.keyFindings.push('Strong video engagement');
    }

    return insights;
}

function calculateConfidenceLevel(sessions, events) {
    if (sessions.length >= 2 && events.length >= 10) return 'high';
    if (sessions.length >= 1 && events.length >= 5) return 'medium';
    return 'low';
}

async function storeAIInsights(familyId, analysis) {
    const query = `
        UPDATE inquiries SET 
            ai_score = $1,
            ai_insights = $2,
            ai_recommended_action = $3,
            ai_last_analyzed = CURRENT_TIMESTAMP,
            ai_confidence_level = $4
        WHERE id = $5
    `;

    const values = [
        analysis.score,
        JSON.stringify(analysis.insights),
        analysis.recommendedAction,
        analysis.analysisMetadata.confidenceLevel,
        familyId
    ];

    await pool.query(query, values);
}

async function performBulkAIAnalysis() {
    // Get families that need AI analysis (haven't been analyzed recently)
    const query = `
        SELECT id FROM inquiries 
        WHERE ai_last_analyzed IS NULL 
           OR ai_last_analyzed < CURRENT_TIMESTAMP - INTERVAL '24 hours'
        ORDER BY created_at DESC
        LIMIT 50
    `;
    
    const result = await pool.query(query);
    const families = result.rows;
    
    let analyzed = 0;
    let updated = 0;

    for (const family of families) {
        try {
            await performFamilyAIAnalysis(family.id);
            analyzed++;
            updated++;
        } catch (error) {
            console.error(`❌ Error analyzing family ${family.id}:`, error);
        }
    }

    return { analyzed, updated };
}

async function checkAIAnalysisTriggers(inquiryId) {
    if (!inquiryId) return false;

    // Check if family has significant new activity
    const query = `
        SELECT COUNT(*) as event_count
        FROM tracking_events 
        WHERE inquiry_id = $1 
          AND is_meaningful_event = true
          AND timestamp > CURRENT_TIMESTAMP - INTERVAL '1 hour'
    `;
    
    const result = await pool.query(query, [inquiryId]);
    const recentEvents = parseInt(result.rows[0].event_count);
    
    return recentEvents >= 5; // Trigger AI analysis after 5 meaningful events
}

// ================================================
// DATA RETRIEVAL FUNCTIONS
// ================================================

async function calculateAIStats() {
    const stats = {
        aiHotLeads: 0,
        immediateContact: 0,
        avgAIScore: 0,
        videoEngagement: 0,
        hotLeadsInsight: '',
        immediateContactInsight: '',
        aiScoreInsight: '',
        videoInsight: '',
        hotLeadsTrend: '',
        immediateContactTrend: '',
        aiScoreTrend: '',
        videoTrend: ''
    };

    try {
        // Get AI hot leads (score > 70)
        const hotLeadsQuery = `
            SELECT COUNT(*) as count 
            FROM inquiries 
            WHERE ai_score > 70 AND ai_last_analyzed > CURRENT_TIMESTAMP - INTERVAL '7 days'
        `;
        const hotLeadsResult = await pool.query(hotLeadsQuery);
        stats.aiHotLeads = parseInt(hotLeadsResult.rows[0].count);

        // Get immediate contact families
        const immediateContactQuery = `
            SELECT COUNT(*) as count 
            FROM inquiries 
            WHERE ai_recommended_action = 'immediate_contact'
        `;
        const immediateContactResult = await pool.query(immediateContactQuery);
        stats.immediateContact = parseInt(immediateContactResult.rows[0].count);

        // Get average AI score
        const avgScoreQuery = `
            SELECT AVG(ai_score) as avg_score 
            FROM inquiries 
            WHERE ai_score IS NOT NULL
        `;
        const avgScoreResult = await pool.query(avgScoreQuery);
        stats.avgAIScore = Math.round(avgScoreResult.rows[0].avg_score || 0);

        // Get video engagement percentage
        const videoEngagementQuery = `
            SELECT 
                COUNT(CASE WHEN youtube_videos::text != '{}' THEN 1 END) * 100.0 / COUNT(*) as percentage
            FROM session_summaries 
            WHERE created_at > CURRENT_TIMESTAMP - INTERVAL '7 days'
        `;
        const videoResult = await pool.query(videoEngagementQuery);
        stats.videoEngagement = Math.round(videoResult.rows[0].percentage || 0) + '%';

        // Generate AI insights
        stats.hotLeadsInsight = `${stats.aiHotLeads} families show exceptional engagement patterns`;
        stats.immediateContactInsight = `${stats.immediateContact} families ready for immediate outreach`;
        stats.aiScoreInsight = `Average engagement quality across all families`;
        stats.videoInsight = `${stats.videoEngagement} of sessions include video viewing`;

        // Generate trends (placeholder - could be enhanced with historical comparison)
        stats.hotLeadsTrend = stats.aiHotLeads > 0 ? '↗️ Growing' : '→ Stable';
        stats.immediateContactTrend = stats.immediateContact > 0 ? '🔥 Active' : '→ Monitoring';
        stats.aiScoreTrend = stats.avgAIScore > 50 ? '📈 Strong' : '📊 Building';
        stats.videoTrend = 'YouTube API Active';

    } catch (error) {
        console.error('❌ Error calculating AI stats:', error);
    }

    return stats;
}

async function getFamiliesWithAIData() {
    const query = `
        SELECT 
            i.*,
            ai_score,
            ai_insights,
            ai_recommended_action,
            ai_last_analyzed,
            ai_confidence_level,
            (
                SELECT JSON_AGG(
                    JSON_BUILD_OBJECT(
                        'timeOnPage', duration_seconds,
                        'maxScrollDepth', max_scroll_depth,
                        'clickCount', total_events,
                        'sectionViews', section_times,
                        'total_visits', 1,
                        'last_visit', end_time
                    )
                ) 
                FROM session_summaries 
                WHERE inquiry_id = i.id 
                ORDER BY start_time DESC 
                LIMIT 1
            )[0] as engagement,
            (
                SELECT youtube_videos 
                FROM session_summaries 
                WHERE inquiry_id = i.id 
                  AND youtube_videos IS NOT NULL 
                  AND youtube_videos::text != '{}' 
                ORDER BY start_time DESC 
                LIMIT 1
            ) as video_engagement
        FROM inquiries i
        WHERE status IN ('received', 'prospectus_generated', 'engaged')
        ORDER BY 
            CASE 
                WHEN ai_recommended_action = 'immediate_contact' THEN 1
                WHEN ai_recommended_action = 'priority_followup' THEN 2
                WHEN ai_recommended_action = 'standard_followup' THEN 3
                ELSE 4
            END,
            ai_score DESC NULLS LAST,
            created_at DESC
        LIMIT 100
    `;

    const result = await pool.query(query);
    
    return result.rows.map(family => ({
        ...family,
        aiScore: family.ai_score || 0,
        aiInsights: family.ai_insights ? JSON.parse(family.ai_insights) : {},
        aiRecommendedAction: family.ai_recommended_action || 'standard_followup',
        engagement: family.engagement || {},
        videoEngagement: family.video_engagement || {}
    }));
}

async function getEnhancedActivity() {
    const query = `
        SELECT 
            te.*,
            i.first_name,
            i.family_surname,
            CASE 
                WHEN te.event_type IN ('conversion_action', 'youtube_video_complete', 'ai_analysis_trigger') THEN true
                ELSE false
            END as is_high_value
        FROM tracking_events te
        LEFT JOIN inquiries i ON te.inquiry_id = i.id
        WHERE te.timestamp > CURRENT_TIMESTAMP - INTERVAL '24 hours'
          AND te.is_meaningful_event = true
        ORDER BY te.timestamp DESC
        LIMIT 50
    `;

    const result = await pool.query(query);
    
    return result.rows.map(event => ({
        ...event,
        event_data: typeof event.event_data === 'string' ? JSON.parse(event.event_data) : event.event_data
    }));
}

// ================================================
// UTILITY FUNCTIONS
// ================================================

async function performAIAnalysis(inquiryId) {
    try {
        console.log(`🤖 Background AI analysis triggered for: ${inquiryId}`);
        await performFamilyAIAnalysis(inquiryId);
        
        // Update family engagement summary
        await updateFamilyEngagementSummary(inquiryId);
        
    } catch (error) {
        console.error(`❌ Background AI analysis failed for ${inquiryId}:`, error);
    }
}

async function updateFamilyEngagementSummary(inquiryId) {
    // This would update the family_engagement_summary table with AI insights
    const query = `
        INSERT INTO family_engagement_summary (
            inquiry_id, 
            engagement_level, 
            contact_readiness_score,
            recommended_approach,
            last_calculated
        )
        SELECT 
            i.id,
            CASE 
                WHEN i.ai_score > 80 THEN 'very_high'
                WHEN i.ai_score > 60 THEN 'high'
                WHEN i.ai_score > 40 THEN 'medium'
                ELSE 'low'
            END,
            i.ai_score,
            i.ai_recommended_action,
            CURRENT_TIMESTAMP
        FROM inquiries i
        WHERE i.id = $1
        ON CONFLICT (inquiry_id) DO UPDATE SET
            engagement_level = EXCLUDED.engagement_level,
            contact_readiness_score = EXCLUDED.contact_readiness_score,
            recommended_approach = EXCLUDED.recommended_approach,
            last_calculated = EXCLUDED.last_calculated
    `;

    await pool.query(query, [inquiryId]);
}

// ================================================
// WEBHOOK ENDPOINTS FOR REAL-TIME UPDATES
// ================================================

// Webhook for immediate AI analysis triggers
router.post('/webhook/ai-trigger', async (req, res) => {
    try {
        const { inquiryId, eventType, threshold } = req.body;
        
        console.log(`🔔 AI webhook triggered: ${eventType} for ${inquiryId}`);
        
        // Perform immediate AI analysis
        setImmediate(async () => {
            try {
                await performFamilyAIAnalysis(inquiryId);
                console.log(`✅ Webhook AI analysis completed for ${inquiryId}`);
            } catch (error) {
                console.error(`❌ Webhook AI analysis failed for ${inquiryId}:`, error);
            }
        });

        res.json({ success: true, message: 'AI analysis triggered' });

    } catch (error) {
        console.error('❌ Error in AI webhook:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// Real-time family status updates
router.get('/families/:id/ai-status', async (req, res) => {
    try {
        const { id } = req.params;
        
        const query = `
            SELECT 
                ai_score,
                ai_recommended_action,
                ai_last_analyzed,
                ai_confidence_level,
                ai_insights
            FROM inquiries 
            WHERE id = $1
        `;
        
        const result = await pool.query(query, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Family not found' });
        }

        const family = result.rows[0];
        
        res.json({
            aiScore: family.ai_score || 0,
            recommendedAction: family.ai_recommended_action || 'standard_followup',
            lastAnalyzed: family.ai_last_analyzed,
            confidenceLevel: family.ai_confidence_level || 'low',
            insights: family.ai_insights ? JSON.parse(family.ai_insights) : {},
            needsAnalysis: !family.ai_last_analyzed || 
                          new Date() - new Date(family.ai_last_analyzed) > 24 * 60 * 60 * 1000
        });

    } catch (error) {
        console.error('❌ Error fetching AI status:', error);
        res.status(500).json({ error: 'Failed to fetch AI status' });
    }
});

// Batch update AI recommendations
router.post('/ai-update-recommendations', async (req, res) => {
    try {
        const { updates } = req.body; // Array of {familyId, action, notes}
        
        if (!Array.isArray(updates)) {
            return res.status(400).json({ error: 'Updates must be an array' });
        }

        let processed = 0;
        
        for (const update of updates) {
            try {
                const query = `
                    UPDATE inquiries 
                    SET ai_recommended_action = $1,
                        ai_manual_override = $2,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $3
                `;
                
                await pool.query(query, [update.action, update.notes || null, update.familyId]);
                processed++;
                
            } catch (error) {
                console.error(`❌ Error updating family ${update.familyId}:`, error);
            }
        }

        res.json({
            success: true,
            processed: processed,
            total: updates.length
        });

    } catch (error) {
        console.error('❌ Error in batch update:', error);
        res.status(500).json({ error: 'Batch update failed' });
    }
});

// ================================================
// ANALYTICS REPORTING ENDPOINTS
// ================================================

// AI Performance Dashboard
router.get('/ai-performance', async (req, res) => {
    try {
        const performance = await calculateAIPerformance();
        res.json(performance);
    } catch (error) {
        console.error('❌ Error fetching AI performance:', error);
        res.status(500).json({ error: 'Failed to fetch AI performance data' });
    }
});

async function calculateAIPerformance() {
    // Calculate AI system performance metrics
    const queries = {
        totalAnalyzed: `SELECT COUNT(*) FROM inquiries WHERE ai_last_analyzed IS NOT NULL`,
        averageScore: `SELECT AVG(ai_score) FROM inquiries WHERE ai_score IS NOT NULL`,
        highConfidence: `SELECT COUNT(*) FROM inquiries WHERE ai_confidence_level = 'high'`,
        conversionRate: `
            SELECT 
                COUNT(CASE WHEN ai_recommended_action = 'immediate_contact' THEN 1 END) * 100.0 / COUNT(*) 
            FROM inquiries WHERE ai_score IS NOT NULL
        `,
        actionDistribution: `
            SELECT 
                ai_recommended_action,
                COUNT(*) as count
            FROM inquiries 
            WHERE ai_recommended_action IS NOT NULL
            GROUP BY ai_recommended_action
        `
    };

    const results = {};
    
    for (const [key, query] of Object.entries(queries)) {
        try {
            const result = await pool.query(query);
            
            if (key === 'actionDistribution') {
                results[key] = result.rows;
            } else {
                results[key] = result.rows[0] ? Object.values(result.rows[0])[0] : 0;
            }
        } catch (error) {
            console.error(`❌ Error in query ${key}:`, error);
            results[key] = key === 'actionDistribution' ? [] : 0;
        }
    }

    return {
        summary: {
            totalFamiliesAnalyzed: parseInt(results.totalAnalyzed || 0),
            averageAIScore: Math.round(results.averageScore || 0),
            highConfidenceAnalyses: parseInt(results.highConfidence || 0),
            recommendedForImmediateContact: Math.round(results.conversionRate || 0)
        },
        actionDistribution: results.actionDistribution.reduce((acc, row) => {
            acc[row.ai_recommended_action] = parseInt(row.count);
            return acc;
        }, {}),
        systemHealth: {
            analysisSuccessRate: 98.5, // Would be calculated from logs
            averageAnalysisTime: 2.3,  // Would be calculated from timestamps
            lastSystemUpdate: new Date().toISOString()
        }
    };
}

// Export the router
module.exports = router;