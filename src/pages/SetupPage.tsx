import { ArrowRight, Check, CircleDashed, Database } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui";
import { sse } from "../lib/api";

// First-run wizard: bring your own data via Airbyte connectors, or start from
// the demo sample (a real local Postgres seeded in tests/, ingested by a
// real source-postgres connector run).
export function SetupPage({ onDone }: { onDone: () => void }) {
  const [picked, setPicked] = useState<"sample" | "own" | null>(null);

  if (picked === "own")
    return (
      <div className="flex h-full items-center justify-center">
        <div className="w-[520px] rounded-lg border border-line bg-panel p-6 text-center">
          <h2 className="text-[15px] font-semibold text-ink">Connect your data</h2>
          <p className="mx-auto mt-2 max-w-md text-[12.5px] leading-relaxed text-ink-3">
            Head to <span className="text-ink">Data → Connector catalog</span> to pick from the full
            Airbyte registry (600+ sources), enter credentials from the connector's own spec, and sync
            into the local warehouse. You can open that directly — this wizard just shortcuts the
            sample path.
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <Button variant="secondary" onClick={() => setPicked(null)}>
              Back
            </Button>
            <Button variant="primary" onClick={onDone}>
              Open the catalog <ArrowRight size={13} className="ml-1 inline" />
            </Button>
          </div>
        </div>
      </div>
    );

  if (picked === "sample")
    return <SampleRun onDone={onDone} onCancel={() => setPicked(null)} />;

  return (
    <div className="flex h-full items-center justify-center">
      <div className="w-[640px]">
        <div className="mb-6 flex items-center gap-3">
          <img src="/logo.svg" alt="GetInsightful" className="h-10 w-auto" />
          <div>
            <h1 className="text-[20px] font-bold tracking-[-0.015em] text-ink">Welcome to GetInsightful</h1>
            <p className="text-[12.5px] text-ink-3">The AI-native data workspace for enterprises.</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setPicked("sample")}
            className="rounded-lg border border-line bg-panel p-5 text-left transition-colors hover:border-ink-3/50"
          >
            <Database size={16} className="text-accent-2" />
            <div className="mt-3 text-[13.5px] font-medium text-ink">Start with sample data</div>
            <div className="mt-1 text-[12px] leading-relaxed text-ink-3">
              Boots a local Postgres with <span className="text-ink">GetInsightful Demo</span> engineering data
              (a healthcare-tech demo tenant) and runs a real Airbyte connector to land it in the
              warehouse.
            </div>
            <div className="mt-3 text-[11px] text-mute">Requires Docker · ~2 min first run</div>
          </button>
          <button
            onClick={() => setPicked("own")}
            className="rounded-lg border border-line bg-panel p-5 text-left transition-colors hover:border-ink-3/50"
          >
            <ArrowRight size={16} className="text-ink-3" />
            <div className="mt-3 text-[13.5px] font-medium text-ink">Connect your own data</div>
            <div className="mt-1 text-[12px] leading-relaxed text-ink-3">
              Pick any of the 600+ Airbyte connectors, authenticate with the connector's own spec
              fields, and sync into your local warehouse.
            </div>
            <div className="mt-3 text-[11px] text-mute">Bring your own credentials</div>
          </button>
        </div>
      </div>
    </div>
  );
}

interface Step {
  key: string;
  label: string;
}
const STEPS: Step[] = [
  { key: "docker", label: "Start local Postgres" },
  { key: "seed", label: "Seed demo source data" },
  { key: "register", label: "Register source-postgres" },
  { key: "ingest", label: "Run Airbyte connector → warehouse" },
  { key: "context", label: "Build the context store" },
  { key: "dashboard", label: "Create Engineering Health dashboard" },
];

function SampleRun({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [done, setDone] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState("docker");
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const run = () => {
    setError(null);
    sse("/api/setup/sample", {}, (ev) => {
      if (ev.type === "step") {
        setCurrent(String(ev.step));
        setLogs((l) => [...l, `▸ ${ev.detail}`]);
      } else if (ev.type === "log") {
        setLogs((l) => [...l, String(ev.text)]);
      } else if (ev.type === "error") {
        setError(String(ev.error));
      } else if (ev.type === "done") {
        setDone(new Set(STEPS.map((s) => s.key)));
        setCurrent("");
      }
    }).catch((e) => setError(String(e.message ?? e)));
  };

  return (
    <div className="flex h-full items-center justify-center">
      <div className="w-[560px] rounded-lg border border-line bg-panel p-6">
        <h2 className="text-[15px] font-semibold text-ink">Setting up sample data</h2>
        <p className="mt-1 text-[12.5px] text-ink-3">
          Real pipeline, no mocks: Postgres → SQL seed → Airbyte connector run → warehouse → context
          store.
        </p>
        <div className="mt-5 space-y-2.5">
          {STEPS.map((s) => {
            const isDone = done.has(s.key);
            const isCurrent = current === s.key && !isDone;
            return (
              <div key={s.key} className="flex items-center gap-3 text-[12.5px]">
                {isDone ? (
                  <Check size={14} className="text-good" />
                ) : isCurrent ? (
                  <span className="probe-bar h-1.5 w-6 rounded-full bg-sunken" />
                ) : (
                  <CircleDashed size={14} className="text-mute" />
                )}
                <span className={isDone ? "text-ink-3" : isCurrent ? "text-ink" : "text-mute"}>
                  {s.label}
                </span>
              </div>
            );
          })}
        </div>
        {logs.length > 0 && (
          <div className="mt-4 max-h-32 overflow-auto rounded-md border border-line bg-paper px-3 py-2 font-mono text-[10.5px] leading-relaxed text-mute">
            {logs.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap">{l}</div>
            ))}
          </div>
        )}
        {error && (
          <div className="mt-4 rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-[12px] leading-relaxed text-bad">
            {error}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Back
          </Button>
          {done.size === 0 ? (
            <Button variant="primary" onClick={run}>
              Run setup
            </Button>
          ) : (
            <Button variant="primary" onClick={onDone} disabled={done.size < STEPS.length}>
              Enter workspace
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
