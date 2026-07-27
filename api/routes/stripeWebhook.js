// routes/stripeWebhook.js
import express from 'express';
import { stripe } from '../stripeconnect.js';
import { supabaseAdmin } from '../dbconnect.js';
import { AppError } from '../helpers/AppError.js';
import { catchAsync } from '../helpers/catchAsync.js';

const router = express.Router();

router.post('/', express.raw({ type: 'application/json' }), catchAsync(async (req, res) => {
    const signature = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        throw new AppError(`Webhook signature verification failed: ${err.message}`, 400);
    }

    if (event.type === 'invoice.payment_succeeded') {
        const invoice = event.data.object;
        const customerId = invoice.customer;

        // Idempotency check — has this customer already been turned into a business?
        const { data: existingBusiness } = await supabaseAdmin
            .from('businesses')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .single();

        if (existingBusiness) {
            // Already processed this customer — acknowledge and exit, don't create a duplicate
            return res.status(200).json({ received: true });
        }

        const customer = await stripe.customers.retrieve(customerId);
        const metadata = customer.metadata;

        if (metadata.signup_type === 'business') {
            const subscriptionId = invoice.subscription;

            const randomPassword = crypto.randomUUID() + crypto.randomUUID();

            const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
                email: customer.email,
                password: randomPassword,
                email_confirm: true,
                user_metadata: { firstname: metadata.owner_firstname, lastname: metadata.owner_lastname }
            });

            if (authError) {
                throw new AppError(authError.message, 500);
            }

            const { error: userError } = await supabaseAdmin.from('users').insert({
                user_id: authData.user.id,
                first_name: metadata.owner_firstname,
                last_name: metadata.owner_lastname,
                phone: metadata.business_phone,
                email: customer.email,
                account_type: 'business'
            });

            if (userError) {
                throw new AppError(userError.message, 500);
            }

            const slug = metadata.business_name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

            const { error: businessError } = await supabaseAdmin.from('businesses').insert({
                owner_user_id: authData.user.id,
                name: metadata.business_name,
                description: metadata.business_description,
                address: metadata.business_address,
                city: metadata.business_city,
                state: metadata.business_state,
                zip: metadata.business_zip,
                phone: metadata.business_phone,
                email: customer.email,
                slug: slug,
                business_tier: metadata.business_tier,
                stripe_customer_id: customerId,
                stripe_subscription_id: subscriptionId
            });

            if (businessError) {
                throw new AppError(businessError.message, 500);
            }
        }
    }

    return res.status(200).json({ received: true });
}))

export default router