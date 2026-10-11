# ServiceTrack

ServiceTrack is a transparent vehicle service tracking system built with Next.js App Router and Supabase. It offers end-to-end service lifecycle management—from booking and mechanic inspection with defect pin-pointing, to customer-approved itemized estimates, before/after proof-of-work documentation, and QR-code-accessible vehicle service records.

---

## 1. Setup & Installation

### Prerequisites
- Node.js 20+
- npm or pnpm
- A Supabase project

### Clone & Install
```bash
git clone <repo-url>
cd servicetrack
npm install
```

### Environment Variables
Create `.env.local` based on `.env.example`:

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous public API key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role secret key (server-side only) |
| `MECHANIC_INVITE_CODE` | Secret invite code required for mechanic registration |
| `NEXT_PUBLIC_APP_URL` | Canonical application URL (e.g. `http://localhost:3000` or production domain) |
| `DEMO_PASSWORD` | Password used by `scripts/seed-demo.ts` for demo accounts |

---

## 2. Database Migrations

Run SQL migrations in your Supabase SQL Editor in the following order:

1. `supabase/migration.sql` — Base schema, users, vehicles, requests, role triggers, and rate limiter.
2. `supabase/migration_phase2.sql` — Multi-angle inspection images, defect pins, repair items, and `create_pin_with_item` / `submit_inspection_report` functions.
3. `supabase/migration_phase3.sql` — Customer decision submission (`submit_decisions`), server-computed estimate totals, and invoice generation.
4. `supabase/migration_phase4.sql` — Proof-of-repair after photos (`attach_after_photo`) and automated transition to completed status.
5. `supabase/migration_phase5.sql` — Public vehicle service history, QR token management, plate masking rules, and link enable/disable controls.

### Supabase Auth Settings
In the Supabase Dashboard under **Authentication > Settings**:
- **Email Confirmations**: Can be toggled off for local testing or demo scripts; must be turned on for production users.
- **Site URL & Redirect URLs**: Set to your application domain (e.g., `http://localhost:3000` for local dev or your production Vercel URL).

---

## 3. Running the App & Tests

### Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### Test Suite
Run the automated test suite:
```bash
npm test
```

---

## 4. Demo Data Management

The project includes isolated demo seeding and cleanup scripts targeting only `@demo.servicetrack.app` accounts.

### Dry Run (Preview only)
```bash
npx tsx scripts/seed-demo.ts
npx tsx scripts/reset-demo.ts
```

### Seed Demo Data
```bash
npx tsx scripts/seed-demo.ts --confirm
```
This generates:
- **1 Mechanic Account**: `demo-mechanic@demo.servicetrack.app`
- **2 Customer Accounts**: `demo-customer1@demo.servicetrack.app` and `demo-customer2@demo.servicetrack.app`
- **3 Vehicles**: Realistic Indian plates (`TS09AB1234`, `MH12CD5678`, `KA01EF9012`)
- **Requests across all 6 statuses**: `booked`, `inspecting`, `awaiting_approval`, `repairing`, `done`, and `cancelled`
- Before/after images uploaded into the private bucket and linked through database functions.

### Reset Demo Data
```bash
npx tsx scripts/reset-demo.ts --confirm
```
Safely deletes all demo accounts, vehicles, requests, and their storage files without touching non-demo data.

---

## 5. 3-Minute Interactive Demo Walkthrough

1. **Book a Service (Customer)**
   - Sign in as `demo-customer1@demo.servicetrack.app`.
   - Go to `/book`, choose `TS09AB1234`, select service type, and submit.
   - The request appears on the dashboard with status `Booked`.

2. **Claim the Request (Mechanic)**
   - In a private/incognito window or separate profile, sign in as `demo-mechanic@demo.servicetrack.app`.
   - Open `/mechanic/queue` and click **Claim** on the new request.
   - The status updates to `Inspecting`.

3. **Inspect with Defect Pins (Mobile-Width)**
   - Resize your browser window to mobile width (~390px).
   - In the inspection tab, select a car angle and upload an inspection photo.
   - Tap directly on the vehicle image to place a defect pin, enter the part name (e.g., "Front Brake Pads"), severity, and estimate amount.
   - Click **Submit Inspection Report**. Status updates to `Awaiting Approval`.

4. **Review & Approve (Customer)**
   - Switch back to the customer window and open the request.
   - View the interactive inspection report, inspect the pinned defects, and choose **Approve** or **Reject** per item.
   - Click **Submit Decisions**. Status transitions to `Repairing`.

5. **Upload After-Photo & Complete (Mechanic)**
   - In the mechanic window, open the approved repair items.
   - Upload the after-repair photo for each approved item.
   - When the last approved item has its photo attached, the system automatically transitions the request to `Done`.

6. **Interactive Before/After Slider**
   - Both mechanic and customer can now slide the interactive before/after comparison tool to inspect the completed work.
   - Access the itemized invoice showing only customer-approved repairs and the server-calculated total.

7. **Public QR Link & Rotation**
   - On the customer dashboard or vehicle edit page, toggle the **Public Service History Link**.
   - Copy the link or scan the QR code in a private window without logging in (`/h/[token]`).
   - Observe the masked plate (`TS09****34`), completed repair records, and verified before/after photos.
   - Rotate the link to immediately revoke the old URL and generate a fresh QR code.

---

## 6. Known Limits

- **Photographic Plate Visibility**: While the vehicle plate number is masked in the public page text (e.g., `TS09****34`), unedited photos taken from vehicle exterior angles may still show the physical license plate if visible in the frame.
- **Supabase Free Tier Inactivity**: Supabase projects on free plans automatically pause after a period of inactivity. If API requests fail to connect, wake the project in the Supabase Dashboard.
- **Email Confirmation**: Automatic email confirmation is disabled by default for demo convenience. In production environments, enable email verification under Supabase Auth Settings to ensure user identity.
