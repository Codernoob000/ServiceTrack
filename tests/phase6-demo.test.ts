import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
import { seedDemoData, validateDomain as validateSeedDomain } from "../scripts/seed-demo";
import { resetDemoData, validateDomain as validateResetDomain } from "../scripts/reset-demo";

const DEFAULT_DEMO_DOMAIN = "@demo.servicetrack.app";
const TEST_DOMAIN = "@seedtest.servicetrack.app";
const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Guard: safety helper to ensure reset is never run against default domain in tests
function safeReset(domain: string) {
  if (domain === DEFAULT_DEMO_DOMAIN) {
    throw new Error(`Refusing to run reset against default demo domain ${DEFAULT_DEMO_DOMAIN} in test!`);
  }
  return resetDemoData({ confirm: true, domain });
}

describe("Phase 6: Demo Seed and Reset Lifecycle Live Test", { concurrency: 1 }, () => {
  it("enforces strict domain validation on seedDemoData and resetDemoData", () => {
    // Valid domain formats
    assert.doesNotThrow(() => validateSeedDomain("@seedtest.servicetrack.app"));
    assert.doesNotThrow(() => validateResetDomain("@seedtest.servicetrack.app"));
    assert.doesNotThrow(() => validateSeedDomain("@sub-domain1.test.org"));

    // Invalid domain formats (missing @, uppercase, invalid symbols)
    assert.throws(() => validateSeedDomain("seedtest.servicetrack.app"), /Invalid domain/);
    assert.throws(() => validateSeedDomain("@Seedtest.app"), /Invalid domain/);
    assert.throws(() => validateSeedDomain("@seed test.app"), /Invalid domain/);
    assert.throws(() => validateResetDomain("@invalid!domain.com"), /Invalid domain/);
    assert.throws(() => validateResetDomain(""), /Invalid domain/);
  });

  it("refuses to run reset if the domain equals @demo.servicetrack.app", async () => {
    // Assert safeReset throws before any delete attempt
    await assert.rejects(
      async () => {
        await safeReset(DEFAULT_DEMO_DOMAIN);
      },
      (err: Error) => {
        assert.ok(
          err.message.includes(`Refusing to run reset against default demo domain ${DEFAULT_DEMO_DOMAIN}`),
          `Expected refusal error message, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it("seeds with test domain, verifies public history, cleanly resets test data, and preserves default demo accounts", async () => {
    // Strict refusal check: the test domain must NEVER be the real demo domain
    if (TEST_DOMAIN === DEFAULT_DEMO_DOMAIN) {
      throw new Error(`Test domain cannot equal ${DEFAULT_DEMO_DOMAIN}`);
    }

    if (!process.env.DEMO_PASSWORD) {
      process.env.DEMO_PASSWORD = "DemoSecureTestPassword123!";
    }

    // Step 0: Record existing default demo accounts before the test starts
    const { data: initialUsersData } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const defaultAccountsBefore = (initialUsersData?.users || []).filter((u) =>
      (u.email?.toLowerCase() || "").endsWith(DEFAULT_DEMO_DOMAIN)
    );
    const defaultIdsBefore = new Map(
      defaultAccountsBefore.map((u) => [u.email!.toLowerCase(), u.id])
    );

    // Pre-cleanup in case a previous aborted test run left any test-domain accounts
    await safeReset(TEST_DOMAIN);

    try {
      // Step 1: Run seed with test-only domain
      await seedDemoData({ confirm: true, domain: TEST_DOMAIN });

      // Step 2: Verify test domain users count (exactly 3: 1 mechanic, 2 customers)
      const { data: usersData } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const testUsers = (usersData?.users || []).filter((u) =>
        (u.email?.toLowerCase() || "").endsWith(TEST_DOMAIN)
      );
      assert.strictEqual(testUsers.length, 3, `Expected exactly 3 accounts created for ${TEST_DOMAIN}`);

      // Step 3: Verify vehicle 1 exists for test customer and retrieve public token
      const testCustomer1 = testUsers.find((u) =>
        u.email?.toLowerCase().startsWith("demo-customer1")
      );
      assert.ok(testCustomer1, `demo-customer1${TEST_DOMAIN} must exist`);

      const { data: v1 } = await admin
        .from("vehicles")
        .select("id, plate, public_token")
        .eq("user_id", testCustomer1.id)
        .eq("plate", "TS09AB1234")
        .single();
      assert.ok(v1?.public_token, "Vehicle TS09AB1234 must have a public_token");

      // Step 4: Verify public history endpoint shows the 'done' request
      const historyRes = await fetch(`${baseUrl}/api/public/vehicles/${v1.public_token}`, {
        headers: { "Cache-Control": "no-cache" },
      });
      assert.strictEqual(historyRes.status, 200, "Public history route should return 200 for TS09AB1234");

      const historyData = await historyRes.json();
      assert.strictEqual(historyData.brand, "Maruti Suzuki");
      assert.strictEqual(historyData.model, "Swift");
      assert.strictEqual(historyData.masked_plate, "TS09****34");
      assert.ok(Array.isArray(historyData.repairs), "repairs should be an array");
      assert.ok(historyData.repairs.length >= 2, "Expected at least 2 completed repairs documented with photos");

      const firstRepair = historyData.repairs[0];
      assert.ok(firstRepair.part_name, "Repair must have part_name");
      assert.ok(firstRepair.before_url, "Repair must have before_url signed link");
      assert.ok(firstRepair.after_url, "Repair must have after_url signed link");

      // Step 5: Run resetDemoData with test-only domain
      const resetResult = await safeReset(TEST_DOMAIN);
      assert.strictEqual(resetResult.usersRemoved, 3, `Should remove exactly 3 users for ${TEST_DOMAIN}`);

      // Step 6: Confirm 0 test-domain accounts remain
      const { data: afterUsers } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const remainingTestUsers = (afterUsers?.users || []).filter((u) =>
        (u.email?.toLowerCase() || "").endsWith(TEST_DOMAIN)
      );
      assert.strictEqual(remainingTestUsers.length, 0, `Expected 0 remaining accounts for ${TEST_DOMAIN} after reset`);

      // Public history should return 404 after deletion
      const postResetHistoryRes = await fetch(`${baseUrl}/api/public/vehicles/${v1.public_token}`);
      assert.strictEqual(postResetHistoryRes.status, 404, "Public history should return 404 after reset");

      // Step 7: Requirement 3 - Assert that default demo accounts are still present with the exact same IDs
      const defaultAccountsAfter = (afterUsers?.users || []).filter((u) =>
        (u.email?.toLowerCase() || "").endsWith(DEFAULT_DEMO_DOMAIN)
      );
      if (defaultAccountsBefore.length > 0) {
        assert.strictEqual(
          defaultAccountsAfter.length,
          defaultAccountsBefore.length,
          "All default demo accounts present before test must still be present after test"
        );
        for (const acc of defaultAccountsAfter) {
          const email = acc.email!.toLowerCase();
          assert.ok(defaultIdsBefore.has(email), `Default demo account ${email} was present before test`);
          assert.strictEqual(
            acc.id,
            defaultIdsBefore.get(email),
            `Default demo account ${email} must retain the exact same ID after test`
          );
        }
      }
    } finally {
      // Teardown: strictly removes only the test-only domain
      await safeReset(TEST_DOMAIN);
    }
  });
});
