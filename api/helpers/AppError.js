// utils/AppError.js
export class AppError extends Error {
    // `code` is an optional machine-readable string (e.g. 'PREMIUM_REQUIRED') for
    // cases where the frontend needs to key off something more specific than the
    // human-readable message — see errorHandler.js for how it's surfaced.
    constructor(message, statusCode, code) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = true;
        this.code = code;
        Error.captureStackTrace(this, this.constructor);
    }
}