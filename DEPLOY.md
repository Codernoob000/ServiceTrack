# Deployment Guide: Vercel & Supabase

This guide outlines the production deployment steps for ServiceTrack on Vercel with a Supabase backend.

---

## 1. Import Repository into Vercel

1. Log in to the [Vercel Dashboard](https://vercel.com).
2. Click **Add New... > Project** and import the `servicetrack` repository.
3. Framework Preset: **Next.js** (automatically detected).
4. Root Directory: `./`.

---

## 2. Configure Environment Variables

Under **Settings > Environment Variables** on Vercel, define the following variables for all environments (Production, Preview, Development):

| Variable Name | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project HTTPS URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public client anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Private service-role key (server-side only) |
| `MECHANIC_INVITE_CODE` | Strong secret string for mechanic registration |
| `NEXT_PUBLIC_APP_URL` | Your production Vercel URL (e.g., `https://your-app.vercel.app`) |
| `DEMO_PASSWORD` | Password for seeding demo accounts |

> [!NOTE]
> The Content Security Policy in `next.config.ts` dynamically derives the exact Supabase host from `NEXT_PUBLIC_SUPABASE_URL` for `connect-src` and `img-src` without wildcards.

---

## 3. Update Supabase Auth Settings

In the [Supabase Dashboard](https://supabase.com/dashboard) under **Authentication > URL Configuration**:

1. **Site URL**:
   Set to your production domain:
   `https://your-app.vercel.app`
2. **Redirect URLs**:
   Add the following patterns:
   - `https://your-app.vercel.app/**`
   - `https://*-your-team.vercel.app/**` (for preview deployments)
   - `http://localhost:3000/**` (for local development)
3. **Email Confirmations**:
   Turn **Enable Email Confirmations** ON for production security.

---

## 4. Run Supabase Migrations

Ensure all SQL migrations have been executed in your Supabase SQL Editor in exact sequence:
1. `supabase/migration.sql`
2. `supabase/migration_phase2.sql`
3. `supabase/migration_phase3.sql`
4. `supabase/migration_phase4.sql`
5. `supabase/migration_phase5.sql`

---

## 5. Post-Deploy Verification Checklist

Once the deployment finishes building:

1. [ ] **Customer Registration & Onboarding**:
   - Navigate to `/auth` on the deployed domain.
   - Register a new customer account.
   - Verify redirect to `/dashboard`.
2. [ ] **Vehicle Addition & Booking**:
   - Add a new vehicle with registration plate and year.
   - Book a service request.
3. [ ] **Mechanic Workflow**:
   - Register a mechanic account using the secret `MECHANIC_INVITE_CODE`.
   - Access `/mechanic/queue`, claim the booked request, upload inspection photos, and add defect pins.
4. [ ] **Customer Decisions & After-Photo Documentation**:
   - Review defect pins and approve items as customer.
   - Upload after-repair photos as mechanic.
   - Confirm status transitions to `done`.
5. [ ] **Public QR History Page**:
   - From vehicle settings, open the public history link in an incognito/private window.
   - Confirm `<meta name="robots" content="noindex, nofollow">` is present in page source.
   - Verify masked license plate (e.g. `TS09****34`) and interactive before/after photo slider.
   - Rotate the token in vehicle settings and confirm previous link immediately returns 404.
