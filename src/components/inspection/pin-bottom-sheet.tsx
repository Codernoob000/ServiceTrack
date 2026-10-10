"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PinWithItem, Severity } from "@/lib/types";
import { Loader2, Trash2, X } from "lucide-react";

interface PinBottomSheetProps {
  isOpen: boolean;
  pinNumber?: number;
  initialPin?: PinWithItem | null;
  coordinates?: { x: number; y: number } | null;
  onSave: (data: {
    part_name: string;
    severity: Severity;
    notes?: string;
    description: string;
    estimate: number;
  }) => Promise<void>;
  onDelete?: (pinId: string) => Promise<void>;
  onClose: () => void;
}

const SEVERITY_OPTIONS: {
  value: Severity;
  label: string;
  dotColor: string;
  badgeBg: string;
  badgeBorder: string;
}[] = [
  {
    value: "low",
    label: "Low",
    dotColor: "bg-emerald-600",
    badgeBg: "bg-emerald-50 text-emerald-800",
    badgeBorder: "border-emerald-300",
  },
  {
    value: "medium",
    label: "Medium",
    dotColor: "bg-amber-600",
    badgeBg: "bg-amber-50 text-amber-800",
    badgeBorder: "border-amber-300",
  },
  {
    value: "high",
    label: "High",
    dotColor: "bg-red-600",
    badgeBg: "bg-red-50 text-red-800",
    badgeBorder: "border-red-300",
  },
  {
    value: "critical",
    label: "Critical",
    dotColor: "bg-rose-800",
    badgeBg: "bg-rose-50 text-rose-900",
    badgeBorder: "border-rose-300",
  },
];

export function PinBottomSheet({
  isOpen,
  pinNumber,
  initialPin,
  coordinates,
  onSave,
  onDelete,
  onClose,
}: PinBottomSheetProps) {
  const [partName, setPartName] = React.useState("");
  const [severity, setSeverity] = React.useState<Severity>("medium");
  const [notes, setNotes] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [estimate, setEstimate] = React.useState<string>("");
  const [isSaving, setIsSaving] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (initialPin) {
      setPartName(initialPin.part_name || "");
      setSeverity(initialPin.severity || "medium");
      setNotes(initialPin.notes || "");
      setDescription(initialPin.repair_item?.description || "");
      setEstimate(
        initialPin.repair_item?.estimate !== undefined
          ? String(initialPin.repair_item.estimate)
          : ""
      );
    } else {
      setPartName("");
      setSeverity("medium");
      setNotes("");
      setDescription("");
      setEstimate("");
    }
    setError(null);
  }, [initialPin, isOpen]);

  if (!isOpen) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmedPartName = partName.trim();
    if (!trimmedPartName) {
      setError("Part name is required.");
      return;
    }

    const trimmedDescription = description.trim();
    if (!trimmedDescription) {
      setError("Repair description is required.");
      return;
    }

    const parsedEstimate = parseInt(estimate.trim(), 10);
    if (isNaN(parsedEstimate) || parsedEstimate < 0) {
      setError("Please enter a valid estimate in rupees (0 or greater).");
      return;
    }

    setIsSaving(true);
    try {
      await onSave({
        part_name: trimmedPartName,
        severity,
        notes: notes.trim() || undefined,
        description: trimmedDescription,
        estimate: parsedEstimate,
      });
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to save defect pin.";
      setError(msg);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    if (!initialPin || !onDelete) return;
    setIsDeleting(true);
    setError(null);
    try {
      await onDelete(initialPin.id);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete pin.";
      setError(msg);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4 transition-opacity"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pin-sheet-title"
    >
      <div className="w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-xl shadow-xl max-h-[90vh] flex flex-col overflow-hidden border border-gray-200">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 bg-gray-50/50">
          <div className="flex items-center gap-2">
            {pinNumber && (
              <span className="w-6 h-6 rounded-full bg-[#2563eb] text-white text-xs font-bold flex items-center justify-center">
                {pinNumber}
              </span>
            )}
            <h2 id="pin-sheet-title" className="text-sm font-bold text-gray-900">
              {initialPin ? `Edit Defect Pin #${pinNumber}` : "New Defect Pin"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="touch-target p-2 text-gray-500 hover:text-gray-900 rounded-lg hover:bg-gray-100 flex items-center justify-center"
            aria-label="Close dialog"
            disabled={isSaving || isDeleting}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Form */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4 overflow-y-auto">
          {error && (
            <div
              className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800"
              role="alert"
            >
              {error}
            </div>
          )}

          {/* Part Name */}
          <div className="space-y-1.5">
            <Label htmlFor="part-name" className="text-xs font-semibold text-gray-900">
              Part Name *
            </Label>
            <Input
              id="part-name"
              type="text"
              required
              placeholder="e.g. Front Bumper, Brake Pad, Radiator"
              value={partName}
              onChange={(e) => setPartName(e.target.value)}
              className="touch-target text-xs"
              disabled={isSaving || isDeleting}
            />
          </div>

          {/* Severity (Color AND text label) */}
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-gray-900">Severity *</Label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {SEVERITY_OPTIONS.map((opt) => {
                const isSelected = severity === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setSeverity(opt.value)}
                    disabled={isSaving || isDeleting}
                    className={`touch-target flex items-center justify-center gap-2 p-2 rounded-lg border text-xs font-medium transition-all ${
                      isSelected
                        ? `${opt.badgeBg} ${opt.badgeBorder} ring-2 ring-[#2563eb] ring-offset-1`
                        : "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    <span className={`w-2.5 h-2.5 rounded-full ${opt.dotColor}`} />
                    <span>{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Repair Description */}
          <div className="space-y-1.5">
            <Label htmlFor="repair-desc" className="text-xs font-semibold text-gray-900">
              Repair Description *
            </Label>
            <textarea
              id="repair-desc"
              rows={2}
              required
              placeholder="Detailed description of required repair work"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-xs text-gray-900 placeholder:text-gray-400 focus-visible:outline-2 focus-visible:outline-[#2563eb] disabled:bg-gray-50"
              disabled={isSaving || isDeleting}
            />
          </div>

          {/* Estimate in Rupees */}
          <div className="space-y-1.5">
            <Label htmlFor="estimate-cost" className="text-xs font-semibold text-gray-900">
              Estimate (₹) *
            </Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-semibold text-xs">
                ₹
              </span>
              <Input
                id="estimate-cost"
                type="number"
                min="0"
                step="1"
                required
                placeholder="2500"
                value={estimate}
                onChange={(e) => setEstimate(e.target.value)}
                className="pl-7 touch-target text-xs font-medium"
                disabled={isSaving || isDeleting}
              />
            </div>
          </div>

          {/* Notes (Optional) */}
          <div className="space-y-1.5">
            <Label htmlFor="pin-notes" className="text-xs font-semibold text-gray-900">
              Notes (Optional)
            </Label>
            <textarea
              id="pin-notes"
              rows={2}
              placeholder="Internal mechanic observations"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-xs text-gray-900 placeholder:text-gray-400 focus-visible:outline-2 focus-visible:outline-[#2563eb] disabled:bg-gray-50"
              disabled={isSaving || isDeleting}
            />
          </div>

          {/* Footer Action Buttons */}
          <div className="pt-2 flex flex-col sm:flex-row gap-2 border-t border-gray-200">
            {initialPin && onDelete && (
              <Button
                type="button"
                variant="outline"
                onClick={handleDelete}
                disabled={isSaving || isDeleting}
                className="touch-target border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 flex items-center justify-center gap-1.5 text-xs font-medium"
              >
                {isDeleting ? (
                  <Loader2 className="w-4 h-4 animate-spin text-red-600" />
                ) : (
                  <Trash2 className="w-4 h-4 text-red-600" />
                )}
                <span>Delete Pin</span>
              </Button>
            )}

            <div className="flex-1 flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={isSaving || isDeleting}
                className="flex-1 touch-target text-xs text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </Button>

              <Button
                type="submit"
                disabled={isSaving || isDeleting}
                className="flex-1 touch-target bg-[#2563eb] hover:bg-blue-700 text-white text-xs font-semibold flex items-center justify-center gap-1.5"
              >
                {isSaving && <Loader2 className="w-4 h-4 animate-spin text-white" />}
                <span>{initialPin ? "Update Pin" : "Save Pin"}</span>
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
