# CheckLocalFirst Backend — Routes & Frontend Integration Guide
*Full rewrite covering everything live as of Aug 2, 2026 — geolocation, multi-category, photo upload, discounts, analytics, featured/carousel, pagination, and monitoring. Supersedes `clf-api-reference-for-frontend.md`.*

---

## 0. Conventions (read this first)

**Base URL:** every path below is relative to the API base — `https://<your-render-host>` in production, `http://localhost:3000` locally. Store as an env var (`NEXT_PUBLIC_API_BASE_URL` or similar) — never hardcode it in the frontend.

**Auth header:** any route marked "Auth: Bearer" needs `Authorization: Bearer <access_token>`, where `access_token` comes from `POST /auth/login`.

**No refresh-token flow exists yet.** The access token is good for about an hour (Supabase's default), and once it expires the only recovery is logging back in — `authMiddleware` returns a 401 and the frontend should redirect to login. Design the "session expired" state around that now; there's no silent renewal to build against.

**Content-Type:** `application/json` on every request with a body, except photo uploads (`multipart/form-data`, see §7) and the Stripe webhook (server-to-server, not a frontend concern).

**Success envelope** (almost every route):
```json
{ "success": true, "data": { /* object or array */ } }
```
or for actions with no payload:
```json
{ "success": true, "message": "Human readable message" }
```
List routes that support pagination (see §8) add a sibling `pagination` key alongside `data`.

**Error envelopes** — three shapes, handle all three:

Validation failure (zod, 400):
```json
{ "success": false, "error": "Validation failed", "details": { "fieldErrors": { "email": ["Invalid email address"] } } }
```
Business logic errors (401/403/404/409/410/500), sometimes with a machine-readable `code`:
```json
{ "success": false, "error": "Human readable message", "code": "PREMIUM_REQUIRED" }
```
`authMiddleware`/`authAdminMiddleware` failures (missing/bad token, not an admin) — **no `success` key at all**:
```json
{ "error": "message" }
```
Check for the presence of `data`/`success` rather than assuming `success` is always in the payload.

**Known `code` values to branch UI on:**
- `PREMIUM_REQUIRED` (403, discount redeem) — open an upgrade prompt instead of a generic error toast.

**Rate limits** — a 429 returns `{ success: false, error: "..." }`; show a "slow down, try again shortly" state, not a generic error:
| Scope | Limit |
|---|---|
| General traffic | 100 requests / 15 min / IP |
| `/auth/login`, `/auth/signup/*` | 10 requests / 15 min / IP |
| `POST /businesses/:slug/track` | 60 requests / min / IP |
| `POST /businesses/:slug/discounts/:id/redeem` | 50 requests / 15 min / IP |

**CORS:** locked to an allowlist now (production domain + the Vercel testing domain). If you add a new frontend domain (staging, a new Vercel preview pattern, etc.), it needs to be added to the backend's `ALLOWED_ORIGINS` env var or requests will fail with a CORS error — this is a backend-side config change, flag it rather than assuming it'll just work.

**Enum fields you'll render/filter by:**
- `users.account_type`: `user` | `business` | `admin`
- `businesses.status`: `pending` | `approved` | `suspended` | `rejected` (only `approved` shows up in public browse/search)
- `businesses.business_tier`: `basic` | `premium`
- `business_photos.photo_type`: `listing` | `owner` | `gallery`
- `discounts.discount_type`: `percent` | `fixed`
- `business_analytics_events.event_type`: `call_click` | `email_click` | `page_view` | `address_click` | `website_click` | `discount_click`
- `landing_signups.source`: `Instagram` | `TikTok` | `Google` | `Facebook` | `Good ol' fashioned word of mouth` (exact strings, case-sensitive)

---

## 1. Public / Directory Routes (no auth)

### GET `/businesses`
All approved businesses. Full object per row — every column described in §5 below (profile fields, tier, featured/carousel flags, geolocation, everything).

### GET `/businesses/:slug`
Single approved business by slug. 404 if not found or not approved.

### GET `/businesses/featured`
Returns **one object or `null`** (not an array) — only one business can be featured at a time. Good for a homepage hero slot.

### GET `/businesses/carousel`
Array of approved businesses with `in_carousel: true`, for a homepage carousel/slider.

### GET `/businesses/:slug/services`
All services for that business.

### GET `/businesses/:slug/categories`
Array of `{ id, name, slug }` — the business's own category badges (independent of individual service tags).

### GET `/businesses/:slug/photos`
Approved photos only, ordered by `display_order`. `data`: array of `{ id, business_id, photo_url, photo_type, display_order, approved, created_at }`. Render whatever comes back — a basic-tier business typically has just `listing` + `owner` photos, premium adds a `gallery` set. Don't assume a fixed number of slots.

### GET `/businesses/:slug/discounts`
Public discount list for a business page — **metadata only, never the redemption code**: `{ id, description, discount_type, value, starts_at, expires_at, active }`. Only currently-active, in-window discounts are returned. This is what renders the discount card/button; the actual code only comes back from the authenticated redeem route (§5).

### GET `/categories`
All categories: `{ id, name, slug }`.

### GET `/services`
All services across approved businesses, each with an extra `businesses: { name, slug }` field.

### GET `/search`
Query params, all optional but at least one should be present:
- `q` — free text
- `category` — a category **slug**, not id
- `lat`, `lng`, `radius_miles` — all three together activate distance filtering; a partial set is silently ignored, not an error
- `page`, `limit` — see §8

Response groups results by business:
```json
{
  "success": true,
  "data": [
    {
      "business": { "id": 1, "name": "...", "slug": "...", "...": "..." },
      "bestMatch": { /* first matching service, or null on a pure browse */ },
      "matchingServices": [ /* ... */ ],
      "matchCount": 2,
      "distance_miles": 2.3
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 47, "totalPages": 3 }
}
```
`distance_miles` only appears when a location filter was active. Businesses that have never been geocoded are excluded outright once a location filter is active — don't expect every business to show up under "near me." Search runs multiple passes server-side (full-text → partial → fuzzy) transparently; just render whatever comes back.

### GET `/search/suggestions?q=<text>`
Autocomplete-as-you-type. `data`: plain array of up to 8 strings, e.g. `["Vintage Clothing", "Vintage Furniture"]` — not full objects, just names for a dropdown. Debounce keystrokes client-side (~200–300ms) before calling this; it's cheap per-call but there's no reason to fire it on every keystroke.

### POST `/landing`
Waitlist/landing page signup. Body: `name` (1–100 chars), `email` (valid, must be unique — 409 if taken), `source` (exact enum string above — build as a select, not free text).

---

## 2. Auth Routes

### POST `/auth/signup/user`
Free user signup. Body: `firstname`, `lastname`, `email`, `password` (min 8 chars), `phone` (optional, 10 digits). 201 on success, no auto-login — send to the login page after.

### POST `/auth/login`
Body: `email`, `password`. Response `data`: `{ access_token, user_id, email, accountType }`. Use `accountType` to route to the right dashboard.

### POST `/auth/logout`
Auth: Bearer. No body.

### `/auth/signup/business` — **do not build a form against this.** Disabled/commented out server-side. The real business signup is the Stripe checkout flow (§3).

### Admin account-creation routes — **do not build UI for these.** `POST /auth/admin/create-user/:account_type` exists (Auth: Bearer + admin) for internal use only — admin sets the password and relays it out of band. Skip entirely on the dashboard.

---

## 3. Business Signup & Billing (Stripe)

### POST `/stripe/signup/business/checkout` — the real "become a business" signup form
No auth. Body: `name`, `description` (optional), `address`, `email` (must not already exist — 409), `phone`, `state` (2-letter), `city`, `zip` (5-digit), `firstname`, `lastname`, `business_tier` (`basic`|`premium` — build as a plan picker), `coupon_code` (optional Stripe promotion code).

Response `data`: `{ client_secret, customer_id, discount_applied }` — mount Stripe Elements with `client_secret`. **No password field** — the account is created by the backend webhook only after payment succeeds, and the owner sets their password via an emailed link (§6). Make this explicit in the UI: "check your email after payment to set up your login."

### POST `/stripe/premium-user/checkout`
Auth: Bearer. No body. Upgrades a free user to premium. Response: `{ client_secret, customer_id }`, same Elements pattern.

### POST `/stripe/business/:slug/upgrade`
Auth: Bearer, must own the business. No body. Basic → premium upgrade, charges the prorated difference immediately. Handle 409 ("already premium") and 402 (card declined) distinctly.

### POST `/stripe/business/:slug/cancel` / `POST /stripe/premium-user/cancel`
Auth: Bearer. No body. Cancels at period end, not immediately — response includes `cancel_at`, show the user when access actually ends.

---

## 4. Authenticated Account Routes (users)

### GET `/users/me` / `PUT /users/me`
Auth: Bearer. `PUT` is a partial update — send only changed fields: `first_name`, `last_name`, `email`, `phone`.

### Favorites (Auth: Bearer, "save this business" feature)
- `GET /favorites` — `data`: array of `{ ...favorite row, businesses: { ...full business object } }`.
- `POST /favorites` — body: `{ business_id }`.
- `DELETE /favorites/:business_id` — no body.

---

## 5. Business Dashboard Routes

All of these require Auth: Bearer **and** ownership — the backend checks the logged-in user actually owns the business behind `:slug`, 403 otherwise.

### GET `/businesses/me`
Returns the logged-in business owner's own row (404 if this user doesn't own a business — use that to decide whether to show a business dashboard at all).

### PUT `/businesses/:slug` — full profile editor
Partial update, all fields optional:

| Field | Tier | Notes |
|---|---|---|
| `name`, `description`, `address`, `city`, `state`, `zip`, `phone`, `email` | both | address changes silently trigger re-geocoding |
| `website_url`, `about_owner`, `facebook_url`, `instagram_url`, `yelp_url` | both | plain URL fields |
| `story` | **premium only** | long-form business story, up to 5000 chars |
| `timeline_year_1/2/3`, `timeline_description_1/2/3` | **premium only** | a fixed 3-entry timeline, not an arbitrary list |

**Important for the form:** if a basic-tier business sends any premium-only field, the whole request is rejected with a 403 (not silently dropped). The frontend should hide/disable the `story` and timeline inputs entirely for basic tier and show an upgrade CTA in their place, rather than letting the user fill them out and hit an error on submit.

### PUT `/businesses/:slug/categories` — replace-all semantics
Body: `{ category_ids: [1, 2, 3] }` — this becomes the business's complete category set (min 1, max 20). Build as a multi-select against `GET /categories`. A business must always keep at least one category, since `business_categories` is what drives `/search`'s category filter now.

### Services (ownership-enforced)
- `POST /businesses/:slug/services` — body: `name` (1–100), `description` (optional), `category_id` (required — populate the select from `GET /categories`).
- `PUT /businesses/:slug/services/:id` — `name`/`description` optional, but **`category_id` is required even on edit** — always send it.
- `DELETE /businesses/:slug/services/:id` — no body.

### Photos — **read-only from the business dashboard right now**
`GET /businesses/:slug/photos` (public, see §1) is the only photo route currently reachable by a business. Self-service upload/edit/delete routes exist in the codebase but are **disabled on purpose** — Justyce's call, so businesses can't upload off-brand or inappropriate images with no review step. All photo uploads go through the admin side (§7) on the business's behalf. **Don't build an upload button on the business dashboard** — just render whatever admin has uploaded. If this changes later, an approval-queue flow is already wired up server-side (uploads would land as unapproved until admin reviews them), so re-enabling it is a backend flag flip, not a redesign.

### Discounts (ownership-enforced, any tier can create one)
- `POST /businesses/:slug/discounts` — body: `code` (1–50 chars), `description` (1–500), `discount_type` (`percent`|`fixed`), `value` (positive number, percent capped at 100), `starts_at`/`expires_at` (optional dates), `max_redemptions` (optional int), `active` (optional bool, defaults true).
- `PUT /businesses/:slug/discounts/:id` — same fields, all optional.
- `DELETE /businesses/:slug/discounts/:id`.
- These are creation/management only — the business owner never sees redemption codes revealed to customers through this route; that's the separate public+redeem flow in §1/§5.

### POST `/businesses/:slug/discounts/:id/redeem` — the "reveal code" button
Auth: Bearer. This is what a **customer** hits from the discount card on a business's public page, not the business owner. Access is gated on the requesting user's own premium status (a premium user, or a business owner whose own business is premium) — everyone else gets a 403 with `code: "PREMIUM_REQUIRED"`. On success: `data: { code }`. Hitting it again after already redeeming just re-shows the same code (idempotent) rather than erroring — safe to let the button be clicked more than once.

### Analytics
- `POST /businesses/:slug/track` — public, no auth. Body: `{ event_type }` (one of the enum values in §0). Fire-and-forget from button clicks on a business's public page (call button, email link, address/map click, website link, discount reveal). 201 on success — don't block the UI action (opening the phone dialer, navigating to the website) on this call finishing.
- `GET /businesses/:slug/analytics?from&to` — Auth: Bearer, ownership-enforced. Defaults to the last 30 days if `from`/`to` aren't given. `data` shape: `{ "call_click": { "2026-08-01": 3, "2026-08-02": 5 }, "page_view": { ... }, ... }` — one object per event type, keyed by date, ready to feed straight into a chart library (one series per event type, one point per day).

### DELETE `/businesses/:slug`
Auth: Bearer, ownership-enforced. Deletes the business, its services, its photos (DB rows and the actual storage files), the owner's user row, and their login entirely. Irreversible — confirm-dialog this hard, same as the admin delete.

---

## 6. Password Setup Page — Supabase Direct Integration

Unchanged from before, still the piece that makes business signup work end to end. After a business pays (§3), the backend creates their login with a password nobody knows and emails a Supabase recovery link via Resend. That link needs to land on a page in this app that lets them set a real password.

**This page talks directly to Supabase, not the Express API.**

```
npm install @supabase/supabase-js
```
Env vars (public/safe for frontend — never the service role key):
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Behavior at a route like `/reset-password` (the exact production URL needs to be registered as `PASSWORD_RESET_REDIRECT_URL` in the backend env **and** added to Supabase's Auth → URL Configuration → Redirect URLs allowlist):
1. On mount, `supabase.auth.onAuthStateChange` — when `event === 'PASSWORD_RECOVERY'`, show the set-password form; otherwise show an expired/invalid state.
2. Fields: New Password (min 8 chars) + Confirm Password (client-side match check).
3. Submit: `await supabase.auth.updateUser({ password: newPassword })`.
4. Success gives a real working session — redirect straight into the business dashboard, no separate login step.
5. On an expired/used link, tell them to contact support — there's no self-service resend wired up.

This same pattern is reusable later for a normal "forgot password" flow (`supabase.auth.resetPasswordForEmail`) — worth designing with that reuse in mind.

---

## 7. Admin Dashboard Routes
*Auth: Bearer + `account_type: 'admin'` on every route below.*

### Businesses
- `GET /admin/businesses` — paginated (§8), newest first.
- `GET /admin/businesses/:id` — numeric id, not slug.
- `GET /admin/businesses/:id/full` — **the review/detail screen.** One call returns the business row plus its categories, services, and photos together — build the "review this pending business" or "business detail" screen against this, not four separate calls.
- `PATCH /admin/businesses/:id/status` — body: `{ status }`. **Will reject approval (400) if the business has zero categories set** — surface that message clearly rather than a generic failure, since it tells the admin exactly what's blocking approval.
- `PATCH /admin/businesses/:id` — the full-field editor: every profile field from §5's table (admin bypasses the tier gate — can set story/timeline on a basic-tier business), plus `business_tier`, `is_comped`, and a manual `latitude`/`longitude`/`neighborhood` override for addresses geocoding couldn't resolve.
- `PATCH /admin/businesses/:id/pilot` — body: `{ pilot_business: boolean }`. Pure badge/tag, no functional effect elsewhere — a simple toggle switch is enough UI.
- `PATCH /admin/businesses/:id/featured` — body: `{ is_featured: boolean }`. **Only one business can be featured at once** — setting a new one automatically un-features whichever business currently holds that slot. Worth a confirm dialog ("this will remove the current featured business") rather than a bare toggle. Requires premium tier — disable the toggle for basic-tier businesses rather than letting it fail.
- `PATCH /admin/businesses/:id/carousel` — body: `{ in_carousel: boolean }`. Plain toggle, no uniqueness constraint, but still premium-tier-only.
- `PUT /admin/businesses/:id/categories` — same replace-all pattern as the business's own version.
- `DELETE /admin/businesses/:id` — destructive, cascades everything. Hard confirm.

### Business Photos (this is where uploads actually happen)
- `POST /admin/businesses/:id/photos` — **multipart/form-data**, field name `photo` for the file, plus `photo_type` (`listing`|`owner`|`gallery`) and optional `display_order` as form fields. No cap, no tier restriction — admin can upload as many of any type as they want. This needs a real file picker + type selector in the UI, not just a text form.
- `GET /admin/businesses/:id/photos` — every photo for a business regardless of approval state (this is the moderation list).
- `PATCH /admin/photos/:id/approve` — body: `{ approved: boolean }`. Currently a no-op in practice since business self-upload is disabled and admin's own uploads insert as already-approved — but build the approve/unpublish toggle anyway, since it's the exact control a moderation queue needs if self-service uploads get re-enabled later.
- `PUT /admin/photos/:id` — body: `photo_type`, `display_order`, both optional (unlike the disabled business-owner version, admin can change `photo_type` too).
- `DELETE /admin/photos/:id`.

### Discounts (full moderation across every business)
- `GET /admin/discounts` — paginated (§8), all businesses, newest first, each row includes `businesses: { name, slug }`.
- `GET /admin/discounts/:id`, `PUT /admin/discounts/:id`, `DELETE /admin/discounts/:id` — same field shape as the business-owner version.
- `POST /admin/businesses/:id/discounts`, `GET /admin/businesses/:id/discounts` — create/list scoped to one business.

### Analytics
- `GET /admin/businesses/:id/analytics?from&to` — same per-business shape as the business dashboard's own version.
- `GET /admin/analytics` — cross-business overview, last 30 days fixed: `{ totalsByType: { "call_click": 42, ... }, topBusinesses: [{ business: { name, slug }, total: 17 }, ...] }` (top 10). Good for a "most active businesses" leaderboard widget.

### Users
- `GET /admin/users` — paginated (§8), newest first.
- `GET /admin/users/:id` — `:id` is a UUID, not numeric.
- `DELETE /admin/users/:id` — blocks deleting your own admin account or the last remaining admin (400) — surface that message, don't show a generic error.

### Services
- `GET /admin/services` — paginated (§8), joined with `{ businesses: { name, slug } }`.
- `GET /admin/services/:id`, `PUT /admin/services/:id`, `DELETE /admin/services/:id`.

### Categories
- `PUT /admin/categories/:id` — body: `name`, `slug` (must be lowercase-hyphenated, e.g. `home-repair`).
- Create/delete live on the public categories router but are still admin-gated: `POST /categories`, `DELETE /categories/:id`. Delete returns 409 if services are still assigned to that category — surface that message.

### Stats
- `GET /admin/stats` — `data`: `{ totalBusinesses, totalUsers, newSignupsLast24Hours }`. Good for a dashboard summary/overview card.

### Admin dashboard UI shape — what's a display element vs. an interactive control
To save some design back-and-forth, here's the rough split:

**Plain display / read-only:** `id`, `created_at`/`updated_at` timestamps, `stripe_customer_id`/`stripe_subscription_id`, `times_redeemed` on a discount, the aggregate `/full` review screen's categories/services/photos lists (viewed here, edited through their own dedicated routes).

**Toggles/switches:** `pilot_business`, `is_featured`, `is_comped`, `in_carousel`, a photo's `approved` state — all plain booleans, a switch component is enough, no form needed.

**Buttons with a confirm step:** business/user delete (irreversible), discount delete, category delete (can 409 if in use), un-featuring a business by featuring a different one.

**Dropdown/select:** `status` (4 fixed values), `business_tier` (2 values), `discount_type` (2 values), `photo_type` (3 values), `category_id` on a service (populate from `GET /categories`).

**Real forms (text inputs/textareas):** the full business editor (`PATCH /admin/businesses/:id`), discount create/edit, service create/edit, category create/edit.

**File upload widget:** photo upload only, nowhere else.

---

## 8. Pagination — which routes, and how to build against it

These list routes accept optional `?page=&limit=` query params (default `page=1`, `limit=20`, capped at `limit=100`):
- `GET /admin/businesses`
- `GET /admin/discounts`
- `GET /admin/users`
- `GET /admin/services`
- `GET /search`

Every one of them returns the same `pagination` shape alongside `data`:
```json
{ "page": 1, "limit": 20, "total": 47, "totalPages": 3 }
```

**Recommended UI pattern differs by context:**
- **`/search` (public results):** use **infinite scroll** or a **"Load more results"** button. Track a `page` counter client-side, request `page + 1` when the user scrolls near the bottom (or clicks the button), append the new results to what's already rendered, and stop once `page >= totalPages`. This is a consumer-facing browse experience — most people won't want to think about page numbers.
- **Admin tables (`/admin/businesses`, `/admin/discounts`, `/admin/users`, `/admin/services`):** use a **traditional pager** (Prev/Next or numbered pages) instead of infinite scroll. Admin screens are management/data-table contexts where jumping to a specific page, or knowing "page 3 of 12," is more useful than an endless feed — and it keeps the DOM from growing unbounded during a long admin session.

Routes *not* in this list (`GET /businesses`, `GET /services`, `GET /categories`, `GET /businesses/:slug/photos`, discount lists, etc.) still return full unpaginated arrays — fine at current scale, don't build pagination UI against them until the backend adds it.

---

## 9. Terms of Service & Privacy Policy — what needs to be covered

This isn't legal advice — just a factual rundown of what data actually flows through the system, so whoever drafts the real ToS/Privacy Policy (a lawyer, ideally) knows what to cover. The frontend should link to these documents somewhere in the signup flows (business checkout, user signup) and the footer.

**Personal information collected directly:**
- Users: first/last name, email, phone number, password (never stored in plaintext or seen by this backend — Supabase Auth handles hashing).
- Businesses: owner first/last name, business name/description/address/phone/email, and everything in the expanded profile (story, owner bio, social links, timeline) if filled in.

**Location data:** a business's street address is sent to Nominatim (OpenStreetMap's free geocoding service) to resolve latitude/longitude/neighborhood for the "near me" search feature. This means a third party (Nominatim) receives the business address on every create/update. Worth a line in the privacy policy disclosing this specific third-party data flow.

**Payment data:** handled entirely by Stripe — this backend never sees or stores card numbers. Only a Stripe customer id and subscription id are retained, tied to a user or business row.

**Analytics/click tracking:** anonymous by design — `business_analytics_events` records only an event type, a business id, and a timestamp. No user identity, IP, or session is attached to a tracked click (call/email/address/website/discount clicks, page views). Worth stating plainly that this tracking is aggregate and not tied to an individual visitor.

**Discount redemption — the one place tracking isn't anonymous:** `discount_redemptions` ties a specific `user_id` to a specific `discount_id` and timestamp, permanently (this is what enforces "once per user per discount"). This should be disclosed distinctly from the anonymous analytics above — it's a record of "this logged-in person redeemed this specific offer."

**Photos:** uploaded images are stored in Supabase Storage and served from public URLs — anyone with the link can view them, by design (they're meant to appear on public business listings).

**Third-party services this data passes through, worth naming in the policy:**
- Supabase — database, authentication, and file storage
- Stripe — payment processing and subscription billing
- Resend — transactional email (password setup, receipts, welcome emails)
- Nominatim / OpenStreetMap — address geocoding
- Sentry — error monitoring (may capture request details, including parts of a failing request, when the backend hits an unexpected error)

**Cookies/local storage:** whatever the frontend ultimately uses to persist the `access_token` between page loads (localStorage, a cookie, in-memory + refresh flow, etc.) should be disclosed in the policy once that decision is made — this doc doesn't dictate that choice.

---

## 10. Known Gaps — don't design around these yet
- **No refresh tokens.** Sessions just expire and force a re-login (§0).
- **Business self-service photo upload is disabled**, admin-only for now (§5).
- **No automated tests** on the backend — manual QA against these routes is the current safety net, so flag anything that behaves unexpectedly rather than assuming it's a known, accepted quirk.
- **CORS allowlist** needs a backend-side update any time a new frontend domain is added.
