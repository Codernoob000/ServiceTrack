"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ServiceRequest } from "@/lib/types";
import { RequestCard } from "@/components/request-card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { EmptyState } from "@/components/empty-state";
import { StepperSkeleton } from "@/components/loading-skeleton";
import { ErrorState } from "@/components/error-state";
import { Wrench, CheckCircle, Clock } from "lucide-react";

export default function MechanicQueuePage() {
  const router = useRouter();

  const [activeTab, setActiveTab] = React.useState<string>("open");
  const [openRequests, setOpenRequests] = React.useState<ServiceRequest[]>([]);
  const [assignedRequests, setAssignedRequests] = React.useState<ServiceRequest[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [claimingId, setClaimingId] = React.useState<string | null>(null);
  const [bannerNotice, setBannerNotice] = React.useState<{ type: "success" | "error"; text: string } | null>(null);

  const loadQueue = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [openRes, assignedRes] = await Promise.all([
        fetch("/api/requests?filter=open"),
        fetch("/api/requests?filter=assigned"),
      ]);

      if (openRes.status === 401 || assignedRes.status === 401) {
        router.push("/auth");
        return;
      }

      if (openRes.status === 403 || assignedRes.status === 403) {
        // Customer trying to access mechanic queue
        router.push("/dashboard");
        return;
      }

      if (!openRes.ok || !assignedRes.ok) {
        throw new Error("Failed to load queue.");
      }

      const openData = await openRes.json();
      const assignedData = await assignedRes.json();

      setOpenRequests(openData.requests || []);
      setAssignedRequests(assignedData.requests || []);
    } catch (err) {
      console.error("Queue load error:", err);
      setError("Unable to load mechanic inspection queue. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  React.useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  async function handleClaim(id: string) {
    setClaimingId(id);
    setBannerNotice(null);

    try {
      const res = await fetch(`/api/requests/${id}/claim`, {
        method: "POST",
      });

      const data = await res.json();

      if (!res.ok) {
        setBannerNotice({
          type: "error",
          text: data.error || "Failed to claim request. It may have already been claimed.",
        });
        setClaimingId(null);
        await loadQueue();
        return;
      }

      setBannerNotice({
        type: "success",
        text: "Service request claimed successfully. Status updated to inspecting.",
      });

      // Refresh queue data
      await loadQueue();
      setActiveTab("assigned");
    } catch (err) {
      console.error("Claim error:", err);
      setBannerNotice({ type: "error", text: "Network error while claiming request." });
    } finally {
      setClaimingId(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Banner */}
      {bannerNotice && (
        <div
          className={`p-3.5 rounded-lg border text-xs flex items-center justify-between ${
            bannerNotice.type === "success"
              ? "bg-green-50 border-green-200 text-green-800"
              : "bg-red-50 border-red-200 text-red-800"
          }`}
          role="status"
        >
          <span>{bannerNotice.text}</span>
          <button
            onClick={() => setBannerNotice(null)}
            className="text-gray-500 hover:text-gray-900 ml-4 font-bold"
          >
            ×
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900 tracking-tight">Mechanic Inspection Queue</h1>
          <p className="text-xs text-gray-500 mt-1">
            Claim open customer booking requests and perform detailed multi-angle inspections
          </p>
        </div>
      </div>

      {error && <ErrorState message={error} onRetry={loadQueue} />}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid grid-cols-2 max-w-md">
          <TabsTrigger value="open" className="gap-2">
            <Clock className="w-3.5 h-3.5" />
            <span>Open Requests</span>
            <span className="text-[11px] px-1.5 py-0.2 rounded-full bg-gray-200 text-gray-800">
              {openRequests.length}
            </span>
          </TabsTrigger>

          <TabsTrigger value="assigned" className="gap-2">
            <Wrench className="w-3.5 h-3.5" />
            <span>My Active Jobs</span>
            <span className="text-[11px] px-1.5 py-0.2 rounded-full bg-blue-100 text-[#2563eb]">
              {assignedRequests.length}
            </span>
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Open unassigned requests */}
        <TabsContent value="open" className="mt-6 space-y-4">
          {loading ? (
            <div className="space-y-4">
              <StepperSkeleton />
              <StepperSkeleton />
            </div>
          ) : openRequests.length === 0 ? (
            <EmptyState
              icon={CheckCircle}
              title="No open booking requests"
              description="There are currently no unassigned customer requests waiting for inspection."
            />
          ) : (
            openRequests.map((req) => (
              <RequestCard
                key={req.id}
                request={req}
                role="mechanic"
                onClaim={handleClaim}
                isClaiming={claimingId === req.id}
              />
            ))
          )}
        </TabsContent>

        {/* Tab 2: Assigned requests */}
        <TabsContent value="assigned" className="mt-6 space-y-4">
          {loading ? (
            <div className="space-y-4">
              <StepperSkeleton />
              <StepperSkeleton />
            </div>
          ) : assignedRequests.length === 0 ? (
            <EmptyState
              icon={Wrench}
              title="No assigned jobs"
              description="You have no jobs currently assigned to you. Claim an open request from the Open tab."
            />
          ) : (
            assignedRequests.map((req) => (
              <RequestCard
                key={req.id}
                request={req}
                role="mechanic"
              />
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
