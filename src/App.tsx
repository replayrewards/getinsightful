import * as Tooltip from "@radix-ui/react-tooltip";
import { Database, LayoutGrid, Layers, MessageSquareText, Moon, Sparkles, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { ChatPage } from "./pages/ChatPage";
import { ContextPage } from "./pages/ContextPage";
import { DataPage } from "./pages/DataPage";
import { DashboardsPage } from "./pages/DashboardsPage";
import { InsightsPage } from "./pages/InsightsPage";
import { SetupPage } from "./pages/SetupPage";
import { api, type Status } from "./lib/api";

type Page = "data" | "dashboards" | "context" | "chat" | "insights";

const NAV: { id: Page; label: string; icon: typeof Database }[] = [
  { id: "data", label: "Data", icon: Database },
  { id: "dashboards", label: "Dashboards", icon: LayoutGrid },
  { id: "context", label: "Context Layer", icon: Layers },
  { id: "chat", label: "AI Chat", icon: MessageSquareText },
  { id: "insights", label: "Insights", icon: Sparkles },
];

export default function App() {
  // deep-link pages via hash (#data, #dashboards, #context, #chat, #insights)
  const [page, setPage] = useState<Page>(() => {
    const h = window.location.hash.replace("#", "") as Page;
    return NAV.some((n) => n.id === h) ? h : "dashboards";
  });
  const [status, setStatus] = useState<Status | null>(null);
  const [setupDone, setSetupDone] = useState<boolean | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    api
      .status()
      .then((s) => {
        setStatus(s);
        setSetupDone(s.setup_done);
      })
      .catch(() => setSetupDone(false));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <Tooltip.Provider delayDuration={300}>
      <div className="flex h-full">
        {/* sidebar */}
        <aside className="flex w-[212px] shrink-0 flex-col border-r border-line bg-paper">
          <div className="flex items-center gap-2.5 px-4 pb-4 pt-5">
            <img src="/logo.svg" alt="GetInsightful" className="h-7 w-auto" />
            <div className="leading-tight">
              <div className="text-[12.5px] font-semibold text-ink">GetInsightful</div>
              <div className="text-[10.5px] text-mute">AI-native data workspace</div>
            </div>
          </div>
          <nav className="min-h-0 flex-1 space-y-0.5 px-2">
            {NAV.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setPage(id)}
                className={`flex w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-[12.5px] transition-colors ${
                  page === id ? "text-ink" : "text-ink-2 hover:text-ink"
                }`}
              >
                <Icon size={14} className={page === id ? "text-accent" : "text-mute"} />
                {label}
              </button>
            ))}
          </nav>
          <div className="border-t border-line-soft px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="text-[10.5px] leading-relaxed text-mute">
                Demo tenant
                <div className="text-[11.5px] text-ink-3">GetInsightful Demo · engineering</div>
              </div>
              <button
                onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                className="rounded-sm p-1.5 text-mute transition-colors hover:bg-sunken hover:text-ink"
                aria-label="Toggle theme"
              >
                {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
              </button>
            </div>
            {status && (
              <div className="mt-2 flex items-center gap-1.5 text-[10.5px] text-mute">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${status.db_ok ? "bg-good" : "bg-bad"}`}
                />
                warehouse {status.db_ok ? "online" : "offline"} · {status.warehouse_tables} tables
              </div>
            )}
          </div>
        </aside>

        {/* main */}
        <main className="min-w-0 flex-1 overflow-y-auto bg-paper">
          {setupDone === null ? (
            <div className="flex h-full items-center justify-center">
              <div className="probe-bar h-1 w-40 rounded-full bg-sunken" />
            </div>
          ) : setupDone ? (
            <>
              {page === "data" && <DataPage />}
              {page === "dashboards" && <DashboardsPage />}
              {page === "context" && <ContextPage />}
              {page === "chat" && <ChatPage />}
              {page === "insights" && <InsightsPage />}
            </>
          ) : (
            <SetupPage
              onDone={() => {
                api.status().then((s) => {
                  setStatus(s);
                  setSetupDone(s.setup_done);
                  if (s.dashboards > 0) setPage("dashboards");
                });
              }}
            />
          )}
        </main>
      </div>
    </Tooltip.Provider>
  );
}
