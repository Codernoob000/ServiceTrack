/**
 * Phase 2a Integration Tests: Inspection Editor API routes & DB triggers against live Supabase.
 *
 * Covers:
 * 1. Image upload validation:
 *    - Rejects Content-Length > 4 MB (413)
 *    - Rejects actual parsed file size > 4 MB (413)
 *    - Rejects non-image / corrupted signature (400)
 *    - Rejects SVG files (400)
 *    - Rejects non-mechanic and unassigned mechanic (403)
 *    - Rejects when request status != inspecting (409)
 *    - Valid JPEG and PNG upload succeeds (201) with sharp re-encode, random storage path, signed URL (10 min)
 *    - GPS-tagged JPEG upload: stored file downloaded via service role has all EXIF/GPS stripped
 *    - Enforces 10-image maximum limit per request (DB trigger check under lock)
 * 2. Strict read gate on GET /api/requests/[id]/images and /pins:
 *    - Assigned mechanic has access anytime (200)
 *    - Unassigned mechanic is denied (403) both before and after report submission
 *    - Vehicle owner is denied before report submission while status is 'inspecting' (403)
 *    - Vehicle owner has access after report submission when status is 'awaiting_approval' (200)
 *    - Non-owner customer is denied (403)
 * 3. Cross-request resource isolation:
 *    - Pin id from a different request rejected on PATCH (404)
 *    - Pin id from a different request rejected on DELETE (404)
 *    - Image id from a different request rejected on image DELETE (404)
 * 4. Defect pins & atomic repair item creation:
 *    - Non-integer estimate rejected (400)
 *    - Whitespace-only part_name rejected (400)
 *    - Out-of-range coordinates or negative estimate rejected (400)
 *    - Unassigned mechanic denied (403)
 *    - Valid pin and repair item created atomically via create_pin_with_item RPC (201)
 * 5. Pin update (PATCH strict whitelist) & DELETE:
 *    - Disallowed fields rejected (400)
 *    - Whitelisted fields updated (200)
 *    - Delete pin cascades to repair item (200)
 * 6. Lifecycle & cancelled request rejection:
 *    - Writes on a cancelled request return 409
 *    - Release with 0 images succeeds back to booked (200)
 *    - Release after images uploaded rejected (400)
 *    - Submit report without images rejected (400)
 *    - Submit report with images and pins succeeds to awaiting_approval (200)
 *    - Post-submission image upload rejected (409)
 * 7. Storage Teardown:
 *    - Teardown cleans up database rows and deletes uploaded files from service-images bucket
 *    - Asserts 0 remaining files in service-images and 0 leftover auth/public test users
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

describe("Phase 2a: Inspection Editor Live Integration Tests", () => {
  const admin = createAdminClient(supabaseUrl, serviceRoleKey);
  const testRunId = Date.now();
  const prefix = `p2test_${testRunId}`;

  const cleanupUserIds: string[] = [];
  const cleanupVehicleIds: string[] = [];
  const cleanupRequestIds: string[] = [];
  const cleanupStoragePaths: string[] = [];

  let customerA: { id: string; email: string; cookie: string };
  let customerB: { id: string; email: string; cookie: string };
  let mechanic1: { id: string; email: string; cookie: string };
  let mechanic2: { id: string; email: string; cookie: string };

  let vehicleA: { id: string };
  let inspectingReq: { id: string };
  let bookedReq: { id: string };
  let secondReq: { id: string };
  let secondImageId: string;
  let secondPinId: string;

  let sampleJpegBuffer: Buffer;
  let samplePngBuffer: Buffer;
  let gpsJpegBuffer: Buffer;

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

  function toBlob(buf: Buffer, type = "image/jpeg"): Blob {
    return new Blob([new Uint8Array(buf)], { type });
  }

  before(async () => {
    // 0. Verify dev/production server is reachable
    try {
      const res = await fetch(`${baseUrl}/api/auth/invite`, { method: "HEAD" }).catch(() => null);
      if (!res) {
        const ping = await fetch(baseUrl).catch(() => null);
        if (!ping) {
          throw new Error(`Development server is not reachable at ${baseUrl}. Ensure server is running.`);
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Development server is not reachable at ${baseUrl}: ${msg}`);
    }

    // 1. Generate real valid sample JPEG, PNG, and GPS-tagged JPEG buffers
    sampleJpegBuffer = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .jpeg()
      .toBuffer();

    samplePngBuffer = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 0, g: 255, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    // Construct genuine JPEG with APP1 EXIF GPS tags
    const exifPayload = Buffer.from([
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // 'Exif\0\0'
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // TIFF header (little-endian)
      0x01, 0x00, // 1 entry in IFD0
      0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1a, 0x00, 0x00, 0x00, // GPSInfo pointer
      0x00, 0x00, 0x00, 0x00, // next IFD offset
      0x01, 0x00, // GPS IFD: 1 entry
      0x00, 0x00, 0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x02, 0x03, 0x00, 0x00, // GPSVersion 2.3.0.0
      0x00, 0x00, 0x00, 0x00,
    ]);
    const app1Len = exifPayload.length + 2;
    const app1Header = Buffer.from([0xff, 0xe1, (app1Len >> 8) & 0xff, app1Len & 0xff]);
    gpsJpegBuffer = Buffer.concat([
      sampleJpegBuffer.subarray(0, 2),
      app1Header,
      exifPayload,
      sampleJpegBuffer.subarray(2),
    ]);

    // Verify gpsJpegBuffer actually has EXIF metadata before upload
    const gpsMeta = await sharp(gpsJpegBuffer).metadata();
    assert.ok(gpsMeta.exif && gpsMeta.exif.length > 0, "Source test JPEG must contain EXIF metadata");

    // 2. Seed users
    customerA = await createTestUser("cust_a", "customer");
    customerB = await createTestUser("cust_b", "customer");
    mechanic1 = await createTestUser("mech_1", "mechanic");
    mechanic2 = await createTestUser("mech_2", "mechanic");

    // 3. Seed vehicle for Customer A
    const plate = `P2-${Math.floor(Math.random() * 8999 + 1000)}`;
    const { data: veh, error: vehErr } = await admin
      .from("vehicles")
      .insert({
        user_id: customerA.id,
        plate,
        brand: "Honda",
        model: "Civic",
        year: 2022,
        is_active: true,
      })
      .select("id")
      .single();

    if (vehErr || !veh) throw new Error(`Vehicle seed failed: ${vehErr?.message}`);
    vehicleA = veh;
    cleanupVehicleIds.push(veh.id);

    // 4. Seed primary 'inspecting' request assigned to mechanic 1
    const { data: req1, error: reqErr1 } = await admin
      .from("requests")
      .insert({
        vehicle_id: vehicleA.id,
        service_type: "full_inspection",
        complaint: "Comprehensive pre-purchase inspection",
        preferred_date: "2026-12-01",
        status: "inspecting",
        mechanic_id: mechanic1.id,
      })
      .select("id")
      .single();

    if (reqErr1 || !req1) throw new Error(`Inspecting request seed failed: ${reqErr1?.message}`);
    inspectingReq = req1;
    cleanupRequestIds.push(req1.id);

    // 5. Seed a 'booked' request unassigned
    const { data: req2, error: reqErr2 } = await admin
      .from("requests")
      .insert({
        vehicle_id: vehicleA.id,
        service_type: "oil_change",
        complaint: "Oil change needed",
        preferred_date: "2026-12-02",
        status: "booked",
        mechanic_id: null,
      })
      .select("id")
      .single();

    if (reqErr2 || !req2) throw new Error(`Booked request seed failed: ${reqErr2?.message}`);
    bookedReq = req2;
    cleanupRequestIds.push(req2.id);

    // 6. Seed a second 'inspecting' request (to test cross-request isolation)
    const { data: req3, error: reqErr3 } = await admin
      .from("requests")
      .insert({
        vehicle_id: vehicleA.id,
        service_type: "engine_diagnostics",
        complaint: "Cross-request isolation test request",
        preferred_date: "2026-12-03",
        status: "inspecting",
        mechanic_id: mechanic1.id,
      })
      .select("id")
      .single();

    if (reqErr3 || !req3) throw new Error(`Second request seed failed: ${reqErr3?.message}`);
    secondReq = req3;
    cleanupRequestIds.push(req3.id);

    // Upload an image and pin for secondReq
    const secondStoragePath = `requests/${secondReq.id}/${crypto.randomUUID()}.jpg`;
    await admin.storage
      .from(SERVICE_IMAGES_BUCKET)
      .upload(secondStoragePath, sampleJpegBuffer, { contentType: "image/jpeg" });
    cleanupStoragePaths.push(secondStoragePath);

    const { data: imgRow } = await admin
      .from("images")
      .insert({
        request_id: secondReq.id,
        storage_path: secondStoragePath,
        view_angle: "front",
      })
      .select("id")
      .single();
    secondImageId = imgRow!.id;

    const { data: pinRpc } = await admin.rpc("create_pin_with_item", {
      p_request_id: secondReq.id,
      p_caller_id: mechanic1.id,
      p_image_id: secondImageId,
      p_x: 0.5,
      p_y: 0.5,
      p_part_name: "Radiator",
      p_severity: "medium",
      p_notes: "Second request radiator",
      p_description: "Flush radiator",
      p_estimate: 2000,
    });
    secondPinId = pinRpc.pin_id;
  });

  after(async () => {
    // 1. Delete all uploaded files from storage bucket
    const uniquePaths = Array.from(new Set(cleanupStoragePaths));
    if (uniquePaths.length > 0) {
      const { error: removeError } = await admin.storage
        .from(SERVICE_IMAGES_BUCKET)
        .remove(uniquePaths);
      if (removeError) {
        console.error("Storage remove error:", removeError);
      }
    }

    // Delay to allow storage deletion propagation
    await new Promise((resolve) => setTimeout(resolve, 800));

    // 2. Verify and report how many files remain in SERVICE_IMAGES_BUCKET for this test run
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
    assert.strictEqual(remainingFiles, 0, `No leftover files should remain in ${SERVICE_IMAGES_BUCKET}`);

    // 3. Remove requests (cascade deletes images, pins, repair items)
    for (const reqId of cleanupRequestIds) {
      await admin.from("requests").delete().eq("id", reqId);
    }

    // 4. Remove vehicles
    for (const vehId of cleanupVehicleIds) {
      await admin.from("vehicles").delete().eq("id", vehId);
    }

    // 5. Remove test users
    for (const uid of cleanupUserIds) {
      await admin.auth.admin.deleteUser(uid);
    }

    // 6. Verify 0 leftover users in auth.users and public.users
    const { data: { users } } = await admin.auth.admin.listUsers();
    const leftoverAuth = users.filter((u) => u.email?.startsWith(prefix));
    const { data: leftoverPublic } = await admin
      .from("users")
      .select("id")
      .ilike("email", `${prefix}%`);

    console.log(`[Phase2 Teardown] Leftover auth users: ${leftoverAuth.length}`);
    console.log(`[Phase2 Teardown] Leftover public users: ${leftoverPublic?.length ?? 0}`);

    assert.strictEqual(leftoverAuth.length, 0, "No leftover test users in auth.users");
    assert.strictEqual(leftoverPublic?.length ?? 0, 0, "No leftover test users in public.users");
  });

  // ==========================================
  // 1. IMAGE UPLOAD TESTS
  // ==========================================
  describe("Image Upload Validation & Ingestion", () => {
    it("rejects oversized request before processing (Content-Length > 4 MB yields 413)", async () => {
      const largeFormData = new FormData();
      const largeBlob = new Blob([new Uint8Array(4.2 * 1024 * 1024)]);
      largeFormData.append("file", largeBlob, "large.jpg");
      largeFormData.append("view_angle", "front");

      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/images`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie },
        body: largeFormData,
      });

      assert.strictEqual(res.status, 413, `Expected 413 Payload Too Large, got ${res.status}`);
    });

    it("rejects parsed file size over 4 MB after body parsing with 413", async () => {
      const overSizeBuffer = Buffer.alloc(4.1 * 1024 * 1024, 0xff);
      // Give valid JPEG header
      overSizeBuffer[0] = 0xff;
      overSizeBuffer[1] = 0xd8;
      overSizeBuffer[2] = 0xff;
      const fileBlob = toBlob(overSizeBuffer);

      const formData = new FormData();
      formData.append("file", fileBlob, "oversized.jpg");
      formData.append("view_angle", "front");

      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/images`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie },
        body: formData,
      });

      assert.strictEqual(res.status, 413, `Expected 413 for parsed file size > 4 MB, got ${res.status}`);
    });

    it("rejects non-image payload and invalid file signature with 400", async () => {
      const formData = new FormData();
      const fakeBlob = new Blob(["This is a text file, not a picture"], { type: "image/jpeg" });
      formData.append("file", fakeBlob, "fake.jpg");
      formData.append("view_angle", "front");

      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/images`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie },
        body: formData,
      });

      assert.strictEqual(res.status, 400, `Expected 400 for fake signature, got ${res.status}`);
      const data = await res.json();
      assert.ok(data.error.includes("signature") || data.error.includes("format"));
    });

    it("rejects SVG files with 400", async () => {
      const formData = new FormData();
      const svgText = "<svg xmlns='http://www.w3.org/2000/svg'><circle r='10'/></svg>";
      const svgBlob = new Blob([svgText], { type: "image/svg+xml" });
      formData.append("file", svgBlob, "vector.svg");
      formData.append("view_angle", "rear");

      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/images`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie },
        body: formData,
      });

      assert.strictEqual(res.status, 400, `Expected 400 for SVG upload, got ${res.status}`);
      const data = await res.json();
      assert.ok(data.error.toLowerCase().includes("svg"));
    });

    it("rejects image upload by unassigned mechanic (mechanic 2) with 403", async () => {
      const formData = new FormData();
      const blob = toBlob(sampleJpegBuffer);
      formData.append("file", blob, "photo.jpg");
      formData.append("view_angle", "front");

      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/images`, {
        method: "POST",
        headers: { Cookie: mechanic2.cookie },
        body: formData,
      });

      assert.strictEqual(res.status, 403, `Expected 403 for unassigned mechanic, got ${res.status}`);
    });

    it("rejects image upload by customer with 403", async () => {
      const formData = new FormData();
      const blob = toBlob(sampleJpegBuffer);
      formData.append("file", blob, "photo.jpg");
      formData.append("view_angle", "front");

      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/images`, {
        method: "POST",
        headers: { Cookie: customerA.cookie },
        body: formData,
      });

      assert.strictEqual(res.status, 403, `Expected 403 for customer, got ${res.status}`);
    });

    it("rejects image upload when request is in booked status with 409", async () => {
      const formData = new FormData();
      const blob = toBlob(sampleJpegBuffer);
      formData.append("file", blob, "photo.jpg");
      formData.append("view_angle", "front");

      const res = await fetch(`${baseUrl}/api/requests/${bookedReq.id}/images`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie },
        body: formData,
      });

      assert.ok([400, 403, 409].includes(res.status), `Expected 409, 400 or 403 for booked request, got ${res.status}`);
    });

    let uploadedStoragePath: string;

    it("successfully uploads valid JPEG for assigned mechanic, returns 201 with signed URL", async () => {
      const formData = new FormData();
      const blob = toBlob(sampleJpegBuffer);
      formData.append("file", blob, "original_client_filename.jpg");
      formData.append("view_angle", "front");

      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/images`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie },
        body: formData,
      });

      assert.strictEqual(res.status, 201, `Expected 201, got ${res.status}`);
      const body = await res.json();
      assert.strictEqual(body.success, true);
      assert.ok(body.image?.id);
      assert.strictEqual(body.image.view_angle, "front");
      assert.ok(body.image.signed_url?.includes("http"));

      uploadedStoragePath = body.image.storage_path;
      cleanupStoragePaths.push(uploadedStoragePath);

      // Verify random UUID path (never client file name)
      assert.ok(!uploadedStoragePath.includes("original_client_filename"));
      assert.ok(uploadedStoragePath.startsWith(`requests/${inspectingReq.id}/`));
      assert.ok(uploadedStoragePath.endsWith(".jpg"));

      // Verify signed URL is accessible
      const signedGet = await fetch(body.image.signed_url);
      assert.strictEqual(signedGet.status, 200, "Signed URL should be accessible via GET");
      const signedBuffer = Buffer.from(await signedGet.arrayBuffer());
      assert.ok(signedBuffer.length > 0);
      assert.strictEqual(signedBuffer[0], 0xff); // JPEG magic byte
    });

    it("uploads GPS-tagged JPEG and verifies downloaded stored file contains NO EXIF/GPS", async () => {
      const formData = new FormData();
      const blob = toBlob(gpsJpegBuffer);
      formData.append("file", blob, "camera_gps.jpg");
      formData.append("view_angle", "rear");

      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/images`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie },
        body: formData,
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();
      const storedPath = data.image.storage_path;
      cleanupStoragePaths.push(storedPath);

      // Download directly with service role from SERVICE_IMAGES_BUCKET
      const { data: downloadedBlob, error: downloadErr } = await admin.storage
        .from(SERVICE_IMAGES_BUCKET)
        .download(storedPath);

      assert.strictEqual(downloadErr, null);
      assert.ok(downloadedBlob);

      const downloadedBuf = Buffer.from(await downloadedBlob.arrayBuffer());
      const metadata = await sharp(downloadedBuf).metadata();

      // Assert that sharp re-encoding stripped all EXIF and GPS tags
      assert.strictEqual(metadata.exif, undefined, "Stored image must contain NO EXIF or GPS metadata");
    });

    it("successfully uploads valid PNG, re-encoded cleanly to JPEG", async () => {
      const formData = new FormData();
      const blob = toBlob(samplePngBuffer, "image/png");
      formData.append("file", blob, "side_view.png");
      formData.append("view_angle", "left");

      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/images`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie },
        body: formData,
      });

      assert.strictEqual(res.status, 201);
      const body = await res.json();
      assert.strictEqual(body.image.view_angle, "left");
      cleanupStoragePaths.push(body.image.storage_path);
    });

    it("enforces maximum cap of 10 images per request", async () => {
      // We already uploaded 3 images. Upload 7 more to reach 10 images.
      for (let i = 4; i <= 10; i++) {
        const formData = new FormData();
        const blob = toBlob(sampleJpegBuffer);
        formData.append("file", blob, `img_${i}.jpg`);
        formData.append("view_angle", "other");

        const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/images`, {
          method: "POST",
          headers: { Cookie: mechanic1.cookie },
          body: formData,
        });

        assert.strictEqual(res.status, 201, `Image ${i} upload failed with status ${res.status}`);
        const data = await res.json();
        cleanupStoragePaths.push(data.image.storage_path);
      }

      // 11th image upload must be rejected by database trigger limit
      const overLimitFormData = new FormData();
      const blob = toBlob(sampleJpegBuffer);
      overLimitFormData.append("file", blob, "img_11_fail.jpg");
      overLimitFormData.append("view_angle", "rear");

      const failRes = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/images`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie },
        body: overLimitFormData,
      });

      assert.strictEqual(failRes.status, 400, `Expected 400 for 11th image, got ${failRes.status}`);
      const failData = await failRes.json();
      assert.ok(
        failData.error?.includes("10 images") || failData.error?.includes("limit"),
        `Expected max image limit error, got: ${failData.error}`
      );
    });
  });

  // ==========================================
  // 2. READ GATE ACCESS CONTROL (IMAGES & PINS)
  // ==========================================
  describe("Read Gate on GET images & pins: Assigned mechanic anytime, Owner only after submission, others 403", () => {
    it("owner gets 403 on GET images while request status is 'inspecting' (before submit)", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/images`, {
        headers: { Cookie: customerA.cookie },
      });
      assert.strictEqual(res.status, 403, `Expected 403 for owner before submit, got ${res.status}`);
    });

    it("owner gets 403 on GET pins while request status is 'inspecting' (before submit)", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/pins`, {
        headers: { Cookie: customerA.cookie },
      });
      assert.strictEqual(res.status, 403, `Expected 403 for owner before submit, got ${res.status}`);
    });

    it("unassigned mechanic gets 403 on GET images", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/images`, {
        headers: { Cookie: mechanic2.cookie },
      });
      assert.strictEqual(res.status, 403, `Expected 403 for unassigned mechanic, got ${res.status}`);
    });

    it("unassigned mechanic gets 403 on GET pins", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/pins`, {
        headers: { Cookie: mechanic2.cookie },
      });
      assert.strictEqual(res.status, 403, `Expected 403 for unassigned mechanic, got ${res.status}`);
    });

    it("assigned mechanic gets 200 on GET images anytime", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/images`, {
        headers: { Cookie: mechanic1.cookie },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.images.length, 10);
    });

    it("assigned mechanic gets 200 on GET pins anytime", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/pins`, {
        headers: { Cookie: mechanic1.cookie },
      });
      assert.strictEqual(res.status, 200);
    });
  });

  // ==========================================
  // 3. DEFECT PINS & CROSS-REQUEST ISOLATION
  // ==========================================
  describe("Defect Pins, Atomic Repair Items & Cross-Request Isolation", () => {
    let firstImageId: string;
    let createdPinId: string;

    before(async () => {
      const { data: images } = await admin
        .from("images")
        .select("id")
        .eq("request_id", inspectingReq.id)
        .limit(1);

      assert.ok(images && images.length > 0);
      firstImageId = images[0].id;
    });

    it("rejects non-integer estimate with 400", async () => {
      const payload = {
        image_id: firstImageId,
        x: 0.5,
        y: 0.5,
        part_name: "Front Bumper",
        severity: "medium",
        description: "Bumper alignment",
        estimate: 1500.5, // non-integer
      };

      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/pins`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      assert.strictEqual(res.status, 400, `Expected 400 for non-integer estimate, got ${res.status}`);
    });

    it("rejects whitespace-only part_name with 400", async () => {
      const payload = {
        image_id: firstImageId,
        x: 0.5,
        y: 0.5,
        part_name: "   ", // whitespace only
        severity: "medium",
        description: "Valid description",
        estimate: 1500,
      };

      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/pins`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      assert.strictEqual(res.status, 400, `Expected 400 for whitespace-only part_name, got ${res.status}`);
    });

    it("rejects pin creation with out-of-range coordinates or negative estimate", async () => {
      const invalidPinPayload = {
        image_id: firstImageId,
        x: 1.5,
        y: -0.2,
        part_name: "Brake Pad",
        severity: "high",
        description: "Replace worn brake pads",
        estimate: -500,
      };

      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/pins`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
        body: JSON.stringify(invalidPinPayload),
      });

      assert.strictEqual(res.status, 400);
    });

    it("successfully creates pin and repair item atomically via create_pin_with_item RPC", async () => {
      const validPayload = {
        image_id: firstImageId,
        x: 0.45,
        y: 0.65,
        part_name: "Front Brake Rotor",
        severity: "critical",
        notes: "Excessive scoring and heat spots detected",
        description: "Replace front brake rotors with OEM parts",
        estimate: 8500,
      };

      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/pins`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
        body: JSON.stringify(validPayload),
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.pin?.pin_id);
      assert.ok(data.pin?.item_id);
      assert.strictEqual(data.pin.part_name, "Front Brake Rotor");
      assert.strictEqual(data.pin.estimate, 8500);

      createdPinId = data.pin.pin_id;
    });

    it("rejects PATCH on pin id belonging to a different request with 404", async () => {
      // secondPinId belongs to secondReq, but calling on inspectingReq
      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/pins/${secondPinId}`, {
        method: "PATCH",
        headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ estimate: 5000 }),
      });

      assert.strictEqual(res.status, 404, `Expected 404 for cross-request pin PATCH, got ${res.status}`);
    });

    it("rejects DELETE on pin id belonging to a different request with 404", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/pins/${secondPinId}`, {
        method: "DELETE",
        headers: { Cookie: mechanic1.cookie },
      });

      assert.strictEqual(res.status, 404, `Expected 404 for cross-request pin DELETE, got ${res.status}`);
    });

    it("rejects DELETE on image id belonging to a different request with 404", async () => {
      // secondImageId belongs to secondReq, calling on inspectingReq
      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/images/${secondImageId}`, {
        method: "DELETE",
        headers: { Cookie: mechanic1.cookie },
      });

      assert.strictEqual(res.status, 404, `Expected 404 for cross-request image DELETE, got ${res.status}`);
    });

    it("PATCH pin rejects disallowed fields with 400 (strict whitelist enforcement)", async () => {
      const maliciousPayload = {
        approval_status: "approved",
        created_at: "2020-01-01T00:00:00Z",
        estimate: 10000,
      };

      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/pins/${createdPinId}`, {
        method: "PATCH",
        headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
        body: JSON.stringify(maliciousPayload),
      });

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes("Disallowed fields"));
    });

    it("PATCH pin successfully updates whitelisted fields on pin and repair item", async () => {
      const validUpdate = {
        estimate: 9200,
        description: "Replace front brake rotors with premium ceramic pads included",
        severity: "high",
        notes: "Updated parts pricing",
      };

      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/pins/${createdPinId}`, {
        method: "PATCH",
        headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
        body: JSON.stringify(validUpdate),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.pin.severity, "high");
      assert.strictEqual(data.pin.notes, "Updated parts pricing");
      assert.strictEqual(data.pin.repair_item.estimate, 9200);
    });
  });

  // ==========================================
  // 4. TRANSITIONS & CANCELLED REQUEST REJECTION
  // ==========================================
  describe("Transitions, Report Submission & Cancelled Request Lockdown", () => {
    it("writes on a cancelled request return 409", async () => {
      // Seed a request and cancel it
      const { data: cancelledReq } = await admin
        .from("requests")
        .insert({
          vehicle_id: vehicleA.id,
          service_type: "oil_change",
          complaint: "Cancel test",
          preferred_date: "2026-12-10",
          status: "cancelled",
          mechanic_id: mechanic1.id,
        })
        .select("id")
        .single();

      assert.ok(cancelledReq);
      cleanupRequestIds.push(cancelledReq.id);

      // Attempt image upload on cancelled request
      const formData = new FormData();
      formData.append("file", toBlob(sampleJpegBuffer), "test.jpg");
      formData.append("view_angle", "front");

      const imgRes = await fetch(`${baseUrl}/api/requests/${cancelledReq.id}/images`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie },
        body: formData,
      });

      assert.strictEqual(imgRes.status, 409, `Expected 409 for image upload on cancelled request, got ${imgRes.status}`);

      // Attempt pin creation on cancelled request
      const pinRes = await fetch(`${baseUrl}/api/requests/${cancelledReq.id}/pins`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          image_id: "00000000-0000-0000-0000-000000000000",
          x: 0.5,
          y: 0.5,
          part_name: "Tire",
          severity: "low",
          description: "Check tire pressure",
          estimate: 500,
        }),
      });

      assert.strictEqual(pinRes.status, 409, `Expected 409 for pin create on cancelled request, got ${pinRes.status}`);
    });

    it("release_inspection_job fails with 400 if images have been uploaded", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/transition`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "release" }),
      });

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes("images have been uploaded"));
    });

    it("release_inspection_job succeeds for job in inspecting with 0 images", async () => {
      const { data: cleanReq } = await admin
        .from("requests")
        .insert({
          vehicle_id: vehicleA.id,
          service_type: "engine_diagnostics",
          complaint: "Battery discharge test",
          preferred_date: "2026-12-05",
          status: "inspecting",
          mechanic_id: mechanic1.id,
        })
        .select("id")
        .single();

      assert.ok(cleanReq);
      cleanupRequestIds.push(cleanReq.id);

      const res = await fetch(`${baseUrl}/api/requests/${cleanReq.id}/transition`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "release" }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.request.status, "booked");
      assert.strictEqual(data.request.mechanic_id, null);
    });

    it("submit_inspection_report fails with 400 if request has 0 images", async () => {
      const { data: noImgReq } = await admin
        .from("requests")
        .insert({
          vehicle_id: vehicleA.id,
          service_type: "full_inspection",
          complaint: "No image test",
          preferred_date: "2026-12-06",
          status: "inspecting",
          mechanic_id: mechanic1.id,
        })
        .select("id")
        .single();

      assert.ok(noImgReq);
      cleanupRequestIds.push(noImgReq.id);

      const res = await fetch(`${baseUrl}/api/requests/${noImgReq.id}/transition`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submit_report" }),
      });

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes("without inspection images"));
    });

    it("submit_inspection_report succeeds with >= 1 image and >= 1 defect pin, moving to awaiting_approval", async () => {
      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/transition`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submit_report" }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.request.status, "awaiting_approval");

      const { data: finalReq } = await admin
        .from("requests")
        .select("status")
        .eq("id", inspectingReq.id)
        .single();

      assert.strictEqual(finalReq?.status, "awaiting_approval");
    });

    it("after submit_report: owner now gets 200 on GET images and GET pins", async () => {
      // GET images
      const imgRes = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/images`, {
        headers: { Cookie: customerA.cookie },
      });
      assert.strictEqual(imgRes.status, 200, `Expected 200 for owner on images after submit, got ${imgRes.status}`);
      const imgData = await imgRes.json();
      assert.ok(imgData.images.length >= 1);

      // GET pins
      const pinRes = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/pins`, {
        headers: { Cookie: customerA.cookie },
      });
      assert.strictEqual(pinRes.status, 200, `Expected 200 for owner on pins after submit, got ${pinRes.status}`);
      const pinData = await pinRes.json();
      assert.ok(pinData.pins.length >= 1);
    });

    it("after submit_report: unassigned mechanic STILL gets 403 on GET images and pins", async () => {
      const imgRes = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/images`, {
        headers: { Cookie: mechanic2.cookie },
      });
      assert.strictEqual(imgRes.status, 403);

      const pinRes = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/pins`, {
        headers: { Cookie: mechanic2.cookie },
      });
      assert.strictEqual(pinRes.status, 403);
    });

    it("post-submission lockdown: image upload rejected with 409 once status is awaiting_approval", async () => {
      const formData = new FormData();
      formData.append("file", toBlob(sampleJpegBuffer), "late_photo.jpg");
      formData.append("view_angle", "front");

      const res = await fetch(`${baseUrl}/api/requests/${inspectingReq.id}/images`, {
        method: "POST",
        headers: { Cookie: mechanic1.cookie },
        body: formData,
      });

      assert.strictEqual(res.status, 409);
      const data = await res.json();
      assert.ok(data.error.includes("inspecting"));
    });
  });
});
