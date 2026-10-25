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
    ["jev demo", "ejemplo integrado"],
    ["jev ask --state - --questions-file q.json", "state por stdin"],
    ["jev batch pedido --contexts examples/contexts.json", "lote por contextos"],
  ];

  return (
    <section>
      <ScreenHead
        eyebrow={`Sesión local · iniciada con ${data.launchCommand}`}
        title="Resumen"
        description="Estado del provider, actividad reciente y accesos directos. Todo lo que ves aquí procede de Jev o de la misma base SQLite que usa la CLI."
        actions={<>
          <Button onClick={() => void refresh()} disabled={refreshing}><Icon name="refresh" />Actualizar</Button>
          <Button variant="primary" onClick={() => router.push("/evaluar")}><Icon name="check" />Nueva evaluación</Button>
        </>}
      />

      {!data.provider.apiKeyMasked || data.provider.apiKeyMasked === "—" ? (
        <div className="mt-12"><Callout>No hay una API key efectiva. <Link href="/configuracion" className="link">Configurar provider</Link>. La navegación y la biblioteca siguen disponibles.</Callout></div>
      ) : null}
      {error ? <div className="mt-12"><Callout tone="danger"><strong>{error.code}</strong>: {error.message}{error.hint ? <><br /><strong>pista:</strong> {error.hint}</> : null}</Callout></div> : null}

      <div className="stats" aria-busy={refreshing}>
        <Stat label="Peticiones en requests" value={data.stats.total} note={`${Math.min(data.stats.total, data.stats.window)} en la ventana de ${data.stats.window}`} />
        <Stat label={`Tasa de éxito · últimas ${data.stats.window}`} value={`${data.stats.successRate.toFixed(1)}%`} note={`${data.stats.ok} ok · ${data.stats.errors} con error`} />
        <Stat label="Tokens · ventana" value={<>{data.stats.inputTokens}<small>in</small></>} note={`${data.stats.outputTokens} out · informados por la API`} />
        <Stat label="Coste acumulado · ventana" value={formatCost(data.stats.cost)} note={`${data.stats.costUnknown} sin coste informado`} />
      </div>
      <div className="row-between" style={{ margin: "-8px 0 14px" }}>
        <span className="hint">Las métricas (salvo el total) usan las últimas peticiones, no un periodo temporal.</span>
        <label className="row hint">Ventana <select className="select mono" style={{ width: 82 }} aria-label="Ventana de métricas" value={data.stats.window} onChange={(event) => void setWindow(Number(event.target.value))}><option>30</option><option>50</option><option>100</option><option>200</option></select></label>
      </div>

      <div className="grid grid-resumen">
        <div className="stack">
          <Panel title="Últimas peticiones" action={<Link href="/historial" className="btn btn-ghost btn-sm">Ver historial completo →</Link>} tight>
            {data.recent.length === 0 ? <EmptyState title="Todavía no hay peticiones" action={<Link href="/evaluar" className="btn btn-primary btn-sm">Evaluar o ejecutar demo</Link>}>El historial real aparecerá después de la primera ejecución guardada.</EmptyState> : (
              <div className="table-wrap"><table className="dt" aria-label="Últimas peticiones">
                <thead><tr><th>Hora</th><th>Estado</th><th>Modelo</th><th>Plantilla</th><th className="num">Tokens</th><th className="num">Coste</th><th className="num">Duración</th></tr></thead>
                <tbody>{data.recent.map((record) => (
                  <tr key={record.id} className="clickable" tabIndex={0} aria-label={`Abrir petición ${record.id}`} onClick={() => router.push(`/historial?id=${record.id}`)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); router.push(`/historial?id=${record.id}`); } }}>
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
          <Panel title="Atajos equivalentes" action={<span className="mono text-muted" style={{ fontSize: 10.5 }}>CLI</span>}>
            <div className="stack" style={{ gap: 8 }}>{shortcuts.map(([command, note]) => <div className="row" key={command}><code className="mono" style={{ fontSize: 11.5, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{command}</code><span className="hint">{note}</span><IconButton label={`Copiar ${command}`} onClick={() => void copy(command)}><Icon name="copy" /></IconButton></div>)}</div>
          </Panel>
        </div>

        <div className="stack">
          <Panel title="Provider" action={<Pill tone={data.provider.status === "ok" ? "ok" : data.provider.status === "error" ? "err" : "neutral"}>{data.provider.status === "ok" ? "conectado" : data.provider.status === "error" ? "error" : "desconocido"}</Pill>}>
            <KvList items={[
              ["endpoint", <span className="code-value" key="endpoint">{data.provider.endpoint}</span>],
              ["modelo", <span className="code-value" key="model">{data.provider.model}</span>],
              ["api_key", <span className="code-value" key="key">{data.provider.apiKeyMasked || "—"} · {sourceLabel(data.provider.apiKeySource)}</span>],
              ["timeout", <span className="code-value" key="timeout">{data.provider.timeoutMs / 1000} s</span>],
              ["reintentos", <span className="code-value" key="retries">{data.provider.retries}</span>],
            ]} />
            <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "12px 0" }} />
            <p className="hint" style={{ marginBottom: 10 }}>La prueba consume una petición real mínima y nunca se guarda en el historial.</p>
            <div className="row-between">
              <Button size="sm" onClick={() => void check()} disabled={checking}>{checking ? "Comprobando…" : "Probar conexión"}</Button>
              {checking ? <Loading label="petición en curso" /> : <span className="status-text">{checkResult ? `${checkResult.statusCode ?? "error"} · ${checkResult.latencyMs} ms` : "sin comprobar"}</span>}
            </div>
          </Panel>
          <Panel title="Esta sesión">
            <KvList items={[
              ["lanzada por", <span className="code-value" key="launch">{data.launchCommand}</span>],
              ["escucha en", <span className="code-value" key="listen">{data.listen.host}:{data.listen.port}</span>],
              ["base", <span className="code-value" key="db">{data.dbPath}</span>],
              ["historial", <span key="history">se guarda salvo con <code>--no-save</code></span>],
              ["versión", <span className="code-value" key="version">v{data.version}</span>],
              ["esquema", <span className="code-value" key="schema">{data.schemaVersion}</span>],
            ]} />
          </Panel>
          <Button className="w-full" onClick={() => router.push("/historial")}>Consultar actividad real</Button>
        </div>
      </div>
      <CliBar command="jev history list --limit 5" />
    </section>
  );
}

function sourceLabel(source: Overview["provider"]["apiKeySource"]): string {
  return { flag: "flag", env: "entorno", sqlite: "SQLite", default: "defecto" }[source];
}
