"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { authFetch } from "@/lib/auth-fetch";
import { ArrowLeft, Car } from "lucide-react";

export default function NewVehiclePage() {
  const router = useRouter();

  const [plate, setPlate] = React.useState("");
  const [brand, setBrand] = React.useState("");
  const [model, setModel] = React.useState("");
  const [year, setYear] = React.useState<number | string>(new Date().getFullYear());

  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const res = await authFetch("/api/vehicles", {
        method: "POST",
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
        setError(data.error || "Failed to register vehicle.");
        setIsSubmitting(false);
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      console.error("Register vehicle error:", err);
      setError("An unexpected error occurred. Please try again.");
      setIsSubmitting(false);
    }
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
              <CardTitle>Register New Vehicle</CardTitle>
              <CardDescription className="text-xs">
                Add a car to your garage to schedule inspections and track verified repair records.
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
                placeholder="e.g. 7XYZ890 or ABC-1234"
                className="font-mono uppercase tracking-wider"
                value={plate}
                onChange={(e) => setPlate(e.target.value.toUpperCase())}
              />
              <p className="mt-1 text-[11px] text-gray-500">2 to 15 alphanumeric characters.</p>
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
                  placeholder="e.g. Toyota, Honda, Ford"
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
                  placeholder="e.g. Camry, Civic, F-150"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="year" required>
                Manufacturing Year
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

            <div className="pt-2 flex items-center justify-end gap-3 border-t border-gray-100">
              <Link href="/dashboard">
                <Button type="button" variant="outline" size="sm">
                  Cancel
                </Button>
              </Link>
              <Button type="submit" variant="primary" size="sm" isLoading={isSubmitting}>
                Save Vehicle
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
