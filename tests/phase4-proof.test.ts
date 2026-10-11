/**
 * Phase 4 Integration Tests: After-Photo Proof for Approved Repairs,
 * Completion Rule, Before/After Verification, and Security Controls.
 *
 * Covers:
 * 1. Security & Ownership Gates on POST /api/requests/[id]/items/[itemId]/after-photo:
 *    - Unauthenticated request returns 401
 *    - A customer (owner of the request) cannot upload an after photo (403)
 *    - Another mechanic (not the assigned mechanic) cannot upload an after photo (403)
 *    - The owner of a different request cannot upload an after photo (403)
 * 2. Lifecycle Conflict Gates (409):
 *    - Upload before 'repairing' (e.g. in inspecting or awaiting_approval) returns 409
 *    - Upload after 'done' returns 409
 * 3. Item Validation Gates (400 or 404):
 *    - An item that was rejected returns 404 (and nothing changes)
 *    - An item that belongs to another request returns 404 (and nothing changes)
 *    - Non-existent item UUID returns 404
 * 4. Image Pipeline & Validation Gates:
 *    - Over 4 MB file rejected (413)
 *    - SVG file rejected (400)
 *    - Spoofed extension (text file named .jpg) rejected (400)
 *    - EXIF metadata is stripped from stored after photo
 * 5. State Transition & Completion Rule:
 *    - Documenting only some approved items leaves request in 'repairing'
 *    - Documenting the last approved item atomically moves request to 'done'
 * 6. Replacement while Repairing vs after Done:
 *    - Replacing a photo while 'repairing' succeeds and old storage file is deleted
 *    - Changing a photo after 'done' fails (409)
 * 7. Signed URLs & Privacy:
 *    - Signed URLs for after photos are returned to owner and assigned mechanic only, and only in 'repairing' or 'done'
 *    - Another customer gets 403
 *    - No mechanic user id appears in any customer response
 * 8. Invoice Route:
 *    - GET /api/requests/[id]/invoice returns per-item has_after_photo flag
 * 9. Teardown:
 *    - Leaves 0 test users and 0 leftover files in service-images bucket
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

describe("Phase 4: After-Photo Proof and Completion Rule Integration Tests", () => {
  const admin = createAdminClient(supabaseUrl, serviceRoleKey);
  const testRunId = Date.now();
  const prefix = `p4test_${testRunId}`;

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

  // Request 1: Assigned to mechanic1, owned by customerA.
  // Has 2 approved items and 1 rejected item. Used for incremental completion, replacement, and access tests.
  let req1: { id: string };
  let req1Item1: { id: string; pin_id: string; description: string };
  let req1Item2: { id: string; pin_id: string; description: string };
  let req1ItemRejected: { id: string; pin_id: string; description: string };

  // Request 2: Assigned to mechanic2, owned by customerB.
  // Used for cross-request validation tests.
  let req2: { id: string };
  let req2ItemApproved: { id: string; pin_id: string };

  // Request 3: Belongs to customerA, currently in 'inspecting' status.
  // Used for pre-repairing lifecycle conflict tests.
  let req3: { id: string };
  let req3Item: { id: string; pin_id: string };

  let sampleJpegBuffer: Buffer;
  let sampleJpegWithExifBuffer: Buffer;

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
    // 0. Verify dev server is reachable
    try {
      const ping = await fetch(baseUrl).catch(() => null);
      if (!ping) {
        throw new Error(`Dev server is not reachable at ${baseUrl}. Ensure server is running.`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Dev server is not reachable at ${baseUrl}: ${msg}`);
    }

    // 1. Generate sample images
    sampleJpegBuffer = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 20, g: 120, b: 220 },
      },
    })
      .jpeg()
      .toBuffer();

    // JPEG with mock EXIF
    sampleJpegWithExifBuffer = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 30, g: 130, b: 230 },
      },
    })
      .jpeg()
      .withMetadata({
        exif: {
          IFD0: {
            Make: "MockCameraMake",
            Model: "MockCameraModel",
          },
        },
      })
      .toBuffer();

    // 2. Create users
    customerA = await createTestUser("custA", "customer");
    customerB = await createTestUser("custB", "customer");
    mechanic1 = await createTestUser("mech1", "mechanic");
    mechanic2 = await createTestUser("mech2", "mechanic");

    // 3. Create vehicles
    const { data: vA, error: vAErr } = await admin
      .from("vehicles")
      .insert({
        user_id: customerA.id,
        plate: `A${Math.floor(Math.random() * 89999 + 10000)}`,
        brand: "Honda",
        model: "Civic",
        year: 2021,
      })
      .select()
      .single();
    if (vAErr || !vA) throw new Error(`Failed to create vehicleA: ${vAErr?.message}`);
    vehicleA = vA;
    cleanupVehicleIds.push(vehicleA.id);

    const { data: vB, error: vBErr } = await admin
      .from("vehicles")
      .insert({
        user_id: customerB.id,
        plate: `B${Math.floor(Math.random() * 89999 + 10000)}`,
        brand: "Toyota",
        model: "Corolla",
        year: 2020,
      })
      .select()
      .single();
    if (vBErr || !vB) throw new Error(`Failed to create vehicleB: ${vBErr?.message}`);
    vehicleB = vB;
    cleanupVehicleIds.push(vehicleB.id);

    // 4. Setup Request 1: customerA, assigned to mechanic1, transitioned to 'repairing'
    const { data: r1, error: r1Err } = await admin
      .from("requests")
      .insert({
        vehicle_id: vehicleA.id,
        mechanic_id: mechanic1.id,
        service_type: "brake_service",
        complaint: "Squeaking brakes",
        preferred_date: new Date().toISOString().split("T")[0],
        status: "inspecting",
      })
      .select()
      .single();
    if (r1Err || !r1) throw new Error(`Failed to create request1: ${r1Err?.message}`);
    req1 = r1;
    cleanupRequestIds.push(req1.id);

    const r1ImgPath = `requests/${req1.id}/${crypto.randomUUID()}.jpg`;
    cleanupStoragePaths.push(r1ImgPath);
    await admin.storage.from(SERVICE_IMAGES_BUCKET).upload(r1ImgPath, sampleJpegBuffer, { contentType: "image/jpeg" });
    const { data: r1Img } = await admin.from("images").insert({ request_id: req1.id, storage_path: r1ImgPath, view_angle: "front" }).select().single();

    // Create 3 defect pins and repair items
    const { data: pin1 } = await admin.from("pins").insert({ image_id: r1Img.id, x: 0.2, y: 0.2, part_name: "Front Pads", severity: "high" }).select().single();
    const { data: item1 } = await admin.from("repair_items").insert({ pin_id: pin1.id, description: "Replace front brake pads", estimate: 4500, approval_status: "pending" }).select().single();
    req1Item1 = { id: item1.id, pin_id: pin1.id, description: item1.description };

    const { data: pin2 } = await admin.from("pins").insert({ image_id: r1Img.id, x: 0.4, y: 0.4, part_name: "Brake Rotors", severity: "medium" }).select().single();
    const { data: item2 } = await admin.from("repair_items").insert({ pin_id: pin2.id, description: "Resurface front rotors", estimate: 2500, approval_status: "pending" }).select().single();
    req1Item2 = { id: item2.id, pin_id: pin2.id, description: item2.description };

    const { data: pin3 } = await admin.from("pins").insert({ image_id: r1Img.id, x: 0.6, y: 0.6, part_name: "Brake Fluid", severity: "low" }).select().single();
    const { data: item3 } = await admin.from("repair_items").insert({ pin_id: pin3.id, description: "Flush brake fluid", estimate: 1200, approval_status: "pending" }).select().single();
    req1ItemRejected = { id: item3.id, pin_id: pin3.id, description: item3.description };

    // Submit report -> awaiting_approval
    await admin.from("requests").update({ status: "awaiting_approval" }).eq("id", req1.id);

    // CustomerA approves item1 and item2, rejects item3 -> status becomes 'repairing'
    await admin.rpc("submit_decisions", {
      p_request_id: req1.id,
      p_caller_id: customerA.id,
      p_decisions: [
        { item_id: req1Item1.id, decision: "approved" },
        { item_id: req1Item2.id, decision: "approved" },
        { item_id: req1ItemRejected.id, decision: "rejected" },
      ],
    });

    // 5. Setup Request 2: customerB, assigned to mechanic2, in 'repairing'
    const { data: r2 } = await admin
      .from("requests")
      .insert({
        vehicle_id: vehicleB.id,
        mechanic_id: mechanic2.id,
        service_type: "oil_change",
        complaint: "Oil service",
        preferred_date: new Date().toISOString().split("T")[0],
        status: "inspecting",
      })
      .select()
      .single();
    req2 = r2;
    cleanupRequestIds.push(req2.id);

    const r2ImgPath = `requests/${req2.id}/${crypto.randomUUID()}.jpg`;
    cleanupStoragePaths.push(r2ImgPath);
    await admin.storage.from(SERVICE_IMAGES_BUCKET).upload(r2ImgPath, sampleJpegBuffer, { contentType: "image/jpeg" });
    const { data: r2Img } = await admin.from("images").insert({ request_id: req2.id, storage_path: r2ImgPath, view_angle: "front" }).select().single();

    const { data: r2Pin } = await admin.from("pins").insert({ image_id: r2Img.id, x: 0.5, y: 0.5, part_name: "Oil Filter", severity: "low" }).select().single();
    const { data: r2Item } = await admin.from("repair_items").insert({ pin_id: r2Pin.id, description: "Replace oil filter", estimate: 800, approval_status: "pending" }).select().single();
    req2ItemApproved = { id: r2Item.id, pin_id: r2Pin.id };

    await admin.from("requests").update({ status: "awaiting_approval" }).eq("id", req2.id);
    await admin.rpc("submit_decisions", {
      p_request_id: req2.id,
      p_caller_id: customerB.id,
      p_decisions: [{ item_id: req2ItemApproved.id, decision: "approved" }],
    });

    // 6. Setup Request 3: customerA, assigned to mechanic1, in 'inspecting'
    const { data: r3 } = await admin
      .from("requests")
      .insert({
        vehicle_id: vehicleA.id,
        mechanic_id: mechanic1.id,
        service_type: "tire_rotation",
        complaint: "Tire rotation",
        preferred_date: new Date().toISOString().split("T")[0],
        status: "inspecting",
      })
      .select()
      .single();
    req3 = r3;
    cleanupRequestIds.push(req3.id);

    const r3ImgPath = `requests/${req3.id}/${crypto.randomUUID()}.jpg`;
    cleanupStoragePaths.push(r3ImgPath);
    await admin.storage.from(SERVICE_IMAGES_BUCKET).upload(r3ImgPath, sampleJpegBuffer, { contentType: "image/jpeg" });
    const { data: r3Img } = await admin.from("images").insert({ request_id: req3.id, storage_path: r3ImgPath, view_angle: "rear" }).select().single();

    const { data: r3Pin } = await admin.from("pins").insert({ image_id: r3Img.id, x: 0.3, y: 0.3, part_name: "Rear Tire", severity: "low" }).select().single();
    const { data: r3Item } = await admin.from("repair_items").insert({ pin_id: r3Pin.id, description: "Rotate rear tires", estimate: 500, approval_status: "pending" }).select().single();
    req3Item = { id: r3Item.id, pin_id: r3Pin.id };
  });

  after(async () => {
    // 1. Clean up storage files for all test requests
    for (const reqId of cleanupRequestIds) {
      const { data: files } = await admin.storage.from(SERVICE_IMAGES_BUCKET).list(`requests/${reqId}`);
      if (files && files.length > 0) {
        const paths = files.map((f) => `requests/${reqId}/${f.name}`);
        await admin.storage.from(SERVICE_IMAGES_BUCKET).remove(paths);
      }
      const { data: afterFiles } = await admin.storage.from(SERVICE_IMAGES_BUCKET).list(`requests/${reqId}/after`);
      if (afterFiles && afterFiles.length > 0) {
        const afterPaths = afterFiles.map((f) => `requests/${reqId}/after/${f.name}`);
        await admin.storage.from(SERVICE_IMAGES_BUCKET).remove(afterPaths);
      }
    }

    if (cleanupStoragePaths.length > 0) {
      await admin.storage.from(SERVICE_IMAGES_BUCKET).remove(cleanupStoragePaths);
    }

    // 2. Cascade delete requests
    if (cleanupRequestIds.length > 0) {
      await admin.from("requests").delete().in("id", cleanupRequestIds);
    }

    // 3. Delete vehicles
    if (cleanupVehicleIds.length > 0) {
      await admin.from("vehicles").delete().in("id", cleanupVehicleIds);
    }

    // 4. Delete auth test users
    for (const uid of cleanupUserIds) {
      await admin.auth.admin.deleteUser(uid);
    }
  });

  function buildFormData(buffer: Buffer, filename = "photo.jpg", contentType = "image/jpeg") {
    const formData = new FormData();
    formData.append("file", new Blob([buffer], { type: contentType }), filename);
    return formData;
  }

  // =========================================================================
  // SUITE 1: Security & Ownership Gates (401, 403)
  // =========================================================================
  describe("Security & Ownership Gates", () => {
    it("rejects unauthenticated request with 401", async () => {
      const fd = buildFormData(sampleJpegBuffer);
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/items/${req1Item1.id}/after-photo`, {
        method: "POST",
        body: fd,
      });
      assert.equal(res.status, 401);
    });

    it("rejects vehicle owner / customer with 403", async () => {
      const fd = buildFormData(sampleJpegBuffer);
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/items/${req1Item1.id}/after-photo`, {
        method: "POST",
        headers: { cookie: customerA.cookie },
        body: fd,
      });
      assert.equal(res.status, 403);
    });

    it("rejects another mechanic (not assigned to this request) with 403", async () => {
      const fd = buildFormData(sampleJpegBuffer);
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/items/${req1Item1.id}/after-photo`, {
        method: "POST",
        headers: { cookie: mechanic2.cookie },
        body: fd,
      });
      assert.equal(res.status, 403);
    });

    it("rejects customer owning a different request with 403", async () => {
      const fd = buildFormData(sampleJpegBuffer);
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/items/${req1Item1.id}/after-photo`, {
        method: "POST",
        headers: { cookie: customerB.cookie },
        body: fd,
      });
      assert.equal(res.status, 403);
    });
  });

  // =========================================================================
  // SUITE 2: Lifecycle Conflict Gates (409)
  // =========================================================================
  describe("Lifecycle Conflict Gates", () => {
    it("uploading before 'repairing' status (e.g. while inspecting) returns 409", async () => {
      const fd = buildFormData(sampleJpegBuffer);
      const res = await fetch(`${baseUrl}/api/requests/${req3.id}/items/${req3Item.id}/after-photo`, {
        method: "POST",
        headers: { cookie: mechanic1.cookie },
        body: fd,
      });
      assert.equal(res.status, 409);
    });
  });

  // =========================================================================
  // SUITE 3: Item Validation Gates (404 / 400) & Non-mutation
  // =========================================================================
  describe("Item Validation Gates", () => {
    it("uploading for a rejected item returns 404 and does not mutate record", async () => {
      const fd = buildFormData(sampleJpegBuffer);
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/items/${req1ItemRejected.id}/after-photo`, {
        method: "POST",
        headers: { cookie: mechanic1.cookie },
        body: fd,
      });
      assert.equal(res.status, 404);

      // Verify db row was not modified
      const { data: item } = await admin
        .from("repair_items")
        .select("after_photo_url, completed_at")
        .eq("id", req1ItemRejected.id)
        .single();
      assert.equal(item?.after_photo_url, null);
      assert.equal(item?.completed_at, null);
    });

    it("uploading an item that belongs to another request returns 404", async () => {
      const fd = buildFormData(sampleJpegBuffer);
      // req2ItemApproved belongs to req2, but request path is req1
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/items/${req2ItemApproved.id}/after-photo`, {
        method: "POST",
        headers: { cookie: mechanic1.cookie },
        body: fd,
      });
      assert.equal(res.status, 404);
    });

    it("uploading for a non-existent item UUID returns 404", async () => {
      const fd = buildFormData(sampleJpegBuffer);
      const nonExistentUuid = "00000000-0000-0000-0000-000000000000";
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/items/${nonExistentUuid}/after-photo`, {
        method: "POST",
        headers: { cookie: mechanic1.cookie },
        body: fd,
      });
      assert.equal(res.status, 404);
    });
  });

  // =========================================================================
  // SUITE 4: Image Pipeline Validation & EXIF Stripping
  // =========================================================================
  describe("Image Pipeline & Metadata Stripping", () => {
    it("rejects file over 4 MB with 413", async () => {
      const largeBuffer = Buffer.alloc(4.5 * 1024 * 1024, 0xff);
      const fd = buildFormData(largeBuffer, "large.jpg");
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/items/${req1Item1.id}/after-photo`, {
        method: "POST",
        headers: { cookie: mechanic1.cookie },
        body: fd,
      });
      assert.equal(res.status, 413);
    });

    it("rejects SVG file with 400", async () => {
      const svgBuffer = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>');
      const fd = buildFormData(svgBuffer, "test.svg", "image/svg+xml");
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/items/${req1Item1.id}/after-photo`, {
        method: "POST",
        headers: { cookie: mechanic1.cookie },
        body: fd,
      });
      assert.equal(res.status, 400);
    });

    it("rejects spoofed extension (plain text named .jpg) with 400", async () => {
      const textBuffer = Buffer.from("this is a spoofed text file masquerading as a jpeg");
      const fd = buildFormData(textBuffer, "fake.jpg", "image/jpeg");
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/items/${req1Item1.id}/after-photo`, {
        method: "POST",
        headers: { cookie: mechanic1.cookie },
        body: fd,
      });
      assert.equal(res.status, 400);
    });

    it("strips EXIF metadata from stored after photo", async () => {
      const fd = buildFormData(sampleJpegWithExifBuffer, "photo_with_exif.jpg");
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/items/${req1Item1.id}/after-photo`, {
        method: "POST",
        headers: { cookie: mechanic1.cookie },
        body: fd,
      });
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.success, true);
      assert.ok(json.after_photo_url, "signed_url must be returned");
      // Must NOT leak raw database row or raw path
      assert.equal(json.storage_path, undefined);
      assert.equal(json.item, undefined);

      // Verify EXIF metadata was stripped in database storage
      const { data: item } = await admin
        .from("repair_items")
        .select("after_photo_url")
        .eq("id", req1Item1.id)
        .single();
      assert.ok(item?.after_photo_url?.startsWith(`requests/${req1.id}/after/`));

      const { data: fileBlob } = await admin.storage
        .from(SERVICE_IMAGES_BUCKET)
        .download(item.after_photo_url);
      assert.ok(fileBlob);

      const arrayBuffer = await fileBlob.arrayBuffer();
      const storedBuffer = Buffer.from(arrayBuffer);
      const metadata = await sharp(storedBuffer).metadata();
      assert.equal(metadata.exif, undefined, "EXIF metadata must be stripped from stored image");
    });
  });

  // =========================================================================
  // SUITE 5: Documenting Progress & Atomic Completion Rule
  // =========================================================================
  describe("Documenting Progress & Completion Rule", () => {
    it("documenting only some approved items leaves request in 'repairing'", async () => {
      // req1Item1 was documented in the previous test; req1Item2 is still undocumented.
      const { data: req } = await admin.from("requests").select("status").eq("id", req1.id).single();
      assert.equal(req?.status, "repairing");
    });

    it("replacing a photo while repairing works and deletes the old file", async () => {
      // Retrieve current after_photo_url for req1Item1
      const { data: beforeItem } = await admin
        .from("repair_items")
        .select("after_photo_url")
        .eq("id", req1Item1.id)
        .single();
      const oldPath = beforeItem?.after_photo_url!;
      assert.ok(oldPath);

      // Re-upload a replacement photo for req1Item1
      const replacementBuffer = await sharp({
        create: {
          width: 120,
          height: 120,
          channels: 3,
          background: { r: 80, g: 180, b: 80 },
        },
      })
        .jpeg()
        .toBuffer();

      const fd = buildFormData(replacementBuffer, "replacement.jpg");
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/items/${req1Item1.id}/after-photo`, {
        method: "POST",
        headers: { cookie: mechanic1.cookie },
        body: fd,
      });
      assert.equal(res.status, 200);

      const { data: afterItem } = await admin
        .from("repair_items")
        .select("after_photo_url")
        .eq("id", req1Item1.id)
        .single();
      const newPath = afterItem?.after_photo_url!;
      assert.ok(newPath);
      assert.notEqual(newPath, oldPath, "Replacement must generate a new storage path");

      // Verify old file was deleted from storage
      const oldFilename = path.basename(oldPath);
      const { data: listed } = await admin.storage
        .from(SERVICE_IMAGES_BUCKET)
        .list(`requests/${req1.id}/after`);
      const oldStillExists = (listed || []).some((f) => f.name === oldFilename);
      assert.equal(oldStillExists, false, "Old storage file must be deleted upon replacement");

      // Request must still be in 'repairing' because req1Item2 is not yet documented
      const { data: req } = await admin.from("requests").select("status").eq("id", req1.id).single();
      assert.equal(req?.status, "repairing");
    });

    it("documenting the last approved item atomically transitions request to 'done'", async () => {
      const fd = buildFormData(sampleJpegBuffer, "item2_after.jpg");
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/items/${req1Item2.id}/after-photo`, {
        method: "POST",
        headers: { cookie: mechanic1.cookie },
        body: fd,
      });
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.equal(json.status, "done");
      assert.equal(json.proof_count, 2);
      assert.equal(json.total_approved, 2);

      // Verify request status in database
      const { data: req } = await admin.from("requests").select("status").eq("id", req1.id).single();
      assert.equal(req?.status, "done");
    });

    it("uploading or replacing after request is 'done' fails with 409", async () => {
      const fd = buildFormData(sampleJpegBuffer, "after_done.jpg");
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/items/${req1Item1.id}/after-photo`, {
        method: "POST",
        headers: { cookie: mechanic1.cookie },
        body: fd,
      });
      assert.equal(res.status, 409);
    });
  });

  // =========================================================================
  // SUITE 6: Signed URLs & Read Access Controls
  // =========================================================================
  describe("Read Routes & Signed URLs", () => {
    it("returns freshly signed URLs for after photos to owner in 'done' status", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/pins`, {
        headers: { cookie: customerA.cookie },
      });
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.ok(Array.isArray(json.pins));

      const approvedPins = json.pins.filter((p: any) => p.repair_item?.approval_status === "approved");
      assert.equal(approvedPins.length, 2);

      for (const pin of approvedPins) {
        assert.ok(pin.repair_item.after_photo_url, "Approved items must have signed after_photo_url");
        assert.ok(
          pin.repair_item.after_photo_url.includes("token="),
          "after_photo_url must be a signed URL, not a raw storage path"
        );
      }

      // Rejected item must have null after_photo_url
      const rejectedPin = json.pins.find((p: any) => p.repair_item?.approval_status === "rejected");
      assert.equal(rejectedPin.repair_item.after_photo_url, null);
    });

    it("returns freshly signed URLs for after photos to assigned mechanic", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/pins`, {
        headers: { cookie: mechanic1.cookie },
      });
      assert.equal(res.status, 200);

      const json = await res.json();
      const approvedPins = json.pins.filter((p: any) => p.repair_item?.approval_status === "approved");
      assert.equal(approvedPins.length, 2);
      for (const pin of approvedPins) {
        assert.ok(pin.repair_item.after_photo_url.includes("token="));
      }
    });

    it("rejects another customer from reading pins with 403", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/pins`, {
        headers: { cookie: customerB.cookie },
      });
      assert.equal(res.status, 403);
    });
  });

  // =========================================================================
  // SUITE 7: Customer Privacy (No Mechanic User ID)
  // =========================================================================
  describe("Customer Privacy Protection", () => {
    it("does not leak mechanic user id in GET /api/requests/[id]", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}`, {
        headers: { cookie: customerA.cookie },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.request.mechanic_id, undefined);
    });

    it("does not leak mechanic user id in GET /api/requests", async () => {
      const res = await fetch(`${baseUrl}/api/requests`, {
        headers: { cookie: customerA.cookie },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      for (const r of json.requests) {
        assert.equal(r.mechanic_id, undefined);
      }
    });

    it("does not leak mechanic user id in GET /api/requests/[id]/invoice", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/invoice`, {
        headers: { cookie: customerA.cookie },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.mechanic_id, undefined);
      assert.equal(json.mechanic_user_id, undefined);
      // mechanic_name is allowed
      assert.ok(typeof json.mechanic_name === "string" || json.mechanic_name === null);
    });
  });

  // =========================================================================
  // SUITE 8: Invoice Route Proof Flag
  // =========================================================================
  describe("Invoice Route Proof Flag", () => {
    it("includes per-item has_after_photo flag in invoice response", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${req1.id}/invoice`, {
        headers: { cookie: customerA.cookie },
      });
      assert.equal(res.status, 200);

      const json = await res.json();
      assert.ok(Array.isArray(json.items));
      assert.equal(json.items.length, 2);

      for (const item of json.items) {
        assert.equal(typeof item.has_after_photo, "boolean");
        assert.equal(item.has_after_photo, true);
      }
    });
  });
});
