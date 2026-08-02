-- 026: business_photos predates the Aug 1, 2026 RLS rollout (it's from
-- migration 010) and never got a policy, so GET /:slug/photos — which uses the
-- anon client, same as /businesses, /services, /categories — has been silently
-- returning an empty array for every business instead of erroring.
--
-- Unlike business_categories (migration 018), this can't be a fully open
-- policy: the `approved` column exists specifically to keep unreviewed
-- business-submitted photos hidden from the public (see migration 023). An
-- open policy would let anyone bypass the Express route entirely and query
-- Supabase's REST API directly with the public anon key, seeing pending photos
-- too. This policy is scoped to match exactly what the app layer already
-- checks: approved = true, and the owning business is itself approved.
--
-- Ensures RLS is actually on regardless of its current state — enabling it
-- again when already enabled is a harmless no-op.
ALTER TABLE business_photos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read access to approved business_photos"
ON business_photos FOR SELECT
USING (
    approved = true
    AND EXISTS (
        SELECT 1 FROM businesses
        WHERE businesses.id = business_photos.business_id
        AND businesses.status = 'approved'
    )
);
