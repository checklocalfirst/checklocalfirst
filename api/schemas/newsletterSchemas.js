import { z } from 'zod';

export const newsletterSignupSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
  }),
  params: z.object({}).optional(),
  query: z.object({}).optional(),
});
