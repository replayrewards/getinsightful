import {
  Bar as RBar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";

// Categorical series palette — validated with the dataviz six-checks script
// against each mode's surface (dark PASS on #1a1817; light PASS with tooltip
// + table-view relief for the 3:1 WARN).
export const SERIES = {
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"],
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"],
};

export function palette(): string[] {
  return document.documentElement.dataset.theme === "light" ? SERIES.light : SERIES.dark;
}

export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  if (Number.isInteger(v)) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(1).replace(/\.0$/, "");
  return v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

const AXIS_TICK = { fill: "var(--color-mute)", fontSize: 9.5 };

interface TipProps {
  active?: boolean;
  payload?: { name?: string | number; value?: number | string; color?: string }[];
  label?: string | number;
  unit?: string;
}

function ChartTooltip({ active, payload, label, unit }: TipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="max-w-56 rounded-md border border-line bg-panel px-2.5 py-2 shadow-2xl">
      {label !== undefined && (
        <div className="mb-1 text-[10.5px] uppercase tracking-wide text-mute">{label}</div>
      )}
      <div className="space-y-1">
        {payload.map((p, i) => (
          <div key={i} className="flex items-center justify-between gap-4 text-[11.5px]">
            <span className="flex min-w-0 items-center gap-1.5 text-ink-2">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color }} />
              <span className="truncate">{p.name}</span>
            </span>
            <span className="font-medium tabular-nums text-ink">
              {fmtNum(Number(p.value))}
              {unit ? ` ${unit}` : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const legendStyle = { fontSize: 10.5, color: "var(--color-ink-3)" };

export function ColumnChart({
  data,
  unit,
  height,
  color,
}: {
  data: { label: string; value: number }[];
  unit?: string;
  height?: number;
  color?: string;
}) {
  const c = color ?? palette()[0]; // one series → one hue
  return (
    <div className="h-full" style={height ? { height } : undefined}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, left: -22, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--color-line-soft)" strokeWidth={1} />
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} tickFormatter={fmtNum} />
          <RTooltip cursor={{ fill: "var(--color-sunken)", opacity: 0.5 }} content={<ChartTooltip unit={unit} />} />
          <RBar dataKey="value" name="value" fill={c} radius={[4, 4, 0, 0]} maxBarSize={28} animationDuration={350} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SeriesChart({
  series,
  unit,
  height,
  colors: colorOverrides,
  showLegend = true,
}: {
  series: { name: string; points: { label: string; value: number }[] }[];
  unit?: string;
  height?: number;
  colors?: Record<string, string>;
  showLegend?: boolean;
}) {
  const colors = palette();
  // pivot: one row per label, one column per series
  const labels = series[0]?.points.map((p) => p.label) ?? [];
  const rows = labels.map((label, i) => {
    const row: Record<string, string | number> = { label };
    series.forEach((s) => {
      row[s.name] = s.points[i]?.value ?? 0;
    });
    return row;
  });
  return (
    <div className="h-full" style={height ? { height } : undefined}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--color-line-soft)" strokeWidth={1} />
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={40} />
          <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} tickFormatter={fmtNum} />
          <RTooltip cursor={{ stroke: "var(--color-line)", strokeWidth: 1 }} content={<ChartTooltip unit={unit} />} />
          {series.length > 1 && showLegend && (
            <Legend wrapperStyle={legendStyle} iconType="plainline" iconSize={10} />
          )}
          {series.map((s, i) => (
            <Line
              key={s.name}
              type="monotone"
              dataKey={s.name}
              stroke={colorOverrides?.[s.name] ?? colors[i % colors.length]}
              strokeWidth={1.8}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0 }}
              animationDuration={350}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// Horizontal bars — plain divs (label column + value-terminated fill), the
// same anatomy as the reference: thin bar, value label at the data end.
export function HBar({
  items,
  onSelect,
  color,
  max: maxOverride,
}: {
  items: { label: string; value: number }[];
  onSelect?: (label: string) => void;
  color?: string;
  max?: number;
}) {
  const c = color ?? palette()[1]; // single-series → slot-2 orange, like the reference
  const max = maxOverride ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="h-full min-w-0 overflow-y-auto">
      {items.length === 0 && <div className="px-6 py-10 text-center text-[12px] text-mute">no data yet</div>}
      <div className="space-y-1.5">
        {items.map((it) => (
          <button
            key={it.label}
            onClick={() => onSelect?.(it.label)}
            title={onSelect ? `Filter to ${it.label}` : it.label}
            className="group flex w-full items-center gap-3 rounded-sm text-left transition-colors hover:bg-sunken/60"
          >
            <span className="w-32 shrink-0 truncate text-[12px] text-ink-2 group-hover:text-ink">
              {it.label}
            </span>
            <span className="relative h-4 min-w-0 flex-1">
              <span
                className="absolute inset-y-0 left-0 rounded-r-[4px] transition-[width] duration-300"
                style={{ width: `${(it.value / max) * 100}%`, background: c }}
              />
              <span className="absolute inset-y-0 right-1 flex items-center text-[10.5px] font-medium tabular-nums text-ink-2">
                {fmtNum(it.value)}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
