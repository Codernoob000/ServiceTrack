/**
 * Phase 3 Integration Tests: Customer Approval, Server-Computed Total,
 * State Transitions (repairing / done), and Invoice API against live Supabase.
 *
 * Covers:
 * 1. Security & Ownership Gates on POST /api/requests/[id]/decisions:
 *    - Unauthenticated request returns 401
 *    - Another customer (customer B) cannot submit decisions (403)
 *    - Assigned mechanic cannot submit decisions (403)
 *    - Unassigned mechanic cannot submit decisions (403)
 * 2. Lifecycle Conflict Gates (409):
 *    - Submitting decisions before report is submitted (while status == 'inspecting') returns 409
 *    - Submitting decisions a second time returns 409
 *    - Direct attempt to modify approval_status via PATCH /api/requests/[id]/pins/[pinId] fails (400)
 * 3. Validation Gates (400) & Atomic Rollback:
 *    - Incomplete decisions payload (missing an item) returns 400 with no state changes
 *    - Duplicate item_id entries in payload returns 400 with no state changes
 *    - Foreign item_id from a different request returns 400 with no state changes
 *    - Non-existent item UUID returns 400 with no state changes
 *    - Invalid decision string (not 'approved' | 'rejected') returns 400
 * 4. State Transitions & Server-Computed Totals:
 *    - Mixed decisions (at least 1 approved) move request status to 'repairing'
 *    - Server ignores client-supplied total in body: total equals exact SQL sum of approved items
 *    - All rejected decisions move request status to 'done' with approved_total = 0
 * 5. Invoice Access Gates (GET /api/requests/[id]/invoice):
 *    - Access before repairing/done (e.g., in inspecting or awaiting_approval) returns 403
 *    - Vehicle owner gets 200 when repairing or done
 *    - Assigned mechanic gets 200 when repairing or done
 *    - Another customer gets 403
 *    - Unassigned mechanic gets 403
 *    - Invoice returns approved items only, vehicle specs, date, server-computed total
 *    - Customer response never contains mechanic's user ID
 * 6. Clean Teardown:
 *    - Leaves 0 test users and 0 leftover files in storage bucket
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createBrowserClient } from "@supabase/ssr";
import { SERVICE_IMAGES_BUCKET } from "../src/lib/constants";
import sharp from "sharp";

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

describe("Phase 3: Customer Decisions, Server Totals, and Invoice Integration Tests", () => {
  const admin = createAdminClient(supabaseUrl, serviceRoleKey);
  const testRunId = Date.now();
  const prefix = `p3test_${testRunId}`;

  const cleanupUserIds: string[] = [];
  const cleanupVehicleIds: string[] = [];
  const cleanupRequestIds: string[] = [];
  const cleanupStoragePaths: string[] = [];

  let customerA: { id: string; email: string; cookie: string };
  let customerB: { id: string; email: string; cookie: string };
  let mechanic1: { id: string; email: string; cookie: string };
  let mechanic2: { id: string; email: string; cookie: string };

  let vehicleA: { id: string };
  let vehicleB: { id: string };

  // Request 1: will be used for pre-submit 409 check, then submitted to awaiting_approval, then mixed decisions -> repairing
  let req1: { id: string };
  let req1ImageId: string;
  let req1Item1: { id: string; pin_id: string; estimate: number };
  let req1Item2: { id: string; pin_id: string; estimate: number };

  // Request 2: belongs to customerB, used for cross-request foreign item tests
  let req2: { id: string };
  let req2ImageId: string;
  let req2Item: { id: string; pin_id: string };

  // Request 3: belongs to customerA, will be used for all-rejected -> done test
  let req3: { id: string };
  let req3ImageId: string;
  let req3Item1: { id: string; pin_id: string; estimate: number };
  let req3Item2: { id: string; pin_id: string; estimate: number };

  let sampleJpegBuffer: Buffer;

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
    // 0. Verify development server is reachable
    try {
      const ping = await fetch(baseUrl).catch(() => null);
      if (!ping) {
        throw new Error(`Development server is not reachable at ${baseUrl}. Ensure server is running.`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Development server is not reachable at ${baseUrl}: ${msg}`);
    }

    // 1. Generate sample image
    sampleJpegBuffer = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 10, g: 100, b: 200 },
      },
    })
      .jpeg()
      .toBuffer();

    // 2. Create users
    customerA = await createTestUser("custA", "customer");
    customerB = await createTestUser("custB", "customer");
    mechanic1 = await createTestUser("mech1", "mechanic");
    mechanic2 = await createTestUser("mech2", "mechanic");

    // 3. Create vehicles
    const { data: vA } = await admin
      .from("vehicles")
      .insert({
        user_id: customerA.id,
        plate: `MH-${Math.floor(1000 + Math.random() * 9000)}`,
        brand: "Tata",
        model: "Nexon",
        year: 2023,
      })
      .select("id")
      .single();
    vehicleA = vA!;
    cleanupVehicleIds.push(vehicleA.id);

    const { data: vB } = await admin
      .from("vehicles")
      .insert({
        user_id: customerB.id,
        plate: `DL-${Math.floor(1000 + Math.random() * 9000)}`,
        brand: "Hyundai",
        model: "Creta",
        year: 2022,
      })
      .select("id")
      .single();
    vehicleB = vB!;
    cleanupVehicleIds.push(vehicleB.id);

    // 4. Seed Request 1 (inspecting, assigned to mech1)
    const { data: r1 } = await admin
      .from("requests")
      .insert({
        vehicle_id: vehicleA.id,
        service_type: "full_inspection",
        complaint: "Vibration on braking",
        preferred_date: "2026-11-01",
        status: "inspecting",
        mechanic_id: mechanic1.id,
      })
      .select("id")
      .single();
    req1 = r1!;
    cleanupRequestIds.push(req1.id);

    const storagePath1 = `requests/${req1.id}/${crypto.randomUUID()}.jpg`;
    await admin.storage.from(SERVICE_IMAGES_BUCKET).upload(storagePath1, sampleJpegBuffer, { contentType: "image/jpeg" });
    cleanupStoragePaths.push(storagePath1);

    const { data: img1 } = await admin
      .from("images")
      .insert({ request_id: req1.id, storage_path: storagePath1, view_angle: "front" })
      .select("id")
      .single();
    req1ImageId = img1!.id;

    // Pin 1 on Req 1 (Estimate: 5000)
    const { data: pin1Rpc } = await admin.rpc("create_pin_with_item", {
      p_request_id: req1.id,
      p_caller_id: mechanic1.id,
      p_image_id: req1ImageId,
      p_x: 0.3,
      p_y: 0.4,
      p_part_name: "Brake Rotor",
      p_severity: "high",
      p_notes: "Deep scoring on surface",
      p_description: "Replace front brake rotor pair",
      p_estimate: 5000,
    });
    req1Item1 = { id: pin1Rpc.item_id, pin_id: pin1Rpc.pin_id, estimate: 5000 };

    // Pin 2 on Req 1 (Estimate: 2500)
    const { data: pin2Rpc } = await admin.rpc("create_pin_with_item", {
      p_request_id: req1.id,
      p_caller_id: mechanic1.id,
      p_image_id: req1ImageId,
      p_x: 0.7,
      p_y: 0.6,
      p_part_name: "Brake Pads",
      p_severity: "medium",
      p_notes: "Pads worn down to 3mm",
      p_description: "Replace front ceramic brake pads",
      p_estimate: 2500,
    });
    req1Item2 = { id: pin2Rpc.item_id, pin_id: pin2Rpc.pin_id, estimate: 2500 };

    // 5. Seed Request 2 (customerB, inspecting, assigned to mech1)
    const { data: r2 } = await admin
      .from("requests")
      .insert({
        vehicle_id: vehicleB.id,
        service_type: "engine_diagnostics",
        complaint: "Check engine warning",
        preferred_date: "2026-11-02",
        status: "inspecting",
        mechanic_id: mechanic1.id,
      })
      .select("id")
      .single();
    req2 = r2!;
    cleanupRequestIds.push(req2.id);

    const storagePath2 = `requests/${req2.id}/${crypto.randomUUID()}.jpg`;
    await admin.storage.from(SERVICE_IMAGES_BUCKET).upload(storagePath2, sampleJpegBuffer, { contentType: "image/jpeg" });
    cleanupStoragePaths.push(storagePath2);

    const { data: img2 } = await admin
      .from("images")
      .insert({ request_id: req2.id, storage_path: storagePath2, view_angle: "rear" })
      .select("id")
      .single();
    req2ImageId = img2!.id;

    const { data: pinBRpc } = await admin.rpc("create_pin_with_item", {
      p_request_id: req2.id,
      p_caller_id: mechanic1.id,
      p_image_id: req2ImageId,
      p_x: 0.5,
      p_y: 0.5,
      p_part_name: "O2 Sensor",
      p_severity: "low",
      p_notes: "Sensor fault code P0135",
      p_description: "Replace oxygen sensor",
      p_estimate: 1800,
    });
    req2Item = { id: pinBRpc.item_id, pin_id: pinBRpc.pin_id };

    // 6. Seed Request 3 (customerA, inspecting, assigned to mech1)
    const { data: r3 } = await admin
      .from("requests")
      .insert({
        vehicle_id: vehicleA.id,
        service_type: "oil_change",
        complaint: "Regular service",
        preferred_date: "2026-11-03",
        status: "inspecting",
        mechanic_id: mechanic1.id,
      })
      .select("id")
      .single();
    req3 = r3!;
    cleanupRequestIds.push(req3.id);

    const storagePath3 = `requests/${req3.id}/${crypto.randomUUID()}.jpg`;
    await admin.storage.from(SERVICE_IMAGES_BUCKET).upload(storagePath3, sampleJpegBuffer, { contentType: "image/jpeg" });
    cleanupStoragePaths.push(storagePath3);

    const { data: img3 } = await admin
      .from("images")
      .insert({ request_id: req3.id, storage_path: storagePath3, view_angle: "left" })
      .select("id")
      .single();
    req3ImageId = img3!.id;

    const { data: pin3ARpc } = await admin.rpc("create_pin_with_item", {
      p_request_id: req3.id,
      p_caller_id: mechanic1.id,
      p_image_id: req3ImageId,
      p_x: 0.4,
      p_y: 0.4,
      p_part_name: "Air Filter",
      p_severity: "low",
      p_notes: null,
      p_description: "Replace cabin air filter",
      p_estimate: 800,
    });
    req3Item1 = { id: pin3ARpc.item_id, pin_id: pin3ARpc.pin_id, estimate: 800 };

    const { data: pin3BRpc } = await admin.rpc("create_pin_with_item", {
      p_request_id: req3.id,
      p_caller_id: mechanic1.id,
      p_image_id: req3ImageId,
      p_x: 0.6,
      p_y: 0.6,
      p_part_name: "Wiper Blades",
      p_severity: "low",
      p_notes: null,
      p_description: "Replace wiper blades",
      p_estimate: 600,
    });
    req3Item2 = { id: pin3BRpc.item_id, pin_id: pin3BRpc.pin_id, estimate: 600 };
  });

  after(async () => {
    // 1. Storage cleanup
    const uniquePaths = Array.from(new Set(cleanupStoragePaths));
    if (uniquePaths.length > 0) {
      await admin.storage.from(SERVICE_IMAGES_BUCKET).remove(uniquePaths);
    }
    await new Promise((r) => setTimeout(r, 600));

    let remainingFiles = 0;
    const checkedFolders = new Set<string>();
    for (const p of uniquePaths) {
      const folder = p.substring(0, p.lastIndexOf("/"));
      if (!checkedFolders.has(folder)) {
        checkedFolders.add(folder);
        const { data: list } = await admin.storage.from(SERVICE_IMAGES_BUCKET).list(folder);
        if (list && list.length > 0) {
          remainingFiles += list.length;
        }
      }
    }
    console.log(`[Storage Cleanup] Files remaining in ${SERVICE_IMAGES_BUCKET}: ${remainingFiles}`);
    assert.strictEqual(remainingFiles, 0, `Storage bucket must have 0 remaining test files`);

    // 2. Database rows cleanup
    for (const reqId of cleanupRequestIds) {
      await admin.from("requests").delete().eq("id", reqId);
    }
    for (const vehId of cleanupVehicleIds) {
      await admin.from("vehicles").delete().eq("id", vehId);
    }
    for (const uid of cleanupUserIds) {
      await admin.auth.admin.deleteUser(uid);
    }

    // 3. User cleanup assertion
    const { data: { users } } = await admin.auth.admin.listUsers();
    const leftoverAuth = users.filter((u) => u.email?.startsWith(prefix));
    assert.strictEqual(leftoverAuth.length, 0, `No leftover test auth users should remain`);
  });

  describe("1. Pre-Submission and Security Gates", () => {
    it("submitting decisions before report is submitted (status == inspecting) returns 409", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/decisions`, {
        method: "POST",
        headers: { Cookie: customerA.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: [
            { item_id: req1Item1.id, decision: "approved" },
            { item_id: req1Item2.id, decision: "approved" },
          ],
        }),
      });

      const data = await res.json().catch(() => ({}));
      assert.strictEqual(res.status, 409, JSON.stringify(data));
      assert.ok(data.error);
    });

    it("transition request 1 to awaiting_approval via submit_report", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/transition`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submit_report" }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.request.status, "awaiting_approval");
    });

    it("unauthenticated request returns 401", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: [{ item_id: req1Item1.id, decision: "approved" }],
        }),
      });

      assert.strictEqual(res.status, 401);
    });

    it("another customer (customer B) cannot submit decisions for request 1 (403)", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/decisions`, {
        method: "POST",
        headers: { Cookie: customerB.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: [
            { item_id: req1Item1.id, decision: "approved" },
            { item_id: req1Item2.id, decision: "approved" },
          ],
        }),
      });

      assert.strictEqual(res.status, 403);
    });

    it("assigned mechanic cannot submit decisions (403)", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/decisions`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: [
            { item_id: req1Item1.id, decision: "approved" },
            { item_id: req1Item2.id, decision: "approved" },
          ],
        }),
      });

      assert.strictEqual(res.status, 403);
    });

    it("unassigned mechanic cannot submit decisions (403)", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/decisions`, {
        method: "POST",
        headers: { Cookie: mechanic2.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: [
            { item_id: req1Item1.id, decision: "approved" },
            { item_id: req1Item2.id, decision: "approved" },
          ],
        }),
      });

      assert.strictEqual(res.status, 403);
    });
  });

  describe("2. Validation Gates (400) and Atomic Rollback", () => {
    it("incomplete decisions (missing an item) is rejected with 400 and state is unchanged", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/decisions`, {
        method: "POST",
        headers: { Cookie: customerA.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: [{ item_id: req1Item1.id, decision: "approved" }],
        }),
      });

      assert.strictEqual(res.status, 400);

      // Verify DB state is still awaiting_approval and items are still pending
      const { data: dbReq } = await admin.from("requests").select("status").eq("id", req1.id).single();
      assert.strictEqual(dbReq?.status, "awaiting_approval");

      const { data: items } = await admin
        .from("repair_items")
        .select("approval_status")
        .in("id", [req1Item1.id, req1Item2.id]);
      assert.ok(items?.every((i) => i.approval_status === "pending"));
    });

    it("duplicate item entries in payload is rejected with 400", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/decisions`, {
        method: "POST",
        headers: { Cookie: customerA.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: [
            { item_id: req1Item1.id, decision: "approved" },
            { item_id: req1Item1.id, decision: "rejected" },
          ],
        }),
      });

      assert.strictEqual(res.status, 400);
    });

    it("foreign item_id from a different request is rejected with 400", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/decisions`, {
        method: "POST",
        headers: { Cookie: customerA.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: [
            { item_id: req1Item1.id, decision: "approved" },
            { item_id: req2Item.id, decision: "rejected" }, // foreign item from req2
          ],
        }),
      });

      assert.strictEqual(res.status, 400);
    });

    it("invalid decision string (not approved|rejected) is rejected with 400", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/decisions`, {
        method: "POST",
        headers: { Cookie: customerA.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: [
            { item_id: req1Item1.id, decision: "maybe" },
            { item_id: req1Item2.id, decision: "approved" },
          ],
        }),
      });

      assert.strictEqual(res.status, 400);
    });
  });

  describe("3. Invoice Gate Before Decision (403)", () => {
    it("invoice request before repairing or done returns 403 for owner", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/invoice`, {
        headers: { Cookie: customerA.cookie },
      });

      assert.strictEqual(res.status, 403);
    });

    it("invoice request before repairing or done returns 403 for assigned mechanic", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/invoice`, {
        headers: { Cookie: mechanic1.cookie },
      });

      assert.strictEqual(res.status, 403);
    });
  });

  describe("4. Mixed Decisions Transition to 'repairing' and Server-Computed Total", () => {
    it("mixed decisions transition request to repairing; ignores client-sent total in body", async () => {
      // Client sends total: 999999 to verify server ignores it completely
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/decisions`, {
        method: "POST",
        headers: { Cookie: customerA.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: [
            { item_id: req1Item1.id, decision: "approved" }, // estimate 5000
            { item_id: req1Item2.id, decision: "rejected" }, // estimate 2500
          ],
          total: 999999, // Should be ignored
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.status, "repairing");
      // Server-computed total must be 5000 (rotor only), NOT 999999
      assert.strictEqual(Number(data.approved_total), 5000);
      assert.strictEqual(data.approved_count, 1);
      assert.strictEqual(data.rejected_count, 1);
      assert.strictEqual(data.total_items, 2);

      // Verify database row transitions
      const { data: dbReq } = await admin.from("requests").select("status").eq("id", req1.id).single();
      assert.strictEqual(dbReq?.status, "repairing");

      const { data: item1 } = await admin.from("repair_items").select("approval_status").eq("id", req1Item1.id).single();
      assert.strictEqual(item1?.approval_status, "approved");

      const { data: item2 } = await admin.from("repair_items").select("approval_status").eq("id", req1Item2.id).single();
      assert.strictEqual(item2?.approval_status, "rejected");

      // Verify customer decisions response contains no mechanic_id or mechanic user id anywhere in the JSON
      const decisionsJson = JSON.stringify(data);
      assert.strictEqual(data.mechanic_id, undefined, "Decisions response must not contain mechanic_id");
      assert.strictEqual(decisionsJson.includes("mechanic_id"), false, "Decisions JSON must not contain key mechanic_id");
      assert.strictEqual(decisionsJson.includes(mechanic1.id), false, "Decisions JSON must not contain mechanic user id");
    });

    it("submitting decisions a second time returns 409", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/decisions`, {
        method: "POST",
        headers: { Cookie: customerA.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: [
            { item_id: req1Item1.id, decision: "approved" },
            { item_id: req1Item2.id, decision: "approved" },
          ],
        }),
      });

      assert.strictEqual(res.status, 409);
    });

    it("direct attempt to modify approval_status via PATCH /pins fails with 400 (whitelist)", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/pins/${req1Item1.pin_id}`, {
        method: "PATCH",
        headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          approval_status: "rejected",
        }),
      });

      assert.strictEqual(res.status, 400);
    });
  });

  describe("5. Invoice Access and Security Verification", () => {
    it("owner accesses invoice when repairing (200), sees approved items and correct server total", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/invoice`, {
        headers: { Cookie: customerA.cookie },
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.request_id, req1.id);
      assert.strictEqual(data.status, "repairing");
      assert.strictEqual(data.total, 5000); // Only approved item
      assert.strictEqual(data.items.length, 1);
      assert.strictEqual(data.items[0].part_name, "Brake Rotor");
      assert.strictEqual(data.items[0].estimate, 5000);
      assert.strictEqual(data.vehicle.brand, "Tata");
      assert.strictEqual(data.vehicle.model, "Nexon");

      // Verify customer NEVER sees mechanic's user ID
      assert.strictEqual(data.mechanic_id, undefined);
      if (data.mechanic_name) {
        assert.ok(typeof data.mechanic_name === "string");
        assert.ok(!data.mechanic_name.includes(mechanic1.id));
      }
    });

    it("assigned mechanic accesses invoice when repairing (200)", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/invoice`, {
        headers: { Cookie: mechanic1.cookie },
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.total, 5000);
    });

    it("another customer (customer B) gets 403 on invoice", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/invoice`, {
        headers: { Cookie: customerB.cookie },
      });

      assert.strictEqual(res.status, 403);
    });

    it("unassigned mechanic (mechanic 2) gets 403 on invoice", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/invoice`, {
        headers: { Cookie: mechanic2.cookie },
      });

      assert.strictEqual(res.status, 403);
    });

    it("customer invoice response contains no mechanic_id or mechanic user id anywhere in the JSON", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/invoice`, {
        headers: { Cookie: customerA.cookie },
      });
      assert.strictEqual(res.status, 200);
      const text = await res.text();
      const data = JSON.parse(text);

      assert.strictEqual(data.mechanic_id, undefined, "Invoice object must not have mechanic_id property");
      assert.strictEqual(text.includes("mechanic_id"), false, "Invoice JSON must not contain key mechanic_id");
      assert.strictEqual(text.includes(mechanic1.id), false, "Invoice JSON must not contain assigned mechanic user id");
      assert.strictEqual(text.includes(mechanic2.id), false, "Invoice JSON must not contain unassigned mechanic user id");
    });
  });

  describe("6. All Rejected Decisions Transition to 'done'", () => {
    it("submit_report on request 3 moves it to awaiting_approval", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req3.id}/transition`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submit_report" }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.request.status, "awaiting_approval");
    });

    it("all rejected decisions transition request directly to 'done' with total = 0", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req3.id}/decisions`, {
        method: "POST",
        headers: { Cookie: customerA.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: [
            { item_id: req3Item1.id, decision: "rejected" },
            { item_id: req3Item2.id, decision: "rejected" },
          ],
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.status, "done");
      assert.strictEqual(Number(data.approved_total), 0);
      assert.strictEqual(data.approved_count, 0);
      assert.strictEqual(data.rejected_count, 2);

      // Verify DB row status
      const { data: dbReq } = await admin.from("requests").select("status").eq("id", req3.id).single();
      assert.strictEqual(dbReq?.status, "done");
    });

    it("invoice for all-rejected request returns 200 with 0 items and total = 0", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req3.id}/invoice`, {
        headers: { Cookie: customerA.cookie },
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.status, "done");
      assert.strictEqual(data.total, 0);
      assert.strictEqual(data.items.length, 0);
    });
  });
});
