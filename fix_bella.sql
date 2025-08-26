INSERT INTO ai_family_insights (inquiry_id, analysis_type, insights_json, generated_at)
VALUES (
  'INQ-175562986068460',
  'engagement_summary',
  '{
    "narrative": "Bella Stella''s family spent 7 minutes exploring their personalised prospectus, with strong focus on About More House and Creative Arts sections (over a minute each, 100% scroll). They also fully reviewed Academic Excellence and Ethical Leaders sections. This engagement pattern shows balanced interest in both academic and creative programmes. A follow-up about creative arts integration would be valuable.",
    "highlights": [
      "• 7 minutes of focused engagement",
      "• Strong interest in Creative Arts and About More House",
      "• 100% scroll on 4 key sections",
      "• Balanced academic and creative interest",
      "• Ready for targeted follow-up"
    ]
  }'::jsonb,
  NOW()
)
ON CONFLICT (inquiry_id, analysis_type)
DO UPDATE SET 
  insights_json = EXCLUDED.insights_json,
  generated_at = NOW();
