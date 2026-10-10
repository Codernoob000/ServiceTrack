"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Vehicle, ServiceRequest } from "@/lib/types";
import { VehicleCard } from "@/components/vehicle-card";
import { RequestCard } from "@/components/request-card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { CardSkeleton, StepperSkeleton } from "@/components/loading-skeleton";
import { ErrorState } from "@/components/error-state";
import { authFetch } from "@/lib/auth-fetch";
import { Car, Plus, CalendarPlus, ClipboardList, AlertCircle } from "lucide-react";

export default function CustomerDashboardPage() {
  const router = useRouter();

  const [vehicles, setVehicles] = React.useState<Vehicle[]>([]);
  const [requests, setRequests] = React.useState<ServiceRequest[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [actionNotice, setActionNotice] = React.useState<{ type: "success" | "error"; text: string } | null>(null);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const profileRes = await authFetch("/api/user/profile");
      if (profileRes.status === 401) {
        router.push("/auth");
        return;
      }
      if (profileRes.ok) {
        const profileData = await profileRes.json();
        if (profileData.profile?.role === "mechanic") {
          router.push("/mechanic/queue");
          return;
        }
      }

      const [vehiclesRes, requestsRes] = await Promise.all([
        authFetch("/api/vehicles"),
        authFetch("/api/requests"),
      ]);

      if (vehiclesRes.status === 401 || requestsRes.status === 401) {
        router.push("/auth");
        return;
      }

      if (vehiclesRes.status === 403) {
        router.push("/mechanic/queue");
        return;
      }

      if (!vehiclesRes.ok || !requestsRes.ok) {
        throw new Error("Could not load account data.");
      }

      const vehiclesData = await vehiclesRes.json();
      const requestsData = await requestsRes.json();

      setVehicles(vehiclesData.vehicles || []);
      setRequests(requestsData.requests || []);
    } catch (err) {
      console.error("Dashboard load error:", err);
      setError("Unable to load vehicles or service requests. Please check your connection.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleDeleteVehicle(id: string) {
    if (!confirm("Are you sure you want to remove this vehicle from your garage?")) {
      return;
    }

    setDeletingId(id);
    setActionNotice(null);
    try {
      const res = await authFetch(`/api/vehicles/${id}`, {
        method: "DELETE",
      });

      const data = await res.json();

      if (!res.ok) {
        setActionNotice({ type: "error", text: data.error || "Failed to remove vehicle." });
        setDeletingId(null);
        return;
      }

      setActionNotice({ type: "success", text: "Vehicle removed successfully." });
      setVehicles((prev) => prev.filter((v) => v.id !== id));
    } catch (err) {
      console.error("Delete vehicle error:", err);
      setActionNotice({ type: "error", text: "Failed to remove vehicle." });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-8">
      {/* Notice banner */}
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
          >
            ×
          </button>
        </div>
      )}

      {/* Header section */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900 tracking-tight">Customer Dashboard</h1>
          <p className="text-xs text-gray-500 mt-1">
            Track ongoing repairs, book service appointments, and manage your garage
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Link href="/vehicles/new">
            <Button variant="outline" size="sm" className="gap-1.5 text-xs">
              <Plus className="w-3.5 h-3.5" />
              Add vehicle
            </Button>
          </Link>

          <Link href="/book">
            <Button variant="primary" size="sm" className="gap-1.5 text-xs">
              <CalendarPlus className="w-3.5 h-3.5" />
              Book service
            </Button>
          </Link>
        </div>
      </div>

      {/* Error state */}
      {error && <ErrorState message={error} onRetry={loadData} />}

      {/* Section 1: My Vehicles */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Car className="w-4 h-4 text-gray-500" />
            <h2 className="text-sm font-semibold text-gray-900">My Vehicles</h2>
            <span className="text-xs text-gray-400">({vehicles.length})</span>
          </div>

          {vehicles.length > 0 && (
            <Link href="/vehicles/new" className="text-xs text-[#2563eb] hover:underline font-medium">
              + Add another vehicle
            </Link>
          )}
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <CardSkeleton />
            <CardSkeleton />
          </div>
        ) : vehicles.length === 0 ? (
          <EmptyState
            icon={Car}
            title="No vehicles in your garage"
            description="Add your car to request service appointments and track repairs."
            action={
              <Link href="/vehicles/new">
                <Button variant="primary" size="sm" className="gap-1.5 text-xs">
                  <Plus className="w-3.5 h-3.5" />
                  Add your first vehicle
                </Button>
              </Link>
            }
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {vehicles.map((vehicle) => (
              <VehicleCard
                key={vehicle.id}
                vehicle={vehicle}
                onDelete={handleDeleteVehicle}
                isDeleting={deletingId === vehicle.id}
              />
            ))}
          </div>
        )}
      </section>

      {/* Section 2: Service Requests */}
      <section className="space-y-3 pt-4 border-t border-gray-200">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-gray-500" />
            <h2 className="text-sm font-semibold text-gray-900">Service Requests</h2>
            <span className="text-xs text-gray-400">({requests.length})</span>
          </div>

          {requests.length > 0 && (
            <Link href="/book" className="text-xs text-[#2563eb] hover:underline font-medium">
              + Book another service
            </Link>
          )}
        </div>

        {loading ? (
          <div className="space-y-4">
            <StepperSkeleton />
            <StepperSkeleton />
          </div>
        ) : requests.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="No active service requests"
            description="When you book a vehicle for maintenance or inspection, progress will be tracked here in real-time."
            action={
              vehicles.length > 0 ? (
                <Link href="/book">
                  <Button variant="primary" size="sm" className="gap-1.5 text-xs">
                    <CalendarPlus className="w-3.5 h-3.5" />
                    Book a service appointment
                  </Button>
                </Link>
              ) : (
                <Link href="/vehicles/new">
                  <Button variant="primary" size="sm" className="gap-1.5 text-xs">
                    <Plus className="w-3.5 h-3.5" />
                    Add a vehicle first
                  </Button>
                </Link>
              )
            }
          />
        ) : (
          <div className="space-y-4">
            {requests.map((req) => (
              <RequestCard key={req.id} request={req} role="customer" />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
