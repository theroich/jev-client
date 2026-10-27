"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Overview } from "@/lib/types";
import { formatCost, formatTokens, relativeDate } from "@/lib/utils";
import { describeApiError, useConsole } from "./console-context";
import {
  Button,
  Callout,
  CliBar,
  EmptyState,
  Icon,
  IconButton,
  KvList,
  Loading,
  Panel,
  Pill,
  ScreenHead,
  Stat,
  StatusPill,
} from "./ui";

interface ProviderCheck {
  status: "ok" | "error";
  statusCode: number | null;
  latencyMs: number;
  model: string;
}

export function OverviewScreen({ initialData }: { initialData: Overview }) {
  const [data, setData] = useState(initialData);
  const [checking, setChecking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [checkResult, setCheckResult] = useState<ProviderCheck | null>(null);
  const [error, setError] = useState<{ code: string; message: string; hint?: string; details?: Record<string, unknown> } | null>(null);
  const { request, copy } = useConsole();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryHandled = useRef(false);

  const check = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    setError(null);
    setCheckResult(null);
    try {
      const result = await request<ProviderCheck>("/api/provider/check", { method: "POST", body: "{}" });
      setCheckResult(result);
      setData((current) => ({ ...current, provider: { ...current.provider, status: "ok" } }));
    } catch (caught) {
      const mapped = describeApiError(caught);
      setError(mapped);
      setCheckResult({
        status: "error",
        statusCode: typeof mapped.details?.providerStatus === "number" ? mapped.details.providerStatus : null,
        latencyMs: typeof mapped.details?.latencyMs === "number" ? mapped.details.latencyMs : 0,
        model: data.provider.model,
      });
      setData((current) => ({ ...current, provider: { ...current.provider, status: "error" } }));
    } finally {
      setChecking(false);
      router.refresh();
    }
  }, [checking, data.provider.model, request, router]);

  useEffect(() => {
    if (searchParams.get("check") !== "1" || queryHandled.current) return;
    queryHandled.current = true;
    router.replace("/", { scroll: false });
    void check();
  }, [check, router, searchParams]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const next = await request<Overview>(`/api/overview?window=${data.stats.window}`);
      setData(next);
      setError(null);
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setRefreshing(false);
    }
  };

  const setWindow = async (window: number) => {
    setRefreshing(true);
    try {
      const next = await request<Overview>(`/api/overview?window=${window}`);
      setData(next);
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setRefreshing(false);
    }
  };

  const shortcuts: Array<[string, string]> = [
    ["jev demo", "built-in example"],
    ["jev ask --state - --questions-file q.json", "state from stdin"],
    ["jev batch order --contexts examples/contexts.json", "batch by contexts"],
  ];

  return (
    <section>
      <ScreenHead
        eyebrow={`Local session · started with ${data.launchCommand}`}
        title="Overview"
        description="Provider status, recent activity and shortcuts. Everything you see here comes from Jev or from the same SQLite database the CLI uses."
        actions={<>
          <Button onClick={() => void refresh()} disabled={refreshing}><Icon name="refresh" />Refresh</Button>
          <Button variant="primary" onClick={() => router.push("/evaluate")}><Icon name="check" />New evaluation</Button>
        </>}
      />

      {!data.provider.apiKeyMasked || data.provider.apiKeyMasked === "—" ? (
        <div className="mt-12"><Callout>There is no effective API key. <Link href="/settings" className="link">Configure provider</Link>. Navigation and the library remain available.</Callout></div>
      ) : null}
      {error ? <div className="mt-12"><Callout tone="danger"><strong>{error.code}</strong>: {error.message}{error.hint ? <><br /><strong>hint:</strong> {error.hint}</> : null}</Callout></div> : null}

      <div className="stats" aria-busy={refreshing}>
        <Stat label="Requests recorded" value={data.stats.total} note={`${Math.min(data.stats.total, data.stats.window)} in the last ${data.stats.window}`} />
        <Stat label={`Success rate · last ${data.stats.window}`} value={`${data.stats.successRate.toFixed(1)}%`} note={`${data.stats.ok} ok · ${data.stats.errors} with errors`} />
        <Stat label="Tokens · window" value={<>{data.stats.inputTokens}<small>in</small></>} note={`${data.stats.outputTokens} out · reported by the API`} />
        <Stat label="Accumulated cost · window" value={formatCost(data.stats.cost)} note={`${data.stats.costUnknown} without reported cost`} />
      </div>
      <div className="row-between" style={{ margin: "-8px 0 14px" }}>
        <span className="hint">Metrics (except the total) use the latest requests, not a time period.</span>
        <label className="row hint">Window <select className="select mono" style={{ width: 82 }} aria-label="Metrics window" value={data.stats.window} onChange={(event) => void setWindow(Number(event.target.value))}><option>30</option><option>50</option><option>100</option><option>200</option></select></label>
      </div>

      <div className="grid grid-resumen">
        <div className="stack">
          <Panel title="Latest requests" action={<Link href="/history" className="btn btn-ghost btn-sm">View full history →</Link>} tight>
            {data.recent.length === 0 ? <EmptyState title="No requests yet" action={<Link href="/evaluate" className="btn btn-primary btn-sm">Evaluate or run the demo</Link>}>Real history appears after the first saved run.</EmptyState> : (
              <div className="table-wrap"><table className="dt" aria-label="Latest requests">
                <thead><tr><th>Time</th><th>Status</th><th>Model</th><th>Template</th><th className="num">Tokens</th><th className="num">Cost</th><th className="num">Duration</th></tr></thead>
                <tbody>{data.recent.map((record) => (
                  <tr key={record.id} className="clickable" tabIndex={0} aria-label={`Open request ${record.id}`} onClick={() => router.push(`/history?id=${record.id}`)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); router.push(`/history?id=${record.id}`); } }}>
                    <td className="cell-muted mono" style={{ fontSize: 11.5 }} suppressHydrationWarning>{relativeDate(record.createdAt)}</td>
                    <td><StatusPill status={record.statusCode} ok={record.ok} /></td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{record.model ?? "—"}</td>
                    <td>{record.templateName ? <span className="chip chip-soft">{record.templateName}</span> : <span className="cell-muted">—</span>}</td>
                    <td className="num">{formatTokens(record.inputTokens, record.outputTokens)}</td>
                    <td className="num">{formatCost(record.cost)}</td>
                    <td className="num">{record.durationMs === null ? "—" : `${record.durationMs} ms`}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </Panel>
          <Panel title="Equivalent shortcuts" action={<span className="mono text-muted" style={{ fontSize: 10.5 }}>CLI</span>}>
            <div className="stack" style={{ gap: 8 }}>{shortcuts.map(([command, note]) => <div className="row" key={command}><code className="mono" style={{ fontSize: 11.5, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{command}</code><span className="hint">{note}</span><IconButton label={`Copy ${command}`} onClick={() => void copy(command)}><Icon name="copy" /></IconButton></div>)}</div>
          </Panel>
        </div>

        <div className="stack">
          <Panel title="Provider" action={<Pill tone={data.provider.status === "ok" ? "ok" : data.provider.status === "error" ? "err" : "neutral"}>{data.provider.status === "ok" ? "connected" : data.provider.status === "error" ? "error" : "unknown"}</Pill>}>
            <KvList items={[
              ["endpoint", <span className="code-value" key="endpoint">{data.provider.endpoint}</span>],
              ["model", <span className="code-value" key="model">{data.provider.model}</span>],
              ["api_key", <span className="code-value" key="key">{data.provider.apiKeyMasked || "—"} · {sourceLabel(data.provider.apiKeySource)}</span>],
              ["timeout", <span className="code-value" key="timeout">{data.provider.timeoutMs / 1000} s</span>],
              ["retries", <span className="code-value" key="retries">{data.provider.retries}</span>],
            ]} />
            <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "12px 0" }} />
            <p className="hint" style={{ marginBottom: 10 }}>The test consumes one minimal real request and is never stored in history.</p>
            <div className="row-between">
              <Button size="sm" onClick={() => void check()} disabled={checking}>{checking ? "Checking…" : "Test connection"}</Button>
              {checking ? <Loading label="request in progress" /> : <span className="status-text">{checkResult ? `${checkResult.statusCode ?? "error"} · ${checkResult.latencyMs} ms` : "not checked"}</span>}
            </div>
          </Panel>
          <Panel title="This session">
            <KvList items={[
              ["launched by", <span className="code-value" key="launch">{data.launchCommand}</span>],
              ["listening on", <span className="code-value" key="listen">{data.listen.host}:{data.listen.port}</span>],
              ["database", <span className="code-value" key="db">{data.dbPath}</span>],
              ["history", <span key="history">saved unless <code>--no-save</code></span>],
              ["version", <span className="code-value" key="version">v{data.version}</span>],
              ["schema", <span className="code-value" key="schema">{data.schemaVersion}</span>],
            ]} />
          </Panel>
          <Button className="w-full" onClick={() => router.push("/history")}>Browse real activity</Button>
        </div>
      </div>
      <CliBar command="jev history list --limit 5" />
    </section>
  );
}

function sourceLabel(source: Overview["provider"]["apiKeySource"]): string {
  return { flag: "flag", env: "environment", sqlite: "SQLite", default: "default" }[source];
}
