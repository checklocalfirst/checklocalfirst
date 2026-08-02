// instrument.js
//
// Must be loaded before any other module — this is what lets Sentry
// auto-instrument Express/HTTP and install global handlers for uncaught
// exceptions and unhandled promise rejections that would otherwise never
// reach errorHandler.js at all. See package.json's "start" script, which runs
// `node --import ./instrument.js server.js` — the ESM equivalent of
// `require("./instrument")` being the first line of a CommonJS entry file.
import * as Sentry from '@sentry/node';

Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    dataCollection: {
        // Uncomment to stop sending user data and HTTP bodies:
        // userInfo: false,
        // httpBodies: [],
    },
});
