import * as React from "react";
import { Check, XCircle } from "lucide-react";
import { RequestStatus } from "@/lib/types";
import { STATUS_STEPS, STATUS_ORDER } from "@/lib/constants";
import { cn } from "@/lib/utils";

interface StatusStepperProps {
  currentStatus: RequestStatus;
  className?: string;
  compact?: boolean;
}

export function StatusStepper({ currentStatus, className, compact = false }: StatusStepperProps) {
  if (currentStatus === "cancelled") {
    return (
      <div
        className={cn(
          "flex items-center gap-2 p-3 rounded-lg border border-red-200 bg-red-50 text-red-800 text-sm",
          className
        )}
        role="status"
        aria-label="Service status: Cancelled"
      >
        <XCircle className="w-4 h-4 shrink-0 text-red-600" />
        <span className="font-medium">Service cancelled.</span>
        <span className="text-red-600 text-xs">Work was stopped before repairing.</span>
      </div>
    );
  }

  const currentIndex = STATUS_ORDER[currentStatus] ?? 0;

  return (
    <div className={cn("w-full py-2", className)} aria-label="Service progress stepper">
      <ol className="flex items-center justify-between w-full relative">
        {STATUS_STEPS.map((step, idx) => {
          const isCompleted = idx < currentIndex;
          const isCurrent = idx === currentIndex;
          const isUpcoming = idx > currentIndex;

          return (
            <li
              key={step.key}
              className="flex-1 flex flex-col items-center relative group text-center"
              aria-current={isCurrent ? "step" : undefined}
            >
              {/* Connector line between steps */}
              {idx > 0 && (
                <div
                  className={cn(
                    "absolute top-3.5 right-1/2 left-[-50%] h-[2px] -z-0",
                    idx <= currentIndex ? "bg-[#2563eb]" : "bg-gray-200"
                  )}
                  aria-hidden="true"
                />
              )}

              {/* Step indicator circle */}
              <div
                className={cn(
                  "relative z-10 flex items-center justify-center rounded-full border transition-colors select-none",
                  compact ? "w-6 h-6 text-[10px]" : "w-7 h-7 text-xs font-semibold",
                  isCompleted && "bg-gray-900 border-gray-900 text-white",
                  isCurrent && "bg-[#2563eb] border-[#2563eb] text-white ring-4 ring-blue-50",
                  isUpcoming && "bg-white border-gray-300 text-gray-500"
                )}
              >
                {isCompleted ? (
                  <Check className={compact ? "w-3 h-3" : "w-3.5 h-3.5"} strokeWidth={3} />
                ) : (
                  <span>{idx + 1}</span>
                )}
              </div>

              {/* Step text */}
              <div className="mt-2 flex flex-col items-center">
                <span
                  className={cn(
                    "text-xs font-medium leading-tight",
                    isCurrent && "text-[#2563eb] font-semibold",
                    isCompleted && "text-gray-900",
                    isUpcoming && "text-gray-400"
                  )}
                >
                  {step.label}
                </span>
                {!compact && isCurrent && (
                  <span className="text-[10px] text-gray-500 mt-0.5">Current stage</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
