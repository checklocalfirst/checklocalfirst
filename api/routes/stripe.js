import { stripe } from "../stripeconnect.js";
import express from 'express'
import { validate } from '../middleware/validate.js';
import { businessCheckoutSchema, premiumUserCheckoutSchema } from '../schemas/stripeSchemas.js';
import { catchAsync } from '../helpers/catchAsync.js';
import { AppError } from '../helpers/AppError.js';
import { supabaseAdmin } from "../dbconnect.js";
import { authMiddleware } from "../middleware/auth.js";

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

export default router