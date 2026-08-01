# CheckLocalFirst Backend — Production Roadmap
*Prepared July 29, 2026 — analysis only, no code changed*

## Where things actually stand

This backend is further along than a typical internship project. You have a full Express + Supabase API with zod validation on every route, centralized error handling, rate limiting, helmet, cascading foreign keys, a working three-tier search (full-text → ilike → pg_trgm fuzzy), and a genuinely solid Stripe integration: business signup checkout, premium user checkout, tier upgrades with proration, cancel-at-period-end, promo codes, and a webhook that's the source of truth for account creation and tier changes. Twelve migrations are already applied, including groundwork you haven't wired up yet — a `business_photos` table, and `is_featured`/`in_carousel` columns with a DB constraint that only allows one featured business at a time and requires premium tier.

**What you did yesterday (Jul 28):** finished the Stripe checkout flow end to end — coupon/promo code support, a guard against double premium-upgrade submissions, a unique-phone check on business signup, and you removed a password-recovery/reset route that wasn't working yet. That last commit is the important one.

## The bug that should come before anything else on your feature list

Look at `stripeWebhook.js`: when a business finishes paying through Stripe, the webhook creates their Supabase auth user with `crypto.randomUUID() + crypto.randomUUID()` as the password and `email_confirm: true`. No email is sent. That password is never shown to anyone, anywhere. **A business that just paid you has no way to log into the account they paid for.** This isn't part of the roadmap — it's a live, silent failure in your only revenue path right now. It's also exactly why you pulled the broken recovery routes yesterday; you were mid-fix and stopped there. This is what "resend + reset password so they can access their account" should actually solve, and it should be step one.

(Side note worth deciding, not fixing: `auth/signup/business` still lets someone create a business account *without* paying, in parallel with the Stripe checkout path. Once Stripe is the intended front door, decide whether that route stays, becomes admin-only, or gets removed.)

## Phase 1 — Resend integration to unblock account access (do first)

- `npm install resend`, add `RESEND_API_KEY` to env (you already have the pattern for pulling secrets via dotenv).
- Add a small `helpers/sendEmail.js` wrapping `resend.emails.send`.
- Use `supabaseAdmin.auth.admin.generateLink({ type: 'recovery', email })` to get a secure, Supabase-hosted reset link — don't hand-roll token generation.
- Call this right after account creation in `stripeWebhook.js` for both the business path and the premium-user path, and send it through Resend with a branded template pointing at a `/reset-password` page on the frontend.
- Do the same for the admin `create-comped-business` / `create-comped-user` routes in `auth.js` — right now the admin sets a password directly and has to relay it manually. An email removes that manual step and one more place a password could leak.
- Consider a short welcome/receipt email alongside it — cheap to add once the send helper exists.

## Phase 2 — Geolocation + search upgrade

- New migration: `latitude NUMERIC(9,6)`, `longitude NUMERIC(9,6)` on `businesses` (nullable — you'll backfill), maybe a `geocoded_at` timestamp.
- You need a geocoding step somewhere: address/city/state/zip → lat/lng. Either call a geocoding API (Google, Mapbox, or free-tier Nominatim) server-side on business approval, or let admins enter lat/lng manually in the dashboard as a stopgap for the businesses you already have.
- Distance search: add a Postgres function similar to your existing `search_services_fuzzy` RPC — something like `search_services_near(lat, lng, radius_miles)` using the `earthdistance`/`cube` extensions (lighter than full PostGIS unless you already need PostGIS for something else — worth checking what extensions your Supabase project has enabled).
- Extend `search.js` to accept optional `lat`/`lng`/`radius_miles` query params, sort by distance when present, and expose distance on business list/detail responses so the frontend can show "2.3 mi away."

## Phase 3 — Admin dashboard: close the CRUD gaps

Current `admin.js` covers businesses (list/get/status/delete), users (list/get/delete), services (list/get/update/delete), categories (update only), and stats. Missing, needed for a real "manage all DB info" dashboard:

- `/admin/photos` — CRUD for `business_photos` (table exists, nothing uses it yet).
- `/admin/featured` and `/admin/carousel` — toggle `is_featured`/`in_carousel`. Needs care: the DB has a unique index allowing only one `is_featured = true` row, so setting a new featured business must unset the old one in the same transaction/call.
- `/admin/discounts`, `/admin/analytics`, `/admin/landing-signups` — new, see Phases 5–6.
- Business PATCH should let admins set `business_tier`/`is_comped` directly, not just `status`.
- Category create/delete under `/admin` for consistency (currently lives only in `categories.js`, gated separately).

## Phase 4 — Photo upload, connected to businesses

- `business_photos` table already fits (`photo_type`: listing/owner/gallery, `display_order`) — no schema change needed.
- Use Supabase Storage (a bucket like `business-photos`). You'll need multipart parsing (`multer` or `busboy`) since `express.json()` won't handle file uploads — this is a genuinely new piece of middleware, not just a route.
- Admin route: upload → store in bucket → insert row with the returned URL. Add list/reorder/delete per business.
- Extend the public business detail route (or add `:slug/photos`) to return ordered photos so the frontend can render galleries dynamically instead of the manual "email us a photo, we rename the file" process the readme describes.

## Phase 5 — Discounts system

- New table: `discounts` (id, business_id FK, code, description, discount_type [percent/fixed], value, starts_at, expires_at, max_redemptions, times_redeemed, active).
- Decide up front: are these informational-only (shown on the page, redeemed in person) or do you need redemption tracking? Your readme mentions "premium upgrade pop-ups when users click discount codes," which suggests this is a premium-tier business feature, and clicks should probably feed the analytics table in Phase 6.
- Routes: business owner CRUD on their own discounts, a public route to fetch a business's active discounts, admin moderation/CRUD.

## Phase 6 — Analytics tracking

- New table: `business_analytics_events` (id, business_id, event_type [call_click, email_click, page_view, address_click, discount_click], created_at). Per your note, no outbound link tracking — you're not sending users to other sites.
- One public, rate-limited, unauthenticated route (`POST /businesses/:slug/track`) to log an event — keep it cheap and abuse-resistant.
- Admin/business-owner read route that aggregates counts (group by event_type/day) for dashboard charts.

## Phase 7 — Featured & carousel (mostly DB-ready already)

Migration 011 already did the hard part — the columns and constraints exist. What's missing is purely route-level: an admin toggle that respects the one-featured-business constraint, and a public `GET /businesses?carousel=true` (or dedicated endpoint) for the homepage carousel. This is the cheapest phase on the list.

## Phase 8 — Security & production hardening

- **RLS**: flagged in your own readme as not yet done. Since every private route already goes through `supabaseAdmin` (service role) and the anon key is only used for scoped auth calls, RLS shouldn't break existing routes — but test table-by-table before flipping it on in production.
- Audit for hardcoded values (also your own readme's note).
- Confirm Stripe price IDs, webhook secret, and the new Resend key all live only in env.
- Add basic request logging/monitoring since Render is your sole host.
- Add tests for the money paths at minimum — `npm test` is currently a stub, and the Stripe webhook (account creation, tier flips, cancellation) is exactly the kind of code where a silent regression is expensive.
- Resolve the redundant unpaid business-signup route noted above.

## Suggested build order

1. **Phase 1** — Resend password-setup emails. Live bug, fix it first.
2. **Phase 7 + Phase 3's featured/carousel piece** — cheapest wins, DB already supports it.
3. **Phase 3** (remaining admin CRUD) — needed before the dashboard can claim full DB management.
4. **Phase 2** — geolocation + search.
5. **Phase 4** — photo upload (this one has a real new dependency: file upload middleware).
6. **Phase 5 + Phase 6 together** — discounts and analytics, since discount clicks likely feed analytics.
7. **Phase 8** — hardening pass (RLS, tests, audits) before calling it production-final.
