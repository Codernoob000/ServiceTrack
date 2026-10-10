-- ============================================================
-- ServiceTrack: Phase 4 Migration
-- After-Photo Proof for Approved Repairs & Completion Rule
-- File: supabase/migration_phase4.sql
--
-- This migration is completely idempotent and safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. COLUMN DEFINITION, DOCUMENTATION & CHECK CONSTRAINT
--
-- repair_items.after_photo_url stores a storage PATH
-- (e.g. requests/{requestId}/after/{uuid}.jpg), NEVER a signed URL.
-- ------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'repair_items' AND column_name = 'after_photo_url'
  ) THEN
    ALTER TABLE public.repair_items ADD COLUMN after_photo_url TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'repair_items' AND column_name = 'completed_at'
  ) THEN
    ALTER TABLE public.repair_items ADD COLUMN completed_at TIMESTAMPTZ;
  END IF;
END $$;

-- Document that after_photo_url stores a storage path, never a signed URL
COMMENT ON COLUMN public.repair_items.after_photo_url IS 'Stores Supabase storage path (e.g. requests/{requestId}/after/{uuid}.jpg), never a signed URL.';

-- Check constraint: after_photo_url, when set, must start with 'requests/'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.repair_items'::regclass
      AND conname = 'repair_items_after_photo_url_path_check'
  ) THEN
    ALTER TABLE public.repair_items
      ADD CONSTRAINT repair_items_after_photo_url_path_check
      CHECK (after_photo_url IS NULL OR after_photo_url LIKE 'requests/%');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_repair_items_after_photo_url
  ON public.repair_items (after_photo_url)
  WHERE after_photo_url IS NOT NULL;


-- ------------------------------------------------------------
-- 2. TRIGGER: AFTER-PHOTO & COMPLETION LIFECYCLE LOCK
--
-- Enforces:
-- 1. after_photo_url and completed_at can only be set or modified
--    while parent request status is 'repairing' (P0015).
-- 2. after_photo_url and completed_at can only be set or modified
--    on items whose approval_status is 'approved' (P0016).
-- 3. INSERT guard: new repair items cannot be inserted with
--    after_photo_url or completed_at pre-set (P0016).
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_repair_items_after_photo_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status TEXT;
BEGIN
  -- 1. INSERT guard: new repair items cannot have after_photo_url or completed_at
  IF (TG_OP = 'INSERT') THEN
    IF NEW.after_photo_url IS NOT NULL OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'New repair items cannot have after_photo_url or completed_at'
        USING ERRCODE = 'P0016';
    END IF;
    RETURN NEW;
  END IF;

  -- 2. UPDATE guard: enforce lifecycle locks when after_photo_url or completed_at is modified
  IF (TG_OP = 'UPDATE') THEN
    IF (NEW.after_photo_url IS DISTINCT FROM OLD.after_photo_url OR NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
      -- Look up parent request status via pin -> image -> request
      SELECT r.status INTO v_status
      FROM public.pins p
      JOIN public.images i ON i.id = p.image_id
      JOIN public.requests r ON r.id = i.request_id
      WHERE p.id = NEW.pin_id
      FOR SHARE OF r;

      IF v_status IS NULL THEN
        RAISE EXCEPTION 'Parent request not found for repair item'
          USING ERRCODE = '23503';
      END IF;

      -- Can only change while parent request status is 'repairing'
      IF v_status <> 'repairing' THEN
        RAISE EXCEPTION 'Cannot modify after-photo or completed_at when request status is % (must be repairing)', v_status
          USING ERRCODE = 'P0015';
      END IF;

      -- Can only change for approved items
      IF NEW.approval_status <> 'approved' OR OLD.approval_status <> 'approved' THEN
        RAISE EXCEPTION 'Cannot modify after-photo or completed_at for non-approved repair item (status: %)', OLD.approval_status
          USING ERRCODE = 'P0016';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_repair_items_after_photo_lock ON public.repair_items;
CREATE TRIGGER trg_repair_items_after_photo_lock
  BEFORE INSERT OR UPDATE ON public.repair_items
  FOR EACH ROW
  EXECUTE FUNCTION public.check_repair_items_after_photo_lock();


-- ------------------------------------------------------------
-- 3. FUNCTION: ATTACH AFTER-PHOTO & ATOMIC COMPLETION RULE
--
-- Function: public.attach_after_photo(p_request_id, p_item_id, p_caller_id, p_path)
--
-- Parameters:
--   p_request_id UUID - Target service request ID
--   p_item_id    UUID - Repair item ID being documented
--   p_caller_id  UUID - Authenticated user ID (must be assigned mechanic)
--   p_path       TEXT - Storage path (must start with 'requests/' || p_request_id)
--
-- Rules & Protections:
--   - Locks the request row FOR UPDATE to prevent race conditions.
--   - Caller must be the assigned mechanic (P0011).
--   - Status must be 'repairing' (P0012).
--   - Path must start with 'requests/' || p_request_id (P0014).
--   - Repair item must belong to this request and be 'approved' (P0013).
--   - Sets after_photo_url = p_path and completed_at = now().
--   - If replacing a photo while 'repairing', records old path and updates timestamp.
--   - In the same transaction: if EVERY approved item of the request now has
--     an after photo, sets request status to 'done'.
--   - Once status is 'done', nothing can change.
--   - Returns item, old_after_photo_url, proof_count, total_approved, status.
--
-- Error codes (P0010 and above):
--   P0010 : Request not found (404)
--   P0011 : Caller is not assigned mechanic (403)
--   P0012 : Wrong request status (409)
--   P0013 : Item not approved or not in this request (400 / 404 / 409)
--   P0014 : Bad storage path (400)
--   P0015 : Trigger: request status not repairing (409)
--   P0016 : Trigger: item not approved (409 / 400)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.attach_after_photo(
  p_request_id UUID,
  p_item_id UUID,
  p_caller_id UUID,
  p_path TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status TEXT;
  v_mechanic_id UUID;
  v_item RECORD;
  v_old_after_photo_url TEXT;
  v_total_approved INT;
  v_approved_with_proof INT;
  v_new_status TEXT;
  v_updated_item RECORD;
BEGIN
  -- 1. Lock the request row FOR UPDATE
  SELECT r.status, r.mechanic_id
  INTO v_status, v_mechanic_id
  FROM public.requests r
  WHERE r.id = p_request_id
  FOR UPDATE OF r;

  -- Verify request exists
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Request not found: %', p_request_id
      USING ERRCODE = 'P0010';
  END IF;

  -- 2. Caller must be the assigned mechanic
  IF v_mechanic_id IS DISTINCT FROM p_caller_id THEN
    RAISE EXCEPTION 'Forbidden: Caller is not the assigned mechanic'
      USING ERRCODE = 'P0011';
  END IF;

  -- 3. Status must be 'repairing'
  IF v_status <> 'repairing' THEN
    RAISE EXCEPTION 'Conflict: Request status is % (must be repairing)', v_status
      USING ERRCODE = 'P0012';
  END IF;

  -- 4. Path must start with 'requests/' || p_request_id
  IF p_path IS NULL OR (p_path NOT LIKE ('requests/' || p_request_id::TEXT || '/%') AND p_path <> ('requests/' || p_request_id::TEXT)) THEN
    RAISE EXCEPTION 'Bad path: storage path must start with requests/%', p_request_id
      USING ERRCODE = 'P0014';
  END IF;

  -- 5. Repair item must belong to this request (via pin and image)
  SELECT ri.*
  INTO v_item
  FROM public.repair_items ri
  JOIN public.pins p ON p.id = ri.pin_id
  JOIN public.images i ON i.id = p.image_id
  WHERE ri.id = p_item_id AND i.request_id = p_request_id;

  IF v_item.id IS NULL THEN
    RAISE EXCEPTION 'Repair item not found in this request: %', p_item_id
      USING ERRCODE = 'P0013';
  END IF;

  -- Item must be approved
  IF v_item.approval_status <> 'approved' THEN
    RAISE EXCEPTION 'Repair item is not approved (status: %)', v_item.approval_status
      USING ERRCODE = 'P0013';
  END IF;

  v_old_after_photo_url := v_item.after_photo_url;

  -- 6. Set after_photo_url and completed_at = now()
  UPDATE public.repair_items
  SET after_photo_url = p_path,
      completed_at = now()
  WHERE id = p_item_id
  RETURNING * INTO v_updated_item;

  -- 7. Count total approved items and approved items with an after photo
  SELECT
    count(*),
    count(*) FILTER (WHERE ri.after_photo_url IS NOT NULL AND ri.after_photo_url <> '')
  INTO v_total_approved, v_approved_with_proof
  FROM public.repair_items ri
  JOIN public.pins p ON p.id = ri.pin_id
  JOIN public.images i ON i.id = p.image_id
  WHERE i.request_id = p_request_id
    AND ri.approval_status = 'approved';

  v_new_status := v_status;

  -- 8. If EVERY approved item now has an after photo, transition to 'done'
  IF v_total_approved > 0 AND v_approved_with_proof = v_total_approved THEN
    v_new_status := 'done';
    UPDATE public.requests
    SET status = 'done'
    WHERE id = p_request_id;
  END IF;

  -- 9. Return structured response
  RETURN jsonb_build_object(
    'item', row_to_json(v_updated_item),
    'old_after_photo_url', v_old_after_photo_url,
    'proof_count', v_approved_with_proof,
    'approved_with_proof_count', v_approved_with_proof,
    'total_approved', v_total_approved,
    'total_approved_count', v_total_approved,
    'status', v_new_status,
    'request_status', v_new_status
  );
END;
$$;


-- ------------------------------------------------------------
-- 4. PERMISSIONS & PRIVILEGE LOCKDOWN
--
-- Server-side SQL functions must be callable ONLY by service_role.
-- Explicitly revoke from PUBLIC, anon, and authenticated.
-- ------------------------------------------------------------

REVOKE ALL ON FUNCTION public.check_repair_items_after_photo_lock() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_repair_items_after_photo_lock() TO service_role;

REVOKE ALL ON FUNCTION public.attach_after_photo(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attach_after_photo(UUID, UUID, UUID, TEXT) TO service_role;
