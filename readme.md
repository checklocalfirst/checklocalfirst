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

### Current setup

- Files on github

- API on render

- Frontend on vercel

- DNS host is namecheap

- Error monitoring on sentry

- Payment handling on stripe

- Database on supabase

- Email service on resend
