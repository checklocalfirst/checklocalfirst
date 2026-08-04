import { z } from 'zod';

const slugParam = z.string().min(1, 'Invalid business slug');

export const EVENT_TYPES = [
  'call_click',
  'email_click',
  'page_view',
  'address_click',
  'website_click',
  'discount_click',
  'facebook_click',
  'instagram_click',
  'yelp_click',
];

export const trackEventSchema = z.object({
  query: z.object({}).optional(),
  params: z.object({ slug: slugParam }),
  body: z.object({
    event_type: z.enum(EVENT_TYPES, {
      errorMap: () => ({ message: `event_type must be one of: ${EVENT_TYPES.join(', ')}` }),
    }),
  }),
});

export const analyticsQuerySchema = z.object({
  body: z.object({}).optional(),
  params: z.object({ slug: slugParam }),
  query: z.object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }),
});

export const adminBusinessAnalyticsSchema = z.object({
  body: z.object({}).optional(),
  params: z.object({ id: z.coerce.number().int().positive('Invalid business id') }),
  query: z.object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }),
});
