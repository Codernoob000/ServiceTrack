import type { Metadata } from "next";
import { fetchPublicVehicleHistory } from "@/lib/public-history";
import { BeforeAfterSlider } from "@/components/inspection/before-after-slider";
import { formatDate } from "@/lib/utils";
import { ShieldCheck, Car, Wrench, AlertCircle, Calendar } from "lucide-react";

export const metadata: Metadata = {
  title: "Vehicle Service History | ServiceTrack",
  description: "Verified vehicle service records and photographic repair history.",
  robots: {
    index: false,
    follow: false,
  },
};

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function PublicHistoryPage({ params }: PageProps) {
  const { token } = await params;
  const history = await fetchPublicVehicleHistory(token);

  // Generic Not Found state for invalid, unknown, inactive, or disabled tokens
  if (!history) {
    return (
      <main className="min-h-screen bg-gray-50 flex flex-col justify-center items-center px-4 py-12">
        <div className="w-full max-w-md bg-white rounded-xl shadow-xs border border-gray-200 p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4 text-gray-500">
            <AlertCircle className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">Vehicle Not Found</h1>
          <p className="text-sm text-gray-600 mb-6 leading-relaxed">
            This service history link is invalid, inactive, or has been disabled by the vehicle owner.
          </p>
          <div className="text-xs text-gray-400">
            ServiceTrack Public Verification
          </div>
        </div>
      </main>
    );
  }

  const { brand, model, year, masked_plate, repairs } = history;
  const repairCount = repairs.length;

  return (
    <main className="min-h-screen bg-gray-50 pb-16">
      {/* Top Brand Bar */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-md bg-blue-600 flex items-center justify-center text-white font-bold text-sm">
              S
            </div>
            <span className="font-semibold text-gray-900 tracking-tight text-base">
              ServiceTrack
            </span>
          </div>
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-semibold">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Verified Public Record</span>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 pt-6 space-y-6">
        {/* Vehicle Header Card */}
        <section aria-labelledby="vehicle-header" className="bg-white rounded-xl border border-gray-200 p-6 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-blue-600 mb-1">
                <Car className="w-4 h-4" />
                <span>Vehicle Profile</span>
              </div>
              <h1 id="vehicle-header" className="text-2xl font-bold text-gray-900">
                {year} {brand} {model}
              </h1>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {/* Masked Plate Badge */}
              <div className="inline-flex items-center px-3 py-1.5 rounded-lg bg-gray-100 text-gray-900 font-mono text-sm font-bold border border-gray-300 tracking-wider">
                {masked_plate}
              </div>

              {/* Verified Repairs Count */}
              <div className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 border border-blue-200 text-xs font-semibold">
                <Wrench className="w-3.5 h-3.5" />
                <span>{repairCount} {repairCount === 1 ? "Verified repair" : "Verified repairs"}</span>
              </div>
            </div>
          </div>
        </section>

        {/* Repairs List */}
        <section aria-labelledby="repairs-heading">
          <h2 id="repairs-heading" className="text-lg font-semibold text-gray-900 mb-3 flex items-center justify-between">
            <span>Verified Service History</span>
            <span className="text-xs font-normal text-gray-500">
              {repairCount} {repairCount === 1 ? "record" : "records"}
            </span>
          </h2>

          {repairCount === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center shadow-xs">
              <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-3 text-gray-400">
                <Wrench className="w-6 h-6" />
              </div>
              <h3 className="text-base font-semibold text-gray-900 mb-1">
                No verified repairs yet
              </h3>
              <p className="text-sm text-gray-500 max-w-sm mx-auto">
                Completed repairs with before &amp; after photographic proof will appear here once approved and completed.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {repairs.map((repair, idx) => (
                <article
                  key={`${repair.part_name}-${idx}`}
                  className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-xs"
                >
                  {/* Item Header */}
                  <div className="px-5 py-3.5 bg-gray-50/70 border-b border-gray-200 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-emerald-500" />
                      <h3 className="text-base font-semibold text-gray-900">
                        {repair.part_name}
                      </h3>
                    </div>
                    {repair.date && (
                      <div className="flex items-center gap-1.5 text-xs text-gray-600 font-medium">
                        <Calendar className="w-3.5 h-3.5 text-gray-400" />
                        <time dateTime={repair.date}>{formatDate(repair.date)}</time>
                      </div>
                    )}
                  </div>

                  {/* Before / After Slider */}
                  <div className="p-4 sm:p-5">
                    <BeforeAfterSlider
                      beforeUrl={repair.before_url}
                      afterUrl={repair.after_url}
                      partName={repair.part_name}
                      className="max-h-[420px]"
                    />
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {/* Disclaimer / Footer */}
        <footer className="pt-6 pb-8 text-center text-xs text-gray-400">
          <p>
            Photos are uploaded by the service center and linked to completed, customer-approved repairs.
          </p>
        </footer>
      </div>
    </main>
  );
}
