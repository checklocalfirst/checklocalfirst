# CheckLocalFirst Backend — Phase 2 Plan
*Prepared August 2, 2026 — planning only, no code changed*

## Where things stand vs. the July 29 roadmap

Since the last roadmap, Phase 1 landed: `stripeWebhook.js` now generates a Supabase recovery link and sends both a password-setup email and a receipt email through Resend for new business signups and premium-user upgrades, `resend` is in `package.json`, and RLS is enabled. That was the live bug; it's fixed.

Still open from the old roadmap, and now folded into this plan: geolocation/distance search, the remaining admin CRUD gaps, photo upload, discounts, analytics, and featured/carousel routes. This plan also adds everything from your new list: pilot business status, an expanded business profile (story, website, owner bio, a 3-entry timeline, social links), and multi-category businesses.

Every new column below is nullable/additive so existing rows (the 3 seeded businesses, and anything already live) don't break.

---

## 1. Migration 014 — Geolocation

```sql
ALTER TABLE businesses
ADD COLUMN latitude NUMERIC(9,6),
ADD COLUMN longitude NUMERIC(9,6),
ADD COLUMN neighborhood VARCHAR(100),
ADD COLUMN geocoded_at TIMESTAMPTZ;
```

All four nullable, per your spec. `geocoded_at` isn't strictly required but it's what lets you tell "never geocoded" apart from "geocoded, just happens to be null because the API failed" — worth keeping so a retry job (or you, manually) can find the businesses that need another attempt.

### Nominatim integration

New `api/helpers/geocode.js`:

- `geocodeAddress({ address, city, state, zip })` → calls `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&q=<full address>`.
- Nominatim's usage policy requires a descriptive `User-Agent` header (with contact info/URL) and caps free usage at ~1 request/second — fine here since this only fires on address create/update, not in a hot path.
- On success: pull `lat`/`lon`, and try to pull a neighborhood from `address.neighbourhood || address.suburb || address.quarter` in the response (Nominatim doesn't always return one — that's why `neighborhood` has to be nullable, not just as a formality).
- On failure/no match: don't throw — log a warning and leave `latitude`/`longitude`/`neighborhood` as `null`, `geocoded_at` as `null`. A business shouldn't fail to save just because geocoding hiccuped.

**Where it's called:**
1. `stripeWebhook.js` — after the business row is created (or folded into the same insert), geocode the address from the checkout metadata.
2. `PUT /businesses/:slug` (business self-edit) — only re-geocode if `address`, `city`, `state`, or `zip` actually changed in this request (compare against the existing row before firing the API call).
3. `PATCH /admin/businesses/:id` (new full-edit route, see §3) — same "only if address changed" logic.
4. One-off backfill script for the 3 seeded businesses (and any real signups that happened before this ships) — a small script that loops businesses with `latitude IS NULL`, geocodes each with a 1-second delay between calls, and updates the row.

**Neighborhood as admin-editable too:** since Nominatim won't always find one, keep `neighborhood` as a plain editable column on both the business and admin update routes so it can be corrected/filled in by hand when the API comes up empty.

---

## 2. Migration 015 — Pilot business

```sql
ALTER TABLE businesses ADD COLUMN pilot_business BOOLEAN DEFAULT false NOT NULL;
```

Admin-only: `PATCH /admin/businesses/:id/pilot` — body `{ pilot_business: boolean }`.

**Resolved:** badge only, no functional gating. It doesn't unlock premium fields, discounts, or anything else — purely a flag for internal tracking and a frontend "Pilot Partner" tag. No tier-check logic needs to reference it anywhere else in this plan.

---

## 3. Migration 016 — Expanded business profile

```sql
ALTER TABLE businesses
ADD COLUMN story TEXT,
ADD COLUMN website_url TEXT,
ADD COLUMN about_owner TEXT,
ADD COLUMN facebook_url TEXT,
ADD COLUMN instagram_url TEXT,
ADD COLUMN yelp_url TEXT,
ADD COLUMN timeline_year_1 SMALLINT,
ADD COLUMN timeline_description_1 TEXT,
ADD COLUMN timeline_year_2 SMALLINT,
ADD COLUMN timeline_description_2 TEXT,
ADD COLUMN timeline_year_3 SMALLINT,
ADD COLUMN timeline_description_3 TEXT;
```

Matches "three options for years, three descriptions" literally as six columns rather than a separate table — simplest to wire into a single `PUT /businesses/:slug` body. (If you'd rather support an arbitrary number of timeline entries later, a `business_timeline_events(business_id, year, description, sort_order)` table would be more flexible — flagging it as an alternative, not building it unless you want that instead.)

**Resolved tier gating:**
- `facebook_url`, `instagram_url`, `yelp_url`, `website_url`, `about_owner` — available at **both** basic and premium. No gating.
- `story`, `timeline_year_1/2/3`, `timeline_description_1/2/3` — **premium only**, the one part of this profile expansion that's actually a paid differentiator.

Enforce the premium-only fields at the route/validation layer (reject the field in the request body if `business_tier !== 'premium'`), not a DB constraint — that way a downgrade doesn't wipe existing `story`/`about_owner`/timeline data, it just stops being editable/shown until they upgrade again.

Both `PUT /businesses/:slug` (business dashboard) and the new admin full-edit route get these fields added to their schemas — admin edits bypass the tier check (admin can set any field on any business regardless of tier, same as the `is_featured`/`in_carousel` pattern already in place).

---

## 4. Migration 017 — Multi-category businesses

Right now categories only exist at the *service* level (`services.category_id`). To let a business itself belong to multiple categories (independent of what each service is tagged):

```sql
CREATE TABLE business_categories (
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (business_id, category_id)
);
```

Routes:
- `PUT /businesses/:slug/categories` (business dashboard) — body `{ category_ids: [1, 2, 3] }`, replace-all semantics: delete the business's existing rows and insert the new set inside one call.
- `PUT /admin/businesses/:id/categories` — same, admin-side.
- `GET /businesses/:slug` (and `/businesses` list) — extend the select to include the joined category list so the frontend can render badges.

**How this interacts with search — recommendation (you asked for one):** make `business_categories` the single source of truth for the `category` filter across all of `/search`, including when `q` is also present. Concretely: filter results down to businesses tagged with that category, regardless of what category the individual matching service happens to carry. Reasoning — search is conceptually "find businesses," and a business owner tagging themselves under multiple categories should reliably surface them there; if `category` instead filtered per-service, a business tagged "Gifts & Specialty" but whose only matching service happened to be tagged "Home Decor" would get excluded, which fights the point of letting a business register under multiple categories at all. `services.category_id` stays exactly as it is today — it's still what organizes/labels services on a business's own page, just no longer what search's `category` param reads from. See §6 for the query-level change this implies.

---

## 5. Business + admin dashboard routes — closing the CRUD gap

This is the "make it all customizable" ask. Concretely:

**Business dashboard (`businesses.js`), all auth + ownership-enforced:**
- Extend `updateBusinessSchema`/`PUT /businesses/:slug` to accept every new column from §1–3 as optional fields (address changes trigger re-geocoding per §1).
- `PUT /businesses/:slug/categories` (§4).
- Photo, discount routes — see §7–8.

**Admin dashboard (`admin.js`):**
- New `PATCH /admin/businesses/:id` (general field editor) — today admin can only touch `status` via `/admin/businesses/:id/status`. Add a full-edit route covering every business column (profile fields, tier, `is_comped`, `pilot_business`, lat/lng override for manual correction) so admin genuinely has full DB control, not just approve/suspend.
- `PATCH /admin/businesses/:id/pilot` (§2).
- `PUT /admin/businesses/:id/categories` (§4).
- Category create/delete: already exist on `/categories` (admin-gated) per the API reference — leave as-is, or mirror under `/admin/categories` purely for dashboard consistency if you want everything under one prefix. Low priority, cosmetic.

---

## 6. Search rework

Extend `GET /search` to accept, in addition to the existing `q` and `category`:

- `lat`, `lng`, `radius_miles` (all optional, all three needed together to activate distance filtering).
- When present: filter to businesses with non-null `latitude`/`longitude` within the radius, and sort by distance. A plain SQL Haversine calculation in a Postgres function (e.g. `businesses_within_radius(lat, lng, radius_miles)`) avoids depending on whether `earthdistance`/`cube` extensions are enabled on your Supabase project — worth checking, but the plain-math version works regardless.
- Expose `distance_miles` on each result so the frontend can show "2.3 mi away."
- Businesses that haven't been geocoded yet (`latitude IS NULL`) are simply excluded when a location filter is active — call this out in the API reference so the frontend doesn't expect every business to show up under "near me."
- `category` param: repoint to `business_categories` per §4 — join `business_categories` on the category slug and filter to businesses in that set, instead of (or in addition to, if you want a stricter AND) filtering the underlying `services.category_id`. Since text search still runs against `services` for the `q` match, the practical change is: get matching services as today, then intersect the resulting business set with `business_categories` for the category filter rather than filtering the services query itself by `category_id`.

**Search suggestions/autocomplete** — confirmed feature, not a maybe. New `GET /search/suggestions?q=` route, no schema change needed — reuses the existing `pg_trgm` index on `services.name`, since that's what search actually matches against.

- Query: prefix `ILIKE` (`name ILIKE '<q>%'`) for the common "still typing the start of a word" case, falling back to `similarity()` ordering (same `> 0.15` threshold as `search_services_fuzzy`) when the prefix match comes back empty, so a slightly misspelled partial word still surfaces something.
- Only pull from `services` joined to `businesses!inner` where `status = 'approved'` — no point suggesting a term that would return zero results once they hit enter.
- Return distinct `name` values (not full rows) capped at ~8, ordered by similarity/relevance — this is a lightweight typeahead, not a second copy of the results themselves.
- Cheap enough to run on every keystroke, but the frontend should still debounce (e.g. 200–300ms) before calling it — that's a frontend concern, not something this route needs to enforce, though it's worth putting on the general rate limiter same as other public routes so a broken debounce on the frontend can't hammer it.
- Response shape: `{ success: true, data: ["Vintage Clothing", "Vintage Furniture", ...] }` — plain array of strings is enough for a dropdown; no need to round-trip full service objects for suggestions.

---

## 7. Photo upload

`business_photos` table already exists and fits (`photo_type`: listing/owner/gallery, `display_order`) — no schema change needed here.

- New dependency: `multer` for multipart parsing (`express.json()` doesn't handle file uploads).
- Storage: a Supabase Storage bucket (e.g. `business-photos`), public bucket since these are public listing images — upload via `supabaseAdmin.storage.from('business-photos').upload(...)`, store the returned public URL in `photo_url`.
- Public: `GET /businesses/:slug/photos` (ordered by `display_order`) so the business page can render whatever's actually been uploaded — dynamic, not a fixed number of image slots. A basic-tier business with just a storefront shot (`photo_type: 'listing'`) and an owner photo (`photo_type: 'owner'`) renders two images; a premium business with a gallery renders those two plus however many `gallery`-type rows it has.
- Admin: `POST/PUT/DELETE /admin/photos` (and a business-scoped list, `/admin/businesses/:id/photos`) — full CRUD across every business's photos, uploads on a business's behalf, **no cap, no tier restriction.** This is the only upload path with no limit — matches your answer that admin should be able to upload as many as they want per business, of any `photo_type`, regardless of that business's tier.
- Business dashboard self-service upload (`POST/PUT/DELETE /businesses/:slug/photos[/:id]`, ownership-enforced) — gating has two dimensions now, not just a count:
  - **`photo_type: 'listing'` and `'owner'`** — available at both tiers, capped at one of each (enforce one-of-each via the `photo_type` check, reject a second `listing`/`owner` upload until the existing one is replaced/deleted). This is the "basic pages usually have two" baseline.
  - **`photo_type: 'gallery'`** — **premium only.** A basic-tier business attempting to self-upload a `gallery`-type photo gets rejected (403, same `PREMIUM_REQUIRED`-style pattern as the discount redeem gate) rather than just silently allowed at a lower count — the gallery itself is the premium feature, not just "more photos." Premium businesses get a cap here too (recommend something like 10 — open to tuning, just needs *a* number so nobody uploads an unbounded gallery through the self-service path; admin uploads still bypass it).
  - Net result: basic tier renders storefront + owner photo only; premium tier renders those two plus a dedicated gallery section on the listing page.

---

## 8. Discounts

```sql
CREATE TABLE discounts (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    code VARCHAR(50),
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

CREATE TABLE discount_redemptions (
    id SERIAL PRIMARY KEY,
    discount_id INTEGER NOT NULL REFERENCES discounts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id),
    redeemed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
```

**Resolved:** redemption-tracked, and gated on the *user's* premium status, not the business's tier — any business (basic or premium) can post a discount, but revealing the actual code requires the requesting user to be a premium user. This splits into two routes instead of one:

- `GET /businesses/:slug/discounts` (public, no auth) — returns discount metadata only: `description`, `discount_type`, `value`, `expires_at`, etc. **Not** `code`. This is what renders the discount card/button on the business page for every visitor.
- `POST /businesses/:slug/discounts/:id/redeem` (auth required) — the "reveal code" button's target. Access check has two paths in, since "premium" means something different depending on account type:
  - **Premium user** (`account_type: 'user'`, `users.is_premium = true` or `is_comped`) → allowed.
  - **Premium business owner** (`account_type: 'business'`) → look up the business they own via `owner_user_id` and check *its* `business_tier === 'premium'` (or `is_comped`) — a premium business's own owner gets discount access too, even though `users.is_premium` is a separate, user-side flag they'd never have set. So the check is effectively: `users.is_premium OR users.is_comped OR (account_type = 'business' AND their business.business_tier = 'premium')`.
  - Either path, on success: increment `times_redeemed`, insert a redemption record (see below), and return `{ code }`.
  - Neither path (basic-tier business owner, non-premium regular user, or logged-out visitor): respond with something the frontend can key off deterministically, e.g. `403` with `{ success: false, error: 'Premium required to redeem discounts', code: 'PREMIUM_REQUIRED' }` — the frontend catches that specific `code` and opens the "go premium" upgrade prompt (`POST /stripe/premium-user/checkout` for a user, `POST /stripe/business/:slug/upgrade` for a business) rather than a generic error toast.
  - Respect `max_redemptions` (reject once `times_redeemed` hits it) and the `active`/`starts_at`/`expires_at` window.
- Since redemption is tied to a specific user, consider a `discount_redemptions(discount_id, user_id, redeemed_at)` join table instead of only incrementing a counter — lets you (and the business owner) see *who* redeemed, not just a count, and cheaply prevents the same user from "redeeming" (and re-incrementing) the same code twice if that matters. Flagging this as a small addition to migration 018; adopt it unless you'd rather keep it to a bare counter.
- Business dashboard: `POST/PUT/DELETE /businesses/:slug/discounts[/:id]`, ownership-enforced (creating/editing a discount itself isn't tier-gated — any business can post one).
- Admin: full CRUD/moderation across all businesses' discounts, plus visibility into redemption counts/redeemers.
- The redeem click itself is a good candidate to also log as a `discount_click` analytics event (§9) even on the `PREMIUM_REQUIRED` path, so you can see interest from non-premium users too, not just successful redemptions.

---

## 9. Analytics tracking

```sql
CREATE TABLE business_analytics_events (
    id BIGSERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    event_type VARCHAR(30) NOT NULL CHECK (event_type IN ('call_click', 'email_click', 'page_view', 'address_click', 'website_click', 'discount_click')),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX idx_analytics_business_event ON business_analytics_events(business_id, event_type, created_at);
```

No outbound-link tracking, no PII — matches your existing note.

- Public: `POST /businesses/:slug/track` — body `{ event_type }`, unauthenticated but rate-limited more aggressively than `generalLimiter` (this is a write endpoint anyone can hit) — keep it cheap: validate `event_type` against the enum, insert, return 204.
- Business dashboard: `GET /businesses/:slug/analytics?from&to` — counts grouped by `event_type`/day, ownership-enforced, feeds a dashboard chart.
- Admin: `GET /admin/businesses/:id/analytics` (per-business) and `GET /admin/analytics` (cross-business — e.g. most-viewed businesses, total events by type) for a bird's-eye view.

---

## 10. Featured & carousel — the cheap, mostly-done phase

Migration 011 already added `is_featured`, `featured_since`, `in_carousel`, and the DB constraints (only one featured business, both require premium tier). Nothing schema-side needed. Just routes:

- `PATCH /admin/businesses/:id/featured` — body `{ is_featured: boolean }`. Because only one business can be featured at a time (partial unique index), setting a new featured business must unset the old one atomically. Recommend a small Postgres function (`set_featured_business(new_id)`) called via `.rpc()` rather than two sequential JS calls, so there's no window where either zero or two businesses are marked featured if a request fails mid-way.
- `PATCH /admin/businesses/:id/carousel` — body `{ in_carousel: boolean }`, no uniqueness constraint, straightforward toggle.
- Public: `GET /businesses/featured` and `GET /businesses/carousel` (or `GET /businesses?carousel=true`) — `status = 'approved'` plus the respective flag, for the homepage.

---

## Suggested build order

1. **Migrations 014–017** (geolocation, pilot business, profile fields, business_categories) — one deploy, all additive/nullable, low risk.
2. **Nominatim wiring** — `helpers/geocode.js`, hook into webhook + business PUT + new admin PATCH, backfill script for existing businesses.
3. **Business + admin dashboard routes** for everything from steps 1–2, so "customizable in both dashboards" is actually true before building on top of it.
4. **Featured & carousel routes** (§10) — cheapest win, DB's been ready since migration 011.
5. **Search rework** (§6) — category via `business_categories`, location/radius filtering, search-suggestions endpoint.
6. **Photo upload** (§7) — the one new dependency (`multer`) and genuinely new middleware, so it's isolated to its own step.
7. **Migrations 018–019 + routes** — discounts and analytics together, since discount clicks likely feed analytics events.
8. **Hardening pass** — the old roadmap's Phase 8 items still apply and now cover more surface area: spot-check RLS on the new public routes (`/search/suggestions`, `/businesses/featured`, `/businesses/:slug/discounts`, `/businesses/:slug/photos`), add tests around geocoding failure paths and the featured-business uniqueness constraint, resolve the still-open `auth/signup/business` redundancy question, audit for hardcoded values.

## Status

All decisions are resolved: `business_categories` drives search's category filter (confirmed), and search suggestions/autocomplete is a confirmed feature (§6) rather than an open maybe. This plan is ready to build against.

---

## 11. Beyond this plan — what "strong backend" doesn't cover yet

Everything above makes this a genuinely solid technical foundation: real input validation on every route, a consistent ownership-check pattern, rate limiting split between general and auth-sensitive traffic, RLS on at the DB level, versioned migrations, and — the hardest part to get right — a Stripe integration where the webhook is the source of truth for account creation and tier changes rather than the client, which sidesteps a whole class of "user closed the tab mid-checkout" bugs. That's not typical for this stage of a project.

It isn't the same thing as "ready to run unattended as a real business," though. None of the items below block building the features in this plan — they're a hardening pass that matters more as usage grows, and most already overlap with Phase 8 of the original roadmap. Listing them here so they don't get lost:

- **No tests anywhere** — `npm test` is still a stub. The Stripe webhook (account creation, tier flips, cancellation) and the admin delete-cascade routes (`DELETE /admin/businesses/:id`, `DELETE /admin/users/:id`) are exactly the code where a silent regression costs real money or real data, and nothing currently catches that before a user does.
- **No monitoring or error tracking** — if something breaks in production on Render, the current failure mode is "find out from an angry email," not a dashboard or alert.
- **No pagination anywhere** — `/search`, `/businesses`, `/admin/businesses`, `/admin/users`, `/admin/services` all return full unpaginated result sets. Fine at a handful of businesses, not fine once the directory actually grows — and this includes the admin list views, not just public-facing ones.
- **CORS wide open** — no allowlist configured yet; fine for development, needs locking down before real launch.
- **No refresh-token/session-expiry handling** — token expiry currently just forces a re-login. Acceptable for now, a rough edge later.
- **The redundant `auth/signup/business` route** — still creates a business account without payment, in parallel with the Stripe checkout path. Needs a decision: stays, becomes admin-only, or gets removed.
- **Hardcoded-value audit** — carried over from your own readme's note, still outstanding.
- **New attack surface from this plan specifically** — photo upload needs real file-type/size validation (not just trusting the `Content-Type` header) once `multer` is wired in, and the new public write endpoints (`POST /businesses/:slug/track`, `POST /businesses/:slug/discounts/:id/redeem`) need their own tighter rate limits since they're unauthenticated-or-low-friction routes that write to the DB.
- **Geocoding provider ceiling** — Nominatim's free tier is capped at ~1 request/second under its usage policy. Fine at current volume; if the directory grows enough that geocoding volume becomes meaningful, budget for migrating `helpers/geocode.js` to a paid provider (Google, Mapbox) later — the abstraction already isolates that swap to one file.
- **Non-code business concerns worth having answers to** — a privacy policy and terms of service covering the location, analytics, and discount-redemption data now being collected; and confirming Supabase's backup/point-in-time-recovery setup matches what you'd want to rely on if something went wrong.

None of this needs to happen before Phase 2 ships. It's the list to work through before calling the backend "production-final" for unattended real-world traffic.
