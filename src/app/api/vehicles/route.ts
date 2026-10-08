import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getAuthenticatedUser } from "@/lib/auth";
import { vehicleCreateSchema } from "@/lib/validation";
import { getServiceRoleClient } from "@/lib/supabase/admin";

export async function GET() {
  try {
    const { user, profile, error: authError } = await getAuthenticatedUser();
    if (authError || !user || !profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = getServiceRoleClient();

    // Customers read only their own active vehicles
    // Mechanics can read vehicles tied to requests they inspect or can inspect
    if (profile.role === "customer") {
      const { data: vehicles, error } = await admin
        .from("vehicles")
        .select("*")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .order("created_at", { ascending: false });

      if (error) {
        return NextResponse.json({ error: "Failed to fetch vehicles." }, { status: 500 });
      }

      return NextResponse.json({ vehicles });
    } else {
      // Mechanic reading vehicles linked to requests
      const { data: requests } = await admin
        .from("requests")
        .select("vehicle_id")
        .or(`mechanic_id.eq.${user.id},and(mechanic_id.is.null,status.eq.booked)`);

      const vehicleIds = (requests || []).map((r) => r.vehicle_id);

      if (vehicleIds.length === 0) {
        return NextResponse.json({ vehicles: [] });
      }

      const { data: vehicles, error } = await admin
        .from("vehicles")
        .select("*")
        .in("id", vehicleIds);

      if (error) {
        return NextResponse.json({ error: "Failed to fetch vehicles." }, { status: 500 });
      }

      return NextResponse.json({ vehicles });
    }
  } catch (err) {
    console.error("Vehicles GET error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { user, profile, error: authError } = await getAuthenticatedUser();
    if (authError || !user || !profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (profile.role !== "customer") {
      return NextResponse.json({ error: "Only customers can register vehicles." }, { status: 403 });
    }

    const body = await request.json();
    const parsed = vehicleCreateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid vehicle information." },
        { status: 400 }
      );
    }

    const { plate, brand, model, year } = parsed.data;
    const admin = getServiceRoleClient();

    // Check duplicate active plate for this user
    const { data: existing } = await admin
      .from("vehicles")
      .select("id")
      .eq("user_id", user.id)
      .ilike("plate", plate.trim())
      .eq("is_active", true)
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        { error: "A vehicle with this license plate is already registered in your account." },
        { status: 409 }
      );
    }

    // Explicit field whitelist:
    // user_id is forced to user.id, is_active is true, public_token is generated via crypto.randomUUID()
    const publicToken = crypto.randomUUID();

    const { data: newVehicle, error: insertError } = await admin
      .from("vehicles")
      .insert({
        user_id: user.id,
        plate: plate.trim().toUpperCase(),
        brand: brand.trim(),
        model: model.trim(),
        year,
        is_active: true,
        public_token: publicToken,
      })
      .select()
      .single();

    if (insertError) {
      console.error("Insert vehicle error:", insertError);
      return NextResponse.json(
        { error: "Failed to save vehicle details." },
        { status: 500 }
      );
    }

    return NextResponse.json({ vehicle: newVehicle }, { status: 201 });
  } catch (err) {
    console.error("Vehicles POST error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
