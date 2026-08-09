# CHECK LOCAL FIRST REPO

- Github repository for the online digital local directory business in Reno Nevada made by Tessa Miller and programmed by Justyce Hickman

# Repo Breakdown


## API Folder

- Contains all of the logic for interacting with supabase, queries to supabase, sign up users, sign up businesses, use stripe payments, use resend for email services, geocode business addresses, upload business photos, and track errors through sentry.

- Uses middleware, helpers, routes, and schema architecture to separate code concerns, uses zod validation on every route body/params/query, uses express rate limit to slow requests down (different limits for general traffic vs auth vs the public tracking/redeem endpoints)

- Utilizes server.js for hosting the main server, utilizes sub routes in routes folder for specific tasks like users and auth, businesses, services, categories, search, favorites, admin, landing signups, and stripe/stripe webhook

- Dbconnect.js utilizes dotenv to pull from a .env file and specify the special keys for connecting to supabase client (one anon client for public reads, one service-role client for anything that writes or touches sensitive data, bypassing RLS since the app layer already checks permissions itself)

- Stripe and supabase files use dotenv to do the same

- instrument.js sets up Sentry error monitoring, has to load before everything else in server.js does (loaded via the `--import` flag in the start script, not a normal import) — only real 500-level errors get reported, not routine validation/not-found stuff

### NPM libraries

├── @sentry/node
├── @supabase/supabase-js
├── cors
├── dotenv
├── express-rate-limit
├── express
├── helmet
├── multer
├── resend
├── stripe
└── zod

Supabase js is primarily used for connecting to the supabase client we store all of our real info at

Dotenv is used for loading env files to keep secrets safe

Cors is for cross origin resource sharing, locked down to an actual allowlist of our real frontend domains now, not wide open

Express rate limit to limit api calls

Express for the server

Helmet for protection

Zod for validation

Stripe for payments

Resend for sending emails (password setup links, receipts, welcome emails) through the business/user signup flows

Multer for handling photo uploads (multipart form data) before they get pushed into supabase storage

Sentry for catching real errors in production instead of finding out from an angry email


## DATABASE Folder

- Specifies the base schema for users, businesses, services, and categories as well as functions and triggers for updating them

- Specifies seed.sql for uploading basic info into the tables for businesses

- Contains migrations showing how we updated the database overtime — up to migration 032 now, covering geolocation columns, the pilot business flag, the expanded profile fields (owner bio, socials, timeline), multi-category businesses, featured/carousel support, business photos (including timeline photos), discounts + redemption tracking (including a per-redemption "used" flag), and analytics events (including social link clicks)




## Project Tech Stack breakdown

### Next.js and TS frontend

### Render on the backend hosting a express server for hosting API on checklocalfirst.render.com for managing all API requests

### Resend for email sending and confirmation emails, will work in unison with supabase and render and namecheap dns

### Supabase is postgresql relational database for holding all the data for API use to show on frontend also supports user auth and can use a smtp for email through resend

### Stripe for payments



### Current setup

- Files on github
When finished with internship allow github to be accessed or transfer ownership over to 
checklocalfirst@gmail.com

- API on onrender
Currently on my email but will setup on checklocalfirst@gmail.com email
simply use this api file
configure envs to match what the code says
Buy the cheapest plan to ensure 0 api downtime for website 7.99


- Frontend on vercel
Original frontend host was wix, we changed to vercel and next.js react framework with html css, js, etc
Transfer email to checklocalfirst@gmail.com on vercel
Also changed to use namecheap


- DNS host
Started off with wix but transfered to namecheap hosting, 
setting it up on checklocalfirstgmail so no problems there


### Important things to not forget

- Ensure no hardcodings in backend routes or frontend routes

- Ensure all accounts and emails with software are linked to checklocalfirst

- Reset envs to ensure security

- Make sure SENTRY_DSN is set in Render's env vars (not just locally) or error monitoring silently does nothing in production

- Render's start command needs to be `npm start` (not just `node server.js`) since Sentry has to load before anything else does

- If a new frontend domain ever gets added (staging, a new preview link, whatever) it has to get added to ALLOWED_ORIGINS in Render's env or it'll get blocked by CORS

### Features built (Phase 2)

Everything below is live and working, not just planned anymore:

- Geolocation on businesses (lat/long/neighborhood), auto-filled through Nominatim/OpenStreetMap when an address is added or changed, with a backfill script for the businesses that existed before this

- Pilot business flag/badge for internal tracking, admin can toggle it

- Expanded business profile — website, owner bio, a 3-entry timeline (text + an optional photo per entry), and social links (facebook/instagram/yelp). Timeline is premium-tier only, everything else is open to both tiers

- Businesses can belong to multiple categories now (separate from how individual services are tagged), and this is what search's category filter actually uses

- Full business + admin dashboard parity — admin can edit basically every field on any business regardless of tier, not just approve/suspend

- Reworked search — text search, category filter, and now real location/radius filtering with distance shown on results, plus a separate autocomplete/suggestions endpoint for the search bar

- Photo upload wired up to supabase storage (business_photos table + an actual storage bucket) — currently admin-only, business self-upload is built but intentionally turned off so nothing inappropriate goes up without a review step

- Discount system — businesses can create discounts, anyone can see the metadata on the business page, but only premium users (or business owners on a premium plan) can actually reveal the redemption code, tracked per-user so nobody can redeem the same code twice

- Analytics tracking — anonymous click tracking on business pages (calls, page views, address clicks, website clicks, discount reveals), business owners and admin can both pull aggregated stats

- Featured business + homepage carousel management, admin-controlled, both premium-tier only

- Pagination on the bigger list routes (admin tables + search) so things don't fall over once there's actually a lot of businesses in the directory

- Sentry error monitoring wired in, so a real crash in production shows up on a dashboard instead of nobody knowing until a business emails asking why something's broken

- General hardening pass — locked down CORS to our real domains, fixed a missing RLS policy on business photos, cleaned up a redundant unpaid business-signup route, closed a gap that could've let someone redeem the same discount more than once, and fixed the backend to actually use Render's assigned port instead of a hardcoded one

### Still on the list

- No refresh tokens yet — sessions just expire after about an hour and force a re-login, fine for now but a rough edge later

- No automated tests — everything's been tested manually against the actual frontend instead

- Still need a real privacy policy and terms of service written up covering the location data, analytics, and discount redemption tracking now happening

- Confirm supabase's backup/point-in-time recovery setup is actually something we can rely on if something ever goes wrong

- Updated readme

