-- 018: business_categories was created (migration 017) after RLS was enabled
-- project-wide (Aug 1, 2026) and never got a policy, so it defaults to deny-all
-- for the anon/authenticated roles — reads silently return zero rows instead of
-- erroring. No write policy is needed: every write path (PUT /businesses/:slug/categories,
-- the admin equivalent) goes through supabaseAdmin with the service-role key, which
-- always bypasses RLS regardless of policies.
--
-- Row contents are just (business_id, category_id) pairs — nothing sensitive, same
-- posture as the fully-open `categories` table — so an unconditional public SELECT
-- policy is correct here rather than a scoped one.
CREATE POLICY "Public read access to business_categories"
ON business_categories FOR SELECT
USING (true);
