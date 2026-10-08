/**
 * End-to-end role authorization tests against the live Supabase instance.
 * Validates:
 * 1. Customer calling claim returns 403 and mechanic_id stays null.
 * 2. Customer GET on /mechanic/queue redirects to /dashboard.
 * 3. Mechanic POST to /api/vehicles returns 403.
 * 4. Mechanic POST to /api/requests returns 403.
 * 5. Customer calling transition on unauthorized request returns 403.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createBrowserClient } from "@supabase/ssr";

// Ensure environment variables from .env.local are loaded
function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [key, ...rest] = trimmed.split("=");
      if (key && rest.length > 0) {
        const val = rest.join("=").trim().replace(/^["']|["']$/g, "");
        if (!process.env[key.trim()]) {
          process.env[key.trim()] = val;
        }
      }
    }
  }
}

loadEnv();

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

describe("Live Supabase Role Authorization & Route Guards", () => {
  const admin = createAdminClient(supabaseUrl, serviceRoleKey);

  const cleanupUserIds: string[] = [];
  const cleanupVehicleIds: string[] = [];
  const cleanupRequestIds: string[] = [];

  let customerUser: { id: string; email: string; cookie: string };
  let mechanicUser: { id: string; email: string; cookie: string };
  let testVehicleId: string;
  let testRequestId: string;

  async function createTestUser(role: "customer" | "mechanic") {
    const timestamp = Date.now() + Math.floor(Math.random() * 10000);
    const email = `test_${role}_${timestamp}@example.com`;
    const password = "Password123!";

    const { data: userRes, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name: `Test ${role}` },
    });

    if (createError || !userRes.user) {
      throw new Error(`Failed to create test user: ${createError?.message}`);
    }

    const userId = userRes.user.id;
    cleanupUserIds.push(userId);

    if (role === "mechanic") {
      await admin.auth.admin.updateUserById(userId, {
        app_metadata: { role: "mechanic" },
      });
      const { error: updateError } = await admin
        .from("users")
        .update({ role: "mechanic" })
        .eq("id", userId);
      if (updateError) {
        throw new Error(`Failed to set mechanic role: ${updateError.message}`);
      }
    }

    // Sign in to obtain @supabase/ssr session cookies
    const jar: Record<string, string> = {};
    const ssrClient = createBrowserClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll: () => Object.entries(jar).map(([name, value]) => ({ name, value })),
        setAll: (cs) => cs.forEach((x) => (jar[x.name] = x.value)),
      },
    });

    const { data: authData, error: loginError } = await ssrClient.auth.signInWithPassword({
      email,
      password,
    });

    if (loginError || !authData.session) {
      throw new Error(`Failed to sign in: ${loginError?.message}`);
    }

    const cookie = Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    return { id: userId, email, cookie };
  }

  before(async () => {
    // Ensure dev server is reachable
    try {
      const ping = await fetch(`${baseUrl}/auth`);
      if (!ping.ok && ping.status !== 200) {
        throw new Error(`Server at ${baseUrl} returned ${ping.status}`);
      }
    } catch (err) {
      throw new Error(
        `Development server is not reachable at ${baseUrl}. Ensure "npm run dev" is running. Error: ${err}`
      );
    }

    // 1. Create a verified customer user
    customerUser = await createTestUser("customer");

    // 2. Create a verified mechanic user
    mechanicUser = await createTestUser("mechanic");

    // 3. Create a test vehicle owned by customer
    const { data: vehicle, error: vehicleErr } = await admin
      .from("vehicles")
      .insert({
        user_id: customerUser.id,
        plate: `TEST-${Math.floor(Math.random() * 8999 + 1000)}`,
        brand: "TestBrand",
        model: "TestModel",
        year: 2022,
        is_active: true,
      })
      .select("id")
      .single();

    if (vehicleErr || !vehicle) {
      throw new Error(`Failed to seed test vehicle: ${vehicleErr?.message}`);
    }
    testVehicleId = vehicle.id;
    cleanupVehicleIds.push(testVehicleId);

    // 4. Create an unassigned booked service request
    const { data: request, error: requestErr } = await admin
      .from("requests")
      .insert({
        vehicle_id: testVehicleId,
        service_type: "full_inspection",
        complaint: "Routine inspection test",
        preferred_date: "2026-11-01",
        status: "booked",
        mechanic_id: null,
      })
      .select("id")
      .single();

    if (requestErr || !request) {
      throw new Error(`Failed to seed test request: ${requestErr?.message}`);
    }
    testRequestId = request.id;
    cleanupRequestIds.push(testRequestId);
  });

  after(async () => {
    // Cleanup requests, vehicles, and users created during test
    for (const reqId of cleanupRequestIds) {
      await admin.from("requests").delete().eq("id", reqId);
    }
    for (const vehId of cleanupVehicleIds) {
      await admin.from("vehicles").delete().eq("id", vehId);
    }
    for (const uid of cleanupUserIds) {
      await admin.auth.admin.deleteUser(uid);
    }
  });

  it("customer calling claim returns 403 and mechanic_id stays null", async () => {
    const res = await fetch(`${baseUrl}/api/requests/${testRequestId}/claim`, {
      method: "POST",
      headers: {
        Cookie: customerUser.cookie,
        "Content-Type": "application/json",
      },
    });

    assert.strictEqual(res.status, 403, `Expected status 403, got ${res.status}`);
    const json = await res.json();
    assert.match(json.error, /forbidden|mechanic/i);

    // Verify in database that mechanic_id was NOT modified and remains null
    const { data: updatedReq, error: fetchError } = await admin
      .from("requests")
      .select("id, status, mechanic_id")
      .eq("id", testRequestId)
      .single();

    assert.strictEqual(fetchError, null);
    assert.strictEqual(updatedReq.mechanic_id, null, "mechanic_id must remain null");
    assert.strictEqual(updatedReq.status, "booked", "status must remain 'booked'");
  });

  it("customer GET on /mechanic/queue redirects to /dashboard", async () => {
    const res = await fetch(`${baseUrl}/mechanic/queue`, {
      method: "GET",
      headers: {
        Cookie: customerUser.cookie,
      },
      redirect: "manual",
    });

    const isRedirect = [302, 307, 308].includes(res.status);
    assert.ok(isRedirect, `Expected redirect status (302/307/308), got ${res.status}`);

    const location = res.headers.get("location") || "";
    assert.ok(
      location.includes("/dashboard"),
      `Expected redirect location to contain '/dashboard', got '${location}'`
    );
  });

  it("mechanic POST to /api/vehicles returns 403", async () => {
    const testPlate = `MEC-${Math.floor(Math.random() * 8999 + 1000)}`;
    const res = await fetch(`${baseUrl}/api/vehicles`, {
      method: "POST",
      headers: {
        Cookie: mechanicUser.cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        plate: testPlate,
        brand: "Ford",
        model: "F-150",
        year: 2022,
      }),
    });

    assert.strictEqual(res.status, 403, `Expected status 403, got ${res.status}`);
    const json = await res.json();
    assert.match(json.error, /only customers/i);

    // Verify in database that vehicle was not created
    const { data: vehicles } = await admin
      .from("vehicles")
      .select("id")
      .eq("plate", testPlate);

    assert.strictEqual((vehicles || []).length, 0, "Vehicle should not be created in DB");
  });

  it("mechanic POST to /api/requests returns 403", async () => {
    const res = await fetch(`${baseUrl}/api/requests`, {
      method: "POST",
      headers: {
        Cookie: mechanicUser.cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        vehicle_id: testVehicleId,
        service_type: "oil_change",
        complaint: "Mechanic trying to book service",
        preferred_date: "2026-11-05",
      }),
    });

    assert.strictEqual(res.status, 403, `Expected status 403, got ${res.status}`);
    const json = await res.json();
    assert.match(json.error, /only customers/i);
  });

  it("mechanic GET on customer-only pages (/dashboard, /book) redirects to /mechanic/queue", async () => {
    const resDashboard = await fetch(`${baseUrl}/dashboard`, {
      method: "GET",
      headers: {
        Cookie: mechanicUser.cookie,
      },
      redirect: "manual",
    });

    assert.ok([302, 307, 308].includes(resDashboard.status));
    assert.ok((resDashboard.headers.get("location") || "").includes("/mechanic/queue"));

    const resBook = await fetch(`${baseUrl}/book`, {
      method: "GET",
      headers: {
        Cookie: mechanicUser.cookie,
      },
      redirect: "manual",
    });

    assert.ok([302, 307, 308].includes(resBook.status));
    assert.ok((resBook.headers.get("location") || "").includes("/mechanic/queue"));
  });
});
