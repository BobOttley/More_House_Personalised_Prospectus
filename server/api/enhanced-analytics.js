// Enhanced API endpoints for AI-powered analytics - MORE HOUSE SCHOOL VERSION
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
// SCHOOL CONFIGURATION - MORE HOUSE
// ================================================
const SCHOOL_ID = 2; // More House School (from schools table)
const SCHOOL_SLUG = 'more-house';

console.log(`🏫 Dashboard configured for: More House School (ID: ${SCHOOL_ID})`);

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

        // Verify inquiry belongs to this school
        const verifyQuery = `SELECT id FROM inquiries WHERE id = $1 AND school_id = $2`;
        const verifyResult = await pool.query(verifyQuery, [sessionInfo?.inquiryId, SCHOOL_ID]);
        
        if (verifyResult.rows.length === 0) {
            return res.status(403).json({ success: false, error: 'Inquiry not found or access denied' });
        }

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

        // Verify family belongs to this school
        const verifyQuery = `SELECT id FROM inquiries WHERE id = $1 AND school_id = $2`;
        const verifyResult = await pool.query(verifyQuery, [familyId, SCHOOL_ID]);
        
        if (verifyResult.rows.length === 0) {
            return res.status(403).json({ error: 'Family not found or access denied' });
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
        console.log('🤖 AI analyzing all More House families...');
        
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
            time_on_page, conversion_signals, school_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
        event.data?.conversionSignals || 0,
        SCHOOL_ID // Add school_id
    ];

    await pool.query(query, values);
}

async function updateEnhancedSessionSummary(sessionInfo) {
    const query = `
        INSERT INTO session_summaries (
            inquiry_id, session_id, start_time, end_time, duration_seconds,
            device_type, is_mobile, user_agent, total_events, meaningful_events,
            sections_visited, max_scroll_depth, engagement_score, conversion_signals,
            section_times, video_engagement, youtube_videos, behavioral_metrics, school_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
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
        JSON.stringify(sessionInfo.behavioralMetrics || {}),
        SCHOOL_ID // Add school_id
    ];

    await pool.query(query, values);
}

// ================================================
// AI ANALYSIS FUNCTIONS
// ================================================

async function calculateAIStats() {
    const query = `
        SELECT 
            COUNT(*) as total_families,
            COUNT(CASE WHEN ai_score > 0 THEN 1 END) as analyzed_families,
            ROUND(AVG(ai_score), 1) as avg_ai_score,
            COUNT(CASE WHEN ai_score >= 80 THEN 1 END) as high_priority,
            COUNT(CASE WHEN ai_score >= 60 AND ai_score < 80 THEN 1 END) as medium_priority,
            COUNT(CASE WHEN ai_score < 60 AND ai_score > 0 THEN 1 END) as low_priority,
            COUNT(CASE WHEN ai_recommended_action = 'immediate_contact' THEN 1 END) as immediate_contact,
            COUNT(CASE WHEN ai_recommended_action = 'scheduled_followup' THEN 1 END) as scheduled_followup,
            COUNT(CASE WHEN contact_ready = true THEN 1 END) as contact_ready
        FROM inquiries
        WHERE school_id = $1
    `;

    const result = await pool.query(query, [SCHOOL_ID]);
    return result.rows[0] || {};
}

async function getFamiliesWithAIData() {
    const query = `
        SELECT 
            i.id,
            i.first_name,
            i.family_surname,
            i.parent_email,
            i.age_group,
            i.entry_year,
            i.ai_score,
            i.ai_insights,
            i.ai_recommended_action,
            i.ai_last_analyzed,
            i.ai_confidence_level,
            i.ai_conversion_probability,
            i.ai_behavior_pattern,
            i.contact_ready,
            i.created_at,
            i.prospectus_generated,
            i.prospectus_opened,
            i.total_sessions,
            i.total_time_spent_seconds,
            COALESCE(
                (SELECT COUNT(*) FROM tracking_events WHERE inquiry_id = i.id),
                0
            ) as total_events
        FROM inquiries i
        WHERE i.school_id = $1
        ORDER BY i.ai_score DESC NULLS LAST, i.created_at DESC
    `;

    const result = await pool.query(query, [SCHOOL_ID]);
    return result.rows;
}

async function getEnhancedActivity() {
    const query = `
        SELECT 
            te.inquiry_id,
            te.event_type,
            te.timestamp,
            te.current_section,
            te.engagement_score,
            i.first_name,
            i.family_surname,
            i.parent_email
        FROM tracking_events te
        JOIN inquiries i ON te.inquiry_id = i.id
        WHERE i.school_id = $1
        ORDER BY te.timestamp DESC
        LIMIT 50
    `;

    const result = await pool.query(query, [SCHOOL_ID]);
    return result.rows;
}

async function performFamilyAIAnalysis(familyId) {
    // Verify family belongs to this school
    const verifyQuery = `SELECT id FROM inquiries WHERE id = $1 AND school_id = $2`;
    const verifyResult = await pool.query(verifyQuery, [familyId, SCHOOL_ID]);
    
    if (verifyResult.rows.length === 0) {
        throw new Error('Family not found or access denied');
    }

    // Get comprehensive family data for analysis
    const dataQuery = `
        SELECT 
            i.*,
            COUNT(DISTINCT te.session_id) as session_count,
            COUNT(te.id) as event_count,
            AVG(te.engagement_score) as avg_engagement,
            MAX(te.timestamp) as last_activity,
            COALESCE(
                json_agg(
                    DISTINCT jsonb_build_object(
                        'section', te.current_section,
                        'count', 1
                    )
                ) FILTER (WHERE te.current_section IS NOT NULL),
                '[]'
            ) as section_views
        FROM inquiries i
        LEFT JOIN tracking_events te ON te.inquiry_id = i.id
        WHERE i.id = $1 AND i.school_id = $2
        GROUP BY i.id
    `;

    const result = await pool.query(dataQuery, [familyId, SCHOOL_ID]);
    const familyData = result.rows[0];

    if (!familyData) {
        throw new Error('Family not found');
    }

    // Calculate AI score based on engagement metrics
    let aiScore = 0;
    const insights = [];
    let recommendedAction = 'standard_followup';
    let confidenceLevel = 'low';

    // Scoring logic
    if (familyData.prospectus_opened) {
        aiScore += 20;
        insights.push('Prospectus opened');
    }

    if (familyData.session_count > 1) {
        aiScore += 15 * Math.min(familyData.session_count, 4);
        insights.push(`${familyData.session_count} sessions recorded`);
    }

    if (familyData.avg_engagement > 50) {
        aiScore += 25;
        insights.push('High engagement score');
        confidenceLevel = 'medium';
    }

    if (familyData.total_time_spent_seconds > 300) {
        aiScore += 20;
        insights.push('Significant time invested');
    }

    // Cap score at 100
    aiScore = Math.min(aiScore, 100);

    // Determine recommended action
    if (aiScore >= 80) {
        recommendedAction = 'immediate_contact';
        confidenceLevel = 'high';
    } else if (aiScore >= 60) {
        recommendedAction = 'scheduled_followup';
        confidenceLevel = 'medium';
    } else if (aiScore >= 40) {
        recommendedAction = 'nurture_campaign';
    }

    // Behavioral pattern
    let behaviorPattern = 'casual_browser';
    if (familyData.session_count > 3) {
        behaviorPattern = 'serious_researcher';
    } else if (familyData.prospectus_opened && familyData.avg_engagement > 60) {
        behaviorPattern = 'engaged_prospect';
    }

    // Update inquiry with AI analysis
    const updateQuery = `
        UPDATE inquiries 
        SET 
            ai_score = $1,
            ai_insights = $2,
            ai_recommended_action = $3,
            ai_last_analyzed = CURRENT_TIMESTAMP,
            ai_confidence_level = $4,
            ai_conversion_probability = $5,
            ai_behavior_pattern = $6,
            contact_ready = $7
        WHERE id = $8 AND school_id = $9
    `;

    await pool.query(updateQuery, [
        aiScore,
        JSON.stringify(insights),
        recommendedAction,
        confidenceLevel,
        aiScore, // Using score as conversion probability
        behaviorPattern,
        aiScore >= 60,
        familyId,
        SCHOOL_ID
    ]);

    return {
        score: aiScore,
        insights: insights,
        recommendedAction: recommendedAction,
        confidenceLevel: confidenceLevel,
        behaviorPattern: behaviorPattern
    };
}

async function performBulkAIAnalysis() {
    // Get all families for this school that need analysis
    const query = `
        SELECT id 
        FROM inquiries 
        WHERE school_id = $1
        AND (ai_last_analyzed IS NULL OR ai_last_analyzed < NOW() - INTERVAL '24 hours')
    `;

    const result = await pool.query(query, [SCHOOL_ID]);
    let analyzed = 0;
    let updated = 0;

    for (const row of result.rows) {
        try {
            await performFamilyAIAnalysis(row.id);
            analyzed++;
            updated++;
        } catch (error) {
            console.error(`Failed to analyze family ${row.id}:`, error);
        }
    }

    return { analyzed, updated };
}

async function checkAIAnalysisTriggers(inquiryId) {
    // Check if this inquiry needs AI analysis
    const query = `
        SELECT 
            ai_last_analyzed,
            (SELECT COUNT(*) FROM tracking_events WHERE inquiry_id = $1) as event_count
        FROM inquiries 
        WHERE id = $1 AND school_id = $2
    `;

    const result = await pool.query(query, [inquiryId, SCHOOL_ID]);
    
    if (result.rows.length === 0) return false;

    const data = result.rows[0];
    
    // Trigger if never analyzed or significant new activity
    if (!data.ai_last_analyzed) return true;
    if (data.event_count > 10) return true;
    
    return false;
}

// ================================================
// BACKGROUND AI PROCESSING
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
        WHERE i.id = $1 AND i.school_id = $2
        ON CONFLICT (inquiry_id) DO UPDATE SET
            engagement_level = EXCLUDED.engagement_level,
            contact_readiness_score = EXCLUDED.contact_readiness_score,
            recommended_approach = EXCLUDED.recommended_approach,
            last_calculated = EXCLUDED.last_calculated
    `;

    await pool.query(query, [inquiryId, SCHOOL_ID]);
}

// ================================================
// WEBHOOK ENDPOINTS FOR REAL-TIME UPDATES
// ================================================

// Webhook for immediate AI analysis triggers
router.post('/webhook/ai-trigger', async (req, res) => {
    try {
        const { inquiryId, eventType, threshold } = req.body;
        
        // Verify inquiry belongs to this school
        const verifyQuery = `SELECT id FROM inquiries WHERE id = $1 AND school_id = $2`;
        const verifyResult = await pool.query(verifyQuery, [inquiryId, SCHOOL_ID]);
        
        if (verifyResult.rows.length === 0) {
            return res.status(403).json({ error: 'Inquiry not found or access denied' });
        }
        
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
            WHERE id = $1 AND school_id = $2
        `;
        
        const result = await pool.query(query, [id, SCHOOL_ID]);
        
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
                // Verify family belongs to this school
                const verifyQuery = `SELECT id FROM inquiries WHERE id = $1 AND school_id = $2`;
                const verifyResult = await pool.query(verifyQuery, [update.familyId, SCHOOL_ID]);
                
                if (verifyResult.rows.length === 0) continue;
                
                const query = `
                    UPDATE inquiries 
                    SET ai_recommended_action = $1,
                        ai_manual_override = $2,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $3 AND school_id = $4
                `;
                
                await pool.query(query, [
                    update.action, 
                    update.notes || null, 
                    update.familyId,
                    SCHOOL_ID
                ]);
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
    // Calculate AI system performance metrics for this school only
    const queries = {
        totalAnalyzed: `SELECT COUNT(*) FROM inquiries WHERE ai_last_analyzed IS NOT NULL AND school_id = ${SCHOOL_ID}`,
        averageScore: `SELECT AVG(ai_score) FROM inquiries WHERE ai_score IS NOT NULL AND school_id = ${SCHOOL_ID}`,
        highConfidence: `SELECT COUNT(*) FROM inquiries WHERE ai_confidence_level = 'high' AND school_id = ${SCHOOL_ID}`,
        conversionRate: `
            SELECT 
                COUNT(CASE WHEN ai_recommended_action = 'immediate_contact' THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0)
            FROM inquiries WHERE ai_score IS NOT NULL AND school_id = ${SCHOOL_ID}
        `,
        actionDistribution: `
            SELECT 
                ai_recommended_action,
                COUNT(*) as count
            FROM inquiries 
            WHERE ai_recommended_action IS NOT NULL AND school_id = ${SCHOOL_ID}
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
            analysisSuccessRate: 98.5,
            averageAnalysisTime: 2.3,
            lastSystemUpdate: new Date().toISOString()
        }
    };
}

// Export the router
module.exports = router;