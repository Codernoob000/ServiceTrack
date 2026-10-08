# ServiceTrack Security Architecture & Policy

## 1. Role & Identity Model
- **Source of Truth**: `public.users.role` is the canonical authorization source of truth (`'customer'` or `'mechanic'`).
- **Trigger Hardening**: The auth trigger `handle_new_user()` is `SECURITY DEFINER` with fixed `search_path = public, pg_temp` and *strictly* assigns `role = 'customer'`, ignoring any client-provided `user_metadata`.
- **Mechanic Promotion**: A user can only obtain the `'mechanic'` role via the server-side registration endpoint (`/api/auth/register`), which verifies the invite code using constant-time comparison (`crypto.timingSafeEqual`) against `process.env.MECHANIC_INVITE_CODE`.
- **Metadata Sync**: Upon successful invite validation, both `public.users.role` and `auth.users.app_metadata.role` are updated using the `service_role` key.
- **Client Metadata**: `user_metadata` is never trusted for authorization decisions.

## 2. Row Level Security (RLS) & Access Boundaries
- **Users Table**: Read-only to the user themselves (`auth.uid() = id`). No direct UPDATE grant on `role` or `email` columns for `authenticated`. Profile updates (name/phone) route through `/api/user/profile`.
- **Vehicles Table**: Single write path via server API routes. Clients have no direct INSERT/UPDATE/DELETE policies. Server routes validate `user_id`, ownership, and `is_active`. `public_token` and `user_id` are never client-settable.
- **Requests Table**: Zero client INSERT/UPDATE/DELETE policies. All bookings, claims, and status transitions occur through server API routes with explicit ownership/assignment checks.
- **Phase 2 Tables (`images`, `pins`, `repair_items`)**: RLS enabled with default-deny.
- **Cross-User Protection**: Every route using the service-role client explicitly validates ownership, current status, and `is_active` in code before performing database mutations.

## 3. Storage Security
- **Private Bucket**: `service-images` is private (`public: false`).
- **No Client Write Policies**: Uploads are accepted only via server API routes which validate file signatures (magic bytes for JPEG/PNG), strip EXIF metadata, enforce a 4MB cap, and verify the caller is assigned to or owns the request.
- **Signed URLs**: All image reads are delivered via signed URLs with 5 to 10 minute expiry, generated per render.

## 4. Atomic Concurrency
- **Request Claiming**: `claim_request()` runs as a `SECURITY DEFINER` function with `search_path = public, pg_temp`. It checks `auth.uid()`, validates that `public.users.role = 'mechanic'`, and updates atomically:
  ```sql
  UPDATE public.requests
  SET mechanic_id = auth.uid(), status = 'inspecting'
  WHERE id = p_request_id AND mechanic_id IS NULL AND status = 'booked';
  ```
  Returns 1 on success or 0 if claimed by another mechanic, avoiding race conditions. Execution is revoked from `public` and `anon`.

## 5. Serverless Rate Limiting
- Rate limiting is backed by Postgres via `public.rate_limits` and `check_rate_limit()` with atomic upserts and expiration cleanup, functioning reliably across distributed serverless environments.
- Direct calls to Supabase Auth (`signUp`) should also be rate-limited in the Supabase Dashboard.

## 6. HTTP & Transport Security
- Strict HTTP security headers configured in `next.config.ts`:
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- All API routes validate incoming JSON payloads with Zod schemas.
- Generic error messages returned to clients to prevent enumeration and leaking stack traces.
