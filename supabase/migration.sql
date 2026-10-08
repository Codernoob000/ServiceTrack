-- ServiceTrack: Full Schema Migration
-- Run this in the Supabase SQL Editor (or via supabase db push).
-- Idempotent: uses IF NOT EXISTS where possible. For a clean project, run as-is.

-- ============================================================
-- 1. TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.users (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL,
  phone       TEXT,
  role        TEXT NOT NULL DEFAULT 'customer'
              CHECK (role IN ('customer', 'mechanic')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.vehicles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  plate         TEXT NOT NULL CHECK (char_length(plate) BETWEEN 2 AND 15),
  brand         TEXT NOT NULL,
  model         TEXT NOT NULL,
  year          INT  NOT NULL CHECK (year BETWEEN 1900 AND 2100),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  public_token  UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vehicles_public_token_unique UNIQUE (public_token)
);

CREATE TABLE IF NOT EXISTS public.requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id      UUID NOT NULL REFERENCES public.vehicles(id) ON DELETE RESTRICT,
  mechanic_id     UUID REFERENCES public.users(id) ON DELETE SET NULL,
  service_type    TEXT NOT NULL
                  CHECK (service_type IN (
                    'oil_change', 'brake_service', 'tire_rotation',
                    'full_inspection', 'engine_diagnostics', 'other'
                  )),
  complaint       TEXT NOT NULL,
  preferred_date  DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'booked'
                  CHECK (status IN (
                    'booked', 'inspecting', 'awaiting_approval',
                    'repairing', 'done', 'cancelled'
                  )),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.images (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  UUID NOT NULL REFERENCES public.requests(id) ON DELETE RESTRICT,
  url         TEXT NOT NULL,
  view_angle  TEXT NOT NULL CHECK (view_angle IN ('front', 'rear', 'left', 'right', 'other')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pins (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_id   UUID NOT NULL REFERENCES public.images(id) ON DELETE RESTRICT,
  x          NUMERIC(5,4) NOT NULL CHECK (x >= 0 AND x <= 1),
  y          NUMERIC(5,4) NOT NULL CHECK (y >= 0 AND y <= 1),
  part_name  TEXT NOT NULL,
  severity   TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.repair_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pin_id          UUID NOT NULL REFERENCES public.pins(id) ON DELETE RESTRICT,
  description     TEXT NOT NULL,
  estimate        NUMERIC(10,2) NOT NULL CHECK (estimate >= 0),
  approval_status TEXT NOT NULL DEFAULT 'pending'
                  CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  after_photo_url TEXT,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 2. INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_vehicles_user_id      ON public.vehicles (user_id);
CREATE INDEX IF NOT EXISTS idx_requests_vehicle_id   ON public.requests (vehicle_id);
CREATE INDEX IF NOT EXISTS idx_requests_mechanic_id  ON public.requests (mechanic_id);
CREATE INDEX IF NOT EXISTS idx_requests_status       ON public.requests (status);
CREATE INDEX IF NOT EXISTS idx_images_request_id     ON public.images  (request_id);
CREATE INDEX IF NOT EXISTS idx_pins_image_id         ON public.pins    (image_id);
CREATE INDEX IF NOT EXISTS idx_repair_items_pin_id   ON public.repair_items (pin_id);

-- ============================================================
-- 3. ENABLE ROW-LEVEL SECURITY (all tables)
-- ============================================================

ALTER TABLE public.users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.requests     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.images       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pins         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repair_items ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 4. RLS POLICIES
-- ============================================================

-- ---- public.users ----
-- SELECT: own row only. Mechanic queue pages use service-role for cross-reads.
CREATE POLICY users_select_own ON public.users
  FOR SELECT TO authenticated
  USING (auth.uid() = id);

-- No INSERT policy  -- trigger (SECURITY DEFINER) handles inserts.
-- No UPDATE policy  -- /api/user/profile uses service-role key.
-- No DELETE policy  -- users are never deleted from public.users directly.

-- ---- public.vehicles ----
-- SELECT: owner sees all own vehicles (incl. inactive, needed for request history).
CREATE POLICY vehicles_select_owner ON public.vehicles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- SELECT: mechanic sees vehicles tied to requests they can access.
CREATE POLICY vehicles_select_mechanic ON public.vehicles
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'mechanic'
    )
    AND id IN (
      SELECT r.vehicle_id FROM public.requests r
      WHERE r.mechanic_id = auth.uid()
         OR (r.mechanic_id IS NULL AND r.status = 'booked')
    )
  );

-- No INSERT / UPDATE / DELETE policies.
-- All vehicle writes go through API routes with service-role key.

-- ---- public.requests ----
-- SELECT: customer sees requests for any of their vehicles.
CREATE POLICY requests_select_customer ON public.requests
  FOR SELECT TO authenticated
  USING (
    vehicle_id IN (
      SELECT v.id FROM public.vehicles v WHERE v.user_id = auth.uid()
    )
  );

-- SELECT: mechanic sees assigned-to-self OR unassigned+booked.
CREATE POLICY requests_select_mechanic ON public.requests
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'mechanic'
    )
    AND (
      mechanic_id = auth.uid()
      OR (mechanic_id IS NULL AND status = 'booked')
    )
  );

-- No INSERT / UPDATE / DELETE policies.
-- Booking, claiming, transitions -- all server-side with service-role key.

-- ---- public.images ----
-- Default deny. No policies until Phase 2.

-- ---- public.pins ----
-- Default deny. No policies until Phase 2.

-- ---- public.repair_items ----
-- Default deny. No policies until Phase 2.

-- ============================================================
-- 5. FUNCTIONS
-- ============================================================

-- ---- Trigger: new auth user -> insert public.users with role='customer' ----
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.users (id, name, email, phone, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'name', ''),
    NEW.email,
    NEW.raw_user_meta_data ->> 'phone',
    'customer'   -- ALWAYS customer. Promotion is a separate step.
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ---- Atomic claim: mechanic takes an open request ----
-- Uses auth.uid() internally -- mechanic_id is never a client parameter.
-- Verifies caller role from public.users (source of truth) inside the function.
-- Sets status = 'inspecting' atomically with the assignment.
-- Returns 1 on success, 0 if already taken or not in 'booked' status.
CREATE OR REPLACE FUNCTION public.claim_request(p_request_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  affected INT;
  caller_role TEXT;
BEGIN
  -- Verify caller is a mechanic in the source-of-truth table
  SELECT role INTO caller_role
  FROM public.users
  WHERE id = auth.uid();

  IF caller_role IS DISTINCT FROM 'mechanic' THEN
    RAISE EXCEPTION 'Unauthorized: caller is not a mechanic';
  END IF;

  -- Atomic claim: only succeeds if row is unassigned + booked
  UPDATE public.requests
  SET    mechanic_id = auth.uid(),
         status      = 'inspecting'
  WHERE  id          = p_request_id
    AND  mechanic_id IS NULL
    AND  status      = 'booked';

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

-- Lock down execute permissions
REVOKE EXECUTE ON FUNCTION public.claim_request(UUID) FROM public;
REVOKE EXECUTE ON FUNCTION public.claim_request(UUID) FROM anon;
GRANT  EXECUTE ON FUNCTION public.claim_request(UUID) TO authenticated;

-- ============================================================
-- 6. RATE LIMITS (Serverless-safe DB storage)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.rate_limits (
  key         TEXT PRIMARY KEY,
  count       INT NOT NULL DEFAULT 1,
  reset_at    TIMESTAMPTZ NOT NULL
);

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
-- Default deny: no client policies. Accessed only via service-role / SECURITY DEFINER.

CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_key TEXT,
  p_max_requests INT,
  p_window_seconds INT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_count INT;
BEGIN
  -- Delete expired entry if it exists
  DELETE FROM public.rate_limits WHERE key = p_key AND reset_at < v_now;

  -- Upsert current request count
  INSERT INTO public.rate_limits (key, count, reset_at)
  VALUES (p_key, 1, v_now + (p_window_seconds || ' seconds')::INTERVAL)
  ON CONFLICT (key) DO UPDATE
  SET count = public.rate_limits.count + 1
  RETURNING count INTO v_count;

  IF v_count > p_max_requests THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_rate_limit(TEXT, INT, INT) FROM public;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(TEXT, INT, INT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.check_rate_limit(TEXT, INT, INT) TO service_role;

-- ============================================================
-- 7. STORAGE
-- ============================================================

-- Private bucket. No public access. No client-side storage policies.
-- All uploads go through server API routes using the service-role key.
-- Reads use signed URLs generated server-side (5-minute expiry).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'service-images',
  'service-images',
  false,
  4194304,   -- 4 MB (Vercel body limit is ~4.5 MB)
  ARRAY['image/jpeg', 'image/png']
)
ON CONFLICT (id) DO NOTHING;

-- No storage.objects policies. Service-role key bypasses storage RLS.



-- ============================================================
-- Lockdown: no automatic grants to client roles
-- ============================================================
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Grant back only what the app needs
grant select on public.users, public.vehicles, public.requests to authenticated;
grant execute on function public.claim_request(uuid) to authenticated;