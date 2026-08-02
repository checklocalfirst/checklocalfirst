import express from 'express'
import businessRouter from './routes/businesses.js'
import userRouter from './routes/users.js'
import categoryRouter from './routes/categories.js'
import serviceRouter from './routes/services.js'
import searchRouter from './routes/search.js'
import authRouter from './routes/auth.js'
import favoriteRouter from './routes/favorites.js'
import adminRouter from './routes/admin.js'
import landingRouter from './routes/signups.js'
import stripeRouter from './routes/stripe.js'
import cors from 'cors'
import { errorHandler } from './middleware/errorHandler.js'
import { generalLimiter } from './middleware/rateLimiter.js'
import helmet from 'helmet'
import stripeWebhookRouter from './routes/stripeWebhook.js'
import { AppError } from './helpers/AppError.js'

// Locked down from wide-open per the hardening pass — your own readme flags
// "no hardcodings," so the actual allowlist lives in ALLOWED_ORIGINS (comma-
// separated) rather than baked into this file. The fallback list below is just
// what works out of the box if that env var isn't set yet: your production
// domain (both with and without www, since a browser's Origin header could
// reflect either depending on how someone reached the site) and your current
// Vercel testing domain. Add ALLOWED_ORIGINS to your env once you're ready to
// stop relying on the fallback — e.g. to add a localhost dev origin without a
// code change.
const DEFAULT_ALLOWED_ORIGINS = [
    'https://www.checklocalfirst.com',
    'https://checklocalfirst.com',
    'https://clf-frontend.vercel.app',
    'https://localhost:3000',
    'localhost:3000'
];

const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim())
    : DEFAULT_ALLOWED_ORIGINS;

const app = express()
app.set('trust proxy', 1)
app.use(cors({
    origin: (origin, callback) => {
        // No Origin header at all means this isn't a browser request (server-to-
        // server, curl, Postman, the Stripe webhook, etc.) — CORS only ever
        // applies to browsers, so there's nothing to restrict here.
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
    }
}))
app.use(generalLimiter)
app.use(helmet())

app.use('/stripe/webhook', stripeWebhookRouter)

app.use(express.json())

app.get('/', (req, res) => {
    res.send('Check Local First API');
})

app.use('/businesses', businessRouter)
app.use('/users', userRouter)
app.use('/services', serviceRouter)
app.use('/categories', categoryRouter)
app.use('/search', searchRouter)
app.use('/auth', authRouter)
app.use('/favorites', favoriteRouter)
app.use('/admin', adminRouter)
app.use('/landing', landingRouter)
app.use('/stripe', stripeRouter)

app.use((req, res, next) => {
    next(new AppError(`Route not found: ${req.originalUrl}`, 404));
});

app.use(errorHandler)


// Render (and most hosts) assign the port dynamically via process.env.PORT —
// binding to a hardcoded port instead can break or silently misbehave in
// production. Falls back to 3000 for local dev where PORT isn't set.
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
})