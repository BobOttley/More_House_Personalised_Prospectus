-- More House School - Phase 3 Production Analytics Database Schema
-- PostgreSQL Database for Render Deployment
-- Stores inquiry data, tracking events, and analytics insights

-- Extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ================================================
-- TABLE 1: INQUIRIES (Existing form data + prospectus links)
-- ================================================
CREATE TABLE inquiries (
    id VARCHAR(50) PRIMARY KEY,  -- INQ-1755364039988685 format
    first_name VARCHAR(100) NOT NULL,
    family_surname VARCHAR(100) NOT NULL,
    parent_email VARCHAR(255) NOT NULL,
    age_group VARCHAR(20) NOT NULL,
    entry_year INTEGER NOT NULL,
    
    -- Academic interests (boolean flags)
    sciences BOOLEAN DEFAULT FALSE,
    mathematics BOOLEAN DEFAULT FALSE,
    english BOOLEAN DEFAULT FALSE,
    languages BOOLEAN DEFAULT FALSE,
    humanities BOOLEAN DEFAULT FALSE,
    business BOOLEAN DEFAULT FALSE,
    
    -- Creative interests
    drama BOOLEAN DEFAULT FALSE,
    music BOOLEAN DEFAULT FALSE,
    art BOOLEAN DEFAULT FALSE,
    creative_writing BOOLEAN DEFAULT FALSE,
    
    -- Co-curricular interests
    sport BOOLEAN DEFAULT FALSE,
    leadership BOOLEAN DEFAULT FALSE,
    community_service BOOLEAN DEFAULT FALSE,
    debating BOOLEAN DEFAULT FALSE,
    
    -- Family priorities
    academic_excellence BOOLEAN DEFAULT FALSE,
    pastoral_care BOOLEAN DEFAULT FALSE,
    small_classes BOOLEAN DEFAULT FALSE,
    london_location BOOLEAN DEFAULT FALSE,
    values_based BOOLEAN DEFAULT FALSE,
    university_prep BOOLEAN DEFAULT FALSE,
    
    -- System fields
    received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(50) DEFAULT 'received',
    
    -- Prospectus generation
    prospectus_generated BOOLEAN DEFAULT FALSE,
    prospectus_filename VARCHAR(255),
    prospectus_url VARCHAR(500),
    prospectus_generated_at TIMESTAMP WITH TIME ZONE,
    
    -- Analytics flags
    first_engagement_at TIMESTAMP WITH TIME ZONE,
    last_engagement_at TIMESTAMP WITH TIME ZONE,
    total_engagement_time INTEGER DEFAULT 0, -- seconds
    engagement_score INTEGER DEFAULT 0, -- 0-100 calculated score
    priority_level VARCHAR(20) DEFAULT 'normal', -- low, normal, high, urgent
    contact_ready BOOLEAN DEFAULT FALSE,
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ================================================
-- TABLE 2: TRACKING EVENTS (All engagement data)
-- ================================================
CREATE TABLE tracking_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    inquiry_id VARCHAR(50) NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
    session_id VARCHAR(100) NOT NULL,
    
    -- Event details
    event_type VARCHAR(50) NOT NULL, -- page_load, section_enter, video_play, etc.
    event_data JSONB, -- Flexible storage for event-specific data
    current_section VARCHAR(50), -- Which section user was in
    
    -- Context
    url VARCHAR(1000),
    user_agent TEXT,
    device_type VARCHAR(20), -- mobile, desktop
    screen_resolution VARCHAR(20),
    viewport VARCHAR(20),
    
    -- Timing
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    session_duration INTEGER, -- milliseconds since session start
    
    -- Engagement metrics
    is_meaningful BOOLEAN DEFAULT TRUE, -- Filter out heartbeats/noise
    engagement_weight DECIMAL(3,2) DEFAULT 1.0, -- 0.1 to 5.0 weight for scoring
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ================================================
-- TABLE 3: SESSION SUMMARIES (Aggregated session data)
-- ================================================
CREATE TABLE session_summaries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    inquiry_id VARCHAR(50) NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
    session_id VARCHAR(100) NOT NULL,
    
    -- Session overview
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE,
    duration_seconds INTEGER,
    
    -- Device and context
    device_type VARCHAR(20),
    is_mobile BOOLEAN,
    user_agent TEXT,
    referrer TEXT,
    is_return_visit BOOLEAN DEFAULT FALSE,
    visit_number INTEGER DEFAULT 1,
    
    -- Engagement metrics
    total_events INTEGER DEFAULT 0,
    meaningful_events INTEGER DEFAULT 0,
    sections_visited INTEGER DEFAULT 0,
    max_scroll_depth INTEGER DEFAULT 0,
    
    -- Section engagement (JSONB for flexibility)
    section_times JSONB, -- {"sciences": 45, "arts": 120, ...}
    
    -- Video engagement
    videos_played INTEGER DEFAULT 0,
    videos_completed INTEGER DEFAULT 0,
    total_video_time INTEGER DEFAULT 0,
    
    -- Downloads and actions
    downloads_count INTEGER DEFAULT 0,
    contact_actions INTEGER DEFAULT 0,
    
    -- Session quality score (0-100)
    engagement_score INTEGER DEFAULT 0,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ================================================
-- TABLE 4: ANALYTICS INSIGHTS (Processed intelligence)
-- ================================================
CREATE TABLE analytics_insights (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    inquiry_id VARCHAR(50) NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
    
    -- Insight details
    insight_type VARCHAR(50) NOT NULL, -- interest_detected, highly_engaged, ready_for_contact
    insight_title VARCHAR(200) NOT NULL,
    insight_description TEXT,
    confidence_score DECIMAL(3,2), -- 0.0 to 1.0
    
    -- Data supporting the insight
    supporting_data JSONB,
    
    -- Actionable recommendations
    recommended_actions JSONB, -- ["Emphasize science facilities", "Mention university placements"]
    priority_level VARCHAR(20) DEFAULT 'normal',
    
    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    is_actionable BOOLEAN DEFAULT TRUE,
    actioned_at TIMESTAMP WITH TIME ZONE,
    actioned_by VARCHAR(100),
    
    -- Timing
    generated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE, -- Some insights may expire
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ================================================
-- TABLE 5: FAMILY ENGAGEMENT SUMMARY (Per-family overview)
-- ================================================
CREATE TABLE family_engagement_summary (
    inquiry_id VARCHAR(50) PRIMARY KEY REFERENCES inquiries(id) ON DELETE CASCADE,
    
    -- Family basics
    family_name VARCHAR(200),
    student_name VARCHAR(200),
    primary_email VARCHAR(255),
    
    -- Engagement overview
    first_visit TIMESTAMP WITH TIME ZONE,
    last_visit TIMESTAMP WITH TIME ZONE,
    total_visits INTEGER DEFAULT 0,
    total_time_seconds INTEGER DEFAULT 0,
    total_sessions INTEGER DEFAULT 0,
    
    -- Interest analysis
    strongest_interests JSONB, -- Top 3 areas based on time spent
    preferred_sections JSONB, -- Sections with most engagement
    content_preferences JSONB, -- Video vs text vs downloads
    
    -- Behavior patterns
    typical_session_length INTEGER, -- average seconds per session
    preferred_device VARCHAR(20), -- mobile or desktop
    active_time_periods JSONB, -- When they typically visit
    
    -- Readiness indicators
    engagement_level VARCHAR(20) DEFAULT 'low', -- low, medium, high, very_high
    interest_depth VARCHAR(20) DEFAULT 'browsing', -- browsing, interested, serious, urgent
    contact_readiness_score INTEGER DEFAULT 0, -- 0-100
    
    -- Contact timing
    optimal_contact_time TIMESTAMP WITH TIME ZONE,
    contact_priority VARCHAR(20) DEFAULT 'normal',
    next_followup_due TIMESTAMP WITH TIME ZONE,
    
    -- Summary insights
    key_insights TEXT[],
    recommended_approach TEXT,
    talking_points JSONB,
    
    -- Metadata
    last_calculated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ================================================
-- INDEXES FOR PERFORMANCE
-- ================================================

-- Tracking events indexes
CREATE INDEX idx_tracking_events_inquiry_id ON tracking_events(inquiry_id);
CREATE INDEX idx_tracking_events_session_id ON tracking_events(session_id);
CREATE INDEX idx_tracking_events_type ON tracking_events(event_type);
CREATE INDEX idx_tracking_events_timestamp ON tracking_events(timestamp);
CREATE INDEX idx_tracking_events_meaningful ON tracking_events(is_meaningful);

-- Session summaries indexes
CREATE INDEX idx_session_summaries_inquiry_id ON session_summaries(inquiry_id);
CREATE INDEX idx_session_summaries_start_time ON session_summaries(start_time);
CREATE INDEX idx_session_summaries_engagement_score ON session_summaries(engagement_score);

-- Analytics insights indexes
CREATE INDEX idx_analytics_insights_inquiry_id ON analytics_insights(inquiry_id);
CREATE INDEX idx_analytics_insights_type ON analytics_insights(insight_type);
CREATE INDEX idx_analytics_insights_active ON analytics_insights(is_active);
CREATE INDEX idx_analytics_insights_priority ON analytics_insights(priority_level);

-- Inquiries indexes
CREATE INDEX idx_inquiries_status ON inquiries(status);
CREATE INDEX idx_inquiries_entry_year ON inquiries(entry_year);
CREATE INDEX idx_inquiries_engagement_score ON inquiries(engagement_score);
CREATE INDEX idx_inquiries_priority ON inquiries(priority_level);
CREATE INDEX idx_inquiries_received_at ON inquiries(received_at);

-- ================================================
-- FUNCTIONS AND TRIGGERS
-- ================================================

-- Function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_inquiries_updated_at 
    BEFORE UPDATE ON inquiries 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_session_summaries_updated_at 
    BEFORE UPDATE ON session_summaries 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_family_engagement_summary_updated_at 
    BEFORE UPDATE ON family_engagement_summary 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================================
-- EXAMPLE DATA STRUCTURE COMMENTS
-- ================================================

-- tracking_events.event_data examples:
-- page_load: {"userAgent": "...", "screenResolution": "1920x1080", "isMobile": false}
-- section_enter: {"section": "sciences", "visitNumber": 2}
-- video_play: {"videoId": "lab-tour", "title": "Science Laboratory Tour", "playCount": 1}
-- download: {"fileName": "curriculum-guide.pdf", "fileType": "pdf", "linkText": "Download Curriculum Guide"}

-- session_summaries.section_times example:
-- {"sciences": 125, "arts": 45, "sixth-form": 89, "admissions": 234}

-- analytics_insights.supporting_data example:
-- {"timeInSciences": 180, "videoPlays": 3, "downloadsCount": 2, "sections": ["sciences", "sixth-form"]}

-- family_engagement_summary.strongest_interests example:
-- [{"area": "sciences", "score": 85}, {"area": "sixth-form", "score": 72}, {"area": "music", "score": 45}]

-- ================================================
-- SAMPLE QUERIES FOR ANALYTICS
-- ================================================

-- Find highly engaged families ready for contact
/*
SELECT 
    i.id,
    i.first_name,
    i.family_surname,
    i.parent_email,
    fes.engagement_level,
    fes.contact_readiness_score,
    fes.recommended_approach
FROM inquiries i
JOIN family_engagement_summary fes ON i.id = fes.inquiry_id
WHERE fes.contact_readiness_score > 70
    AND i.contact_ready = FALSE
ORDER BY fes.contact_readiness_score DESC;
*/

-- Get insights for a specific family
/*
SELECT * FROM analytics_insights 
WHERE inquiry_id = 'INQ-1755364039988685' 
    AND is_active = TRUE 
ORDER BY confidence_score DESC;
*/

-- Session engagement trends
/*
SELECT 
    DATE(start_time) as date,
    COUNT(*) as sessions,
    AVG(duration_seconds) as avg_duration,
    AVG(engagement_score) as avg_engagement
FROM session_summaries 
WHERE start_time > CURRENT_DATE - INTERVAL '30 days'
GROUP BY DATE(start_time)
ORDER BY date;
*/