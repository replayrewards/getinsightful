import { ArrowDownRight, ArrowUpRight, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { ColumnChart, HBar, SeriesChart, fmtNum } from "../components/charts";
import { Loading, Pill } from "../components/ui";
import { useFilters } from "../state/filters";
import { api, type CardSpec, type Filters, type SqlResult } from "../lib/api";

type CardData = Record<string, unknown> | SqlResult | undefined;

function useCardData(card: CardSpec, refreshKey: number) {
  const filters = useFilters();
  const svcKey = filters.services.join(",");
  const varKey = JSON.stringify(filters.vars);
  const [data, setData] = useState<CardData>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(undefined);
    const req =
      card.sql !== undefined
        ? api.querySql(card.sql, {
            range: filters.range,
            freq: filters.freq,
            services: filters.services,
            params: filters.vars,
          })
        : api.query(card.metric ?? "", { range: filters.range, services: filters.services });
    req
      .then((d) => alive && (setData(d), setLoading(false)))
      .catch((e) => alive && (setError(String(e.message ?? e)), setLoading(false)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.sql, card.metric, filters.range, filters.freq, svcKey, varKey, refreshKey]);
  return { data, loading, error };
}

export function CardBody({
  card,
  refreshKey,
  onCrossFilter,
}: {
  card: CardSpec;
  refreshKey: number;
  onCrossFilter?: (service: string) => void;
}) {
  const { data, loading, error } = useCardData(card, refreshKey);
  if (error)
    return (
      <div className="px-1 py-2 text-[11.5px] leading-relaxed text-bad">
        {error}
      </div>
    );
  if (loading && data === undefined) return <Loading />;
  if (!data) return <Loading />;
  return <RenderData card={card} data={data} onCrossFilter={onCrossFilter} />;
}

/** Render a query result according to the card type. SQL results are shaped
 * client-side by deriveViz; registry results already carry their shape. */
export function RenderData({
  card,
  data,
  onCrossFilter,
}: {
  card: CardSpec;
  data: Exclude<CardData, undefined>;
  onCrossFilter?: (service: string) => void;
}) {
  const viz = card.viz_options ?? {};
  const unit = (viz.unit ?? (card.options?.unit as string)) || undefined;
  const res =
    card.sql && data && typeof data === "object" && "rows" in data
      ? (data as SqlResult)
      : null;
  if (card.sql && !res) {
    // shape drift — should be impossible; log instead of crashing
    console.error("sql card got non-SQL data", card.id, card.metric, JSON.stringify(data).slice(0, 200));
  }
  switch (card.type) {
    case "kpi":
      return <Kpi data={res ? deriveScalar(res) : (data as Record<string, unknown>)} card={card} />;
    case "hero":
      return <Hero data={res ? deriveScalar(res) : (data as Record<string, unknown>)} />;
    case "hbar":
      return (
        <HBar
          items={res ? deriveItems(res) : ((data as Record<string, unknown>).items as { label: string; value: number }[]) ?? []}
          onSelect={onCrossFilter}
          color={viz.colors?.["value"]}
        />
      );
    case "bar":
      return (
        <ColumnChart
          data={res ? deriveItems(res) : ((data as Record<string, unknown>).items as { label: string; value: number }[]) ?? []}
          unit={unit}
          color={viz.colors?.["value"]}
        />
      );
    case "line":
      return (
        <SeriesChart
          series={
            res
              ? deriveSeries(res)
              : ((data as Record<string, unknown>).series as { name: string; points: { label: string; value: number }[] }[]) ?? []
          }
          unit={unit}
          colors={viz.colors}
          showLegend={viz.legend ?? true}
        />
      );
    case "table":
      return <DataTable data={res ? deriveTable(res) : (data as Record<string, unknown>)} />;
    case "insight":
      return <Insight text={String((data as Record<string, unknown>).text ?? "")} basis={String((data as Record<string, unknown>).basis ?? "warehouse")} />;
    default:
      return <div className="text-[12px] text-mute">unknown card type</div>;
  }
}

// -- deriveViz: shape an arbitrary SQL result into what a card type needs ----

const isNum = (v: unknown) => typeof v === "number";
const cols = (r: SqlResult): string[] =>
  r.columns?.length ? r.columns : Object.keys(r.rows?.[0] ?? {});

export function deriveItems(r: SqlResult): { label: string; value: number }[] {
  const rows = r.rows ?? [];
  const c = cols(r);
  const labelCol = c.find((k) => !isNum(rows[0]?.[k])) ?? c[0];
  const valueCol = c.find((k) => k !== labelCol && isNum(rows[0]?.[k])) ?? c[c.length - 1];
  return rows.map((row) => ({ label: String(row[labelCol] ?? ""), value: Number(row[valueCol] ?? 0) }));
}

export function deriveSeries(r: SqlResult): { name: string; points: { label: string; value: number }[] }[] {
  const rows = r.rows ?? [];
  const c = cols(r);
  if (!rows.length || c.length < 2) return [];
  // long format (label, name, value) → pivot; otherwise wide (label, num…)
  if (c.length === 3 && !isNum(rows[0][c[1]])) {
    const labels: string[] = [];
    const names: string[] = [];
    for (const row of rows) {
      const l = String(row[c[0]]), n = String(row[c[1]]);
      if (!labels.includes(l)) labels.push(l);
      if (!names.includes(n)) names.push(n);
    }
    const map = new Map(rows.map((row) => [`${row[c[0]]}|${row[c[1]]}`, Number(row[c[2]] ?? 0)]));
    return names.map((name) => ({
      name,
      points: labels.map((label) => ({ label, value: map.get(`${label}|${name}`) ?? 0 })),
    }));
  }
  const labelCol = c.find((k) => !isNum(rows[0]?.[k])) ?? c[0];
  const seriesCols = c.filter((k) => k !== labelCol && isNum(rows[0]?.[k]));
  return seriesCols.map((name) => ({
    name,
    points: rows.map((row) => ({ label: String(row[labelCol] ?? ""), value: Number(row[name] ?? 0) })),
  }));
}

export function deriveScalar(r: SqlResult): Record<string, unknown> {
  const first = r.rows?.[0] ?? {};
  const numCol = Object.keys(first).find((k) => isNum(first[k]));
  return { value: numCol ? Number(first[numCol]) : 0 };
}

export function deriveTable(r: SqlResult): Record<string, unknown> {
  const c = cols(r);
  return {
    columns: c.map((k) => ({ key: k, label: k })),
    rows: r.rows ?? [],
  };
}

function Kpi({ data, card }: { data: Record<string, unknown>; card: CardSpec }) {
  const value = Number(data?.value ?? 0);
  const delta = data?.delta_pct === null || data?.delta_pct === undefined ? null : Number(data.delta_pct);
  const unit = card.viz_options?.unit ?? (card.options?.unit as string) ?? "";
  const goodDown = (card.viz_options?.goodDirection ?? (card.options?.goodDirection as string)) === "down";
  const good = delta === null ? null : goodDown ? delta <= 0 : delta >= 0;
  return (
    <div className="flex h-full flex-col justify-between py-1">
      <div className="text-[24px] font-semibold leading-none tracking-[-0.01em] text-ink">
        {fmtNum(value)}
        {unit && <span className="ml-1 text-[13px] font-normal text-mute">{unit}</span>}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px]">
        {delta !== null && (
          <span className={`inline-flex items-center gap-0.5 ${good ? "text-good" : "text-bad"}`}>
            {delta >= 0 ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
            {Math.abs(delta).toFixed(0)}%
          </span>
        )}
        <span className="text-mute">vs previous period</span>
      </div>
    </div>
  );
}

function Hero({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-[44px] font-semibold leading-none tracking-[-0.02em] text-ink">
        {fmtNum(Number(data?.value ?? 0))}
      </div>
    </div>
  );
}

function DataTable({ data }: { data: CardData }) {
  const columns = (data?.columns as { key: string; label: string }[]) ?? [];
  const rows = (data?.rows as Record<string, unknown>[]) ?? [];
  return (
    <div className="h-full overflow-auto text-[11.5px]">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line-soft text-left">
            {columns.map((c) => (
              <th key={c.key} className="whitespace-nowrap px-2 py-1.5 font-medium text-mute">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line-soft/60 last:border-0 hover:bg-sunken/50">
              {columns.map((c) => {
                const v = r[c.key];
                const text =
                  typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)
                    ? new Date(v).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : typeof v === "number"
                      ? fmtNum(v)
                      : String(v ?? "—");
                return (
                  <td key={c.key} className="max-w-52 truncate whitespace-nowrap px-2 py-1.5 text-ink-2">
                    {c.key === "severity" || c.key === "status" ? <Pill tone={text}>{text}</Pill> : text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="px-6 py-8 text-center text-[12px] text-mute">no rows</div>}
    </div>
  );
}

function Insight({ text, basis }: { text: string; basis: string }) {
  return (
    <div className="flex h-full flex-col justify-between gap-2 py-1">
      <div className="flex gap-2.5">
        <Sparkles size={14} className="mt-0.5 shrink-0 text-accent-2" />
        <p className="text-[12.5px] leading-relaxed text-ink">{text}</p>
      </div>
      <div className="flex items-center gap-1.5 text-[10.5px] text-mute">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-2" />
        generated from {basis}
      </div>
    </div>
  );
}

export function crossFilterHint(filters: Filters): string {
  return filters.services.length ? `filtered to ${filters.services.length} services` : "all services";
}
