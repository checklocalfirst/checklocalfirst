import { z } from 'zod';

const slugParam = z.string().min(1, 'Invalid business slug');

export const businessSlugParamSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({}).optional(),
  params: z.object({
    slug: slugParam,
  }),
});

// Timeline fields are premium-tier only — enforced in the route handler
// (checked against the business's own business_tier), not here in the schema,
// since whether a field is *allowed* depends on data the schema doesn't have
// access to. This list is shared with businesses.js so the two stay in sync.
// (`story` used to live here too — removed along with the column, migration 032.)
export const PREMIUM_ONLY_BUSINESS_FIELDS = [
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
    timeline_year_1: yearSchema.optional(),
    timeline_description_1: z.string().max(2000).optional(),
    timeline_year_2: yearSchema.optional(),
    timeline_description_2: z.string().max(2000).optional(),
    timeline_year_3: yearSchema.optional(),
    timeline_description_3: z.string().max(2000).optional(),
  }),
});

// Sunday-Saturday, always all seven — same "replace-all" convention as
// category_ids below, since a weekly-hours editor naturally holds all seven
// days in state anyway (there's no meaningful "just update Tuesday" request
// from a form like that). Times are "HH:MM" 24-hour, in the business's own
// local time — no timezone conversion happens server-side. Overnight hours
// that cross midnight (e.g. a bar open 18:00-02:00) aren't supported yet —
// close must be later than open within the same day.
export const DAY_KEYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

const timeString = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be in HH:MM 24-hour format (e.g. "09:00")');

const daySchema = z
  .object({
    closed: z.boolean(),
    open: timeString.optional(),
    close: timeString.optional(),
  })
  .refine(
    (day) => day.closed || (day.open !== undefined && day.close !== undefined && day.open < day.close),
    {
      message:
        'open and close are both required when closed is false, and open must be earlier than close',
      path: ['open'],
    }
  );

const hoursShape = {};
for (const day of DAY_KEYS) {
  hoursShape[day] = daySchema;
}

// Body-only shape, exported separately from updateBusinessHoursSchema below so
// adminSchemas.js's full-field business editor can compose it in as one
// optional field (`hours: businessHoursBodySchema.optional()`) instead of
// duplicating the day/time validation rules a second time.
//
// .strict() — reject unknown day keys (typos, non-day strings) rather than
// silently ignoring them and leaving that day unset.
export const businessHoursBodySchema = z.object(hoursShape).strict();

export const updateBusinessHoursSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({
    slug: slugParam,
  }),
  body: businessHoursBodySchema,
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

// Validates the multipart form's text fields — multer populates req.body with
// these as strings before this schema ever runs (see middleware/upload.js),
// same as any other body. The file itself (req.file) isn't part of this schema;
// the route checks for its presence directly.
export const uploadPhotoSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({
    slug: slugParam,
  }),
  body: z.object({
    photo_type: z.enum(['listing', 'owner', 'gallery'], {
      errorMap: () => ({ message: 'photo_type must be listing, owner, or gallery' }),
    }),
    display_order: z.coerce.number().int().min(0).optional(),
  }),
});

export const updatePhotoSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({
    slug: slugParam,
    id: z.coerce.number().int().positive('Invalid photo id'),
  }),
  body: z.object({
    // photo_type isn't editable here — changing it could bypass the one-per-type
    // cap on listing/owner or the tier gate on gallery. Delete and re-upload to
    // change type instead.
    display_order: z.coerce.number().int().min(0).optional(),
  }),
});

export const photoIdParamSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({}).optional(),
  params: z.object({
    slug: slugParam,
    id: z.coerce.number().int().positive('Invalid photo id'),
  }),
});