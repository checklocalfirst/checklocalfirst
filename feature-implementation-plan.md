# CheckLocalFirst — New Feature Implementation Plan
*Drafted Aug 4, 2026 against the current `clfbackend` codebase (Express + Supabase + Stripe + Resend) and the routes contract in `clfbackendroutesandinfo.md`. Frontend assumed to be Next.js (App Router), per your confirmation.*

*Revision note: business self-service photo upload is out — businesses will email photos in or get a professional shoot, and admin stays the only upload path, same as today. Everything else from the original plan is unchanged.*

---

## 0. Decisions already made (so you don't have to re-litigate while building)

- **Business `story` field:** full removal — migration drops the column, data is gone for good.
- **"Mark redemption used":** bookkeeping-only flag. Doesn't unlock re-redemption; the one-per-user-per-discount rule (migration 027) still stands. "Delete" is the separate, distinct action that actually removes the redemption row (which *does* let that user redeem again, since the uniqueness constraint has nothing left to match against).
- **Membership vs. Premium Upgrade pages:** "Membership" is marketing/info content (two flavors: for Users, for Businesses) that ends in a CTA. "Premium Upgrade" pages are the actual Stripe Elements checkout screens. Two different pages, linked from one another.
- **Business photo uploads:** staying admin-only. The commented-out self-service upload/edit/delete routes in `businesses.js` stay exactly as they are — commented out, untouched. No new private bucket, no pending-review queue, no signed URLs. Businesses submit photos out-of-band (email, or a professional shoot you arrange) and admin uploads them through the existing `POST /admin/businesses/:id/photos` route, same as every photo today.

## 1. Migration plan (run in this order)

Current migrations top out at `028`. New ones, in dependency order:

| # | File | Purpose |
|---|---|---|
| 029 | `029_add_timeline_photo_type.sql` | Adds `timeline` to `business_photos.photo_type`, adds `timeline_slot` column + constraints |
| 030 | `030_add_social_click_event_types.sql` | Extends `business_analytics_events.event_type` enum with social clicks |
| 031 | `031_add_discount_redemption_used_flag.sql` | Adds `used` / `used_at` to `discount_redemptions` |
| 032 | `032_drop_business_story_column.sql` | Drops `businesses.story` entirely |

Full SQL for each is written out in its feature section below.

---

## 2. Timeline photo uploads (3 slots)

**What it is:** each of the 3 existing timeline entries (`timeline_year_N` / `timeline_description_N`, premium-only) gets an associated photo. Since photo upload stays admin-only (§3 below), this is purely an extension of the existing admin upload route — no new upload surface for businesses.

### Backend

**Migration 029:**
```sql
ALTER TABLE business_photos DROP CONSTRAINT business_photos_type_check;
ALTER TABLE business_photos ADD CONSTRAINT business_photos_type_check
  CHECK (photo_type IN ('listing', 'owner', 'gallery', 'timeline'));

ALTER TABLE business_photos ADD COLUMN timeline_slot SMALLINT;

ALTER TABLE business_photos ADD CONSTRAINT timeline_slot_consistency CHECK (
  (photo_type = 'timeline' AND timeline_slot IN (1, 2, 3))
  OR (photo_type != 'timeline' AND timeline_slot IS NULL)
);

-- one photo per business per timeline slot — re-uploading a slot replaces it
-- (route deletes the old row/file first), it doesn't stack up duplicates.
CREATE UNIQUE INDEX one_photo_per_timeline_slot
  ON business_photos (business_id, timeline_slot) WHERE photo_type = 'timeline';
```

**`api/schemas/adminSchemas.js`:** add `timeline_slot` to `adminUploadPhotoSchema`:
```js
photo_type: z.enum(['listing', 'owner', 'gallery', 'timeline']),
timeline_slot: z.coerce.number().int().min(1).max(3).optional(),
```
with a `.refine()` requiring `timeline_slot` when `photo_type === 'timeline'` and forbidding it otherwise. Same addition to `adminUpdatePhotoSchema` for consistency (so `PUT /admin/photos/:id` can also move a photo into/out of a timeline slot later if needed).

**`api/routes/admin.js` — `POST /admin/businesses/:id/photos`:** when `photo_type === 'timeline'`, before inserting, check for an existing row at `(business_id, timeline_slot)`; if found, delete its storage file (`deleteBusinessPhotoFile`) and DB row first, then insert the new one — a clean replace instead of erroring on the unique index. Pull this into a small shared helper, e.g. `replaceTimelinePhotoIfExists(businessId, timelineSlot)`.

Since photo upload is admin-only end to end, there's no separate tier check needed in the route itself — admin already bypasses tier gates everywhere else (can set timeline text on a basic-tier business, uploads gallery photos with no tier restriction), so a timeline photo behaves the same way: admin can attach one to any business regardless of tier. The *frontend* premium-gate (§11) is what keeps a basic-tier business from seeing/requesting this as if it's self-service, not a backend restriction.

**`clfbackendroutesandinfo.md`:** update §5/§7 to document the new `timeline` photo type and `timeline_slot` field, and note that photo submission for businesses is "email us or we'll schedule a shoot," not a dashboard upload button.

### Frontend

- Public business page → timeline section: for each of the 3 entries, look up the photo from `GET /:slug/photos` where `photo_type === 'timeline' && timeline_slot === N` and render it next to the year/description if present; fall back to text-only if no photo was uploaded for that slot.
- Business dashboard: no upload control needed (see §3) — the timeline editor only handles the text fields; if a timeline photo exists for a slot it can show as a small read-only preview, same as the rest of the dashboard's read-only photo display.
- Admin dashboard: extend the existing photo upload form's `photo_type` selector with a `timeline` option; when selected, show a slot picker (1/2/3) tied to the business currently being edited.

---

## 3. Business photo submissions — admin-only, no self-service upload

**Decision:** no self-service upload route gets re-enabled. Businesses send photos to you directly (email, or you arrange a professional shoot), and you upload them the same way you already do today via `POST /admin/businesses/:id/photos`. This section is intentionally small — there's no new upload/storage/review-queue infrastructure to build.

### Backend
- No route or schema changes beyond what §2 already adds for the `timeline` photo type.
- Leave the commented-out self-service `POST`/`PUT`/`DELETE /:slug/photos` block in `businesses.js` exactly as-is (still disabled, still there for reference if you ever change your mind later — no need to delete it).
- Optional, low-effort nicety: if you want a dedicated inbox for these submissions rather than a general contact address, that's a mail-forwarding/config decision on your end, not a code change.

### Frontend
- Business dashboard, photos section: since there's still no upload button, replace any leftover "coming soon" placeholder with a clear one-liner: something like *"Want new photos on your listing? Email them to [address] or ask us about a professional photo shoot."* This is the one small piece of UI work this section actually needs — everything else about photo display (rendering whatever admin has uploaded, ordered by `display_order`) is already how the dashboard works today and doesn't change.

---

## 4. Social media analytics tracking

**Migration 030:**
```sql
ALTER TABLE business_analytics_events DROP CONSTRAINT business_analytics_events_event_type_check;
ALTER TABLE business_analytics_events ADD CONSTRAINT business_analytics_events_event_type_check CHECK (
  event_type IN ('call_click', 'email_click', 'page_view', 'address_click', 'website_click', 'discount_click',
                 'facebook_click', 'instagram_click', 'yelp_click')
);
```

### Backend
- `api/schemas/analyticsSchemas.js` — add `'facebook_click', 'instagram_click', 'yelp_click'` to the `EVENT_TYPES` array. That's the only code change — `POST /:slug/track`, `GET /:slug/analytics`, `GET /admin/analytics`, and `aggregateEventsByTypeAndDay` are all already generic over whatever's in the enum, no route logic changes needed.
- Update `clfbackendroutesandinfo.md` §0's enum list.

### Frontend
- On a business's public page, wherever the Facebook/Instagram/Yelp icon links render (`facebook_url`/`instagram_url`/`yelp_url`), fire `POST /businesses/:slug/track` with the matching `event_type` on click, fire-and-forget, exact same pattern already used for `website_click`/`call_click`.
- Business & admin analytics dashboards: no work needed beyond making sure the chart component doesn't hardcode the list of series — it should already just render whatever event types come back from the aggregation endpoint (confirm this before shipping; if it currently hardcodes a fixed list of 6 series, that list needs the 3 new keys added).

---

## 5. Membership navbar + "Membership for Users" page

Marketing/info content, no backend work.

### Frontend
- Navbar: replace (or add alongside) whatever "Join"/"Pricing" element exists today with a **"Membership"** item that opens a dropdown/menu with two options: **"For Users"** → `/membership/users`, **"For Businesses"** → `/membership/businesses`.
- `/membership/users` (new page): benefits of a Premium user membership (discount code redemption being the flagship perk per the existing `PREMIUM_REQUIRED` gate on discount redemption) — ends in a CTA button.
- `/membership/businesses` (new page): benefits of Basic vs. Premium business tiers (gallery + timeline photos, featured slot, carousel, discounts, analytics) — ends in a CTA button. This is a good place to render an honest tier-comparison table, since `is_featured`/`in_carousel`/timeline are all already premium-gated server-side, so the copy here won't drift from what's actually enforced.
- Both pages' CTA buttons follow the same signed-in/signed-out branching as the "Join Now" buttons in §6 — reuse whatever shared helper you build there.

---

## 6. "Join Now" button routing (signed out → signup, signed in → premium upgrade)

### Frontend only
- Add a shared helper, e.g. `getJoinNowHref(session)`:
  - No session → `/signup` (or your existing user-signup route).
  - Session, `accountType === 'business'` → `/premium/businesses` (business upgrade page, §7).
  - Session, `accountType === 'user'` → `/premium/users` (user upgrade page, §7).
  - Session, already premium/premium-tier — you may want this to route to an account/billing page instead of an upgrade page they can't use again; worth deciding once §7's pages exist, but not blocking to build now (the premium upgrade page itself can defensively show "you're already Premium" and link to account settings if hit directly).
- Apply this helper everywhere a "Join Now" CTA currently exists (navbar, landing page, membership pages built in §5).

---

## 7. Premium upgrade pages (separate for users and businesses)

Both are pure frontend pages against **routes that already exist** — no backend work.

### Frontend
- `/premium/users`: Stripe Elements checkout mounted from `POST /stripe/premium-user/checkout`'s `client_secret` (auth required — redirect to login first if hit signed-out). Handle the 409 "already premium" case per the doc.
- `/premium/businesses`: same pattern against `POST /stripe/business/:slug/upgrade` — needs the signed-in business owner's own slug first (`GET /businesses/me`), then submits the upgrade. Handle 409 ("already premium") and 402 (card declined) distinctly, per the doc's explicit callout.
- Both: on success, redirect back into the relevant dashboard with a success toast; Stripe's webhook (already built) is the actual source of truth for when the tier flips, so don't optimistically show "Premium" in the UI until the account data reflects it (poll or just tell the user "this can take a minute to reflect").

---

## 8. Cancellation email (subscription cancelled, ends on X date)

### Backend — `api/routes/stripe.js`
Both cancel routes already compute `subscription.cancel_at` and already have the relevant email address in scope. Add a best-effort email send after the Stripe update succeeds, wrapped in try/catch (same non-blocking pattern already used for every other email in `stripeWebhook.js` — a Resend hiccup shouldn't fail the cancel request since the cancellation itself already went through on Stripe's side):

**`POST /business/:slug/cancel`** — after `subscription.update(...)`:
```js
const cancelDate = new Date(subscription.cancel_at * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
try {
    await sendEmail({
        to: business.email,
        subject: 'Your CheckLocalFirst subscription has been cancelled',
        html: `<p>Hi,</p><p>Your subscription for <strong>${business.name}</strong> has been cancelled. You'll keep full access until <strong>${cancelDate}</strong>, when it will end.</p><p>Changed your mind? You can resubscribe any time before then from your dashboard.</p>`
    });
} catch (emailErr) {
    console.error(`Failed to send cancellation email for business ${business.slug}:`, emailErr);
}
```

**`POST /premium-user/cancel`** — same shape, addressed to the user's email/first name, after fetching them (the route currently only selects `is_premium, is_comped, stripe_subscription_id` — extend that `select` to include `email, first_name`).

Both routes' JSON response is unaffected — this is purely a side effect after the Stripe call succeeds.

### Frontend
No change required — the cancel button flow already just calls the route and shows `cancel_at` from the response; the email is a parallel notification, not something the frontend needs to trigger or display differently.

---

## 9. Business dashboard: view + manage redeemed coupons

**Migration 031:**
```sql
ALTER TABLE discount_redemptions ADD COLUMN used BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE discount_redemptions ADD COLUMN used_at TIMESTAMPTZ;
```

### Backend — new routes in `api/routes/businesses.js`, ownership-enforced same as the existing discount routes

```
GET    /businesses/:slug/discounts/:id/redemptions
PATCH  /businesses/:slug/discounts/:id/redemptions/:redemptionId   { used: boolean }
DELETE /businesses/:slug/discounts/:id/redemptions/:redemptionId
```
- `GET` — verify ownership, verify the discount belongs to this business, then `select('*, users(first_name, last_name, email)').eq('discount_id', id)`, ordered by `redeemed_at desc`. This is what powers a "who's redeemed this" table (name/email + redeemed date + used flag).
- `PATCH` — sets `used` and, when flipping to `true`, stamps `used_at: new Date().toISOString()` (and nulls `used_at` if un-marking). Bookkeeping only, per §0 — does **not** touch the `discount_redemptions` uniqueness constraint or let the user redeem again.
- `DELETE` — removes the redemption row outright. Because of the `UNIQUE(discount_id, user_id)` constraint from migration 027, this is what actually frees the user up to redeem that discount again later — worth a distinct confirm-dialog copy in the UI ("This lets the customer redeem this discount again") so it doesn't read the same as "mark used."
- Add a small `discountRedemptionIdParamSchema` / `updateRedemptionSchema` in `discountSchemas.js` for these three routes.
- Optional convenience: `GET /businesses/:slug/redemptions` (no `:id`) aggregating redemptions across *all* of the business's discounts in one call, for a single dashboard "Redemptions" tab rather than one per discount. Recommended if the dashboard is going to show this as one unified list rather than nested under each discount card.

### Frontend
- Business dashboard, per-discount card (or a dedicated "Redemptions" tab): table of redeemers (name, email, redeemed date), each row with a "Mark used" toggle and a "Delete" button (confirm dialog, copy noting it re-allows redemption).

---

## 10. Admin dashboard: view redeemed coupons

### Backend — `api/routes/admin.js`
```
GET /admin/discounts/:id/redemptions
```
Same join as §9's business version (`users(first_name, last_name, email)`), no ownership check needed (admin-gated at the router level already via `router.use(authMiddleware, authAdminMiddleware)`). Optionally also fold a `redemptions` count or the full list into the existing `GET /admin/discounts/:id` response instead of a separate route — a separate route is more consistent with how `/admin/businesses/:id/full` already handles "give me everything about X" as its own call, so that's the recommended shape.

### Frontend
- Admin discount detail view: add a redemptions table (same shape as the business dashboard one, §9), read-only for now (no mark-used/delete UI needed here) unless you want admin to have the same override power — call this out if you want mark used/delete on the admin side too. Not building it into this plan since it wasn't explicitly asked for.

---

## 11. "Meet the Owner" section — conditional rendering

### Frontend only
On the public business page, only render the "Meet the Owner" section when **both**:
- `business.about_owner` is present and non-empty (trim before checking — a whitespace-only value shouldn't count), and
- `GET /:slug/photos` contains at least one row with `photo_type === 'owner'`.

No backend change — both pieces of data are already returned as-is; this is purely a rendering condition in the component that currently always renders the section.

---

## 12. Premium features disabled/unclickable for basic-tier businesses

### Frontend only, business dashboard
Audit every premium-gated field the business dashboard exposes and apply a consistent "disabled + upgrade CTA" treatment for `business_tier === 'basic'`, rather than leaving it enabled and letting the request 403 on submit (the routes doc already calls this out for `story`/timeline, but story is being removed — see §13 — so the actual list after this round of changes is):
- `timeline_year_1/2/3`, `timeline_description_1/2/3` inputs — `disabled`, greyed out, with a small "Upgrade to Premium" badge/link (to `/premium/businesses` from §7) overlaid or adjacent.
- Any dashboard mention of the 3 timeline photo slots from §2 (even though there's no upload button per §3, if the dashboard shows "request a timeline photo" copy or similar, gate that copy the same way) — same treatment.
- If the dashboard ever renders `is_featured`/`in_carousel` as read-only status indicators, those aren't business-editable anyway (admin-only routes), so no action needed there beyond maybe a "premium unlocks eligibility for featured/carousel placement" note.

Recommend building this as one small shared component (`<PremiumGate tier={business.business_tier}>...</PremiumGate>` or similar) wrapping each gated control, so future premium-only fields opt into the same treatment automatically instead of every new field needing its own bespoke disabled-state logic.

---

## 13. Remove business "story"

Per §0: full removal, including existing data.

**Migration 032:**
```sql
ALTER TABLE businesses DROP COLUMN story;
```
Run this *last*, after confirming nothing above still references `story` — nothing in this plan reintroduces it, but double check before running against production since it's irreversible.

### Backend
- `api/schemas/businessSchemas.js` — remove `story` from `updateBusinessSchema` body and from `PREMIUM_ONLY_BUSINESS_FIELDS`.
- `api/schemas/adminSchemas.js` — remove `story` from `adminUpdateBusinessSchema` body.
- `api/routes/businesses.js` — remove `story` from the destructured body and the `.update({...})` call in `PUT /:slug`.
- `api/routes/admin.js` — same removal in `PATCH /businesses/:id`.
- `clfbackendroutesandinfo.md` — remove the `story` row from §5's field table and drop the "up to 5000 chars" mention.

### Frontend
- Remove the story textarea from the business dashboard's profile editor.
- Remove the "Our Story" (or however it's labeled) section from the public business page template.
- Remove `story` from any TypeScript types/interfaces modeling the business object.

---

## Suggested build order

Roughly in dependency order, grouping backend-first work before the frontend that depends on it:

1. **Migrations 029–032** (all at once, in a single deploy — they're independent of each other except that 032 should land after you've grepped the whole codebase for `story` one more time).
2. **§13 story removal** (backend) — smallest, self-contained, gets stale code out of the way first.
3. **§4 social click events** (backend) — trivial, unlocks §4's frontend tracking calls immediately.
4. **§2 timeline photos** (backend) — small extension of the existing admin upload route; §3 needs no backend work at all.
5. **§9 + §10 redemptions** (backend) — independent of the photo work, can be done in parallel by someone else if you're splitting work.
6. **§8 cancellation email** (backend) — small, independent, low risk.
7. **Frontend**: §11 and §13's frontend half first (pure conditional rendering / deletion, no new backend dependency), then §3's one-line dashboard messaging change and §2's timeline photo display + admin upload form update, §9/§10's redemption tables, §12's premium-gate component (reusable — build once, apply to §2's timeline fields too), then §5/§6/§7 (membership nav, join-now routing, upgrade pages) as the last, most user-facing layer since it ties everything else together.

## Verification checklist before calling any of this done

- Run each migration against a staging DB copy first — 032 especially, since it's destructive.
- Confirm the admin upload form can attach a `timeline` photo to a slot, that re-uploading the same slot cleanly replaces the old file (no orphaned storage object, no unique-index violation), and that this works regardless of the business's tier (admin override, same as timeline text).
- Confirm a basic-tier business's dashboard shows the disabled/upgrade-gated state for timeline fields, and that the photo section shows the new "email us" messaging instead of any leftover upload UI.
- Confirm deleting a redemption actually lets that user redeem the same discount again (hits the `POST /:slug/discounts/:id/redeem` route a second time post-delete and gets a fresh `times_redeemed` increment, not the idempotent "already redeemed" branch).
- Confirm the cancellation emails actually land (Resend delivery, not just a 200 from the route) for both the business and user cancel flows.
- Grep the whole repo (backend and frontend) for `story` after §13 to make sure nothing references the dropped column/field.
