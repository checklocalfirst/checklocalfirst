-- 014: Geolocation columns for businesses. All nullable — existing rows (and any
-- business created before geocoding is wired up) stay valid with no address-derived
-- coordinates yet. latitude/longitude get populated by the Nominatim geocoding step
-- (helpers/geocode.js) whenever a business's address is created or changed.
-- geocoded_at lets a retry/backfill job tell "never attempted" apart from
-- "attempted and failed" (both look like NULL lat/lng otherwise).
ALTER TABLE businesses
ADD COLUMN latitude NUMERIC(9,6),
ADD COLUMN longitude NUMERIC(9,6),
ADD COLUMN neighborhood VARCHAR(100),
ADD COLUMN geocoded_at TIMESTAMPTZ;
