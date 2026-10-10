/**
 * Schema validation test suite.
 * Validates Zod request body and parameter schemas.
 * Uses native Node.js test runner (node:test) and assertions (node:assert/strict).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  registerSchema,
  profileUpdateSchema,
  vehicleCreateSchema,
  vehicleUpdateSchema,
  requestCreateSchema,
  requestTransitionSchema,
} from "../src/lib/validation";

describe("Schema validation", () => {
  it("registerSchema rejects invalid role and missing mechanic invite", () => {
    // Mechanic missing invite code
    const res1 = registerSchema.safeParse({
      email: "test@example.com",
      password: "password123",
      name: "John",
      role: "mechanic",
      inviteCode: "",
    });
    assert.strictEqual(res1.success, false);

    // Valid customer
    const res2 = registerSchema.safeParse({
      email: "cust@example.com",
      password: "password123",
      name: "Customer",
      role: "customer",
    });
    assert.strictEqual(res2.success, true);
  });

  it("profileUpdateSchema restricts modifiable fields", () => {
    const res = profileUpdateSchema.safeParse({
      name: "Updated Name",
      phone: "+1234567890",
      role: "mechanic",
    });
    assert.strictEqual(res.success, true);
    if (res.success) {
      // @ts-expect-error role should not exist
      assert.strictEqual(res.data.role, undefined);
    }
  });

  it("vehicleCreateSchema enforces plate and year rules", () => {
    // Invalid year
    const invalidYear = vehicleCreateSchema.safeParse({
      plate: "ABC-1234",
      brand: "Toyota",
      model: "Camry",
      year: 1850,
    });
    assert.strictEqual(invalidYear.success, false);

    // Plate with invalid characters
    const invalidPlate = vehicleCreateSchema.safeParse({
      plate: "INVALID!@#$",
      brand: "Toyota",
      model: "Camry",
      year: 2022,
    });
    assert.strictEqual(invalidPlate.success, false);

    // Valid vehicle
    const valid = vehicleCreateSchema.safeParse({
      plate: "7XYZ890",
      brand: "Honda",
      model: "Civic",
      year: 2021,
    });
    assert.strictEqual(valid.success, true);
  });

  it("vehicleUpdateSchema does not accept user_id or public_token", () => {
    const updatePayload = {
      plate: "NEW-PLATE",
      brand: "Ford",
      user_id: "attacker-uuid",
      public_token: "hacked-token",
    };
    const res = vehicleUpdateSchema.safeParse(updatePayload);
    assert.strictEqual(res.success, true);
    if (res.success) {
      // @ts-expect-error user_id cannot exist on parsed payload
      assert.strictEqual(res.data.user_id, undefined);
      // @ts-expect-error public_token cannot exist on parsed payload
      assert.strictEqual(res.data.public_token, undefined);
    }
  });

  it("requestCreateSchema validates service type enum", () => {
    const invalidType = requestCreateSchema.safeParse({
      vehicle_id: "123e4567-e89b-12d3-a456-426614174000",
      service_type: "unknown_hack_service",
      complaint: "Engine rattling on cold start",
      preferred_date: "2026-10-15",
    });
    assert.strictEqual(invalidType.success, false);

    const valid = requestCreateSchema.safeParse({
      vehicle_id: "123e4567-e89b-12d3-a456-426614174000",
      service_type: "brake_service",
      complaint: "Squeaking sound when applying brakes gently",
      preferred_date: "2026-10-15",
    });
    assert.strictEqual(valid.success, true);
  });

  it("requestTransitionSchema restricts action to valid state machine transitions", () => {
    const invalidAction = requestTransitionSchema.safeParse({
      action: "force_complete_without_approval",
    });
    assert.strictEqual(invalidAction.success, false);

    const valid = requestTransitionSchema.safeParse({
      action: "cancel",
    });
    assert.strictEqual(valid.success, true);
  });
});
