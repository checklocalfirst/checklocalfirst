import express from 'express'
import { supabase, supabaseAdmin } from '../dbconnect.js'
import { authMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { verifyBusinessOwnership } from '../helpers/verifyBusinessOwnership.js';
import { catchAsync } from '../helpers/catchAsync.js';
import { AppError } from '../helpers/AppError.js';
import { geocodeAddress, addressFieldsChanged } from '../helpers/geocode.js';
// uploadSinglePhoto and uploadBusinessPhoto are only used by the commented-out
// self-service photo routes below — deleteBusinessPhotoFile stays imported
// since the business's own account-delete route still uses it for cleanup.
// import { uploadSinglePhoto } from '../middleware/upload.js';
// import { uploadBusinessPhoto } from '../helpers/photoStorage.js';
import { deleteBusinessPhotoFile } from '../helpers/photoStorage.js';
import {
    businessSlugParamSchema,
    updateBusinessSchema,
    updateBusinessCategoriesSchema,
    createServiceSchema,
    updateServiceSchema,
    serviceIdParamSchema,
    // uploadPhotoSchema,
    // updatePhotoSchema,
    // photoIdParamSchema,
    PREMIUM_ONLY_BUSINESS_FIELDS
} from '../schemas/businessSchemas.js';

const router = express.Router()

// Rejects the request outright if a premium-only field (story, timeline) is
// present in the body but the business isn't on the premium tier, rather than
// silently dropping the field — the business owner should know why it didn't save.
function assertPremiumFieldsAllowed(body, businessTier) {
    const attempted = PREMIUM_ONLY_BUSINESS_FIELDS.filter((field) => body[field] !== undefined);

    if (attempted.length > 0 && businessTier !== 'premium') {
        throw new AppError(
            `Upgrade to Premium to set: ${attempted.join(', ')}`,
            403
        );
    }
}

// Only used by the commented-out self-service photo upload route below —
// left in place (not deleted) alongside it for the same reason.
//
// listing/owner: one each, either tier. gallery: premium only, capped at
// SELF_SERVICE_GALLERY_CAP. Basic-tier pages end up with just a storefront +
// owner photo; premium pages add a real gallery on top of those two.
//
// const SELF_SERVICE_GALLERY_CAP = 10;
//
// async function assertPhotoUploadAllowed(businessId, businessTier, photoType) {
//     if (photoType === 'gallery' && businessTier !== 'premium') {
//         throw new AppError('Upgrade to Premium to add gallery photos', 403);
//     }
//
//     const { count, error } = await supabaseAdmin
//         .from('business_photos')
//         .select('*', { count: 'exact', head: true })
//         .eq('business_id', businessId)
//         .eq('photo_type', photoType);
//
//     if (error) {
//         throw new AppError(error.message, 500);
//     }
//
//     const cap = photoType === 'gallery' ? SELF_SERVICE_GALLERY_CAP : 1;
//
//     if (count >= cap) {
//         throw new AppError(
//             photoType === 'gallery'
//                 ? `Gallery is limited to ${SELF_SERVICE_GALLERY_CAP} photos — delete one before adding another`
//                 : `Only one ${photoType} photo allowed — delete the existing one before uploading a new one`,
//             409
//         );
//     }
// }

router.get('/', catchAsync(async (req, res) => {
    const { data, error} = await supabase.from('businesses').select('*').eq('status', 'approved');

    if(error){
        throw new AppError(error.message, 500);
    }

    res.json({ success: true, data });
}))

router.get('/me', authMiddleware, catchAsync(async (req, res) => {
    const { data, error } = await supabaseAdmin.from('businesses').select('*').eq('owner_user_id', req.user.id).single();

    if(error){
        throw new AppError('Business not found', 404);
    }

    res.json({ success: true, data });
}))

// Fixed-path routes must come before /:slug below, or Express (and the businesses
// lookup inside it) would treat "featured"/"carousel" as a slug value instead.
router.get('/featured', catchAsync(async (req, res) => {
    // Only one business can ever be is_featured = true (DB partial unique index),
    // so this is a single object (or null), not a list.
    const { data, error } = await supabase
        .from('businesses')
        .select('*')
        .eq('status', 'approved')
        .eq('is_featured', true)
        .maybeSingle();

    if (error) {
        throw new AppError(error.message, 500);
    }

    res.json({ success: true, data: data ?? null });
}))

router.get('/carousel', catchAsync(async (req, res) => {
    const { data, error } = await supabase
        .from('businesses')
        .select('*')
        .eq('status', 'approved')
        .eq('in_carousel', true);

    if (error) {
        throw new AppError(error.message, 500);
    }

    res.json({ success: true, data });
}))

router.get('/:slug', validate(businessSlugParamSchema), catchAsync(async (req, res) => {
    const { slug } = req.validated.params;
    const { data, error } = await supabase.from('businesses').select('*').eq('slug', slug).eq('status', 'approved').single();

    if(error){
        throw new AppError(error.message, 500);
    }

    res.json({ success: true, data });
}))

router.get('/:slug/services', validate(businessSlugParamSchema), catchAsync(async (req, res) => {
    const { slug } = req.validated.params;

    const {data, error} = await supabase.from('businesses').select('id').eq('slug', slug).single();

    if(error){
        throw new AppError(error.message, 500);
    }

    const businessId = data.id;

    const {data: businessData, error: businessError} = await supabase.from('services').select('*').eq('business_id', businessId);

    if(businessError){
        throw new AppError(businessError.message, 500);
    }

    return res.status(200).json({ success: true, data: businessData });
}))

router.put('/:slug/services/:id', authMiddleware, validate(updateServiceSchema), catchAsync(async (req, res) => {
    const { slug, id } = req.validated.params;
    const { name, description, category_id } = req.validated.body;

    await verifyBusinessOwnership(slug, req.user.id);

    const {data, error} = await supabaseAdmin.from('services').update({name, description, category_id}).eq('id', id);

    if(error){
        throw new AppError(error.message, 500);
    }

    return res.status(200).json({ success: true, message: 'Service for business updated' });
}))

router.post('/:slug/services', authMiddleware, validate(createServiceSchema), catchAsync(async (req, res) => {
    const { slug } = req.validated.params;
    const { name, description, category_id } = req.validated.body;

    const businessData = await verifyBusinessOwnership(slug, req.user.id);

    const {data, error} = await supabaseAdmin.from('services').insert({business_id: businessData.id, name, description, category_id});

    if(error){
        throw new AppError(error.message, 500);
    }

    return res.status(201).json({ success: true, message: 'Service for business added' });
}))

router.delete('/:slug/services/:id', authMiddleware, validate(serviceIdParamSchema), catchAsync(async (req, res) => {
    const { slug, id } = req.validated.params;

    await verifyBusinessOwnership(slug, req.user.id);

    const {data, error} = await supabaseAdmin.from('services').delete().eq('id', id);

    if(error){
        throw new AppError(error.message, 500);
    }

    return res.status(200).json({ success: true, message: 'Service for business deleted' });
}))

router.put('/:slug', authMiddleware, validate(updateBusinessSchema), catchAsync(async (req, res) => {
    const { slug } = req.validated.params;
    const {
        name, description, address, city, state, zip, phone, email,
        website_url, about_owner, facebook_url, instagram_url, yelp_url,
        story,
        timeline_year_1, timeline_description_1,
        timeline_year_2, timeline_description_2,
        timeline_year_3, timeline_description_3
    } = req.validated.body;

    const businessData = await verifyBusinessOwnership(slug, req.user.id);

    assertPremiumFieldsAllowed(req.validated.body, businessData.business_tier);

    // Only re-geocode when address/city/state/zip actually changed in this request —
    // not on every PUT regardless of what fields were sent.
    let geoUpdate = {};
    if (addressFieldsChanged(businessData, { address, city, state, zip })) {
        const geocoded = await geocodeAddress({
            address: address ?? businessData.address,
            city: city ?? businessData.city,
            state: state ?? businessData.state,
            zip: zip ?? businessData.zip
        });

        // Address changed, so any previously-stored coordinates/neighborhood are now
        // stale regardless of whether the new geocode attempt succeeds — null them out
        // on failure rather than leaving old, now-wrong coordinates in place.
        geoUpdate = geocoded
            ? {
                latitude: geocoded.latitude,
                longitude: geocoded.longitude,
                neighborhood: geocoded.neighborhood,
                geocoded_at: new Date().toISOString()
            }
            : { latitude: null, longitude: null, neighborhood: null, geocoded_at: null };
    }

    const {data, error} = await supabaseAdmin.from('businesses').update({
        name, description, address, city, state, zip, phone, email,
        website_url, about_owner, facebook_url, instagram_url, yelp_url,
        story,
        timeline_year_1, timeline_description_1,
        timeline_year_2, timeline_description_2,
        timeline_year_3, timeline_description_3,
        ...geoUpdate
    }).eq('slug', slug);

    if(error){
        throw new AppError(error.message, 500);
    }

    return res.status(200).json({ success: true, message: `${name ?? businessData.name} successfully updated` });
}))

// Replace-all semantics: this becomes the business's complete category set.
// Ownership-enforced, same pattern as the services sub-routes above.
router.put('/:slug/categories', authMiddleware, validate(updateBusinessCategoriesSchema), catchAsync(async (req, res) => {
    const { slug } = req.validated.params;
    const { category_ids } = req.validated.body;

    const businessData = await verifyBusinessOwnership(slug, req.user.id);

    const { error: deleteError } = await supabaseAdmin
        .from('business_categories')
        .delete()
        .eq('business_id', businessData.id);

    if (deleteError) {
        throw new AppError(deleteError.message, 500);
    }

    if (category_ids.length > 0) {
        const rows = category_ids.map((category_id) => ({ business_id: businessData.id, category_id }));
        const { error: insertError } = await supabaseAdmin.from('business_categories').insert(rows);

        if (insertError) {
            throw new AppError(insertError.message, 500);
        }
    }

    return res.status(200).json({ success: true, message: 'Business categories updated' });
}))

// Public — lets the frontend render category badges on a business's own page,
// same "separate sub-route" pattern as /:slug/services rather than embedding
// the join into the main business object.
router.get('/:slug/categories', validate(businessSlugParamSchema), catchAsync(async (req, res) => {
    const { slug } = req.validated.params;

    const { data: business, error: businessError } = await supabase
        .from('businesses')
        .select('id')
        .eq('slug', slug)
        .eq('status', 'approved')
        .single();

    if (businessError) {
        throw new AppError('Business not found', 404);
    }

    const { data, error } = await supabase
        .from('business_categories')
        .select('categories(id, name, slug)')
        .eq('business_id', business.id);

    if (error) {
        throw new AppError(error.message, 500);
    }

    return res.status(200).json({ success: true, data: data.map((row) => row.categories) });
}))

// Business self-service photo upload/reorder/delete — disabled per Justyce's call:
// businesses could otherwise upload inappropriate or off-brand images with no
// review step. All photo uploads currently go through the admin routes in
// admin.js instead (POST/GET /admin/businesses/:id/photos, PUT/DELETE
// /admin/photos/:id), which are unaffected by this and stay fully active.
//
// Left commented rather than deleted: the approval gate below (inserting with
// approved: false, kept invisible from GET /:slug/photos above until admin
// calls PATCH /admin/photos/:id/approve) is already wired up, so re-enabling
// this later — e.g. if a moderation queue makes business uploads safe again —
// is just uncommenting this block, the assertPhotoUploadAllowed helper below,
// and the matching imports at the top of this file.
//
// // multer runs before validate() so req.body already has photo_type/display_order
// // as parsed strings by the time the schema checks them (see middleware/upload.js).
// router.post('/:slug/photos', authMiddleware, uploadSinglePhoto, validate(uploadPhotoSchema), catchAsync(async (req, res) => {
//     const { slug } = req.validated.params;
//     const { photo_type, display_order } = req.validated.body;
//
//     if (!req.file) {
//         throw new AppError('No photo file provided (field name: "photo")', 400);
//     }
//
//     const businessData = await verifyBusinessOwnership(slug, req.user.id);
//
//     await assertPhotoUploadAllowed(businessData.id, businessData.business_tier, photo_type);
//
//     const { photoUrl, storagePath } = await uploadBusinessPhoto(businessData.id, req.file);
//
//     const { data, error } = await supabaseAdmin
//         .from('business_photos')
//         .insert({
//             business_id: businessData.id,
//             photo_url: photoUrl,
//             storage_path: storagePath,
//             photo_type,
//             display_order: display_order ?? 0,
//             approved: false // pending — invisible on GET /:slug/photos until admin approves it
//         })
//         .select()
//         .single();
//
//     if (error) {
//         // Insert failed after the file already landed in storage — clean up the
//         // now-orphaned object rather than leaving it dangling.
//         await deleteBusinessPhotoFile(storagePath);
//         throw new AppError(error.message, 500);
//     }
//
//     return res.status(201).json({ success: true, message: 'Photo uploaded — pending admin approval', data });
// }))
//
// // display_order only — see updatePhotoSchema for why photo_type isn't editable here.
// router.put('/:slug/photos/:id', authMiddleware, validate(updatePhotoSchema), catchAsync(async (req, res) => {
//     const { slug, id } = req.validated.params;
//     const { display_order } = req.validated.body;
//
//     const businessData = await verifyBusinessOwnership(slug, req.user.id);
//
//     const { data, error } = await supabaseAdmin
//         .from('business_photos')
//         .update({ display_order })
//         .eq('id', id)
//         .eq('business_id', businessData.id) // can't touch another business's photo by id
//         .select()
//         .single();
//
//     if (error) {
//         throw new AppError(error.message, 500);
//     }
//
//     if (!data) {
//         throw new AppError('Photo not found', 404);
//     }
//
//     return res.status(200).json({ success: true, message: 'Photo updated', data });
// }))
//
// router.delete('/:slug/photos/:id', authMiddleware, validate(photoIdParamSchema), catchAsync(async (req, res) => {
//     const { slug, id } = req.validated.params;
//
//     const businessData = await verifyBusinessOwnership(slug, req.user.id);
//
//     const { data, error } = await supabaseAdmin
//         .from('business_photos')
//         .delete()
//         .eq('id', id)
//         .eq('business_id', businessData.id)
//         .select()
//         .single();
//
//     if (error) {
//         throw new AppError(error.message, 500);
//     }
//
//     if (!data) {
//         throw new AppError('Photo not found', 404);
//     }
//
//     await deleteBusinessPhotoFile(data.storage_path);
//
//     return res.status(200).json({ success: true, message: 'Photo deleted' });
// }))

// Public — dynamic gallery, not a fixed number of slots. Ordered by
// display_order so the frontend just renders whatever comes back in sequence.
// Only approved photos show here — a business-submitted photo (if that upload
// path is ever re-enabled) sits invisible to the public until admin approves it
// via PATCH /admin/photos/:id/approve; admin's own uploads are auto-approved so
// this filter is a no-op for the admin-only upload flow currently in use.
router.get('/:slug/photos', validate(businessSlugParamSchema), catchAsync(async (req, res) => {
    const { slug } = req.validated.params;

    const { data: business, error: businessError } = await supabase
        .from('businesses')
        .select('id')
        .eq('slug', slug)
        .eq('status', 'approved')
        .single();

    if (businessError) {
        throw new AppError('Business not found', 404);
    }

    const { data, error } = await supabase
        .from('business_photos')
        .select('*')
        .eq('business_id', business.id)
        .eq('approved', true)
        .order('display_order', { ascending: true });

    if (error) {
        throw new AppError(error.message, 500);
    }

    return res.status(200).json({ success: true, data });
}))

router.delete('/:slug', authMiddleware, validate(businessSlugParamSchema), catchAsync(async (req, res) => {
    const { slug } = req.validated.params;

    const businessData = await verifyBusinessOwnership(slug, req.user.id);

    // business_photos rows cascade-delete with the business (FK ON DELETE CASCADE),
    // but the actual files in Supabase Storage don't clean themselves up — fetch
    // their paths first so they can be removed after the DB rows are gone.
    const { data: photos, error: photosError } = await supabaseAdmin
        .from('business_photos')
        .select('storage_path')
        .eq('business_id', businessData.id);

    if (photosError) throw new AppError(photosError.message, 500);

    const {error: servicesError} = await supabaseAdmin.from('services').delete().eq('business_id', businessData.id);
    if(servicesError) throw new AppError(servicesError.message, 500);

    const {error: bizError} = await supabaseAdmin.from('businesses').delete().eq('slug', slug);
    if(bizError) throw new AppError(bizError.message, 500);

    await Promise.all(photos.map((photo) => deleteBusinessPhotoFile(photo.storage_path)));

    const {error: userError} = await supabaseAdmin.from('users').delete().eq('user_id', businessData.owner_user_id);
    if(userError) throw new AppError(userError.message, 500);

    const {error: authError} = await supabaseAdmin.auth.admin.deleteUser(businessData.owner_user_id);
    if(authError) throw new AppError(authError.message, 500);

    return res.status(200).json({ success: true, message: 'Business successfully deleted' });
}))

export default router