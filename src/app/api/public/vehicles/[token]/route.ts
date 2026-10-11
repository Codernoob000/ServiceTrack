import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { fetchPublicVehicleHistory } from "@/lib/public-history";

interface RouteParams {
  params: Promise<{ token: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    // 1. Rate limit per IP
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown-ip";

    const rateLimit = await checkRateLimit(`pub_veh:${ip}`, 60, 60);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        {
          status: 429,
          headers: {
            "Cache-Control": "no-store",
          },
        }
      );
    }

    const { token } = await params;

    // 2. Fetch history (handles token UUID validation and SQL query)
    const history = await fetchPublicVehicleHistory(token);

    if (!history) {
      return NextResponse.json(
        { error: "Vehicle not found." },
        {
          status: 404,
          headers: {
            "Cache-Control": "no-store",
          },
        }
      );
    }

    // 3. Return ONLY whitelisted fields
    return NextResponse.json(
      {
        brand: history.brand,
        model: history.model,
        year: history.year,
        masked_plate: history.masked_plate,
        repairs: history.repairs,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (err) {
    console.error("Public vehicle history GET error:", err);
    return NextResponse.json(
      { error: "Vehicle not found." },
      {
        status: 404,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }
}
