-- 030: adds social media link clicks to the analytics event_type enum
-- (migration 025), same anonymous click-tracking pattern as the existing
-- call/email/address/website/discount click types — no PII, just a count of
-- clicks on a business's Facebook/Instagram/Yelp links from their listing page.
ALTER TABLE business_analytics_events DROP CONSTRAINT business_analytics_events_event_type_check;
ALTER TABLE business_analytics_events ADD CONSTRAINT business_analytics_events_event_type_check CHECK (
  event_type IN (
    'call_click', 'email_click', 'page_view', 'address_click', 'website_click', 'discount_click',
    'facebook_click', 'instagram_click', 'yelp_click'
  )
);
