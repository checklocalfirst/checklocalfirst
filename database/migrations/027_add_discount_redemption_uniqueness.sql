-- 027: one redemption per user per discount, enforced at the database level.
-- The app layer (POST /businesses/:slug/discounts/:id/redeem) checks for an
-- existing redemption first and returns the code again instead of erroring,
-- but this constraint is what actually prevents two near-simultaneous requests
-- from both slipping past that check before either one's insert lands —
-- without it, a race condition could double-count a single user's redemption.
--
-- Scoped to discount_id, not business_id: if a business creates a *new*
-- discount, that's a new row with a new id, so a user who already redeemed an
-- earlier discount from the same business is unaffected and can redeem the new
-- one too.
ALTER TABLE discount_redemptions
ADD CONSTRAINT discount_redemptions_unique_user_discount UNIQUE (discount_id, user_id);
