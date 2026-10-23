-- 037: Log searches that found nothing.
--
-- GET /search writes one row every time it falls back to the no-results
-- response (the `fallback` object, migration 036), so admin can see which
-- searches fail most often and fix them — usually by adding a search synonym or
-- nudging a business to describe what it sells. Read through
-- GET /admin/search-misses (top queries) and /admin/search-misses/recent.
--
-- Deliberately stores no IP, user id, or coordinates — only whether a location
-- filter was active.
--
-- Written with the service-role client only; RLS on with no policies, so the
-- anon/authenticated roles can neither read nor write it.

BEGIN;

CREATE TABLE IF NOT EXISTS search_misses (
    id BIGSERIAL PRIMARY KEY,
    query TEXT,                       -- lowercased/trimmed; null for category/location-only browses
    category_slug TEXT,
    had_location BOOLEAN DEFAULT false NOT NULL,
    did_you_mean TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_misses_created ON search_misses (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_misses_query ON search_misses (query, created_at DESC);

ALTER TABLE search_misses ENABLE ROW LEVEL SECURITY;

-- Grouped "most missed" list for the admin dashboard. Category/location-only
-- misses (query IS NULL) are grouped by category instead so they still show up.
CREATE OR REPLACE FUNCTION top_search_misses(since TIMESTAMPTZ, max_rows INTEGER DEFAULT 50)
RETURNS TABLE (
    query TEXT,
    category_slug TEXT,
    misses BIGINT,
    last_seen TIMESTAMPTZ,
    did_you_mean TEXT
) AS $$
    SELECT
        m.query,
        CASE WHEN m.query IS NULL THEN m.category_slug END,
        count(*),
        max(m.created_at),
        (array_agg(m.did_you_mean ORDER BY m.created_at DESC) FILTER (WHERE m.did_you_mean IS NOT NULL))[1]
    FROM search_misses m
    WHERE m.created_at >= since
    GROUP BY m.query, CASE WHEN m.query IS NULL THEN m.category_slug END
    ORDER BY count(*) DESC, max(m.created_at) DESC
    LIMIT max_rows;
$$ LANGUAGE sql STABLE;

COMMIT;
