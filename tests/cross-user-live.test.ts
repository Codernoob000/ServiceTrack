/**
 * Real cross-user access, concurrency, and authorization tests against live Supabase.
 *
 * Verifies:
 * 1. Customer B GET/PATCH/DELETE on A's vehicle is denied and A's data is unchanged.
 * 2. Customer B reading or cancelling A's request is denied.
 * 3. CONCURRENT claim: two claim calls with Promise.all from two mechanics on one booked request;
 *    exactly one returns 200 and the other 409.
 * 4. Invalid transitions rejected (booked to done, customer start_inspection, cancel after repairing).
 * 5. Mechanic POST to cancel returns 403 with status unchanged; assigned mechanic release returns 200 to booked.
 * 6. Vehicle PATCH cannot change user_id, is_active, or public_token.
 * 7. Direct Supabase signUp with data.role = 'mechanic' yields role = 'customer' in public.users.
 * 8. Teardown removes all created test users and verifies no leftover users remain in auth.users or public.users.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createBrowserClient } from "@supabase/ssr";

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

describe("Live Supabase Cross-User Authorization & Concurrency", () => {
  const admin = createAdminClient(supabaseUrl, serviceRoleKey);
  const testRunId = Date.now();
  const prefix = `xuser_${testRunId}`;

  const cleanupUserIds: string[] = [];
  const cleanupVehicleIds: string[] = [];
  const cleanupRequestIds: string[] = [];

  let customerA: { id: string; email: string; cookie: string };
  let customerB: { id: string; email: string; cookie: string };
  let mechanic1: { id: string; email: string; cookie: string };
  let mechanic2: { id: string; email: string; cookie: string };

  let vehicleA: { id: string; public_token: string; brand: string; model: string; plate: string; year: number };
  let requestA: { id: string };

  async function createTestUser(identifier: string, role: "customer" | "mechanic") {
    const email = `${prefix}_${identifier}_${Math.floor(Math.random() * 100000)}@example.com`;
    const password = "Password123!";

    const { data: userRes, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name: `Test ${identifier}` },
    });

    if (createError || !userRes.user) {
      throw new Error(`Failed to create user ${email}: ${createError?.message}`);
    }

    const userId = userRes.user.id;
    cleanupUserIds.push(userId);

    if (role === "mechanic") {
      await admin.auth.admin.updateUserById(userId, {
        app_metadata: { role: "mechanic" },
      });
      const { error: roleError } = await admin
        .from("users")
        .update({ role: "mechanic" })
        .eq("id", userId);
      if (roleError) {
        throw new Error(`Failed to set mechanic role: ${roleError.message}`);
      }
    }

    // Sign in to retrieve auth cookies
    const jar: Record<string, string> = {};
    const ssrClient = createBrowserClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll: () => Object.entries(jar).map(([name, value]) => ({ name, value })),
        setAll: (cs) => cs.forEach((x) => (jar[x.name] = x.value)),
      },
    });

    const { error: loginError } = await ssrClient.auth.signInWithPassword({
      email,
      password,
    });

    if (loginError) {
      throw new Error(`Failed to sign in ${email}: ${loginError.message}`);
    }

    const cookie = Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    return { id: userId, email, cookie };
  }

  before(async () => {
    // 1. Seed Customer A, Customer B, Mechanic 1, Mechanic 2
    customerA = await createTestUser("cust_a", "customer");
    customerB = await createTestUser("cust_b", "customer");
    mechanic1 = await createTestUser("mech_1", "mechanic");
    mechanic2 = await createTestUser("mech_2", "mechanic");

    // 2. Seed Customer A's vehicle
    const plate = `TSTA-${Math.floor(Math.random() * 8999 + 1000)}`;
    const { data: veh, error: vehErr } = await admin
      .from("vehicles")
      .insert({
        user_id: customerA.id,
        plate,
        brand: "Toyota",
        model: "Camry",
        year: 2021,
        is_active: true,
      })
      .select("id, public_token, brand, model, plate, year")
      .single();

    if (vehErr || !veh) {
      throw new Error(`Failed to seed vehicle for Customer A: ${vehErr?.message}`);
    }

    vehicleA = veh;
    cleanupVehicleIds.push(veh.id);

    // 3. Seed request A for Customer A
    const { data: req, error: reqErr } = await admin
      .from("requests")
      .insert({
        vehicle_id: vehicleA.id,
        service_type: "oil_change",
        complaint: "Regular 5,000 mile synthetic oil change",
        preferred_date: "2026-11-10",
        status: "booked",
        mechanic_id: null,
      })
      .select("id")
      .single();

    if (reqErr || !req) {
      throw new Error(`Failed to seed request for Customer A: ${reqErr?.message}`);
    }

    requestA = req;
    cleanupRequestIds.push(req.id);
  });

  after(async () => {
    // Cleanup requests, vehicles, and users
    for (const reqId of cleanupRequestIds) {
      await admin.from("requests").delete().eq("id", reqId);
    }
    for (const vehId of cleanupVehicleIds) {
      await admin.from("vehicles").delete().eq("id", vehId);
    }
    for (const uid of cleanupUserIds) {
      await admin.auth.admin.deleteUser(uid);
    }

    // List and verify leftover test users in auth.users and public.users
    const { data: { users } } = await admin.auth.admin.listUsers();
    const leftoverAuth = users.filter((u) => u.email?.startsWith(prefix));
    const { data: leftoverPublic } = await admin
      .from("users")
      .select("id, email")
      .ilike("email", `${prefix}%`);

    console.log(`[Teardown] Leftover test users in auth.users: ${leftoverAuth.length}`);
    console.log(`[Teardown] Leftover test users in public.users: ${leftoverPublic?.length ?? 0}`);

    assert.strictEqual(leftoverAuth.length, 0, "No leftover test users should remain in auth.users");
    assert.strictEqual(leftoverPublic?.length ?? 0, 0, "No leftover test users should remain in public.users");
  });

  it("customer B GET/PATCH/DELETE on A's vehicle is denied and A's data is unchanged", async () => {
    // 1. GET
    const getRes = await fetch(`${baseUrl}/api/vehicles/${vehicleA.id}`, {
      headers: { Cookie: customerB.cookie },
    });
    assert.ok(
      getRes.status === 403 || getRes.status === 404,
      `Expected 403 or 404 for B reading A's vehicle, got ${getRes.status}`
    );

    // 2. PATCH
    const patchRes = await fetch(`${baseUrl}/api/vehicles/${vehicleA.id}`, {
      method: "PATCH",
      headers: { Cookie: customerB.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ brand: "MaliciousHackedBrand", model: "Corrupted" }),
    });
    assert.ok(
      patchRes.status === 403 || patchRes.status === 404,
      `Expected 403 or 404 for B patching A's vehicle, got ${patchRes.status}`
    );

    // 3. DELETE
    const deleteRes = await fetch(`${baseUrl}/api/vehicles/${vehicleA.id}`, {
      method: "DELETE",
      headers: { Cookie: customerB.cookie },
    });
    assert.ok(
      deleteRes.status === 403 || deleteRes.status === 404,
      `Expected 403 or 404 for B deleting A's vehicle, got ${deleteRes.status}`
    );

    // 4. Verify A's vehicle in DB is completely unchanged
    const { data: currentVeh, error } = await admin
      .from("vehicles")
      .select("*")
      .eq("id", vehicleA.id)
      .single();

    assert.strictEqual(error, null);
    assert.strictEqual(currentVeh.brand, "Toyota");
    assert.strictEqual(currentVeh.model, "Camry");
    assert.strictEqual(currentVeh.user_id, customerA.id);
    assert.strictEqual(currentVeh.is_active, true);
  });

  it("customer B reading or cancelling A's request is denied", async () => {
    // 1. Customer B reading A's request
    const getRes = await fetch(`${baseUrl}/api/requests/${requestA.id}`, {
      headers: { Cookie: customerB.cookie },
    });
    assert.ok(
      getRes.status === 403 || getRes.status === 404,
      `Expected 403 or 404 for B reading A's request, got ${getRes.status}`
    );

    // 2. Customer B attempting to cancel A's request
    const cancelRes = await fetch(`${baseUrl}/api/requests/${requestA.id}/transition`, {
      method: "POST",
      headers: { Cookie: customerB.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    });
    assert.strictEqual(cancelRes.status, 403, "Expected 403 for Customer B cancelling A's request");

    // 3. Verify request is still in booked status
    const { data: currentReq } = await admin
      .from("requests")
      .select("status, mechanic_id")
      .eq("id", requestA.id)
      .single();

    assert.strictEqual(currentReq?.status, "booked");
    assert.strictEqual(currentReq?.mechanic_id, null);
  });

  it("CONCURRENT claim: fire two claim calls with Promise.all from two mechanics; exactly one returns 200 and the other 409", async () => {
    // Seed an open booked request specifically for concurrent claim test
    const { data: claimReq, error: reqErr } = await admin
      .from("requests")
      .insert({
        vehicle_id: vehicleA.id,
        service_type: "brake_service",
        complaint: "Concurrent claim race test",
        preferred_date: "2026-11-12",
        status: "booked",
        mechanic_id: null,
      })
      .select("id")
      .single();

    assert.strictEqual(reqErr, null);
    assert.ok(claimReq?.id);
    cleanupRequestIds.push(claimReq.id);

    // Fire two claim calls concurrently with Promise.all
    const [claimRes1, claimRes2] = await Promise.all([
      fetch(`${baseUrl}/api/requests/${claimReq.id}/claim`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
      }),
      fetch(`${baseUrl}/api/requests/${claimReq.id}/claim`, {
        method: "POST",
        headers: { Cookie: mechanic2.cookie, "Content-Type": "application/json" },
      }),
    ]);

    const statuses = [claimRes1.status, claimRes2.status].sort();
    assert.deepStrictEqual(
      statuses,
      [200, 409],
      `Expected exactly one 200 and one 409, got [${claimRes1.status}, ${claimRes2.status}]`
    );

    // Verify in DB that request is assigned to exactly one mechanic and moved to inspecting
    const { data: finalReq } = await admin
      .from("requests")
      .select("status, mechanic_id")
      .eq("id", claimReq.id)
      .single();

    assert.strictEqual(finalReq?.status, "inspecting");
    const validMechanicIds = [mechanic1.id, mechanic2.id];
    assert.ok(
      validMechanicIds.includes(finalReq?.mechanic_id || ""),
      "Mechanic ID must be one of the two mechanics"
    );
  });

  it("invalid transitions rejected (booked to done, customer start_inspection, cancel after repairing)", async () => {
    // 1. Booked to done: cannot jump from booked to done
    const jumpRes = await fetch(`${baseUrl}/api/requests/${requestA.id}/transition`, {
      method: "POST",
      headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete" }),
    });
    assert.strictEqual(
      jumpRes.status,
      400,
      `Expected 400 for jumping booked to done, got ${jumpRes.status}`
    );

    // 2. Customer start_inspection: customers cannot start inspection
    const custInspectRes = await fetch(`${baseUrl}/api/requests/${requestA.id}/transition`, {
      method: "POST",
      headers: { Cookie: customerA.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start_inspection" }),
    });
    assert.strictEqual(
      custInspectRes.status,
      403,
      `Expected 403 for customer starting inspection, got ${custInspectRes.status}`
    );

    // 3. Cancel after repairing: seed or update a request to repairing status
    const { data: repairingReq } = await admin
      .from("requests")
      .insert({
        vehicle_id: vehicleA.id,
        service_type: "engine_diagnostics",
        complaint: "Repairing cancel test",
        preferred_date: "2026-11-15",
        status: "repairing",
        mechanic_id: mechanic1.id,
      })
      .select("id")
      .single();

    assert.ok(repairingReq?.id);
    cleanupRequestIds.push(repairingReq.id);

    const cancelAfterRepairRes = await fetch(
      `${baseUrl}/api/requests/${repairingReq.id}/transition`,
      {
        method: "POST",
        headers: { Cookie: customerA.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      }
    );
    assert.strictEqual(
      cancelAfterRepairRes.status,
      400,
      `Expected 400 for cancelling after repairing, got ${cancelAfterRepairRes.status}`
    );

    const { data: stillRepairing } = await admin
      .from("requests")
      .select("status")
      .eq("id", repairingReq.id)
      .single();
    assert.strictEqual(stillRepairing?.status, "repairing");
  });

  it("mechanic POST to cancel returns 403 with status unchanged; assigned mechanic release returns 200 to booked", async () => {
    // Seed a request assigned to mechanic 1 in inspecting status
    const { data: assignedReq } = await admin
      .from("requests")
      .insert({
        vehicle_id: vehicleA.id,
        service_type: "tire_rotation",
        complaint: "Tire rotation and balancing",
        preferred_date: "2026-11-16",
        status: "inspecting",
        mechanic_id: mechanic1.id,
      })
      .select("id")
      .single();

    assert.ok(assignedReq?.id);
    cleanupRequestIds.push(assignedReq.id);

    // 1. Mechanic attempts to cancel -> 403 Forbidden (Cancel is vehicle owner only)
    const mechCancelRes = await fetch(`${baseUrl}/api/requests/${assignedReq.id}/transition`, {
      method: "POST",
      headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    });
    assert.strictEqual(mechCancelRes.status, 403, "Mechanic cannot cancel service request");

    // Verify status remains inspecting
    const { data: uncancelledReq } = await admin
      .from("requests")
      .select("status, mechanic_id")
      .eq("id", assignedReq.id)
      .single();
    assert.strictEqual(uncancelledReq?.status, "inspecting");
    assert.strictEqual(uncancelledReq?.mechanic_id, mechanic1.id);

    // 2. Assigned mechanic releases job -> 200 OK
    const releaseRes = await fetch(`${baseUrl}/api/requests/${assignedReq.id}/transition`, {
      method: "POST",
      headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "release" }),
    });
    assert.strictEqual(releaseRes.status, 200, "Assigned mechanic can release job to queue");

    // Verify status returned to booked and mechanic_id is null
    const { data: releasedReq } = await admin
      .from("requests")
      .select("status, mechanic_id")
      .eq("id", assignedReq.id)
      .single();
    assert.strictEqual(releasedReq?.status, "booked");
    assert.strictEqual(releasedReq?.mechanic_id, null);
  });

  it("vehicle PATCH cannot change user_id, is_active, or public_token", async () => {
    const maliciousPayload = {
      user_id: customerB.id,
      is_active: false,
      public_token: "00000000-0000-0000-0000-000000000000",
      brand: "Honda",
      model: "Accord",
      year: 2023,
    };

    const patchRes = await fetch(`${baseUrl}/api/vehicles/${vehicleA.id}`, {
      method: "PATCH",
      headers: { Cookie: customerA.cookie, "Content-Type": "application/json" },
      body: JSON.stringify(maliciousPayload),
    });

    assert.strictEqual(patchRes.status, 200, "Valid PATCH with extra fields should succeed");

    const { data: updatedVeh } = await admin
      .from("vehicles")
      .select("user_id, is_active, public_token, brand, model, year")
      .eq("id", vehicleA.id)
      .single();

    assert.strictEqual(updatedVeh?.user_id, customerA.id, "user_id must remain customer A");
    assert.strictEqual(updatedVeh?.is_active, true, "is_active must remain true");
    assert.strictEqual(
      updatedVeh?.public_token,
      vehicleA.public_token,
      "public_token must remain original token"
    );
    assert.strictEqual(updatedVeh?.brand, "Honda", "Allowed field brand was updated");
    assert.strictEqual(updatedVeh?.model, "Accord", "Allowed field model was updated");
  });

  it("direct supabase signUp with data.role = 'mechanic' yields a customer in public.users", async () => {
    const maliciousEmail = `${prefix}_malicious_signup_${Math.floor(Math.random() * 100000)}@example.com`;
    const password = "Password123!";
    const client = createAdminClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: signUpData, error: signUpErr } = await client.auth.signUp({
      email: maliciousEmail,
      password,
      options: {
        data: {
          role: "mechanic",
          name: "Privilege Escalation Attempt",
        },
      },
    });

    assert.strictEqual(signUpErr, null);
    assert.ok(signUpData.user?.id);
    const newUserId = signUpData.user.id;
    cleanupUserIds.push(newUserId);

    // Query public.users directly to confirm trigger assigned 'customer'
    const { data: publicProfile, error: profileErr } = await admin
      .from("users")
      .select("role")
      .eq("id", newUserId)
      .single();

    assert.strictEqual(profileErr, null);
    assert.strictEqual(
      publicProfile?.role,
      "customer",
      "Direct signUp must strictly yield customer role in public.users"
    );
  });
});
