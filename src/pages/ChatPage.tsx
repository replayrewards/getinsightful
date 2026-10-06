import { SendHorizonal, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Input, Modal, Pill, Select } from "../components/ui";
import { api, sse } from "../lib/api";

interface Msg {
  role: "user" | "assistant";
  content: string;
  tool?: string; // last tool activity note
}

interface ProviderCfg {
  provider: string;
  base_url: string | null;
  model: string | null;
  has_key: boolean;
  key_hint: string;
}

// AI Chat — bring your own model. Any Anthropic-protocol provider works:
// Anthropic directly, or Z.ai GLM's coding plan (api.z.ai/api/anthropic).
// Answers stream and can call the warehouse tools (run_sql, context_search).
export function ChatPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [cfg, setCfg] = useState<ProviderCfg | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.chatConfig().then(setCfg);
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    const history = [...messages, { role: "user" as const, content: text }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setStreaming(true);
    try {
      await sse(
        "/api/chat",
        { messages: history.map((m) => ({ role: m.role, content: m.content })) },
        (ev) => {
          if (ev.type === "text") {
            const t = String(ev.text);
            setMessages((cur) => {
              const copy = [...cur];
              const last = copy[copy.length - 1];
              copy[copy.length - 1] = { ...last, content: last.content + t };
              return copy;
            });
          } else if (ev.type === "tool") {
            setMessages((cur) => {
              const copy = [...cur];
              const last = copy[copy.length - 1];
              copy[copy.length - 1] = { ...last, tool: String(ev.name) };
              return copy;
            });
          } else if (ev.type === "error") {
            setMessages((cur) => {
              const copy = [...cur];
              const last = copy[copy.length - 1];
              copy[copy.length - 1] = { ...last, content: last.content + `\n\n⚠ ${ev.error}` };
              return copy;
            });
          }
        },
      );
    } catch (e) {
      setMessages((cur) => {
        const copy = [...cur];
        copy[copy.length - 1] = { ...copy[copy.length - 1], content: `⚠ ${String((e as Error).message)}` };
        return copy;
      });
    } finally {
      setStreaming(false);
    }
  };

  const configured = cfg?.has_key;

  return (
    <div className="mx-auto flex h-full max-w-[900px] flex-col px-6 pt-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[20px] font-bold tracking-[-0.015em] text-ink">AI Chat</h1>
          <p className="mt-0.5 text-[12px] text-ink-3">
            {cfg
              ? `${cfg.provider}${cfg.model ? ` · ${cfg.model}` : ""}${cfg.has_key ? ` · key ${cfg.key_hint}` : " · no key set"}`
              : "…"}
          </p>
        </div>
        <Button variant="chip" onClick={() => setSettingsOpen(true)}>
          <Settings2 size={12} className="mr-1.5 inline" />
          Providers
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-5">
        {messages.length === 0 && (
          <div className="mt-16 text-center">
            <div className="text-[13.5px] font-medium text-ink">Ask your data anything</div>
            <div className="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-ink-3">
              The assistant searches the context store and can run read-only SQL against the local
              warehouse to answer with real numbers.
            </div>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {[
                "Which service had the most sev1 incidents this week?",
                "What is the p95 latency trend for patient-api?",
                "Summarize DB replica lag over the last 7 days",
              ].map((s) => (
                <button
                  key={s}
                  onClick={() => setInput(s)}
                  className="rounded-full border border-line px-3 py-1.5 text-[11.5px] text-ink-2 transition-colors hover:bg-sunken"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`mb-4 flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={
                m.role === "user"
                  ? "max-w-[75%] rounded-lg bg-sunken px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink"
                  : "max-w-[85%] rounded-lg border border-line bg-panel px-3.5 py-2.5"
              }
            >
              {m.tool && (
                <div className="mb-1.5">
                  <Pill tone="running">tool · {m.tool}</Pill>
                </div>
              )}
              <div className="chat-md whitespace-pre-wrap">{m.content || " "}</div>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="pb-5">
        <div className="flex items-end gap-2 rounded-lg border border-line bg-panel p-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={
              configured ? "Ask about your data… (⏎ to send)" : "Connect a provider first (Providers →)"
            }
            className="max-h-40 min-h-[38px] flex-1 resize-none bg-transparent px-2 py-2 text-[13.5px] text-ink outline-none placeholder:text-mute"
          />
          <Button variant="primarySm" disabled={!input.trim() || streaming || !configured} onClick={send}>
            <SendHorizonal size={12.5} />
          </Button>
        </div>
      </div>

      <ProviderSettings open={settingsOpen} onOpenChange={setSettingsOpen} cfg={cfg} onSaved={setCfg} />
    </div>
  );
}

function ProviderSettings({
  open,
  onOpenChange,
  cfg,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  cfg: ProviderCfg | null;
  onSaved: (c: ProviderCfg) => void;
}) {
  const [provider, setProvider] = useState("glm");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (open && cfg) {
      setProvider(cfg.provider || "glm");
      setModel(cfg.model ?? "");
      setBaseUrl(cfg.base_url ?? "");
      setApiKey("");
      setSaved(false);
    }
  }, [open, cfg]);

  const save = async () => {
    await api.setChatConfig({ provider, model, base_url: baseUrl, api_key: apiKey });
    const fresh = await api.chatConfig();
    onSaved(fresh);
    setSaved(true);
    setTimeout(() => onOpenChange(false), 500);
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="AI providers">
      <div className="space-y-3">
        <div>
          <label className="mb-1.5 block text-[12px] font-medium text-ink-3">Provider</label>
          <Select
            value={provider}
            onChange={setProvider}
            className="w-full"
            options={[
              { value: "glm", label: "Z.ai GLM (Coding Plan) — Anthropic-compatible" },
              { value: "anthropic", label: "Anthropic (Claude API)" },
              { value: "custom", label: "Custom (Anthropic-compatible base URL)" },
            ]}
          />
          <div className="mt-1.5 text-[11px] leading-relaxed text-mute">
            {provider === "glm"
              ? "Uses your GLM coding plan key with base https://api.z.ai/api/anthropic and model glm-4.6."
              : provider === "anthropic"
                ? "Uses api.anthropic.com with an Anthropic API key."
                : "Any server speaking the Anthropic Messages protocol works."}
          </div>
        </div>
        {provider === "custom" && (
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3">Base URL</label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://host/api/anthropic" />
          </div>
        )}
        <div>
          <label className="mb-1.5 block text-[12px] font-medium text-ink-3">
            Model {provider !== "custom" && "(optional — provider default)"}
          </label>
          <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={provider === "glm" ? "glm-4.6" : "claude-sonnet-4-5"} />
        </div>
        <div>
          <label className="mb-1.5 block text-[12px] font-medium text-ink-3">
            API key {cfg?.has_key ? `(saved ${cfg.key_hint} — leave blank to keep)` : ""}
          </label>
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
          <div className="mt-1.5 text-[11px] text-mute">
            Stored locally in the workspace database. Requests are proxied through the app process —
            the key never reaches the browser.
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 pt-1">
          {saved && <span className="text-[11px] text-good">Saved ✓</span>}
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
