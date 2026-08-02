// middleware/errorHandler.js
import * as Sentry from '@sentry/node';

export function errorHandler(err, req, res, next) {
    const statusCode = err.statusCode || 500;
    const message = err.isOperational ? err.message : 'Something went wrong';

    console.error(err);

    // Only report genuine failures (500s) to Sentry — not routine 4xx business
    // logic like validation errors, not-found, or PREMIUM_REQUIRED, which are
    // expected control flow, not bugs. Reporting those too would just bury real
    // errors in noise and burn through Sentry's free-tier quota for nothing.
    if (statusCode >= 500) {
        Sentry.captureException(err);
    }

    const response = { success: false, error: message };

    // Only ever surface `code` from operational (AppError) errors, matching how
    // `message` itself is already gated — never leak internals off an
    // unexpected/programmer error.
    if (err.isOperational && err.code) {
        response.code = err.code;
    }

    return res.status(statusCode).json(response);
}