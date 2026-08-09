# New owner-scoped business routes

Added so the business dashboard can read its own services/categories/photos/
discounts while the business `status` is still `pending` (not yet
admin-approved). The existing public routes below still require
`status = 'approved'` and are unchanged — use the new `/owner/...` routes
instead for anything shown on the business's own dashboard, and keep using
the public routes for the public-facing business page.

Root cause, for context: `businesses` has an RLS policy that restricts the
anon-key client to `status = 'approved'` rows. That blocks pending businesses
even on routes with no explicit status filter in the code (e.g. the old
`GET /:slug/services` — this is what was causing the "Cannot coerce the
result to a single JSON object" 500 on the Services tab for pending
businesses). The `/owner/...` routes below read through `supabaseAdmin`
(service role), which bypasses RLS, gated instead by
`verifyBusinessOwnership`.

All four are `GET`, require `Authorization` (same auth as the other business
dashboard calls, e.g. `PUT /businesses/:slug`), and 403 if the logged-in user
doesn't own the business at `:slug`. Same 404 as the existing routes if the
slug doesn't exist.

## GET /businesses/:slug/owner/services

Dashboard replacement for `GET /businesses/:slug/services` — use this for the
Services tab. Same response shape as the public route.

```json
{ "success": true, "data": [{ "id": 1, "business_id": 12, "name": "Logo Design", "description": "...", "category_id": 3 }] }
```

## GET /businesses/:slug/owner/categories

Dashboard replacement for `GET /businesses/:slug/categories`.

Response: identical shape to the public route.

```json
{ "success": true, "data": [{ "id": 1, "name": "Bakery", "slug": "bakery" }] }
```

## GET /businesses/:slug/owner/photos

Dashboard replacement for `GET /businesses/:slug/photos`.

Difference from the public route: not filtered to `approved = true`, so it
includes any photo still pending admin review. Each row has an `approved`
boolean — show a "pending review" indicator for `approved: false` rows if
useful.

```json
{
  "success": true,
  "data": [
    {
      "id": 5,
      "business_id": 12,
      "photo_url": "...",
      "photo_type": "storefront",
      "display_order": 0,
      "approved": true
    }
  ]
}
```

## GET /businesses/:slug/owner/discounts

Dashboard replacement for `GET /businesses/:slug/discounts`.

Differences from the public route:
- Includes the `code` column (public route strips it).
- Not filtered to `active: true` or to the current start/expiry window —
  returns every discount the business has created, so the dashboard can list
  and manage inactive/expired ones too.

```json
{
  "success": true,
  "data": [
    {
      "id": 3,
      "business_id": 12,
      "code": "SUMMER10",
      "description": "10% off",
      "discount_type": "percent",
      "value": 10,
      "starts_at": null,
      "expires_at": null,
      "max_redemptions": null,
      "times_redeemed": 2,
      "active": true,
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

## Not changed

- `GET /businesses/me` already works regardless of status — still the right
  call for the business's own top-level record (name, address, tier, etc.).
- All the write routes (creating/editing services, categories, discounts,
  deleting the business) already go through `verifyBusinessOwnership` with
  `supabaseAdmin`, so they were never RLS-blocked — no changes needed there.
  It was specifically the *read* routes reused from the public page that hit
  RLS for pending businesses.
