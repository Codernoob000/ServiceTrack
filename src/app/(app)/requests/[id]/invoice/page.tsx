"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { authFetch } from "@/lib/auth-fetch";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import { ArrowLeft, Printer, Loader2, AlertCircle } from "lucide-react";

interface InvoiceItem {
  id: string;
  part_name: string;
  description: string;
  estimate: number;
}

interface InvoiceData {
  request_id: string;
  status: string;
  date: string;
  preferred_date?: string;
  vehicle: {
    brand: string;
    model: string;
    year: number | null;
    plate: string;
  };
  items: InvoiceItem[];
  total: number;
  mechanic_name: string | null;
}

export default function InvoicePage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const [invoice, setInvoice] = React.useState<InvoiceData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [isNotFound, setIsNotFound] = React.useState(false);

  const loadInvoice = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    setIsNotFound(false);
    try {
      const res = await authFetch(`/api/requests/${id}/invoice`);
      if (res.status === 401) {
        router.push("/auth");
        return;
      }
      if (res.status === 403 || res.status === 404) {
        setIsNotFound(true);
        setLoading(false);
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Unable to load invoice.");
      }

      const data: InvoiceData = await res.json();
      setInvoice(data);
    } catch (err) {
      console.error("Load invoice error:", err);
      setError(err instanceof Error ? err.message : "Failed to load invoice.");
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  React.useEffect(() => {
    if (id) loadInvoice();
  }, [id, loadInvoice]);

  function handlePrint() {
    window.print();
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto py-16 flex flex-col items-center justify-center space-y-2">
        <Loader2 className="w-6 h-6 animate-spin text-[#2563eb]" />
        <span className="text-xs text-gray-500">Loading invoice details...</span>
      </div>
    );
  }

  if (isNotFound) {
    return (
      <div className="max-w-2xl mx-auto space-y-4 py-8">
        <Link
          href={`/requests/${id}`}
          className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900 touch-target"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to service request</span>
        </Link>
        <div className="p-8 text-center rounded-xl border border-gray-200 bg-white space-y-2">
          <h1 className="text-base font-bold text-gray-900">Invoice not available</h1>
          <p className="text-xs text-gray-500">
            The requested invoice could not be found or has not been authorized yet.
          </p>
        </div>
      </div>
    );
  }

  if (error || !invoice) {
    return (
      <div className="max-w-2xl mx-auto space-y-4 py-8">
        <Link
          href={`/requests/${id}`}
          className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900 touch-target"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to service request</span>
        </Link>
        <div className="p-6 rounded-xl border border-red-200 bg-red-50 text-center space-y-3">
          <AlertCircle className="w-6 h-6 text-red-600 mx-auto" />
          <p className="text-xs text-red-800">{error || "Failed to load invoice."}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={loadInvoice}
            className="touch-target text-xs bg-white"
          >
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="invoice-container max-w-2xl mx-auto space-y-6 py-4">
      {/* Print Stylesheet */}
      <style jsx global>{`
        @media print {
          @page {
            margin: 10mm;
            size: auto;
          }
          html,
          body {
            background: white !important;
            color: black !important;
            margin: 0 !important;
            padding: 0 !important;
          }
          header,
          nav,
          .no-print,
          [role="navigation"] {
            display: none !important;
          }
          main {
            padding: 0 !important;
            margin: 0 !important;
            max-width: 100% !important;
            width: 100% !important;
          }
          .invoice-container {
            padding: 0 !important;
            margin: 0 !important;
            max-width: 100% !important;
            width: 100% !important;
          }
          .invoice-card {
            border: none !important;
            box-shadow: none !important;
            padding: 0 !important;
            margin: 0 !important;
            width: 100% !important;
          }
        }
      `}</style>

      {/* Top action bar (hidden in print) */}
      <div className="no-print flex items-center justify-between">
        <Link
          href={`/requests/${id}`}
          className="touch-target inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to service request</span>
        </Link>

        <Button
          type="button"
          onClick={handlePrint}
          className="touch-target bg-[#2563eb] hover:bg-blue-700 text-white text-xs font-semibold gap-1.5 min-h-[44px] px-4"
        >
          <Printer className="w-4 h-4" />
          <span>Print Invoice</span>
        </Button>
      </div>

      {/* Printable Invoice Card */}
      <Card className="invoice-card p-6 sm:p-8 space-y-6 bg-white border border-gray-200">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between sm:items-start gap-4 pb-6 border-b border-gray-200">
          <div>
            <h1 className="text-xl font-bold text-gray-900 tracking-tight">ServiceTrack</h1>
            <p className="text-xs text-gray-500 mt-0.5">Automotive Inspection & Repair Invoice</p>
          </div>

          <div className="text-left sm:text-right text-xs text-gray-600 space-y-1">
            <p>
              Invoice #:{" "}
              <span className="font-mono text-gray-900 font-semibold">
                {invoice.request_id.slice(0, 8).toUpperCase()}
              </span>
            </p>
            <p>Date: {formatDate(invoice.date)}</p>
            <p className="capitalize">
              Status: <span className="font-semibold text-gray-900">{invoice.status.replace("_", " ")}</span>
            </p>
          </div>
        </div>

        {/* Vehicle & Service Details */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-lg bg-gray-50 border border-gray-200 text-xs">
          <div>
            <span className="font-semibold text-gray-900 block mb-1">Vehicle Information</span>
            <p className="text-gray-700">
              {invoice.vehicle.brand} {invoice.vehicle.model}
              {invoice.vehicle.year ? ` (${invoice.vehicle.year})` : ""}
            </p>
            <p className="font-mono text-gray-600 mt-0.5">Plate: {invoice.vehicle.plate}</p>
          </div>

          <div>
            <span className="font-semibold text-gray-900 block mb-1">Service Details</span>
            {invoice.mechanic_name ? (
              <p className="text-gray-700">Technician: {invoice.mechanic_name}</p>
            ) : (
              <p className="text-gray-500">Technician: Certified Mechanic</p>
            )}
            {invoice.preferred_date && (
              <p className="text-gray-600 mt-0.5">Preferred date: {formatDate(invoice.preferred_date)}</p>
            )}
          </div>
        </div>

        {/* Approved Items Table */}
        <div className="space-y-3">
          <h2 className="text-xs font-bold text-gray-900 uppercase tracking-wider">
            Approved Repair Items
          </h2>

          {invoice.items.length === 0 ? (
            <div className="p-4 rounded-lg border border-gray-200 bg-white text-center text-xs text-gray-500">
              No repairs approved.
            </div>
          ) : (
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <table className="w-full text-xs text-left">
                <thead className="bg-gray-50 border-b border-gray-200 text-gray-700">
                  <tr>
                    <th className="py-2.5 px-3.5 font-semibold">Part / Component</th>
                    <th className="py-2.5 px-3.5 font-semibold">Description</th>
                    <th className="py-2.5 px-3.5 text-right font-semibold">Estimate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {invoice.items.map((item, idx) => (
                    <tr key={item.id || idx}>
                      <td className="py-3 px-3.5 font-medium text-gray-900 whitespace-nowrap">
                        {item.part_name}
                      </td>
                      <td className="py-3 px-3.5 text-gray-700">
                        {item.description}
                      </td>
                      <td className="py-3 px-3.5 text-right font-semibold text-gray-900 whitespace-nowrap">
                        ₹{item.estimate.toLocaleString("en-IN")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Total calculation (server-computed) */}
        <div className="pt-4 border-t border-gray-200 flex justify-between items-center">
          <span className="text-sm font-bold text-gray-900">Total Authorized Amount</span>
          <span className="text-lg font-bold text-gray-900">
            ₹{invoice.total.toLocaleString("en-IN")}
          </span>
        </div>

        {/* Footer Note */}
        <div className="text-[11px] text-gray-500 pt-4 border-t border-gray-100 text-center">
          This document serves as an authorized invoice for the listed repairs. All estimates are
          in Indian Rupees (₹).
        </div>
      </Card>
    </div>
  );
}
