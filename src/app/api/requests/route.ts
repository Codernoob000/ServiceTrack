import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { requestCreateSchema } from "@/lib/validation";
import { getServiceRoleClient } from "@/lib/supabase/admin";

export async function GET(request: NextRequest) {
  try {
    const { user, profile, error: authError } = await getAuthenticatedUser();
    if (authError || !user || !profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const filter = searchParams.get("filter"); // e.g. "open" or "assigned" for mechanics
    const admin = getServiceRoleClient();

    if (profile.role === "customer") {
      // 1. Fetch user's vehicle IDs
      const { data: userVehicles } = await admin
        .from("vehicles")
        .select("id")
        .eq("user_id", user.id);

      const vehicleIds = (userVehicles || []).map((v) => v.id);

      if (vehicleIds.length === 0) {
        return NextResponse.json({ requests: [] });
      }

      // 2. Fetch requests for those vehicles
      const { data: requests, error } = await admin
        .from("requests")
        .select(`
          *,
          vehicle:vehicles(*)
        `)
        .in("vehicle_id", vehicleIds)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Customer requests fetch error:", error);
        return NextResponse.json({ error: "Failed to load requests." }, { status: 500 });
      }

      // Customers must never see the mechanic's user ID
      const sanitizedRequests = (requests || []).map((r) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { mechanic_id, ...rest } = r;
        return rest;
      });

      return NextResponse.json({ requests: sanitizedRequests });
    } else {
      // Mechanic role
      let query = admin
        .from("requests")
        .select(`
          *,
          vehicle:vehicles(*)
        `);

      if (filter === "open") {
        query = query.is("mechanic_id", null).eq("status", "booked");
      } else if (filter === "assigned") {
        query = query.eq("mechanic_id", user.id);
      } else {
        query = query.or(`mechanic_id.eq.${user.id},and(mechanic_id.is.null,status.eq.booked)`);
      }

      const { data: requests, error } = await query.order("created_at", { ascending: false });

      if (error) {
        console.error("Mechanic requests fetch error:", error);
        return NextResponse.json({ error: "Failed to load requests." }, { status: 500 });
      }

      return NextResponse.json({ requests });
    }
  } catch (err) {
    console.error("Requests GET error:", err);
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
      return NextResponse.json({ error: "Only customers can book service requests." }, { status: 403 });
    }

    const body = await request.json();
    const parsed = requestCreateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid booking request details." }, { status: 400 });
    }

    const { vehicle_id, service_type, complaint, preferred_date } = parsed.data;
    const admin = getServiceRoleClient();

    // Verify vehicle belongs to user and is active
    const { data: vehicle, error: vehicleError } = await admin
      .from("vehicles")
      .select("id, user_id, is_active")
      .eq("id", vehicle_id)
      .maybeSingle();

    if (vehicleError || !vehicle) {
      return NextResponse.json({ error: "Vehicle not found." }, { status: 404 });
    }

    if (vehicle.user_id !== user.id) {
      return NextResponse.json({ error: "Forbidden: You do not own this vehicle." }, { status: 403 });
    }

    if (!vehicle.is_active) {
      return NextResponse.json({ error: "Cannot book a service for an archived vehicle." }, { status: 400 });
    }

    // Insert new request with initial status 'booked'
    const { data: newRequest, error: insertError } = await admin
      .from("requests")
      .insert({
        vehicle_id,
        service_type,
        complaint: complaint.trim(),
        preferred_date,
        status: "booked",
        mechanic_id: null,
      })
      .select(`
        *,
        vehicle:vehicles(*)
      `)
      .single();

    if (insertError) {
      console.error("Request booking insert error:", insertError);
      return NextResponse.json({ error: "Failed to book service." }, { status: 500 });
    }

    return NextResponse.json({ request: newRequest }, { status: 201 });
  } catch (err) {
    console.error("Requests POST error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
