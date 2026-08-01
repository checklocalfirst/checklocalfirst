# CheckLocalFirst API Reference — for Frontend Build
*For the frontend design agent. Covers every live backend route as of Jul 30, 2026, plus the new password-setup email flow.*

---

## 0. Conventions (read this first)

**Base URL:** all paths below are relative to the API base, e.g. `https://<your-render-host>` in production or `http://localhost:3000` locally. Store this as `NEXT_PUBLIC_API_BASE_URL` — never hardcode it.

**Auth header:** any route marked "Auth: Bearer" needs `Authorization: Bearer <access_token>`, where `access_token` comes from the login response (see 2.2). No refresh-token flow exists yet — when the token expires the user just has to log in again.

**Content-Type:** `application/json` on every request with a body, except the Stripe webhook (server-to-server only, not a frontend concern).

**Success envelope** (almost every route):
```json
{ "success": true, "data": { /* or array */ } }
```
or for actions with no payload:
```json
{ "success": true, "message": "Human readable message" }
```

**Error envelope** — two shapes depending on where the failure happens, handle both:

Validation failure (zod, 400):
```json
{ "success": false, "error": "Validation failed", "details": { "fieldErrors": { "email": ["Invalid email address"] } } }
```
Everything else (business logic, 401/403/404/409/500):
```json
{ "success": false, "error": "Human readable message" }
```
**One inconsistency to code around:** `authMiddleware`/`authAdminMiddleware` failures (missing/bad token, not an admin) return `{ "error": "message" }` — no `success` key. Check for the presence of `data`/`success` rather than assuming `success` is always in the payload.

**Rate limits:** general routes allow 100 requests/15min per IP; `/auth/signup/*` and `/auth/login` allow only 10/15min per IP. A limit hit returns 429 with `{ success: false, error: "Too many requests..." }` — show a friendly "slow down, try again shortly" state rather than a generic error.

**CORS:** currently open to all origins (no allowlist configured yet), so this won't block you in dev. Expect this to get locked down before launch — not a frontend concern now.

**Enum fields you'll render/filter by:**
- `users.account_type`: `user` | `business` | `admin`
- `businesses.status`: `pending` | `approved` | `suspended` | `rejected` (only `approved` businesses show up in public browse/search)
- `businesses.business_tier`: `basic` | `premium`
- `landing_signups.source`: `Instagram` | `TikTok` | `Google` | `Facebook` | `Good ol' fashioned word of mouth` (exact strings, case-sensitive)

---

## 1. Public / Directory Routes (no auth)

### GET `/businesses`
List all approved businesses. No params, no pagination yet (small dataset).
Response `data`: array of business objects — `id, owner_user_id, name, description, address, city, state, zip, phone, email, slug, status, business_tier, is_comped, is_featured, featured_since, in_carousel, created_at, updated_at`.

### GET `/businesses/:slug`
Single approved business by slug. 404 if not found or not approved.

### GET `/businesses/:slug/services`
All services for that business. `data`: array of `{ id, business_id, category_id, name, description, created_at, updated_at }`.

### GET `/categories`
All categories. `data`: array of `{ id, name, slug }`.

### GET `/services`
All services across approved businesses, joined with business name/slug. `data`: array of service objects with an extra `businesses: { name, slug }` field.

### GET `/search?q=<text>&category=<slug>`
Both params optional but at least one should be present (empty query with no category just returns `{ data: [] }`). `q` is free text, `category` is a category **slug**, not id. Response groups results by business:
```json
{
  "success": true,
  "data": [
    {
      "business": { "id": 1, "name": "...", "slug": "...", "...": "..." },
      "bestMatch": { /* first matching service */ },
      "matchingServices": [ /* all matching services at this business */ ],
      "matchCount": 2
    }
  ]
}
```
Search runs three passes server-side (full-text → partial match → fuzzy) transparently — the frontend doesn't need to know which one fired, just render whatever comes back. No geolocation/distance filtering yet — that's a later phase, don't build "near me" UI against this route yet.

### POST `/landing`
Waitlist/landing page signup form.

| field | type | required | notes |
|---|---|---|---|
| name | string | yes | 1–100 chars |
| email | string | yes | valid email, must be unique or you'll get a 409 |
| source | enum | yes | one of the exact strings listed in section 0 — build this as a select, not free text |

---

## 2. Auth Routes

### 2.1 POST `/auth/signup/user`
Free user account signup (not business, not paid).

| field | type | required | notes |
|---|---|---|---|
| firstname | string | yes | 1–100 chars |
| lastname | string | yes | 1–100 chars |
| email | string | yes | valid email |
| password | string | yes | min 8 chars — user chooses this themselves |
| phone | string | no | exactly 10 digits, no dashes/spaces/parens |

201 on success, no auto-login — send them to the login page after signup.

### 2.2 POST `/auth/login`

| field | type | required |
|---|---|---|
| email | string | yes |
| password | string | yes |

Response `data`: `{ access_token, user_id, email, accountType }`. Store `access_token` (e.g. in memory + httpOnly-safe storage strategy of your choice) and use it as the Bearer token everywhere else. Use `accountType` to route them to the right dashboard (`user` / `business` / `admin`).

### 2.3 POST `/auth/logout`
Auth: Bearer. No body. Clears the Supabase session server-side; clear your stored token client-side too.

### 2.4 POST `/auth/signup/business` — **hold off on building this one**
This creates a business account directly, no payment required. It technically works, but it's redundant with the Stripe checkout signup flow below (2.5/3.1) which is meant to be the actual paid front door for businesses. Don't build a form against this route until Justyce confirms whether it stays, becomes admin-only, or gets removed — use the Stripe checkout flow (section 3.1) for the real "become a business" signup form.

### 2.5 Admin account-creation routes — **do not build UI for these**
`POST /auth/admin/create-user/:account_type`, `POST /auth/admin/create-comped-user`, `POST /auth/admin/create-comped-business` all exist and work (Auth: Bearer + admin), but they're internal tooling — the admin manually sets the password and relays it out of band. These are staying off the dashboard for now, per Justyce. Skip them entirely when building the admin panel.

---

## 3. Business Signup & Billing (Stripe)

### 3.1 POST `/stripe/signup/business/checkout` — **this is the real business signup form**
No auth (this creates the account). Returns a Stripe client_secret to mount Stripe's payment element — this route does NOT create the account immediately; the account is created by the backend webhook only after payment succeeds.

| field | type | required | notes |
|---|---|---|---|
| name | string | yes | business name, 1–100 chars |
| description | string | no | |
| address | string | yes | |
| email | string | yes | business email, must not already exist (409 if taken) |
| phone | string | yes | 10 digits |
| state | string | yes | 2-letter code |
| city | string | yes | |
| zip | string | yes | 5 digits |
| firstname | string | yes | owner's first name |
| lastname | string | yes | owner's last name |
| business_tier | enum | yes | `basic` or `premium` — build this as a plan picker |
| coupon_code | string | no | Stripe promotion code, validated server-side |

Response `data`: `{ client_secret, customer_id, discount_applied }`. Use `client_secret` with Stripe.js/Elements to collect payment. **There is no password field here** — the owner doesn't set a password at signup. Once payment succeeds, the backend webhook creates their login and emails them a "set your password" link (see section 5). Make this clear in the UI: "Check your email after payment to set up your login."

### 3.2 POST `/stripe/premium-user/checkout`
Auth: Bearer. Upgrades an existing free user account to premium. No body needed. Response `data`: `{ client_secret, customer_id }` — same Stripe Elements pattern. This is an upgrade path, not signup — only show it to logged-in free users, gated behind a "Go Premium" button.

### 3.3 POST `/stripe/business/:slug/upgrade`
Auth: Bearer (must own the business). No body. Charges the prorated difference immediately for a basic → premium upgrade. Handle the 409 case ("already premium") and 402 (card declined) distinctly in the UI.

### 3.4 POST `/stripe/business/:slug/cancel`
Auth: Bearer (must own the business). No body. Cancels at period end, not immediately. Response includes `cancel_at` — show the user when access actually ends.

### 3.5 POST `/stripe/premium-user/cancel`
Auth: Bearer. No body. Same cancel-at-period-end pattern for user premium.

---

## 4. Authenticated Account Routes

### 4.1 GET `/users/me`
Auth: Bearer. Returns the logged-in user's full row.

### 4.2 PUT `/users/me`
Auth: Bearer. Partial update — send only changed fields.

| field | type | notes |
|---|---|---|
| first_name | string | optional |
| last_name | string | optional |
| email | string | optional, valid email |
| phone | string | optional, 10 digits |

### 4.3 GET `/businesses/me`
Auth: Bearer. Returns the logged-in business owner's own business row (404 if this user doesn't own a business — use that to decide whether to show a business dashboard at all).

### 4.4 PUT `/businesses/:slug`
Auth: Bearer (must own it — enforced server-side, 403 if not). Partial update, all fields optional: `name, description, address, city, state, zip, phone, email`.

### 4.5 Business's own services (Auth: Bearer, ownership enforced server-side)
- `POST /businesses/:slug/services` — body: `name` (required, 1–100), `description` (optional), `category_id` (required, positive integer — fetch the category list from `GET /categories` for a select dropdown).
- `PUT /businesses/:slug/services/:id` — body: `name` (optional), `description` (optional), `category_id` (**required even on edit** — always send it, don't omit).
- `DELETE /businesses/:slug/services/:id` — no body.

### 4.6 Favorites (Auth: Bearer, user-facing "save this business" feature)
- `GET /favorites` — `data`: array of `{ ...favorite row, businesses: { ...full business object } }`.
- `POST /favorites` — body: `{ business_id: <int> }`.
- `DELETE /favorites/:business_id` — no body, `business_id` in the URL.

---

## 5. Password Setup Page — Supabase Direct Integration

**This is the piece you need to build for Phase 1 to actually work end to end.** After a business finishes paying (section 3.1), the backend creates their login with a password nobody knows, generates a Supabase recovery link, and emails it to them via Resend. Clicking that link needs to land on a page in this app that lets them set a real password.

**Important:** this page talks **directly to Supabase**, not to our Express API. There's no backend route involved here at all once the email is sent.

### Setup
```
npm install @supabase/supabase-js
```
Env vars needed (all public/safe for frontend — do NOT use the service role key here, that's backend-only):
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the anon/publishable key from the Supabase project — same project the backend uses)

Create a client (e.g. `lib/supabaseClient.js`):
```js
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)
```

### The page itself — build it at a route like `/reset-password`
This exact URL (full production URL) needs to be given back to Justyce — it has to be set as `PASSWORD_RESET_REDIRECT_URL` in the backend's env **and** added to Supabase's Authentication → URL Configuration → Redirect URLs allowlist, or the link will fail to redirect here. Coordinate that before this goes live.

Behavior:
1. On mount, subscribe to auth state: `supabase.auth.onAuthStateChange((event, session) => { ... })`. When `event === 'PASSWORD_RECOVERY'`, the visitor arrived via a valid link — show the form. Otherwise (direct nav, expired link) show an error/expired state instead of the form.
2. Form fields: **New Password** (min 8 chars — match the backend's password rule for consistency) and **Confirm Password** (must match New Password client-side before submitting).
3. On submit: `await supabase.auth.updateUser({ password: newPassword })`.
4. On success: the user now has a working session (this is a real session, not a temporary one) — redirect straight into their business dashboard, no separate login step needed.
5. On error (expired/used link): show a message telling them the link expired and to contact support for a new one — there's no self-service "resend" button wired up yet.

This same page/pattern can be reused later for a normal "forgot password" flow on the login page (calling `supabase.auth.resetPasswordForEmail(email, { redirectTo })` directly from the frontend, no backend route needed) — worth designing with that reuse in mind, but not required for Phase 1.

---

## 6. Admin Dashboard Routes
*Auth: Bearer + the logged-in user must have `account_type: 'admin'` on every route below.*

### Businesses
- `GET /admin/businesses` — all businesses, any status, newest first.
- `GET /admin/businesses/:id` — single business by numeric id (not slug).
- `PATCH /admin/businesses/:id/status` — body: `{ status: "pending" | "approved" | "suspended" | "rejected" }`. This is how admin approves a new signup or suspends someone.
- `DELETE /admin/businesses/:id` — deletes the business, its services (cascade), and the owner's user account + auth login. This is destructive and irreversible — confirm-dialog it hard.

### Users
- `GET /admin/users` — all users, newest first.
- `GET /admin/users/:id` — `:id` is a UUID, not numeric.
- `DELETE /admin/users/:id` — blocks deleting your own admin account or the last remaining admin (409/400 with a message — surface it, don't just show a generic error).

### Services
- `GET /admin/services` — all services, joined with `{ businesses: { name, slug } }`.
- `GET /admin/services/:id`
- `PUT /admin/services/:id` — body: `name`, `description`, `category_id` all optional.
- `DELETE /admin/services/:id`

### Categories
- `PUT /admin/categories/:id` — body: `name` (optional, 1–100 chars), `slug` (optional, must be lowercase-hyphenated, e.g. `home-repair`).
- Category **create/delete** aren't under `/admin` — they're on the public categories router but still admin-gated: `POST /categories` and `DELETE /categories/:id` (Auth: Bearer + admin). Body for create: `{ name, slug }` (slug must match the lowercase-hyphen pattern). Delete returns 409 if services are still assigned to that category — surface that message rather than a generic failure.

### Stats
- `GET /admin/stats` — `data`: `{ totalBusinesses, totalUsers, newSignupsLast24Hours }`. Good for a dashboard summary/overview card.

---

## 7. Not Built Yet — don't design UI against these

These are on the backend roadmap but have no routes yet. Don't wire up forms/pages expecting them; ask before assuming a shape:
- Business photo upload/gallery (table exists, no upload route or storage wiring yet)
- Featured business / homepage carousel management (DB columns exist, no admin route to toggle them yet, no public endpoint to fetch carousel businesses yet)
- Discounts (nothing built yet — no table, no routes)
- Analytics/click tracking (nothing built yet)
- Geolocation-based "near me" search (no lat/lng columns yet, current `/search` is text-only)

If you need placeholder UI for any of these while backend catches up, flag it rather than guessing the API shape.
