import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import { X } from "lucide-react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

// Buttons — the primary is ink, not blue. Blue (accent) is a signal.
const BTN = {
  primary: "rounded-sm bg-ink px-4 py-2 text-[12.5px] font-semibold text-paper hover:bg-ink-2 disabled:opacity-40",
  primarySm: "rounded-sm bg-ink px-2.5 py-1 text-[11.5px] font-semibold text-paper hover:bg-ink-2 disabled:opacity-40",
  secondary: "rounded-sm border border-line bg-panel px-3 py-2 text-[12.5px] font-medium text-ink-2 hover:bg-sunken disabled:opacity-40",
  secondarySm: "rounded-sm border border-line bg-panel px-2.5 py-1.5 text-[11.5px] font-medium text-ink-2 hover:bg-sunken disabled:opacity-40",
  chip: "rounded-sm border border-line bg-panel px-2 py-1 text-[11.5px] text-ink-2 hover:bg-sunken disabled:opacity-40",
  ghost: "rounded-sm px-2 py-1 text-[11.5px] text-ink-3 hover:bg-sunken hover:text-ink",
};

export function Button({
  variant = "secondary",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BTN }) {
  return <button {...rest} className={`transition-colors ${BTN[variant]} ${className}`} />;
}

export function IconBtn({
  label,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Tooltip.Root delayDuration={300}>
      <Tooltip.Trigger asChild>
        <button
          aria-label={label}
          {...rest}
          className={`rounded-sm p-1 text-mute transition-colors hover:bg-sunken hover:text-ink ${className}`}
        />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="bottom" className="z-50 rounded-sm border border-line bg-panel px-2 py-1 text-[11px] text-ink-2 shadow-md">
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

// Status pills — outline only, tone carries the state; pulse = live.
const PILL: Record<string, string> = {
  connected: "text-good border-good/40",
  done: "text-good border-good/40",
  success: "text-good border-good/40",
  resolved: "text-good border-good/40",
  running: "text-accent-2 border-accent-2/40 animate-pulse",
  syncing: "text-accent-2 border-accent-2/40 animate-pulse",
  open: "text-accent-2 border-accent-2/40",
  firing: "text-bad border-bad/40",
  failed: "text-bad border-bad/40",
  error: "text-bad border-bad/40",
  sev1: "text-bad border-bad/40",
  critical: "text-bad border-bad/40",
  warning: "text-warn border-warn/40",
  sev2: "text-warn border-warn/40",
  sev3: "text-ink-3 border-line",
  sev4: "text-ink-3 border-line",
  info: "text-ink-3 border-line",
  queued: "text-ink-3 border-line",
  neutral: "text-mute border-line",
};

export function Pill({ tone, children }: { tone: string; children?: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${PILL[tone] ?? PILL.neutral}`}>
      {children ?? tone}
    </span>
  );
}

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={`w-full rounded-sm border border-line bg-paper px-3 py-2 text-[12.5px] text-ink outline-none placeholder:text-mute focus:border-line ${className}`}
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  className = "",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={`rounded-sm border border-line bg-paper px-2 py-1.5 text-[11.5px] text-ink-2 outline-none hover:bg-sunken ${className}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Menu({
  trigger,
  items,
}: {
  trigger: ReactNode;
  items: { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean }[];
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-[140px] rounded-lg border border-line bg-panel p-1 shadow-2xl"
        >
          {items.map((it) => (
            <DropdownMenu.Item
              key={it.label}
              disabled={it.disabled}
              onSelect={it.onSelect}
              className={`cursor-pointer rounded-sm px-2.5 py-1.5 text-[12px] outline-none transition-colors ${
                it.danger
                  ? "text-ink-3 data-[highlighted]:bg-bad/10 data-[highlighted]:text-bad"
                  : "text-ink-2 data-[highlighted]:bg-sunken data-[highlighted]:text-ink"
              } data-[disabled]:opacity-40`}
            >
              {it.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  children,
  wide,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          className={`fixed left-1/2 top-1/2 z-50 max-h-[85vh] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-line bg-panel p-5 shadow-2xl ${
            wide ? "w-[860px]" : "w-[440px]"
          }`}
        >
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-[15px] font-semibold text-ink">{title}</Dialog.Title>
            <Dialog.Close className="text-mute transition-colors hover:text-ink">
              <X size={16} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function EmptyState({
  title,
  body,
  actions,
}: {
  title: string;
  body: string;
  actions?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center">
      <div className="text-[13.5px] font-medium text-ink">{title}</div>
      <div className="mx-auto mt-1.5 max-w-xs text-[12.5px] leading-relaxed text-ink-3">{body}</div>
      {actions && <div className="mt-4 flex justify-center gap-2">{actions}</div>}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-10 text-[12px] text-mute">
      <div className="probe-bar h-1 w-28 rounded-full bg-sunken" />
      {label}
    </div>
  );
}

export function TabBar({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-line-soft">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`group relative rounded-t-sm px-3 py-2 text-[12.5px] transition-colors ${
            active === t.id ? "text-ink" : "text-ink-3 hover:text-ink-2"
          }`}
        >
          {t.label}
          {active === t.id && (
            <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-accent" />
          )}
        </button>
      ))}
    </div>
  );
}
