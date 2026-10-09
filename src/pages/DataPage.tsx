import { BookOpen, Database, Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, IconBtn, Input, Loading, Menu, Modal, Pill, Select, TabBar } from "../components/ui";
import { api, clearQueryCache, sse, type CatalogItem, type SourceRow, type SyncRow } from "../lib/api";

type Tab = "sources" | "catalog" | "warehouse" | "syncs";

export function DataPage() {
  const [tab, setTab] = useState<Tab>("sources");
  return (
    <div className="mx-auto max-w-[1400px] px-6 pb-10 pt-5">
      <h1 className="text-[20px] font-bold tracking-[-0.015em] text-ink">Data</h1>
      <p className="mt-1 text-[12.5px] text-ink-3">
        Connect sources via real Airbyte connectors, sync into the local warehouse, browse what landed.
      </p>
      <div className="mt-4">
        <TabBar
          tabs={[
            { id: "sources", label: "Sources" },
            { id: "catalog", label: "Connector catalog" },
            { id: "warehouse", label: "Warehouse" },
            { id: "syncs", label: "Sync history" },
          ]}
          active={tab}
          onChange={(t) => setTab(t as Tab)}
        />
      </div>
      <div className="mt-5">
        {tab === "sources" && <SourcesTab />}
        {tab === "catalog" && <CatalogTab />}
        {tab === "warehouse" && <WarehouseTab />}
        {tab === "syncs" && <SyncsTab />}
      </div>
    </div>
  );
}

// -- Sources -----------------------------------------------------------------

function SourcesTab() {
  const [sources, setSources] = useState<SourceRow[] | null>(null);
  const [running, setRunning] = useState<Record<string, string>>({});
  const [log, setLog] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const load = () => api.sources().then((r) => setSources(r.sources));
  useEffect(() => {
    load();
  }, []);

  const sync = async (s: SourceRow) => {
    setRunning((m) => ({ ...m, [s.id]: "syncing" }));
    setLog(null);
    try {
      await sse(`/api/connectors/${s.id}/sync`, {}, (ev) => {
        if (ev.type === "error") setLog(`error: ${ev.error}`);
        if (ev.type === "done")
          setLog(`synced: ${JSON.stringify((ev.streams as Record<string, unknown> | undefined) ?? {})}`);
      });
      clearQueryCache(); // new data landed — cached card results are stale
      setRunning((m) => ({ ...m, [s.id]: "connected" }));
    } catch (e) {
      setRunning((m) => ({ ...m, [s.id]: "error" }));
      setLog(String((e as Error).message));
    }
    load();
  };

  if (sources === null) return <Loading />;
  return (
    <div>
      <div className="mb-3 flex justify-end">
        <Button variant="primarySm" onClick={() => setAddOpen(true)}>
          <Plus size={12} className="mr-1 inline" />
          Add source
        </Button>
      </div>
      {log && (
        <div className="mb-3 rounded-md border border-line bg-sunken px-3 py-2 text-[11.5px] text-ink-3">{log}</div>
      )}
      {sources.length === 0 ? (
        <EmptyState
          title="No sources connected"
          body="Run the setup wizard (sample data) or add a connector from the catalog of 600+ Airbyte connectors."
          actions={
            <Button variant="primarySm" onClick={() => setAddOpen(true)}>
              Browse catalog
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {sources.map((s) => {
            const status = running[s.id] ?? s.status;
            return (
              <div key={s.id} className="rounded-lg border border-line bg-panel p-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 items-center justify-center rounded-md bg-sunken text-ink-2">
                      <Database size={15} />
                    </span>
                    <div>
                      <div className="text-[13px] font-medium text-ink">{s.name}</div>
                      <div className="font-mono text-[11px] text-mute">{s.connector}</div>
                    </div>
                  </div>
                  <Menu
                    trigger={<IconBtn label="Source actions"><MoreDots /></IconBtn>}
                    items={[
                      {
                        label: "Remove source",
                        danger: true,
                        onSelect: async () => {
                          await api.deleteSource(s.id);
                          load();
                        },
                      },
                    ]}
                  />
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <Pill tone={status}>{status}</Pill>
                  <span className="text-[11px] text-mute">
                    {s.last_sync_at
                      ? `last sync ${new Date(s.last_sync_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
                      : "never synced"}
                  </span>
                </div>
                <div className="mt-3 flex justify-end">
                  <Button variant="chip" disabled={status === "syncing"} onClick={() => sync(s)}>
                    <RefreshCw size={11.5} className={`mr-1.5 inline ${status === "syncing" ? "animate-pulse" : ""}`} />
                    {status === "syncing" ? "Syncing…" : "Sync now"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConnectorPicker
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={() => {
          setAddOpen(false);
          load();
        }}
      />
    </div>
  );
}

const MoreDots = () => <span className="text-[13px] leading-none text-mute">···</span>;

// -- Catalog -----------------------------------------------------------------

function CatalogTab() {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("sources");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ total: number; items: CatalogItem[] } | null>(null);
  const limit = 40;

  useEffect(() => {
    const t = setTimeout(() => {
      api.catalog(q, category, kind, limit, page * limit).then(setData);
    }, 200);
    return () => clearTimeout(t);
  }, [q, kind, category, page]);

  const pages = data ? Math.max(1, Math.ceil(data.total / limit)) : 1;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mute" />
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(0);
            }}
            placeholder="Search 600+ Airbyte connectors…"
            className="pl-8"
          />
        </div>
        <Select
          value={kind}
          onChange={(v) => {
            setKind(v);
            setPage(0);
          }}
          options={[
            { value: "sources", label: "Sources" },
            { value: "destinations", label: "Destinations" },
          ]}
        />
        <Select
          value={category}
          onChange={(v) => {
            setCategory(v);
            setPage(0);
          }}
          options={[
            { value: "", label: "All categories" },
            { value: "api", label: "API" },
            { value: "database", label: "Database" },
            { value: "file", label: "File" },
          ]}
        />
        <span className="ml-auto text-[11.5px] text-mute">{data ? `${data.total} connectors` : ""}</span>
      </div>

      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {data.items.map((c) => (
              <CatalogRow key={c.slug + c.kind} item={c} onCreated={() => api.catalog(q, category, kind, limit, page * limit).then(setData)} />
            ))}
          </div>
          <div className="mt-4 flex items-center justify-center gap-3 text-[11.5px] text-mute">
            <Button variant="chip" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            page {page + 1} / {pages}
            <Button variant="chip" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function CatalogRow({ item, onCreated }: { item: CatalogItem; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex items-center justify-between rounded-md border border-line bg-panel px-3 py-2.5 transition-colors hover:border-ink-3/40">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-sunken text-[10px] font-semibold uppercase text-ink-3">
            {item.name.slice(0, 2)}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-medium text-ink">{item.name}</div>
            <div className="truncate font-mono text-[10.5px] text-mute">{item.slug}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {item.releaseStage && item.releaseStage !== "generally_available" && (
            <span className="text-[10.5px] text-mute">{item.releaseStage}</span>
          )}
          {item.documentationUrl && (
            <a href={item.documentationUrl} target="_blank" rel="noreferrer" className="text-mute hover:text-ink" title="Docs">
              <BookOpen size={13} />
            </a>
          )}
          <Button variant="chip" onClick={() => setOpen(true)}>
            Connect
          </Button>
        </div>
      </div>
      <ConnectorConfigModal
        open={open}
        onOpenChange={setOpen}
        slug={item.slug}
        name={item.name}
        onCreated={onCreated}
      />
    </>
  );
}

function ConnectorPicker({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ items: CatalogItem[] } | null>(null);
  useEffect(() => {
    if (open) api.catalog(q, "", "sources", 8, 0).then(setData);
  }, [q, open]);
  const [picked, setPicked] = useState<CatalogItem | null>(null);
  return (
    <>
      <Modal open={open && !picked} onOpenChange={onOpenChange} title="Add a source connector">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search connectors…" />
        <div className="mt-3 space-y-1.5">
          {(data?.items ?? []).map((c) => (
            <button
              key={c.slug}
              onClick={() => setPicked(c)}
              className="flex w-full items-center justify-between rounded-md border border-line px-3 py-2 text-left transition-colors hover:bg-sunken"
            >
              <span className="text-[12.5px] text-ink">{c.name}</span>
              <span className="font-mono text-[10.5px] text-mute">{c.slug}</span>
            </button>
          ))}
        </div>
      </Modal>
      {picked && (
        <ConnectorConfigModal
          open={!!picked}
          onOpenChange={(v) => {
            if (!v) setPicked(null);
          }}
          slug={picked.slug}
          name={picked.name}
          onCreated={() => {
            setPicked(null);
            onCreated();
          }}
        />
      )}
    </>
  );
}

// Spec-driven credential form: fields come from the connector's own JSON schema
// (the registry spec / Airbyte docs best practice), so any of the 600+ connectors
// gets a correct form without bespoke UI.
function ConnectorConfigModal({
  open,
  onOpenChange,
  slug,
  name,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  slug: string;
  name: string;
  onCreated: () => void;
}) {
  const [spec, setSpec] = useState<Record<string, SpecProp> | null>(null);
  const [required, setRequired] = useState<string[]>([]);
  const [docs, setDocs] = useState<string>("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [name_, setName_] = useState(`${name} source`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    // docs link comes from the catalog; the credential form is generated from
    // the connector's own JSON schema via POST /api/spec (registry spec).
    fetch(`/api/catalog?q=${encodeURIComponent(slug)}&limit=5`)
      .then((r) => r.json())
      .then(async (cat) => {
        const hit = (cat.items as CatalogItem[]).find((x) => x.slug === slug);
        if (hit?.documentationUrl) setDocs(hit.documentationUrl);
        const res = await fetch("/api/spec", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connector: slug }),
        });
        const j = await res.json();
        const cs = j.spec?.properties ? j.spec : (j.spec?.connectionSpecification ?? j.spec ?? {});
        setSpec((cs.properties as Record<string, SpecProp>) ?? {});
        setRequired((cs.required as string[]) ?? []);
      })
      .catch((e) => setError(String(e)));
  }, [open, slug]);

  const fields = useMemo(() => Object.entries(spec ?? {}), [spec]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const config: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values)) {
        if (v === "") continue;
        const t = spec?.[k]?.type;
        config[k] = t === "integer" || t === "number" ? Number(v) : v;
      }
      await api.createSource({ connector: slug, name: name_, category: "Custom", config });
      onCreated();
      onOpenChange(false);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={`Connect ${name}`}>
      {!spec ? (
        <Loading label="Resolving connector spec…" />
      ) : (
        <div className="space-y-3">
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3">Source name</label>
            <Input value={name_} onChange={(e) => setName_(e.target.value)} />
          </div>
          {fields.map(([key, prop]) => (
            <div key={key}>
              <label className="mb-1.5 block text-[12px] font-medium text-ink-3">
                {(prop.title ?? key) + (required.includes(key) ? "" : " (optional)")}
              </label>
              <Input
                type={prop.airbyte_secret || prop.format === "password" ? "password" : "text"}
                value={values[key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                placeholder={prop.examples?.[0] !== undefined ? String(prop.examples[0]) : ""}
              />
              {prop.description && (
                <div className="mt-1 text-[11px] leading-relaxed text-mute">{prop.description}</div>
              )}
            </div>
          ))}
          {fields.length === 0 && (
            <div className="rounded-md border border-line bg-sunken px-3 py-2 text-[12px] text-ink-3">
              This connector takes no configuration.
            </div>
          )}
          {docs && (
            <a href={docs} target="_blank" rel="noreferrer" className="block text-[11.5px] text-accent hover:underline">
              Setup guide (Airbyte docs) ↗
            </a>
          )}
          {error && <div className="rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-[12px] text-bad">{error}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={submit}>
              {busy ? "Checking…" : "Create source"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

interface SpecProp {
  type?: string;
  title?: string;
  description?: string;
  airbyte_secret?: boolean;
  format?: string;
  examples?: unknown[];
}

// -- Warehouse ---------------------------------------------------------------

function WarehouseTab() {
  const [tables, setTables] = useState<{ schema: string; name: string; rows: number; bytes: number }[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    columns: { name: string; type: string }[];
    rows: Record<string, unknown>[];
  } | null>(null);

  useEffect(() => {
    api.warehouseTables().then((r) => {
      setTables(r.tables);
      if (r.tables[0]) setPicked(`${r.tables[0].schema}.${r.tables[0].name}`);
    });
  }, []);

  useEffect(() => {
    if (!picked) return;
    const [schema, name] = picked.split(".");
    setPreview(null);
    api.tablePreview(schema, name).then(setPreview);
  }, [picked]);

  if (tables === null) return <Loading />;
  if (tables.length === 0)
    return (
      <EmptyState
        title="Warehouse is empty"
        body="Sync a source to land data here. Tables appear automatically after a connector run."
      />
    );

  return (
    <div className="flex gap-4">
      <div className="w-64 shrink-0 space-y-0.5">
        {tables.map((t) => {
          const key = `${t.schema}.${t.name}`;
          const active = picked === key;
          return (
            <button
              key={key}
              onClick={() => setPicked(key)}
              className={`flex w-full items-center justify-between rounded-sm px-2.5 py-1.5 text-left transition-colors ${
                active ? "text-ink" : "text-ink-2 hover:text-ink"
              }`}
            >
              <span className="truncate font-mono text-[11.5px]">{t.name}</span>
              <span className="ml-2 shrink-0 text-[10.5px] text-mute">{t.rows.toLocaleString()}</span>
            </button>
          );
        })}
      </div>
      <div className="min-w-0 flex-1 overflow-auto rounded-lg border border-line bg-panel">
        {!preview ? (
          <Loading />
        ) : (
          <table className="w-full border-collapse text-[11.5px]">
            <thead>
              <tr className="border-b border-line text-left">
                {preview.columns.map((c) => (
                  <th key={c.name} className="whitespace-nowrap px-3 py-2">
                    <div className="font-medium text-ink-2">{c.name}</div>
                    <div className="font-mono text-[10px] text-mute">{c.type}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((r, i) => (
                <tr key={i} className="border-b border-line-soft/60 last:border-0 hover:bg-sunken/50">
                  {preview.columns.map((c) => {
                    const v = r[c.name];
                    const text =
                      typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)
                        ? v.replace("T", " ").slice(0, 19)
                        : v === null || v === undefined
                          ? "—"
                          : typeof v === "object"
                            ? JSON.stringify(v).slice(0, 60)
                            : String(v);
                    return (
                      <td key={c.name} className="max-w-64 truncate whitespace-nowrap px-3 py-1.5 text-ink-2">
                        {text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// -- Sync history ------------------------------------------------------------

function SyncsTab() {
  const [syncs, setSyncs] = useState<SyncRow[] | null>(null);
  useEffect(() => {
    api.syncs().then((r) => setSyncs(r.syncs));
  }, []);
  if (syncs === null) return <Loading />;
  if (syncs.length === 0)
    return <EmptyState title="No syncs yet" body="Connector runs and their stream counts will appear here." />;
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-line text-left">
            {["Source", "Connector", "Started", "Duration", "Status", "Streams"].map((h) => (
              <th key={h} className="px-3.5 py-2 font-medium text-mute">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {syncs.map((s) => {
            const dur =
              s.started_at && s.finished_at
                ? `${Math.max(1, Math.round((+new Date(s.finished_at) - +new Date(s.started_at)) / 1000))}s`
                : s.status === "running"
                  ? "…"
                  : "—";
            return (
              <tr key={s.id} className="border-b border-line-soft/60 last:border-0 hover:bg-sunken/40">
                <td className="px-3.5 py-2 text-ink">{s.source}</td>
                <td className="px-3.5 py-2 font-mono text-[11px] text-ink-3">{s.connector}</td>
                <td className="px-3.5 py-2 text-ink-2">
                  {s.started_at
                    ? new Date(s.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                    : "—"}
                </td>
                <td className="px-3.5 py-2 text-ink-2">{dur}</td>
                <td className="px-3.5 py-2">
                  <Pill tone={s.status}>{s.status}</Pill>
                  {s.error && <span className="ml-2 text-[11px] text-bad">{s.error.slice(0, 80)}</span>}
                </td>
                <td className="px-3.5 py-2 text-[11px] text-mute">
                  {s.streams && typeof s.streams === "object"
                    ? Object.entries(s.streams)
                        .map(([k, v]) => `${k}: ${typeof v === "number" ? v.toLocaleString() : "ok"}`)
                        .join(", ") || "—"
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
