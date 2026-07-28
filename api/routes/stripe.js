import { stripe } from "../stripeconnect.js";
import express from 'express'
import { validate } from '../middleware/validate.js';
import { businessCheckoutSchema, premiumUserCheckoutSchema, premiumUserCancelSchema, recoveryLinkQuerySchema } from '../schemas/stripeSchemas.js';
import { businessSlugParamSchema } from '../schemas/businessSchemas.js';
import { catchAsync } from '../helpers/catchAsync.js';
import { AppError } from '../helpers/AppError.js';
import { supabaseAdmin } from "../dbconnect.js";
import { authMiddleware } from "../middleware/auth.js";
import { verifyBusinessOwnership } from '../helpers/verifyBusinessOwnership.js';

const router = express.Router();

router.get('/', catchAsync(async (req, res) => {
    return res.status(200).json({ success: true, message: 'Stripe route' });
}))

router.post('/signup/business/checkout', validate(businessCheckoutSchema), catchAsync(async (req, res) => {
    const { name, description, address, email, phone, state, city, zip, firstname, lastname, business_tier } = req.validated.body;

    const { data: existingUser } = await supabaseAdmin
        .from('users')
        .select('user_id')
        .eq('email', email)
        .single();

    if (existingUser) {
        throw new AppError('An account with this email already exists', 409);
    }

    const priceId = business_tier === 'premium'
        ? process.env.STRIPE_PREMIUM_BUSINESS_PRICE
        : process.env.STRIPE_BASIC_BUSINESS_PRICE;

    const customer = await stripe.customers.create({
        email: email,
        name: name,
        metadata: {
            signup_type: 'business',
            business_name: name,
            business_description: description || '',
            business_address: address,
            business_phone: phone,
            business_state: state,
            business_city: city,
            business_zip: zip,
            owner_firstname: firstname,
            owner_lastname: lastname,
            business_tier: business_tier,
        }
    });

    const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: priceId }],
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        expand: ['latest_invoice.confirmation_secret'],
    });

    const clientSecret = subscription.latest_invoice.confirmation_secret.client_secret;

    return res.status(200).json({
        success: true,
        data: {
            client_secret: clientSecret,
            customer_id: customer.id,
        }
    });
}))

// No auth possible here — the Supabase Auth user doesn't exist (and there's no token to issue)
// until the webhook creates it. Trust boundary is the Stripe customer_id itself: it's an
// opaque, non-sequential ID only the checkout response ever revealed to this specific caller.
// Poll this after payment confirms. Returns { ready: false } until the webhook has created the
// business row; once it has, generates a fresh single-use Supabase recovery link so the owner
// can set their own password instead of the random one the webhook assigned. This is a stand-in
// for emailing that link once Resend/DNS is live — same underlying Supabase mechanism either way.
router.get('/signup/business/recovery-link', validate(recoveryLinkQuerySchema), catchAsync(async (req, res) => {
    const { customer_id } = req.validated.query;

    const { data: business } = await supabaseAdmin
        .from('businesses')
        .select('email')
        .eq('stripe_customer_id', customer_id)
        .single();

    if (!business) {
        return res.status(200).json({ success: true, data: { ready: false } });
    }

    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
        type: 'recovery',
        email: business.email,
        options: {
            // Without this, Supabase falls back to whatever "Site URL" is configured in the
            // dashboard (Authentication -> URL Configuration) — which is what silently sent
            // the last test to a blank localhost tab. This must also be added to that project's
            // Redirect URLs allow-list, or Supabase ignores redirectTo and falls back anyway.
            redirectTo: process.env.RESET_PASSWORD_URL,
        },
    });

    if (linkError) {
        throw new AppError(linkError.message, 500);
    }

    return res.status(200).json({
        success: true,
        data: { ready: true, recovery_link: linkData.properties.action_link },
    });
}));

// routes/stripe.js — add this route
router.post('/premium-user/checkout', authMiddleware, validate(premiumUserCheckoutSchema), catchAsync(async (req, res) => {
    const { data: userData, error: userError } = await supabaseAdmin
        .from('users')
        .select('email, first_name, last_name, is_premium, stripe_customer_id')
        .eq('user_id', req.user.id)
        .single();

    if (userError || !userData) {
        throw new AppError('User not found', 404);
    }

    if (userData.is_premium) {
        throw new AppError('You already have premium access', 409);
    }

    // Reuse existing Stripe customer if one exists (e.g. from a prior attempt), otherwise create one
    let customerId = userData.stripe_customer_id;

    if (!customerId) {
        const customer = await stripe.customers.create({
            email: userData.email,
            name: `${userData.first_name} ${userData.last_name}`,
            metadata: {
                signup_type: 'user_premium',
                user_id: req.user.id,
            }
        });
        customerId = customer.id;
    }

    const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: process.env.STRIPE_PREMIUM_USER_PRICE }],
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        expand: ['latest_invoice.confirmation_secret'],
    });

    const clientSecret = subscription.latest_invoice.confirmation_secret.client_secret;

    return res.status(200).json({
        success: true,
        data: {
            client_secret: clientSecret,
            customer_id: customerId,
        }
    });
}))

// Basic -> Premium business tier upgrade. Charges the prorated difference immediately
// against the subscription's saved payment method. business_tier itself is NOT flipped
// here — the webhook (invoice.payment_succeeded, billing_reason 'subscription_update')
// is the source of truth, same pattern as signup. This route just tells Stripe to make
// the change and reports whether the charge went through.
router.post('/business/:slug/upgrade', authMiddleware, validate(businessSlugParamSchema), catchAsync(async (req, res) => {
    const { slug } = req.validated.params;

    const business = await verifyBusinessOwnership(slug, req.user.id);

    if (business.business_tier === 'premium') {
        throw new AppError('Business is already on the Premium tier', 409);
    }

    if (business.is_comped) {
        throw new AppError('Comped accounts must start billing before upgrading tiers', 400);
    }

    if (!business.stripe_subscription_id) {
        throw new AppError('No active subscription found for this business', 400);
    }

    const subscription = await stripe.subscriptions.retrieve(business.stripe_subscription_id);
    const subscriptionItemId = subscription.items.data[0].id;

    try {
        // error_if_incomplete: if the immediate proration charge fails or needs 3DS,
        // Stripe throws here and does NOT apply the price change — no rollback needed.
        await stripe.subscriptions.update(business.stripe_subscription_id, {
            items: [{ id: subscriptionItemId, price: process.env.STRIPE_PREMIUM_BUSINESS_PRICE }],
            proration_behavior: 'always_invoice',
            payment_behavior: 'error_if_incomplete',
        });
    } catch (err) {
        if (err.type === 'StripeCardError') {
            throw new AppError(`Upgrade payment failed: ${err.message}`, 402);
        }
        throw new AppError(err.message, 500);
    }

    return res.status(200).json({
        success: true,
        message: 'Upgrade payment confirmed — Premium tier will be reflected shortly',
    });
}));

// Cancels at the end of the current billing period (not immediately) so the business
// keeps its current tier/access until the period they already paid for runs out.
// The webhook (customer.subscription.deleted) sets status: 'suspended' once it actually lapses.
router.post('/business/:slug/cancel', authMiddleware, validate(businessSlugParamSchema), catchAsync(async (req, res) => {
    const { slug } = req.validated.params;

    const business = await verifyBusinessOwnership(slug, req.user.id);

    if (business.is_comped) {
        throw new AppError('Comped accounts do not have a billed subscription to cancel', 400);
    }

    if (!business.stripe_subscription_id) {
        throw new AppError('No active subscription found for this business', 400);
    }

    const subscription = await stripe.subscriptions.update(business.stripe_subscription_id, {
        cancel_at_period_end: true,
    });

    return res.status(200).json({
        success: true,
        message: 'Subscription will cancel at the end of the current billing period',
        data: { cancel_at: new Date(subscription.cancel_at * 1000).toISOString() },
    });
}));

// Same cancel-at-period-end pattern for premium users. Webhook flips is_premium: false
// once the subscription actually ends.
router.post('/premium-user/cancel', authMiddleware, validate(premiumUserCancelSchema), catchAsync(async (req, res) => {
    const { data: user, error } = await supabaseAdmin
        .from('users')
        .select('is_premium, is_comped, stripe_subscription_id')
        .eq('user_id', req.user.id)
        .single();

    if (error || !user) {
        throw new AppError('User not found', 404);
    }

    if (!user.is_premium) {
        throw new AppError('You do not have an active premium subscription', 400);
    }

    if (user.is_comped) {
        throw new AppError('Comped accounts do not have a billed subscription to cancel', 400);
    }

    if (!user.stripe_subscription_id) {
        throw new AppError('No active subscription found', 400);
    }

    const subscription = await stripe.subscriptions.update(user.stripe_subscription_id, {
        cancel_at_period_end: true,
    });

    return res.status(200).json({
        success: true,
        message: 'Premium will cancel at the end of the current billing period',
        data: { cancel_at: new Date(subscription.cancel_at * 1000).toISOString() },
    });
}));

export default router