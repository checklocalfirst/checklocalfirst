-- 016: Expanded business profile fields.
--
-- Tier gating is NOT enforced here at the DB level (unlike is_featured/in_carousel
-- in migration 011) because a tier downgrade shouldn't wipe a business's story/timeline
-- data — it should just stop being editable/displayed until they upgrade again. That
-- check belongs in the route/validation layer instead. See businessSchemas.js /
-- adminSchemas.js for the tier gate.
--
-- Tier availability (enforced in application code, not here):
--   facebook_url, instagram_url, yelp_url, website_url, about_owner -> basic + premium
--   story, timeline_year_1/2/3, timeline_description_1/2/3         -> premium only
ALTER TABLE businesses
ADD COLUMN story TEXT,
ADD COLUMN website_url TEXT,
ADD COLUMN about_owner TEXT,
ADD COLUMN facebook_url TEXT,
ADD COLUMN instagram_url TEXT,
ADD COLUMN yelp_url TEXT,
ADD COLUMN timeline_year_1 SMALLINT,
ADD COLUMN timeline_description_1 TEXT,
ADD COLUMN timeline_year_2 SMALLINT,
ADD COLUMN timeline_description_2 TEXT,
ADD COLUMN timeline_year_3 SMALLINT,
ADD COLUMN timeline_description_3 TEXT;
