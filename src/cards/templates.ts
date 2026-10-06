import type { CardSpec } from "../lib/api";
import { BUILTIN_SQL } from "./builtinSql";

// Dashboard templates (shadcn chart-block derived). The agent guide
// (docs/AGENT_GUIDE.md) documents this exact JSON shape so agents can author
// more; the UI template picker uses the same registry.
//
// Chart/table/hero cards are SQL cards (they run through /api/query/sql);
// KPIs keep the metric registry (previous-period delta machinery) and the
// insight card is composed in Rust.

export interface Template {
  id: string;
  name: string;
  description: string;
  layout: { cards: CardSpec[] };
}

const c = (
  id: string,
  type: CardSpec["type"],
  title: string,
  metric: string,
  x: number,
  y: number,
  w: number,
  h: number,
  options?: Record<string, unknown>,
): CardSpec => ({ id, type, title, metric, x, y, w, h, options });

const s = (
  id: string,
  type: CardSpec["type"],
  title: string,
  metric: string,
  x: number,
  y: number,
  w: number,
  h: number,
  viz_options?: CardSpec["viz_options"],
): CardSpec => ({ id, type, title, metric, sql: BUILTIN_SQL[metric], x, y, w, h, viz_options });

export const templates: Template[] = [
  {
    id: "engineering-health",
    name: "Engineering Health",
    description:
      "Service reliability at a glance: incidents, latency, error rate, deploys, MTTR and DB health.",
    layout: {
      cards: [
        c("c1", "kpi", "Active incidents", "kpi_active_incidents", 0, 0, 2, 2, { goodDirection: "down" }),
        c("c2", "kpi", "p95 latency", "kpi_p95_latency", 2, 0, 2, 2, { unit: "ms", goodDirection: "down" }),
        c("c3", "kpi", "Error rate", "kpi_error_rate", 4, 0, 2, 2, { unit: "%", goodDirection: "down" }),
        c("c4", "kpi", "Deployments", "kpi_deploys", 6, 0, 2, 2, { goodDirection: "up" }),
        c("c5", "kpi", "MTTR", "kpi_mttr", 8, 0, 2, 2, { unit: "min", goodDirection: "down" }),
        c("c6", "kpi", "Alerts firing", "kpi_firing_alerts", 10, 0, 2, 2, { goodDirection: "down" }),
        s("c7", "hero", "Requests served", "hero_requests", 0, 2, 4, 3),
        s("c8", "hbar", "Incidents by service", "incidents_by_service", 4, 2, 4, 4),
        s("c9", "bar", "Deployments per day", "deploys_per_day", 8, 2, 4, 3),
        s("c10", "line", "p95 latency by service", "latency_by_service", 8, 5, 4, 4, { unit: "ms" }),
        s("c11", "table", "Recent incidents", "recent_incidents", 0, 5, 4, 4),
        s("c12", "line", "DB replica lag", "db_replica_lag", 4, 6, 4, 3, { unit: "ms" }),
        c("c13", "insight", "AI insight", "insight_main", 8, 9, 4, 3),
      ],
    },
  },
  {
    id: "data-ops",
    name: "Data Ops Overview",
    description:
      "Warehouse + pipeline lens: data volume, DB health, alert pressure and sync activity.",
    layout: {
      cards: [
        c("d1", "kpi", "Alerts firing", "kpi_firing_alerts", 0, 0, 3, 2, { goodDirection: "down" }),
        c("d2", "kpi", "Active incidents", "kpi_active_incidents", 3, 0, 3, 2, { goodDirection: "down" }),
        c("d3", "kpi", "Deployments", "kpi_deploys", 6, 0, 3, 2, { goodDirection: "up" }),
        c("d4", "kpi", "MTTR", "kpi_mttr", 9, 0, 3, 2, { unit: "min", goodDirection: "down" }),
        c("d5", "line", "DB replica lag", "db_replica_lag", 0, 2, 6, 4, { unit: "ms" }),
        c("d6", "bar", "Deployments per day", "deploys_per_day", 6, 2, 6, 4),
        c("d7", "hbar", "Incidents by service", "incidents_by_service", 0, 6, 5, 4),
        c("d8", "table", "Recent incidents", "recent_incidents", 5, 6, 7, 4),
      ],
    },
  },
  {
    id: "blank",
    name: "Blank canvas",
    description: "An empty 12-column grid — drag in cards from scratch.",
    layout: { cards: [] },
  },
];
