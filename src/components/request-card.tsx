"use client";

import * as React from "react";
import Link from "next/link";
import { ServiceRequest } from "@/lib/types";
import { SERVICE_TYPE_LABELS } from "@/lib/constants";
import { formatDate } from "@/lib/utils";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { StatusStepper } from "./status-stepper";
import { Calendar, ChevronRight, Wrench } from "lucide-react";

interface RequestCardProps {
  request: ServiceRequest;
  role?: "customer" | "mechanic";
  onClaim?: (id: string) => void;
  isClaiming?: boolean;
}

export function RequestCard({
  request,
  role = "customer",
  onClaim,
  isClaiming,
}: RequestCardProps) {
  const serviceLabel = SERVICE_TYPE_LABELS[request.service_type] || request.service_type;
  const vehicle = request.vehicle;

  return (
    <Card className="hover:border-gray-300 transition-colors">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-gray-100">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-gray-900">{serviceLabel}</span>
            {vehicle && (
              <span className="font-mono text-xs px-2 py-0.5 rounded border border-gray-200 bg-gray-50 text-gray-800">
                {vehicle.plate}
              </span>
            )}
          </div>
          {vehicle && (
            <p className="text-xs text-gray-500 mt-0.5">
              {vehicle.year} {vehicle.brand} {vehicle.model}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 text-xs text-gray-500">
          <div className="flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5 text-gray-400" />
            <span>Target: {formatDate(request.preferred_date)}</span>
          </div>
        </div>
      </div>

      {/* Stepper display */}
      <div className="py-4">
        <StatusStepper currentStatus={request.status} compact />
      </div>

      {/* Complaint excerpt & actions */}
      <div className="pt-3 border-t border-gray-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <p className="text-xs text-gray-600 line-clamp-1 italic max-w-md">
          &ldquo;{request.complaint}&rdquo;
        </p>

        <div className="flex items-center gap-2 self-end sm:self-auto">
          {role === "mechanic" && !request.mechanic_id && request.status === "booked" && onClaim ? (
            <Button
              variant="primary"
              size="sm"
              isLoading={isClaiming}
              onClick={() => onClaim(request.id)}
              className="gap-1.5 text-xs"
            >
              <Wrench className="w-3.5 h-3.5" />
              Claim this job
            </Button>
          ) : null}

          <Link href={`/requests/${request.id}`}>
            <Button variant="outline" size="sm" className="gap-1 text-xs">
              <span>View details</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </Link>
        </div>
      </div>
    </Card>
  );
}
