-- 021: distance search support for /search's lat/lng/radius_miles params.
--
-- Plain-SQL Haversine rather than the earthdistance/cube extensions — this
-- avoids depending on whether those are enabled on the Supabase project, at the
-- cost of a slightly more verbose function body. 3959 is Earth's radius in miles.
--
-- The LEAST/GREATEST clamp guards against acos() receiving a value marginally
-- outside [-1, 1] due to floating-point rounding (most commonly when a business
-- is at/near the exact search point) — without it, that edge case raises a
-- Postgres error instead of just resolving to ~0 miles.
--
-- Only considers approved, already-geocoded businesses — a business with
-- NULL latitude/longitude (never geocoded, or geocoding failed) simply can't
-- appear in a distance-filtered result, by design (see the Phase 2 plan's
-- search section).
CREATE OR REPLACE FUNCTION businesses_within_radius(
    target_lat NUMERIC,
    target_lng NUMERIC,
    radius_miles NUMERIC
)
RETURNS TABLE (
    business_id INTEGER,
    distance_miles NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT sub.business_id, sub.distance_miles
    FROM (
        SELECT
            b.id AS business_id,
            (3959 * acos(
                LEAST(1, GREATEST(-1,
                    cos(radians(target_lat)) * cos(radians(b.latitude)) * cos(radians(b.longitude) - radians(target_lng))
                    + sin(radians(target_lat)) * sin(radians(b.latitude))
                ))
            ))::NUMERIC AS distance_miles
        FROM businesses b
        WHERE b.status = 'approved'
          AND b.latitude IS NOT NULL
          AND b.longitude IS NOT NULL
    ) sub
    WHERE sub.distance_miles <= radius_miles
    ORDER BY sub.distance_miles ASC;
END;
$$ LANGUAGE plpgsql;
