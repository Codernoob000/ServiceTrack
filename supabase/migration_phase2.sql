-- ============================================================
-- ServiceTrack: Phase 2 Migration (Final Hardened Idempotent Revision)
-- File: supabase/migration_phase2.sql
-- Run this in the Supabase SQL Editor.
-- ============================================================

-- ------------------------------------------------------------
-- 1. SCHEMA ALIGNMENT: STORAGE_PATH COLUMN MIGRATION
-- ------------------------------------------------------------
-- Safely transitions images.url to images.storage_path across all states:
-- - If url exists and storage_path does not: rename column.
-- - If both exist: backfill any missing storage_path from url, then drop url.
-- - If storage_path exists and url does not: skip (already migrated).
-- - If neither exists: create storage_path.
-- Guarantees no existing image paths are silently discarded.
DO $$
DECLARE
  v_has_url BOOLEAN;
  v_has_storage_path BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'images' AND column_name = 'url'
  ) INTO v_has_url;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'images' AND column_name = 'storage_path'
  ) INTO v_has_storage_path;

  IF v_has_url AND NOT v_has_storage_path THEN
    ALTER TABLE public.images RENAME COLUMN url TO storage_path;
    RAISE NOTICE 'Renamed public.images.url to storage_path.';
  ELSIF v_has_url AND v_has_storage_path THEN
    UPDATE public.images
    SET storage_path = url
    WHERE (storage_path IS NULL OR storage_path = '') AND (url IS NOT NULL AND url <> '');

    IF EXISTS (SELECT 1 FROM public.images WHERE storage_path IS NULL OR storage_path = '') THEN
      RAISE EXCEPTION 'Cannot drop url: some rows in public.images have empty storage_path after backfill.';
    END IF;

    ALTER TABLE public.images DROP COLUMN url;
    RAISE NOTICE 'Backfilled storage_path from url and removed legacy url column.';
  ELSIF NOT v_has_url AND v_has_storage_path THEN
    RAISE NOTICE 'public.images.storage_path already exists; legacy url column absent.';
  ELSE
    ALTER TABLE public.images ADD COLUMN storage_path TEXT NOT NULL;
    RAISE NOTICE 'Created storage_path column on public.images.';
  END IF;
END $$;


-- ------------------------------------------------------------
-- 2. FOREIGN-KEY DEFINITION & CASCADE/RESTRICT CONTROLS
-- ------------------------------------------------------------
-- Explicit foreign-key inspection:
-- - Verifies single-column child and referenced columns.
-- - Verifies delete actions:
--     * requests -> images: ON DELETE CASCADE
--       There is no delete route for requests; vehicle history is protected
--       by vehicles.user_id -> users.id ON DELETE RESTRICT.  CASCADE here
--       lets test teardown and future admin delete succeed without manual cleanup.
--     * images -> pins: ON DELETE CASCADE (deleting image removes defect pins)
--     * pins -> repair_items: ON DELETE CASCADE (deleting pin removes repair item)
-- - Checks for orphaned child records before any constraint creation.
-- - Avoids dropping and recreating constraints when definition already matches.

-- 2.1 Foreign Key: public.images(request_id) -> public.requests(id) [ON DELETE CASCADE]
DO $$
DECLARE
  v_match_conname TEXT;
  v_confdeltype "char";
  v_conflicting_conname TEXT;
  v_orphans INT;
BEGIN
  -- Look for exact single-column FK on images(request_id) referencing requests(id)
  SELECT c.conname, c.confdeltype
  INTO v_match_conname, v_confdeltype
  FROM pg_constraint c
  JOIN pg_attribute a_child ON a_child.attrelid = c.conrelid AND a_child.attnum = c.conkey[1]
  JOIN pg_attribute a_ref   ON a_ref.attrelid   = c.confrelid AND a_ref.attnum   = c.confkey[1]
  WHERE c.conrelid = 'public.images'::regclass
    AND c.confrelid = 'public.requests'::regclass
    AND c.contype = 'f'
    AND array_length(c.conkey, 1) = 1
    AND array_length(c.confkey, 1) = 1
    AND a_child.attname = 'request_id'
    AND a_ref.attname = 'id'
  LIMIT 1;

  IF v_match_conname IS NOT NULL AND v_confdeltype = 'c' THEN
    RAISE NOTICE 'images(request_id) -> requests(id) already has ON DELETE CASCADE via constraint %.', v_match_conname;
  ELSE
    -- Check for orphaned child records first
    SELECT count(*) INTO v_orphans
    FROM public.images i
    WHERE NOT EXISTS (SELECT 1 FROM public.requests r WHERE r.id = i.request_id);

    IF v_orphans > 0 THEN
      RAISE EXCEPTION 'Cannot enforce FK on public.images: % orphaned rows point to non-existent requests.', v_orphans;
    END IF;

    -- Drop any conflicting FK on request_id
    FOR v_conflicting_conname IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.conrelid = 'public.images'::regclass
        AND c.contype = 'f'
        AND array_length(c.conkey, 1) = 1
        AND a.attname = 'request_id'
    LOOP
      EXECUTE format('ALTER TABLE public.images DROP CONSTRAINT %I', v_conflicting_conname);
      RAISE NOTICE 'Dropped conflicting constraint % on public.images.', v_conflicting_conname;
    END LOOP;

    ALTER TABLE public.images
      ADD CONSTRAINT images_request_id_fkey
      FOREIGN KEY (request_id) REFERENCES public.requests(id) ON DELETE CASCADE;
    RAISE NOTICE 'Created constraint images_request_id_fkey with ON DELETE CASCADE.';
  END IF;
END $$;

-- 2.2 Foreign Key: public.pins(image_id) -> public.images(id) [ON DELETE CASCADE]
DO $$
DECLARE
  v_match_conname TEXT;
  v_confdeltype "char";
  v_conflicting_conname TEXT;
  v_orphans INT;
BEGIN
  SELECT c.conname, c.confdeltype
  INTO v_match_conname, v_confdeltype
  FROM pg_constraint c
  JOIN pg_attribute a_child ON a_child.attrelid = c.conrelid AND a_child.attnum = c.conkey[1]
  JOIN pg_attribute a_ref   ON a_ref.attrelid   = c.confrelid AND a_ref.attnum   = c.confkey[1]
  WHERE c.conrelid = 'public.pins'::regclass
    AND c.confrelid = 'public.images'::regclass
    AND c.contype = 'f'
    AND array_length(c.conkey, 1) = 1
    AND array_length(c.confkey, 1) = 1
    AND a_child.attname = 'image_id'
    AND a_ref.attname = 'id'
  LIMIT 1;

  IF v_match_conname IS NOT NULL AND v_confdeltype = 'c' THEN
    RAISE NOTICE 'pins(image_id) -> images(id) already has ON DELETE CASCADE via constraint %.', v_match_conname;
  ELSE
    SELECT count(*) INTO v_orphans
    FROM public.pins p
    WHERE NOT EXISTS (SELECT 1 FROM public.images i WHERE i.id = p.image_id);

    IF v_orphans > 0 THEN
      RAISE EXCEPTION 'Cannot enforce FK on public.pins: % orphaned rows point to non-existent images.', v_orphans;
    END IF;

    FOR v_conflicting_conname IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.conrelid = 'public.pins'::regclass
        AND c.contype = 'f'
        AND array_length(c.conkey, 1) = 1
        AND a.attname = 'image_id'
    LOOP
      EXECUTE format('ALTER TABLE public.pins DROP CONSTRAINT %I', v_conflicting_conname);
      RAISE NOTICE 'Dropped conflicting constraint % on public.pins.', v_conflicting_conname;
    END LOOP;

    ALTER TABLE public.pins
      ADD CONSTRAINT pins_image_id_fkey
      FOREIGN KEY (image_id) REFERENCES public.images(id) ON DELETE CASCADE;
    RAISE NOTICE 'Created constraint pins_image_id_fkey with ON DELETE CASCADE.';
  END IF;
END $$;

-- 2.3 Foreign Key: public.repair_items(pin_id) -> public.pins(id) [ON DELETE CASCADE]
DO $$
DECLARE
  v_match_conname TEXT;
  v_confdeltype "char";
  v_conflicting_conname TEXT;
  v_orphans INT;
BEGIN
  SELECT c.conname, c.confdeltype
  INTO v_match_conname, v_confdeltype
  FROM pg_constraint c
  JOIN pg_attribute a_child ON a_child.attrelid = c.conrelid AND a_child.attnum = c.conkey[1]
  JOIN pg_attribute a_ref   ON a_ref.attrelid   = c.confrelid AND a_ref.attnum   = c.confkey[1]
  WHERE c.conrelid = 'public.repair_items'::regclass
    AND c.confrelid = 'public.pins'::regclass
    AND c.contype = 'f'
    AND array_length(c.conkey, 1) = 1
    AND array_length(c.confkey, 1) = 1
    AND a_child.attname = 'pin_id'
    AND a_ref.attname = 'id'
  LIMIT 1;

  IF v_match_conname IS NOT NULL AND v_confdeltype = 'c' THEN
    RAISE NOTICE 'repair_items(pin_id) -> pins(id) already has ON DELETE CASCADE via constraint %.', v_match_conname;
  ELSE
    SELECT count(*) INTO v_orphans
    FROM public.repair_items ri
    WHERE NOT EXISTS (SELECT 1 FROM public.pins p WHERE p.id = ri.pin_id);

    IF v_orphans > 0 THEN
      RAISE EXCEPTION 'Cannot enforce FK on public.repair_items: % orphaned rows point to non-existent pins.', v_orphans;
    END IF;

    FOR v_conflicting_conname IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.conrelid = 'public.repair_items'::regclass
        AND c.contype = 'f'
        AND array_length(c.conkey, 1) = 1
        AND a.attname = 'pin_id'
    LOOP
      EXECUTE format('ALTER TABLE public.repair_items DROP CONSTRAINT %I', v_conflicting_conname);
      RAISE NOTICE 'Dropped conflicting constraint % on public.repair_items.', v_conflicting_conname;
    END LOOP;

    ALTER TABLE public.repair_items
      ADD CONSTRAINT repair_items_pin_id_fkey
      FOREIGN KEY (pin_id) REFERENCES public.pins(id) ON DELETE CASCADE;
    RAISE NOTICE 'Created constraint repair_items_pin_id_fkey with ON DELETE CASCADE.';
  END IF;
END $$;


-- ------------------------------------------------------------
-- 3. UNIQUE & CHECK CONSTRAINTS (IDEMPOTENT & PRE-CHECKED)
-- ------------------------------------------------------------

-- 3.1 Unique constraint on repair_items(pin_id)
DO $$
DECLARE
  v_match_conname TEXT;
  v_dupes INT;
BEGIN
  SELECT c.conname INTO v_match_conname
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.conrelid = 'public.repair_items'::regclass
    AND c.contype = 'u'
    AND array_length(c.conkey, 1) = 1
    AND a.attname = 'pin_id'
  LIMIT 1;

  IF v_match_conname IS NOT NULL THEN
    RAISE NOTICE 'Unique constraint on public.repair_items(pin_id) already exists via %.', v_match_conname;
  ELSE
    SELECT count(*) INTO v_dupes
    FROM (
      SELECT pin_id FROM public.repair_items GROUP BY pin_id HAVING count(*) > 1
    ) sub;

    IF v_dupes > 0 THEN
      RAISE EXCEPTION 'Cannot enforce unique repair item per pin: % pin_ids have duplicate repair items.', v_dupes;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.repair_items'::regclass
        AND conname = 'repair_items_pin_id_unique'
    ) THEN
      ALTER TABLE public.repair_items DROP CONSTRAINT repair_items_pin_id_unique;
    END IF;

    ALTER TABLE public.repair_items
      ADD CONSTRAINT repair_items_pin_id_unique UNIQUE (pin_id);
    RAISE NOTICE 'Created constraint repair_items_pin_id_unique.';
  END IF;
END $$;

-- 3.2 Coordinate constraints: pins.x and pins.y between 0 and 1
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.pins'::regclass AND conname = 'pins_x_check' AND contype = 'c'
  ) THEN
    IF EXISTS (SELECT 1 FROM public.pins WHERE x IS NULL OR x < 0 OR x > 1) THEN
      RAISE EXCEPTION 'Cannot enforce pins_x_check: rows exist with x outside [0, 1] or NULL.';
    END IF;
    ALTER TABLE public.pins ADD CONSTRAINT pins_x_check CHECK (x >= 0 AND x <= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.pins'::regclass AND conname = 'pins_y_check' AND contype = 'c'
  ) THEN
    IF EXISTS (SELECT 1 FROM public.pins WHERE y IS NULL OR y < 0 OR y > 1) THEN
      RAISE EXCEPTION 'Cannot enforce pins_y_check: rows exist with y outside [0, 1] or NULL.';
    END IF;
    ALTER TABLE public.pins ADD CONSTRAINT pins_y_check CHECK (y >= 0 AND y <= 1);
  END IF;
END $$;

-- 3.3 Whole-rupee estimate constraint [0, 1000000]
DO $$
DECLARE
  v_invalid INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.repair_items'::regclass
      AND conname = 'repair_items_estimate_check'
      AND contype = 'c'
  ) THEN
    SELECT count(*) INTO v_invalid
    FROM public.repair_items
    WHERE estimate IS NULL OR estimate < 0 OR estimate > 1000000 OR estimate <> trunc(estimate);

    IF v_invalid > 0 THEN
      RAISE EXCEPTION 'Cannot enforce repair_items_estimate_check: % rows violate whole-rupee [0, 1000000].', v_invalid;
    END IF;

    ALTER TABLE public.repair_items
      ADD CONSTRAINT repair_items_estimate_check
      CHECK (estimate >= 0 AND estimate <= 1000000 AND estimate = trunc(estimate));
    RAISE NOTICE 'Created constraint repair_items_estimate_check.';
  END IF;
END $$;

-- 3.4 Text-length constraints with non-empty/whitespace enforcement
DO $$
DECLARE
  v_invalid INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.pins'::regclass
      AND conname = 'pins_part_name_length_check'
      AND contype = 'c'
  ) THEN
    SELECT count(*) INTO v_invalid
    FROM public.pins
    WHERE part_name IS NULL OR char_length(trim(part_name)) < 1 OR char_length(part_name) > 100;

    IF v_invalid > 0 THEN
      RAISE EXCEPTION 'Cannot enforce pins_part_name_length_check: % rows violate 1-100 character rules.', v_invalid;
    END IF;

    ALTER TABLE public.pins
      ADD CONSTRAINT pins_part_name_length_check
      CHECK (char_length(trim(part_name)) >= 1 AND char_length(part_name) <= 100);
    RAISE NOTICE 'Created constraint pins_part_name_length_check.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.pins'::regclass
      AND conname = 'pins_notes_length_check'
      AND contype = 'c'
  ) THEN
    SELECT count(*) INTO v_invalid
    FROM public.pins
    WHERE notes IS NOT NULL AND char_length(notes) > 1000;

    IF v_invalid > 0 THEN
      RAISE EXCEPTION 'Cannot enforce pins_notes_length_check: % rows exceed 1000 characters.', v_invalid;
    END IF;

    ALTER TABLE public.pins
      ADD CONSTRAINT pins_notes_length_check
      CHECK (notes IS NULL OR char_length(notes) <= 1000);
    RAISE NOTICE 'Created constraint pins_notes_length_check.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.repair_items'::regclass
      AND conname = 'repair_items_description_length_check'
      AND contype = 'c'
  ) THEN
    SELECT count(*) INTO v_invalid
    FROM public.repair_items
    WHERE description IS NULL OR char_length(trim(description)) < 1 OR char_length(description) > 500;

    IF v_invalid > 0 THEN
      RAISE EXCEPTION 'Cannot enforce repair_items_description_length_check: % rows violate 1-500 character rules.', v_invalid;
    END IF;

    ALTER TABLE public.repair_items
      ADD CONSTRAINT repair_items_description_length_check
      CHECK (char_length(trim(description)) >= 1 AND char_length(description) <= 500);
    RAISE NOTICE 'Created constraint repair_items_description_length_check.';
  END IF;
END $$;

-- 3.5 CHECK constraint on images.view_angle
DO $$
DECLARE
  v_invalid INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.images'::regclass
      AND conname = 'images_view_angle_check'
      AND contype = 'c'
  ) THEN
    SELECT count(*) INTO v_invalid
    FROM public.images
    WHERE view_angle IS NULL
       OR view_angle NOT IN ('front', 'rear', 'left', 'right', 'other');

    IF v_invalid > 0 THEN
      RAISE EXCEPTION 'Cannot enforce images_view_angle_check: % rows have invalid view_angle values.', v_invalid;
    END IF;

    ALTER TABLE public.images
      ADD CONSTRAINT images_view_angle_check
      CHECK (view_angle IN ('front', 'rear', 'left', 'right', 'other'));
    RAISE NOTICE 'Created constraint images_view_angle_check.';
  END IF;
END $$;

-- 3.6 Query performance indexes
CREATE INDEX IF NOT EXISTS idx_images_req_angle ON public.images (request_id, view_angle);
CREATE INDEX IF NOT EXISTS idx_pins_image_id     ON public.pins (image_id);
CREATE INDEX IF NOT EXISTS idx_repair_items_pin  ON public.repair_items (pin_id);

-- NOTE: created_at columns verified present on images, pins, and repair_items
-- in Phase 1 migration (supabase/migration.sql lines 56, 67, 79).
-- No additions needed here.


-- ------------------------------------------------------------
-- 4. DATABASE-LEVEL LOCKING, IMMUTABILITY & LIFECYCLE TRIGGERS
-- ------------------------------------------------------------

-- 4.1 Trigger Function for public.images
CREATE OR REPLACE FUNCTION public.check_images_inspecting_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req_id UUID;
  v_status TEXT;
  v_image_count INT;
BEGIN
  -- Immutable identity and parent reference
  IF (TG_OP = 'UPDATE') THEN
    IF (NEW.id IS DISTINCT FROM OLD.id) THEN
      RAISE EXCEPTION 'id is immutable and cannot be modified' USING ERRCODE = 'P0007';
    END IF;
    IF (NEW.request_id IS DISTINCT FROM OLD.request_id) THEN
      RAISE EXCEPTION 'request_id is immutable and cannot be modified' USING ERRCODE = 'P0007';
    END IF;
    IF (NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
      RAISE EXCEPTION 'created_at is immutable and cannot be modified' USING ERRCODE = 'P0007';
    END IF;
  END IF;

  IF (TG_OP = 'DELETE') THEN
    v_req_id := OLD.request_id;
  ELSE
    v_req_id := NEW.request_id;
  END IF;

  -- On INSERT: serialize uploads per request via FOR UPDATE to eliminate image-cap and submit race conditions
  -- On UPDATE or DELETE: acquire FOR SHARE lock
  IF (TG_OP = 'INSERT') THEN
    SELECT status INTO v_status
    FROM public.requests
    WHERE id = v_req_id
    FOR UPDATE;
  ELSE
    SELECT status INTO v_status
    FROM public.requests
    WHERE id = v_req_id
    FOR SHARE;
  END IF;

  -- Cascade-delete handling: if parent request was already removed, allow delete
  IF (TG_OP = 'DELETE') AND (v_status IS NULL) THEN
    RETURN OLD;
  END IF;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Service request % not found', v_req_id USING ERRCODE = '23503';
  END IF;

  IF v_status <> 'inspecting' THEN
    RAISE EXCEPTION 'Cannot modify images: request status is % (must be inspecting)', v_status USING ERRCODE = 'P0001';
  END IF;

  -- Enforce 10-image maximum cap on INSERT under the FOR UPDATE lock
  IF (TG_OP = 'INSERT') THEN
    SELECT count(*) INTO v_image_count
    FROM public.images
    WHERE request_id = NEW.request_id;

    IF v_image_count >= 10 THEN
      RAISE EXCEPTION 'Maximum limit of 10 images reached for request %', NEW.request_id USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF (TG_OP = 'DELETE') THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_images_inspecting_lock ON public.images;
CREATE TRIGGER trg_images_inspecting_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.images
  FOR EACH ROW
  EXECUTE FUNCTION public.check_images_inspecting_lock();


-- 4.2 Trigger Function for public.pins
CREATE OR REPLACE FUNCTION public.check_pins_inspecting_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_image_id UUID;
  v_req_id UUID;
  v_status TEXT;
BEGIN
  -- Immutable identity and parent reference
  IF (TG_OP = 'UPDATE') THEN
    IF (NEW.id IS DISTINCT FROM OLD.id) THEN
      RAISE EXCEPTION 'id is immutable and cannot be modified' USING ERRCODE = 'P0007';
    END IF;
    IF (NEW.image_id IS DISTINCT FROM OLD.image_id) THEN
      RAISE EXCEPTION 'image_id is immutable and cannot be modified' USING ERRCODE = 'P0007';
    END IF;
    IF (NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
      RAISE EXCEPTION 'created_at is immutable and cannot be modified' USING ERRCODE = 'P0007';
    END IF;
  END IF;

  IF (TG_OP = 'DELETE') THEN
    v_image_id := OLD.image_id;
  ELSE
    v_image_id := NEW.image_id;
  END IF;

  SELECT request_id INTO v_req_id
  FROM public.images
  WHERE id = v_image_id;

  -- Cascade-delete handling: if parent image was already removed in cascade, allow delete
  IF (TG_OP = 'DELETE') AND (v_req_id IS NULL) THEN
    RETURN OLD;
  END IF;

  IF v_req_id IS NOT NULL THEN
    SELECT status INTO v_status
    FROM public.requests
    WHERE id = v_req_id
    FOR SHARE;

    -- Cascade-delete handling: if request is absent, allow delete
    IF (TG_OP = 'DELETE') AND (v_status IS NULL) THEN
      RETURN OLD;
    END IF;

    IF v_status IS NOT NULL AND v_status <> 'inspecting' THEN
      RAISE EXCEPTION 'Cannot modify pins: request status is % (must be inspecting)', v_status USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF (TG_OP <> 'DELETE') THEN
      RAISE EXCEPTION 'Image % not found for pin', v_image_id USING ERRCODE = '23503';
    END IF;
  END IF;

  IF (TG_OP = 'DELETE') THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pins_inspecting_lock ON public.pins;
CREATE TRIGGER trg_pins_inspecting_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.pins
  FOR EACH ROW
  EXECUTE FUNCTION public.check_pins_inspecting_lock();


-- 4.3 Trigger Function for public.repair_items
CREATE OR REPLACE FUNCTION public.check_repair_items_inspecting_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pin_id UUID;
  v_status TEXT;
BEGIN
  -- Strict immutability for identity and creation metadata
  IF (TG_OP = 'UPDATE') THEN
    IF (NEW.id IS DISTINCT FROM OLD.id) THEN
      RAISE EXCEPTION 'id is immutable and cannot be modified' USING ERRCODE = 'P0007';
    END IF;
    IF (NEW.pin_id IS DISTINCT FROM OLD.pin_id) THEN
      RAISE EXCEPTION 'pin_id is immutable and cannot be modified' USING ERRCODE = 'P0007';
    END IF;
    IF (NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
      RAISE EXCEPTION 'created_at is immutable and cannot be modified' USING ERRCODE = 'P0007';
    END IF;
  END IF;

  IF (TG_OP = 'DELETE') THEN
    v_pin_id := OLD.pin_id;
  ELSE
    v_pin_id := NEW.pin_id;
  END IF;

  -- Look up parent request status
  SELECT r.status INTO v_status
  FROM public.pins p
  JOIN public.images i ON i.id = p.image_id
  JOIN public.requests r ON r.id = i.request_id
  WHERE p.id = v_pin_id
  FOR SHARE OF r;

  -- Cascade-delete handling: if parent pin/image/request was already removed in cascade, allow delete
  IF (TG_OP = 'DELETE') THEN
    IF (v_status IS NULL) THEN
      RETURN OLD;
    END IF;

    IF v_status <> 'inspecting' THEN
      RAISE EXCEPTION 'Cannot delete repair items: request status is % (must be inspecting)', v_status USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  -- INSERT check: parent must exist and request must be in 'inspecting'
  IF (TG_OP = 'INSERT') THEN
    IF v_status IS NULL THEN
      RAISE EXCEPTION 'Parent pin or request not found for repair item' USING ERRCODE = '23503';
    END IF;

    IF v_status <> 'inspecting' THEN
      RAISE EXCEPTION 'Cannot create repair items: request status is % (must be inspecting)', v_status USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE check:
  IF (TG_OP = 'UPDATE') THEN
    IF v_status IS NULL THEN
      RAISE EXCEPTION 'Parent pin or request not found for repair item' USING ERRCODE = '23503';
    END IF;

    -- While request is NOT 'inspecting', strictly whitelist only lifecycle updates:
    -- Only approval_status, after_photo_url, and completed_at may change.
    -- description and estimate are strictly locked.
    IF v_status <> 'inspecting' THEN
      IF (NEW.description IS DISTINCT FROM OLD.description) THEN
        RAISE EXCEPTION 'Cannot modify description when request status is % (must be inspecting)', v_status USING ERRCODE = 'P0001';
      END IF;
      IF (NEW.estimate IS DISTINCT FROM OLD.estimate) THEN
        RAISE EXCEPTION 'Cannot modify estimate when request status is % (must be inspecting)', v_status USING ERRCODE = 'P0001';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_repair_items_inspecting_lock ON public.repair_items;
CREATE TRIGGER trg_repair_items_inspecting_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.repair_items
  FOR EACH ROW
  EXECUTE FUNCTION public.check_repair_items_inspecting_lock();


-- ------------------------------------------------------------
-- 5. ATOMIC STATE TRANSITION FUNCTIONS
-- ------------------------------------------------------------

-- 5.1 submit_inspection_report:
-- Atomically validates assigned mechanic, 'inspecting' status,
-- requires >= 1 image AND >= 1 pin with its associated repair item,
-- locks request FOR UPDATE, and transitions status to 'awaiting_approval'.
CREATE OR REPLACE FUNCTION public.submit_inspection_report(
  p_request_id UUID,
  p_caller_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status TEXT;
  v_mechanic_id UUID;
  v_image_count INT;
  v_pin_count INT;
BEGIN
  -- Lock request FOR UPDATE to serialize against concurrent uploads/edits
  SELECT status, mechanic_id INTO v_status, v_mechanic_id
  FROM public.requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Request % not found', p_request_id USING ERRCODE = 'P0002';
  END IF;

  IF v_mechanic_id IS DISTINCT FROM p_caller_id THEN
    RAISE EXCEPTION 'Unauthorized: caller is not the assigned mechanic' USING ERRCODE = 'P0003';
  END IF;

  IF v_status <> 'inspecting' THEN
    RAISE EXCEPTION 'Conflict: request status is % (must be inspecting)', v_status USING ERRCODE = 'P0004';
  END IF;

  -- Require at least one inspection image
  SELECT count(*) INTO v_image_count
  FROM public.images
  WHERE request_id = p_request_id;

  IF v_image_count = 0 THEN
    RAISE EXCEPTION 'Cannot submit report without inspection images' USING ERRCODE = 'P0005';
  END IF;

  -- Require at least one defect pin with its associated repair item
  SELECT count(DISTINCT p.id) INTO v_pin_count
  FROM public.pins p
  JOIN public.images i ON i.id = p.image_id
  JOIN public.repair_items ri ON ri.pin_id = p.id
  WHERE i.request_id = p_request_id;

  IF v_pin_count = 0 THEN
    RAISE EXCEPTION 'Cannot submit report without at least one defect pin and repair item' USING ERRCODE = 'P0008';
  END IF;

  UPDATE public.requests
  SET status = 'awaiting_approval'
  WHERE id = p_request_id;

  RETURN jsonb_build_object(
    'success', true,
    'request_id', p_request_id,
    'status', 'awaiting_approval',
    'image_count', v_image_count,
    'pin_count', v_pin_count
  );
END;
$$;

-- 5.2 release_inspection_job:
-- Locks request FOR UPDATE, checks caller is assigned mechanic,
-- checks status is 'inspecting', checks exactly 0 images uploaded,
-- resets status to 'booked' and mechanic_id to NULL.
CREATE OR REPLACE FUNCTION public.release_inspection_job(
  p_request_id UUID,
  p_caller_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status TEXT;
  v_mechanic_id UUID;
  v_image_count INT;
BEGIN
  -- Lock request FOR UPDATE
  SELECT status, mechanic_id INTO v_status, v_mechanic_id
  FROM public.requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Request % not found', p_request_id USING ERRCODE = 'P0002';
  END IF;

  IF v_mechanic_id IS DISTINCT FROM p_caller_id THEN
    RAISE EXCEPTION 'Unauthorized: caller is not the assigned mechanic' USING ERRCODE = 'P0003';
  END IF;

  IF v_status <> 'inspecting' THEN
    RAISE EXCEPTION 'Conflict: request status is % (must be inspecting)', v_status USING ERRCODE = 'P0004';
  END IF;

  SELECT count(*) INTO v_image_count
  FROM public.images
  WHERE request_id = p_request_id;

  IF v_image_count > 0 THEN
    RAISE EXCEPTION 'Conflict: cannot release job after inspection images have been uploaded' USING ERRCODE = 'P0006';
  END IF;

  UPDATE public.requests
  SET status = 'booked',
      mechanic_id = NULL
  WHERE id = p_request_id;

  RETURN jsonb_build_object(
    'success', true,
    'request_id', p_request_id,
    'status', 'booked'
  );
END;
$$;


-- ------------------------------------------------------------
-- 6. ATOMIC PIN & REPAIR ITEM CREATION
-- ------------------------------------------------------------

-- create_pin_with_item:
-- Validates caller, request status, image ownership,
-- and creates pin + repair item atomically in one transaction.
CREATE OR REPLACE FUNCTION public.create_pin_with_item(
  p_request_id UUID,
  p_caller_id UUID,
  p_image_id UUID,
  p_x NUMERIC,
  p_y NUMERIC,
  p_part_name TEXT,
  p_severity TEXT,
  p_notes TEXT,
  p_description TEXT,
  p_estimate NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status TEXT;
  v_mechanic_id UUID;
  v_pin_id UUID;
  v_item_id UUID;
BEGIN
  -- Verify image belongs to this request and lock request FOR SHARE
  SELECT r.status, r.mechanic_id INTO v_status, v_mechanic_id
  FROM public.requests r
  JOIN public.images i ON i.request_id = r.id
  WHERE r.id = p_request_id AND i.id = p_image_id
  FOR SHARE OF r;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Image does not belong to request or request not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_mechanic_id IS DISTINCT FROM p_caller_id THEN
    RAISE EXCEPTION 'Unauthorized: caller is not the assigned mechanic' USING ERRCODE = 'P0003';
  END IF;

  IF v_status <> 'inspecting' THEN
    RAISE EXCEPTION 'Conflict: request status is % (must be inspecting)', v_status USING ERRCODE = 'P0004';
  END IF;

  -- Insert pin (length and coordinate checks enforced by table constraints)
  INSERT INTO public.pins (image_id, x, y, part_name, severity, notes)
  VALUES (p_image_id, p_x, p_y, p_part_name, p_severity, p_notes)
  RETURNING id INTO v_pin_id;

  -- Insert single repair item (whole rupee estimate enforced by table constraint)
  INSERT INTO public.repair_items (pin_id, description, estimate, approval_status)
  VALUES (v_pin_id, p_description, p_estimate, 'pending')
  RETURNING id INTO v_item_id;

  RETURN jsonb_build_object(
    'pin_id', v_pin_id,
    'item_id', v_item_id,
    'image_id', p_image_id,
    'x', p_x,
    'y', p_y,
    'part_name', p_part_name,
    'severity', p_severity,
    'notes', p_notes,
    'description', p_description,
    'estimate', p_estimate,
    'approval_status', 'pending'
  );
END;
$$;


-- ------------------------------------------------------------
-- 7. PERMISSIONS & PRIVILEGE LOCKDOWN
-- ------------------------------------------------------------
-- Revoke all table privileges from PUBLIC, anon, and authenticated.
-- Only the service role key can access or mutate images, pins, and repair_items.
REVOKE ALL ON TABLE public.images, public.pins, public.repair_items FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.images, public.pins, public.repair_items TO service_role;

-- Revoke all function execution privileges from PUBLIC, anon, and authenticated.
-- Restrict execution solely to service_role.
REVOKE ALL ON FUNCTION public.submit_inspection_report(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_inspection_report(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.release_inspection_job(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_inspection_job(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.create_pin_with_item(UUID, UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_pin_with_item(UUID, UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, NUMERIC) TO service_role;

-- Lock down trigger functions against direct execution
REVOKE ALL ON FUNCTION public.check_images_inspecting_lock() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_pins_inspecting_lock() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_repair_items_inspecting_lock() FROM PUBLIC, anon, authenticated;


-- ============================================================
-- 8. LIVE-DATABASE TEST PLAN
-- ============================================================
-- Run these tests against the actual Supabase project database.
--
-- T1: IDEMPOTENCY
--     Run this migration file twice in succession.
--     Expected: second run produces no errors and no NOTICE messages
--     indicating constraint/trigger recreation.
--
-- T2: CASCADE DELETE
--     Create a request (status 'inspecting') with images, pins, and
--     repair_items.  DELETE the request row.
--     Expected: all child images, pins, and repair_items are cascade-
--     deleted.  No orphaned rows remain.
--
-- T3: CONCURRENT IMAGE CAP (11-way race)
--     Using 11 concurrent database connections, each attempts to INSERT
--     one image for the same request (status 'inspecting').
--     Expected: exactly 10 succeed; exactly 1 fails with ERRCODE P0001
--     ("Maximum limit of 10 images reached").
--
-- T4: IMAGE INSERT vs SUBMIT RACE
--     Connection A begins an image INSERT (inside a transaction, paused
--     after acquiring the FOR UPDATE lock on the request row).
--     Connection B calls submit_inspection_report for the same request.
--     Then Connection A commits.
--     Expected: one of two outcomes:
--       a) The image INSERT commits first; submit_inspection_report
--          sees and counts it (image_count includes the new image).
--       b) submit_inspection_report acquires the lock first and
--          transitions the request to 'awaiting_approval'; the image
--          INSERT then fails with "request status is awaiting_approval".
--     Never: an image silently inserted after status is 'awaiting_approval'.
--
-- T5: TRIGGER IMMUTABILITY ENFORCEMENT
--     Attempt to UPDATE images.id, images.request_id, images.created_at,
--     pins.id, pins.image_id, pins.created_at, repair_items.id,
--     repair_items.pin_id, repair_items.created_at.
--     Expected: each attempt fails with ERRCODE P0007.
--
-- T6: VIEW_ANGLE CHECK
--     Attempt to INSERT an image with view_angle = 'top'.
--     Expected: fails with check constraint violation.
--     INSERT with view_angle = 'front' succeeds.
