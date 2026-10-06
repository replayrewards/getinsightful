import { Database, Search, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState, Input, Loading } from "../components/ui";
import { api } from "../lib/api";

interface Collection {
  source: string;
  collection: string;
  entities: number;
  updated: string;
}
interface Entity {
  source: string;
  collection: string;
  id: string;
  title: string;
  summary: string;
}

// Context Layer — the pre-indexed business context built from every sync
// (Airbyte Agents-style context store). Searchable here; also exposed to any
// MCP client (Claude, Cursor) at POST /mcp.
export function ContextPage() {
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [q, setQ] = useState("");
  const [entities, setEntities] = useState<Entity[] | null>(null);
  const [mcp, setMcp] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    api.contextOverview().then((r) => setCollections(r.collections));
    api.contextSearch("").then((r) => setEntities(r.entities));
    api.mcpInfo().then(setMcp);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => api.contextSearch(q).then((r) => setEntities(r.entities)), 200);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="mx-auto max-w-[1400px] px-6 pb-10 pt-5">
      <h1 className="text-[20px] font-bold tracking-[-0.015em] text-ink">Context Layer</h1>
      <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-ink-3">
        The pre-indexed business context built by your connectors — what the AI chat and MCP clients
        ground their answers in. It refreshes after every sync.
      </p>

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        <div>
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mute" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search the context store — services, tables, incidents…"
              className="pl-8"
            />
          </div>
          <div className="mt-3 space-y-1.5">
            {entities === null ? (
              <Loading />
            ) : entities.length === 0 ? (
              <EmptyState
                title="Context store is empty"
                body="It fills automatically after the first connector sync (setup wizard runs this for you)."
              />
            ) : (
              entities.map((e) => (
                <div
                  key={`${e.source}/${e.collection}/${e.id}`}
                  className="rounded-md border border-line bg-panel px-3.5 py-2.5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-[12.5px] font-medium text-ink">{e.title}</span>
                    <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10.5px] text-mute">
                      {e.collection}
                    </span>
                  </div>
                  <div className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-ink-3">{e.summary}</div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-lg border border-line bg-panel p-4">
            <div className="mb-2.5 flex items-center gap-2 text-[12px] font-medium text-ink-2">
              <Database size={13} className="text-mute" />
              Collections
            </div>
            {(collections ?? []).map((c) => (
              <div key={`${c.source}/${c.collection}`} className="flex items-center justify-between py-1 text-[12px]">
                <span className="text-ink-2">{c.collection}</span>
                <span className="text-mute">{c.entities.toLocaleString()}</span>
              </div>
            ))}
            {(collections ?? []).length === 0 && <div className="py-2 text-[11.5px] text-mute">Nothing indexed yet.</div>}
          </div>

          <div className="rounded-lg border border-line bg-panel p-4">
            <div className="mb-2.5 flex items-center gap-2 text-[12px] font-medium text-ink-2">
              <TerminalSquare size={13} className="text-mute" />
              MCP endpoint
            </div>
            <div className="space-y-1.5 font-mono text-[11px] leading-relaxed text-ink-3">
              <div>POST http://localhost:3000/mcp</div>
              <div>tools: {(mcp?.tools as string[])?.join(", ") ?? "…"}</div>
            </div>
            <div className="mt-2.5 text-[11.5px] leading-relaxed text-mute">
              Point Claude Desktop or Cursor at this endpoint and they can query the warehouse and
              search the same context.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
