import express from 'express'
import { supabaseAdmin, supabase } from '../dbconnect.js'
import { authMiddleware, authAdminMiddleware } from '../middleware/auth.js'
import { validate } from '../middleware/validate.js'
import {
    businessIdParamSchema,
    userIdParamSchema,
    updateBusinessStatusSchema,
    adminServiceIdParamSchema,
    adminUpdateServiceSchema,
    adminUpdateBusinessSchema,
    updatePilotStatusSchema,
    adminUpdateBusinessCategoriesSchema,
    updateFeaturedStatusSchema,
    updateCarouselStatusSchema,
    adminUploadPhotoSchema,
    adminUpdatePhotoSchema,
    adminPhotoIdParamSchema,
    updatePhotoApprovalSchema
} from '../schemas/adminSchemas.js'
import { categoryIdParamSchema, updateCategorySchema } from '../schemas/categorySchemas.js'
import { catchAsync } from '../helpers/catchAsync.js';
import { AppError } from '../helpers/AppError.js';
import { geocodeAddress, addressFieldsChanged } from '../helpers/geocode.js';
import { uploadSinglePhoto } from '../middleware/upload.js';
import { uploadBusinessPhoto, deleteBusinessPhotoFile } from '../helpers/photoStorage.js';
import {
    adminCreateDiscountSchema,
    adminUpdateDiscountSchema,
    adminDiscountIdParamSchema
} from '../schemas/discountSchemas.js'
import { adminBusinessAnalyticsSchema } from '../schemas/analyticsSchemas.js'
import { aggregateEventsByTypeAndDay } from '../helpers/analytics.js';
import { parsePagination, buildPaginationMeta } from '../helpers/pagination.js';

const router = express.Router()

router.use(authMiddleware, authAdminMiddleware);


router.get('/businesses', catchAsync(async (req, res) => {
    const { page, limit, from, to } = parsePagination(req.query);

    const { data, error, count } = await supabaseAdmin
        .from('businesses')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

    if(error){
        throw new AppError(error.message, 500);
    }

    res.status(200).json({ success: true, data, pagination: buildPaginationMeta({ page, limit, total: count }) });
}))

router.get('/businesses/:id', validate(businessIdParamSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;

    const { data, error } = await supabaseAdmin.from('businesses').select('*').eq('id', id).single();

    if(error){
        throw new AppError(error.message, 500);
    }

    res.status(200).json({ success: true, data });
}))

router.patch('/businesses/:id/status', validate(updateBusinessStatusSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;
    const { status } = req.validated.body;

    // A business must have at least one category before it can be approved —
    // otherwise it'd go live invisible to category-based browse/search, the
    // primary discovery path. Only checked on the way to 'approved'; pending/
    // suspended/rejected don't care about completeness.
    if (status === 'approved') {
        const { data: business, error: businessError } = await supabaseAdmin
            .from('businesses')
            .select('id')
            .eq('id', id)
            .single();

        if (businessError || !business) {
            throw new AppError('Business not found', 404);
        }

        const { count, error: countError } = await supabaseAdmin
            .from('business_categories')
            .select('*', { count: 'exact', head: true })
            .eq('business_id', id);

        if (countError) {
            throw new AppError(countError.message, 500);
        }

        if (!count) {
            throw new AppError('Cannot approve business: at least one category must be set first', 400);
        }
    }

    const { data, error } = await supabaseAdmin.from('businesses').update({status}).eq('id', id).select().single();

    if(error){
        throw new AppError(error.message, 500);
    }

    if(!data){
        throw new AppError('Business not found', 404);
    }

    return res.status(200).json({ success: true, message: 'Business status updated' });
}))

// Full-field editor — everything short of `status` (that stays on its own route
// above since it's a distinct approve/suspend workflow). Admin is never tier-gated
// here: it can set story/timeline on a basic business, same pattern as
// is_featured/in_carousel already being admin-only togglable regardless of tier.
router.patch('/businesses/:id', validate(adminUpdateBusinessSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;
    const {
        name, description, address, city, state, zip, phone, email,
        business_tier, is_comped,
        website_url, about_owner, facebook_url, instagram_url, yelp_url,
        story,
        timeline_year_1, timeline_description_1,
        timeline_year_2, timeline_description_2,
        timeline_year_3, timeline_description_3,
        latitude, longitude, neighborhood
    } = req.validated.body;

    const { data: existing, error: existingError } = await supabaseAdmin
        .from('businesses')
        .select('address, city, state, zip')
        .eq('id', id)
        .single();

    if (existingError || !existing) {
        throw new AppError('Business not found', 404);
    }

    // Manual override takes priority: if admin explicitly supplies coordinates,
    // use them directly and skip the Nominatim call entirely (this is the
    // stopgap path for addresses geocoding can't resolve on its own). Otherwise,
    // only re-geocode if the address actually changed in this request.
    let geoUpdate = {};

    if (latitude !== undefined || longitude !== undefined) {
        geoUpdate = {
            ...(latitude !== undefined ? { latitude } : {}),
            ...(longitude !== undefined ? { longitude } : {}),
            ...(neighborhood !== undefined ? { neighborhood } : {}),
            geocoded_at: new Date().toISOString()
        };
    } else if (addressFieldsChanged(existing, { address, city, state, zip })) {
        const geocoded = await geocodeAddress({
            address: address ?? existing.address,
            city: city ?? existing.city,
            state: state ?? existing.state,
            zip: zip ?? existing.zip
        });

        geoUpdate = geocoded
            ? {
                latitude: geocoded.latitude,
                longitude: geocoded.longitude,
                neighborhood: geocoded.neighborhood,
                geocoded_at: new Date().toISOString()
            }
            : { latitude: null, longitude: null, neighborhood: null, geocoded_at: null };
    } else if (neighborhood !== undefined) {
        // Neighborhood-only correction, no coordinate change requested.
        geoUpdate = { neighborhood };
    }

    const { data, error } = await supabaseAdmin
        .from('businesses')
        .update({
            name, description, address, city, state, zip, phone, email,
            business_tier, is_comped,
            website_url, about_owner, facebook_url, instagram_url, yelp_url,
            story,
            timeline_year_1, timeline_description_1,
            timeline_year_2, timeline_description_2,
            timeline_year_3, timeline_description_3,
            ...geoUpdate
        })
        .eq('id', id)
        .select()
        .single();

    if (error) {
        throw new AppError(error.message, 500);
    }

    if (!data) {
        throw new AppError('Business not found', 404);
    }

    return res.status(200).json({ success: true, message: 'Business updated successfully', data });
}))

// Pure badge, no functional gating — see migration 015.
router.patch('/businesses/:id/pilot', validate(updatePilotStatusSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;
    const { pilot_business } = req.validated.body;

    const { data, error } = await supabaseAdmin
        .from('businesses')
        .update({ pilot_business })
        .eq('id', id)
        .select()
        .single();

    if (error) {
        throw new AppError(error.message, 500);
    }

    if (!data) {
        throw new AppError('Business not found', 404);
    }

    return res.status(200).json({ success: true, message: `Pilot status ${pilot_business ? 'granted' : 'revoked'}` });
}))

// Only one business can be featured at a time (DB partial unique index on
// is_featured) and featuring requires premium tier (DB check constraint) — the
// tier check here gives a clear error message rather than surfacing a raw
// constraint-violation code. Un-featuring is a plain single-row update since it
// can't collide with the uniqueness constraint; featuring goes through the
// set_featured_business() RPC so the old featured business is unset and the new
// one is set atomically, with no window where zero or two are featured at once.
router.patch('/businesses/:id/featured', validate(updateFeaturedStatusSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;
    const { is_featured } = req.validated.body;

    const { data: business, error: businessError } = await supabaseAdmin
        .from('businesses')
        .select('id, business_tier')
        .eq('id', id)
        .single();

    if (businessError || !business) {
        throw new AppError('Business not found', 404);
    }

    if (is_featured) {
        if (business.business_tier !== 'premium') {
            throw new AppError('Only Premium-tier businesses can be featured', 400);
        }

        const { data, error } = await supabaseAdmin.rpc('set_featured_business', { target_business_id: id });

        if (error) {
            throw new AppError(error.message, 500);
        }

        return res.status(200).json({ success: true, message: 'Business is now featured', data: data?.[0] ?? null });
    }

    const { data, error } = await supabaseAdmin
        .from('businesses')
        .update({ is_featured: false, featured_since: null })
        .eq('id', id)
        .select()
        .single();

    if (error) {
        throw new AppError(error.message, 500);
    }

    return res.status(200).json({ success: true, message: 'Business removed from featured', data });
}))

// No uniqueness constraint on in_carousel (unlike featured), so this is a plain
// toggle — still tier-gated the same way, since the DB's carousel_requires_premium
// check constraint would reject it anyway for a basic-tier business.
router.patch('/businesses/:id/carousel', validate(updateCarouselStatusSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;
    const { in_carousel } = req.validated.body;

    const { data: business, error: businessError } = await supabaseAdmin
        .from('businesses')
        .select('id, business_tier')
        .eq('id', id)
        .single();

    if (businessError || !business) {
        throw new AppError('Business not found', 404);
    }

    if (in_carousel && business.business_tier !== 'premium') {
        throw new AppError('Only Premium-tier businesses can be added to the carousel', 400);
    }

    const { data, error } = await supabaseAdmin
        .from('businesses')
        .update({ in_carousel })
        .eq('id', id)
        .select()
        .single();

    if (error) {
        throw new AppError(error.message, 500);
    }

    return res.status(200).json({
        success: true,
        message: `Business ${in_carousel ? 'added to' : 'removed from'} the carousel`,
        data
    });
}))

// Replace-all semantics, same as the business-owner version in businesses.js —
// admin can set any business's categories regardless of ownership.
router.put('/businesses/:id/categories', validate(adminUpdateBusinessCategoriesSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;
    const { category_ids } = req.validated.body;

    const { data: business, error: businessError } = await supabaseAdmin
        .from('businesses')
        .select('id')
        .eq('id', id)
        .single();

    if (businessError || !business) {
        throw new AppError('Business not found', 404);
    }

    const { error: deleteError } = await supabaseAdmin
        .from('business_categories')
        .delete()
        .eq('business_id', id);

    if (deleteError) {
        throw new AppError(deleteError.message, 500);
    }

    if (category_ids.length > 0) {
        const rows = category_ids.map((category_id) => ({ business_id: id, category_id }));
        const { error: insertError } = await supabaseAdmin.from('business_categories').insert(rows);

        if (insertError) {
            throw new AppError(insertError.message, 500);
        }
    }

    return res.status(200).json({ success: true, message: 'Business categories updated' });
}))

router.get('/businesses/:id/categories', validate(businessIdParamSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;

    const { data, error } = await supabaseAdmin
        .from('business_categories')
        .select('categories(id, name, slug)')
        .eq('business_id', id);

    if (error) {
        throw new AppError(error.message, 500);
    }

    return res.status(200).json({ success: true, data: data.map((row) => row.categories) });
}))

// Aggregate read route — everything about one business in a single call, for
// review screens (e.g. the pending-approval view) that need to judge whether a
// business is "complete" without stitching together 3+ separate requests.
// Read-only: editing still goes through the focused routes above (PATCH
// /businesses/:id, PUT /businesses/:id/categories, the services routes, etc.).
router.get('/businesses/:id/full', validate(businessIdParamSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;

    const { data: business, error: businessError } = await supabaseAdmin
        .from('businesses')
        .select('*')
        .eq('id', id)
        .single();

    if (businessError || !business) {
        throw new AppError('Business not found', 404);
    }

    const [
        { data: categoryRows, error: categoriesError },
        { data: services, error: servicesError },
        { data: photos, error: photosError }
    ] = await Promise.all([
        supabaseAdmin.from('business_categories').select('categories(id, name, slug)').eq('business_id', id),
        supabaseAdmin.from('services').select('*').eq('business_id', id),
        supabaseAdmin.from('business_photos').select('*').eq('business_id', id).order('display_order', { ascending: true })
    ]);

    if (categoriesError) {
        throw new AppError(categoriesError.message, 500);
    }

    if (servicesError) {
        throw new AppError(servicesError.message, 500);
    }

    if (photosError) {
        throw new AppError(photosError.message, 500);
    }

    return res.status(200).json({
        success: true,
        data: {
            business,
            categories: categoryRows.map((row) => row.categories),
            services,
            photos
        }
    });
}))

// Admin upload — no cap, no tier restriction, any photo_type, on behalf of any
// business (see businesses.js for the self-service version's tier gating/caps).
router.post('/businesses/:id/photos', uploadSinglePhoto, validate(adminUploadPhotoSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;
    const { photo_type, display_order } = req.validated.body;

    if (!req.file) {
        throw new AppError('No photo file provided (field name: "photo")', 400);
    }

    const { data: business, error: businessError } = await supabaseAdmin
        .from('businesses')
        .select('id')
        .eq('id', id)
        .single();

    if (businessError || !business) {
        throw new AppError('Business not found', 404);
    }

    const { photoUrl, storagePath } = await uploadBusinessPhoto(id, req.file);

    const { data, error } = await supabaseAdmin
        .from('business_photos')
        .insert({
            business_id: id,
            photo_url: photoUrl,
            storage_path: storagePath,
            photo_type,
            display_order: display_order ?? 0,
            approved: true // admin IS the moderator — no separate approval step for admin's own uploads
        })
        .select()
        .single();

    if (error) {
        await deleteBusinessPhotoFile(storagePath);
        throw new AppError(error.message, 500);
    }

    return res.status(201).json({ success: true, message: 'Photo uploaded', data });
}))

// Admin sees every photo regardless of approval status — that's the point,
// this is the review list a moderation queue would be built against.
router.get('/businesses/:id/photos', validate(businessIdParamSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;

    const { data, error } = await supabaseAdmin
        .from('business_photos')
        .select('*')
        .eq('business_id', id)
        .order('display_order', { ascending: true });

    if (error) {
        throw new AppError(error.message, 500);
    }

    return res.status(200).json({ success: true, data });
}))

// Separate toggle route rather than folding `approved` into the general PUT
// below, matching the pilot/featured/carousel pattern already used elsewhere —
// this is the route a moderation-queue UI would call to approve or unpublish a
// pending business-submitted photo (currently only relevant if the commented-out
// self-service upload routes in businesses.js get re-enabled; admin's own
// uploads are already approved: true at insert time above).
router.patch('/photos/:id/approve', validate(updatePhotoApprovalSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;
    const { approved } = req.validated.body;

    const { data, error } = await supabaseAdmin
        .from('business_photos')
        .update({ approved })
        .eq('id', id)
        .select()
        .single();

    if (error) {
        throw new AppError(error.message, 500);
    }

    if (!data) {
        throw new AppError('Photo not found', 404);
    }

    return res.status(200).json({ success: true, message: `Photo ${approved ? 'approved' : 'unpublished'}`, data });
}))

router.put('/photos/:id', validate(adminUpdatePhotoSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;
    const { photo_type, display_order } = req.validated.body;

    const { data, error } = await supabaseAdmin
        .from('business_photos')
        .update({ photo_type, display_order })
        .eq('id', id)
        .select()
        .single();

    if (error) {
        throw new AppError(error.message, 500);
    }

    if (!data) {
        throw new AppError('Photo not found', 404);
    }

    return res.status(200).json({ success: true, message: 'Photo updated', data });
}))

router.delete('/photos/:id', validate(adminPhotoIdParamSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;

    const { data, error } = await supabaseAdmin
        .from('business_photos')
        .delete()
        .eq('id', id)
        .select()
        .single();

    if (error) {
        throw new AppError(error.message, 500);
    }

    if (!data) {
        throw new AppError('Photo not found', 404);
    }

    await deleteBusinessPhotoFile(data.storage_path);

    return res.status(200).json({ success: true, message: 'Photo deleted' });
}))

// DISCOUNTS — full moderation/CRUD across every business's discounts.
router.post('/businesses/:id/discounts', validate(adminCreateDiscountSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;
    const { code, description, discount_type, value, starts_at, expires_at, max_redemptions, active } = req.validated.body;

    const { data: business, error: businessError } = await supabaseAdmin
        .from('businesses')
        .select('id')
        .eq('id', id)
        .single();

    if (businessError || !business) {
        throw new AppError('Business not found', 404);
    }

    const { data, error } = await supabaseAdmin
        .from('discounts')
        .insert({
            business_id: id,
            code,
            description,
            discount_type,
            value,
            starts_at,
            expires_at,
            max_redemptions,
            active: active ?? true
        })
        .select()
        .single();

    if (error) {
        throw new AppError(error.message, 500);
    }

    return res.status(201).json({ success: true, message: 'Discount created', data });
}))

router.get('/businesses/:id/discounts', validate(businessIdParamSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;

    const { data, error } = await supabaseAdmin
        .from('discounts')
        .select('*')
        .eq('business_id', id)
        .order('created_at', { ascending: false });

    if (error) {
        throw new AppError(error.message, 500);
    }

    return res.status(200).json({ success: true, data });
}))

router.get('/discounts', catchAsync(async (req, res) => {
    const { page, limit, from, to } = parsePagination(req.query);

    const { data, error, count } = await supabaseAdmin
        .from('discounts')
        .select('*, businesses(name, slug)', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

    if (error) {
        throw new AppError(error.message, 500);
    }

    return res.status(200).json({ success: true, data, pagination: buildPaginationMeta({ page, limit, total: count }) });
}))

router.get('/discounts/:id', validate(adminDiscountIdParamSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;

    const { data, error } = await supabaseAdmin
        .from('discounts')
        .select('*, businesses(name, slug)')
        .eq('id', id)
        .single();

    if (error || !data) {
        throw new AppError('Discount not found', 404);
    }

    return res.status(200).json({ success: true, data });
}))

router.put('/discounts/:id', validate(adminUpdateDiscountSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;
    const { code, description, discount_type, value, starts_at, expires_at, max_redemptions, active } = req.validated.body;

    const { data, error } = await supabaseAdmin
        .from('discounts')
        .update({ code, description, discount_type, value, starts_at, expires_at, max_redemptions, active })
        .eq('id', id)
        .select()
        .single();

    if (error) {
        throw new AppError(error.message, 500);
    }

    if (!data) {
        throw new AppError('Discount not found', 404);
    }

    return res.status(200).json({ success: true, message: 'Discount updated', data });
}))

router.delete('/discounts/:id', validate(adminDiscountIdParamSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;

    const { data, error } = await supabaseAdmin
        .from('discounts')
        .delete()
        .eq('id', id)
        .select()
        .single();

    if (error) {
        throw new AppError(error.message, 500);
    }

    if (!data) {
        throw new AppError('Discount not found', 404);
    }

    return res.status(200).json({ success: true, message: 'Discount deleted' });
}))

// ANALYTICS
router.get('/businesses/:id/analytics', validate(adminBusinessAnalyticsSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;
    const { from, to } = req.validated.query;

    const rangeStart = from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rangeEnd = to ?? new Date();

    const { data, error } = await supabaseAdmin
        .from('business_analytics_events')
        .select('event_type, created_at')
        .eq('business_id', id)
        .gte('created_at', rangeStart.toISOString())
        .lte('created_at', rangeEnd.toISOString());

    if (error) {
        throw new AppError(error.message, 500);
    }

    return res.status(200).json({ success: true, data: aggregateEventsByTypeAndDay(data) });
}))

// Cross-business overview — total events by type plus a simple "most active
// businesses" leaderboard, both over the last 30 days.
router.get('/analytics', catchAsync(async (req, res) => {
    const rangeStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabaseAdmin
        .from('business_analytics_events')
        .select('business_id, event_type, businesses(name, slug)')
        .gte('created_at', rangeStart);

    if (error) {
        throw new AppError(error.message, 500);
    }

    const totalsByType = {};
    const totalsByBusiness = new Map();

    for (const event of data) {
        totalsByType[event.event_type] = (totalsByType[event.event_type] ?? 0) + 1;

        if (!totalsByBusiness.has(event.business_id)) {
            totalsByBusiness.set(event.business_id, { business: event.businesses, total: 0 });
        }
        totalsByBusiness.get(event.business_id).total += 1;
    }

    const topBusinesses = Array.from(totalsByBusiness.values())
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);

    return res.status(200).json({
        success: true,
        data: { totalsByType, topBusinesses }
    });
}))

router.delete('/businesses/:id', validate(businessIdParamSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;

    const { data: businessData, error: businessError } = await supabaseAdmin.from('businesses').select('owner_user_id').eq('id', id).single();

    if(businessError || !businessData){
        throw new AppError('Business not found', 404);
    }

    // business_photos rows cascade-delete with the business (FK ON DELETE CASCADE),
    // but the actual files in Supabase Storage don't clean themselves up.
    const { data: photos, error: photosError } = await supabaseAdmin
        .from('business_photos')
        .select('storage_path')
        .eq('business_id', id);

    if (photosError) {
        throw new AppError(photosError.message, 500);
    }

    const { error: bizError } = await supabaseAdmin.from('businesses').delete().eq('id', id);
    if(bizError){
        throw new AppError(bizError.message, 500);
    }

    await Promise.all(photos.map((photo) => deleteBusinessPhotoFile(photo.storage_path)));

    if(businessData.owner_user_id){
        const { error: userError } = await supabaseAdmin.from('users').delete().eq('user_id', businessData.owner_user_id);
        if(userError){
            throw new AppError(userError.message, 500);
        }

        const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(businessData.owner_user_id);
        if(authError){
            throw new AppError(authError.message, 500);
        }
    }

    return res.status(200).json({ success: true, message: 'Business successfully deleted' });
}))

router.get('/users', catchAsync(async (req, res) => {
    const { page, limit, from, to } = parsePagination(req.query);

    const { data, error, count } = await supabaseAdmin
        .from('users')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

    if(error){
        throw new AppError(error.message, 500);
    }

    res.status(200).json({ success: true, data, pagination: buildPaginationMeta({ page, limit, total: count }) });
}))

router.get('/users/:id', validate(userIdParamSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;

    const { data, error } = await supabaseAdmin.from('users').select('*').eq('user_id', id).single();

    if(error){
        throw new AppError(error.message, 500);
    }

    res.status(200).json({ success: true, data });
}))

router.delete('/users/:id', validate(userIdParamSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;

    if (id === req.user.id) {
        throw new AppError('You cannot delete your own admin account', 400);
    }

    const { data: targetUser, error: targetError } = await supabaseAdmin
        .from('users')
        .select('account_type')
        .eq('user_id', id)
        .single();

    if (targetError || !targetUser) {
        throw new AppError('User not found', 404);
    }

    if (targetUser.account_type === 'admin') {
        const { count, error: countError } = await supabaseAdmin
            .from('users')
            .select('*', { count: 'exact', head: true })
            .eq('account_type', 'admin');

        if (countError) {
            throw new AppError(countError.message, 500);
        }

        if (count <= 1) {
            throw new AppError('Cannot delete the last remaining admin account', 400);
        }
    }

    const { error: userError } = await supabaseAdmin.from('users').delete().eq('user_id', id);
    if (userError) {
        throw new AppError(userError.message, 500);
    }

    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(id);
    if (authError) {
        throw new AppError(authError.message, 500);
    }

    return res.status(200).json({ success: true, message: 'User successfully deleted' });
}))


// SERVICES

router.get('/services', catchAsync(async (req, res) => {
    const { page, limit, from, to } = parsePagination(req.query);

    const { data, error, count } = await supabaseAdmin
        .from('services')
        .select('*, businesses(name, slug)', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

    if(error){
        throw new AppError(error.message, 500);
    }

    res.status(200).json({ success: true, data, pagination: buildPaginationMeta({ page, limit, total: count }) });
}))

router.get('/services/:id', validate(adminServiceIdParamSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;

    const { data, error } = await supabaseAdmin
        .from('services')
        .select('*, businesses(name, slug)')
        .eq('id', id)
        .single();

    if(error){
        throw new AppError('Service not found', 404);
    }

    res.status(200).json({ success: true, data });
}))

router.put('/services/:id', validate(adminUpdateServiceSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;
    const { name, description, category_id } = req.validated.body;

    const { data, error } = await supabaseAdmin
        .from('services')
        .update({ name, description, category_id })
        .eq('id', id)
        .select()
        .single();

    if(error){
        throw new AppError(error.message, 500);
    }

    if(!data){
        throw new AppError('Service not found', 404);
    }

    return res.status(200).json({ success: true, message: 'Service updated successfully' });
}))

router.delete('/services/:id', validate(adminServiceIdParamSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;

    const { data, error } = await supabaseAdmin
        .from('services')
        .delete()
        .eq('id', id)
        .select()
        .single();

    if(error){
        throw new AppError(error.message, 500);
    }

    if(!data){
        throw new AppError('Service not found', 404);
    }

    return res.status(200).json({ success: true, message: 'Service deleted successfully' });
}))


// CATEGORIES

router.put('/categories/:id', validate(updateCategorySchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;
    const { name, slug } = req.validated.body;

    const { data, error } = await supabaseAdmin
        .from('categories')
        .update({ name, slug })
        .eq('id', id)
        .select()
        .single();

    if(error){
        throw new AppError(error.message, 500);
    }

    if(!data){
        throw new AppError('Category not found', 404);
    }

    return res.status(200).json({ success: true, message: 'Category updated successfully' });
}))


router.get('/stats', catchAsync(async (req, res) => {
    const { count: totalBusinesses, error: businessError } = await supabaseAdmin.from('businesses').select('*', { count: 'exact', head: true });

    if(businessError){
        throw new AppError(businessError.message, 500);
    }

    const { count: totalUsers, error: userError } = await supabaseAdmin.from('users').select('*', { count: 'exact', head: true });

    if(userError){
        throw new AppError(userError.message, 500);
    }

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { count: newSignups, error: signupError } = await supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).gte('created_at', twentyFourHoursAgo);

    if(signupError){
        throw new AppError(signupError.message, 500);
    }

    return res.status(200).json({
        success: true,
        data: {
            totalBusinesses,
            totalUsers,
            newSignupsLast24Hours: newSignups
        }
    });
}))



export default router