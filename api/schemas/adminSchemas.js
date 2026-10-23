import { z } from 'zod';
import { businessHoursBodySchema, addressLabelSchema } from './businessSchemas.js';

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
// isn't tier-gated on timeline (admin can set any field on any business
// regardless of business_tier, same pattern as is_featured/in_carousel already
// being admin-only togglable) and can manually override latitude/longitude/
// neighborhood as a stopgap for businesses geocoding can't resolve.
// (`story` used to be part of this editor too — removed along with the column, migration 032.)
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
    address_label: addressLabelSchema.optional(),
    hide_address: z.boolean().optional(),
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
    // Same shape/validation as PUT /businesses/:slug/hours (see
    // businessSchemas.js) — admin can set a business's hours on its behalf,
    // same "admin isn't tier-gated" pattern as everything else on this route.
    // The `hours` key itself is optional here (omit it to leave hours
    // untouched, same as every other field on this partial-update editor),
    // but when it IS present it must still be the complete seven-day object —
    // businessHoursBodySchema keeps its own replace-all requirement either way.
    hours: businessHoursBodySchema.optional(),
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

// Admin upload — unlike the business-owner version, photo_type isn't capped or
// tier-gated here (admin can upload any type, any count, regardless of tier,
// including 'timeline' onto a basic-tier business — same override pattern as
// timeline text fields in adminUpdateBusinessSchema above). timeline_slot is
// required exactly when photo_type is 'timeline' and disallowed otherwise —
// see migration 029's one_photo_per_timeline_slot index, which is what
// re-uploading the same slot needs to cleanly replace rather than collide with.
export const adminUploadPhotoSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({
    id: z.coerce.number().int().positive('Invalid business id'),
  }),
  body: z.object({
    photo_type: z.enum(['listing', 'owner', 'gallery', 'timeline'], {
      errorMap: () => ({ message: 'photo_type must be listing, owner, gallery, or timeline' }),
    }),
    display_order: z.coerce.number().int().min(0).optional(),
    timeline_slot: z.coerce.number().int().min(1).max(3).optional(),
  }).refine(
    (data) => (data.photo_type === 'timeline') === (data.timeline_slot !== undefined),
    { message: 'timeline_slot (1-3) is required when photo_type is timeline, and must be omitted otherwise', path: ['timeline_slot'] }
  ),
});

export const adminUpdatePhotoSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({
    id: z.coerce.number().int().positive('Invalid photo id'),
  }),
  body: z.object({
    // Admin isn't capped, so — unlike the business-owner update route — photo_type
    // can be changed here too, not just display_order.
    photo_type: z.enum(['listing', 'owner', 'gallery', 'timeline']).optional(),
    display_order: z.coerce.number().int().min(0).optional(),
    // Only enforced when photo_type is present in *this* request (same
    // partial-update caveat as discountSchemas.js's capPercentValue) — moving
    // an existing timeline photo's slot without also resending photo_type is
    // still allowed and left to the route/DB constraint to validate.
    timeline_slot: z.coerce.number().int().min(1).max(3).optional(),
  }).refine(
    (data) => data.photo_type !== 'timeline' || data.timeline_slot !== undefined,
    { message: 'timeline_slot (1-3) is required when changing photo_type to timeline', path: ['timeline_slot'] }
  ).refine(
    (data) => data.photo_type === 'timeline' || data.photo_type === undefined || data.timeline_slot === undefined,
    { message: 'timeline_slot cannot be set when changing photo_type away from timeline', path: ['timeline_slot'] }
  ),
});

export const adminPhotoIdParamSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({}).optional(),
  params: z.object({
    id: z.coerce.number().int().positive('Invalid photo id'),
  }),
});

export const updatePhotoApprovalSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({
    id: z.coerce.number().int().positive('Invalid photo id'),
  }),
  body: z.object({
    approved: z.boolean(),
  }),
});
// Admin create — nested under business id (like adminUploadPhotoSchema),
// unlike adminUpdateServiceSchema/adminServiceIdParamSchema below which key
// off the service's own id since a service already exists by the time those
// run. category_id is required here (no existing service row to fall back
// to); the route surfaces a 400 if it doesn't reference a real category
// rather than letting the FK violation bubble up as a raw 500.
export const adminCreateServiceSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({
    id: z.coerce.number().int().positive('Invalid business id'),
  }),
  body: z.object({
    name: z.string().min(1, 'Service name is required').max(100),
    description: z.string().optional(),
    category_id: z.coerce.number().int().positive('category_id is required'),
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
// Search synonyms (migration 036) — two phrases search treats as the same thing,
// matched in both directions. Normalized to lowercase/trimmed here because the
// table's CHECK constraint requires it; letters, digits, spaces, hyphens and
// apostrophes only.
const synonymPhrase = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Phrase is required')
  .max(100)
  .regex(/^[a-z0-9' -]+$/, 'Only letters, numbers, spaces, hyphens and apostrophes are allowed');

export const createSearchSynonymSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({}).optional(),
  body: z
    .object({
      term: synonymPhrase,
      synonym: synonymPhrase,
    })
    .refine((body) => body.term !== body.synonym, {
      message: 'term and synonym must be different',
      path: ['synonym'],
    }),
});

export const searchSynonymIdParamSchema = z.object({
  body: z.object({}).optional(),
  query: z.object({}).optional(),
  params: z.object({
    id: z.coerce.number().int().positive('Invalid synonym id'),
  }),
});

// GET /admin/search-misses (migration 037) — most-missed searches over the last
// `days` days.
export const searchMissesQuerySchema = z.object({
  body: z.object({}).optional(),
  params: z.object({}).optional(),
  query: z.object({
    days: z.coerce.number().int().min(1).max(365).default(30),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
});

// GET /admin/change-log and /admin/businesses/:id/change-log (migration 039).
// page/limit are read by parsePagination, like every other paged admin list.
const changeLogFilters = {
  actor_role: z.enum(['owner', 'admin', 'system']).optional(),
  action: z.string().max(40).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).optional(),
};

export const changeLogQuerySchema = z.object({
  body: z.object({}).optional(),
  params: z.object({}).optional(),
  query: z.object({
    business_id: z.coerce.number().int().positive('Invalid business id').optional(),
    ...changeLogFilters,
  }),
});

export const businessChangeLogQuerySchema = z.object({
  body: z.object({}).optional(),
  params: z.object({
    id: z.coerce.number().int().positive('Invalid business id'),
  }),
  query: z.object(changeLogFilters),
});
