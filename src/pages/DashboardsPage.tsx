import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CardBody } from "../cards";
import { BUILTIN_SQL, NEW_CARD_SQL } from "../cards/builtinSql";
import { templates } from "../cards/templates";
import { BentoGrid } from "../components/grid";
import { Button, IconBtn, Input, Menu, Modal, Pill, Select } from "../components/ui";
import { api, clearQueryCache, type CardSpec, type Dashboard, type DashVar, type Range } from "../lib/api";
import { useFilters } from "../state/filters";
import { CardEditor } from "./CardEditor";

const RANGES: { value: Range; label: string }[] = [
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

export function DashboardsPage() {
  const filters = useFilters();
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [current, setCurrent] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [servicesOpen, setServicesOpen] = useState(false);
  const [allServices, setAllServices] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<CardSpec | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [varsOpen, setVarsOpen] = useState(false);
  const [editing, setEditing] = useState<CardSpec | null>(null);
  const [editingNew, setEditingNew] = useState(false);
  const [refreshKeys, setRefreshKeys] = useState<Record<string, number>>({});
  const [refreshAll, setRefreshAll] = useState(0);
  const dirty = useRef(false); // layout changed by the user since last save/load
  const appliedVarsRef = useRef("");

  useEffect(() => {
    setLoading(true);
    Promise.all([api.dashboards(), api.services()])
      .then(([d, s]) => {
        setDashboards(d.dashboards);
        setCurrent(d.dashboards[0] ?? null);
        setAllServices(s.services);
      })
      .finally(() => setLoading(false));
  }, [refreshAll]);

  // Debounced layout persistence — only for user edits; loading or switching
  // dashboards never writes the just-fetched layout back.
  useEffect(() => {
    if (!current || !dirty.current) return;
    dirty.current = false;
    const t = setTimeout(() => {
      api.updateDashboard(current.id, { layout: { cards: current.layout.cards } }).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [current]);

  const patchCards = (cards: CardSpec[]) => {
    dirty.current = true;
    setCurrent((c) => (c ? { ...c, layout: { ...c.layout, cards } } : c));
  };

  const setCards = (cards: CardSpec[]) => patchCards(cards);

  const patchLayout = (patch: Partial<Dashboard["layout"]>) => {
    dirty.current = true;
    setCurrent((c) => (c ? { ...c, layout: { ...c.layout, ...patch } } : c));
  };

  // apply dashboard variables once per dashboard/variable-set
  const variables = current?.layout.variables ?? [];
  const varSig = (current?.id ?? "") + JSON.stringify(variables);
  useEffect(() => {
    if (appliedVarsRef.current === varSig) return;
    appliedVarsRef.current = varSig;
    const defaults = Object.fromEntries(variables.map((v) => [v.name, v.default]));
    filters.resetVars(defaults);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [varSig]);

  if (loading)
    return (
      <div className="flex h-full items-center justify-center">
        <div className="probe-bar h-1 w-40 rounded-full bg-sunken" />
      </div>
    );

  if (!current)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <div className="text-[13.5px] font-medium text-ink">No dashboards yet</div>
        <Button variant="primarySm" onClick={() => setNewOpen(true)}>
          Create from template
        </Button>
        <NewDashboardModal
          open={newOpen}
          onOpenChange={setNewOpen}
          onCreate={async (name, layout) => {
            const d = await api.createDashboard(name, layout);
            setDashboards((cur) => [...cur, d]);
            setCurrent(d);
            setNewOpen(false);
          }}
        />
      </div>
    );

  const cards = current.layout.cards;

  // full-page card editor (Redash-style) replaces the grid while open
  if (editing)
    return (
      <CardEditor
        dashboardName={current.name}
        initial={editing}
        isNew={editingNew}
        onBack={() => setEditing(null)}
        onSave={(spec) => {
          const exists = cards.some((c) => c.id === spec.id);
          patchCards(exists ? cards.map((c) => (c.id === spec.id ? spec : c)) : [...cards, spec]);
          setEditing(null);
        }}
      />
    );

  return (
    <>
      <div className="mx-auto max-w-[1400px] px-6 pb-10 pt-5">
        {/* breadcrumb + actions */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[12px] text-ink-3">
            <span>Dashboards</span>
            <span className="text-mute">/</span>
            <Menu
              trigger={
                <button className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-sunken">
                  {current.name}
                  <ChevronDown size={13} className="text-mute" />
                </button>
              }
              items={[
                ...dashboards
                  .filter((d) => d.id !== current.id)
                  .map((d) => ({ label: d.name, onSelect: () => setCurrent(d) })),
                { label: "New dashboard…", onSelect: () => setNewOpen(true) },
                { label: "Manage variables…", onSelect: () => setVarsOpen(true) },
                {
                  label: "Delete dashboard",
                  danger: true,
                  disabled: dashboards.length < 2,
                  onSelect: async () => {
                    await api.deleteDashboard(current.id);
                    const rest = dashboards.filter((d) => d.id !== current.id);
                    setDashboards(rest);
                    setCurrent(rest[0] ?? null);
                  },
                },
              ]}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="chip"
              onClick={() => {
                const maxY = Math.max(0, ...cards.map((c) => c.y + c.h));
                setEditingNew(true);
                setEditing({
                  id: crypto.randomUUID(),
                  type: "bar",
                  title: "New card",
                  sql: NEW_CARD_SQL,
                  x: 0,
                  y: maxY,
                  w: 4,
                  h: 3,
                  viz_options: {},
                });
              }}
            >
              <Plus size={12} className="mr-1.5 inline" />
              Add card
            </Button>
            <Button
              variant="chip"
              onClick={() => {
                clearQueryCache(); // forced refresh: drop client cache, force server re-run
                setRefreshAll((n) => n + 1);
              }}
            >
              <RefreshCw size={12} className="mr-1.5 inline" />
              Refresh
            </Button>
            <Button variant="primarySm" onClick={() => setNewOpen(true)}>
              <Plus size={12} className="mr-1 inline" />
              New
            </Button>
          </div>
        </div>

        {/* title + filters */}
        <div className="mt-4 flex items-end justify-between gap-4">
          <h1 className="text-[20px] font-bold tracking-[-0.015em] text-ink">{current.name}</h1>
          <div className="flex items-center gap-2" onMouseDown={(e) => e.stopPropagation()}>
            <Select value={filters.range} onChange={filters.setRange} options={RANGES} />
            <Select
              value={filters.freq}
              onChange={filters.setFreq}
              options={[
                { value: "hour", label: "Hourly" },
                { value: "day", label: "Daily" },
                { value: "week", label: "Weekly" },
              ]}
            />
            {variables.map((v) =>
              v.type === "enum" ? (
                <Select
                  key={v.name}
                  value={filters.vars[v.name] ?? v.default}
                  onChange={(val) => filters.setVar(v.name, val)}
                  options={(v.options ?? [v.default]).map((o) => ({ value: o, label: `${v.name}: ${o}` }))}
                />
              ) : (
                <Input
                  key={v.name}
                  value={filters.vars[v.name] ?? v.default}
                  onChange={(e) => filters.setVar(v.name, e.target.value)}
                  placeholder={v.name}
                  className="w-28 py-1.5"
                />
              ),
            )}
            <Popover.Root open={servicesOpen} onOpenChange={setServicesOpen}>
              <Popover.Trigger asChild>
                <button className="flex items-center gap-1.5 rounded-sm border border-line bg-paper px-2 py-1.5 text-[11.5px] text-ink-2 transition-colors hover:bg-sunken">
                  Services
                  {filters.services.length > 0 && (
                    <span className="rounded-full bg-sunken px-1.5 text-[10px] text-ink">
                      {filters.services.length}
                    </span>
                  )}
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  align="end"
                  sideOffset={4}
                  className="z-50 max-h-72 w-56 overflow-auto rounded-lg border border-line bg-panel p-1 shadow-2xl"
                >
                  {allServices.map((s) => {
                    const on = filters.services.includes(s);
                    return (
                      <button
                        key={s}
                        onClick={() => filters.toggleService(s)}
                        className="flex w-full items-center justify-between rounded-sm px-2.5 py-1.5 text-[12px] text-ink-2 transition-colors hover:bg-sunken hover:text-ink"
                      >
                        {s}
                        {on && <Check size={13} className="text-accent" />}
                      </button>
                    );
                  })}
                  {filters.services.length > 0 && (
                    <div className="border-t border-line-soft pt-1">
                      <button
                        onClick={filters.clearServices}
                        className="w-full rounded-sm px-2.5 py-1.5 text-left text-[12px] text-mute hover:text-ink"
                      >
                        Clear filters
                      </button>
                    </div>
                  )}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            {filters.services.map((s) => (
              <Pill key={s} tone="neutral">
                <button onClick={() => filters.toggleService(s)} className="hover:text-ink">
                  {s} ×
                </button>
              </Pill>
            ))}
          </div>
        </div>

        {/* bento */}
        <div className="mt-4" onMouseDown={(e) => e.stopPropagation()}>
          <BentoGrid
            cards={cards}
            onLayoutChange={setCards}
            renderCard={(card) => (
              <DashboardCard
                key={card.id}
                card={card}
                selected={selected === card.id}
                onSelect={() => setSelected(card.id)}
                refreshKey={(refreshKeys[card.id] ?? 0) + refreshAll}
                onRefresh={() => setRefreshKeys((m) => ({ ...m, [card.id]: (m[card.id] ?? 0) + 1 }))}
                onExpand={() => setExpanded(card)}
                onEdit={() => {
                  setEditingNew(false);
                  setEditing({ ...card, sql: card.sql ?? BUILTIN_SQL[card.metric ?? ""] ?? NEW_CARD_SQL });
                }}
                onCrossFilter={filters.toggleService}
                onRemove={() => patchCards(cards.filter((c) => c.id !== card.id))}
              />
            )}
          />
        </div>
      </div>

      {/* expanded card view */}
      <Modal open={!!expanded} onOpenChange={(v) => !v && setExpanded(null)} title={expanded?.title ?? ""} wide>
        {expanded && (
          <div className="h-[64vh]">
            <CardBody
              card={expanded}
              refreshKey={refreshKeys[expanded.id] ?? 0}
              onCrossFilter={(s) => {
                filters.toggleService(s);
                setExpanded(null);
              }}
            />
          </div>
        )}
      </Modal>

      <NewDashboardModal
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreate={async (name, layout) => {
          const d = await api.createDashboard(name, layout);
          setDashboards((cur) => [...cur, d]);
          setCurrent(d);
          setNewOpen(false);
        }}
      />

      <VarsDialog
        open={varsOpen}
        onOpenChange={setVarsOpen}
        variables={variables}
        onSave={(vars) => {
          patchLayout({ variables: vars });
          setVarsOpen(false);
        }}
      />
    </>
  );
}

// Dashboard-level variables — shared across every card's SQL via {{name}}.
function VarsDialog({
  open,
  onOpenChange,
  variables,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  variables: DashVar[];
  onSave: (vars: DashVar[]) => void;
}) {
  const [rows, setRows] = useState<DashVar[]>(variables);
  useEffect(() => {
    if (open) setRows(variables);
  }, [open, variables]);

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Dashboard variables" wide>
      <p className="mb-4 text-[12px] leading-relaxed text-ink-3">
        Reference them in any card's SQL as <code className="rounded-sm bg-sunken px-1.5 py-0.5 font-mono">{"{{name}}"}</code>.
        Built-ins always available: <code className="rounded-sm bg-sunken px-1.5 py-0.5 font-mono">{"{{freq}}"}</code>{" "}
        <code className="rounded-sm bg-sunken px-1.5 py-0.5 font-mono">{"{{range_start}}"}</code>{" "}
        <code className="rounded-sm bg-sunken px-1.5 py-0.5 font-mono">{"{{range_end}}"}</code>{" "}
        <code className="rounded-sm bg-sunken px-1.5 py-0.5 font-mono">{"{{services}}"}</code>{" "}
        <code className="rounded-sm bg-sunken px-1.5 py-0.5 font-mono">{"{{services_filter}}"}</code>
      </p>
      <div className="space-y-2">
        {rows.map((v, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={v.name}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
              placeholder="name"
              className="w-32"
            />
            <Select
              value={v.type}
              onChange={(t) => setRows(rows.map((r, j) => (j === i ? { ...r, type: t as DashVar["type"] } : r)))}
              options={[
                { value: "enum", label: "dropdown" },
                { value: "text", label: "text" },
              ]}
            />
            {v.type === "enum" ? (
              <>
                <Input
                  value={v.options?.join(", ") ?? ""}
                  onChange={(e) =>
                    setRows(rows.map((r, j) => (j === i ? { ...r, options: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } : r)))
                  }
                  placeholder="options, comma separated"
                  className="flex-1"
                />
                <Input
                  value={v.default}
                  onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, default: e.target.value } : r)))}
                  placeholder="default"
                  className="w-28"
                />
              </>
            ) : (
              <Input
                value={v.default}
                onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, default: e.target.value } : r)))}
                placeholder="default value"
                className="flex-1"
              />
            )}
            <Button variant="chip" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="rounded-md border border-dashed border-line px-4 py-6 text-center text-[12px] text-mute">
            No custom variables — cards can still use the built-ins.
          </div>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="primarySm"
          onClick={() =>
            onSave(rows.filter((r) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(r.name) && !(r.type === "enum" && !(r.options ?? []).length)))
          }
        >
          Save variables
        </Button>
      </div>
    </Modal>
  );
}

function DashboardCard({
  card,
  selected,
  onSelect,
  refreshKey,
  onRefresh,
  onExpand,
  onEdit,
  onRemove,
  onCrossFilter,
}: {
  card: CardSpec;
  selected: boolean;
  onSelect: () => void;
  refreshKey: number;
  onRefresh: () => void;
  onExpand: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onCrossFilter: (s: string) => void;
}) {
  return (
    <div
      onMouseDown={onSelect}
      className={`group flex h-full flex-col rounded-lg border bg-panel transition-shadow ${
        selected ? "border-accent/60 ring-1 ring-accent/60" : "border-line"
      }`}
    >
      <header className="card-drag flex cursor-grab items-center justify-between px-3.5 pb-0 pt-2.5 active:cursor-grabbing">
        <h3 className="truncate text-[12px] font-medium text-ink-2">{card.title}</h3>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 hover:opacity-100">
          <IconBtn label="Refresh card" onClick={onRefresh}>
            <RefreshCw size={12.5} />
          </IconBtn>
          <Menu
            trigger={
              <IconBtn label="Card actions">
                <MoreHorizontal size={13} />
              </IconBtn>
            }
            items={[
              { label: "Edit", onSelect: onEdit },
              { label: "Expand", onSelect: onExpand },
              { label: "Refresh", onSelect: onRefresh },
              { label: "Remove card", danger: true, onSelect: onRemove },
            ]}
          />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden px-3.5 pb-3 pt-1.5">
        <CardBody card={card} refreshKey={refreshKey} onCrossFilter={onCrossFilter} />
      </div>
    </div>
  );
}

function NewDashboardModal({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreate: (name: string, layout: { cards: CardSpec[] }) => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="New dashboard">
      <div className="space-y-2">
        {templates.map((t) => (
          <button
            key={t.id}
            onClick={() => onCreate(t.name, JSON.parse(JSON.stringify(t.layout)))}
            className="w-full rounded-md border border-line px-3.5 py-3 text-left transition-colors hover:bg-sunken"
          >
            <div className="text-[13px] font-medium text-ink">{t.name}</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-ink-3">{t.description}</div>
          </button>
        ))}
      </div>
    </Modal>
  );
}

// hover-reveal affordance lives on the group; card is not inside a group so add one
// via wrapper class in BentoGrid items.
