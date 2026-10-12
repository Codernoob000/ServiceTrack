# ServiceTrack

ServiceTrack is a transparent, full-stack vehicle service lifecycle management platform built with Next.js 16 (App Router), React 19, Supabase (PostgreSQL, Auth, Storage), and Tailwind CSS v4.

It bridges the trust and communication gap between vehicle owners and repair shops by providing complete, end-to-end service lifecycle traceability: customer booking, mechanic job claiming, photographic vehicle inspection with coordinate-accurate defect pins, line-item repair approvals, proof-of-work documentation, print-ready invoicing, and privacy-preserving public vehicle history accessible via QR code.

---

## Table of Contents

1. [System Overview & Key Features](#system-overview--key-features)
2. [Architecture & Technical Design](#architecture--technical-design)
3. [Security Architecture](#security-architecture)
4. [Technology Stack](#technology-stack)
5. [Repository Structure](#repository-structure)
6. [Database Schema & Migrations](#database-schema--migrations)
7. [API Route Reference](#api-route-reference)
8. [Prerequisites & Environment Configuration](#prerequisites--environment-configuration)
9. [Installation & Setup](#installation--setup)
10. [Running the Application](#running-the-application)
11. [Automated Test Suite](#automated-test-suite)
12. [Demo Data Management](#demo-data-management)
13. [Interactive 3-Minute Walkthrough](#interactive-3-minute-walkthrough)
14. [Production Deployment](#production-deployment)
15. [Known Limitations & Design Considerations](#known-limitations--design-considerations)

---

## System Overview & Key Features

ServiceTrack solves the persistent opacity in vehicle repair workflows—unverified upsells, lack of visual defect evidence, disputed estimates, and lost service histories—through an interactive, role-based platform.

### Core Capabilities

- **Role-Based Workflows**: Tailored portals for **Customers** (manage personal garage, book repairs, approve/reject estimates, view invoices) and **Mechanics** (open repair queue, atomic job claiming, visual inspection editor, proof-of-repair uploads).
- **Atomic Job Claiming**: Prevents double-assignment race conditions using a PostgreSQL `SECURITY DEFINER` function (`claim_request`), ensuring only one mechanic can claim a booked job.
- **Visual Multi-Angle Inspection Canvas**: Mechanics upload exterior/interior vehicle photos across predefined angles (`front`, `rear`, `left`, `right`, `other`), tap directly on images to place normalized defect coordinates (`x, y`), assign severity levels, and specify whole-rupee estimates.
- **Customer Decision Engine**: Customers review defect pins interactively and approve or reject repair items individually. Total costs are computed strictly server-side in PostgreSQL.
- **Proof-of-Repair & Automated Completion**: Approved repairs require photographic "after" proof. When the assigned mechanic uploads verified after-photos for every approved item, the system automatically marks the service request as `done`.
- **Interactive Before/After Comparison**: Both customers and mechanics can inspect completed repairs using an interactive split-slider comparing original defect photos against completed repair photos.
- **Print-Optimized Invoicing**: Server-calculated itemized invoices showing approved repairs only, formatted specifically for A4 portrait printing with navigation and action bars suppressed.
- **Privacy-Preserving Public QR History**: Each vehicle has a unique UUID token linking to an unauthenticated public record (`/h/[token]`). License plates are automatically masked (e.g., `TS09****34`), search engine indexing is blocked (`noindex, nofollow`), and vehicle owners can toggle public visibility or rotate tokens at any time.
- **Isolated Demo Sandbox**: Preconfigured seed and reset scripts targeting `@demo.servicetrack.app` accounts, enabling risk-free local demonstrations across all lifecycle statuses.

---

## Architecture & Technical Design

ServiceTrack is architected as a Next.js App Router full-stack application backed by Supabase Managed PostgreSQL, Supabase Auth, and Supabase Storage.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Client Browser                                  │
│  ┌───────────────────────┐ ┌──────────────────────┐ ┌────────────────────┐  │
│  │  Customer Dashboard  │ │   Mechanic Queue     │ │   Public History   │  │
│  │  (/dashboard, /book)  │ │  (/mechanic/queue)   │ │    (/h/[token])    │  │
│  └───────────┬───────────┘ └──────────┬───────────┘ └─────────┬──────────┘  │
└──────────────┼────────────────────────┼───────────────────────┼─────────────┘
               │ Session Cookies        │ Session Cookies       │ Public Token
               ▼                        ▼                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Next.js Middleware (src/middleware.ts)                   │
│   - Route protection for authenticated paths                                │
│   - Role enforcement (mechanic -> /mechanic/queue, customer -> /dashboard)  │
│   - Session token refresh via @supabase/ssr                                 │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                   Next.js App Router (Server API Routes)                    │
│   - Session validation (src/lib/auth.ts -> getAuthenticatedUser())          │
│   - Schema validation with Zod (src/lib/validation.ts)                      │
│   - Image processing with Sharp (EXIF stripping, format normalization)      │
│   - Service-Role Database Operations (src/lib/supabase/admin.ts)             │
│   - PostgreSQL-backed rate limiting (src/lib/rate-limit.ts)                 │
└──────────────────────┬───────────────────────────────┬──────────────────────┘
                       │ SQL RPC Calls & Queries       │ Signed URLs / Uploads
                       ▼                               ▼
┌────────────────────────────────────────┐ ┌──────────────────────────────────┐
│      Supabase PostgreSQL Database      │ │         Supabase Storage         │
│  - public.users (Auth Source of Truth) │ │  - service-images (PRIVATE)      │
│  - public.vehicles & public.requests   │ │  - 4 MB upload limit             │
│  - public.images, pins, repair_items   │ │  - Magic-byte validated JPEG/PNG │
│  - State Machine Enforcement Triggers  │ │  - Signed URLs (10-min expiry)   │
│  - SECURITY DEFINER Functions          │ └──────────────────────────────────┘
│  - Strict RLS & Revoked Direct Grants  │
└────────────────────────────────────────┘
```

### Service Lifecycle State Machine

A service request follows a strict linear state transition managed by database triggers and dedicated API endpoints:

```
                  ┌──────────────┐
                  │    booked    │ ◄── Customer books service request
                  └──────┬───────┘
                         │
        Mechanic claims  │  (Atomic claim_request RPC)
                         ▼
                  ┌──────────────┐
                  │  inspecting  │ ◄── Multi-angle photos & defect pins added
                  └──────┬───────┘
                         │
Mechanic submits report  │  (submit_inspection_report RPC; requires >= 1 photo & pin)
                         ▼
             ┌───────────────────────┐
             │   awaiting_approval   │ ◄── Customer reviews defect pins
             └───────────┬───────────┘
                         │
Customer submits decision│  (submit_decisions RPC)
                         ├──────────────────────────────┐
                         │ At least 1 item approved     │ All items rejected
                         ▼                              ▼
                  ┌──────────────┐              ┌──────────────┐
                  │  repairing   │              │     done     │
                  └──────┬───────┘              └──────────────┘
                         │
 All approved repairs get│  (attach_after_photo RPC; auto-transitions when complete)
 verified after-photos   ▼
                  ┌──────────────┐
                  │     done     │ ◄── Invoice and before/after comparisons unlocked
                  └──────────────┘
```

> **Cancellation Policy**: Customers can cancel a request via `POST /api/requests/[id]/transition` (`action: "cancel"`) only while the status is `booked`, `inspecting`, or `awaiting_approval`. Once work enters `repairing` or reaches `done`, cancellation is rejected.

---

## Security Architecture

Security in ServiceTrack is enforced at the database, network, and application layers:

### 1. Dual-Role Authorization Model
- **Source of Truth**: `public.users.role` is the definitive source of truth (`'customer'` or `'mechanic'`).
- **Trigger Hardening**: The auth trigger `handle_new_user()` runs with `SECURITY DEFINER` and fixed `search_path = public, pg_temp`. It strictly assigns `role = 'customer'`, ignoring any client-supplied `user_metadata`.
- **Mechanic Promotion**: A user can only obtain the `'mechanic'` role via `/api/auth/register`, which verifies the registration code using constant-time comparison (`crypto.timingSafeEqual`) against `process.env.MECHANIC_INVITE_CODE`.

### 2. Grant Lockdown & Row Level Security (RLS)
- Direct mutation grants (`INSERT`, `UPDATE`, `DELETE`) on `public.vehicles` and `public.requests` are revoked from `anon` and `authenticated` roles.
- State mutations execute strictly through server-side Route Handlers via the service-role client after session verification.
- Direct execution of sensitive database functions (`claim_request`, `create_pin_with_item`, `submit_decisions`, etc.) is revoked from `public` and `anon`.

### 3. Private Storage Security
- The `service-images` bucket is completely private (`public: false`) with no direct client-side storage policies.
- File uploads are validated server-side:
  - Magic-byte inspection for authentic JPEG/PNG binaries (SVG, HTML, XML, and polyglots are rejected).
  - 4 MB file size cap enforced both via `Content-Length` headers and raw buffer length.
  - Server-side re-encoding via `sharp` to strip all EXIF, GPS, and metadata tags before storage.
- Storage reads use temporary signed URLs generated server-side with a 10-minute expiry.

### 4. HTTP Headers & Transport Protection
Strict security headers are configured in `next.config.ts`:
- **Content-Security-Policy (CSP)**: Disallows object embeddings, blocks frame ancestors (`frame-ancestors 'none'`), and dynamically restricts `connect-src` and `img-src` to the exact Supabase host without wildcards.
- **X-Frame-Options**: `DENY`
- **X-Content-Type-Options**: `nosniff`
- **Strict-Transport-Security (HSTS)**: `max-age=63072000; includeSubDomains; preload`
- **Permissions-Policy**: Disables camera, microphone, and geolocation APIs.

### 5. Serverless Rate Limiting
- Backed by PostgreSQL (`public.rate_limits` table) via the `check_rate_limit()` stored procedure.
- Handles atomic count updates and window resets cleanly across serverless instances without requiring in-memory state or external caching tiers.

---

## Technology Stack

| Layer | Technology | Details / Purpose |
|---|---|---|
| **Framework** | Next.js 16.4.0 | App Router, Server Components, Route Handlers, Turbopack |
| **UI Library** | React 19.3.0 | Modern concurrent rendering, hooks, form actions |
| **Styling** | Tailwind CSS v4 | CSS-first configuration, Turbopack integration (`@tailwindcss/turbopack`) |
| **Database & Auth** | Supabase / PostgreSQL 15+ | Relational schema, RLS policies, triggers, stored procedures, GoTrue auth |
| **Supabase SDKs** | `@supabase/ssr` 0.12.7, `@supabase/supabase-js` 2.117.3 | Cookie-based session management and service-role database operations |
| **Validation** | Zod 4.6.5 | Request body parsing, query parameter validation, type inference |
| **Image Processing** | Sharp 0.35.5 | Server-side EXIF/GPS stripping, image re-encoding, format normalization |
| **QR Code Engine** | QRCode 1.5.4 | Server-side SVG QR code generation for vehicle history tokens |
| **Icons** | Lucide React 1.52.0 | Consistent iconography |
| **Test Runner** | Node.js Test Runner (`node:test`, `tsx` 4.23.15) | Native Node assertions (`node:assert/strict`), schema and live E2E integration tests |
| **Type System** | TypeScript 5 | Strict typing across components, server routes, and database schemas |

---

## Repository Structure

```
servicetrack/
├── .env.example                  # Environment variable template
├── .env.local                    # Local environment variables (git-ignored)
├── DEPLOY.md                     # Production deployment guide for Vercel & Supabase
├── SECURITY.md                   # Security architecture, grant lockdown, and threat analysis
├── package.json                  # Project dependencies and script definitions
├── next.config.ts                # Next.js configuration, Turbopack rules, and security headers
├── tsconfig.json                 # TypeScript compiler configuration
├── public/                       # Static public assets
├── seed-assets/                  # Sample inspection images used by seed-demo.ts
├── supabase/                     # Sequential SQL database migrations
│   ├── migration.sql             # Base schema, users, vehicles, requests, rate limits, claim RPC
│   ├── migration_phase2.sql      # Multi-angle images, pins, repair items, inspection submission RPC
│   ├── migration_phase3.sql      # Customer approvals, server totals, decision submission RPC
│   ├── migration_phase4.sql      # After-photo proof-of-work, automatic completion RPC
│   └── migration_phase5.sql      # Public service history function, token rotation, plate masking
├── scripts/                      # Isolated CLI administrative tooling
│   ├── seed-demo.ts              # Idempotent demo account and multi-status data seeder
│   └── reset-demo.ts             # Clean-up script targeting @demo.servicetrack.app records
├── src/
│   ├── middleware.ts             # Edge authentication guard, session refresh, role redirection
│   ├── app/
│   │   ├── page.tsx              # Root landing redirector based on session and role
│   │   ├── layout.tsx            # Global HTML document layout and metadata
│   │   ├── globals.css           # Global Tailwind CSS and printable invoice stylesheets
│   │   ├── auth/                 # Customer and mechanic authentication & registration
│   │   │   └── page.tsx
│   │   ├── h/                    # Unauthenticated public vehicle history
│   │   │   └── [token]/
│   │   │       └── page.tsx
│   │   ├── (app)/                # Protected application shell
│   │   │   ├── layout.tsx        # Shell layout wrapping navigation bar
│   │   │   ├── dashboard/        # Customer garage and active requests
│   │   │   ├── book/             # Service booking wizard
│   │   │   ├── vehicles/         # Vehicle creation and editing (/new, /[id]/edit)
│   │   │   ├── mechanic/queue/   # Mechanic open queue and claimed repair jobs
│   │   │   └── requests/[id]/    # Interactive service request hub
│   │   │       ├── page.tsx      # Main inspection, pin editor, approval, and proof view
│   │   │       └── invoice/      # Print-ready itemized invoice view
│   │   └── api/                  # Server-side Route Handlers
│   │       ├── auth/register/    # Mechanic registration with constant-time invite code check
│   │       ├── user/profile/     # User profile retrieval and updating
│   │       ├── vehicles/         # Vehicle CRUD, public link settings, token rotation
│   │       ├── requests/         # Request creation, filtering, claiming, transitions
│   │       │   └── [id]/
│   │       │       ├── claim/    # Atomic mechanic claiming endpoint
│   │       │       ├── images/   # Inspection image uploads and signed URL retrieval
│   │       │       ├── pins/     # Defect pin placement and updates
│   │       │       ├── decisions/# Customer line-item approval submissions
│   │       │       ├── invoice/  # Approved itemized invoice endpoint
│   │       │       ├── transition/# State machine action handler (cancel, release, etc.)
│   │       │       └── items/[itemId]/after-photo/ # Proof-of-work photo upload
│   │       └── public/vehicles/  # Unauthenticated public vehicle history endpoint
│   ├── components/
│   │   ├── navbar.tsx            # Role-aware navigation header
│   │   ├── request-card.tsx      # Service request summary card
│   │   ├── vehicle-card.tsx      # Garage vehicle summary card
│   │   ├── status-stepper.tsx    # Visual request progress stepper
│   │   ├── vehicle-public-link-section.tsx # Public link toggle and QR code card
│   │   ├── inspection/           # Visual inspection editor components
│   │   │   ├── inspection-section.tsx  # Master container for inspection, pins, approvals, proof
│   │   │   ├── inspection-canvas.tsx   # Image canvas with pin overlay and coordinate capture
│   │   │   ├── pin-bottom-sheet.tsx    # Pin defect modal for details, severity, and estimates
│   │   │   └── before-after-slider.tsx # Interactive split comparison slider
│   │   └── ui/                   # Reusable UI primitives (button, card, badge, tabs, etc.)
│   └── lib/
│       ├── auth.ts               # Server-side getAuthenticatedUser() authentication resolver
│       ├── auth-fetch.ts         # Client-side fetch wrapper with automatic session retry
│       ├── constants.ts          # Service types, statuses, severity configs, storage bucket names
│       ├── image-compress.ts     # Client-side pre-upload canvas compression utility
│       ├── public-history.ts     # Public history retrieval helper with signed URL mapping
│       ├── rate-limit.ts         # Serverless PostgreSQL rate limiter caller
│       ├── types.ts              # Core TypeScript interfaces and type definitions
│       ├── utils.ts              # Currency formatting, date formatting, and styling helpers
│       ├── validation.ts         # Zod schemas for all input and mutation payloads
│       └── supabase/
│           ├── admin.ts          # Server-only service-role client (bypasses RLS)
│           ├── client.ts         # Browser-side Supabase client (@supabase/ssr)
│           └── server.ts         # Server-side cookie-aware Supabase client (@supabase/ssr)
└── tests/                        # Automated test suites
    ├── cross-user-access.test.ts # Zod schema validation tests
    ├── invoice-print.test.ts     # Invoice print layout and CSS isolation tests
    ├── role-authorization.test.ts# Role authorization and route guard live tests
    ├── mechanic-queue-banner.test.ts # Mechanic queue 409 claim banner state tests
    ├── cross-user-live.test.ts   # Concurrency and cross-user data isolation tests
    ├── phase2-inspection.test.ts # Inspection images, defect pins, and upload tests
    ├── phase3-decisions.test.ts  # Customer repair decisions and server totals tests
    ├── phase4-proof.test.ts      # Proof-of-repair after photos and completion tests
    ├── phase5-history.test.ts    # Public vehicle history, QR tokens, and masking tests
    └── phase6-demo.test.ts       # Demo seeding and cleanup lifecycle tests
```

---

## Database Schema & Migrations

### Tables

| Table | Primary Key | Description | RLS Policy |
|---|---|---|---|
| `public.users` | `id` (UUID -> `auth.users`) | Canonical user profiles (`role`: `'customer'` or `'mechanic'`) | Read own profile; writes through service-role only |
| `public.vehicles` | `id` (UUID) | Registered vehicles (`plate`, `brand`, `model`, `year`, `public_token`, `public_history_enabled`, `is_active`) | Customer reads own; mechanic reads assigned; writes through service-role |
| `public.requests` | `id` (UUID) | Service requests (`vehicle_id`, `mechanic_id`, `service_type`, `complaint`, `preferred_date`, `status`) | Customer reads own; mechanic reads assigned or open booked; writes through service-role |
| `public.images` | `id` (UUID) | Inspection photos (`request_id`, `storage_path`, `view_angle`, max 10 per request) | Managed exclusively via service-role API routes |
| `public.pins` | `id` (UUID) | Defect coordinates on images (`image_id`, `x`, `y`, `part_name`, `severity`, `notes`) | Managed exclusively via service-role API routes |
| `public.repair_items` | `id` (UUID) | Repair line items (`pin_id`, `description`, `estimate`, `approval_status`, `after_photo_url`, `completed_at`) | Managed exclusively via service-role API routes |
| `public.rate_limits` | `key` (TEXT) | Serverless rate-limiting counters (`count`, `reset_at`) | No direct access; accessible only via `check_rate_limit` RPC |

### Migration Sequence

When setting up a new Supabase project, execute the SQL files in the `supabase/` directory in the following exact order:

1. **`supabase/migration.sql`**: Sets up base tables, foreign keys, RLS policies, the `handle_new_user()` auth trigger, the atomic `claim_request()` function, the `check_rate_limit()` stored procedure, storage bucket configuration, and initial grant revocation.
2. **`supabase/migration_phase2.sql`**: Adds column normalization for `images.storage_path`, cascade constraints, coordinate checks, text-length constraints, whole-rupee checks, the 10-image maximum trigger, and the `create_pin_with_item`, `submit_inspection_report`, and `release_inspection_job` functions.
3. **`supabase/migration_phase3.sql`**: Introduces repair approval lifecycle locks on `repair_items` and the atomic `submit_decisions()` function for customer approvals and server-side total calculations.
4. **`supabase/migration_phase4.sql`**: Configures the `after_photo_url` and `completed_at` columns, enforces after-photo lifecycle triggers, and introduces `attach_after_photo()` for proof-of-work uploads and automated transition to `done`.
5. **`supabase/migration_phase5.sql`**: Adds `public_history_enabled` on `vehicles`, creates the sanitized `public_vehicle_history()` lookup function, implements SQL-based license plate masking, and adds `rotate_vehicle_token()` and `set_public_history()`.

### Key Stored Procedures & Functions

| Function | Security Mode | Parameters | Description |
|---|---|---|---|
| `claim_request` | `SECURITY DEFINER` | `p_request_id UUID` | Atomically assigns a booked request to `auth.uid()` and transitions status to `inspecting`. |
| `create_pin_with_item` | `SECURITY DEFINER` | `p_request_id`, `p_caller_id`, `p_image_id`, `p_x`, `p_y`, `p_part_name`, `p_severity`, `p_notes`, `p_description`, `p_estimate` | Atomically creates a defect pin and repair item within a transaction. |
| `submit_inspection_report` | `SECURITY DEFINER` | `p_request_id`, `p_caller_id` | Verifies >= 1 photo and pin, then transitions request to `awaiting_approval`. |
| `release_inspection_job` | `SECURITY DEFINER` | `p_request_id`, `p_caller_id` | Reverts a job from `inspecting` to `booked` if and only if 0 photos have been uploaded. |
| `submit_decisions` | `SECURITY DEFINER` | `p_request_id`, `p_caller_id`, `p_decisions JSONB` | Applies customer decisions, calculates total in SQL, and moves status to `repairing` or `done`. |
| `attach_after_photo` | `SECURITY DEFINER` | `p_request_id`, `p_item_id`, `p_caller_id`, `p_path TEXT` | Attaches proof photo to approved repair; automatically completes request when all items have proof. |
| `public_vehicle_history` | `SECURITY DEFINER` | `p_token UUID` | Returns public vehicle profile with masked plate and completed repair records. |
| `rotate_vehicle_token` | `SECURITY DEFINER` | `p_vehicle_id`, `p_caller_id` | Generates and assigns a new random UUID public token for a vehicle. |
| `set_public_history` | `SECURITY DEFINER` | `p_vehicle_id`, `p_caller_id`, `p_enabled BOOLEAN` | Enables or disables public service history visibility for a vehicle. |
| `check_rate_limit` | `SECURITY DEFINER` | `p_key TEXT`, `p_max_requests INT`, `p_window_seconds INT` | Manages IP/key rate counters in Postgres and returns a boolean pass/fail. |

---

## API Route Reference

All API routes validate inputs using Zod schemas and enforce session identity using `getAuthenticatedUser()`.

| Endpoint | Method | Role | Description |
|---|---|---|---|
| `/api/auth/register` | `POST` | Public | Register customer or mechanic. Mechanics must supply valid `inviteCode`. |
| `/api/user/profile` | `GET` | Authenticated | Retrieve authenticated user profile and role. |
| `/api/user/profile` | `PATCH` | Authenticated | Update name or phone number (email and role cannot be altered). |
| `/api/vehicles` | `GET` | Authenticated | Customers fetch their active vehicles; mechanics fetch vehicles for accessible jobs. |
| `/api/vehicles` | `POST` | Customer | Register a new vehicle in the customer garage. |
| `/api/vehicles/[id]` | `GET` | Authenticated | Fetch vehicle details (ownership or assigned job verified). |
| `/api/vehicles/[id]` | `PATCH` | Customer | Update vehicle plate, brand, model, or year (soft-deleted vehicles locked). |
| `/api/vehicles/[id]` | `DELETE` | Customer | Soft-delete vehicle (`is_active = false`), blocked if active repairs exist. |
| `/api/vehicles/[id]/public-link` | `GET` | Customer | Fetch vehicle public history URL, token, enabled status, and SVG QR code. |
| `/api/vehicles/[id]/public-link/rotate` | `POST` | Customer | Generate a new random UUID public token, invalidating old URLs. |
| `/api/vehicles/[id]/public-link/enabled` | `POST` | Customer | Toggle public service history visibility on or off. |
| `/api/requests` | `GET` | Authenticated | List service requests (customers see own; mechanics filter `open` or `assigned`). |
| `/api/requests` | `POST` | Customer | Book a new service request for an active vehicle. |
| `/api/requests/[id]` | `GET` | Authenticated | Fetch request details (customers never receive mechanic user IDs). |
| `/api/requests/[id]/claim` | `POST` | Mechanic | Atomically claim an unassigned booked service request. |
| `/api/requests/[id]/images` | `GET` | Authenticated | Fetch inspection photos with 10-minute signed URLs. |
| `/api/requests/[id]/images` | `POST` | Mechanic | Upload multi-angle inspection image (4 MB cap, Sharp stripped). |
| `/api/requests/[id]/pins` | `POST` | Mechanic | Add defect pin and line-item estimate on an inspection photo. |
| `/api/requests/[id]/decisions` | `POST` | Customer | Submit approval/rejection decisions for all inspection items. |
| `/api/requests/[id]/items/[itemId]/after-photo` | `POST` | Mechanic | Upload proof-of-repair photo for an approved item. |
| `/api/requests/[id]/invoice` | `GET` | Authenticated | Fetch invoice with approved repair items and server-computed total. |
| `/api/requests/[id]/transition` | `POST` / `PATCH` | Authenticated | Perform state transitions: `cancel`, `release`, `submit_report`, `complete`. |
| `/api/public/vehicles/[token]` | `GET` | Public | Unauthenticated, rate-limited public service history with masked plate. |

---

## Prerequisites & Environment Configuration

### Prerequisites

- **Node.js**: `20.x` or higher
- **Package Manager**: `npm` (v10+) or `pnpm`
- **Supabase Project**: An active Supabase project with database, auth, and storage enabled.

### Environment Variables

Create a `.env.local` file in the project root based on `.env.example`:

```bash
# Supabase Configuration
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-public-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-secret-key

# Mechanic Invite Code (used for constant-time comparison during registration)
MECHANIC_INVITE_CODE=your-secret-mechanic-invite-code

# Canonical Application URL
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Demo Password (used by scripts/seed-demo.ts)
DEMO_PASSWORD=your-secure-demo-password
```

#### Variable Details

- `NEXT_PUBLIC_SUPABASE_URL`: HTTPS endpoint for your Supabase project. Also used in `next.config.ts` to derive strict CSP connect/image rules.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Public client key used by `@supabase/ssr` in browser contexts.
- `SUPABASE_SERVICE_ROLE_KEY`: Elevated administrative secret key. **Never expose to the client.** Guarded with `import "server-only"`.
- `MECHANIC_INVITE_CODE`: Shared secret string required when registering an account with `role: "mechanic"`.
- `NEXT_PUBLIC_APP_URL`: Base URL used for constructing public QR history links (e.g., `http://localhost:3000` or production domain).
- `DEMO_PASSWORD`: Default password assigned to generated demo accounts when running `scripts/seed-demo.ts`.

---

## Installation & Setup

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd servicetrack
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment variables**:
   ```bash
   cp .env.example .env.local
   # Edit .env.local with your real Supabase credentials
   ```

4. **Apply database migrations**:
   Open the [Supabase Dashboard](https://supabase.com/dashboard) for your project, navigate to the **SQL Editor**, and run the migration files sequentially:
   - `supabase/migration.sql`
   - `supabase/migration_phase2.sql`
   - `supabase/migration_phase3.sql`
   - `supabase/migration_phase4.sql`
   - `supabase/migration_phase5.sql`

5. **Configure Supabase Auth Settings**:
   Under **Authentication > URL Configuration** in the Supabase Dashboard:
   - **Site URL**: Set to `http://localhost:3000` (or your production URL).
   - **Redirect URLs**: Add `http://localhost:3000/**`.
   - **Email Confirmations**: For local testing and running demo scripts, you can disable email confirmations under **Authentication > Providers > Email**. Enable them for production deployments.

---

## Running the Application

### Development Server

Start the Next.js development server with Turbopack:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Production Build

Create and test an optimized production build locally:

```bash
npm run build
npm start
```

### Code Quality & Linting

Run ESLint to check for code standards:

```bash
npm run lint
```

---

## Automated Test Suite

ServiceTrack includes a test suite covering schema validation, print styles, live role authorization, concurrency, inspection mechanics, approvals, proof attachments, and public history.

Tests run using Node's native test runner (`node:test`) and TypeScript execution via `tsx`.

### Running All Tests

```bash
npm test
```

*Note: Running the full suite executes live integration tests against the configured Supabase instance specified in `.env.local`.*

### Running Fast Schema & Unit Tests

To run local schema and style isolation tests without hitting network services:

```bash
npx tsx --test tests/cross-user-access.test.ts tests/invoice-print.test.ts
```

### Test Suite Overview

| Test File | Scope | Key Validations |
|---|---|---|
| `tests/cross-user-access.test.ts` | Unit / Schema | Zod schemas, input restrictions, unassignable field omissions |
| `tests/invoice-print.test.ts` | Unit / Styles | Printable stylesheet scoping, A4 portrait constraints, `.no-print` classes |
| `tests/role-authorization.test.ts` | Live Integration | Role restrictions, cross-user claim protections, middleware redirects |
| `tests/mechanic-queue-banner.test.ts` | Unit / Logic | UI alert banners on claim race conditions (409) and session expiration |
| `tests/cross-user-live.test.ts` | Live Integration | Concurrency races on job claiming (atomic 200 vs 409), vehicle isolation |
| `tests/phase2-inspection.test.ts` | Live Integration | 4MB limit, magic-byte checks, EXIF stripping, 10-image cap, pin creation |
| `tests/phase3-decisions.test.ts` | Live Integration | Customer item approvals, server-calculated totals, status transitions |
| `tests/phase4-proof.test.ts` | Live Integration | After-repair photo uploads, automatic completion trigger |
| `tests/phase5-history.test.ts` | Live Integration | Public vehicle history endpoint, plate masking rules, token rotation |
| `tests/phase6-demo.test.ts` | Live Integration | Demo seeder and cleanup domain isolation and validation rules |

---

## Demo Data Management

The repository provides safe, isolated CLI scripts to populate and reset demo accounts and service requests.

> **Safety Notice**: Demo operations strictly target accounts ending with `@demo.servicetrack.app`. The scripts will refuse to modify or delete non-demo customer or mechanic data.

### 1. Preview Seeding (Dry Run)

```bash
npx tsx scripts/seed-demo.ts
```

Shows the accounts, vehicles, and requests that would be generated without writing to the database.

### 2. Seed Demo Data

```bash
npx tsx scripts/seed-demo.ts --confirm
```

Generates:
- **1 Mechanic Account**: `demo-mechanic@demo.servicetrack.app` (Password: value of `DEMO_PASSWORD`)
- **2 Customer Accounts**:
  - `demo-customer1@demo.servicetrack.app`
  - `demo-customer2@demo.servicetrack.app`
- **3 Vehicles**: Indian license plates (`TS09AB1234`, `MH12CD5678`, `KA01EF9012`)
- **6 Service Requests**: One request representing each lifecycle status (`booked`, `inspecting`, `awaiting_approval`, `repairing`, `done`, and `cancelled`).
- Sample before and after images uploaded directly to the private `service-images` storage bucket.

### 3. Reset / Clean Up Demo Data

```bash
# Preview cleanup
npx tsx scripts/reset-demo.ts

# Execute cleanup
npx tsx scripts/reset-demo.ts --confirm
```

Removes all demo users, vehicles, requests, defect pins, and storage files matching `@demo.servicetrack.app` without touching production data.

---

## Interactive 3-Minute Walkthrough

Follow this step-by-step path to experience the complete service lifecycle locally:

1. **Seed Demo Records**:
   ```bash
   npx tsx scripts/seed-demo.ts --confirm
   ```

2. **Step 1: Customer Books a Service**:
   - Open [http://localhost:3000/auth](http://localhost:3000/auth) and sign in as `demo-customer1@demo.servicetrack.app`.
   - Navigate to `/book`, choose `TS09AB1234`, select `Brake Service`, enter a complaint, and submit.
   - The request appears on your customer dashboard with status **Booked**.

3. **Step 2: Mechanic Claims the Job**:
   - In a private/incognito window, sign in as `demo-mechanic@demo.servicetrack.app`.
   - Open `/mechanic/queue`, locate the newly booked request under the **Open Bookings** tab, and click **Claim**.
   - Status updates atomically to **Inspecting**, and the request moves to your **Assigned** tab.

4. **Step 3: Multi-Angle Inspection & Pinning**:
   - Click into the request. On mobile view or resized screen, open the **Inspection** tab.
   - Select angle `front`, upload an inspection photo (JPEG or PNG).
   - Tap directly on the vehicle image to drop a defect pin. Enter the part name (e.g., "Front Brake Pads"), select severity (`High`), provide repair description, and set an estimate (e.g., `3500`).
   - Click **Submit Inspection Report**. Status updates to **Awaiting Approval**.

5. **Step 4: Customer Approves Line Items**:
   - Switch back to the customer browser window and refresh the request page.
   - View the pinned defect on the photo canvas, review the itemized estimate, and select **Approve**.
   - Click **Submit Decisions**. Status transitions to **Repairing**.

6. **Step 5: Mechanic Attaches After-Photo**:
   - In the mechanic window, open the approved repair item.
   - Upload an after-repair photo showing the completed work.
   - Because all approved items now have proof photos, the status automatically advances to **Done**.

7. **Step 6: Before/After Slider & Itemized Invoice**:
   - Both mechanic and customer can now view the interactive before/after split comparison slider.
   - Click **View Printable Invoice** to inspect the server-calculated invoice. Click **Print Invoice** to preview the clean, single-page A4 print layout.

8. **Step 7: Public QR Verification**:
   - In the customer window, navigate to vehicle settings (`/vehicles/[id]/edit`).
   - Copy the public history link or scan the QR code in an unauthenticated browser window (`/h/[token]`).
   - Observe the masked plate (`TS09****34`), verified service record, before/after slider, and notice that customer identities and costs are strictly excluded.
   - Click **Rotate Link** in vehicle settings; observe that the previous link immediately returns 404.

---

## Production Deployment

ServiceTrack is optimized for deployment on Vercel paired with a Supabase PostgreSQL backend. Detailed step-by-step instructions are documented in [DEPLOY.md](DEPLOY.md).

### Deployment Summary

1. **Import Repository**: Connect the repository to [Vercel](https://vercel.com).
2. **Environment Variables**: Configure all variables in the Vercel project settings:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `MECHANIC_INVITE_CODE`
   - `NEXT_PUBLIC_APP_URL` (set to your production URL, e.g., `https://your-domain.vercel.app`)
   - `DEMO_PASSWORD`
3. **Supabase Auth URL Configuration**:
   - Update **Site URL** to your production domain.
   - Add production redirect URIs: `https://your-domain.vercel.app/**`.
   - Enable email confirmations under **Authentication > Providers > Email**.
4. **Run Database Migrations**: Apply all 5 SQL migrations in your production database.

---

## Known Limitations & Design Considerations

- **Visual License Plate Visibility in Photos**: The application automatically masks plate strings in database queries and public views (e.g., `TS09****34`). However, physical vehicle license plates captured directly in wide-angle exterior photos remain visible within the raw image pixels unless manually cropped by the photographer prior to upload.
- **Supabase Free-Tier Project Pausing**: Supabase projects hosted on free-tier plans pause after periods of inactivity. If API routes fail with 500 errors or connection timeouts, resume the database in the Supabase Dashboard.
- **Direct Auth Client Bypass**: Direct client-side calls to `supabase.auth.signUp()` or `signInWithPassword()` bypass Next.js API route rate limiters. Always enforce captcha and rate limits within the Supabase Auth Settings dashboard in production environments.
- **10-Image Inspection Cap**: Each service request is constrained to a maximum of 10 inspection photos enforced by database trigger `check_images_inspecting_lock()`.

---

## Contributing & License

Contributions, bug reports, and pull requests are welcome. Please ensure that all modified code passes `npm run lint` and all unit and schema tests pass via `npm test` before submitting changes.

This project is distributed under the standard private repository terms unless explicitly noted otherwise.
