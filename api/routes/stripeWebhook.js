import express from 'express';
import { stripe } from '../stripeconnect.js';
import { supabaseAdmin } from '../dbconnect.js';
import { AppError } from '../helpers/AppError.js';
import { catchAsync } from '../helpers/catchAsync.js';
import crypto from 'crypto';
import { authMiddleware } from '../middleware/auth.js';
import { sendEmail } from '../helpers/sendEmail.js';
import { geocodeAddress } from '../helpers/geocode.js';

const router = express.Router();

// Creates the Supabase auth user + `users` row + `businesses` row for a new
// business signup, and emails the password-setup link. Shared by both
// invoice.payment_succeeded (the normal, charged-today signup) and
// setup_intent.succeeded (the coupon path, where nothing was charged but a
// card got saved) — same account, same fields, just reached via two different
// Stripe events depending on whether there was anything to pay today. See the
// call sites below for which event fires which one.
async function provisionBusinessAccount(customer, customerId, subscriptionId) {
    const metadata = customer.metadata;
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

    // Geocoding failure shouldn't block account creation — geocodeAddress()
    // fails soft and returns null, which just leaves lat/lng/neighborhood
    // null for now (backfillable later via scripts/backfillGeocoding.js).
    const geocoded = await geocodeAddress({
        address: metadata.business_address,
        city: metadata.business_city,
        state: metadata.business_state,
        zip: metadata.business_zip
    });

    const { data: newBusiness, error: businessError } = await supabaseAdmin
        .from('businesses')
        .insert({
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
            stripe_subscription_id: subscriptionId,
            latitude: geocoded?.latitude ?? null,
            longitude: geocoded?.longitude ?? null,
            neighborhood: geocoded?.neighborhood ?? null,
            geocoded_at: geocoded ? new Date().toISOString() : null
        })
        .select('id')
        .single();

    if (businessError) {
        throw new AppError(businessError.message, 500);
    }

    // Every new business starts with a standing "10% off one item" welcome
    // discount (WELCOME10). Wrapped in its own try/catch for the same reason
    // as the password-setup email below: the user and business rows are
    // already committed above, and throwing here would just make Stripe retry
    // the whole event, which lands in the existingBusiness branch and never
    // re-attempts this insert. Logged for manual follow-up instead.
    try {
        const { error: discountError } = await supabaseAdmin.from('discounts').insert({
            business_id: newBusiness.id,
            code: 'WELCOME10',
            description: '10% off one item',
            discount_type: 'percent',
            value: 10,
            active: true
        });

        if (discountError) {
            throw discountError;
        }
    } catch (discountErr) {
        console.error(`Failed to create welcome discount for business ${newBusiness.id}:`, discountErr);
    }

    // createUser above sets a random password nobody knows — this is the only way
    // the business owner gets into the account they just signed up for. Wrapped in its own
    // try/catch so a Resend hiccup doesn't fail this webhook response: the account and
    // business rows already committed above, and failing here would just make Stripe
    // retry the whole event, which lands in the existingBusiness branch above and never
    // re-attempts this email. If sending fails, it's logged here for manual follow-up
    // instead of silently vanishing.
    try {
        const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
            type: 'recovery',
            email: customer.email,
            options: {
                redirectTo: process.env.PASSWORD_RESET_REDIRECT_URL
            }
        });

        if (linkError) {
            throw linkError;
        }

        await sendEmail({
            to: customer.email,
            subject: 'Welcome to CheckLocalFirst — set up your account',
            html: `
                <p>Hi ${metadata.owner_firstname},</p>
                <p>Thanks for signing up ${metadata.business_name} with CheckLocalFirst! Click below to set your password and access your business dashboard.</p>
                <p><a href="${linkData.properties.action_link}">Set your password</a></p>
                <p>This link will expire after a while, so set your password soon. If you weren't expecting this email, you can safely ignore it.</p>
            `
        });
    } catch (emailErr) {
        console.error(`Failed to send password-setup email to ${customer.email}:`, emailErr);
    }
}

router.post('/', express.raw({ type: 'application/json' }), catchAsync(async (req, res) => {
    const signature = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        throw new AppError(`Webhook signature verification failed: ${err.message}`, 400);
    }

    if (event.type === 'invoice.payment_succeeded') {
        const invoiceObject = event.data.object;
        const customerId = invoiceObject.customer;

        const customer = await stripe.customers.retrieve(customerId);
        const metadata = customer.metadata;

        if (metadata.signup_type === 'business') {
            const { data: existingBusiness } = await supabaseAdmin
                .from('businesses')
                .select('id')
                .eq('stripe_customer_id', customerId)
                .single();

            if (existingBusiness) {
                // Not a new signup — this is a renewal or a tier-upgrade proration invoice.
                if (invoiceObject.billing_reason === 'subscription_update') {
                    const invoice = await stripe.invoices.retrieve(invoiceObject.id, {
                        expand: ['parent.subscription_details']
                    });
                    const subscriptionId = invoice.parent?.subscription_details?.subscription;

                    if (subscriptionId) {
                        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                        const priceId = subscription.items.data[0]?.price?.id;
                        const newTier = priceId === process.env.STRIPE_PREMIUM_BUSINESS_PRICE ? 'premium' : 'basic';

                        const { error: tierError } = await supabaseAdmin
                            .from('businesses')
                            .update({ business_tier: newTier })
                            .eq('id', existingBusiness.id);

                        if (tierError) {
                            throw new AppError(tierError.message, 500);
                        }
                    }
                }

                return res.status(200).json({ received: true });
            }

            // A $0 invoice (this signup used a coupon that fully covered the first
            // invoice/period — e.g. "PILOTBUSINESS") is auto-finalized and paid by
            // Stripe the instant the subscription is created, before the customer
            // has entered a card. If account creation ran here unconditionally,
            // the business/user rows (and the password-setup email) would go out
            // before the signup form's card step even loads on the frontend —
            // meaning a business could get a live account just by typing in a
            // coupon code and abandoning the page, with no card ever saved for
            // when the free period ends. Account creation for that path happens
            // in the setup_intent.succeeded handler below instead, once the
            // customer has actually confirmed a card to save.
            if (invoiceObject.amount_paid === 0) {
                return res.status(200).json({ received: true });
            }

            const invoice = await stripe.invoices.retrieve(invoiceObject.id, {
                expand: ['parent.subscription_details']
            });

            const subscriptionId = invoice.parent?.subscription_details?.subscription;

            await provisionBusinessAccount(customer, customerId, subscriptionId);

            // Separate welcome/receipt email — its own try/catch so a failure here (or above)
            // never blocks the other. Amount/invoice info comes straight off the invoice Stripe
            // just sent us (amount_paid, hosted_invoice_url, invoice_pdf) rather than being
            // hardcoded, so it stays correct if pricing or discounts change.
            try {
                const amountPaid = (invoiceObject.amount_paid / 100).toLocaleString('en-US', {
                    style: 'currency',
                    currency: (invoiceObject.currency || 'usd').toUpperCase()
                });

                await sendEmail({
                    to: customer.email,
                    subject: `Welcome to CheckLocalFirst — receipt for ${metadata.business_name}`,
                    html: `
                        <p>Hi ${metadata.owner_firstname},</p>
                        <p>Welcome to CheckLocalFirst! ${metadata.business_name} is officially signed up on the ${metadata.business_tier} plan.</p>
                        <p><strong>Amount paid:</strong> ${amountPaid}</p>
                        ${invoiceObject.number ? `<p><strong>Invoice number:</strong> ${invoiceObject.number}</p>` : ''}
                        ${invoiceObject.hosted_invoice_url ? `<p><a href="${invoiceObject.hosted_invoice_url}">View your invoice</a></p>` : ''}
                        ${invoiceObject.invoice_pdf ? `<p><a href="${invoiceObject.invoice_pdf}">Download PDF receipt</a></p>` : ''}
                        <p>If you haven't set your password yet, check your inbox for a separate email with that link.</p>
                    `
                });
            } catch (emailErr) {
                console.error(`Failed to send welcome/receipt email to ${customer.email}:`, emailErr);
            }
        }

        if (metadata.signup_type === 'user_premium') {
            const userId = metadata.user_id;

            const { data: userData, error: fetchError } = await supabaseAdmin
                .from('users')
                .select('is_premium, first_name')
                .eq('user_id', userId)
                .single();

            if (fetchError || !userData) {
                throw new AppError('User not found for premium upgrade', 404);
            }

            if (userData.is_premium) {
                return res.status(200).json({ received: true });
            }

            // Same reasoning as the business signup path above: a $0 invoice
            // (a coupon that fully covers the first period) is auto-finalized
            // and paid by Stripe before the frontend's card step ever runs.
            // Flipping is_premium here would grant access before a card is
            // actually saved for when the free period ends — that happens in
            // the setup_intent.succeeded handler below instead, once the
            // customer has confirmed a card to save.
            if (invoiceObject.amount_paid === 0) {
                return res.status(200).json({ received: true });
            }

            const invoice = await stripe.invoices.retrieve(invoiceObject.id, {
                expand: ['parent.subscription_details']
            });

            const subscriptionId = invoice.parent?.subscription_details?.subscription;

            const { error: updateError } = await supabaseAdmin
                .from('users')
                .update({
                    is_premium: true,
                    stripe_customer_id: customerId,
                    stripe_subscription_id: subscriptionId
                })
                .eq('user_id', userId);

            if (updateError) {
                throw new AppError(updateError.message, 500);
            }

            // Upgrade confirmation + receipt — own try/catch so a Resend hiccup doesn't fail
            // the webhook (the upgrade itself already committed above). Same invoice fields
            // as the business welcome email, pulled straight from Stripe.
            try {
                const amountPaid = (invoiceObject.amount_paid / 100).toLocaleString('en-US', {
                    style: 'currency',
                    currency: (invoiceObject.currency || 'usd').toUpperCase()
                });

                await sendEmail({
                    to: customer.email,
                    subject: 'Thanks for upgrading to CheckLocalFirst Premium',
                    html: `
                        <p>Hi ${userData.first_name || 'there'},</p>
                        <p>Thanks for upgrading to Premium! Your account now has full access to premium features.</p>
                        <p><strong>Amount paid:</strong> ${amountPaid}</p>
                        ${invoiceObject.number ? `<p><strong>Invoice number:</strong> ${invoiceObject.number}</p>` : ''}
                        ${invoiceObject.hosted_invoice_url ? `<p><a href="${invoiceObject.hosted_invoice_url}">View your invoice</a></p>` : ''}
                        ${invoiceObject.invoice_pdf ? `<p><a href="${invoiceObject.invoice_pdf}">Download PDF receipt</a></p>` : ''}
                    `
                });
            } catch (emailErr) {
                console.error(`Failed to send premium-upgrade receipt email to ${customer.email}:`, emailErr);
            }
        }
    }

    // The counterpart to the amount_paid === 0 guard above — this is what
    // actually provisions the account for a business signup whose first
    // invoice was fully covered by a coupon. It fires once the customer has
    // confirmed the SetupIntent on the frontend (routes/stripe.js's
    // POST /signup/business/checkout, 'setup' mode), meaning a card is now on
    // file as the subscription's default payment method — so billing will
    // work automatically once the coupon's free period ends, exactly like the
    // paid-today path, just without a charge happening right now.
    if (event.type === 'setup_intent.succeeded') {
        const setupIntent = event.data.object;

        if (setupIntent.metadata?.signup_type === 'business') {
            const customerId = setupIntent.customer;

            const customer = await stripe.customers.retrieve(customerId);
            const metadata = customer.metadata;

            // Same idempotency guard as invoice.payment_succeeded above — Stripe
            // retries webhook deliveries, so a second delivery of this same event
            // (or a stray extra one) must not re-provision the same business.
            const { data: existingBusiness } = await supabaseAdmin
                .from('businesses')
                .select('id')
                .eq('stripe_customer_id', customerId)
                .single();

            if (existingBusiness) {
                return res.status(200).json({ received: true });
            }

            // The SetupIntent has no built-in link back to the subscription that
            // spawned it — routes/stripe.js stamps subscription_id into its
            // metadata right after creating it (see POST /signup/business/checkout),
            // but fall back to looking it up if that's ever missing (e.g. an older
            // in-flight signup from before this existed).
            let subscriptionId = setupIntent.metadata.subscription_id;

            if (!subscriptionId) {
                const subscriptions = await stripe.subscriptions.list({ customer: customerId, limit: 1 });
                subscriptionId = subscriptions.data[0]?.id;
            }

            await provisionBusinessAccount(customer, customerId, subscriptionId);

            // No dollar amount to report here — nothing was charged today. This
            // confirms the signup and explains that billing starts once the free
            // period ends, in place of the amount-based receipt email the
            // paid-today path sends above.
            try {
                await sendEmail({
                    to: customer.email,
                    subject: `Welcome to CheckLocalFirst — ${metadata.business_name} is signed up`,
                    html: `
                        <p>Hi ${metadata.owner_firstname},</p>
                        <p>Welcome to CheckLocalFirst! ${metadata.business_name} is officially signed up on the ${metadata.business_tier} plan using your coupon code — nothing was charged today.</p>
                        <p>We've saved your card on file, and billing will start automatically once your free period ends.</p>
                        <p>If you haven't set your password yet, check your inbox for a separate email with that link.</p>
                    `
                });
            } catch (emailErr) {
                console.error(`Failed to send signup-confirmation email to ${customer.email}:`, emailErr);
            }
        }

        // Counterpart to the amount_paid === 0 guard in the user_premium branch
        // of invoice.payment_succeeded above — this is what actually flips
        // is_premium for a premium-user checkout whose first invoice was fully
        // covered by a coupon. Fires once the customer has confirmed the
        // SetupIntent on the frontend (routes/stripe.js's POST
        // /premium-user/checkout, 'setup' mode), meaning a card is now on file
        // as the subscription's default payment method.
        else if (setupIntent.metadata?.signup_type === 'user_premium') {
            const customerId = setupIntent.customer;

            const customer = await stripe.customers.retrieve(customerId);
            const userId = customer.metadata.user_id;

            const { data: userData, error: fetchError } = await supabaseAdmin
                .from('users')
                .select('is_premium, first_name')
                .eq('user_id', userId)
                .single();

            if (fetchError || !userData) {
                throw new AppError('User not found for premium upgrade', 404);
            }

            // Same idempotency guard as invoice.payment_succeeded above — Stripe
            // retries webhook deliveries, so a second delivery of this same
            // event must not re-process the same upgrade.
            if (userData.is_premium) {
                return res.status(200).json({ received: true });
            }

            // Same fallback reasoning as the business branch above — the
            // SetupIntent has no built-in link back to the subscription that
            // spawned it, so routes/stripe.js stamps subscription_id into its
            // metadata right after creating it; fall back to looking it up if
            // that's ever missing.
            let subscriptionId = setupIntent.metadata.subscription_id;

            if (!subscriptionId) {
                const subscriptions = await stripe.subscriptions.list({ customer: customerId, limit: 1 });
                subscriptionId = subscriptions.data[0]?.id;
            }

            const { error: updateError } = await supabaseAdmin
                .from('users')
                .update({
                    is_premium: true,
                    stripe_customer_id: customerId,
                    stripe_subscription_id: subscriptionId
                })
                .eq('user_id', userId);

            if (updateError) {
                throw new AppError(updateError.message, 500);
            }

            // No dollar amount to report here — nothing was charged today, same
            // reasoning as the business signup confirmation email above.
            try {
                await sendEmail({
                    to: customer.email,
                    subject: 'Thanks for upgrading to CheckLocalFirst Premium',
                    html: `
                        <p>Hi ${userData.first_name || 'there'},</p>
                        <p>Thanks for upgrading to Premium using your coupon code — nothing was charged today.</p>
                        <p>Your account now has full access to premium features. We've saved your card on file, and billing will start automatically once your free period ends.</p>
                    `
                });
            } catch (emailErr) {
                console.error(`Failed to send premium-upgrade confirmation email to ${customer.email}:`, emailErr);
            }
        }

        return res.status(200).json({ received: true });
    }

    // Fires when a subscription actually ends — either an immediate cancellation or,
    // more commonly here, once a cancel_at_period_end subscription reaches its period end.
    if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        const { data: business } = await supabaseAdmin
            .from('businesses')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .single();

        if (business) {
            const { error: suspendError } = await supabaseAdmin
                .from('businesses')
                .update({ status: 'suspended' })
                .eq('id', business.id);

            if (suspendError) {
                throw new AppError(suspendError.message, 500);
            }

            return res.status(200).json({ received: true });
        }

        const { data: user } = await supabaseAdmin
            .from('users')
            .select('user_id')
            .eq('stripe_customer_id', customerId)
            .single();

        if (user) {
            const { error: downgradeError } = await supabaseAdmin
                .from('users')
                .update({ is_premium: false })
                .eq('user_id', user.user_id);

            if (downgradeError) {
                throw new AppError(downgradeError.message, 500);
            }
        }

        return res.status(200).json({ received: true });
    }

    return res.status(200).json({ received: true });
}))

export default router