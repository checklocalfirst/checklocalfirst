// middleware/rateLimiter.js
import rateLimit from 'express-rate-limit';

// General purpose — applies to most routes
export const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 300, // 300 requests per IP per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests, please try again later.' }
});

// Stricter — for auth routes specifically (login, signup)
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10, // only 10 attempts per IP per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many attempts, please try again later.' }
});

// For POST /businesses/:slug/track — public, unauthenticated, writes to the DB
// on every call. This is scoped per-IP, not per-person, so a shared IP (a
// household, an office, a coffee shop's wifi) can legitimately generate a lot
// of real events across several people browsing different businesses at once —
// undercounting real analytics from a too-tight limit is a worse, silent
// failure mode here than allowing a bit more headroom, so this errs generous.
export const trackLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests, please try again shortly.' }
});

// For POST /businesses/:slug/discounts/:id/redeem — authenticated, and spans
// multiple business slugs (a premium user can legitimately redeem discounts at
// several different businesses in one shopping session). The per-user-per-
// discount uniqueness constraint (migration 027) is what actually stops repeat-
// redemption abuse; this is just a generous backstop against a compromised or
// scripted account blitzing through many different discounts at once.
export const redeemLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests, please try again shortly.' }
});