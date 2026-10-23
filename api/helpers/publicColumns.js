// helpers/publicColumns.js
//
// Column list for every public (or other-user-facing) read of `businesses`,
// used in place of select('*') so billing/internal fields never leave the API:
// owner_user_id, is_comped, stripe_customer_id, stripe_subscription_id.
// Owner (GET /businesses/me) and admin routes still select('*').
//
// Embedded relations still work without owner_user_id in the list — e.g.
// `${PUBLIC_BUSINESS_COLUMNS}, users(first_name)` — PostgREST resolves the join
// from the foreign key, not from the selected columns.
//
// Adding a new column to `businesses` that the public should see? Add it here.
export const PUBLIC_BUSINESS_COLUMNS = [
    'id', 'name', 'description', 'address', 'city', 'state', 'zip', 'phone', 'email', 'slug',
    'status', 'business_tier', 'pilot_business', 'is_featured', 'featured_since', 'in_carousel',
    'latitude', 'longitude', 'neighborhood', 'geocoded_at',
    'website_url', 'about_owner', 'facebook_url', 'instagram_url', 'yelp_url',
    'timeline_year_1', 'timeline_description_1',
    'timeline_year_2', 'timeline_description_2',
    'timeline_year_3', 'timeline_description_3',
    'hours', 'search_vector', 'created_at', 'updated_at'
].join(', ');
