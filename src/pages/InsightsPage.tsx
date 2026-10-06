import { Sparkles } from "lucide-react";
import { EmptyState } from "../components/ui";

// v1 stub: the insights surface will surface AI-generated narrative reports
// (scheduled analyses over the context store). The bento AI-insight cards on
// dashboards already render the per-card flavor.
export function InsightsPage() {
  return (
    <div className="mx-auto max-w-[900px] px-6 pb-10 pt-5">
      <h1 className="flex items-center gap-2 text-[20px] font-bold tracking-[-0.015em] text-ink">
        Insights
        <span className="rounded-full border border-accent-2/40 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider text-accent-2">
          coming soon
        </span>
      </h1>
      <div className="mt-6">
        <EmptyState
          title="Scheduled AI analyses land here"
          body="Narrative reports generated over the context store — weekly reliability digests, anomaly reviews, cost notes. Dashboard insight cards already show per-card versions."
          actions={
            <span className="flex items-center gap-1.5 text-[12px] text-mute">
              <Sparkles size={13} className="text-accent-2" />
              powered by the context layer
            </span>
          }
        />
      </div>
    </div>
  );
}
