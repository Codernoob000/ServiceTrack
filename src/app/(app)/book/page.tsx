"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Vehicle } from "@/lib/types";
import { SERVICE_TYPES } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { authFetch } from "@/lib/auth-fetch";
import { CalendarPlus, ArrowLeft, Car, Plus, Loader2 } from "lucide-react";

function BookServiceContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedVehicleId = searchParams.get("vehicleId") || "";

  const [vehicles, setVehicles] = React.useState<Vehicle[]>([]);
  const [selectedVehicleId, setSelectedVehicleId] = React.useState<string>(preselectedVehicleId);
  const [serviceType, setServiceType] = React.useState<string>("oil_change");
  const [preferredDate, setPreferredDate] = React.useState<string>("");
  const [complaint, setComplaint] = React.useState<string>("");

  const [isLoadingVehicles, setIsLoadingVehicles] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const todayString = React.useMemo(() => {
    const now = new Date();
    return now.toISOString().split("T")[0];
  }, []);

  React.useEffect(() => {
    async function loadVehicles() {
      setIsLoadingVehicles(true);
      try {
        const res = await authFetch("/api/vehicles");
        if (res.status === 401) {
          router.push("/auth");
          return;
        }
        if (res.status === 403) {
          router.push("/mechanic/queue");
          return;
        }
        if (!res.ok) throw new Error("Failed to load vehicles.");
        const data = await res.json();
        const list = data.vehicles || [];
        setVehicles(list);

        if (list.length > 0) {
          if (preselectedVehicleId && list.some((v: Vehicle) => v.id === preselectedVehicleId)) {
            setSelectedVehicleId(preselectedVehicleId);
          } else {
            setSelectedVehicleId(list[0].id);
          }
        }
      } catch (err) {
        console.error("Load vehicles error:", err);
        setError("Unable to load your vehicles. Please try again.");
      } finally {
        setIsLoadingVehicles(false);
      }
    }
    loadVehicles();
  }, [preselectedVehicleId, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!selectedVehicleId) {
      setError("Please select a vehicle for this service appointment.");
      return;
    }

    if (!preferredDate) {
      setError("Please choose a preferred service date.");
      return;
    }

    if (complaint.trim().length < 5) {
      setError("Please describe the issue or service requirements (at least 5 characters).");
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await authFetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vehicle_id: selectedVehicleId,
          service_type: serviceType,
          complaint: complaint.trim(),
          preferred_date: preferredDate,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to book service appointment.");
        setIsSubmitting(false);
        return;
      }

      router.push(`/requests/${data.request.id}`);
      router.refresh();
    } catch (err) {
      console.error("Book service error:", err);
      setError("An unexpected error occurred. Please try again.");
      setIsSubmitting(false);
    }
  }

  if (isLoadingVehicles) {
    return (
      <div className="max-w-xl mx-auto py-12 flex flex-col items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        <span className="text-xs text-gray-500 mt-2">Checking your garage...</span>
      </div>
    );
  }

  if (vehicles.length === 0) {
    return (
      <div className="max-w-xl mx-auto space-y-6">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to dashboard</span>
        </Link>

        <Card className="text-center p-8">
          <div className="w-12 h-12 rounded-lg bg-gray-100 border border-gray-200 text-gray-700 flex items-center justify-center mx-auto mb-3">
            <Car className="w-5 h-5" />
          </div>
          <h2 className="text-base font-semibold text-gray-900">No registered vehicles</h2>
          <p className="text-xs text-gray-500 mt-1 max-w-sm mx-auto">
            You must add a vehicle to your garage before booking an inspection or repair service.
          </p>
          <div className="mt-5">
            <Link href="/vehicles/new">
              <Button variant="primary" size="sm" className="gap-1.5 text-xs">
                <Plus className="w-3.5 h-3.5" />
                Add your vehicle now
              </Button>
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span>Back to dashboard</span>
      </Link>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-200 text-[#2563eb] flex items-center justify-center">
              <CalendarPlus className="w-4 h-4" />
            </div>
            <div>
              <CardTitle>Book Service Appointment</CardTitle>
              <CardDescription className="text-xs">
                Select your vehicle, choose the service package, and describe any symptoms.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {error && (
            <div
              className="mb-4 p-3 rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs"
              role="alert"
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Vehicle picker */}
            <div>
              <Label required>Select Vehicle</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                {vehicles.map((v) => {
                  const isSelected = selectedVehicleId === v.id;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setSelectedVehicleId(v.id)}
                      className={`flex items-start justify-between p-3 rounded-lg border text-left transition-colors touch-target ${
                        isSelected
                          ? "border-[#2563eb] bg-blue-50/40 text-gray-900"
                          : "border-gray-200 bg-white hover:bg-gray-50 text-gray-700"
                      }`}
                    >
                      <div>
                        <p className="text-xs font-semibold">
                          {v.brand} {v.model}
                        </p>
                        <p className="text-[11px] text-gray-500">{v.year}</p>
                      </div>
                      <span className="font-mono text-xs px-2 py-0.5 rounded border border-gray-200 bg-white font-medium">
                        {v.plate}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Service Type selection */}
            <div>
              <Label required>Service Type</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                {SERVICE_TYPES.map((st) => {
                  const isSelected = serviceType === st.value;
                  return (
                    <button
                      key={st.value}
                      type="button"
                      onClick={() => setServiceType(st.value)}
                      className={`p-3 rounded-lg border text-left transition-colors touch-target ${
                        isSelected
                          ? "border-[#2563eb] bg-blue-50/40 text-gray-900"
                          : "border-gray-200 bg-white hover:bg-gray-50 text-gray-700"
                      }`}
                    >
                      <p className="text-xs font-semibold">{st.label}</p>
                      <p className="text-[11px] text-gray-500 mt-0.5 line-clamp-1">
                        {st.description}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Preferred Date */}
            <div>
              <Label htmlFor="preferred-date" required>
                Preferred Service Date
              </Label>
              <Input
                id="preferred-date"
                type="date"
                required
                min={todayString}
                value={preferredDate}
                onChange={(e) => setPreferredDate(e.target.value)}
              />
              <p className="mt-1 text-[11px] text-gray-500">
                The mechanic will inspect your car on or around this date.
              </p>
            </div>

            {/* Complaint */}
            <div>
              <Label htmlFor="complaint" required>
                Complaint / Reported Issues
              </Label>
              <textarea
                id="complaint"
                required
                rows={3}
                minLength={5}
                maxLength={2000}
                placeholder="Describe what feels wrong, abnormal noises, warning lights, or requested maintenance..."
                value={complaint}
                onChange={(e) => setComplaint(e.target.value)}
                className="flex w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 transition-colors placeholder:text-gray-400 focus-visible:outline-2 focus-visible:outline-[#2563eb] disabled:cursor-not-allowed"
              />
            </div>

            {/* Actions */}
            <div className="pt-2 flex items-center justify-end gap-3 border-t border-gray-100">
              <Link href="/dashboard">
                <Button type="button" variant="outline" size="sm">
                  Cancel
                </Button>
              </Link>
              <Button type="submit" variant="primary" size="sm" isLoading={isSubmitting}>
                Submit Service Booking
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default function BookServicePage() {
  return (
    <React.Suspense
      fallback={
        <div className="max-w-xl mx-auto py-12 flex flex-col items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      }
    >
      <BookServiceContent />
    </React.Suspense>
  );
}
