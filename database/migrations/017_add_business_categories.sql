-- 017: Lets a business register under multiple categories, independent of what
-- categories its individual services happen to carry (services.category_id is
-- unchanged and still organizes services within a business's own page).
--
-- This table is the source of truth for /search's `category` filter going forward
-- (search.js will be reworked in a later step) — a business shows up under a
-- category because it was tagged with it, not because one of its services was.
CREATE TABLE business_categories (
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (business_id, category_id)
);

-- Search filters by category_id, so index that side of the join.
CREATE INDEX idx_business_categories_category ON business_categories(category_id);
