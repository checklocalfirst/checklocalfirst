-- 031: lets a business mark a discount_redemptions row as "used" — pure
-- bookkeeping so a business owner can track who's actually come in and
-- claimed their discount. Deliberately does NOT interact with the
-- discount_redemptions_unique_user_discount constraint (migration 027) or
-- unlock re-redemption in any way — that's still only possible by deleting
-- the redemption row outright, a separate and distinct action from marking
-- it used.
ALTER TABLE discount_redemptions ADD COLUMN used BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE discount_redemptions ADD COLUMN used_at TIMESTAMPTZ;
