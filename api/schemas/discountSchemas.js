import { z } from 'zod';

const slugParam = z.string().min(1, 'Invalid business slug');
const discountIdParam = z.coerce.number().int().positive('Invalid discount id');

// Shared so a percent discount can't be created at, say, 250% — value is a
// plain positive number for 'fixed' (a dollar amount), but capped at 100 when
// discount_type is 'percent'.
function capPercentValue(data) {
  return data.discount_type !== 'percent' || data.value === undefined || data.value <= 100;
}

const createBody = z.object({
  code: z.string().min(1, 'Code is required').max(50),
  description: z.string().min(1, 'Description is required').max(500),
  discount_type: z.enum(['percent', 'fixed'], {
    errorMap: () => ({ message: 'discount_type must be percent or fixed' }),
  }),
  value: z.coerce.number().positive('Value must be positive'),
  starts_at: z.coerce.date().optional(),
  expires_at: z.coerce.date().optional(),
  max_redemptions: z.coerce.number().int().positive().optional(),
  active: z.boolean().optional(),
}).refine(capPercentValue, { message: 'Percent discounts must be between 0 and 100', path: ['value'] });

const updateBody = z.object({
  code: z.string().min(1).max(50).optional(),
  description: z.string().min(1).max(500).optional(),
  discount_type: z.enum(['percent', 'fixed']).optional(),
  value: z.coerce.number().positive('Value must be positive').optional(),
  starts_at: z.coerce.date().optional(),
  expires_at: z.coerce.date().optional(),
  max_redemptions: z.coerce.number().int().positive().optional(),
  active: z.boolean().optional(),
  // Only enforced when both fields are present in this same request — can't
  // validate a partial update (e.g. value-only) against a discount_type the
  // schema doesn't know yet; the route does a belt-and-suspenders check against
  // the stored type before saving.
}).refine(capPercentValue, { message: 'Percent discounts must be between 0 and 100', path: ['value'] });

export const createDiscountSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({ slug: slugParam }),
  body: createBody,
});

export const updateDiscountSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({ slug: slugParam, id: discountIdParam }),
  body: updateBody,
});

export const discountIdParamSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({}).optional(),
  params: z.object({ slug: slugParam, id: discountIdParam }),
});

export const redeemDiscountSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({}).optional(),
  params: z.object({ slug: slugParam, id: discountIdParam }),
});

// Admin variants — same body shape, id-based params instead of slug-scoped.
export const adminCreateDiscountSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({ id: z.coerce.number().int().positive('Invalid business id') }),
  body: createBody,
});

export const adminUpdateDiscountSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({ id: discountIdParam }),
  body: updateBody,
});

export const adminDiscountIdParamSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({}).optional(),
  params: z.object({ id: discountIdParam }),
});
