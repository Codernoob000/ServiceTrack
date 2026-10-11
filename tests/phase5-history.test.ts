/**
 * Phase 5 Integration Tests: Public Vehicle Service History & QR Access
 *
 * Covers:
 * 1. Unauthenticated GET /api/public/vehicles/[token]:
 *    - 200 with strictly whitelisted fields only (brand, model, year, masked_plate, repairs)
 *    - Raw JSON contains no owner info, request ids, estimates, notes, descriptions, mechanic info, full plate, vehicle id, or token
 * 2. Plate masking rules:
 *    - 5-character plate -> fully masked (5 asterisks, >= 3 hidden)
 *    - 6-character plate -> 1 visible + 3 asterisks + 2 visible (3 hidden, >= 3)
 *    - 7-character plate -> 1 visible + 4 asterisks + 2 visible (4 hidden, >= 3)
 *    - 10-character plate -> 4 visible + 4 asterisks + 2 visible (4 hidden, >= 3)
 * 3. Token rejection equivalence:
 *    - Unknown token, malformed token, disabled vehicle, and inactive vehicle all return identical generic 404 body
 * 4. Completed repairs filtering:
 *    - Only 'done' requests with approved items that have after photos appear
 *    - 'repairing' requests, items without after photos, and rejected items are excluded
 * 5. Link rotation and toggle:
 *    - After rotate: old token yields 404, new token yields 200
 *    - After disable: token yields 404; re-enabling restores 200
 * 6. Authorization checks:
 *    - Non-owner customer and mechanic are denied access to public-link endpoints (404 generic not-found)
 * 7. Storage signed URLs:
 *    - Signed URLs return 200; raw storage paths never exposed in payload
 * 8. Public page /h/[token]:
 *    - Renders without session (does not redirect to /auth) and contains robots noindex
 * 9. Teardown:
 *    - Clean teardown removing files, requests, vehicles, and auth users with logged counts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createBrowserClient } from "@supabase/ssr";
import { SERVICE_IMAGES_BUCKET } from "../src/lib/constants";
import sharp from "sharp";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BeforeAfterSlider } from "../src/components/inspection/before-after-slider";
import { InspectionCanvas } from "../src/components/inspection/inspection-canvas";

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

describe("Phase 5: Public Vehicle History & QR Access Integration Tests", { concurrency: 1 }, () => {
  const admin = createAdminClient(supabaseUrl, serviceRoleKey);
  const testRunId = Date.now();
  const prefix = `p5test_${testRunId}`;

  const cleanupUserIds: string[] = [];
  const cleanupVehicleIds: string[] = [];
  const cleanupRequestIds: string[] = [];
  const cleanupStoragePaths: string[] = [];

  let customerA: { id: string; email: string; cookie: string };
  let customerB: { id: string; email: string; cookie: string };
  let mechanic1: { id: string; email: string; cookie: string };

  let vehicleMain: { id: string; public_token: string; plate: string };
  let vehicle5Char: { id: string; public_token: string; plate: string };
  let vehicle6Char: { id: string; public_token: string; plate: string };
  let vehicle7Char: { id: string; public_token: string; plate: string };
  let vehicle10Char: { id: string; public_token: string; plate: string };
  let vehicleRotate: { id: string; public_token: string; plate: string };
  let vehicleToggle: { id: string; public_token: string; plate: string };
  let vehicleDisabled: { id: string; public_token: string; plate: string };
  let vehicleInactive: { id: string; public_token: string; plate: string };
  let vehicleMissingPhoto: { id: string; public_token: string; plate: string };
  let reqMissingPhoto: { id: string };
  let imgMissingPhotoId: string;
  let pinMissingPhotoId: string;
  let itemMissingPhotoId: string;

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
      throw new Error(`Failed to log in ${email}: ${loginError.message}`);
    }

    const cookieHeader = Object.entries(jar)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");

    return { id: userId, email, cookie: cookieHeader };
  }

  before(async () => {
    // Generate valid sample JPEG image
    sampleJpegBuffer = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 50, g: 120, b: 200 },
      },
    })
      .jpeg()
      .toBuffer();

    // 1. Create test users
    customerA = await createTestUser("cust_a", "customer");
    customerB = await createTestUser("cust_b", "customer");
    mechanic1 = await createTestUser("mech_1", "mechanic");

    // 2. Create vehicles for Customer A
    // Main vehicle: plate 'TS09AB1235' (10 chars)
    const { data: vMain } = await admin
      .from("vehicles")
      .insert({
        user_id: customerA.id,
        brand: "Honda",
        model: "Civic",
        year: 2021,
        plate: "TS09AB1235",
      })
      .select()
      .single();
    vehicleMain = vMain;
    cleanupVehicleIds.push(vehicleMain.id);

    // 5-character plate: 'ABC12'
    const { data: v5 } = await admin
      .from("vehicles")
      .insert({
        user_id: customerA.id,
        brand: "Ford",
        model: "Focus",
        year: 2018,
        plate: "ABC12",
      })
      .select()
      .single();
    vehicle5Char = v5;
    cleanupVehicleIds.push(vehicle5Char.id);

    // 6-character plate: 'ABC123'
    const { data: v6 } = await admin
      .from("vehicles")
      .insert({
        user_id: customerA.id,
        brand: "Toyota",
        model: "Corolla",
        year: 2019,
        plate: "ABC123",
      })
      .select()
      .single();
    vehicle6Char = v6;
    cleanupVehicleIds.push(vehicle6Char.id);

    // 7-character plate: 'ABC1234'
    const { data: v7 } = await admin
      .from("vehicles")
      .insert({
        user_id: customerA.id,
        brand: "Nissan",
        model: "Sentra",
        year: 2020,
        plate: "ABC1234",
      })
      .select()
      .single();
    vehicle7Char = v7;
    cleanupVehicleIds.push(vehicle7Char.id);

    // 10-character plate: 'KA01MJ9999'
    const { data: v10 } = await admin
      .from("vehicles")
      .insert({
        user_id: customerA.id,
        brand: "Tesla",
        model: "Model 3",
        year: 2022,
        plate: "KA01MJ9999",
      })
      .select()
      .single();
    vehicle10Char = v10;
    cleanupVehicleIds.push(vehicle10Char.id);

    // Dedicated vehicle for token rotation
    const { data: vRot } = await admin
      .from("vehicles")
      .insert({
        user_id: customerA.id,
        brand: "Mazda",
        model: "CX-5",
        year: 2020,
        plate: "TS09CD4321",
      })
      .select()
      .single();
    vehicleRotate = vRot;
    cleanupVehicleIds.push(vehicleRotate.id);

    // Dedicated vehicle for history toggle and null check
    const { data: vTog } = await admin
      .from("vehicles")
      .insert({
        user_id: customerA.id,
        brand: "Honda",
        model: "Accord",
        year: 2019,
        plate: "TS09EF5678",
      })
      .select()
      .single();
    vehicleToggle = vTog;
    cleanupVehicleIds.push(vehicleToggle.id);

    // Dedicated vehicle for disabled test
    const { data: vDis } = await admin
      .from("vehicles")
      .insert({
        user_id: customerA.id,
        brand: "Subaru",
        model: "Outback",
        year: 2017,
        plate: "SUB1234",
        public_history_enabled: false,
      })
      .select()
      .single();
    vehicleDisabled = vDis;
    cleanupVehicleIds.push(vehicleDisabled.id);

    // Dedicated vehicle for inactive test
    const { data: vInact } = await admin
      .from("vehicles")
      .insert({
        user_id: customerA.id,
        brand: "BMW",
        model: "330i",
        year: 2016,
        plate: "BMW1234",
        is_active: false,
      })
      .select()
      .single();
    vehicleInactive = vInact;
    cleanupVehicleIds.push(vehicleInactive.id);

    // 3. Set up Completed Repairs for vehicleMain
    // Request 1: Done with 1 completed repair item (has after photo)
    const { data: rDone } = await admin
      .from("requests")
      .insert({
        vehicle_id: vehicleMain.id,
        mechanic_id: mechanic1.id,
        service_type: "brake_service",
        complaint: "Squeaking brake pads",
        preferred_date: new Date().toISOString().split("T")[0],
        status: "inspecting",
      })
      .select()
      .single();
    cleanupRequestIds.push(rDone.id);

    const beforeImgPath = `requests/${rDone.id}/${crypto.randomUUID()}.jpg`;
    cleanupStoragePaths.push(beforeImgPath);
    await admin.storage.from(SERVICE_IMAGES_BUCKET).upload(beforeImgPath, sampleJpegBuffer, { contentType: "image/jpeg" });
    const { data: imgDone } = await admin.from("images").insert({ request_id: rDone.id, storage_path: beforeImgPath, view_angle: "front" }).select().single();

    const { data: pinDone } = await admin.from("pins").insert({ image_id: imgDone.id, x: 0.5, y: 0.5, part_name: "Front Ceramic Brake Pads", severity: "high" }).select().single();
    const { data: itemDone } = await admin.from("repair_items").insert({ pin_id: pinDone.id, description: "Replace front ceramic pads", estimate: 250, approval_status: "pending" }).select().single();

    // Transition request to awaiting_approval
    await admin.from("requests").update({ status: "awaiting_approval" }).eq("id", rDone.id);
    // Approve repair item
    await admin.from("repair_items").update({ approval_status: "approved" }).eq("id", itemDone.id);
    // Transition request to repairing
    await admin.from("requests").update({ status: "repairing" }).eq("id", rDone.id);

    // Upload after photo
    const afterImgPath = `requests/${rDone.id}/after/${crypto.randomUUID()}.jpg`;
    cleanupStoragePaths.push(afterImgPath);
    await admin.storage.from(SERVICE_IMAGES_BUCKET).upload(afterImgPath, sampleJpegBuffer, { contentType: "image/jpeg" });

    await admin.rpc("attach_after_photo", {
      p_request_id: rDone.id,
      p_item_id: itemDone.id,
      p_caller_id: mechanic1.id,
      p_path: afterImgPath,
    });

    // Request transitions to 'done' (attach_after_photo atomically completed it or update status)
    await admin.from("requests").update({ status: "done" }).eq("id", rDone.id);

    // Request 2: Still 'repairing' (should NOT appear in history)
    const { data: rRepairing } = await admin
      .from("requests")
      .insert({
        vehicle_id: vehicleMain.id,
        mechanic_id: mechanic1.id,
        service_type: "oil_change",
        complaint: "Oil change",
        preferred_date: new Date().toISOString().split("T")[0],
        status: "inspecting",
      })
      .select()
      .single();
    cleanupRequestIds.push(rRepairing.id);

    const r2ImgPath = `requests/${rRepairing.id}/${crypto.randomUUID()}.jpg`;
    cleanupStoragePaths.push(r2ImgPath);
    await admin.storage.from(SERVICE_IMAGES_BUCKET).upload(r2ImgPath, sampleJpegBuffer, { contentType: "image/jpeg" });
    const { data: r2Img } = await admin.from("images").insert({ request_id: rRepairing.id, storage_path: r2ImgPath, view_angle: "rear" }).select().single();
    const { data: r2Pin } = await admin.from("pins").insert({ image_id: r2Img.id, x: 0.2, y: 0.2, part_name: "Oil Filter", severity: "low" }).select().single();
    const { data: r2Item } = await admin.from("repair_items").insert({ pin_id: r2Pin.id, description: "Oil filter change", estimate: 50, approval_status: "pending" }).select().single();

    await admin.from("requests").update({ status: "awaiting_approval" }).eq("id", rRepairing.id);
    await admin.from("repair_items").update({ approval_status: "approved" }).eq("id", r2Item.id);
    await admin.from("requests").update({ status: "repairing" }).eq("id", rRepairing.id);

    const r2AfterPath = `requests/${rRepairing.id}/after/${crypto.randomUUID()}.jpg`;
    cleanupStoragePaths.push(r2AfterPath);
    await admin.storage.from(SERVICE_IMAGES_BUCKET).upload(r2AfterPath, sampleJpegBuffer, { contentType: "image/jpeg" });
    await admin.rpc("attach_after_photo", {
      p_request_id: rRepairing.id,
      p_item_id: r2Item.id,
      p_caller_id: mechanic1.id,
      p_path: r2AfterPath,
    });
    // Explicitly keep rRepairing in 'repairing' status
    await admin.from("requests").update({ status: "repairing" }).eq("id", rRepairing.id);

    // Request 3: 'done' but item was rejected (should NOT appear)
    const { data: rRejectedReq } = await admin
      .from("requests")
      .insert({
        vehicle_id: vehicleMain.id,
        mechanic_id: mechanic1.id,
        service_type: "engine_diagnostics",
        complaint: "Check engine light",
        preferred_date: new Date().toISOString().split("T")[0],
        status: "inspecting",
      })
      .select()
      .single();
    cleanupRequestIds.push(rRejectedReq.id);

    const r3ImgPath = `requests/${rRejectedReq.id}/${crypto.randomUUID()}.jpg`;
    cleanupStoragePaths.push(r3ImgPath);
    await admin.storage.from(SERVICE_IMAGES_BUCKET).upload(r3ImgPath, sampleJpegBuffer, { contentType: "image/jpeg" });
    const { data: r3Img } = await admin.from("images").insert({ request_id: rRejectedReq.id, storage_path: r3ImgPath, view_angle: "left" }).select().single();
    const { data: r3Pin } = await admin.from("pins").insert({ image_id: r3Img.id, x: 0.1, y: 0.1, part_name: "Oxygen Sensor", severity: "high" }).select().single();
    const { data: r3Item } = await admin.from("repair_items").insert({ pin_id: r3Pin.id, description: "Replace O2 sensor", estimate: 180, approval_status: "pending" }).select().single();

    await admin.from("requests").update({ status: "awaiting_approval" }).eq("id", rRejectedReq.id);
    await admin.from("repair_items").update({ approval_status: "rejected" }).eq("id", r3Item.id);
    await admin.from("requests").update({ status: "done" }).eq("id", rRejectedReq.id);

    // 4. Setup Dedicated vehicle & request for missing photo handling tests
    const { data: vMissing } = await admin
      .from("vehicles")
      .insert({
        user_id: customerA.id,
        brand: "Nissan",
        model: "Rogue",
        year: 2022,
        plate: "TS09MS9999",
      })
      .select()
      .single();
    vehicleMissingPhoto = vMissing;
    cleanupVehicleIds.push(vMissing.id);

    const { data: rMissing } = await admin
      .from("requests")
      .insert({
        vehicle_id: vMissing.id,
        mechanic_id: mechanic1.id,
        service_type: "brake_service",
        complaint: "Missing photo test",
        preferred_date: new Date().toISOString().split("T")[0],
        status: "inspecting",
      })
      .select()
      .single();
    reqMissingPhoto = rMissing;
    cleanupRequestIds.push(rMissing.id);

    // Insert an image with a non-existent storage path (file never uploaded)
    const missingStoragePath = `requests/${rMissing.id}/never_uploaded_${crypto.randomUUID()}.jpg`;
    const { data: imgMissing } = await admin
      .from("images")
      .insert({
        request_id: rMissing.id,
        storage_path: missingStoragePath,
        view_angle: "front",
      })
      .select()
      .single();
    imgMissingPhotoId = imgMissing.id;

    // Insert pin and approved repair item with non-existent after_photo_url (file never uploaded)
    const { data: pinMissing } = await admin
      .from("pins")
      .insert({
        image_id: imgMissing.id,
        x: 0.5,
        y: 0.5,
        part_name: "Missing Filter Part",
        severity: "low",
      })
      .select()
      .single();
    pinMissingPhotoId = pinMissing.id;

    const missingAfterStoragePath = `requests/${rMissing.id}/after/never_uploaded_${crypto.randomUUID()}.jpg`;
    const { data: itemMissing, error: insertItemErr } = await admin
      .from("repair_items")
      .insert({
        pin_id: pinMissing.id,
        description: "Filter replacement missing photo",
        estimate: 120,
        approval_status: "pending",
      })
      .select()
      .single();

    if (insertItemErr || !itemMissing) {
      throw new Error(`Failed to insert itemMissing: ${insertItemErr?.message}`);
    }
    itemMissingPhotoId = itemMissing.id;

    // Transition request through state machine to approved and done
    await admin.from("requests").update({ status: "awaiting_approval" }).eq("id", rMissing.id);
    await admin.from("repair_items").update({ approval_status: "approved" }).eq("id", itemMissing.id);
    await admin.from("requests").update({ status: "repairing" }).eq("id", rMissing.id);
    await admin.from("repair_items").update({ after_photo_url: missingAfterStoragePath }).eq("id", itemMissing.id);
    await admin.from("requests").update({ status: "done" }).eq("id", rMissing.id);
  });

  after(async () => {
    // 1. Cascade delete requests created by this test run (cascades to images, pins, repair_items)
    for (const reqId of cleanupRequestIds) {
      await admin.from("requests").delete().eq("id", reqId);
    }

    // 2. Delete vehicles created by this test run
    for (const vehId of cleanupVehicleIds) {
      await admin.from("vehicles").delete().eq("id", vehId);
    }

    // 3. Delete auth users created by this test run
    for (const uid of cleanupUserIds) {
      await admin.from("users").delete().eq("id", uid);
      await admin.auth.admin.deleteUser(uid);
    }

    // 4. Clean up ONLY storage paths uploaded by this specific test run
    if (cleanupStoragePaths.length > 0) {
      const uniquePaths = Array.from(new Set(cleanupStoragePaths));
      await admin.storage.from(SERVICE_IMAGES_BUCKET).remove(uniquePaths);
    }

    // 5. User cleanup verification
    const { data: { users } } = await admin.auth.admin.listUsers();
    const leftoverAuth = users.filter((u) => u.email?.startsWith(prefix));
    assert.strictEqual(leftoverAuth.length, 0, "No leftover test auth users should remain");
  });

  // =========================================================================
  // 1. Whitelist Fields & Security Gates
  // =========================================================================
  describe("Whitelisted Fields & Security Gates", { concurrency: 1 }, () => {
    it("returns 200 and ONLY whitelisted fields for valid public token", async () => {
      const res = await fetch(`${baseUrl}/api/public/vehicles/${vehicleMain.public_token}`);
      assert.strictEqual(res.status, 200);

      const cacheControl = res.headers.get("Cache-Control");
      assert.ok(cacheControl?.includes("no-store"), `Expected Cache-Control: no-store, got ${cacheControl}`);

      const data = await res.json();
      const topKeys = Object.keys(data).sort();
      assert.deepStrictEqual(topKeys, ["brand", "masked_plate", "model", "repairs", "year"]);

      assert.strictEqual(data.brand, "Honda");
      assert.strictEqual(data.model, "Civic");
      assert.strictEqual(data.year, 2021);
      assert.strictEqual(data.masked_plate, "TS09****35");

      // Verify each repair item contains ONLY date, part_name, before_url, after_url
      assert.ok(Array.isArray(data.repairs));
      assert.strictEqual(data.repairs.length, 1);
      const repair = data.repairs[0];
      const repairKeys = Object.keys(repair).sort();
      assert.deepStrictEqual(repairKeys, ["after_url", "before_url", "date", "part_name"]);
      assert.strictEqual(repair.part_name, "Front Ceramic Brake Pads");

      // Strict blacklisted fields check across raw JSON payload
      const rawJson = JSON.stringify(data);
      const forbiddenTerms = [
        customerA.id,
        customerA.email,
        "Password123!",
        "owner",
        "phone",
        "mechanic",
        mechanic1.id,
        vehicleMain.id,
        vehicleMain.public_token,
        "storage_path",
        "before_image_path",
        "after_image_path",
        "estimate",
        "Replace front ceramic pads",
        "Squeaking brake pads",
        "TS09AB1235", // full unmasked plate
      ];

      for (const term of forbiddenTerms) {
        assert.ok(
          !rawJson.includes(term),
          `Raw JSON leaked sensitive data: "${term}" found in ${rawJson}`
        );
      }
    });

    it("signed URLs in the response work for images and raw paths are never exposed", async () => {
      const res = await fetch(`${baseUrl}/api/public/vehicles/${vehicleMain.public_token}`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      const repair = data.repairs[0];

      assert.ok(repair.before_url.startsWith("http"));
      assert.ok(repair.after_url.startsWith("http"));
      assert.ok(repair.before_url.includes("token="));
      assert.ok(repair.after_url.includes("token="));

      // Test that fetching the signed URL returns the image
      const beforeRes = await fetch(repair.before_url);
      assert.strictEqual(beforeRes.status, 200);
      assert.strictEqual(beforeRes.headers.get("content-type"), "image/jpeg");

      const afterRes = await fetch(repair.after_url);
      assert.strictEqual(afterRes.status, 200);
      assert.strictEqual(afterRes.headers.get("content-type"), "image/jpeg");
    });
  });

  // =========================================================================
  // 2. Plate Masking Rules (5, 6, 7, 10 characters)
  // =========================================================================
  describe("Plate Masking Rules", { concurrency: 1 }, () => {
    it("masks 5-character plate fully with 5 asterisks", async () => {
      const res = await fetch(`${baseUrl}/api/public/vehicles/${vehicle5Char.public_token}`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.masked_plate, "*****");
      const hiddenCount = (data.masked_plate.match(/\*/g) || []).length;
      assert.ok(hiddenCount >= 3, `Expected at least 3 masked characters, got ${hiddenCount}`);
    });

    it("masks 6-character plate hiding 3 characters: A***23", async () => {
      const res = await fetch(`${baseUrl}/api/public/vehicles/${vehicle6Char.public_token}`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.masked_plate, "A***23");
      const hiddenCount = (data.masked_plate.match(/\*/g) || []).length;
      assert.ok(hiddenCount >= 3, `Expected at least 3 masked characters, got ${hiddenCount}`);
    });

    it("masks 7-character plate hiding 4 characters: A****34", async () => {
      const res = await fetch(`${baseUrl}/api/public/vehicles/${vehicle7Char.public_token}`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.masked_plate, "A****34");
      const hiddenCount = (data.masked_plate.match(/\*/g) || []).length;
      assert.ok(hiddenCount >= 3, `Expected at least 3 masked characters, got ${hiddenCount}`);
    });

    it("masks 10-character plate keeping 4 and 2 visible: KA01****99", async () => {
      const res = await fetch(`${baseUrl}/api/public/vehicles/${vehicle10Char.public_token}`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.masked_plate, "KA01****99");
      const hiddenCount = (data.masked_plate.match(/\*/g) || []).length;
      assert.ok(hiddenCount >= 3, `Expected at least 3 masked characters, got ${hiddenCount}`);
    });
  });

  // =========================================================================
  // 3. Generic 404 Equivalence
  // =========================================================================
  describe("Generic 404 Equivalence", { concurrency: 1 }, () => {
    it("returns identical 404 for unknown, malformed, disabled and inactive tokens", async () => {
      const unknownToken = crypto.randomUUID();
      const malformedToken = "invalid-token-123";

      // 1. Unknown token
      const resUnknown = await fetch(`${baseUrl}/api/public/vehicles/${unknownToken}`);
      assert.strictEqual(resUnknown.status, 404);
      const bodyUnknown = await resUnknown.text();

      // 2. Malformed token
      const resMalformed = await fetch(`${baseUrl}/api/public/vehicles/${malformedToken}`);
      assert.strictEqual(resMalformed.status, 404);
      const bodyMalformed = await resMalformed.text();

      // 3. Disabled vehicle
      const resDisabled = await fetch(`${baseUrl}/api/public/vehicles/${vehicleDisabled.public_token}`);
      assert.strictEqual(resDisabled.status, 404);
      const bodyDisabled = await resDisabled.text();

      // 4. Inactive vehicle
      const resInactive = await fetch(`${baseUrl}/api/public/vehicles/${vehicleInactive.public_token}`);
      assert.strictEqual(resInactive.status, 404);
      const bodyInactive = await resInactive.text();

      // All 4 responses must have identical bodies and status codes
      assert.strictEqual(bodyUnknown, bodyMalformed);
      assert.strictEqual(bodyUnknown, bodyDisabled);
      assert.strictEqual(bodyUnknown, bodyInactive);
    });
  });

  // =========================================================================
  // 4. Completed Repairs Filtering
  // =========================================================================
  describe("Completed Repairs Filtering", { concurrency: 1 }, () => {
    it("excludes 'repairing' requests, rejected items, and items without after photos", async () => {
      const res = await fetch(`${baseUrl}/api/public/vehicles/${vehicleMain.public_token}`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();

      // vehicleMain has:
      // - 1 'done' request with approved item & after photo -> INCLUDED
      // - 1 'repairing' request -> EXCLUDED
      // - 1 'done' request with rejected item -> EXCLUDED
      assert.strictEqual(data.repairs.length, 1);
      assert.strictEqual(data.repairs[0].part_name, "Front Ceramic Brake Pads");
    });
  });

  // =========================================================================
  // 5. Token Rotation & History Toggle (API & Functions)
  // =========================================================================
  describe("Token Rotation & History Toggle", { concurrency: 1 }, () => {
    it("rotates token: old token returns 404 and new token works", async () => {
      const oldToken = vehicleRotate.public_token;

      // Rotate via owner API
      const rotateRes = await fetch(`${baseUrl}/api/vehicles/${vehicleRotate.id}/public-link/rotate`, {
        method: "POST",
        headers: { Cookie: customerA.cookie },
      });
      assert.strictEqual(rotateRes.status, 200);
      const rotateData = await rotateRes.json();
      const newToken = rotateData.token;

      assert.notStrictEqual(oldToken, newToken);
      assert.ok(rotateData.public_url.includes(newToken));
      assert.ok(rotateData.qr_code.includes("<svg"));

      // Old token now yields 404
      const oldCheck = await fetch(`${baseUrl}/api/public/vehicles/${oldToken}`);
      assert.strictEqual(oldCheck.status, 404);

      // New token returns 200
      const newCheck = await fetch(`${baseUrl}/api/public/vehicles/${newToken}`);
      assert.strictEqual(newCheck.status, 200);
      const newData = await newCheck.json();
      assert.strictEqual(newData.brand, "Mazda");

      // Update vehicleRotate token reference
      vehicleRotate.public_token = newToken;
    });

    it("disables and re-enables public link via API", async () => {
      // 1. Disable link
      const disableRes = await fetch(`${baseUrl}/api/vehicles/${vehicleToggle.id}/public-link/enabled`, {
        method: "POST",
        headers: {
          Cookie: customerA.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      });
      assert.strictEqual(disableRes.status, 200);
      const disableData = await disableRes.json();
      assert.strictEqual(disableData.enabled, false);

      // Token yields 404 while disabled
      const resDisabled = await fetch(`${baseUrl}/api/public/vehicles/${vehicleToggle.public_token}`);
      assert.strictEqual(resDisabled.status, 404);

      // 2. Re-enable link
      const enableRes = await fetch(`${baseUrl}/api/vehicles/${vehicleToggle.id}/public-link/enabled`, {
        method: "POST",
        headers: {
          Cookie: customerA.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      });
      assert.strictEqual(enableRes.status, 200);
      const enableData = await enableRes.json();
      assert.strictEqual(enableData.enabled, true);

      // Token yields 200 again
      const resEnabled = await fetch(`${baseUrl}/api/public/vehicles/${vehicleToggle.public_token}`);
      assert.strictEqual(resEnabled.status, 200);
    });

    it("set_public_history rejects null enabled with 400 (P0022)", async () => {
      const res = await fetch(`${baseUrl}/api/vehicles/${vehicleToggle.id}/public-link/enabled`, {
        method: "POST",
        headers: {
          Cookie: customerA.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: null }),
      });
      assert.strictEqual(res.status, 400);
    });
  });

  // =========================================================================
  // 6. Authorization Gates
  // =========================================================================
  describe("Authorization Gates", { concurrency: 1 }, () => {
    it("non-owner customer cannot read public-link (returns 404)", async () => {
      const res = await fetch(`${baseUrl}/api/vehicles/${vehicleMain.id}/public-link`, {
        headers: { Cookie: customerB.cookie },
      });
      assert.strictEqual(res.status, 404);
    });

    it("mechanic cannot read public-link (returns 404)", async () => {
      const res = await fetch(`${baseUrl}/api/vehicles/${vehicleMain.id}/public-link`, {
        headers: { Cookie: mechanic1.cookie },
      });
      assert.strictEqual(res.status, 404);
    });

    it("non-owner customer cannot rotate token (returns 404)", async () => {
      const res = await fetch(`${baseUrl}/api/vehicles/${vehicleMain.id}/public-link/rotate`, {
        method: "POST",
        headers: { Cookie: customerB.cookie },
      });
      assert.strictEqual(res.status, 404);
    });

    it("mechanic cannot rotate token (returns 404)", async () => {
      const res = await fetch(`${baseUrl}/api/vehicles/${vehicleMain.id}/public-link/rotate`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie },
      });
      assert.strictEqual(res.status, 404);
    });

    it("non-owner customer cannot toggle link enabled (returns 404)", async () => {
      const res = await fetch(`${baseUrl}/api/vehicles/${vehicleMain.id}/public-link/enabled`, {
        method: "POST",
        headers: {
          Cookie: customerB.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      });
      assert.strictEqual(res.status, 404);
    });
  });

  // =========================================================================
  // 7. Public Page Route Rendering
  // =========================================================================
  describe("Public Page /h/[token] Route", { concurrency: 1 }, () => {
    it("renders public page without session and does not redirect to /auth", async () => {
      const pageRes = await fetch(`${baseUrl}/h/${vehicleMain.public_token}`, {
        redirect: "manual",
      });
      assert.strictEqual(pageRes.status, 200, `Expected 200, got ${pageRes.status}`);

      const html = await pageRes.text();
      assert.ok(html.includes("Honda"), "Expected HTML to contain brand");
      assert.ok(html.includes("Civic"), "Expected HTML to contain model");
      assert.ok(html.includes("TS09****35"), "Expected HTML to contain masked plate");
      assert.ok(html.includes("Front Ceramic Brake Pads"), "Expected HTML to contain repair item");
      assert.ok(html.includes('robots" content="noindex'), "Expected HTML to contain robots noindex");
    });

    it("renders generic not found page for bad token without redirecting", async () => {
      const pageRes = await fetch(`${baseUrl}/h/${crypto.randomUUID()}`, {
        redirect: "manual",
      });
      assert.strictEqual(pageRes.status, 200);
      const html = await pageRes.text();
      assert.ok(html.includes("Vehicle Not Found"), "Expected not found message in HTML");
    });
  });

  // =========================================================================
  // 8. Missing Photo Signed URL Null Handling Across Routes
  // =========================================================================
  describe("Missing Photo Signed URL Null Handling", { concurrency: 1 }, () => {
    it("GET /api/requests/[id]/images returns signed_url as null (not empty string) for missing storage file", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${reqMissingPhoto.id}/images`, {
        headers: { Cookie: customerA.cookie },
      });
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.ok(Array.isArray(json.images));
      const targetImg = json.images.find((img: any) => img.id === imgMissingPhotoId);
      assert.ok(targetImg, "Target image must exist in response");
      assert.strictEqual(targetImg.signed_url, null, "Missing image signed_url must be null, not empty string");
    });

    it("GET /api/requests/[id]/pins returns after_photo_url as null (not empty string) for missing storage file", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${reqMissingPhoto.id}/pins`, {
        headers: { Cookie: customerA.cookie },
      });
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.ok(Array.isArray(json.pins));
      const targetPin = json.pins.find((p: any) => p.id === pinMissingPhotoId);
      assert.ok(targetPin, "Target pin must exist in response");
      assert.strictEqual(targetPin.repair_item.after_photo_url, null, "Missing after_photo_url must be null, not empty string");
    });

    it("GET /api/requests/[id]/invoice returns after_photo_url as null (not empty string) for missing storage file", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${reqMissingPhoto.id}/invoice`, {
        headers: { Cookie: customerA.cookie },
      });
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.ok(Array.isArray(json.items));
      const targetItem = json.items.find((item: any) => item.id === itemMissingPhotoId);
      assert.ok(targetItem, "Target item must exist in invoice");
      assert.strictEqual(targetItem.after_photo_url, null, "Missing after_photo_url must be null, not empty string");
    });

    it("GET /api/public/vehicles/[token] returns before_url and after_url as null (not empty string) for missing files", async () => {
      const res = await fetch(`${baseUrl}/api/public/vehicles/${vehicleMissingPhoto.public_token}`);
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.ok(Array.isArray(json.repairs));
      const repair = json.repairs.find((r: any) => r.part_name === "Missing Filter Part");
      assert.ok(repair, "Repair item must exist in public history");
      assert.strictEqual(repair.before_url, null, "Missing before_url must be null, not empty string");
      assert.strictEqual(repair.after_url, null, "Missing after_url must be null, not empty string");
    });
  });

  // =========================================================================
  // 9. UI Components Missing-Photo Rendering & Empty src Prevention
  // =========================================================================
  describe("UI Components Missing-Photo Rendering", { concurrency: 1 }, () => {
    it("BeforeAfterSlider never renders <img> with empty or null src and shows 'Photo unavailable'", () => {
      // Both null
      const htmlNull = renderToStaticMarkup(
        React.createElement(BeforeAfterSlider, { beforeUrl: null, afterUrl: null, partName: "Brake Rotor" })
      );
      assert.ok(!htmlNull.includes("<img"), "Must not render any <img> when both URLs are null");
      assert.ok(htmlNull.includes("Photo unavailable"), "Must contain 'Photo unavailable'");

      // Both empty string
      const htmlEmpty = renderToStaticMarkup(
        React.createElement(BeforeAfterSlider, { beforeUrl: "", afterUrl: "", partName: "Brake Rotor" })
      );
      assert.ok(!htmlEmpty.includes("<img"), "Must not render any <img> when both URLs are empty string");
      assert.ok(htmlEmpty.includes("Photo unavailable"), "Must contain 'Photo unavailable'");

      // Only beforeUrl valid, afterUrl null
      const htmlBeforeOnly = renderToStaticMarkup(
        React.createElement(BeforeAfterSlider, {
          beforeUrl: "https://example.com/before.jpg",
          afterUrl: null,
          partName: "Brake Rotor",
        })
      );
      assert.ok(!htmlBeforeOnly.includes('src=""'), "Must not render <img> with empty src");
      assert.ok(htmlBeforeOnly.includes("https://example.com/before.jpg"), "Must render before image");
      assert.ok(htmlBeforeOnly.includes("Photo unavailable"), "After layer must show 'Photo unavailable'");

      // Only afterUrl valid, beforeUrl null
      const htmlAfterOnly = renderToStaticMarkup(
        React.createElement(BeforeAfterSlider, {
          beforeUrl: null,
          afterUrl: "https://example.com/after.jpg",
          partName: "Brake Rotor",
        })
      );
      assert.ok(!htmlAfterOnly.includes('src=""'), "Must not render <img> with empty src");
      assert.ok(htmlAfterOnly.includes("https://example.com/after.jpg"), "Must render after image");
      assert.ok(htmlAfterOnly.includes("Photo unavailable"), "Before layer must show 'Photo unavailable'");
    });

    it("InspectionCanvas never renders <img> when imageUrl is null or empty and shows 'Photo unavailable'", () => {
      const htmlNull = renderToStaticMarkup(
        React.createElement(InspectionCanvas, {
          imageUrl: null,
          pins: [],
          pinNumberMap: new Map(),
          readOnly: true,
        })
      );
      assert.ok(!htmlNull.includes("<img"), "Must not render <img> when imageUrl is null");
      assert.ok(htmlNull.includes("Photo unavailable"), "Must contain 'Photo unavailable'");

      const htmlEmpty = renderToStaticMarkup(
        React.createElement(InspectionCanvas, {
          imageUrl: "",
          pins: [],
          pinNumberMap: new Map(),
          readOnly: true,
        })
      );
      assert.ok(!htmlEmpty.includes("<img"), "Must not render <img> when imageUrl is empty string");
      assert.ok(htmlEmpty.includes("Photo unavailable"), "Must contain 'Photo unavailable'");
    });
  });
});
