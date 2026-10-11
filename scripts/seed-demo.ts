import fs from "fs";
import path from "path";

// Ensure environment variables from .env.local are loaded
const envPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

import crypto from "crypto";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";

const DEFAULT_DEMO_DOMAIN = "@demo.servicetrack.app";
const DOMAIN_REGEX = /^@[a-z0-9.-]+$/;
const SERVICE_IMAGES_BUCKET = "service-images";

export function validateDomain(domain: string): string {
  if (!DOMAIN_REGEX.test(domain)) {
    throw new Error(
      `Invalid domain "${domain}". Domain must start with "@" followed by lowercase letters, digits, dots, and hyphens only.`
    );
  }
  return domain;
}

export interface SeedDemoOptions {
  domain?: string;
  confirm?: boolean;
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function getOrGenerateImageBuffer(type: "front" | "after"): Promise<Buffer> {
  const filename = type === "front" ? "front.jpg" : "after.jpg";
  const filepath = path.join(process.cwd(), "seed-assets", filename);

  let rawBuffer: Buffer;
  if (fs.existsSync(filepath)) {
    rawBuffer = fs.readFileSync(filepath);
  } else {
    const label = type === "front" ? "Before" : "After";
    const svg = `
      <svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#f3f4f6"/>
        <circle cx="400" cy="300" r="160" fill="#e5e7eb"/>
        <text x="50%" y="50%" font-family="system-ui, -apple-system, sans-serif" font-size="52" font-weight="bold" fill="#4b5563" text-anchor="middle" dominant-baseline="middle">
          ${label}
        </text>
      </svg>
    `;
    rawBuffer = Buffer.from(svg);
  }

  return await sharp(rawBuffer)
    .rotate()
    .jpeg({ quality: 85, mozjpeg: false })
    .toBuffer();
}

async function uploadImageToStorage(requestId: string, buffer: Buffer): Promise<string> {
  const randomFileName = `${crypto.randomUUID()}.jpg`;
  const storagePath = `requests/${requestId}/${randomFileName}`;

  const { error } = await admin.storage
    .from(SERVICE_IMAGES_BUCKET)
    .upload(storagePath, buffer, {
      contentType: "image/jpeg",
      upsert: false,
    });

  if (error) {
    throw new Error(`Storage upload failed for ${storagePath}: ${error.message}`);
  }

  return storagePath;
}

export async function seedDemoData(
  confirmOrOptions: boolean | SeedDemoOptions = false,
  extraOptions?: SeedDemoOptions
) {
  let confirm = false;
  let domain = DEFAULT_DEMO_DOMAIN;

  if (typeof confirmOrOptions === "boolean") {
    confirm = confirmOrOptions;
    if (extraOptions?.domain) {
      domain = extraOptions.domain;
    }
  } else if (confirmOrOptions && typeof confirmOrOptions === "object") {
    confirm = Boolean(confirmOrOptions.confirm);
    if (confirmOrOptions.domain) {
      domain = confirmOrOptions.domain;
    }
  }

  validateDomain(domain);

  const mechanicEmail = `demo-mechanic${domain}`;
  const customer1Email = `demo-customer1${domain}`;
  const customer2Email = `demo-customer2${domain}`;

  console.log("=== ServiceTrack Demo Data Seeder ===");
  console.log(`Target domain: *${domain}`);

  const demoPassword = process.env.DEMO_PASSWORD;

  if (!confirm) {
    console.log("\n[DRY RUN ONLY] The seed script will create:");
    console.log("1. Demo Accounts:");
    console.log(`   - Mechanic:  ${mechanicEmail}`);
    console.log(`   - Customer 1: ${customer1Email}`);
    console.log(`   - Customer 2: ${customer2Email}`);
    console.log("2. 3 Vehicles:");
    console.log("   - TS09AB1234 (Maruti Suzuki Swift 2021) -> Customer 1");
    console.log("   - MH12CD5678 (Hyundai Creta 2022)       -> Customer 1");
    console.log("   - KA01EF9012 (Honda City 2020)          -> Customer 2");
    console.log("3. Requests in all statuses:");
    console.log("   - done              (Vehicle 1) -> all approved items documented with before/after photos");
    console.log("   - repairing         (Vehicle 1) -> items approved by customer, work in progress");
    console.log("   - awaiting_approval (Vehicle 2) -> inspection report submitted, awaiting customer decision");
    console.log("   - booked            (Vehicle 2) -> in queue, ready for mechanic claim");
    console.log("   - inspecting        (Vehicle 3) -> claimed by mechanic, inspection pins added");
    console.log("   - cancelled         (Vehicle 3) -> cancelled request");
    console.log("\nTo execute this seeding, re-run with --confirm.");
    if (!demoPassword) {
      console.log("Note: DEMO_PASSWORD is not set in environment. Set it in .env.local before running with --confirm.");
    }
    return;
  }

  if (!demoPassword) {
    throw new Error("DEMO_PASSWORD environment variable is missing. Please define it in .env.local.");
  }

  console.log("\n[CONFIRMED] Creating demo accounts...");

  // 1. Create or retrieve users idempotently
  const { data: usersData, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listError) throw new Error(`Failed to list users: ${listError.message}`);

  const existingUsers = usersData?.users || [];
  async function ensureUser(email: string, name: string, phone: string, role: "mechanic" | "customer") {
    let existing = existingUsers.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    let userId: string;

    if (existing) {
      userId = existing.id;
      await admin.auth.admin.updateUserById(userId, {
        password: demoPassword,
        user_metadata: { name, phone },
        app_metadata: { role },
      });
      console.log(` - Reusing existing auth user: ${email} (${userId})`);
    } else {
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password: demoPassword,
        email_confirm: true,
        user_metadata: { name, phone },
      });
      if (createErr || !created.user) {
        throw new Error(`Failed to create ${email}: ${createErr?.message}`);
      }
      userId = created.user.id;
      console.log(` - Created new auth user: ${email} (${userId})`);
    }

    if (role === "mechanic") {
      await admin.auth.admin.updateUserById(userId, {
        app_metadata: { role: "mechanic" },
      });
      await admin.from("users").update({ role: "mechanic", name, phone }).eq("id", userId);
    } else {
      await admin.from("users").update({ role: "customer", name, phone }).eq("id", userId);
    }

    return { id: userId, email };
  }

  const mechanic = await ensureUser(mechanicEmail, "Demo Mechanic", "9876543210", "mechanic");
  const customer1 = await ensureUser(customer1Email, "Demo Customer One", "9876543211", "customer");
  const customer2 = await ensureUser(customer2Email, "Demo Customer Two", "9876543212", "customer");

  // 2. Create 3 Vehicles
  console.log("\nCreating demo vehicles...");
  async function ensureVehicle(userId: string, plate: string, brand: string, model: string, year: number) {
    const { data: existing } = await admin
      .from("vehicles")
      .select("*")
      .eq("user_id", userId)
      .eq("plate", plate)
      .maybeSingle();

    if (existing) {
      console.log(` - Reusing vehicle ${plate} (${existing.id})`);
      return existing;
    }

    const { data: created, error: vehErr } = await admin
      .from("vehicles")
      .insert({
        user_id: userId,
        plate,
        brand,
        model,
        year,
        public_token: crypto.randomUUID(),
        public_history_enabled: true,
        is_active: true,
      })
      .select()
      .single();

    if (vehErr || !created) {
      throw new Error(`Failed to create vehicle ${plate}: ${vehErr?.message}`);
    }
    console.log(` - Created vehicle ${plate}: ${brand} ${model} (${created.id})`);
    return created;
  }

  const v1 = await ensureVehicle(customer1.id, "TS09AB1234", "Maruti Suzuki", "Swift", 2021);
  const v2 = await ensureVehicle(customer1.id, "MH12CD5678", "Hyundai", "Creta", 2022);
  const v3 = await ensureVehicle(customer2.id, "KA01EF9012", "Honda", "City", 2020);

  // 3. Prepare Image Buffers
  const frontBuffer = await getOrGenerateImageBuffer("front");
  const afterBuffer = await getOrGenerateImageBuffer("after");

  // 4. Seed Requests across all 6 statuses
  console.log("\nSeeding requests across all statuses using strict application rules...");

  // Helper to create request
  async function createInitialRequest(vehicleId: string, serviceType: string, complaint: string) {
    const today = new Date().toISOString().split("T")[0];
    const { data: req, error } = await admin
      .from("requests")
      .insert({
        vehicle_id: vehicleId,
        service_type: serviceType,
        complaint: complaint,
        preferred_date: today,
        status: "booked",
      })
      .select()
      .single();

    if (error || !req) {
      throw new Error(`Failed to insert request for vehicle ${vehicleId}: ${error?.message}`);
    }
    return req;
  }

  // --- REQUEST 1: 'done' (Vehicle 1) ---
  console.log(" - Creating 'done' request on TS09AB1234...");
  const reqDone = await createInitialRequest(v1.id, "full_inspection", "Annual scheduled maintenance");
  // Transition to inspecting assigned to mechanic
  await admin.from("requests").update({ status: "inspecting", mechanic_id: mechanic.id }).eq("id", reqDone.id);
  // Upload before photo
  const doneBeforePath = await uploadImageToStorage(reqDone.id, frontBuffer);
  const { data: doneImg } = await admin
    .from("images")
    .insert({ request_id: reqDone.id, storage_path: doneBeforePath, view_angle: "front" })
    .select()
    .single();

  // Create defect pins & items via SQL function
  const { data: pin1Res, error: pin1Err } = await admin.rpc("create_pin_with_item", {
    p_request_id: reqDone.id,
    p_caller_id: mechanic.id,
    p_image_id: doneImg.id,
    p_x: 0.355,
    p_y: 0.42,
    p_part_name: "Front Brake Pads",
    p_severity: "high",
    p_notes: "Worn below 2mm thickness",
    p_description: "Replace front disc brake pad set",
    p_estimate: 3200,
  });
  if (pin1Err) throw new Error(`create_pin_with_item 1 failed: ${pin1Err.message} (${pin1Err.code})`);

  const { data: pin2Res, error: pin2Err } = await admin.rpc("create_pin_with_item", {
    p_request_id: reqDone.id,
    p_caller_id: mechanic.id,
    p_image_id: doneImg.id,
    p_x: 0.62,
    p_y: 0.55,
    p_part_name: "Synthetic Engine Oil",
    p_severity: "medium",
    p_notes: "Oil dark and degraded",
    p_description: "Drain oil, replace filter, refill 5W-30 synthetic",
    p_estimate: 1800,
  });
  if (pin2Err) throw new Error(`create_pin_with_item 2 failed: ${pin2Err.message} (${pin2Err.code})`);

  // Submit inspection report
  const { error: subRepErr } = await admin.rpc("submit_inspection_report", {
    p_request_id: reqDone.id,
    p_caller_id: mechanic.id,
  });
  if (subRepErr) throw new Error(`submit_inspection_report failed: ${subRepErr.message} (${subRepErr.code})`);

  // Submit customer decisions (Approve both items)
  const { error: subDecErr } = await admin.rpc("submit_decisions", {
    p_request_id: reqDone.id,
    p_caller_id: customer1.id,
    p_decisions: [
      { item_id: pin1Res.item_id, decision: "approved" },
      { item_id: pin2Res.item_id, decision: "approved" },
    ],
  });
  if (subDecErr) throw new Error(`submit_decisions failed: ${subDecErr.message} (${subDecErr.code})`);

  // Upload after photos and attach via RPC
  const doneAfter1Path = await uploadImageToStorage(reqDone.id, afterBuffer);
  const { error: att1Err } = await admin.rpc("attach_after_photo", {
    p_request_id: reqDone.id,
    p_item_id: pin1Res.item_id,
    p_caller_id: mechanic.id,
    p_path: doneAfter1Path,
  });
  if (att1Err) throw new Error(`attach_after_photo 1 failed: ${att1Err.message} (${att1Err.code})`);

  const doneAfter2Path = await uploadImageToStorage(reqDone.id, afterBuffer);
  const { error: att2Err } = await admin.rpc("attach_after_photo", {
    p_request_id: reqDone.id,
    p_item_id: pin2Res.item_id,
    p_caller_id: mechanic.id,
    p_path: doneAfter2Path,
  });
  if (att2Err) throw new Error(`attach_after_photo 2 failed: ${att2Err.message} (${att2Err.code})`);
  console.log(`   ✓ Request ${reqDone.id} completed (done) with 2 verified repairs`);

  // --- REQUEST 2: 'repairing' (Vehicle 1) ---
  console.log(" - Creating 'repairing' request on TS09AB1234...");
  const reqRepairing = await createInitialRequest(v1.id, "brake_service", "Suspension thudding on bumps");
  await admin.from("requests").update({ status: "inspecting", mechanic_id: mechanic.id }).eq("id", reqRepairing.id);
  const repBeforePath = await uploadImageToStorage(reqRepairing.id, frontBuffer);
  const { data: repImg } = await admin
    .from("images")
    .insert({ request_id: reqRepairing.id, storage_path: repBeforePath, view_angle: "front" })
    .select()
    .single();

  const { data: repPin1, error: repPin1Err } = await admin.rpc("create_pin_with_item", {
    p_request_id: reqRepairing.id,
    p_caller_id: mechanic.id,
    p_image_id: repImg.id,
    p_x: 0.28,
    p_y: 0.6,
    p_part_name: "Front Strut Shock Absorber",
    p_severity: "high",
    p_notes: "Hydraulic oil leakage detected",
    p_description: "Replace front right strut assembly",
    p_estimate: 4800,
  });
  if (repPin1Err) throw new Error(`create_pin_with_item rep1 failed: ${repPin1Err.message} (${repPin1Err.code})`);

  const { data: repPin2, error: repPin2Err } = await admin.rpc("create_pin_with_item", {
    p_request_id: reqRepairing.id,
    p_caller_id: mechanic.id,
    p_image_id: repImg.id,
    p_x: 0.7,
    p_y: 0.35,
    p_part_name: "Cabin AC Filter",
    p_severity: "low",
    p_notes: "Dust clogged",
    p_description: "Clean or replace cabin filter",
    p_estimate: 600,
  });
  if (repPin2Err) throw new Error(`create_pin_with_item rep2 failed: ${repPin2Err.message} (${repPin2Err.code})`);

  const { error: subRepErr2 } = await admin.rpc("submit_inspection_report", {
    p_request_id: reqRepairing.id,
    p_caller_id: mechanic.id,
  });
  if (subRepErr2) throw new Error(`submit_inspection_report rep failed: ${subRepErr2.message} (${subRepErr2.code})`);

  // Approve Shock Absorber, Reject Cabin AC Filter -> transitions to repairing
  const { error: subDecErr2 } = await admin.rpc("submit_decisions", {
    p_request_id: reqRepairing.id,
    p_caller_id: customer1.id,
    p_decisions: [
      { item_id: repPin1.item_id, decision: "approved" },
      { item_id: repPin2.item_id, decision: "rejected" },
    ],
  });
  if (subDecErr2) throw new Error(`submit_decisions rep failed: ${subDecErr2.message} (${subDecErr2.code})`);
  console.log(`   ✓ Request ${reqRepairing.id} in repairing status (1 approved item in progress)`);

  // --- REQUEST 3: 'awaiting_approval' (Vehicle 2) ---
  console.log(" - Creating 'awaiting_approval' request on MH12CD5678...");
  const reqAwaiting = await createInitialRequest(v2.id, "engine_diagnostics", "Engine hesitation on acceleration");
  await admin.from("requests").update({ status: "inspecting", mechanic_id: mechanic.id }).eq("id", reqAwaiting.id);
  const awtBeforePath = await uploadImageToStorage(reqAwaiting.id, frontBuffer);
  const { data: awtImg } = await admin
    .from("images")
    .insert({ request_id: reqAwaiting.id, storage_path: awtBeforePath, view_angle: "front" })
    .select()
    .single();

  const { error: awtPinErr } = await admin.rpc("create_pin_with_item", {
    p_request_id: reqAwaiting.id,
    p_caller_id: mechanic.id,
    p_image_id: awtImg.id,
    p_x: 0.5,
    p_y: 0.48,
    p_part_name: "Iridium Spark Plugs",
    p_severity: "medium",
    p_notes: "Carbon buildup and misfire code",
    p_description: "Set of 4 Iridium spark plugs",
    p_estimate: 2400,
  });
  if (awtPinErr) throw new Error(`create_pin_with_item awt failed: ${awtPinErr.message} (${awtPinErr.code})`);

  const { error: subRepErr3 } = await admin.rpc("submit_inspection_report", {
    p_request_id: reqAwaiting.id,
    p_caller_id: mechanic.id,
  });
  if (subRepErr3) throw new Error(`submit_inspection_report awt failed: ${subRepErr3.message} (${subRepErr3.code})`);
  console.log(`   ✓ Request ${reqAwaiting.id} in awaiting_approval status`);

  // --- REQUEST 4: 'booked' (Vehicle 2) ---
  console.log(" - Creating 'booked' request on MH12CD5678...");
  const reqBooked = await createInitialRequest(v2.id, "other", "Pre-monsoon general checkup");
  console.log(`   ✓ Request ${reqBooked.id} in booked status (open queue)`);

  // --- REQUEST 5: 'inspecting' (Vehicle 3) ---
  console.log(" - Creating 'inspecting' request on KA01EF9012...");
  const reqInspecting = await createInitialRequest(v3.id, "brake_service", "Squeaking sound when braking");
  await admin.from("requests").update({ status: "inspecting", mechanic_id: mechanic.id }).eq("id", reqInspecting.id);
  const inspBeforePath = await uploadImageToStorage(reqInspecting.id, frontBuffer);
  const { data: inspImg } = await admin
    .from("images")
    .insert({ request_id: reqInspecting.id, storage_path: inspBeforePath, view_angle: "front" })
    .select()
    .single();

  const { error: inspPinErr } = await admin.rpc("create_pin_with_item", {
    p_request_id: reqInspecting.id,
    p_caller_id: mechanic.id,
    p_image_id: inspImg.id,
    p_x: 0.45,
    p_y: 0.5,
    p_part_name: "Wiper Blades",
    p_severity: "low",
    p_notes: "Streaking water on windshield",
    p_description: "Frameless wiper blade set",
    p_estimate: 750,
  });
  if (inspPinErr) throw new Error(`create_pin_with_item insp failed: ${inspPinErr.message} (${inspPinErr.code})`);
  console.log(`   ✓ Request ${reqInspecting.id} in inspecting status`);

  // --- REQUEST 6: 'cancelled' (Vehicle 3) ---
  console.log(" - Creating 'cancelled' request on KA01EF9012...");
  const reqCancelled = await createInitialRequest(v3.id, "oil_change", "Customer cancelled due to travel");
  await admin.from("requests").update({ status: "cancelled" }).eq("id", reqCancelled.id);
  console.log(`   ✓ Request ${reqCancelled.id} in cancelled status`);

  console.log("\n=== Demo Seed Completed Successfully ===");
  console.log("Accounts:");
  console.log(` - Mechanic:  ${mechanic.email}`);
  console.log(` - Customer1: ${customer1.email}`);
  console.log(` - Customer2: ${customer2.email}`);
  console.log("\nRequests Status Summary:");
  console.log(` - done:              ${reqDone.id} (Vehicle TS09AB1234)`);
  console.log(` - repairing:         ${reqRepairing.id} (Vehicle TS09AB1234)`);
  console.log(` - awaiting_approval: ${reqAwaiting.id} (Vehicle MH12CD5678)`);
  console.log(` - booked:            ${reqBooked.id} (Vehicle MH12CD5678)`);
  console.log(` - inspecting:        ${reqInspecting.id} (Vehicle KA01EF9012)`);
  console.log(` - cancelled:         ${reqCancelled.id} (Vehicle KA01EF9012)`);
  console.log("\nPublic Vehicle History URL for TS09AB1234:");
  console.log(` http://localhost:3000/h/${v1.public_token}`);
}

if (process.argv[1] && process.argv[1].endsWith("seed-demo.ts")) {
  const isConfirm = process.argv.includes("--confirm");
  const domainArg = process.argv.find((arg) => arg.startsWith("--domain="));
  const domain = domainArg ? domainArg.split("=")[1] : DEFAULT_DEMO_DOMAIN;
  seedDemoData({ confirm: isConfirm, domain }).catch((err) => {
    console.error("\n[ERROR] Seeding failed:", err);
    process.exit(1);
  });
}
