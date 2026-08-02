-- 022: business_photos.photo_url stores the public URL, but deleting a photo
-- needs the storage object's actual path, not the public URL — parsing it back
-- out of the URL is fragile (breaks if the URL scheme/CDN domain ever changes).
-- storage_path is the source of truth for storage operations; photo_url stays
-- what the frontend renders directly.
ALTER TABLE business_photos ADD COLUMN storage_path TEXT;
