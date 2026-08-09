// helpers/sendEmail.js
import { Resend } from 'resend';
import { AppError } from './AppError.js';

const resend = new Resend(process.env.RESEND_API_KEY);

// Falls back to Resend's shared test domain if RESEND_FROM_EMAIL isn't set yet,
// so this doesn't hard-fail before the real sending domain is verified.
const DEFAULT_FROM = process.env.RESEND_FROM_EMAIL || 'CheckLocalFirst <hello@checklocalfirst.com>';

/**
 * Sends a single email through Resend.
 *
 * @param {Object} options
 * @param {string|string[]} options.to - Recipient email address(es).
 * @param {string} options.subject - Email subject line.
 * @param {string} options.html - HTML body.
 * @param {string} [options.text] - Optional plain-text fallback body.
 * @param {string} [options.from] - Overrides DEFAULT_FROM for this send.
 * @param {string} [options.replyTo] - Optional reply-to address.
 * @returns {Promise<{id: string}>} The Resend message data.
 */
export async function sendEmail({ to, subject, html, text, from, replyTo }) {
    if (!to || !subject || !html) {
        throw new AppError('sendEmail requires "to", "subject", and "html"', 500);
    }

    const { data, error } = await resend.emails.send({
        from: from || DEFAULT_FROM,
        to,
        subject,
        html,
        ...(text ? { text } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
    });

    if (error) {
        // Email failures shouldn't usually crash the calling flow (e.g. a webhook that already
        // created the account) — callers can catch this and log/retry rather than fail the request.
        throw new AppError(`Failed to send email: ${error.message}`, 502);
    }

    return data;
}
