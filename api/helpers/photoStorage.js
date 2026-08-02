// helpers/photoStorage.js
import crypto from 'crypto';
import { supabaseAdmin } from '../dbconnect.js';
import { AppError } from './AppError.js';

// Create this bucket in the Supabase dashboard (Storage -> New bucket) before
// this feature can work: name it exactly this (or set SUPABASE_PHOTOS_BUCKET
// in the env to override), and mark it Public — these routes always upload
// through supabaseAdmin (service role), which bypasses storage RLS regardless,
// but a public bucket is what lets the stored photo_url actually be viewable
// by anyone without an auth header, which is what a public listing page needs.
const BUCKET_NAME = process.env.SUPABASE_PHOTOS_BUCKET || 'business-photos';

const EXTENSION_BY_MIME_TYPE = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif'
};

/**
 * Uploads a photo buffer (from multer's memoryStorage) to the business-photos
 * bucket under a per-business folder, and returns both the public URL (what
 * gets stored in photo_url / rendered by the frontend) and the storage path
 * (what deleteBusinessPhotoFile needs later — see migration 022's notes on
 * why that's stored separately rather than parsed back out of the URL).
 *
 * @param {number} businessId
 * @param {{ buffer: Buffer, mimetype: string }} file - req.file from multer
 */
export async function uploadBusinessPhoto(businessId, file) {
    const extension = EXTENSION_BY_MIME_TYPE[file.mimetype] || 'bin';
    const storagePath = `${businessId}/${crypto.randomUUID()}.${extension}`;

    const { error } = await supabaseAdmin.storage
        .from(BUCKET_NAME)
        .upload(storagePath, file.buffer, {
            contentType: file.mimetype,
            upsert: false
        });

    if (error) {
        throw new AppError(`Photo upload failed: ${error.message}`, 500);
    }

    const { data } = supabaseAdmin.storage.from(BUCKET_NAME).getPublicUrl(storagePath);

    return { photoUrl: data.publicUrl, storagePath };
}

/**
 * Deletes a photo from storage given its stored path. Failure here is logged,
 * not thrown — an orphaned storage object is a much smaller problem than a
 * delete request failing after the DB row is already gone (or blocking an
 * insert rollback cleanup), so callers shouldn't have to handle this throwing.
 *
 * @param {string|null|undefined} storagePath
 */
export async function deleteBusinessPhotoFile(storagePath) {
    if (!storagePath) {
        return;
    }

    const { error } = await supabaseAdmin.storage.from(BUCKET_NAME).remove([storagePath]);

    if (error) {
        console.error(`[photoStorage] Failed to delete storage object "${storagePath}":`, error.message);
    }
}
