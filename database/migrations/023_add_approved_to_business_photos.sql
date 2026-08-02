-- 023: photos uploaded directly by a business owner need admin approval before
-- they're publicly visible — protects against inappropriate or off-brand images
-- going live unreviewed. Defaults to true because everything uploaded through
-- the admin route is auto-approved (admin IS the moderator) and any existing
-- rows so far were admin-uploaded anyway; the business self-service upload
-- route is the only place that explicitly inserts approved: false.
ALTER TABLE business_photos ADD COLUMN approved BOOLEAN DEFAULT true NOT NULL;
