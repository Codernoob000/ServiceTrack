"use client";

import * as React from "react";
import { Button } from "./button";
import { AlertCircle } from "lucide-react";

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "primary";
  isLoading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "danger",
  isLoading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div className="bg-white rounded-xl border border-gray-200 shadow-xl max-w-sm w-full p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-full bg-red-100 text-red-600 shrink-0 mt-0.5">
            <AlertCircle className="w-4 h-4" />
          </div>
          <div className="space-y-1">
            <h3 id="confirm-dialog-title" className="text-sm font-semibold text-gray-900">
              {title}
            </h3>
            <p className="text-xs text-gray-600 leading-relaxed">
              {description}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100">
          <Button
            variant="outline"
            size="sm"
            disabled={isLoading}
            onClick={onCancel}
            className="text-xs"
          >
            {cancelLabel}
          </Button>
          <Button
            variant="primary"
            size="sm"
            isLoading={isLoading}
            onClick={onConfirm}
            className={`text-xs ${
              variant === "danger"
                ? "bg-red-600 hover:bg-red-700 text-white border-transparent"
                : ""
            }`}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
