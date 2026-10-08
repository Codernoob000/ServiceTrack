import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { vehicleUpdateSchema } from "@/lib/validation";
import { getServiceRoleClient } from "@/lib/supabase/admin";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const { user, profile, error: authError } = await getAuthenticatedUser();
    if (authError || !user || !profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = getServiceRoleClient();
    const { data: vehicle, error } = await admin
      .from("vehicles")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error || !vehicle) {
      return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });
    }

    // Ownership check: customers must own the vehicle
    if (profile.role === "customer" && vehicle.user_id !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Mechanic check: must be linked to a request they can inspect
    if (profile.role === "mechanic") {
      const { data: linkedRequest } = await admin
        .from("requests")
        .select("id")
        .eq("vehicle_id", id)
        .or(`mechanic_id.eq.${user.id},and(mechanic_id.is.null,status.eq.booked)`)
        .maybeSingle();

      if (!linkedRequest) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    return NextResponse.json({ vehicle });
  } catch (err) {
    console.error("Vehicle GET by id error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const { user, profile, error: authError } = await getAuthenticatedUser();
    if (authError || !user || !profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (profile.role !== "customer") {
      return NextResponse.json({ error: "Only owners can update vehicles." }, { status: 403 });
    }

    const admin = getServiceRoleClient();

    // Explicit ownership and is_active check
    const { data: existing, error: findError } = await admin
      .from("vehicles")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (findError || !existing) {
      return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });
    }

    if (existing.user_id !== user.id) {
      return NextResponse.json({ error: "Forbidden: You do not own this vehicle." }, { status: 403 });
    }

    if (!existing.is_active) {
      return NextResponse.json({ error: "Cannot modify an inactive vehicle." }, { status: 400 });
    }

    const body = await request.json();
    const parsed = vehicleUpdateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid update data." }, { status: 400 });
    }

    const { plate, brand, model, year } = parsed.data;

    // Field whitelist: only plate, brand, model, year are modifiable by customer.
    // user_id, public_token, and is_active are NEVER client-settable here!
    const updates: Record<string, unknown> = {};
    if (plate !== undefined) updates.plate = plate.trim().toUpperCase();
    if (brand !== undefined) updates.brand = brand.trim();
    if (model !== undefined) updates.model = model.trim();
    if (year !== undefined) updates.year = year;

    const { data: updatedVehicle, error: updateError } = await admin
      .from("vehicles")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (updateError) {
      console.error("Vehicle update error:", updateError);
      return NextResponse.json({ error: "Failed to update vehicle." }, { status: 500 });
    }

    return NextResponse.json({ vehicle: updatedVehicle });
  } catch (err) {
    console.error("Vehicle PATCH error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const { user, profile, error: authError } = await getAuthenticatedUser();
    if (authError || !user || !profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (profile.role !== "customer") {
      return NextResponse.json({ error: "Only owners can remove vehicles." }, { status: 403 });
    }

    const admin = getServiceRoleClient();

    // Verify ownership and is_active in code
    const { data: existing } = await admin
      .from("vehicles")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (!existing) {
      return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });
    }

    if (existing.user_id !== user.id) {
      return NextResponse.json({ error: "Forbidden: You do not own this vehicle." }, { status: 403 });
    }

    // Check if there are active service requests for this vehicle
    const { data: activeRequests } = await admin
      .from("requests")
      .select("id, status")
      .eq("vehicle_id", id)
      .in("status", ["booked", "inspecting", "awaiting_approval", "repairing"]);

    if (activeRequests && activeRequests.length > 0) {
      return NextResponse.json(
        { error: "Cannot delete vehicle with active service requests in progress." },
        { status: 400 }
      );
    }

    // Soft delete: set is_active = false
    const { error: softDeleteError } = await admin
      .from("vehicles")
      .update({ is_active: false })
      .eq("id", id)
      .eq("user_id", user.id);

    if (softDeleteError) {
      return NextResponse.json({ error: "Failed to delete vehicle." }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: "Vehicle archived successfully." });
  } catch (err) {
    console.error("Vehicle DELETE error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
