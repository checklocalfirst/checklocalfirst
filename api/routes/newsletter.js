import express from 'express'
import { supabaseAdmin } from '../dbconnect.js'
import { validate } from '../middleware/validate.js';
import { newsletterSignupSchema } from '../schemas/newsletterSchemas.js';
import { catchAsync } from '../helpers/catchAsync.js';
import { AppError } from '../helpers/AppError.js';

const router = express.Router()

router.post('/', validate(newsletterSignupSchema), catchAsync(async (req, res) => {
    const { email } = req.validated.body;

    const { data, error } = await supabaseAdmin
        .from('newsletter_signups')
        .insert({ email })
        .select()
        .single();

    if (error) {
        // Unlike /landing (which 409s on a repeat email — attribution there
        // depends on catching duplicates), a newsletter box gets accidental
        // double-submits all the time and there's nothing attribution-sensitive
        // to protect. Treat "already on the list" as success rather than an
        // error the frontend has to special-case.
        if (error.code === '23505') {
            return res.status(200).json({ success: true, message: "You're already subscribed" });
        }
        throw new AppError(error.message, 500);
    }

    res.status(201).json({ success: true, data });
}))

export default router
