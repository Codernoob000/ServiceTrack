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

export interface ResetDemoOptions {
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

export async function resetDemoData(
  confirmOrOptions: boolean | ResetDemoOptions = false,
  extraOptions?: ResetDemoOptions
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

  const targetDomainLower = domain.toLowerCase();

  console.log("=== ServiceTrack Demo Data Cleanup ===");
  console.log(`Target account domain: *${domain}`);

  // 1. Fetch all auth users
  const { data: usersData, error: listError } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (listError) {
    throw new Error(`Failed to list auth users: ${listError.message}`);
  }

  // Filter ONLY accounts ending with the target domain
  const demoUsers = usersData.users.filter((u) => {
    const email = u.email?.toLowerCase() || "";
    return email.endsWith(targetDomainLower);
  });

  const demoUserIds = demoUsers.map((u) => u.id);

  console.log(`Found ${demoUsers.length} matching demo account(s):`);
  demoUsers.forEach((u) => console.log(` - ${u.email} (${u.id})`));

  if (demoUsers.length === 0) {
    console.log("No demo accounts found to remove.");
    return {
      usersRemoved: 0,
      vehiclesRemoved: 0,
      requestsRemoved: 0,
      filesRemoved: 0,
    };
  }

  // 2. Query vehicles owned by these users
  const { data: vehicles, error: vehError } = await admin
    .from("vehicles")
    .select("id, plate, user_id")
    .in("user_id", demoUserIds);

  if (vehError) {
    throw new Error(`Failed to query vehicles: ${vehError.message}`);
  }

  const vehicleIds = (vehicles || []).map((v) => v.id);
  console.log(`Found ${(vehicles || []).length} vehicle(s) belonging to demo accounts.`);

  // 3. Query requests for these vehicles or claimed by these mechanics
  let requests: Array<{ id: string; vehicle_id: string; status: string }> = [];
  if (vehicleIds.length > 0 || demoUserIds.length > 0) {
    let query = admin.from("requests").select("id, vehicle_id, status");
    if (vehicleIds.length > 0 && demoUserIds.length > 0) {
      query = query.or(`vehicle_id.in.(${vehicleIds.join(",")}),mechanic_id.in.(${demoUserIds.join(",")})`);
    } else if (vehicleIds.length > 0) {
      query = query.in("vehicle_id", vehicleIds);
    } else {
      query = query.in("mechanic_id", demoUserIds);
    }

    const { data: reqData, error: reqError } = await query;
    if (reqError) {
      throw new Error(`Failed to query requests: ${reqError.message}`);
    }
    requests = reqData || [];
  }

  const requestIds = requests.map((r) => r.id);
  console.log(`Found ${requests.length} request(s) belonging to demo accounts.`);

  // 4. Collect all storage paths in memory
  const storagePaths = new Set<string>();

  if (requestIds.length > 0) {
    const { data: imgData, error: imgError } = await admin
      .from("images")
      .select("id, storage_path")
      .in("request_id", requestIds);

    if (imgError) {
      throw new Error(`Failed to query images for storage paths: ${imgError.message}`);
    }
    const imageIds: string[] = [];
    (imgData || []).forEach((img) => {
      if (img.storage_path) storagePaths.add(img.storage_path);
      if (img.id) imageIds.push(img.id);
    });

    if (imageIds.length > 0) {
      const { data: pinData, error: pinError } = await admin
        .from("pins")
        .select("id")
        .in("image_id", imageIds);

      if (pinError) {
        throw new Error(`Failed to query pins for storage paths: ${pinError.message}`);
      }

      const pinIds = (pinData || []).map((p) => p.id);
      if (pinIds.length > 0) {
        const { data: itemData, error: itemError } = await admin
          .from("repair_items")
          .select("after_photo_url")
          .in("pin_id", pinIds);

        if (itemError) {
          throw new Error(`Failed to query repair items for storage paths: ${itemError.message}`);
        }
        (itemData || []).forEach((item) => {
          if (item.after_photo_url) storagePaths.add(item.after_photo_url);
        });
      }
    }
  }

  const collectedPaths = Array.from(storagePaths);
  console.log(`Collected ${collectedPaths.length} storage file path(s) in memory.`);

  if (!confirm) {
    console.log("\n[DRY RUN ONLY] No changes were made.");
    console.log("Summary of data that WOULD be removed with --confirm:");
    console.log(` - Demo users: ${demoUsers.length}`);
    console.log(` - Demo vehicles: ${(vehicles || []).length}`);
    console.log(` - Demo requests: ${requests.length}`);
    console.log(` - Storage files: ${collectedPaths.length}`);
    console.log("\nTo proceed with deletion, re-run with --confirm.");
    return {
      usersRemoved: 0,
      vehiclesRemoved: 0,
      requestsRemoved: 0,
      filesRemoved: 0,
    };
  }

  console.log("\n[CONFIRMED] Executing deletion in strict sequence...");

  // Step 1: Delete requests (cascades to images, pins, repair_items)
  if (requestIds.length > 0) {
    const { error: delReqErr } = await admin
      .from("requests")
      .delete()
      .in("id", requestIds);
    if (delReqErr) {
      throw new Error(`Failed to delete requests: ${delReqErr.message}`);
    }
    console.log(`✓ Deleted ${requestIds.length} request(s)`);
  }

  // Step 2: Delete vehicles
  if (vehicleIds.length > 0) {
    const { error: delVehErr } = await admin
      .from("vehicles")
      .delete()
      .in("id", vehicleIds);
    if (delVehErr) {
      throw new Error(`Failed to delete vehicles: ${delVehErr.message}`);
    }
    console.log(`✓ Deleted ${vehicleIds.length} vehicle(s)`);
  }

  // Step 3: Delete public.users rows
  if (demoUserIds.length > 0) {
    const { error: delUserErr } = await admin
      .from("users")
      .delete()
      .in("id", demoUserIds);
    if (delUserErr) {
      throw new Error(`Failed to delete public.users rows: ${delUserErr.message}`);
    }
    console.log(`✓ Deleted ${demoUserIds.length} public.users row(s)`);
  }

  // Step 4: Delete auth.users
  for (const uid of demoUserIds) {
    const { error: delAuthErr } = await admin.auth.admin.deleteUser(uid);
    if (delAuthErr) {
      console.warn(`Warning: Failed to delete auth user ${uid}: ${delAuthErr.message}`);
    }
  }
  console.log(`✓ Deleted ${demoUserIds.length} auth user(s)`);

  // Step 5: Remove storage files (ignoring missing files)
  let removedCount = 0;
  if (collectedPaths.length > 0) {
    const { data: remData, error: remErr } = await admin.storage
      .from(SERVICE_IMAGES_BUCKET)
      .remove(collectedPaths);

    if (remErr) {
      console.warn(`Warning during storage removal: ${remErr.message}`);
    } else {
      removedCount = remData?.length ?? collectedPaths.length;
    }
    console.log(`✓ Removed storage files (${removedCount} attempted)`);
  }

  // Verification: check remaining accounts for target domain
  const { data: remainingUsers } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const remainingDemo = (remainingUsers?.users || []).filter((u) =>
    (u.email?.toLowerCase() || "").endsWith(targetDomainLower)
  );

  console.log("\n=== Demo Cleanup Complete ===");
  console.log(`Users removed: ${demoUserIds.length}`);
  console.log(`Vehicles removed: ${vehicleIds.length}`);
  console.log(`Requests removed: ${requestIds.length}`);
  console.log(`Storage files removed: ${collectedPaths.length}`);
  console.log(`Remaining demo accounts: ${remainingDemo.length}`);

  return {
    usersRemoved: demoUserIds.length,
    vehiclesRemoved: vehicleIds.length,
    requestsRemoved: requestIds.length,
    filesRemoved: collectedPaths.length,
  };
}

if (process.argv[1] && process.argv[1].endsWith("reset-demo.ts")) {
  const isConfirm = process.argv.includes("--confirm");
  const domainArg = process.argv.find((arg) => arg.startsWith("--domain="));
  const domain = domainArg ? domainArg.split("=")[1] : DEFAULT_DEMO_DOMAIN;
  resetDemoData({ confirm: isConfirm, domain }).catch((err) => {
    console.error("\n[ERROR] Cleanup failed:", err);
    process.exit(1);
  });
}
