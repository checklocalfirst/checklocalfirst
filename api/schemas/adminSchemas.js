import { z } from 'zod';

// GET/DELETE /businesses/:id, GET/DELETE /users/:id — id is a numeric string in the URL for businesses,
// but a UUID string for users. Handle separately since they're different types.

export const businessIdParamSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({}).optional(),
  params: z.object({
    id: z.coerce.number().int().positive('Invalid business id'),
  }),
});

export const userIdParamSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({}).optional(),
  params: z.object({
    id: z.string().uuid('Invalid user id'),
  }),
});

export const updateBusinessStatusSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({
    id: z.coerce.number().int().positive('Invalid business id'),
  }),
  body: z.object({
    status: z.enum(['pending', 'approved', 'suspended', 'rejected'], {
      errorMap: () => ({ message: 'Invalid status value' }),
    }),
  }),
});

const yearSchema = z.coerce.number().int().min(1800).max(2100);

// Full-field admin editor — unlike the business's own PUT /businesses/:slug, admin
// isn't tier-gated on story/timeline (admin can set any field on any business
// regardless of business_tier, same pattern as is_featured/in_carousel already
// being admin-only togglable) and can manually override latitude/longitude/
// neighborhood as a stopgap for businesses geocoding can't resolve.
export const adminUpdateBusinessSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({
    id: z.coerce.number().int().positive('Invalid business id'),
  }),
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().optional(),
    address: z.string().max(255).optional(),
    city: z.string().max(100).optional(),
    state: z.string().length(2, 'State must be a 2-letter code').optional(),
    zip: z.string().regex(/^\d{5}$/, 'Zip must be 5 digits').optional(),
    phone: z.string().regex(/^\d{10}$/, 'Phone must be 10 digits').optional(),
    email: z.string().email('Invalid email address').optional(),
    business_tier: z.enum(['basic', 'premium']).optional(),
    is_comped: z.boolean().optional(),
    website_url: z.string().url('Invalid URL').max(2048).optional(),
    about_owner: z.string().max(3000).optional(),
    facebook_url: z.string().url('Invalid URL').max(2048).optional(),
    instagram_url: z.string().url('Invalid URL').max(2048).optional(),
    yelp_url: z.string().url('Invalid URL').max(2048).optional(),
    story: z.string().max(5000).optional(),
    timeline_year_1: yearSchema.optional(),
    timeline_description_1: z.string().max(2000).optional(),
    timeline_year_2: yearSchema.optional(),
    timeline_description_2: z.string().max(2000).optional(),
    timeline_year_3: yearSchema.optional(),
    timeline_description_3: z.string().max(2000).optional(),
    // Manual geocoding override — set both together; skips the Nominatim call.
    latitude: z.coerce.number().min(-90).max(90).optional(),
    longitude: z.coerce.number().min(-180).max(180).optional(),
    neighborhood: z.string().max(100).optional(),
  }),
});

export const updatePilotStatusSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({
    id: z.coerce.number().int().positive('Invalid business id'),
  }),
  body: z.object({
    pilot_business: z.boolean(),
  }),
});

export const adminUpdateBusinessCategoriesSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({
    id: z.coerce.number().int().positive('Invalid business id'),
  }),
  body: z.object({
    // Same "always at least one" rule as the business-owner version — admin isn't
    // exempt from this invariant, just from the tier-gating on other fields.
    category_ids: z
      .array(z.coerce.number().int().positive())
      .min(1, 'A business must have at least one category')
      .max(20, 'Too many categories'),
  }),
});

export const updateFeaturedStatusSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({
    id: z.coerce.number().int().positive('Invalid business id'),
  }),
  body: z.object({
    is_featured: z.boolean(),
  }),
});

export const updateCarouselStatusSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({
    id: z.coerce.number().int().positive('Invalid business id'),
  }),
  body: z.object({
    in_carousel: z.boolean(),
  }),
});
export const adminServiceIdParamSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({}).optional(),
  params: z.object({
    id: z.coerce.number().int().positive('Invalid service id'),
  }),
});

export const adminUpdateServiceSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({
    id: z.coerce.number().int().positive('Invalid service id'),
  }),
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().optional(),
    category_id: z.coerce.number().int().positive().optional(),
  }),
});