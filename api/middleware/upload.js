// middleware/upload.js
import multer from 'multer';
import { AppError } from '../helpers/AppError.js';

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const upload = multer({
    storage: multer.memoryStorage(), // never touches disk — buffer goes straight to Supabase Storage
    limits: { fileSize: MAX_FILE_SIZE_BYTES },
    fileFilter: (req, file, cb) => {
        if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
            return cb(new AppError('Only JPEG, PNG, WebP, or GIF images are allowed', 400));
        }
        cb(null, true);
    }
}).single('photo');

/**
 * Wraps multer's middleware so its own errors (file too large, wrong type)
 * come out as AppError with a real status code instead of falling through to
 * the generic 500 the global error handler gives anything without
 * `isOperational` set. fileFilter above already passes an AppError straight
 * through; this only needs to translate multer's own thrown errors (like
 * LIMIT_FILE_SIZE, which fileFilter never sees).
 */
export function uploadSinglePhoto(req, res, next) {
    upload(req, res, (err) => {
        if (!err) {
            return next();
        }

        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return next(new AppError(`File too large — max ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB`, 400));
            }
            return next(new AppError(err.message, 400));
        }

        next(err);
    });
}
