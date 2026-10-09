import CodeMirror from "@uiw/react-codemirror";
import { keymap } from "@codemirror/view";
import { sql as sqlLang } from "@codemirror/lang-sql";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Play, Save } from "lucide-react";
import { useMemo, useState } from "react";
import { RenderData, deriveItems, deriveScalar, deriveSeries, deriveTable } from "../cards";
import { editorTheme } from "../lib/codemirror-theme";
import { Button, Input, Pill, Select, TabBar } from "../components/ui";
import { SERIES, fmtNum } from "../components/charts";
import { api, type CardSpec, type SqlResult } from "../lib/api";
import { useFilters } from "../state/filters";

/** shape a preview result for RenderData according to the selected viz type */
function previewData(card: CardSpec, result: SqlResult): Record<string, unknown> {
  switch (card.type) {
    case "table":
      return deriveTable(result);
    case "line":
      return { series: deriveSeries(result) };
    case "bar":
    case "hbar":
      return { items: deriveItems(result) };
    default:
      return deriveScalar(result);
  }
}

const VIZ_TYPES: { value: CardSpec["type"]; label: string }[] = [
  { value: "bar", label: "Bar chart" },
  { value: "line", label: "Line chart" },
  { value: "hbar", label: "Horizontal bars" },
  { value: "table", label: "Table" },
  { value: "kpi", label: "KPI number" },
  { value: "hero", label: "Hero number" },
];

// Full-page Redash-style editor: SQL on top, live table/plot below, viz
// settings on the right. Saving always persists a SQL card.
export function CardEditor({
  dashboardName,
  initial,
  isNew,
  onBack,
  onSave,
}: {
  dashboardName: string;
  initial: CardSpec;
  isNew: boolean;
  onBack: () => void;
  onSave: (card: CardSpec) => void;
}) {
  const filters = useFilters();
  const [card, setCard] = useState<CardSpec>(initial);
  const [sql, setSql] = useState(initial.sql ?? "");
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState("viz");
  const [dirty, setDirty] = useState(isNew);

  const varsUsed = useMemo(() => {
    const found = new Set<string>();
    for (const m of sql.matchAll(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g)) found.add(m[1]);
    return [...found];
  }, [sql]);

  const execute = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await api.querySql(sql, {
        range: filters.range,
        freq: filters.freq,
        services: filters.services,
        params: filters.vars,
        force: true, // Execute always runs fresh
      });
      setResult(r);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setRunning(false);
    }
  };

  const save = () => {
    onSave({ ...card, sql });
  };

  const seriesNames = useMemo(() => (result ? deriveSeriesNames(card, result) : []), [card, result]);

  return (
    <div className="flex h-full flex-col" onKeyDown={(e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        execute();
      }
    }}>
      {/* header */}
      <div className="flex items-center justify-between border-b border-line-soft px-6 py-3">
        <div className="flex min-w-0 items-center gap-2 text-[12px] text-ink-3">
          <button onClick={onBack} className="rounded-sm px-1.5 py-0.5 transition-colors hover:bg-sunken hover:text-ink">
            Dashboards / {dashboardName}
          </button>
          <span className="text-mute">/</span>
          <Input
            value={card.title}
            onChange={(e) => setCard({ ...card, title: e.target.value })}
            className="w-56 py-1 font-medium text-ink"
          />
          {dirty && <Pill tone="neutral">unsaved</Pill>}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10.5px] text-mute">⌘⏎ to run</span>
          <Button variant="secondarySm" disabled={running || !sql.trim()} onClick={execute}>
            <Play size={11.5} className="mr-1.5 inline" />
            {running ? "Running…" : "Execute"}
          </Button>
          <Button variant="primarySm" disabled={!sql.trim()} onClick={save}>
            <Save size={11.5} className="mr-1.5 inline" />
            {isNew ? "Add to dashboard" : "Save"}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* left: sql + preview */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="h-[34%] min-h-[140px] shrink-0 overflow-auto rounded-none border-b border-line">
            <CodeMirror
              value={sql}
              onChange={(v) => { setSql(v); setDirty(true); }}
              theme="none"
              extensions={[sqlLang(), keymap.of([]), ...editorTheme({ dark: document.documentElement.dataset.theme !== "light" })]}
              basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true, autocompletion: false }}
              height="100%"
              style={{ height: "100%" }}
            />
          </div>

          <div className="flex items-center justify-between px-6 pt-3">
            <div className="w-64">
              <TabBar
                tabs={[{ id: "viz", label: "Visualization" }, { id: "table", label: "Table" }]}
                active={tab}
                onChange={setTab}
              />
            </div>
            <div className="flex flex-wrap items-center justify-end gap-1.5 text-[10.5px] text-mute">
              vars:
              <code className="rounded-sm bg-sunken px-1.5 py-0.5 font-mono">{"{{freq}}"}</code>
              <code className="rounded-sm bg-sunken px-1.5 py-0.5 font-mono">{"{{range_start}}"}</code>
              <code className="rounded-sm bg-sunken px-1.5 py-0.5 font-mono">{"{{range_end}}"}</code>
              <code className="rounded-sm bg-sunken px-1.5 py-0.5 font-mono">{"{{services_filter}}"}</code>
              {varsUsed.filter((v) => !["freq", "range", "range_start", "range_end", "services", "services_filter"].includes(v))
                .map((v) => (
                  <code key={v} className="rounded-sm bg-sky/15 px-1.5 py-0.5 font-mono text-ink-2">{`{{${v}}}`}</code>
                ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-6 py-3">
            {error && (
              <div className="rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-[12px] leading-relaxed text-bad">
                {error}
              </div>
            )}
            {!error && !result && (
              <div className="py-16 text-center text-[12.5px] text-mute">
                Run the query (⌘⏎) to preview the result here.
              </div>
            )}
            {result && (
              <div className="h-full">
                {tab === "table" ? (
                  <PreviewTable result={result} />
                ) : (
                  <div className="h-[360px]">
                    <RenderData card={card} data={previewData(card, result)} />
                  </div>
                )}
                <div className="mt-2 text-[10.5px] text-mute">
                  {result.rows.length} rows{result.rows.length >= 5000 ? " (capped)" : ""}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* right: settings */}
        <div className="w-[272px] shrink-0 space-y-4 overflow-y-auto border-l border-line-soft px-5 py-4">
          <Field label="Visualization">
            <Select
              value={card.type}
              onChange={(v) => setCard({ ...card, type: v as CardSpec["type"] })}
              options={VIZ_TYPES}
              className="w-full"
            />
          </Field>

          <Field label="Unit (suffix)">
            <Input
              value={card.viz_options?.unit ?? ""}
              onChange={(e) => setCard({ ...card, viz_options: { ...card.viz_options, unit: e.target.value } })}
              placeholder="ms, %, req…"
            />
          </Field>

          {(card.type === "line" || card.type === "table") && (
            <Field label="Legend">
              <Switch
                checked={card.viz_options?.legend ?? true}
                onChange={(v) => setCard({ ...card, viz_options: { ...card.viz_options, legend: v } })}
                label={card.viz_options?.legend === false ? "Hidden" : "Shown"}
              />
            </Field>
          )}

          {card.type === "kpi" && (
            <Field label="Delta reads good when">
              <Select
                value={(card.viz_options?.goodDirection ?? "down") as string}
                onChange={(v) => setCard({ ...card, viz_options: { ...card.viz_options, goodDirection: v as "up" | "down" } })}
                options={[
                  { value: "down", label: "Lower (latency, errors)" },
                  { value: "up", label: "Higher (deploys, uptime)" },
                ]}
                className="w-full"
              />
            </Field>
          )}

          {seriesNames.length > 0 && (
            <Field label="Series colors">
              <div className="space-y-1.5">
                {seriesNames.map((name) => (
                  <ColorRow
                    key={name}
                    name={name}
                    value={card.viz_options?.colors?.[name]}
                    onChange={(hex) =>
                      setCard({ ...card, viz_options: { ...card.viz_options, colors: { ...card.viz_options?.colors, [name]: hex } } })
                    }
                  />
                ))}
              </div>
            </Field>
          )}

          <Field label="Grid size (12 cols)">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={12}
                value={card.w}
                onChange={(e) => setCard({ ...card, w: Math.max(1, Math.min(12, Number(e.target.value) || 4)) })}
              />
              <span className="text-mute">×</span>
              <Input
                type="number"
                min={1}
                max={12}
                value={card.h}
                onChange={(e) => setCard({ ...card, h: Math.max(1, Math.min(12, Number(e.target.value) || 3)) })}
              />
            </div>
          </Field>

          <div className="border-t border-line-soft pt-3 text-[11px] leading-relaxed text-mute">
            Queries run read-only against the local warehouse with a 15s timeout, capped at 5000 rows.
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-mute">{label}</div>
      {children}
    </div>
  );
}

// lazy Radix-free switch styled to the tokens (one boolean control)
function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 text-[12px] text-ink-2"
    >
      <span
        className={`flex h-4.5 w-8 items-center rounded-full border px-0.5 transition-colors ${
          checked ? "border-accent/50 bg-accent/25" : "border-line bg-sunken"
        }`}
      >
        <span
          className={`h-3 w-3 rounded-full bg-ink-2 transition-transform ${checked ? "translate-x-3.5 bg-accent" : ""}`}
        />
      </span>
      {label}
    </button>
  );
}

function ColorRow({ name, value, onChange }: { name: string; value?: string; onChange: (hex: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="w-36 truncate text-[12px] text-ink-2">{name}</span>
      <PopoverPrimitive.Root>
        <PopoverPrimitive.Trigger asChild>
          <button
            className="h-5 w-9 rounded-sm border border-line"
            style={{ background: value ?? "transparent" }}
            title="Pick series color"
          />
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content align="end" sideOffset={4} className="z-50 flex w-auto gap-1.5 rounded-lg border border-line bg-panel p-2 shadow-2xl">
            {SERIES.dark.map((hex) => (
              <button
                key={hex}
                onClick={() => onChange(hex)}
                className={`h-5 w-5 rounded-sm border ${value === hex ? "border-accent ring-1 ring-accent" : "border-line"}`}
                style={{ background: hex }}
              />
            ))}
            {value && (
              <button onClick={() => onChange("")} className="px-1 text-[10.5px] text-mute hover:text-ink">
                reset
              </button>
            )}
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </div>
  );
}

function PreviewTable({ result }: { result: SqlResult }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <table className="w-full text-[11.5px]">
        <thead>
          <tr className="border-b border-line text-left">
            {result.columns.map((c) => (
              <th key={c} className="px-3 py-2 font-medium text-mute">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.slice(0, 50).map((row, i) => (
            <tr key={i} className="border-b border-line-soft/60 last:border-0 hover:bg-sunken/50">
              {result.columns.map((c) => {
                const v = row[c];
                return (
                  <td key={c} className="max-w-64 truncate whitespace-nowrap px-3 py-1.5 text-ink-2">
                    {typeof v === "number" ? fmtNum(v) : v === null || v === undefined ? "—" : String(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// which color pickers to show, from the previewed result
function deriveSeriesNames(card: CardSpec, result: SqlResult): string[] {
  if (!result.rows.length) return [];
  const cols = result.columns.length ? result.columns : Object.keys(result.rows[0]);
  const first = result.rows[0];
  const numeric = cols.filter((c) => typeof first[c] === "number");
  const text = cols.filter((c) => typeof first[c] === "string");
  if (card.type === "line") {
    if (cols.length === 3 && text.length >= 2) {
      return [...new Set(result.rows.map((r) => String(r[cols[1]])))];
    }
    return numeric;
  }
  if (card.type === "bar" || card.type === "hbar") return ["value"];
  return [];
}
