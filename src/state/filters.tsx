import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Range } from "../lib/api";

export type Freq = "hour" | "day" | "week";

// Global dashboard state: filters (date range + service multi-select), the
// shared {{freq}} variable, and custom dashboard variables. Every card's query
// key includes all of these, so changing anything re-queries the dashboard
// (through the client + server caches). There is NO background refresh —
// data changes only via forced refresh or a connector sync.
interface FiltersCtx {
  range: Range;
  services: string[];
  setRange: (r: Range) => void;
  toggleService: (s: string) => void;
  clearServices: () => void;
  freq: Freq;
  setFreq: (f: Freq) => void;
  vars: Record<string, string>; // custom dashboard variables
  setVar: (name: string, value: string) => void;
  resetVars: (defaults: Record<string, string>) => void;
}

const Ctx = createContext<FiltersCtx>({
  range: "30d",
  services: [],
  setRange: () => {},
  toggleService: () => {},
  clearServices: () => {},
  freq: "day",
  setFreq: () => {},
  vars: {},
  setVar: () => {},
  resetVars: () => {},
});

export function FiltersProvider({ children }: { children: ReactNode }) {
  const [range, setRange] = useState<Range>("30d");
  const [services, setServices] = useState<string[]>([]);
  const [freq, setFreq] = useState<Freq>("day");
  const [vars, setVars] = useState<Record<string, string>>({});

  const value = useMemo<FiltersCtx>(
    () => ({
      range,
      services,
      setRange,
      toggleService: (s) =>
        setServices((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s])),
      clearServices: () => setServices([]),
      freq,
      setFreq,
      vars,
      setVar: (name, v) => setVars((cur) => ({ ...cur, [name]: v })),
      resetVars: (defaults) => setVars(defaults),
    }),
    [range, services, freq, vars],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useFilters = () => useContext(Ctx);
