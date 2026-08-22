-- 034: give businesses their own search_vector, mirroring what services
-- already has (see schema.sql). /search's free-text passes previously only
-- matched against services.name/description — a business's own name or
-- description was never searched directly, so looking someone up by the
-- actual name of their business could silently return nothing unless the
-- term also happened to appear in one of that business's service names or
-- descriptions. This backs the new businesses-table match pass in
-- api/routes/search.js.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;

CREATE OR REPLACE FUNCTION update_business_search_vector()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector = to_tsvector('english', coalesce(NEW.name, '') || ' ' || coalesce(NEW.description, ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_business_search_vector ON businesses;

CREATE TRIGGER trigger_update_business_search_vector
BEFORE UPDATE OR INSERT ON businesses
FOR EACH ROW EXECUTE FUNCTION update_business_search_vector();

CREATE INDEX IF NOT EXISTS idx_businesses_search ON businesses USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_businesses_trgm ON businesses USING GIN(name gin_trgm_ops);

-- Backfill existing rows — the trigger above only fires on future
-- INSERT/UPDATE, so without this every business created before this
-- migration would have a NULL search_vector until its next edit.
UPDATE businesses
SET search_vector = to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, ''));
