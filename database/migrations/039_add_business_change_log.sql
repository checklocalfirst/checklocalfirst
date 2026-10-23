-- 039: Business change log — who changed what on a business profile, and when.
--
-- One row per save. `changes` holds only the fields that actually changed:
--   { "<field>": { "from": <old>, "to": <new> }, ... }
-- written by api/helpers/changeLog.js from the owner routes (profile, hours,
-- categories, services), the matching admin routes (plus status changes),
-- signup provisioning (business_created) and both delete routes
-- (business_deleted).
--
-- business_id is SET NULL on delete and business_name is a snapshot, so the
-- history survives the business being deleted. actor_user_id has no FK for the
-- same reason (deleted users keep their log rows).
--
-- Read through GET /admin/change-log and GET /admin/businesses/:id/change-log.
-- Service-role only: RLS on, no policies.

BEGIN;

CREATE TABLE IF NOT EXISTS business_change_log (
    id BIGSERIAL PRIMARY KEY,
    business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
    business_name TEXT NOT NULL,
    actor_user_id UUID,
    actor_role VARCHAR(10) NOT NULL CHECK (actor_role IN ('owner', 'admin', 'system')),
    action VARCHAR(40) NOT NULL,
    entity_id INTEGER,               -- e.g. the service id for service_* actions
    changes JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_business_change_log_business ON business_change_log (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_change_log_created ON business_change_log (created_at DESC);

ALTER TABLE business_change_log ENABLE ROW LEVEL SECURITY;

COMMIT;
