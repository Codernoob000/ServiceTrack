# ServiceTrack Security Architecture & Policy

## 1. Role & Identity Model
- **Source of Truth**: `public.users.role` is the canonical authorization source of truth (`'customer'` or `'mechanic'`).
- **Trigger Hardening**: The auth trigger `handle_new_user()` is `SECURITY DEFINER` with fixed `search_path = public, pg_temp` and *strictly* assigns `role = 'customer'`, ignoring any client-provided `user_metadata`.
- **Mechanic Promotion**: A user can only obtain the `'mechanic'` role via the server-side registration endpoint (`/api/auth/register`), which verifies the invite code using constant-time comparison (`crypto.timingSafeEqual`) against `process.env.MECHANIC_INVITE_CODE`.
- **Metadata Sync**: Upon successful invite validation, both `public.users.role` and `auth.users.app_metadata.role` are updated using the `service_role` key.
- **Client Metadata**: `user_metadata` is never trusted for authorization decisions.

## 2. Grant Lockdown & Row Level Security (RLS)
- **Grant Lockdown**: Direct mutation grants (`INSERT`, `UPDATE`, `DELETE`) on `public.vehicles` and `public.requests` are locked down from `anon` and `authenticated` roles. All state mutations must flow through Next.js server-side API routes (`service_role` client) after strict session verification and ownership validation.
- **RPC Lockdown**: Sensitive RPCs such as `claim_request()` have execution privileges revoked from `anon` and `public`, restricted to `authenticated` or internal callers.
- **Users Table**: Read-only to the user themselves (`auth.uid() = id`). No direct UPDATE grant on `role` or `email` columns for `authenticated`. Profile updates (name/phone) route through `/api/user/profile`.
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
  - `Content-Security-Policy`: Restricts scripts, styles, frames (`frame-ancestors 'none'`), objects, and limits `connect-src` to `'self'` and Supabase HTTPS/WSS endpoints.
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- All API routes validate incoming JSON payloads with Zod schemas.
- Server-only modules (`admin.ts`, `auth.ts`, `rate-limit.ts`) enforce `import "server-only"` to prevent secret leaks into client bundles.

## 7. Dev-Only npm Audit Note
- Running `npm audit` reports a vulnerability in `braces` (via `micromatch` in `eslint-config-next` / ESLint).
- **Impact Assessment**: This dependency belongs exclusively to `devDependencies` and is executed solely during local developer linting. It is never included in the production runtime, serverless functions, or client-side bundles compiled by Next.js.

## 8. Honest Known Risks & Mitigations
1. **Direct GoTrue Auth Client Bypass**: Direct calls to `supabase.auth.signUp()` or `signInWithPassword()` from client browsers bypass Next.js API route rate limiters. *Mitigation*: Rate limiting and captcha must be enabled in the Supabase Dashboard under Auth Settings.
2. **Service Role Key Secrecy**: The service role client bypasses RLS in Postgres. Server routes must enforce explicit authorization and ownership checks before any query. *Mitigation*: The service role key is guarded with `server-only` imports and throws immediately if missing from server environments.
3. **Public Token Enumeration**: Vehicle status can be tracked via `public_token` UUIDs without authentication. *Mitigation*: UUIDv4 values are cryptographically random and unguessable (128-bit entropy).
4. **Stale Session Claims**: A user demoted or altered directly in Postgres may retain a valid JWT until the session expires or refreshes. *Mitigation*: Server API routes and route handlers rely on `getAuthenticatedUser()` which queries `public.users` directly as the canonical source of truth on each write request.
