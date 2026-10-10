import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { getServiceRoleClient } from "@/lib/supabase/admin";
import { submitDecisionsSchema } from "@/lib/validation";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/requests/[id]/decisions
 * Submits customer approval/rejection decisions for all repair items on an inspection report.
 * - Authenticated vehicle owner only (enforced via submit_decisions RPC)
 * - Request status must be 'awaiting_approval'
 * - p_caller_id is strictly user.id (never a body value)
 * - Client-sent totals are ignored; approved total is strictly computed in SQL
 * - Atomic state transition:
 *   - At least 1 item approved -> request status becomes 'repairing'
 *   - All items rejected -> request status becomes 'done'
 *
 * Error code mapping:
 * - P0002 -> 404 (Request not found)
 * - P0003 -> 403 (Forbidden: Caller is not the vehicle owner)
 * - P0004 -> 409 (Conflict: Request status is not awaiting_approval)
 * - P0005 -> 400 (Bad Request: Incomplete, duplicate, or invalid decisions)
 * - P0009 -> 409 (Conflict: Repair item has already been decided)
 * - P0001 -> 409 (Conflict: Status locked / cannot modify approval status)
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const { user, profile, error: authError } = await getAuthenticatedUser();
    if (authError || !user || !profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const parsed = submitDecisionsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid decisions payload.", details: parsed.error.issues },
        { status: 400 }
      );
    }

    const admin = getServiceRoleClient();

    // Call atomic SQL function submit_decisions with authenticated user ID as p_caller_id
    const { data: result, error: rpcError } = await admin.rpc("submit_decisions", {
      p_request_id: id,
      p_caller_id: user.id,
      p_decisions: parsed.data.decisions,
    });

    if (rpcError) {
      const code = rpcError.code;
      const msg = rpcError.message || "";

      if (code === "P0002") {
        return NextResponse.json({ error: "Request not found." }, { status: 404 });
      }
      if (code === "P0003") {
        return NextResponse.json(
          { error: "Forbidden: Only the vehicle owner can submit repair decisions." },
          { status: 403 }
        );
      }
      if (code === "P0004") {
        return NextResponse.json(
          { error: "Conflict: Request is not in awaiting approval status." },
          { status: 409 }
        );
      }
      if (code === "P0005" || code === "23514") {
        return NextResponse.json(
          { error: msg || "Bad Request: Incomplete or invalid decisions payload." },
          { status: 400 }
        );
      }
      if (code === "P0009") {
        return NextResponse.json(
          { error: "Conflict: Repair item has already been decided." },
          { status: 409 }
        );
      }
      if (code === "P0001") {
        return NextResponse.json(
          { error: "Conflict: Cannot modify approval status for this request." },
          { status: 409 }
        );
      }

      console.error("submit_decisions RPC error:", rpcError);
      return NextResponse.json({ error: "Failed to submit decisions." }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      ...result,
      result,
    });
  } catch (err) {
    console.error("Decisions route error:", err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
