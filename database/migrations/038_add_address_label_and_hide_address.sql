-- 038: Address label + hide-address toggle.
--
-- address_label — optional short line shown above the address, e.g.
--   "Find us at the Riverside Market". Plain text, max 100 chars.
-- hide_address — when true, public API responses null out address, zip,
--   latitude and longitude (see toPublicBusiness() in
--   api/helpers/publicColumns.js), so a home-based business can be listed
--   without exposing its street address or map pin. City, state, neighborhood
--   and address_label stay visible. The real address is still stored and still
--   used server-side (geocoding, radius search); distances to a hidden-address
--   business are rounded to whole miles in search results.
--
-- Both tiers; owner-editable through PUT /businesses/:slug, admin through
-- PATCH /admin/businesses/:id.

BEGIN;

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_label VARCHAR(100);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS hide_address BOOLEAN DEFAULT false NOT NULL;

COMMIT;
