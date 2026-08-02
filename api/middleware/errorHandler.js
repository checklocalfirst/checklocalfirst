// middleware/errorHandler.js
export function errorHandler(err, req, res, next) {
    const statusCode = err.statusCode || 500;
    const message = err.isOperational ? err.message : 'Something went wrong';

    console.error(err);

    const response = { success: false, error: message };

    // Only ever surface `code` from operational (AppError) errors, matching how
    // `message` itself is already gated — never leak internals off an
    // unexpected/programmer error.
    if (err.isOperational && err.code) {
        response.code = err.code;
    }

    return res.status(statusCode).json(response);
}