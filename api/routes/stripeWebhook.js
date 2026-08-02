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

            const invoice = await stripe.invoices.retrieve(invoiceObject.id, {
                expand: ['parent.subscription_details']
            });

            const subscriptionId = invoice.parent?.subscription_details?.subscription;

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
                stripe_subscription_id: subscriptionId,
                latitude: geocoded?.latitude ?? null,
                longitude: geocoded?.longitude ?? null,
                neighborhood: geocoded?.neighborhood ?? null,
                geocoded_at: geocoded ? new Date().toISOString() : null
            });

            if (businessError) {
                throw new AppError(businessError.message, 500);
            }

            // createUser above sets a random password nobody knows — this is the only way
            // the business owner gets into the account they just paid for. Wrapped in its own
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