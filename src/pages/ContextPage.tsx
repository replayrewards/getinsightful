import { Check, Database, Search, TerminalSquare, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState, IconBtn, Input, Loading, Pill, TabBar } from "../components/ui";
import { api, type Memory } from "../lib/api";

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

const KIND_LABEL: Record<string, string> = {
  fact: "fact",
  preference: "preference",
  procedure: "procedure",
  learning: "learning",
};
const STATUS_TONE: Record<string, string> = {
  pending: "open",
  approved: "done",
  rejected: "neutral",
};

// Context Layer — the pre-indexed business context built from every sync
// (Airbyte Agents-style context store), plus the memory feed: durable facts /
// procedures / preferences / learnings extracted from chat, approved here.
// Both are exposed to any MCP client (Claude, Cursor) at POST /mcp.
export function ContextPage() {
  const [tab, setTab] = useState<"entities" | "memories">("entities");
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [memSummary, setMemSummary] = useState<{ total: number; pending: number } | null>(null);
  const [q, setQ] = useState("");
  const [entities, setEntities] = useState<Entity[] | null>(null);
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [mcp, setMcp] = useState<Record<string, unknown> | null>(null);

  const load = () => {
    api.contextOverview().then((r) => {
      setCollections(r.collections);
      setMemSummary(r.memories);
    });
    api.contextSearch(q).then((r) => {
      setEntities(r.entities);
      setMemories(r.memories);
    });
  };

  useEffect(() => {
    api.mcpInfo().then(setMcp);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const moderate = async (id: number, status: Memory["status"]) => {
    await api.setMemoryStatus(id, status);
    setMemories((cur) => (cur ?? []).map((m) => (m.id === id ? { ...m, status } : m)));
    api.contextOverview().then((r) => setMemSummary(r.memories));
  };
  const remove = async (id: number) => {
    await api.deleteMemory(id);
    setMemories((cur) => (cur ?? []).filter((m) => m.id !== id));
    api.contextOverview().then((r) => setMemSummary(r.memories));
  };

  return (
    <div className="mx-auto max-w-[1400px] px-6 pb-10 pt-5">
      <h1 className="text-[20px] font-bold tracking-[-0.015em] text-ink">Context Layer</h1>
      <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-ink-3">
        The pre-indexed business context built by your connectors, plus memories learned from your
        questions — what the AI chat and MCP clients ground their answers in. It refreshes after
        every sync.
      </p>

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        <div>
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mute" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={
                tab === "entities"
                  ? "Search the context store — services, tables, incidents…"
                  : "Search memories — facts, procedures, past answers…"
              }
              className="pl-8"
            />
          </div>
          <div className="mt-3">
            <TabBar
              tabs={[
                { id: "entities", label: `Entities${entities ? ` (${entities.length})` : ""}` },
                {
                  id: "memories",
                  label: `Memories${memSummary?.pending ? ` · ${memSummary.pending} pending` : ""}`,
                },
              ]}
              active={tab}
              onChange={(id) => setTab(id as "entities" | "memories")}
            />
          </div>
          <div className="mt-3 space-y-1.5">
            {tab === "entities" ? (
              entities === null ? (
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
                    <div className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-ink-3">
                      {e.summary}
                    </div>
                  </div>
                ))
              )
            ) : memories === null ? (
              <Loading />
            ) : memories.length === 0 ? (
              <EmptyState
                title="No memories yet"
                body="Answers in AI Chat are distilled into durable facts and learnings; they land here pending your approval."
              />
            ) : (
              memories.map((m) => (
                <div
                  key={m.id}
                  className={`rounded-md border border-line bg-panel px-3.5 py-2.5 ${
                    m.status === "rejected" ? "opacity-50" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <Pill tone="neutral">{KIND_LABEL[m.kind] ?? m.kind}</Pill>
                      <Pill tone={STATUS_TONE[m.status] ?? "neutral"}>{m.status}</Pill>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {m.status === "pending" && (
                        <>
                          <IconBtn label="Approve" onClick={() => moderate(m.id, "approved")}>
                            <Check size={13} className="text-good" />
                          </IconBtn>
                          <IconBtn label="Reject" onClick={() => moderate(m.id, "rejected")}>
                            <X size={13} className="text-warn" />
                          </IconBtn>
                        </>
                      )}
                      {m.status !== "pending" && (
                        <IconBtn label="Back to pending" onClick={() => moderate(m.id, "pending")}>
                          <X size={13} className="rotate-45 text-warn" />
                        </IconBtn>
                      )}
                      <IconBtn label="Delete" onClick={() => remove(m.id)}>
                        <Trash2 size={13} />
                      </IconBtn>
                    </div>
                  </div>
                  <div className="mt-1.5 text-[12.5px] leading-relaxed text-ink">{m.text}</div>
                  {m.provenance?.question && (
                    <div className="mt-1 line-clamp-1 text-[11px] text-mute">
                      from chat: “{m.provenance.question}”
                    </div>
                  )}
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
            {memSummary && (
              <div className="mt-1 flex items-center justify-between border-t border-line-soft pt-2 text-[12px]">
                <span className="text-ink-2">Memories</span>
                <span className="text-mute">
                  {memSummary.total.toLocaleString()}
                  {memSummary.pending > 0 && (
                    <span className="text-accent-2"> · {memSummary.pending} pending</span>
                  )}
                </span>
              </div>
            )}
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
              search the same context — approved memories included.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
