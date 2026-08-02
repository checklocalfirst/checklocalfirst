import express from 'express'
import { supabase, supabaseAdmin } from '../dbconnect.js'
import { authAdminMiddleware, authMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { createCategorySchema, categoryIdParamSchema } from '../schemas/categorySchemas.js';
import { catchAsync } from '../helpers/catchAsync.js';
import { AppError } from '../helpers/AppError.js';

const router = express.Router()

router.get('/', catchAsync(async (req, res) => {
    const {data, error} = await supabase.from('categories').select('*');

    if(error){
        throw new AppError(error.message, 500);
    }

    return res.status(200).json({ success: true, data });
}))

router.post('/', authMiddleware, authAdminMiddleware, validate(createCategorySchema), catchAsync(async (req, res) => {
    const { name, slug } = req.validated.body;

    const { data, error } = await supabaseAdmin.from('categories').insert({ name, slug }).select().single();

    if (error) {
        throw new AppError(error.message, 500);
    }

    return res.status(201).json({ success: true, data });
}))

router.delete('/:id', authMiddleware, authAdminMiddleware, validate(categoryIdParamSchema), catchAsync(async (req, res) => {
    const { id } = req.validated.params;

    const { data, error } = await supabaseAdmin.from('categories').delete().eq('id', id).select().single();

    if (error) {
        if (error.code === '23503') {
            throw new AppError('Cannot delete category: services or businesses are still assigned to it', 409);
        }
        throw new AppError(error.message, 500);
    }

    if (!data) {
        throw new AppError('Category not found', 404);
    }

    return res.status(200).json({ success: true, message: 'Category deleted successfully' });
}))

export default router