-- 040: Typo correction against every word in the directory.
--
-- 036's typo tolerance only compared the query with business and service
-- NAMES, so "blankit" found nothing when "blanket" appeared only in a
-- description or category. This corrects each misspelled query word to the
-- closest word that appears anywhere in approved listings (business and
-- service names + descriptions, category names, synonym phrases) before
-- searching — Google-style "Showing results for …".
--
-- Correction rules (edit distance, not trigram similarity — trigrams can't tell
-- "blankit"/"blanket" (0.45) from "wool"/"wood" (0.43)):
--   * words under 5 letters are never corrected ("wool" never becomes "wood"),
--   * 5–6 letters: one letter off at most; 7+ letters: two at most,
--   * a word already in the directory, including another form of it
--     ("blankets" when only "blanket" is listed), is never corrected,
--   * ties go to the closer spelling, then the more common word.
--
-- search_businesses() gains a corrected_query column (null when nothing was
-- corrected); /search returns it so the frontend can say "Showing results for
-- blanket". search_did_you_mean() prefers the corrected query too.
--
-- Safe to re-run. Deploy the API after running this (the current API keeps
-- working against it — it ignores the new column).

BEGIN;

-- levenshtein(). On Supabase extensions live in the `extensions` schema.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
        CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA extensions;
    ELSE
        CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
    END IF;
END $$;

-- Every word (letters only, 3+ chars) in approved listings, with how often it
-- appears. Computed per call — fine at directory scale; materialize it if the
-- directory grows into the thousands of listings.
CREATE OR REPLACE FUNCTION search_vocabulary()
RETURNS TABLE (word TEXT, uses BIGINT) AS $$
    SELECT w, count(*)
    FROM (
        SELECT regexp_split_to_table(lower(coalesce(b.name, '') || ' ' || coalesce(b.description, '')), '[^a-z]+') AS w
        FROM businesses b WHERE b.status = 'approved'
        UNION ALL
        SELECT regexp_split_to_table(lower(coalesce(s.name, '') || ' ' || coalesce(s.description, '')), '[^a-z]+')
        FROM services s JOIN businesses b ON b.id = s.business_id AND b.status = 'approved'
        UNION ALL
        SELECT regexp_split_to_table(lower(c.name), '[^a-z]+') FROM categories c
        UNION ALL
        SELECT regexp_split_to_table(s.term || ' ' || s.synonym, '[^a-z]+') FROM search_synonyms s
    ) words
    WHERE length(w) >= 3
    GROUP BY w;
$$ LANGUAGE sql STABLE;

-- The query with misspelled words replaced, or NULL if nothing needed fixing.
CREATE OR REPLACE FUNCTION search_correct_query(search_term TEXT)
RETURNS TEXT AS $$
    WITH words AS (
        SELECT t.w, t.ord
        FROM regexp_split_to_table(lower(btrim(search_term)), '\s+') WITH ORDINALITY AS t(w, ord)
        WHERE t.w <> ''
    ),
    vocab AS (
        SELECT v.word, v.uses, (ts_lexize('english_stem', v.word))[1] AS stem
        FROM search_vocabulary() v
    ),
    fixed AS (
        SELECT w.ord, w.w,
            CASE
                WHEN length(w.w) < 5 OR w.w !~ '^[a-z]+$' THEN w.w
                WHEN (ts_lexize('english_stem', w.w))[1] IS NULL THEN w.w -- stopword
                WHEN EXISTS (SELECT 1 FROM vocab v WHERE v.stem = (ts_lexize('english_stem', w.w))[1]) THEN w.w
                ELSE coalesce((
                    SELECT v.word FROM vocab v
                    WHERE abs(length(v.word) - length(w.w)) <= 2
                      AND levenshtein(v.word, w.w) <= CASE WHEN length(w.w) >= 7 THEN 2 ELSE 1 END
                    ORDER BY levenshtein(v.word, w.w), similarity(v.word, w.w) DESC, v.uses DESC, v.word
                    LIMIT 1
                ), w.w)
            END AS fixed
        FROM words w
    )
    SELECT CASE WHEN bool_or(fixed <> w) THEN string_agg(fixed, ' ' ORDER BY ord) END
    FROM fixed;
$$ LANGUAGE sql STABLE;

-- Same as 036 apart from: corrected-query variants are searched alongside the
-- original ones, and the corrected query is returned on every row.
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
    total_count BIGINT,
    corrected_query TEXT
) AS $$
    WITH corrected AS (
        SELECT search_correct_query(search_term) AS q
    ),
    all_variants AS (
        SELECT v.variant FROM search_query_variants(search_term) AS v
        UNION
        SELECT v.variant FROM corrected, search_query_variants(corrected.q) AS v
        WHERE corrected.q IS NOT NULL
    ),
    variants AS (
        -- Hyphenated compounds ("t-shirt") also come back split ("t", "shirt");
        -- only the parts are kept so a hyphen in the query doesn't block a full match.
        SELECT ARRAY(
            SELECT l FROM unnest(tsvector_to_array(to_tsvector('english', av.variant))) AS l
            WHERE l NOT LIKE '%-%'
        ) AS lexemes
        FROM all_variants av
        WHERE av.variant IS NOT NULL
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
        m.total,
        (SELECT q FROM corrected)
    FROM matched m
    ORDER BY m.tier, (m.business_tier = 'premium') DESC, m.relevance DESC, m.dist NULLS LAST, m.id
    LIMIT page_limit OFFSET page_offset;
$$ LANGUAGE sql STABLE;

-- Prefer the word-level correction; fall back to 036's closest-name match.
CREATE OR REPLACE FUNCTION search_did_you_mean(search_term TEXT)
RETURNS TEXT AS $$
    SELECT coalesce(
        search_correct_query(search_term),
        (
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
            LIMIT 1
        )
    );
$$ LANGUAGE sql STABLE;

COMMIT;
