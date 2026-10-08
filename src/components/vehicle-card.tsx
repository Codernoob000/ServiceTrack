"use client";

import * as React from "react";
import Link from "next/link";
import { Vehicle } from "@/lib/types";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Car, Edit2, Trash2, CalendarPlus } from "lucide-react";

interface VehicleCardProps {
  vehicle: Vehicle;
  onDelete?: (id: string) => void;
  isDeleting?: boolean;
}

export function VehicleCard({ vehicle, onDelete, isDeleting }: VehicleCardProps) {
  return (
    <Card className="flex flex-col justify-between hover:border-gray-300 transition-colors">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-gray-100 text-gray-700 border border-gray-200 shrink-0">
              <Car className="w-4 h-4" />
            </div>
            <div>
              <h4 className="text-sm font-semibold text-gray-900 leading-tight">
                {vehicle.brand} {vehicle.model}
              </h4>
              <p className="text-xs text-gray-500 mt-0.5">{vehicle.year}</p>
            </div>
          </div>
          <span className="font-mono text-xs font-semibold px-2.5 py-1 rounded border border-gray-300 bg-gray-50 text-gray-900 tracking-wider">
            {vehicle.plate}
          </span>
        </div>
      </div>

      <div className="mt-5 pt-4 border-t border-gray-100 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Link href={`/vehicles/${vehicle.id}/edit`}>
            <Button
              variant="ghost"
              size="sm"
              className="px-2.5 text-xs text-gray-600 hover:text-gray-900"
              title="Edit vehicle"
            >
              <Edit2 className="w-3.5 h-3.5 mr-1" />
              Edit
            </Button>
          </Link>
          {onDelete && (
            <Button
              variant="ghost"
              size="sm"
              isLoading={isDeleting}
              onClick={() => onDelete(vehicle.id)}
              className="px-2.5 text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
              title="Archive vehicle"
            >
              <Trash2 className="w-3.5 h-3.5 mr-1" />
              Remove
            </Button>
          )}
        </div>

        <Link href={`/book?vehicleId=${vehicle.id}`}>
          <Button variant="primary" size="sm" className="gap-1.5 text-xs">
            <CalendarPlus className="w-3.5 h-3.5" />
            Book service
          </Button>
        </Link>
      </div>
    </Card>
  );
}
