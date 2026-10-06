// Typed client for the embedded axum API. Works identically in the Tauri
// webview (same origin) and in the browser via the Vite dev proxy.

export type Range = "24h" | "7d" | "30d" | "90d";

export interface Filters {
  range: Range;
  services: string[];
}

export interface VizOptions {
  legend?: boolean;
  colors?: Record<string, string>; // series/label name → hex
  unit?: string;
  goodDirection?: "up" | "down";
}

export interface CardSpec {
  id: string;
  type: "kpi" | "hero" | "hbar" | "bar" | "line" | "table" | "insight";
  title: string;
  metric?: string; // registry metric (built-in)
  sql?: string; // custom SQL — takes precedence when present
  x: number;
  y: number;
  w: number;
  h: number;
  options?: Record<string, unknown>;
  viz_options?: VizOptions;
}

export interface DashVar {
  name: string;
  type: "enum" | "text";
  default: string;
  options?: string[]; // enum choices
}

export interface Dashboard {
  id: string;
  slug: string;
  name: string;
  layout: { cards: CardSpec[]; variables?: DashVar[]; refresh_seconds?: number };
  created_at: string;
  updated_at: string;
}

export interface SqlResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface SourceRow {
  id: string;
  connector: string;
  name: string;
  category: string;
  status: string;
  schedule: string;
  last_sync_at: string | null;
}

export interface CatalogItem {
  name: string;
  slug: string;
  category: string;
  kind: string;
  iconUrl: string;
  documentationUrl: string;
  releaseStage: string;
  supportLevel: string;
}

export interface SyncRow {
  id: number;
  connector: string;
  source: string;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  streams: Record<string, unknown>;
  error: string | null;
}

export interface Status {
  db_ok: boolean;
  setup_done: boolean;
  sources: number;
  dashboards: number;
  ctx_entities: number;
  syncs_done: number;
  warehouse_tables: number;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 300)}` : ""}`);
  }
  return res.json() as Promise<T>;
}

// Client query cache — no TTL. Entries live until clearQueryCache() (manual
// Refresh, sync finished) or the query key changes (filters/freq/vars/SQL are
// part of the key). The server keeps its own cache behind these.
const queryCache = new Map<string, unknown>();

export function clearQueryCache(): void {
  queryCache.clear();
}

export const api = {
  status: () => req<Status>("/api/status"),
  services: () => req<{ services: string[] }>("/api/services"),

  sources: () => req<{ sources: SourceRow[] }>("/api/connectors"),
  createSource: (body: { connector: string; name: string; category: string; config: unknown }) =>
    req<{ id: string }>("/api/connectors", { method: "POST", body: JSON.stringify(body) }),
  deleteSource: (id: string) => req<{ ok: boolean }>(`/api/connectors/${id}`, { method: "DELETE" }),
  connectorSpec: (id: string) =>
    req<{ spec: { properties?: Record<string, unknown> }; documentationUrl?: string }>(
      `/api/connectors/${id}/spec`,
    ),
  catalog: (q: string, category: string, kind: string, limit = 60, offset = 0) =>
    req<{ total: number; items: CatalogItem[] }>(
      `/api/catalog?q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}&kind=${encodeURIComponent(kind)}&limit=${limit}&offset=${offset}`,
    ),
  warehouseTables: () =>
    req<{ tables: { schema: string; name: string; rows: number; bytes: number }[] }>(
      "/api/warehouse/tables",
    ),
  tablePreview: (schema: string, name: string, limit = 20) =>
    req<{ columns: { name: string; type: string }[]; rows: Record<string, unknown>[] }>(
      `/api/warehouse/tables/${encodeURIComponent(schema)}/${encodeURIComponent(name)}?limit=${limit}`,
    ),
  syncs: () => req<{ syncs: SyncRow[] }>("/api/syncs"),

  dashboards: () => req<{ dashboards: Dashboard[] }>("/api/dashboards"),
  createDashboard: (name: string, layout: { cards: CardSpec[] }) =>
    req<Dashboard>("/api/dashboards", { method: "POST", body: JSON.stringify({ name, layout }) }),
  updateDashboard: (id: string, patch: { name?: string; layout?: { cards: CardSpec[] } }) =>
    req<Dashboard>(`/api/dashboards/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  deleteDashboard: (id: string) => req<{ ok: boolean }>(`/api/dashboards/${id}`, { method: "DELETE" }),
  query: (metric: string, filters: Filters, force = false) => {
    const key = `metric|${metric}|${filters.range}|${filters.services.join(",")}`;
    if (!force && queryCache.has(key)) return Promise.resolve(queryCache.get(key) as Record<string, unknown>);
    const p = req<Record<string, unknown>>("/api/query", {
      method: "POST",
      body: JSON.stringify({ metric, range: filters.range, services: filters.services, force }),
    });
    p.then((d) => queryCache.set(key, d)).catch(() => {});
    return p;
  },
  querySql: (
    sql: string,
    opts: {
      range: string;
      freq: string;
      services: string[];
      params?: Record<string, unknown>;
      force?: boolean;
    },
  ) => {
    const key = `sql|${sql}|${opts.range}|${opts.freq}|${opts.services.join(",")}|${JSON.stringify(opts.params ?? {})}`;
    if (!opts.force && queryCache.has(key)) return Promise.resolve(queryCache.get(key) as SqlResult);
    const p = req<SqlResult>("/api/query/sql", {
      method: "POST",
      body: JSON.stringify({
        sql,
        range: opts.range,
        freq: opts.freq,
        services: opts.services,
        params: opts.params ?? {},
        force: opts.force ?? false,
      }),
    });
    p.then((d) => queryCache.set(key, d)).catch(() => {});
    return p;
  },

  contextOverview: () =>
    req<{ collections: { source: string; collection: string; entities: number; updated: string }[] }>(
      "/api/context/overview",
    ),
  contextSearch: (q: string) =>
    req<{
      entities: {
        source: string;
        collection: string;
        id: string;
        title: string;
        summary: string;
      }[];
    }>(`/api/context/search?q=${encodeURIComponent(q)}`),

  chatConfig: () =>
    req<{ provider: string; base_url: string | null; model: string | null; has_key: boolean; key_hint: string }>(
      "/api/chat/config",
    ),
  setChatConfig: (body: { provider: string; base_url?: string; model?: string; api_key?: string }) =>
    req<{ ok: boolean }>("/api/chat/config", { method: "POST", body: JSON.stringify(body) }),

  mcpInfo: () => req<Record<string, unknown>>("/mcp"),
};

/** Consume an SSE endpoint (setup wizard + sync runs + chat). */
export async function sse(
  path: string,
  body: unknown,
  onEvent: (data: Record<string, unknown>) => void,
): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) {
          try {
            onEvent(JSON.parse(line.slice(5).trim()));
          } catch {
            /* ignore malformed frames */
          }
        }
      }
    }
  }
}
