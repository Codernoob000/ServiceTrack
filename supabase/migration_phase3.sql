-- ============================================================
-- SERVICETRACK: PHASE 3 MIGRATION
-- Customer Approval of Repair Items, Server-Computed Total,
-- and Atomic State Transition (repairing / done)
--
-- This migration is completely idempotent and safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. APPROVAL STATUS LIFECYCLE TRIGGER ON repair_items
--
-- Enforces:
-- 1. INSERTs must have approval_status = 'pending' (cannot insert
--    pre-approved or pre-rejected items).
-- 2. approval_status can only change while the parent request
--    status is 'awaiting_approval' (P0001, 409).
-- 3. approval_status can only transition from 'pending' to
--    'approved' or 'rejected'.
-- 4. A decided item ('approved' or 'rejected') can NEVER change
--    again (P0009, 409).
-- 5. description and estimate remain frozen outside 'inspecting'
--    (already enforced by trg_repair_items_inspecting_lock).
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_repair_items_approval_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status TEXT;
BEGIN
  -- 1. INSERT guard: all new repair items must have approval_status = 'pending'
  IF (TG_OP = 'INSERT') THEN
    IF NEW.approval_status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'New repair items must have approval_status = pending (got: %)', NEW.approval_status
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- 2. UPDATE guard: only enforce when approval_status is actually being modified
  IF (TG_OP = 'UPDATE') THEN
    IF (NEW.approval_status IS DISTINCT FROM OLD.approval_status) THEN
      -- Look up parent request status via pin -> image -> request
      SELECT r.status INTO v_status
      FROM public.pins p
      JOIN public.images i ON i.id = p.image_id
      JOIN public.requests r ON r.id = i.request_id
      WHERE p.id = NEW.pin_id
      FOR SHARE OF r;

      IF v_status IS NULL THEN
        RAISE EXCEPTION 'Parent request not found for repair item' USING ERRCODE = '23503';
      END IF;

      -- approval_status can only change while parent request is 'awaiting_approval'
      IF v_status <> 'awaiting_approval' THEN
        RAISE EXCEPTION 'Cannot modify approval status when request status is % (must be awaiting_approval)', v_status
          USING ERRCODE = 'P0001';
      END IF;

      -- approval_status can only change from 'pending' (a decided item cannot change again)
      IF OLD.approval_status <> 'pending' THEN
        RAISE EXCEPTION 'Repair item has already been decided (%): approval status cannot be modified again', OLD.approval_status
          USING ERRCODE = 'P0009';
      END IF;

      -- approval_status can only transition to 'approved' or 'rejected'
      IF NEW.approval_status NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'Invalid approval_status: must be approved or rejected (got: %)', NEW.approval_status
          USING ERRCODE = '23514';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_repair_items_approval_status_lock ON public.repair_items;
CREATE TRIGGER trg_repair_items_approval_status_lock
  BEFORE INSERT OR UPDATE ON public.repair_items
  FOR EACH ROW
  EXECUTE FUNCTION public.check_repair_items_approval_status();


-- ------------------------------------------------------------
-- 2. ATOMIC DECISION SUBMISSION FUNCTION
--
-- Function: public.submit_decisions(p_request_id, p_caller_id, p_decisions)
--
-- Parameters:
--   p_request_id UUID  - Target service request ID
--   p_caller_id  UUID  - Authenticated user ID (must match vehicle owner)
--   p_decisions  JSONB - Array of objects: [{"item_id": "...", "decision": "approved"|"rejected"}]
--
-- Rules & Protections:
--   - Locks the request row FOR UPDATE to prevent race conditions.
--   - Verifies the caller is the vehicle owner (customer) via vehicles.user_id.
--   - Verifies the request status is 'awaiting_approval'.
--   - Validates that p_decisions contains exactly one decision for EVERY repair
--     item of the request (no missing, no unknown, no duplicate, no foreign IDs).
--   - Applies all decisions atomically.
--   - Computes SQL sum of approved item estimates (whole rupees).
--   - If at least one item is approved -> status becomes 'repairing'.
--   - If all items are rejected -> status becomes 'done'.
--   - Returns JSONB containing request_id, new status, approved_total, counts.
--   - Error codes:
--       P0001 : Request status is not awaiting_approval in trigger (conflict, 409)
--       P0002 : Request not found (not found, 404)
--       P0003 : Caller is not the vehicle owner (forbidden, 403)
--       P0004 : Request status is not awaiting_approval in submit_decisions (conflict, 409)
--       P0005 : Incomplete or invalid decisions payload (bad request, 400)
--       P0009 : Repair item already decided (conflict, 409)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_decisions(
  p_request_id UUID,
  p_caller_id UUID,
  p_decisions JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status TEXT;
  v_owner_id UUID;
  v_new_status TEXT;
  v_total_request_items INT;
  v_total_decisions INT;
  v_distinct_decisions INT;
  v_matched_items INT;
  v_approved_count INT;
  v_rejected_count INT;
  v_approved_total NUMERIC;
  v_elem JSONB;
  v_raw_item_id TEXT;
  v_raw_decision TEXT;
BEGIN
  -- 1. Lock the request row FOR UPDATE
  SELECT r.status, v.user_id
  INTO v_status, v_owner_id
  FROM public.requests r
  JOIN public.vehicles v ON v.id = r.vehicle_id
  WHERE r.id = p_request_id
  FOR UPDATE OF r;

  -- Verify request exists
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Request not found: %', p_request_id
      USING ERRCODE = 'P0002';
  END IF;

  -- 2. Verify caller is the vehicle owner
  IF v_owner_id IS DISTINCT FROM p_caller_id THEN
    RAISE EXCEPTION 'Forbidden: Caller is not the vehicle owner'
      USING ERRCODE = 'P0003';
  END IF;

  -- 3. Verify request status is 'awaiting_approval'
  IF v_status <> 'awaiting_approval' THEN
    RAISE EXCEPTION 'Conflict: Request status is % (must be awaiting_approval)', v_status
      USING ERRCODE = 'P0004';
  END IF;

  -- 4. Validate p_decisions JSONB payload structure
  IF p_decisions IS NULL OR jsonb_typeof(p_decisions) <> 'array' THEN
    RAISE EXCEPTION 'Invalid decisions: payload must be a JSON array'
      USING ERRCODE = 'P0005';
  END IF;

  v_total_decisions := jsonb_array_length(p_decisions);
  IF v_total_decisions = 0 THEN
    RAISE EXCEPTION 'Invalid decisions: payload array cannot be empty'
      USING ERRCODE = 'P0005';
  END IF;

  -- Validate each element in p_decisions
  FOR v_elem IN SELECT * FROM jsonb_array_elements(p_decisions) LOOP
    v_raw_item_id := v_elem->>'item_id';
    v_raw_decision := v_elem->>'decision';

    IF v_raw_item_id IS NULL OR v_raw_decision IS NULL THEN
      RAISE EXCEPTION 'Invalid decision entry: item_id and decision are required'
        USING ERRCODE = 'P0005';
    END IF;

    IF v_raw_decision NOT IN ('approved', 'rejected') THEN
      RAISE EXCEPTION 'Invalid decision: must be approved or rejected (got: %)', v_raw_decision
        USING ERRCODE = 'P0005';
    END IF;

    -- Strict UUID pattern check
    IF v_raw_item_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Invalid item_id UUID format: %', v_raw_item_id
        USING ERRCODE = 'P0005';
    END IF;
  END LOOP;

  -- Check for duplicate item_ids in p_decisions
  SELECT count(DISTINCT (elem->>'item_id')::UUID)
  INTO v_distinct_decisions
  FROM jsonb_array_elements(p_decisions) AS elem;

  IF v_total_decisions <> v_distinct_decisions THEN
    RAISE EXCEPTION 'Invalid decisions: duplicate item_id entries found'
      USING ERRCODE = 'P0005';
  END IF;

  -- 5. Count all repair items belonging to this request
  SELECT count(*)
  INTO v_total_request_items
  FROM public.repair_items ri
  JOIN public.pins p ON p.id = ri.pin_id
  JOIN public.images i ON i.id = p.image_id
  WHERE i.request_id = p_request_id;

  IF v_total_request_items = 0 THEN
    RAISE EXCEPTION 'Request has no repair items to decide'
      USING ERRCODE = 'P0005';
  END IF;

  -- Verify total decisions matches total request items
  IF v_total_decisions <> v_total_request_items THEN
    RAISE EXCEPTION 'Incomplete or mismatched decisions: expected % items, got %',
      v_total_request_items, v_total_decisions
      USING ERRCODE = 'P0005';
  END IF;

  -- Verify every decision item belongs to this request (no foreign/unknown IDs)
  SELECT count(*)
  INTO v_matched_items
  FROM jsonb_array_elements(p_decisions) AS elem
  JOIN public.repair_items ri ON ri.id = (elem->>'item_id')::UUID
  JOIN public.pins p ON p.id = ri.pin_id
  JOIN public.images i ON i.id = p.image_id
  WHERE i.request_id = p_request_id;

  IF v_matched_items <> v_total_request_items THEN
    RAISE EXCEPTION 'Invalid decisions: payload contains items not belonging to this request'
      USING ERRCODE = 'P0005';
  END IF;

  -- 6. Apply all decisions atomically to public.repair_items
  UPDATE public.repair_items ri
  SET approval_status = (d.elem->>'decision')::TEXT
  FROM jsonb_array_elements(p_decisions) AS d(elem)
  WHERE ri.id = (d.elem->>'item_id')::UUID;

  -- 7. Compute counts and approved estimate sum in SQL
  SELECT
    count(*) FILTER (WHERE ri.approval_status = 'approved'),
    count(*) FILTER (WHERE ri.approval_status = 'rejected'),
    COALESCE(SUM(ri.estimate) FILTER (WHERE ri.approval_status = 'approved'), 0)
  INTO v_approved_count, v_rejected_count, v_approved_total
  FROM public.repair_items ri
  JOIN public.pins p ON p.id = ri.pin_id
  JOIN public.images i ON i.id = p.image_id
  WHERE i.request_id = p_request_id;

  -- 8. State Transition:
  -- If at least one item is approved -> status = 'repairing'
  -- Otherwise (all rejected) -> status = 'done'
  IF v_approved_count > 0 THEN
    v_new_status := 'repairing';
  ELSE
    v_new_status := 'done';
  END IF;

  UPDATE public.requests
  SET status = v_new_status
  WHERE id = p_request_id;

  -- 9. Return structured response
  RETURN jsonb_build_object(
    'request_id', p_request_id,
    'status', v_new_status,
    'approved_total', v_approved_total,
    'approved_count', v_approved_count,
    'rejected_count', v_rejected_count,
    'total_items', v_total_request_items
  );
END;
$$;


-- ------------------------------------------------------------
-- 3. PERMISSIONS & PRIVILEGE LOCKDOWN
--
-- Server-side SQL functions must be callable ONLY by service_role.
-- Explicitly revoke from PUBLIC, anon, and authenticated.
-- ------------------------------------------------------------

REVOKE ALL ON FUNCTION public.check_repair_items_approval_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_repair_items_approval_status() TO service_role;

REVOKE ALL ON FUNCTION public.submit_decisions(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_decisions(UUID, UUID, JSONB) TO service_role;
