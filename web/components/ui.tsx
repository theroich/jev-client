"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

import { useConsole } from "./console-context";

export type IconName =
  | "overview"
  | "evaluate"
  | "batch"
  | "templates"
  | "history"
  | "config"
  | "copy"
  | "search"
  | "plus"
  | "close"
  | "check"
  | "warning"
  | "download"
  | "refresh"
  | "terminal"
  | "play"
  | "stop"
  | "trash"
  | "upload"
  | "chevron";

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    overview: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
    evaluate: <path d="M3 12h3.5l2.5-6.5 4 13 2.5-6.5H21" />,
    batch: <><path d="M12 3.5l8 4.2-8 4.2-8-4.2 8-4.2z" /><path d="M4 12.5l8 4.2 8-4.2M4 16.8l8 4.2 8-4.2" /></>,
    templates: <><path d="M9 3.5H7.5A2.5 2.5 0 0 0 5 6v3.2A1.8 1.8 0 0 1 3.2 11 1.8 1.8 0 0 1 5 12.8V18a2.5 2.5 0 0 0 2.5 2.5H9" /><path d="M15 3.5h1.5A2.5 2.5 0 0 1 19 6v3.2a1.8 1.8 0 0 0 1.8 1.8 1.8 1.8 0 0 0-1.8 1.8V18a2.5 2.5 0 0 1-2.5 2.5H15" /></>,
    history: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 1.8" /></>,
    config: <><path d="M4 8h9M18.5 8H20M4 16h3M12 16h8" /><circle cx="15.2" cy="8" r="2.2" /><circle cx="9" cy="16" r="2.2" /></>,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 6.5V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h1.5" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l4.5 4.5" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="M6 6l12 12M18 6L6 18" />,
    check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
    warning: <><path d="M12 4.5l8 14H4l8-14z" /><path d="M12 10v3.5M12 16.2v.1" /></>,
    download: <><path d="M12 4v10M8 10.5l4 4 4-4" /><path d="M5 18.5h14" /></>,
    refresh: <><path d="M20 7v5h-5" /><path d="M18.5 16a8 8 0 1 1 1.2-7L20 12" /></>,
    terminal: <path d="M9.5 8.5L6 12l3.5 3.5M14.5 8.5L18 12l-3.5 3.5" />,
    play: <path d="M8 5l11 7-11 7V5z" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></>,
    upload: <><path d="M12 16V5M8 8.5L12 4.5l4 4" /><path d="M5 14.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3.5" /></>,
    chevron: <path d="M9 6l6 6-6 6" />,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      width={size}
      height={size}
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function Button({
  variant = "outline",
  size,
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost" | "danger";
  size?: "sm";
}) {
  return (
    <button
      type={type}
      className={`btn btn-${variant}${size ? " btn-sm" : ""}${className ? ` ${className}` : ""}`}
      {...props}
    />
  );
}

export function IconButton({
  label,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" className={`icon-btn ${className}`} aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

export function Panel({
  title,
  action,
  children,
  className = "",
  tight = false,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  tight?: boolean;
}) {
  return (
    <section className={`panel ${className}`}>
      {title !== undefined || action !== undefined ? (
        <div className="panel-head">
          <span className="panel-title">{title}</span>
          {action}
        </div>
      ) : null}
      <div className={`panel-body${tight ? " tight" : ""}`}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, note }: { label: string; value: ReactNode; note: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-note">{note}</div>
    </div>
  );
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "ok" | "warn" | "err" | "info" | "neutral" }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function StatusPill({ status, ok }: { status: number | null; ok: boolean }) {
  return <Pill tone={ok ? "ok" : status === 429 ? "warn" : "err"}>{status ?? "network"}</Pill>;
}

export function CliBar({ command }: { command: string }) {
  const { copy } = useConsole();
  return (
    <div className="cli-bar">
      <span className="cli-label">CLI equivalent</span>
      <code><span className="prompt">$</span>{command}</code>
      <IconButton label="Copy command" onClick={() => void copy(command)}>
        <Icon name="copy" />
      </IconButton>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name="overview" size={22} />
      <strong>{title}</strong>
      <span>{children}</span>
      {action}
    </div>
  );
}

export function Callout({ children, tone = "warn" }: { children: ReactNode; tone?: "warn" | "info" | "danger" }) {
  return (
    <div className={`callout${tone === "warn" ? "" : ` ${tone}`}`} role={tone === "danger" ? "alert" : undefined}>
      <Icon name={tone === "info" ? "terminal" : "warning"} />
      <span>{children}</span>
    </div>
  );
}

export function Loading({ label = "Loading live data…" }: { label?: string }) {
  return <div className="loading-line" role="status"><span className="spinner" aria-hidden="true" />{label}</div>;
}

export function Tabs({ items, value, onChange, label }: {
  items: Array<{ id: string; label: string }>;
  value: string;
  onChange(id: string): void;
  label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          type="button"
          role="tab"
          aria-selected={value === item.id}
          className="tab"
          key={item.id}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function JsonBlock({ value, className = "" }: { value: unknown; className?: string }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "null";
  const nodes: ReactNode[] = [];
  const expression = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = expression.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const className = match[1] !== undefined
      ? match[2] !== undefined ? "json-key" : "json-str"
      : "json-num";
    nodes.push(<span className={className} key={`${match.index}-${index++}`}>{token}</span>);
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <pre className={`json ${className}`} tabIndex={0}>{nodes}</pre>;
}

export function ScreenHead({ eyebrow, title, description, actions }: {
  eyebrow: string;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="screen-head">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="sub">{description}</p>
      </div>
      {actions ? <div className="head-actions">{actions}</div> : null}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled = false }: {
  checked: boolean;
  onChange(checked: boolean): void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="switch" aria-hidden="true" />
      {label}
    </label>
  );
}

export function KvList({ items }: { items: Array<[string, ReactNode]> }) {
  return <dl className="kv">{items.map(([key, value]) => <div key={key} style={{ display: "contents" }}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>;
}
