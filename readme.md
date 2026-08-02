# CHECK LOCAL FIRST REPO

- Github repository for the online digital local directory business in Reno Nevada made by Tessa Miller and programmed by Justyce Hickman

# Repo Breakdown


## API Folder

- Contains all of the logic for interacting with supabase, queries to supabase, sign up users, sign up businesses, use stripe payments, use resend for email services.

- Uses middleware, helpers, routes, and schema architecture to separate code concerns, uses zod validation, uses express rate limit to slow request

- Utilizes server.js for hosting the main server, utilizes sub routes in routes folder for specific task like users and auth, businesses, services, categories etc. 

- Dbconnect.js utilizes dotenv to pull from a .env file and specify the special keys for connecting to supabase client

- Stripe and supabase files use dotenv to do the same

### NPM libraries

├── @supabase/supabase-js@2.106.2
├── cors@2.8.6
├── dotenv@17.4.2
├── express-rate-limit@8.6.0
├── express@5.2.1
├── helmet@8.3.0
├── stripe@22.3.2
└── zod@4.4.3

Supabase js is primarily used for connecting to the supabase client we store all of our real info at

Dotenv is used for loading env files to keep secrets safe

Cors is for cross origin resource sharing

Express rate limit to limit api calls

Express for the server

Helmet for protection

Zod for validation

Stripe for payments


## DATABASE Folder

- Specifies the base schema for users, businesses, services, and categories as well as functions and triggers for updating them

- Specifies seed.sql for uploading basic info into the tables for businesses

- Contains migrations showing how we updated the database overtime




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

### Features to implement

- Analytic tracking on business button clicks for calls, individual page listing, and maybe even address, and website clicks

- Make a admin dashboard for tessa to access to be able to CRUD all users and businesses and services and categories and even more functions for managing everything including featured businesses, carousel, photo upload and more

- Implement photo upload routes to work with supabase

- Discount integrations using business dashboard to show a discount

- Build the backend routes and edit the current tables to make discount generation and tracking for users and businesses

- Implement carousel photos for main page dynamically and user dashboard

- Implement geo info

- Upgrade search route





