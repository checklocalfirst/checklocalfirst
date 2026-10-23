-- 036: Search upgrade — ranked, synonym-aware, single-query search.
--
-- Replaces the old "all words must match, then up to 5 fallback queries, then
-- sort in JS" approach in api/routes/search.js with one RPC, search_businesses(),
-- that:
--   * matches ANY query word, not only all of them ("wool blanket" now also finds
--     businesses that only list "blanket"),
--   * groups results by match quality — match_tier 0 = every word matched inside
--     one unit (the business's own name/description, a single service, or a single
--     category), 1 = partial or typo-only match — then premium first within each
--     tier, then relevance score, then distance,
--   * expands the query with admin-managed synonyms (search_synonyms: "chili
--     crunch" <-> "chili crisp"),
--   * folds typo tolerance (pg_trgm word_similarity >= 0.55 — low enough for
--     "blankit", high enough to keep "Crunchy Granola" out of "chili crunch") into the same query instead
--     of running it as a last-resort fallback,
--   * filters by category / radius and paginates in the database.
--
-- Field weights (ts_rank): business name + service names = A, category names = B,
-- business + service descriptions = C.
--
-- Also adds search_did_you_mean() for the "no results" fallback.
--
-- Run this whole file once in the Supabase SQL editor. Safe to re-run.

BEGIN;

-- 1. Weighted per-service vectors (was unweighted name + description) ---------

CREATE OR REPLACE FUNCTION update_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector =
        setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.description, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. One combined, weighted document per business ------------------------------
--
-- businesses.search_document = business name/description + every service's
-- name/description + every category name. It's what the GIN index pre-filters
-- on and what ts_rank scores; the per-unit "did every word match" check in
-- search_businesses() still looks at services/categories individually so that
-- "wool socks" + "cotton blanket" doesn't count as a full match for "wool blanket".

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS search_document TSVECTOR;

CREATE OR REPLACE FUNCTION build_business_search_document(p_business_id INTEGER, p_name TEXT, p_description TEXT)
RETURNS TSVECTOR AS $$
    SELECT
        setweight(to_tsvector('english', coalesce(p_name, '')), 'A')
        || setweight(to_tsvector('english', coalesce(p_description, '')), 'C')
        || coalesce((
            SELECT setweight(to_tsvector('english', string_agg(s.name, ' ')), 'A')
            FROM services s WHERE s.business_id = p_business_id
        ), ''::tsvector)
        || coalesce((
            SELECT setweight(to_tsvector('english', string_agg(coalesce(s.description, ''), ' ')), 'C')
            FROM services s WHERE s.business_id = p_business_id
        ), ''::tsvector)
        || coalesce((
            SELECT setweight(to_tsvector('english', string_agg(c.name, ' ')), 'B')
            FROM business_categories bc
            JOIN categories c ON c.id = bc.category_id
            WHERE bc.business_id = p_business_id
        ), ''::tsvector);
$$ LANGUAGE sql STABLE;

-- Existing trigger (migration 034) keeps calling this function; it now also
-- weights search_vector and rebuilds search_document on every insert/update.
CREATE OR REPLACE FUNCTION update_business_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector =
        setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.description, '')), 'C');
    NEW.search_document = build_business_search_document(NEW.id, NEW.name, NEW.description);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Backfill — updated_at triggers paused so existing rows keep their timestamps

ALTER TABLE services DISABLE TRIGGER update_services_updated_at;
UPDATE services SET search_vector =
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C');
ALTER TABLE services ENABLE TRIGGER update_services_updated_at;

ALTER TABLE businesses DISABLE TRIGGER update_businesses_updated_at;
UPDATE businesses SET search_document = NULL; -- the BEFORE trigger rebuilds both vectors
ALTER TABLE businesses ENABLE TRIGGER update_businesses_updated_at;

-- 4. Keep search_document current when services / categories change ------------
--
-- Touching the business row fires update_business_search_vector() above, which
-- rebuilds the document. Side effect: a service or category change also bumps
-- that business's updated_at.

CREATE OR REPLACE FUNCTION refresh_business_search_document()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_TABLE_NAME = 'categories' THEN
        UPDATE businesses SET search_document = NULL
        WHERE id IN (SELECT bc.business_id FROM business_categories bc WHERE bc.category_id = NEW.id);
        RETURN NULL;
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        UPDATE businesses SET search_document = NULL WHERE id = NEW.business_id;
    END IF;

    IF TG_OP IN ('UPDATE', 'DELETE') AND (TG_OP = 'DELETE' OR OLD.business_id IS DISTINCT FROM NEW.business_id) THEN
        UPDATE businesses SET search_document = NULL WHERE id = OLD.business_id;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_refresh_doc_on_services ON services;
CREATE TRIGGER trigger_refresh_doc_on_services
AFTER INSERT OR UPDATE OF name, description, business_id OR DELETE ON services
FOR EACH ROW EXECUTE FUNCTION refresh_business_search_document();

DROP TRIGGER IF EXISTS trigger_refresh_doc_on_business_categories ON business_categories;
CREATE TRIGGER trigger_refresh_doc_on_business_categories
AFTER INSERT OR UPDATE OR DELETE ON business_categories
FOR EACH ROW EXECUTE FUNCTION refresh_business_search_document();

DROP TRIGGER IF EXISTS trigger_refresh_doc_on_categories ON categories;
CREATE TRIGGER trigger_refresh_doc_on_categories
AFTER UPDATE OF name ON categories
FOR EACH ROW EXECUTE FUNCTION refresh_business_search_document();

CREATE INDEX IF NOT EXISTS idx_businesses_search_document ON businesses USING GIN(search_document);

-- 5. Synonyms ------------------------------------------------------------------
--
-- One row = two phrases that mean the same thing, matched in both directions.
-- Stored lowercase/trimmed; managed through /admin/search-synonyms.

CREATE TABLE IF NOT EXISTS search_synonyms (
    id SERIAL PRIMARY KEY,
    term TEXT NOT NULL,
    synonym TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    CONSTRAINT search_synonyms_not_same CHECK (term <> synonym),
    CONSTRAINT search_synonyms_normalized CHECK (term = lower(btrim(term)) AND synonym = lower(btrim(synonym)))
);

-- (a, b) and (b, a) are the same pair.
CREATE UNIQUE INDEX IF NOT EXISTS search_synonyms_pair_unique
    ON search_synonyms (LEAST(term, synonym), GREATEST(term, synonym));

ALTER TABLE search_synonyms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read access to search_synonyms" ON search_synonyms;
CREATE POLICY "Public read access to search_synonyms"
    ON search_synonyms FOR SELECT USING (true);

INSERT INTO search_synonyms (term, synonym) VALUES ('chili crunch', 'chili crisp')
ON CONFLICT DO NOTHING;

-- 6. Query variants: the query itself + one rewrite per synonym it contains -----
--
-- Whole-word match, tolerating a plural on the stored phrase ("chili crunches").
-- Punctuation in stored phrases is escaped before being used as a regex.

CREATE OR REPLACE FUNCTION search_query_variants(search_term TEXT)
RETURNS TABLE (variant TEXT) AS $$
    WITH q AS (SELECT lower(btrim(search_term)) AS t),
    pairs AS (
        SELECT s.term AS from_phrase, s.synonym AS to_phrase FROM search_synonyms s
        UNION ALL
        SELECT s.synonym, s.term FROM search_synonyms s
    ),
    patterns AS (
        SELECT '\m' || regexp_replace(p.from_phrase, '([^[:alnum:][:space:]])', '\\\1', 'g') || '(e?s)?\M' AS pattern,
               p.to_phrase
        FROM pairs p
    )
    SELECT q.t FROM q
    UNION
    SELECT regexp_replace(q.t, pt.pattern, pt.to_phrase, 'g')
    FROM q, patterns pt
    WHERE q.t ~ pt.pattern;
$$ LANGUAGE sql STABLE;

-- 7. The search itself ----------------------------------------------------------

DROP FUNCTION IF EXISTS search_businesses(TEXT, INTEGER, NUMERIC, NUMERIC, NUMERIC, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION search_businesses(
    search_term TEXT,
    filter_category_id INTEGER DEFAULT NULL,
    target_lat NUMERIC DEFAULT NULL,
    target_lng NUMERIC DEFAULT NULL,
    radius_miles NUMERIC DEFAULT NULL,
    page_limit INTEGER DEFAULT 20,
    page_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
    business_id INTEGER,
    match_tier SMALLINT,
    score REAL,
    distance_miles NUMERIC,
    matching_service_ids INTEGER[],
    total_count BIGINT
) AS $$
    WITH variants AS (
        -- Hyphenated compounds ("t-shirt") also come back split ("t", "shirt");
        -- only the parts are kept so a hyphen in the query doesn't block a full match.
        SELECT ARRAY(
            SELECT l FROM unnest(tsvector_to_array(to_tsvector('english', v.variant))) AS l
            WHERE l NOT LIKE '%-%'
        ) AS lexemes
        FROM search_query_variants(search_term) AS v
    ),
    usable AS (
        SELECT lexemes,
               to_tsquery('simple', array_to_string(ARRAY(SELECT quote_literal(l) FROM unnest(lexemes) AS l), ' & ')) AS all_q
        FROM variants
        WHERE cardinality(lexemes) > 0
    ),
    any_q AS (
        SELECT to_tsquery('simple', string_agg(DISTINCT quote_literal(l), ' | ')) AS q
        FROM usable, unnest(usable.lexemes) AS l
    ),
    candidates AS (
        SELECT b.id, b.business_tier, b.name, b.search_vector, b.search_document,
            CASE WHEN target_lat IS NOT NULL AND target_lng IS NOT NULL AND radius_miles IS NOT NULL THEN
                (3959 * acos(LEAST(1, GREATEST(-1,
                    cos(radians(target_lat)) * cos(radians(b.latitude)) * cos(radians(b.longitude) - radians(target_lng))
                    + sin(radians(target_lat)) * sin(radians(b.latitude))
                ))))::NUMERIC
            END AS dist
        FROM businesses b
        WHERE b.status = 'approved'
          AND (filter_category_id IS NULL OR EXISTS (
                SELECT 1 FROM business_categories bc
                WHERE bc.business_id = b.id AND bc.category_id = filter_category_id))
          AND (target_lat IS NULL OR target_lng IS NULL OR radius_miles IS NULL
               OR (b.latitude IS NOT NULL AND b.longitude IS NOT NULL))
    ),
    scored AS (
        SELECT c.id, c.business_tier, c.dist, aq.q,
            coalesce(c.search_document @@ aq.q, false) AS text_hit,
            GREATEST(
                word_similarity(search_term, c.name),
                coalesce((SELECT max(word_similarity(search_term, s.name)) FROM services s WHERE s.business_id = c.id), 0)
            ) AS fuzzy,
            -- Full match: every word of some variant inside ONE unit.
            EXISTS (
                SELECT 1 FROM usable u
                WHERE c.search_vector @@ u.all_q
                   OR EXISTS (SELECT 1 FROM services s WHERE s.business_id = c.id AND s.search_vector @@ u.all_q)
                   OR EXISTS (SELECT 1 FROM business_categories bc JOIN categories cat ON cat.id = bc.category_id
                              WHERE bc.business_id = c.id AND to_tsvector('english', cat.name) @@ u.all_q)
            ) AS full_match,
            -- Share of query words found anywhere in the business (best variant).
            coalesce((
                SELECT max((
                    SELECT count(*) FROM unnest(u.lexemes) AS l
                    WHERE c.search_document @@ to_tsquery('simple', quote_literal(l))
                )::REAL / cardinality(u.lexemes))
                FROM usable u
            ), 0) AS coverage,
            coalesce(ts_rank(c.search_document, aq.q), 0) AS text_rank
        FROM candidates c
        CROSS JOIN any_q aq
        WHERE radius_miles IS NULL OR target_lat IS NULL OR target_lng IS NULL OR c.dist <= radius_miles
    ),
    matched AS (
        SELECT sc.*,
            (CASE WHEN sc.full_match THEN 0 ELSE 1 END)::SMALLINT AS tier,
            (sc.coverage + sc.text_rank + 0.5 * sc.fuzzy)::REAL AS relevance,
            count(*) OVER () AS total
        FROM scored sc
        WHERE sc.text_hit OR sc.fuzzy >= 0.55
    )
    SELECT
        m.id,
        m.tier,
        m.relevance,
        round(m.dist, 2),
        ARRAY(
            SELECT s.id FROM services s
            WHERE s.business_id = m.id
              AND (coalesce(s.search_vector @@ m.q, false) OR word_similarity(search_term, s.name) >= 0.55)
            ORDER BY coalesce(ts_rank(s.search_vector, m.q), 0) + word_similarity(search_term, s.name) DESC, s.id
        ),
        m.total
    FROM matched m
    ORDER BY m.tier, (m.business_tier = 'premium') DESC, m.relevance DESC, m.dist NULLS LAST, m.id
    LIMIT page_limit OFFSET page_offset;
$$ LANGUAGE sql STABLE;

-- 8. "Did you mean" for the no-results fallback ---------------------------------

CREATE OR REPLACE FUNCTION search_did_you_mean(search_term TEXT)
RETURNS TEXT AS $$
    SELECT x.candidate
    FROM (
        SELECT s.name AS candidate FROM services s
        JOIN businesses b ON b.id = s.business_id AND b.status = 'approved'
        UNION
        SELECT b.name FROM businesses b WHERE b.status = 'approved'
        UNION
        SELECT c.name FROM categories c
        UNION
        SELECT s.term FROM search_synonyms s
        UNION
        SELECT s.synonym FROM search_synonyms s
    ) x
    WHERE similarity(x.candidate, search_term) >= 0.3
      AND lower(x.candidate) <> lower(btrim(search_term))
    ORDER BY similarity(x.candidate, search_term) DESC, x.candidate
    LIMIT 1;
$$ LANGUAGE sql STABLE;

COMMIT;
