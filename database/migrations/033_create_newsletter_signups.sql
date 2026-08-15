-- 033: newsletter_signups — a lightweight, standalone email capture list.
--
-- Deliberately separate from landing_signups (migration 004): that table
-- backs the landing-page waitlist and requires name + source for attribution.
-- This one is just "give us your email," so it only stores that plus when
-- they signed up. Keep it this way unless a real requirement (e.g. per-source
-- attribution, double opt-in, unsubscribe tracking) shows up — don't grow this
-- table to match landing_signups speculatively.
CREATE TABLE newsletter_signups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS on, no policies: matches the Aug 1, 2026 project-wide hardening pass
-- (see migration 026's note). Nobody needs to read this table from the
-- client — the only write path is POST /newsletter, which goes through
-- supabaseAdmin (service-role key) and bypasses RLS regardless. This just
-- makes sure the anon/authenticated roles can't read or write it directly
-- via Supabase's REST API.
ALTER TABLE newsletter_signups ENABLE ROW LEVEL SECURITY;
