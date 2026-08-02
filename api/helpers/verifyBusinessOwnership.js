// helpers/verifyBusinessOwnership.js
import { supabase, supabaseAdmin } from '../dbconnect.js';
import { AppError } from './AppError.js';

export async function verifyBusinessOwnership(slug, userId) {
    const { data: businessData, error: businessError } = await supabaseAdmin
        .from('businesses')
        .select('owner_user_id, id, business_tier, stripe_subscription_id, is_comped, address, city, state, zip')
        .eq('slug', slug)
        .single();

    if (businessError || !businessData) {
        throw new AppError('Business not found', 404);
    }

    if (userId !== businessData.owner_user_id) {
        throw new AppError('Unauthorized: you do not own this business', 403);
    }

    return businessData;
}