import { Component, type ErrorInfo, type ReactNode } from "react";

// Last-resort error boundary: a crash anywhere in the app renders the error
// + a reload button instead of an empty (black) screen.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center p-8">
          <div className="w-[680px] rounded-lg border border-bad/30 bg-bad/10 p-5">
            <div className="text-[13.5px] font-semibold text-bad">Something broke</div>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-ink-2">
              {String(this.state.error.stack ?? this.state.error.message ?? this.state.error).slice(0, 2000)}
            </pre>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => this.setState({ error: null })}
                className="rounded-sm border border-line bg-panel px-3 py-1.5 text-[12px] text-ink-2 hover:bg-sunken"
              >
                Try again
              </button>
              <button
                onClick={() => window.location.reload()}
                className="rounded-sm bg-ink px-3 py-1.5 text-[12px] font-semibold text-paper hover:bg-ink-2"
              >
                Reload app
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
