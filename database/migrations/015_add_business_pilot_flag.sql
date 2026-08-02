-- 015: pilot_business is a pure badge/flag, granted by admin only, with no
-- functional gating anywhere else in the app (no tier bypass, no comped status).
-- Frontend uses it to show a "Pilot Partner" tag.
ALTER TABLE businesses
ADD COLUMN pilot_business BOOLEAN DEFAULT false NOT NULL;
