-- 013: search_services_fuzzy still referenced services.price, which migration 008
-- dropped ("CLF is a directory, not a marketplace"). The function was never updated,
-- so it throws "column s.price does not exist" whenever the fuzzy fallback in
-- search.js actually runs (full-text and ilike both return zero results first).
--
-- Postgres won't let CREATE OR REPLACE change a function's return type, so the
-- old signature has to be dropped before recreating it without price.
DROP FUNCTION IF EXISTS search_services_fuzzy(TEXT, INTEGER);

CREATE OR REPLACE FUNCTION search_services_fuzzy(search_term TEXT, filter_category_id INTEGER DEFAULT NULL)
RETURNS TABLE (
    id INTEGER,
    business_id INTEGER,
    category_id INTEGER,
    name VARCHAR,
    description TEXT,
    search_vector TSVECTOR,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    similarity REAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.id,
        s.business_id,
        s.category_id,
        s.name,
        s.description,
        s.search_vector,
        s.created_at,
        s.updated_at,
        similarity(s.name, search_term) AS similarity
    FROM services s
    WHERE similarity(s.name, search_term) > 0.15
    AND (filter_category_id IS NULL OR s.category_id = filter_category_id)
    ORDER BY similarity DESC;
END;
$$ LANGUAGE plpgsql;
