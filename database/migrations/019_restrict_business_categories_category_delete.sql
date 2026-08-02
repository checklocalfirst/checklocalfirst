-- 019: migration 017 created business_categories.category_id with ON DELETE
-- CASCADE, which meant deleting a category would silently untag every business
-- assigned to it — no error, no warning, and no way for the admin deleting the
-- category to know it happened.
--
-- A business is required to always have at least one category (enforced in the
-- application layer: PUT /businesses/:slug/categories and the admin equivalent
-- both reject an empty category_ids list). Silently stripping a business's only
-- category out from under it would violate that invariant with zero visibility.
--
-- This switches category_id to the default NO ACTION/RESTRICT behavior, matching
-- how services.category_id already works — categories.js's DELETE /:id route
-- already catches the resulting 23503 error and returns a 409 instead of a raw
-- DB error. Now that same protection covers businesses, not just services.
--
-- business_id keeps ON DELETE CASCADE (unchanged, not part of this migration) —
-- deleting a business should clean up its own category assignments, that's correct.
ALTER TABLE business_categories DROP CONSTRAINT business_categories_category_id_fkey;

ALTER TABLE business_categories
ADD CONSTRAINT business_categories_category_id_fkey
FOREIGN KEY (category_id) REFERENCES categories(id);
