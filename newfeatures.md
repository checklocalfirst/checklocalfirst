# New Features — Frontend Build Guide
*For the frontend agent working on the CheckLocalFirst Next.js app. Covers everything that changed on the backend this round, plus the remaining frontend-only work that goes with it. Read alongside `clfbackendroutesandinfo.md` (the full route reference) — this doc only covers what's new/changed since that doc was last updated, not the whole API.*

Conventions are unchanged from the main routes doc: base URL from an env var, `Authorization: Bearer <access_token>` on anything marked Auth, success responses shaped `{ success: true, data }` or `{ success: true, message }`, validation errors shaped `{ success: false, error, details }`, and auth-middleware failures shaped `{ error }` with no `success` key. Check for `data`/`success` rather than assuming `success` is always present.

---

## Part 1 — New and changed routes

### 1. Timeline photos

Each of a business's 3 timeline entries (`timeline_year_1/2/3`, `timeline_description_1/2/3` on the business object — premium-tier only) can now have an associated photo. This is **admin-managed only** — there is no business-facing upload route for this (see Part 2, item 1, for why).

**What you'll consume:** `GET /businesses/:slug/photos` (public, no auth — same route as always) now returns rows with `photo_type: 'timeline'` and a `timeline_slot` field (`1`, `2`, or `3`; `null` on every other `photo_type`):

```json
{ "id": 12, "business_id": 4, "photo_url": "https://...", "photo_type": "timeline", "timeline_slot": 2, "display_order": 0, "approved": true, "created_at": "..." }
```

**Where to use it:** on the public business page's timeline section, for each of the 3 entries, find the matching photo by `timeline_slot === N` and render it next to that entry's year/description. If no photo exists for a slot, just render the text — don't assume every slot has one.

**Business dashboard:** no upload control needed here (see Part 2, item 1) — if the dashboard shows the timeline editor, it can optionally show a small read-only thumbnail of each slot's photo (from the same `GET /:slug/photos` response the dashboard likely already fetches), but there's no "upload" action to wire up.

**Admin dashboard (if you're building this too):** the existing photo upload form's `photo_type` selector needs a 4th option, `timeline`. When selected, show a slot picker (1/2/3). Two routes changed:

- `POST /admin/businesses/:id/photos` — multipart/form-data, same as before (`photo` field for the file), plus form fields `photo_type` and, **only when `photo_type` is `timeline`**, `timeline_slot` (integer 1–3, **required** in that case, **must be omitted** for every other type — the request 400s otherwise). No cap, no tier restriction, same as every other admin upload.
  - Uploading to a slot that already has a photo **replaces it** — the old photo is deleted server-side automatically. Treat every slot in the UI as always showing "Upload" (which becomes "Replace" once a photo exists), never a separate "remove first" step.
- `PUT /admin/photos/:id` — body: `photo_type`, `display_order`, `timeline_slot`, all optional. Same required-when-timeline rule when `photo_type` is being *changed to* `timeline` in the same request. You can move an already-`timeline` photo to a different slot by sending just `{ timeline_slot: N }` without resending `photo_type`. Moving a photo's type *away* from `timeline` clears its slot automatically server-side — don't try to send `timeline_slot: null` yourself, just omit it.

### 2. Social media click tracking

`POST /businesses/:slug/track` (public, no auth, same route as every other click event) now accepts three new `event_type` values: `facebook_click`, `instagram_click`, `yelp_click`.

**Where to use it:** on the public business page, wherever the Facebook/Instagram/Yelp icons link out (`facebook_url`/`instagram_url`/`yelp_url` on the business object), fire this fire-and-forget on click, exact same pattern as whatever you're already doing for `website_click`/`call_click`:

```js
fetch(`${API_BASE}/businesses/${slug}/track`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ event_type: 'facebook_click' }),
});
// don't await this before navigating — same as the existing website/call click pattern
```

**Analytics dashboards (business + admin):** `GET /businesses/:slug/analytics` and `GET /admin/businesses/:id/analytics` both return one key per event type that actually occurred in the date range — `facebook_click`/`instagram_click`/`yelp_click` will just show up as additional keys once they start getting fired. **If your chart component hardcodes a fixed list of series/colors for the 6 original event types, it needs the 3 new keys added** — check this before shipping, since it's an easy thing to silently miss (the data will be there, it just won't render).

### 3. Discount redemption management — business dashboard

Four new routes, all Auth: Bearer + ownership-enforced (same pattern as every other `/businesses/:slug/...` dashboard route — 403 if you don't own the business).

**`GET /businesses/:slug/discounts/:id/redemptions`** — everyone who's redeemed one specific discount.
```json
{ "success": true, "data": [
  { "id": 5, "discount_id": 3, "user_id": "uuid", "redeemed_at": "2026-08-01T...", "used": false, "used_at": null,
    "users": { "first_name": "Jane", "last_name": "Doe", "email": "jane@example.com" } }
] }
```

**`GET /businesses/:slug/redemptions`** — convenience aggregate: every redemption across *all* of this business's discounts in one call. Same row shape as above, plus each row embeds `discounts: { code, description }`. **Recommended over the per-discount route** if you're building one unified "Redemptions" tab rather than nesting a table under each discount card — saves N requests for N discounts.

**`PATCH /businesses/:slug/discounts/:id/redemptions/:redemptionId`** — body `{ used: boolean }`. **Bookkeeping only.** This is "mark as fulfilled" — the business ticking off that a customer actually came in and used their code. It does **not** let the customer redeem again; the one-redemption-per-user-per-discount rule is completely untouched by this. Response includes the updated row (`used`/`used_at` reflect the change).

**`DELETE /businesses/:slug/discounts/:id/redemptions/:redemptionId`** — removes the redemption record entirely. **This is different from marking it used** — deleting it actually frees that customer up to redeem the same discount again in the future, since it's the record the backend's uniqueness check was matching against. Use a distinct confirm-dialog copy for this vs. the "mark used" toggle so they don't read as the same action to whoever's clicking — e.g.:
- Mark used: *"Mark this redemption as used?"*
- Delete: *"Delete this redemption? [Customer name] will be able to redeem this discount again."*

**UI suggestion:** a table per discount (or one combined table if using the aggregate route) with columns for customer name/email, redeemed date, a "Used" toggle, and a delete icon/button with the confirm dialog above.

### 4. Discount redemption visibility — admin dashboard

**`GET /admin/discounts/:id/redemptions`** — Auth: Bearer + admin. Same row shape as the business version above (with `users: { first_name, last_name, email }` embedded), works across any business, no ownership check needed. **Read-only** — there's no admin-side mark-used/delete route; if you want admin to have that same override power later, flag it, it wasn't built into this round.

### 5. Business "story" field — fully removed

The `story` column no longer exists in the database. Both `PUT /businesses/:slug` and `PATCH /admin/businesses/:id` will **reject the request with a 400** if `story` is present in the body (it's no longer in the accepted field list), and neither route returns it anymore.

**What to do:**
- Delete the story textarea/field from the business dashboard's profile editor.
- Delete the "Our Story" (or however it's labeled) section from the public business page template.
- Remove `story` from any TypeScript type/interface modeling the business object — if it's still typed as `story?: string` somewhere, delete that line, and check for any component still trying to read `business.story` (it'll just be `undefined` now, but better to remove the dead code).
- Grep the frontend codebase for `story` to catch anything this misses.

### 6. Subscription cancellation — email side effect (no route change, informational)

`POST /stripe/business/:slug/cancel` and `POST /stripe/premium-user/cancel` behave exactly as documented already (same request/response shape, same `cancel_at` field) — nothing to change in how you call them. The only difference is the backend now also sends a confirmation email stating the subscription is cancelled and when access ends. **No frontend work here**, just noting it so you're not surprised when a cancel action also triggers an email.

---

## Part 2 — Remaining frontend-only work (from the original feature list, no backend changes needed)

### 1. Business photo submissions — no self-service upload

Decision: businesses do **not** get an upload button. They send photos in over email, or CheckLocalFirst arranges a professional shoot, and admin uploads them the usual way. On the business dashboard's photo section, replace any "coming soon" placeholder with a one-liner along the lines of:

> *"Want new photos on your listing? Email them to [address] or ask us about a professional photo shoot."*

Everything else about how photos display on the dashboard (rendering whatever's in `GET /:slug/photos`, ordered by `display_order`) is unchanged.

### 2. Membership navbar + membership pages

- Navbar: add a **"Membership"** item with a dropdown/menu offering **"For Users"** (→ `/membership/users`) and **"For Businesses"** (→ `/membership/businesses`).
- `/membership/users`: marketing content on the benefits of a Premium user membership (discount code redemption is the flagship perk — see `PREMIUM_REQUIRED` gating on `POST /businesses/:slug/discounts/:id/redeem` in the main routes doc). Ends in a CTA.
- `/membership/businesses`: marketing content on Basic vs. Premium business tiers (gallery + timeline photos, featured slot, carousel eligibility, discounts, analytics — all real, server-enforced perks, so a tier-comparison table here is safe to build honestly). Ends in a CTA.
- Both CTAs should route using the same signed-in/signed-out logic as item 3 below.

### 3. "Join Now" button routing

Build a shared helper (e.g. `getJoinNowHref(session)`):
- No session → `/signup`.
- Session, `accountType === 'business'` → `/premium/businesses`.
- Session, `accountType === 'user'` → `/premium/users`.
- Already premium/premium-tier: consider routing to account/billing instead — the premium upgrade page itself should defensively show an "already Premium" state if hit directly regardless.

Apply this everywhere a "Join Now" CTA appears (navbar, landing page, the membership pages above).

### 4. Premium upgrade pages (checkout)

Two separate pages, both against routes that already exist and are documented in the main routes doc:
- `/premium/users` — Stripe Elements mounted from `POST /stripe/premium-user/checkout`'s `client_secret` (Auth: Bearer required — redirect to login if hit signed out). Handle the 409 "already premium" response.
- `/premium/businesses` — same pattern against `POST /stripe/business/:slug/upgrade` (needs the signed-in owner's own slug first via `GET /businesses/me`). Handle 409 ("already premium") and 402 (card declined) as distinct states.
- Both: on success, don't optimistically flip the UI to "Premium" — the Stripe webhook is the actual source of truth for the tier change and can take a moment to land. Redirect to the relevant dashboard with a success message instead, and let the dashboard's normal data fetch reflect the new tier once it's actually updated.

### 5. "Meet the Owner" — conditional rendering

Only render this section on the public business page when **both**:
- `business.about_owner` is present and non-empty (trim whitespace before checking), **and**
- `GET /:slug/photos` contains at least one row with `photo_type === 'owner'`.

Pure frontend conditional — both pieces of data are already in the responses you're already fetching.

### 6. Premium feature gating on the business dashboard

For `business_tier === 'basic'`, every premium-only input should be visibly disabled with an upgrade CTA rather than silently 403ing on submit. Current list:
- `timeline_year_1/2/3` / `timeline_description_1/2/3` inputs.
- Any dashboard copy referencing the timeline photo slots (Part 1, item 1) — even without an upload button, if there's a "request a timeline photo" note or similar, gate it the same way.
- Gallery photo display/requests, if the dashboard surfaces anything premium-specific there.

Recommend one shared component (e.g. `<PremiumGate tier={business.business_tier}>`) wrapping each gated control so it's applied consistently and new premium fields opt in automatically. Link the CTA to `/premium/businesses` (item 4 above).

---

## Part 3 — Terms of Service & Privacy Policy notes

Not legal advice — a factual list of what data actually flows through the system after this round of changes, for whoever drafts the real documents (a lawyer, ideally). Link to these documents from the signup flows (business checkout, user signup) and the footer.

**Personal information collected directly**
- Users: first/last name, email, phone, password (hashed by Supabase Auth, never seen by the backend in plaintext).
- Businesses: owner first/last name, business name/description/address/phone/email, and anything filled into the profile (owner bio, social links, timeline text). **Note: the business "story" field has been removed** — it's no longer collected or stored; any earlier draft of a privacy policy that mentioned "business story" should have that line removed.

**Photos**
- All business photos (listing, owner, gallery, and now timeline photos) are uploaded by admin, sourced either from a professional photo shoot CheckLocalFirst arranges, or from photos the business emails in directly. **If businesses are emailing photos to a company inbox, disclose that email submissions are used to populate their public listing** — this is a new, distinct collection channel from the signup form fields above and is worth its own line.
- Uploaded photos are stored in Supabase Storage and served from public URLs — anyone with the link can view them, by design, since they're meant to appear on public listings.

**Location data:** unchanged — a business's address is sent to Nominatim (OpenStreetMap) to resolve coordinates for "near me" search. Third-party data flow, worth disclosing.

**Payment data:** unchanged — handled entirely by Stripe; this backend only retains a Stripe customer id and subscription id.

**Analytics/click tracking — anonymous by design:** unchanged in kind, just a longer list now. `business_analytics_events` records only an event type, business id, and timestamp — no user identity, IP, or session attached. The tracked interactions now include: call clicks, email clicks, page views, address/map clicks, website link clicks, discount reveal clicks, **and Facebook/Instagram/Yelp link clicks**. State plainly that all of this is aggregate, not tied to an individual visitor.

**Discount redemption — the one place tracking isn't anonymous:** unchanged in principle, one addition. `discount_redemptions` ties a specific `user_id` to a specific `discount_id` and timestamp, permanently — disclosed distinctly from the anonymous analytics above, same as before. **New:** each redemption now also has a `used`/`used_at` flag, which is the business marking that they've seen the customer redeem the code in person. This is bookkeeping metadata on the *same* already-disclosed record (who redeemed what, when) — not a new category of data collection, but worth a sentence noting the business can annotate a redemption as fulfilled.

**Transactional email:** unchanged in provider (Resend), one addition — cancellation confirmation emails (subscription cancelled, effective end date) join the existing list of transactional emails (password setup, receipts, welcome, premium-upgrade receipts).

**Cookies/local storage:** unchanged — whatever mechanism the frontend uses to persist `access_token` between page loads should be disclosed once that's finalized; this doc doesn't dictate the choice.

**Third-party services to name in the policy (updated list):**
- Supabase — database, authentication, file storage.
- Stripe — payment processing and subscription billing.
- Resend — transactional email (password setup, receipts, welcome emails, **cancellation confirmations**).
- Nominatim / OpenStreetMap — address geocoding.
- Sentry — error monitoring (may capture parts of a failing request).
- **[Your email provider, if photos are submitted via a company inbox]** — worth naming explicitly if that inbox is anything other than plain email (e.g. a shared support tool), since it's now a stated photo-submission channel.

**Known gaps to keep in mind while drafting (unchanged from the main routes doc):** no refresh-token flow (sessions expire and force re-login), no automated backend tests (manual QA is the safety net), and the CORS allowlist needs a manual backend update any time a new frontend domain goes live.
