-- 029: timeline photo uploads. Each of the 3 existing timeline entries
-- (timeline_year_N / timeline_description_N, migration 016, premium-only) can
-- now have an associated photo. Reuses business_photos rather than adding a
-- new table — a timeline photo is still just a photo with display metadata,
-- same shape as listing/owner/gallery, it just needs to know which of the 3
-- slots it belongs to.
ALTER TABLE business_photos DROP CONSTRAINT business_photos_type_check;
ALTER TABLE business_photos ADD CONSTRAINT business_photos_type_check
  CHECK (photo_type IN ('listing', 'owner', 'gallery', 'timeline'));

-- Only meaningful when photo_type = 'timeline'; NULL for every other type.
ALTER TABLE business_photos ADD COLUMN timeline_slot SMALLINT;

ALTER TABLE business_photos ADD CONSTRAINT timeline_slot_consistency CHECK (
  (photo_type = 'timeline' AND timeline_slot IN (1, 2, 3))
  OR (photo_type != 'timeline' AND timeline_slot IS NULL)
);

-- One photo per business per timeline slot. Re-uploading a slot is a replace,
-- not a stack — the route deletes the old row/storage file for that slot
-- before inserting the new one, so this index should never actually reject a
-- request in normal use; it's the backstop against a race/bug doing otherwise.
CREATE UNIQUE INDEX one_photo_per_timeline_slot
  ON business_photos (business_id, timeline_slot) WHERE photo_type = 'timeline';
