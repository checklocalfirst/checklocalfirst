-- 025: click/view tracking. No PII, no outbound-link tracking — event_type is
-- a closed enum of interactions on a business's own listing page.
CREATE TABLE business_analytics_events (
    id BIGSERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    event_type VARCHAR(30) NOT NULL CHECK (
        event_type IN ('call_click', 'email_click', 'page_view', 'address_click', 'website_click', 'discount_click')
    ),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_analytics_business_event ON business_analytics_events(business_id, event_type, created_at);

-- Same reasoning as migration 024: RLS on, no policies. The public track route
-- (POST /businesses/:slug/track) inserts through supabaseAdmin after its own
-- validation/rate-limiting, same pattern as the existing public landing-signup
-- insert in signups.js — the anon client is never used against this table.
ALTER TABLE business_analytics_events ENABLE ROW LEVEL SECURITY;
