"use client";

import * as React from "react";
import { authFetch } from "@/lib/auth-fetch";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  QrCode,
  Copy,
  Check,
  Printer,
  RotateCcw,
  Loader2,
  AlertCircle,
  ExternalLink,
} from "lucide-react";

interface VehiclePublicLinkSectionProps {
  vehicleId: string;
  plate: string;
}

export function VehiclePublicLinkSection({
  vehicleId,
  plate,
}: VehiclePublicLinkSectionProps) {
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [publicUrl, setPublicUrl] = React.useState("");
  const [enabled, setEnabled] = React.useState(true);
  const [qrCodeSvg, setQrCodeSvg] = React.useState("");

  const [copied, setCopied] = React.useState(false);
  const [isToggling, setIsToggling] = React.useState(false);
  const [isRotating, setIsRotating] = React.useState(false);
  const [showConfirmRotate, setShowConfirmRotate] = React.useState(false);

  const loadLinkData = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await authFetch(`/api/vehicles/${vehicleId}/public-link`);
      if (!res.ok) {
        throw new Error("Unable to load public service link.");
      }
      const data = await res.json();
      setPublicUrl(data.public_url || "");
      setEnabled(Boolean(data.enabled));
      setQrCodeSvg(data.qr_code || "");
    } catch (err) {
      console.error("Load public link error:", err);
      setError("Unable to load public link details.");
    } finally {
      setIsLoading(false);
    }
  }, [vehicleId]);

  React.useEffect(() => {
    loadLinkData();
  }, [loadLinkData]);

  const handleCopy = async () => {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const handleToggleEnabled = async () => {
    setIsToggling(true);
    try {
      const nextEnabled = !enabled;
      const res = await authFetch(`/api/vehicles/${vehicleId}/public-link/enabled`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled }),
      });

      if (!res.ok) {
        throw new Error("Failed to update link status.");
      }

      setEnabled(nextEnabled);
    } catch (err) {
      console.error("Toggle enabled error:", err);
      alert("Failed to update link setting. Please try again.");
    } finally {
      setIsToggling(false);
    }
  };

  const handleRotateConfirm = async () => {
    setIsRotating(true);
    try {
      const res = await authFetch(`/api/vehicles/${vehicleId}/public-link/rotate`, {
        method: "POST",
      });

      if (!res.ok) {
        throw new Error("Failed to rotate link.");
      }

      const data = await res.json();
      setPublicUrl(data.public_url || "");
      setQrCodeSvg(data.qr_code || "");
      setShowConfirmRotate(false);
    } catch (err) {
      console.error("Rotate link error:", err);
      alert("Failed to rotate service link. Please try again.");
    } finally {
      setIsRotating(false);
    }
  };

  if (isLoading) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6 flex items-center justify-center min-h-[220px]">
        <div className="flex flex-col items-center gap-2 text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
          <span className="text-xs">Loading service history link...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6 text-center">
        <div className="w-10 h-10 rounded-full bg-red-50 text-red-600 flex items-center justify-center mx-auto mb-2">
          <AlertCircle className="w-5 h-5" />
        </div>
        <p className="text-sm font-semibold text-gray-900 mb-1">Link Information Unavailable</p>
        <p className="text-xs text-gray-500 mb-4">{error}</p>
        <Button variant="outline" size="sm" onClick={loadLinkData} className="min-h-[44px]">
          Try again
        </Button>
      </div>
    );
  }

  return (
    <>
      <section
        aria-labelledby="service-history-link-heading"
        className="bg-white rounded-xl border border-gray-200 p-6 shadow-xs space-y-6"
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-gray-100">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-blue-600 mb-1">
              <QrCode className="w-4 h-4" />
              <span>Verified Service Record</span>
            </div>
            <h2 id="service-history-link-heading" className="text-lg font-bold text-gray-900">
              Service history link
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Anyone with this link or QR code can view verified completed repairs for this vehicle.
            </p>
          </div>

          {/* Toggle Switch */}
          <div className="flex items-center gap-3 self-start sm:self-auto">
            <label
              htmlFor={`history-toggle-${vehicleId}`}
              className="text-xs font-medium text-gray-700 cursor-pointer select-none"
            >
              {enabled ? "Public link enabled" : "Public link disabled"}
            </label>
            <button
              id={`history-toggle-${vehicleId}`}
              role="switch"
              aria-checked={enabled}
              disabled={isToggling}
              onClick={handleToggleEnabled}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-blue-600 focus:ring-offset-2 ${
                enabled ? "bg-blue-600" : "bg-gray-200"
              }`}
            >
              <span className="sr-only">Toggle public service history</span>
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                  enabled ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex flex-col md:flex-row items-center md:items-start gap-6">
          {/* QR Code Container */}
          <div className="flex flex-col items-center shrink-0">
            <div className="w-44 h-44 rounded-xl bg-white border border-gray-200 p-2 shadow-xs flex items-center justify-center overflow-hidden">
              {qrCodeSvg ? (
                <div
                  className="w-full h-full [&>svg]:w-full [&>svg]:h-full"
                  dangerouslySetInnerHTML={{ __html: qrCodeSvg }}
                />
              ) : (
                <QrCode className="w-16 h-16 text-gray-300" />
              )}
            </div>
            <span className="text-[11px] text-gray-400 mt-2 font-mono">
              Scan with camera
            </span>
          </div>

          {/* Link URL and Action Buttons */}
          <div className="flex-1 w-full space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">
                Shareable web link
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={publicUrl}
                  className="flex-1 min-h-[44px] px-3 rounded-lg border border-gray-300 bg-gray-50 text-xs text-gray-800 font-mono focus:outline-hidden focus:ring-2 focus:ring-blue-600"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCopy}
                  className="min-h-[44px] px-4 gap-1.5 text-xs font-semibold shrink-0"
                  title="Copy link to clipboard"
                >
                  {copied ? (
                    <>
                      <Check className="w-4 h-4 text-emerald-600" />
                      <span className="text-emerald-700">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" />
                      <span>Copy link</span>
                    </>
                  )}
                </Button>
              </div>
            </div>

            {/* Action Buttons Row */}
            <div className="flex flex-wrap items-center gap-2.5 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handlePrint}
                className="min-h-[44px] px-4 gap-1.5 text-xs font-medium"
              >
                <Printer className="w-4 h-4 text-gray-600" />
                <span>Print QR</span>
              </Button>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowConfirmRotate(true)}
                className="min-h-[44px] px-4 gap-1.5 text-xs font-medium text-gray-700 hover:text-gray-900"
              >
                <RotateCcw className="w-4 h-4 text-gray-500" />
                <span>Rotate link</span>
              </Button>

              {publicUrl && (
                <a
                  href={publicUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-1.5 px-4 min-h-[44px] text-xs font-medium text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors ml-auto"
                >
                  <span>Preview page</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </div>

            {!enabled && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                <span>
                  This link is currently disabled. Anyone visiting this QR code will see a not-found page until re-enabled.
                </span>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Print-only layout container */}
      <div className="print-only-qr" style={{ display: "none" }}>
        <h1 style={{ fontSize: "1.75rem", fontWeight: "bold", marginBottom: "0.5rem" }}>
          Vehicle Service History
        </h1>
        <p style={{ fontSize: "1.25rem", fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: "1.5rem" }}>
          Plate: {plate}
        </p>
        <div
          style={{ width: "300px", height: "300px", margin: "0 auto" }}
          dangerouslySetInnerHTML={{ __html: qrCodeSvg }}
        />
        <p style={{ marginTop: "1rem", fontSize: "0.875rem", color: "#666" }}>
          Scan to verify complete service records &amp; repair proof photos
        </p>
      </div>

      {/* Rotate Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showConfirmRotate}
        title="Rotate Service History Link?"
        description="Rotating will generate a new unique link and QR code. Anyone with the old link or printed QR code will immediately lose access and receive a not-found page."
        confirmLabel="Rotate Link"
        cancelLabel="Cancel"
        variant="danger"
        isLoading={isRotating}
        onConfirm={handleRotateConfirm}
        onCancel={() => setShowConfirmRotate(false)}
      />
    </>
  );
}
