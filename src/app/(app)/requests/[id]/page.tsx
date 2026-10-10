"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ServiceRequest } from "@/lib/types";
import { SERVICE_TYPE_LABELS } from "@/lib/constants";
import { formatDate } from "@/lib/utils";
import { StatusStepper } from "@/components/status-stepper";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/error-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { authFetch } from "@/lib/auth-fetch";
import { InspectionSection } from "@/components/inspection/inspection-section";
import {
  ArrowLeft,
  Car,
  Wrench,
  XCircle,
  FileText,
  Loader2,
  RotateCcw,
} from "lucide-react";

export default function RequestDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const [request, setRequest] = React.useState<ServiceRequest | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [isNotFound, setIsNotFound] = React.useState(false);
  const [userRole, setUserRole] = React.useState<"customer" | "mechanic" | null>(null);
  const [userId, setUserId] = React.useState<string | null>(null);
  const [imagesCount, setImagesCount] = React.useState<number | null>(null);

  const [isCancelling, setIsCancelling] = React.useState(false);
  const [isReleasing, setIsReleasing] = React.useState(false);
  const [showConfirmCancel, setShowConfirmCancel] = React.useState(false);
  const [showConfirmRelease, setShowConfirmRelease] = React.useState(false);
  const [actionNotice, setActionNotice] = React.useState<{ type: "success" | "error"; text: string } | null>(null);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    setIsNotFound(false);
    try {
      let activeRole = "customer";
      let activeUid: string | null = null;

      // 1. Fetch current user profile to determine role
      const profileRes = await authFetch("/api/user/profile");
      if (profileRes.status === 401) {
        router.push("/auth");
        return;
      }
      if (profileRes.ok) {
        const profileData = await profileRes.json();
        activeRole = profileData.profile?.role || "customer";
        activeUid = profileData.user?.id || null;
        setUserRole(activeRole as "customer" | "mechanic");
        setUserId(activeUid);
      }

      // 2. Fetch specific request details
      const res = await authFetch(`/api/requests/${id}`);
      if (res.status === 403 || res.status === 404) {
        setIsNotFound(true);
        setLoading(false);
        return;
      }

      if (!res.ok) {
        throw new Error("Unable to load service request details.");
      }

      const data = await res.json();
      setRequest(data.request);

      // If assigned mechanic in inspecting, fetch initial imagesCount to determine release eligibility
      if (
        activeRole === "mechanic" &&
        data.request?.status === "inspecting" &&
        data.request?.mechanic_id === activeUid
      ) {
        try {
          const imgRes = await authFetch(`/api/requests/${id}/images`);
          if (imgRes.ok) {
            const imgData = await imgRes.json();
            setImagesCount(imgData.images?.length ?? 0);
          }
        } catch {
          // synced by InspectionSection
        }
      }
    } catch (err) {
      console.error("Load request detail error:", err);
      setError("Unable to load service request details.");
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  React.useEffect(() => {
    if (id) loadData();
  }, [id, loadData]);

  async function handleConfirmCancel() {
    setIsCancelling(true);
    setActionNotice(null);
    try {
      const res = await authFetch(`/api/requests/${id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });

      const data = await res.json();

      if (!res.ok) {
        setActionNotice({
          type: "error",
          text: data.error || "Failed to cancel service request.",
        });
        setShowConfirmCancel(false);
        setIsCancelling(false);
        return;
      }

      setActionNotice({
        type: "success",
        text: "Service request cancelled successfully.",
      });
      setShowConfirmCancel(false);
      await loadData();
    } catch (err) {
      console.error("Cancel request error:", err);
      setActionNotice({
        type: "error",
        text: "An error occurred while cancelling the request.",
      });
      setShowConfirmCancel(false);
    } finally {
      setIsCancelling(false);
    }
  }

  async function handleConfirmRelease() {
    setIsReleasing(true);
    setActionNotice(null);
    try {
      const res = await authFetch(`/api/requests/${id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "release" }),
      });

      const data = await res.json();

      if (!res.ok) {
        setActionNotice({
          type: "error",
          text: data.error || "Failed to release job.",
        });
        setShowConfirmRelease(false);
        setIsReleasing(false);
        return;
      }

      setActionNotice({
        type: "success",
        text: "Job released back to queue successfully.",
      });
      setShowConfirmRelease(false);
      await loadData();
    } catch (err) {
      console.error("Release job error:", err);
      setActionNotice({
        type: "error",
        text: "An error occurred while releasing the job.",
      });
      setShowConfirmRelease(false);
    } finally {
      setIsReleasing(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto py-12 flex flex-col items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        <span className="text-xs text-gray-500 mt-2">Loading service request...</span>
      </div>
    );
  }

  // 403 or 404: Render plain "Not found" page with back link, no Try again button, no empty form
  if (isNotFound) {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to dashboard</span>
        </Link>
        <div className="py-12 text-center space-y-2">
          <h1 className="text-lg font-semibold text-gray-900">Not found</h1>
          <p className="text-xs text-gray-500">The requested resource could not be found.</p>
        </div>
      </div>
    );
  }

  // 5xx or Network error: Render with Retry button
  if (error || !request) {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to dashboard</span>
        </Link>
        <ErrorState message={error || "Service request not found."} onRetry={loadData} />
      </div>
    );
  }

  const vehicle = request.vehicle;
  const serviceLabel = SERVICE_TYPE_LABELS[request.service_type] || request.service_type;
  const isMechanic = userRole === "mechanic";
  const isAssignedMechanic = isMechanic && request.mechanic_id === userId;
  const canCancel = !isMechanic && ["booked", "inspecting", "awaiting_approval"].includes(request.status);
  const canRelease =
    isAssignedMechanic && request.status === "inspecting" && imagesCount === 0;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Inline Action Message */}
      {actionNotice && (
        <div
          className={`p-3.5 rounded-lg border text-xs flex items-center justify-between ${
            actionNotice.type === "success"
              ? "bg-green-50 border-green-200 text-green-800"
              : "bg-red-50 border-red-200 text-red-800"
          }`}
          role="status"
        >
          <span>{actionNotice.text}</span>
          <button
            onClick={() => setActionNotice(null)}
            className="text-gray-500 hover:text-gray-900 ml-4 font-bold"
            aria-label="Dismiss message"
          >
            ×
          </button>
        </div>
      )}

      {/* Back button and actions */}
      <div className="flex items-center justify-between">
        <Link
          href={isMechanic ? "/mechanic/queue" : "/dashboard"}
          className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>{isMechanic ? "Back to queue" : "Back to dashboard"}</span>
        </Link>

        {canCancel && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowConfirmCancel(true)}
            className="text-xs text-red-600 hover:text-red-700 hover:bg-red-50 gap-1"
          >
            <XCircle className="w-3.5 h-3.5" />
            <span>Cancel service</span>
          </Button>
        )}

        {canRelease && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowConfirmRelease(true)}
            className="text-xs text-amber-700 hover:text-amber-800 hover:bg-amber-50 gap-1"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Release job</span>
          </Button>
        )}
      </div>

      <ConfirmDialog
        isOpen={showConfirmCancel}
        title="Cancel Service Request"
        description="Are you sure you want to cancel this service request? This action cannot be undone."
        confirmLabel="Yes, cancel request"
        cancelLabel="Keep booking"
        variant="danger"
        isLoading={isCancelling}
        onConfirm={handleConfirmCancel}
        onCancel={() => setShowConfirmCancel(false)}
      />

      <ConfirmDialog
        isOpen={showConfirmRelease}
        title="Release Job to Queue"
        description="Release this job back to the open queue? Another mechanic will be able to claim it."
        confirmLabel="Yes, release job"
        cancelLabel="Keep job"
        variant="primary"
        isLoading={isReleasing}
        onConfirm={handleConfirmRelease}
        onCancel={() => setShowConfirmRelease(false)}
      />

      {/* Main card */}
      <Card className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 pb-4 border-b border-gray-100">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-gray-900">{serviceLabel}</h1>
              <Badge variant={request.status === "cancelled" ? "danger" : "active"}>
                {request.status.replace("_", " ")}
              </Badge>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Booking ID: <span className="font-mono text-gray-700">{request.id}</span>
            </p>
          </div>

          <div className="text-left sm:text-right text-xs text-gray-500">
            <p>Booked on {formatDate(request.created_at)}</p>
            <p className="font-medium text-gray-700 mt-0.5">
              Preferred: {formatDate(request.preferred_date)}
            </p>
          </div>
        </div>

        {/* 5-Step Progress Stepper */}
        <div className="py-2">
          <StatusStepper currentStatus={request.status} />
        </div>

        {/* Stage Status Description */}
        <div className="p-3.5 rounded-lg border border-gray-200 bg-gray-50/70 text-xs text-gray-700">
          {isMechanic ? (
            <>
              {request.status === "booked" && (
                <p>
                  <strong className="text-gray-900">Unassigned ticket.</strong> This job is waiting in the open queue for a mechanic to claim.
                </p>
              )}
              {request.status === "inspecting" && (
                <p>
                  <strong className="text-gray-900">Vehicle in inspection.</strong> Document vehicle condition and estimate required repair items.
                </p>
              )}
              {request.status === "awaiting_approval" && (
                <p>
                  <strong className="text-gray-900">Awaiting customer authorization.</strong> Inspection findings submitted. Waiting for customer approval.
                </p>
              )}
              {request.status === "repairing" && (
                <p>
                  <strong className="text-gray-900">Repairs authorized.</strong> Perform repairs and capture completion verification photos.
                </p>
              )}
              {request.status === "done" && (
                <p>
                  <strong className="text-gray-900">Service completed.</strong> All approved repair work is finalized and documented.
                </p>
              )}
              {request.status === "cancelled" && (
                <p className="text-red-700">
                  <strong className="text-red-900">Service cancelled.</strong> This request was cancelled by the customer.
                </p>
              )}
            </>
          ) : (
            <>
              {request.status === "booked" && (
                <p>
                  <strong className="text-gray-900">Service booked.</strong> Your appointment is registered. A certified technician will claim the ticket and begin vehicle inspection.
                </p>
              )}
              {request.status === "inspecting" && (
                <p>
                  <strong className="text-gray-900">Inspection in progress.</strong> The mechanic is reviewing the vehicle, dropping pin coordinates on inspection photos, and estimating repair costs.
                </p>
              )}
              {request.status === "awaiting_approval" && (
                <p>
                  <strong className="text-gray-900">Inspection report ready.</strong> The mechanic has submitted findings. Please review each repair item and make your approval decisions.
                </p>
              )}
              {request.status === "repairing" && (
                <p>
                  <strong className="text-gray-900">Repairs authorized.</strong> Mechanic is completing work on all approved repair items.
                </p>
              )}
              {request.status === "done" && (
                <p>
                  <strong className="text-gray-900">Service completed.</strong> All approved repair items have verified proof-of-repair photos and inspection records.
                </p>
              )}
              {request.status === "cancelled" && (
                <p className="text-red-700">
                  <strong className="text-red-900">Service cancelled.</strong> This request was cancelled before repairs started.
                </p>
              )}
            </>
          )}
        </div>

        {/* Vehicle & Request details */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
          {/* Vehicle info */}
          <div className="p-4 rounded-lg border border-gray-200 bg-white">
            <div className="flex items-center gap-2 text-xs font-semibold text-gray-900 mb-2">
              <Car className="w-4 h-4 text-gray-500" />
              <span>Vehicle Specifications</span>
            </div>
            {vehicle ? (
              <dl className="space-y-1 text-xs">
                <div className="flex justify-between">
                  <dt className="text-gray-500">Make & Model:</dt>
                  <dd className="font-medium text-gray-900">
                    {vehicle.brand} {vehicle.model}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Year:</dt>
                  <dd className="font-medium text-gray-900">{vehicle.year}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">License Plate:</dt>
                  <dd className="font-mono font-medium text-gray-900">{vehicle.plate}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-xs text-gray-500">Vehicle details unavailable.</p>
            )}
          </div>

          {/* Mechanic Assignment */}
          <div className="p-4 rounded-lg border border-gray-200 bg-white">
            <div className="flex items-center gap-2 text-xs font-semibold text-gray-900 mb-2">
              <Wrench className="w-4 h-4 text-gray-500" />
              <span>Assigned Technician</span>
            </div>
            {request.mechanic?.name || request.mechanic_name || (request.mechanic_id && isMechanic) ? (
              <div className="text-xs space-y-1">
                <p className="font-medium text-gray-900">
                  {request.mechanic?.name || request.mechanic_name || "Mechanic Assigned"}
                </p>
                <p className="text-gray-500">Certified Technician</p>
                <p className="text-emerald-700 text-[11px] font-medium">Assigned & active</p>
              </div>
            ) : (
              <div className="text-xs space-y-1 text-gray-500">
                <p className="text-amber-700 font-medium">Pending assignment</p>
                <p>Waiting for the next available mechanic in queue.</p>
              </div>
            )}
          </div>
        </div>

        {/* Customer complaint */}
        <div className="pt-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-gray-900 mb-1.5">
            <FileText className="w-4 h-4 text-gray-500" />
            <span>Reported Symptoms & Notes</span>
          </div>
          <div className="p-3.5 rounded-lg border border-gray-200 bg-white text-xs text-gray-800 leading-relaxed whitespace-pre-wrap">
            {request.complaint}
          </div>
        </div>

        {/* Phase 2: Inspection Section */}
        {request.status !== "cancelled" && (
          <div className="pt-4 border-t border-gray-100">
            <InspectionSection
              requestId={request.id}
              status={request.status}
              userRole={userRole || "customer"}
              isAssignedMechanic={isAssignedMechanic}
              onRequestUpdated={loadData}
              onImagesCountChange={(count) => setImagesCount(count)}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
