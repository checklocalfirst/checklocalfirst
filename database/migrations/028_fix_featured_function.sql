
  CREATE OR REPLACE FUNCTION set_featured_business(target_business_id INTEGER)
  RETURNS TABLE (
      id INTEGER,
      name VARCHAR,
      is_featured BOOLEAN,
      featured_since TIMESTAMPTZ
  ) AS $$
  BEGIN
      UPDATE businesses
      SET is_featured = false, featured_since = NULL
      WHERE businesses.is_featured = true;   -- was: WHERE is_featured = true

      UPDATE businesses
      SET is_featured = true, featured_since = NOW()
      WHERE businesses.id = target_business_id;

      RETURN QUERY
      SELECT b.id, b.name, b.is_featured, b.featured_since
      FROM businesses b
      WHERE b.id = target_business_id;
  END;
  $$ LANGUAGE plpgsql;