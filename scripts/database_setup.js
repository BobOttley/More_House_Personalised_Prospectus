#!/usr/bin/env node

/**
 * More House School - Phase 3 Analytics
 * Database Setup Script
 * 
 * This script creates the PostgreSQL tables needed for analytics tracking
 * without affecting your existing JSON data storage system.
 */

require('dotenv').config();
const { Client } = require('pg');

console.log('🏗️  MORE HOUSE ANALYTICS - DATABASE SETUP');
console.log('═══════════════════════════════════════════');

const setupDatabase = async () => {
    let client;
    
    try {
        // Connect to PostgreSQL
        console.log('📡 Connecting to PostgreSQL...');
        client = new Client({
            connectionString: process.env.DATABASE_URL,
            // Alternative connection using individual env vars
            host: process.env.DB_HOST || 'localhost',
            port: process.env.DB_PORT || 5432,
            database: process.env.DB_NAME || 'morehouse_analytics',
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
        });
        
        await client.connect();
        console.log('✅ Connected to PostgreSQL successfully');
        
        // Create inquiries table (mirrors your JSON structure)
        console.log('\n📊 Creating inquiries table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS inquiries (
                id VARCHAR(50) PRIMARY KEY,
                first_name VARCHAR(100) NOT NULL,
                family_surname VARCHAR(100) NOT NULL,
                parent_email VARCHAR(255) NOT NULL,
                age_group VARCHAR(20) NOT NULL,
                entry_year VARCHAR(10) NOT NULL,
                
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
                outdoor_education BOOLEAN DEFAULT FALSE,
                
                -- Family priorities
                academic_excellence BOOLEAN DEFAULT FALSE,
                pastoral_care BOOLEAN DEFAULT FALSE,
                university_preparation BOOLEAN DEFAULT FALSE,
                personal_development BOOLEAN DEFAULT FALSE,
                career_guidance BOOLEAN DEFAULT FALSE,
                extracurricular_opportunities BOOLEAN DEFAULT FALSE,
                
                -- System fields
                received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                status VARCHAR(50) DEFAULT 'received',
                prospectus_generated BOOLEAN DEFAULT FALSE,
                prospectus_filename VARCHAR(255),
                prospectus_url VARCHAR(500),
                prospectus_generated_at TIMESTAMP,
                
                -- Analytics tracking
                user_agent TEXT,
                referrer VARCHAR(500),
                ip_address INET,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Inquiries table created');
        
        // Create tracking events table (FIXED SYNTAX)
        console.log('\n📈 Creating tracking_events table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS tracking_events (
                id SERIAL PRIMARY KEY,
                inquiry_id VARCHAR(50) REFERENCES inquiries(id),
                event_type VARCHAR(100) NOT NULL,
                event_data JSONB,
                page_url VARCHAR(500),
                user_agent TEXT,
                ip_address INET,
                session_id VARCHAR(100),
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Tracking events table created');
        
        // Create engagement metrics table
        console.log('\n📊 Creating engagement_metrics table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS engagement_metrics (
                id SERIAL PRIMARY KEY,
                inquiry_id VARCHAR(50) REFERENCES inquiries(id),
                prospectus_filename VARCHAR(255),
                
                -- Time metrics
                time_on_page INTEGER DEFAULT 0,
                pages_viewed INTEGER DEFAULT 0,
                scroll_depth INTEGER DEFAULT 0,
                
                -- Interaction metrics
                clicks_on_links INTEGER DEFAULT 0,
                downloads INTEGER DEFAULT 0,
                form_interactions INTEGER DEFAULT 0,
                
                -- Session info
                session_id VARCHAR(100),
                first_visit TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_visit TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                total_visits INTEGER DEFAULT 1,
                
                -- Device info
                device_type VARCHAR(50),
                browser VARCHAR(100),
                operating_system VARCHAR(100),
                
                UNIQUE(inquiry_id, session_id)
            );
        `);
        console.log('✅ Engagement metrics table created');
        
        // Create indexes for performance (SEPARATE STATEMENTS)
        console.log('\n🔍 Creating performance indexes...');
        await client.query('CREATE INDEX IF NOT EXISTS idx_inquiries_received_at ON inquiries(received_at);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_inquiries_status ON inquiries(status);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_inquiries_entry_year ON inquiries(entry_year);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_tracking_events_inquiry_id ON tracking_events(inquiry_id);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_tracking_events_event_type ON tracking_events(event_type);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_tracking_events_timestamp ON tracking_events(timestamp);');
        await client.query('CREATE INDEX IF NOT EXISTS idx_engagement_metrics_inquiry_id ON engagement_metrics(inquiry_id);');
        console.log('✅ Performance indexes created');
        
        // Create a function to update timestamps
        console.log('\n⚡ Creating update timestamp function...');
        await client.query(`
            CREATE OR REPLACE FUNCTION update_updated_at_column()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $$ language 'plpgsql';
        `);
        
        await client.query(`
            DROP TRIGGER IF EXISTS update_inquiries_updated_at ON inquiries;
            CREATE TRIGGER update_inquiries_updated_at
                BEFORE UPDATE ON inquiries
                FOR EACH ROW
                EXECUTE FUNCTION update_updated_at_column();
        `);
        console.log('✅ Update timestamp function created');
        
        // Verify tables exist
        console.log('\n🔍 Verifying database setup...');
        const result = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            ORDER BY table_name;
        `);
        
        console.log('📋 Tables created:');
        result.rows.forEach(row => {
            console.log(`   ✅ ${row.table_name}`);
        });
        
        console.log('\n🎉 DATABASE SETUP COMPLETE!');
        console.log('═══════════════════════════════════════════');
        console.log('✅ PostgreSQL database ready for analytics');
        console.log('✅ Your existing JSON files remain unchanged');
        console.log('✅ Ready to start tracking prospectus engagement');
        console.log('\nNext steps:');
        console.log('1. Update your server.js file');
        console.log('2. Add tracking script to prospectuses');
        console.log('3. Create analytics dashboard');
        
    } catch (error) {
        console.error('\n❌ Database setup failed:', error.message);
        console.error('Details:', error);
        
        if (error.message.includes('database') && error.message.includes('does not exist')) {
            console.log('\n💡 TIP: Create the database first:');
            console.log(`   createdb ${process.env.DB_NAME || 'morehouse_analytics'}`);
        }
        
        if (error.message.includes('authentication failed')) {
            console.log('\n💡 TIP: Check your .env file credentials');
        }
        
        process.exit(1);
    } finally {
        if (client) {
            await client.end();
            console.log('\n📡 Database connection closed');
        }
    }
};

// Run the setup
if (require.main === module) {
    setupDatabase();
}

module.exports = { setupDatabase };