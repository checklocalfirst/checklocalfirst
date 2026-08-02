-- 024: discounts, redemption-tracked, gated on the redeeming user's premium
-- status rather than the posting business's tier (any business, basic or
-- premium, can post one — see the API layer for who can redeem).
CREATE TABLE discounts (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    code VARCHAR(50) NOT NULL,
    description TEXT NOT NULL,
    discount_type VARCHAR(10) NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
    value NUMERIC(10,2) NOT NULL,
    starts_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    max_redemptions INTEGER,
    times_redeemed INTEGER DEFAULT 0 NOT NULL,
    active BOOLEAN DEFAULT true NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_discounts_business ON discounts(business_id);

CREATE TRIGGER update_discounts_updated_at
BEFORE UPDATE ON discounts
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Tied to a specific user rather than a bare counter so both the business owner
-- and admin can see *who* redeemed, not just how many times.
CREATE TABLE discount_redemptions (
    id SERIAL PRIMARY KEY,
    discount_id INTEGER NOT NULL REFERENCES discounts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id),
    redeemed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_discount_redemptions_discount ON discount_redemptions(discount_id);

-- RLS enabled with deliberately NO anon/authenticated policies — unlike
-- business_categories (migration 017/018), the `code` column is sensitive and
-- must never be directly queryable via Supabase's REST API using just the anon
-- key. Every route touching these two tables goes through supabaseAdmin
-- (service role, bypasses RLS) and the public discount-listing route hand-picks
-- safe columns in the API layer instead of relying on a column-level policy,
-- which Postgres RLS doesn't support anyway (it's row-level only).
ALTER TABLE discounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE discount_redemptions ENABLE ROW LEVEL SECURITY;
