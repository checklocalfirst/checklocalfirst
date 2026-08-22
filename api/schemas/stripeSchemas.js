// schemas/stripeSchemas.js
import { z } from 'zod';

export const businessCheckoutSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
    description: z.string().optional(),
    address: z.string().min(1),
    email: z.string().email(),
    phone: z.string().regex(/^\d{10}$/),
    state: z.string().length(2),
    city: z.string().min(1),
    zip: z.string().regex(/^\d{5}$/),
    firstname: z.string().min(1).max(100),
    lastname: z.string().min(1).max(100),
    business_tier: z.enum(['basic', 'premium']),
    coupon_code: z.string().min(1).optional(),
  }),
  params: z.object({}).optional(),
  query: z.object({}).optional(),
});

export const premiumUserCheckoutSchema = z.object({
  body: z.object({
    // Same Promotion Code lookup as businessCheckoutSchema above.
    coupon_code: z.string().min(1).optional(),
  }).optional(),
  params: z.object({}).optional(),
  query: z.object({}).optional(),
});

export const premiumUserCancelSchema = z.object({
  body: z.object({}).optional(),
  params: z.object({}).optional(),
  query: z.object({}).optional(),
});