"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { ErrorState } from "@/components/error-state";
import { authFetch } from "@/lib/auth-fetch";
import { ArrowLeft, Car, Loader2 } from "lucide-react";

export default function EditVehiclePage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const [plate, setPlate] = React.useState("");
  const [brand, setBrand] = React.useState("");
  const [model, setModel] = React.useState("");
  const [year, setYear] = React.useState<number | string>("");

  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [isNotFound, setIsNotFound] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const loadVehicle = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setIsNotFound(false);
    try {
      // 1. Check user profile / role directly
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

      // 2. Fetch vehicle details
      const res = await authFetch(`/api/vehicles/${id}`);
      if (res.status === 403 || res.status === 404) {
        setIsNotFound(true);
        setIsLoading(false);
        return;
      }

      if (!res.ok) {
        throw new Error("Unable to load vehicle details.");
      }

      const data = await res.json();
      const v = data.vehicle;
      setPlate(v.plate);
      setBrand(v.brand);
      setModel(v.model);
      setYear(v.year);
    } catch (err) {
      console.error("Load vehicle error:", err);
      setError("Unable to load vehicle details.");
    } finally {
      setIsLoading(false);
    }
  }, [id, router]);

  React.useEffect(() => {
    if (id) loadVehicle();
  }, [id, loadVehicle]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const res = await authFetch(`/api/vehicles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plate: plate.trim().toUpperCase(),
          brand: brand.trim(),
          model: model.trim(),
          year: Number(year),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to update vehicle.");
        setIsSubmitting(false);
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      console.error("Update vehicle error:", err);
      setError("An unexpected error occurred. Please try again.");
      setIsSubmitting(false);
    }
  }

  if (isLoading) {
    return (
      <div className="max-w-xl mx-auto py-12 flex flex-col items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        <span className="text-xs text-gray-500 mt-2">Loading vehicle details...</span>
      </div>
    );
  }

  // 403 or 404: Render plain "Not found" page with back link, no Try again button, no empty form
  if (isNotFound) {
    return (
      <div className="max-w-xl mx-auto space-y-4">
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
  if (error && !plate) {
    return (
      <div className="max-w-xl mx-auto space-y-4">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to dashboard</span>
        </Link>
        <ErrorState message={error || "Vehicle not found."} onRetry={loadVehicle} />
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto space-y-6">
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
            <div className="w-8 h-8 rounded-lg bg-gray-100 border border-gray-200 text-gray-700 flex items-center justify-center">
              <Car className="w-4 h-4" />
            </div>
            <div>
              <CardTitle>Edit Vehicle</CardTitle>
              <CardDescription className="text-xs">
                Update license plate, make, model, or year for this vehicle.
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

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="plate" required>
                License Plate
              </Label>
              <Input
                id="plate"
                type="text"
                required
                maxLength={15}
                className="font-mono uppercase tracking-wider"
                value={plate}
                onChange={(e) => setPlate(e.target.value.toUpperCase())}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="brand" required>
                  Make / Brand
                </Label>
                <Input
                  id="brand"
                  type="text"
                  required
                  maxLength={50}
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                />
              </div>

              <div>
                <Label htmlFor="model" required>
                  Model
                </Label>
                <Input
                  id="model"
                  type="text"
                  required
                  maxLength={50}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="year" required>
                Year
              </Label>
              <Input
                id="year"
                type="number"
                required
                min={1900}
                max={2100}
                value={year}
                onChange={(e) => setYear(e.target.value)}
              />
            </div>

            <div className="pt-2 flex items-center justify-end gap-3">
              <Link href="/dashboard">
                <Button type="button" variant="outline" size="sm">
                  Cancel
                </Button>
              </Link>
              <Button type="submit" size="sm" isLoading={isSubmitting}>
                Save Changes
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
