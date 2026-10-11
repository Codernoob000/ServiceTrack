-- ============================================================
-- SERVICETRACK: PHASE 5 MIGRATION
-- Public Vehicle Service History, QR Access, and Token Management
--
-- This migration is completely idempotent and safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. SCHEMA ALIGNMENT: public_history_enabled ON public.vehicles
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'vehicles'
      AND column_name = 'public_history_enabled'
  ) THEN
    ALTER TABLE public.vehicles
      ADD COLUMN public_history_enabled BOOLEAN NOT NULL DEFAULT true;
    RAISE NOTICE 'Added public_history_enabled column to public.vehicles.';
  ELSE
    RAISE NOTICE 'public.vehicles.public_history_enabled column already exists.';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_vehicles_public_token
  ON public.vehicles (public_token);

CREATE INDEX IF NOT EXISTS idx_vehicles_public_lookup
  ON public.vehicles (public_token)
  WHERE is_active = true AND public_history_enabled = true;


-- ------------------------------------------------------------
-- 2. FUNCTION: public_vehicle_history(p_token uuid)
--
-- Public vehicle service history lookup by public_token.
-- Returns JSONB with strictly whitelisted public fields:
--   - brand
--   - model
--   - year
--   - masked_plate (first 4 and last 2 characters visible, rest masked with '*')
--   - repairs (array of completed repairs: completed_at, part_name, before_image_path, after_image_path)
--
-- A completed repair is:
--   - repair_items.approval_status = 'approved'
--   - repair_items.after_photo_url IS NOT NULL
--   - requests.status = 'done'
--   - vehicle.is_active = true
--   - vehicle.public_history_enabled = true
--
-- Excluded: owner id, name, phone, email, request ids, estimates,
-- totals, notes, descriptions, mechanic details, full plate,
-- vehicle id, token.
--
-- Returns NULL when token is unknown, vehicle is inactive,
-- or public history is disabled.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.public_vehicle_history(p_token UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_vehicle RECORD;
  v_masked_plate TEXT;
  v_len INT;
  v_repairs JSONB;
BEGIN
  -- If token is null, return null immediately
  IF p_token IS NULL THEN
    RETURN NULL;
  END IF;

  -- 1. Find matching vehicle
  SELECT v.id, v.brand, v.model, v.year, v.plate, v.is_active, v.public_history_enabled
  INTO v_vehicle
  FROM public.vehicles v
  WHERE v.public_token = p_token;

  -- 2. Return NULL for unknown token, inactive vehicle, or disabled public history
  IF v_vehicle.id IS NULL OR NOT v_vehicle.is_active OR NOT v_vehicle.public_history_enabled THEN
    RETURN NULL;
  END IF;

  -- 3. Mask plate in SQL: always hide at least 3 characters
  v_len := char_length(v_vehicle.plate);
  IF v_len >= 9 THEN
    v_masked_plate := left(v_vehicle.plate, 4) || repeat('*', v_len - 6) || right(v_vehicle.plate, 2);
  ELSIF v_len >= 6 THEN
    v_masked_plate := left(v_vehicle.plate, 1) || repeat('*', v_len - 3) || right(v_vehicle.plate, 2);
  ELSE
    v_masked_plate := repeat('*', v_len);
  END IF;

  -- 4. Gather completed repairs
  -- (approved repair item with after_photo_url on a 'done' request, ordered by completed_at DESC)
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'completed_at', ri.completed_at,
        'part_name', p.part_name,
        'before_image_path', i.storage_path,
        'after_image_path', ri.after_photo_url
      )
      ORDER BY ri.completed_at DESC NULLS LAST
    ),
    '[]'::jsonb
  )
  INTO v_repairs
  FROM public.repair_items ri
  JOIN public.pins p ON p.id = ri.pin_id
  JOIN public.images i ON i.id = p.image_id
  JOIN public.requests r ON r.id = i.request_id
  WHERE r.vehicle_id = v_vehicle.id
    AND r.status = 'done'
    AND ri.approval_status = 'approved'
    AND ri.after_photo_url IS NOT NULL;

  -- 5. Construct and return final sanitized JSON payload
  RETURN jsonb_build_object(
    'brand', v_vehicle.brand,
    'model', v_vehicle.model,
    'year', v_vehicle.year,
    'masked_plate', v_masked_plate,
    'repairs', v_repairs
  );
END;
$$;

-- Restrict execution to service_role only
REVOKE ALL ON FUNCTION public.public_vehicle_history(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_vehicle_history(UUID) TO service_role;


-- ------------------------------------------------------------
-- 3. FUNCTION: rotate_vehicle_token(p_vehicle_id uuid, p_caller_id uuid)
--
-- Generates and assigns a new public_token for the vehicle.
-- Only the vehicle owner can rotate the token.
--
-- Error codes:
--   P0020 : Vehicle not found
--   P0021 : Caller is not the vehicle owner
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rotate_vehicle_token(
  p_vehicle_id UUID,
  p_caller_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner_id UUID;
  v_new_token UUID;
BEGIN
  -- 1. Verify vehicle exists
  SELECT user_id INTO v_owner_id
  FROM public.vehicles
  WHERE id = p_vehicle_id;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Vehicle not found: %', p_vehicle_id
      USING ERRCODE = 'P0020';
  END IF;

  -- 2. Verify caller is owner
  IF v_owner_id IS DISTINCT FROM p_caller_id THEN
    RAISE EXCEPTION 'Forbidden: Caller is not the owner of vehicle %', p_vehicle_id
      USING ERRCODE = 'P0021';
  END IF;

  -- 3. Generate new unique token
  v_new_token := gen_random_uuid();

  UPDATE public.vehicles
  SET public_token = v_new_token
  WHERE id = p_vehicle_id;

  RETURN v_new_token;
END;
$$;

-- Restrict execution to service_role only
REVOKE ALL ON FUNCTION public.rotate_vehicle_token(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_vehicle_token(UUID, UUID) TO service_role;


-- ------------------------------------------------------------
-- 4. FUNCTION: set_public_history(p_vehicle_id uuid, p_caller_id uuid, p_enabled boolean)
--
-- Enables or disables public service history for a vehicle.
-- Only the vehicle owner can modify this setting.
--
-- Error codes:
--   P0020 : Vehicle not found
--   P0021 : Caller is not the vehicle owner
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_public_history(
  p_vehicle_id UUID,
  p_caller_id UUID,
  p_enabled BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner_id UUID;
BEGIN
  -- 1. Validate input
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'Invalid input: p_enabled cannot be null'
      USING ERRCODE = 'P0022';
  END IF;

  -- 2. Verify vehicle exists
  SELECT user_id INTO v_owner_id
  FROM public.vehicles
  WHERE id = p_vehicle_id;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Vehicle not found: %', p_vehicle_id
      USING ERRCODE = 'P0020';
  END IF;

  -- 3. Verify caller is owner
  IF v_owner_id IS DISTINCT FROM p_caller_id THEN
    RAISE EXCEPTION 'Forbidden: Caller is not the owner of vehicle %', p_vehicle_id
      USING ERRCODE = 'P0021';
  END IF;

  -- 4. Update setting
  UPDATE public.vehicles
  SET public_history_enabled = p_enabled
  WHERE id = p_vehicle_id;

  RETURN p_enabled;
END;
$$;

-- Restrict execution to service_role only
REVOKE ALL ON FUNCTION public.set_public_history(UUID, UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_public_history(UUID, UUID, BOOLEAN) TO service_role;
