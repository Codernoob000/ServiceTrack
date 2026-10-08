"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ServiceRequest } from "@/lib/types";
import { SERVICE_TYPE_LABELS } from "@/lib/constants";
import { formatDate } from "@/lib/utils";
import { StatusStepper } from "@/components/status-stepper";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/error-state";
import {
  ArrowLeft,
  Calendar,
  Car,
  Wrench,
  Clock,
  AlertCircle,
  XCircle,
  FileText,
  Loader2,
} from "lucide-react";

export default function RequestDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const [request, setRequest] = React.useState<ServiceRequest | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [isCancelling, setIsCancelling] = React.useState(false);

  const loadRequest = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/requests");
      if (!res.ok) throw new Error("Failed to load requests.");
      const data = await res.json();
      const match = (data.requests || []).find((r: ServiceRequest) => r.id === id);

      if (!match) {
        throw new Error("Service request not found or access denied.");
      }

      setRequest(match);
    } catch (err) {
      console.error("Load request detail error:", err);
      setError("Unable to load service request details.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    if (id) loadRequest();
  }, [id, loadRequest]);

  async function handleCancel() {
    if (!confirm("Are you sure you want to cancel this service request? This action cannot be undone.")) {
      return;
    }

    setIsCancelling(true);
    try {
      const res = await fetch(`/api/requests/${id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.error || "Failed to cancel service request.");
        setIsCancelling(false);
        return;
      }

      await loadRequest();
    } catch (err) {
      console.error("Cancel request error:", err);
      alert("An error occurred while cancelling the request.");
    } finally {
      setIsCancelling(false);
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
        <ErrorState message={error || "Service request not found."} onRetry={loadRequest} />
      </div>
    );
  }

  const vehicle = request.vehicle;
  const serviceLabel = SERVICE_TYPE_LABELS[request.service_type] || request.service_type;
  const canCancel = ["booked", "inspecting", "awaiting_approval"].includes(request.status);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Back button */}
      <div className="flex items-center justify-between">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to dashboard</span>
        </Link>

        {canCancel && (
          <Button
            variant="ghost"
            size="sm"
            isLoading={isCancelling}
            onClick={handleCancel}
            className="text-xs text-red-600 hover:text-red-700 hover:bg-red-50 gap-1"
          >
            <XCircle className="w-3.5 h-3.5" />
            <span>Cancel service</span>
          </Button>
        )}
      </div>

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
            {request.mechanic_id ? (
              <div className="text-xs space-y-1">
                <p className="font-medium text-gray-900">Mechanic Assigned</p>
                <p className="text-gray-500">
                  Technician ID: <span className="font-mono">{request.mechanic_id.slice(0, 8)}...</span>
                </p>
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
      </Card>
    </div>
  );
}
