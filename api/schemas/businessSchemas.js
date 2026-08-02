import { z } from 'zod';

const slugParam = z.string().min(1, 'Invalid business slug');

export const businessSlugParamSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({}).optional(),
  params: z.object({
    slug: slugParam,
  }),
});

// Story + timeline fields are premium-tier only — enforced in the route handler
// (checked against the business's own business_tier), not here in the schema,
// since whether a field is *allowed* depends on data the schema doesn't have
// access to. This list is shared with businesses.js so the two stay in sync.
export const PREMIUM_ONLY_BUSINESS_FIELDS = [
  'story',
  'timeline_year_1',
  'timeline_description_1',
  'timeline_year_2',
  'timeline_description_2',
  'timeline_year_3',
  'timeline_description_3',
];

const yearSchema = z.coerce.number().int().min(1800).max(2100);

export const updateBusinessSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({
    slug: slugParam,
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
    // Available at both basic and premium tiers.
    website_url: z.string().url('Invalid URL').max(2048).optional(),
    about_owner: z.string().max(3000).optional(),
    facebook_url: z.string().url('Invalid URL').max(2048).optional(),
    instagram_url: z.string().url('Invalid URL').max(2048).optional(),
    yelp_url: z.string().url('Invalid URL').max(2048).optional(),
    // Premium only — see PREMIUM_ONLY_BUSINESS_FIELDS above.
    story: z.string().max(5000).optional(),
    timeline_year_1: yearSchema.optional(),
    timeline_description_1: z.string().max(2000).optional(),
    timeline_year_2: yearSchema.optional(),
    timeline_description_2: z.string().max(2000).optional(),
    timeline_year_3: yearSchema.optional(),
    timeline_description_3: z.string().max(2000).optional(),
  }),
});

export const updateBusinessCategoriesSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({
    slug: slugParam,
  }),
  body: z.object({
    // Replace-all semantics: this list becomes the business's complete category
    // set. A business must always have at least one category — otherwise it's
    // invisible to category-based browse/search, which is the primary discovery
    // path now that business_categories drives it (see /search's category filter).
    category_ids: z
      .array(z.coerce.number().int().positive())
      .min(1, 'A business must have at least one category')
      .max(20, 'Too many categories'),
  }),
});

export const createServiceSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({
    slug: slugParam,
  }),
  body: z.object({
    name: z.string().min(1, 'Service name is required').max(100),
    description: z.string().optional(),
    category_id: z.coerce.number().int().positive('category_id is required'),
  }),
});

export const updateServiceSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({
    slug: slugParam,
    id: z.coerce.number().int().positive('Invalid service id'),
  }),
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().optional(),
    category_id: z.coerce.number().int().positive('category_id is required'),
  }),
});

export const serviceIdParamSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({}).optional(),
  params: z.object({
    slug: slugParam,
    id: z.coerce.number().int().positive('Invalid service id'),
  }),
});