-- 020: migration 011 added is_featured/featured_since/in_carousel plus a partial
-- unique index allowing only one is_featured = true row at a time. Toggling a new
-- business featured therefore has to unset whichever business currently holds the
-- slot in the same statement — two sequential JS calls (unset old, then set new)
-- would leave a window where zero or, if the second call fails, two businesses
-- are marked featured. Wrapping both updates in one function makes the swap
-- atomic: it runs inside the same implicit transaction as the calling statement.
--
-- Un-featuring (is_featured: false) doesn't need this — it's a single-row update
-- with no uniqueness concern, handled directly in the route instead.
CREATE OR REPLACE FUNCTION set_featured_business(target_business_id INTEGER)
RETURNS TABLE (
    id INTEGER,
    name VARCHAR,
    is_featured BOOLEAN,
    featured_since TIMESTAMPTZ
) AS $$
BEGIN
    UPDATE businesses
    SET is_featured = false, featured_since = NULL
    WHERE is_featured = true;

    UPDATE businesses
    SET is_featured = true, featured_since = NOW()
    WHERE businesses.id = target_business_id;

    RETURN QUERY
    SELECT b.id, b.name, b.is_featured, b.featured_since
    FROM businesses b
    WHERE b.id = target_business_id;
END;
$$ LANGUAGE plpgsql;
