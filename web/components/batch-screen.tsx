"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";

import {
  ApiRequestError,
  type BatchEvent,
  type BatchItemView,
  type BatchSummary,
  type TemplateSummary,
} from "@/lib/types";
import { buildBatchCommand, formatCost, validateContexts } from "@/lib/utils";
import { describeApiError, useConsole } from "./console-context";
import {
  Button,
  Callout,
  CliBar,
  EmptyState,
  Icon,
  Loading,
  Panel,
  Pill,
  ScreenHead,
  Switch,
} from "./ui";

function pendingItem(index: number): BatchItemView {
  return { index, state: "pending", requestId: null, model: null, usage: null, durationMs: 0, error: null };
}

export function BatchScreen({ templates }: { templates: TemplateSummary[] }) {
  const [template, setTemplate] = useState(templates[0]?.name ?? "");
  const [contextsText, setContextsText] = useState("[]");
  const [concurrency, setConcurrency] = useState(1);
  const [failFast, setFailFast] = useState(false);
  const [save, setSave] = useState(true);
  const [running, setRunning] = useState(false);
  const [items, setItems] = useState<BatchItemView[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [error, setError] = useState<{ code: string; message: string; hint?: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const { apiFetch, notify, ready } = useConsole();
  const validation = useMemo(() => validateContexts(contextsText), [contextsText]);
  const command = buildBatchCommand(template, concurrency, failFast, save);

  const processEvent = (event: BatchEvent) => {
    if (event.type === "batch.start") {
      setBatchId(event.batchId);
    } else if (event.type === "item.start") {
      setItems((current) => current.map((item) => item.index === event.index ? { ...item, state: "running" } : item));
    } else if (event.type === "item.finish") {
      setItems((current) => current.map((item) => item.index === event.index ? {
        ...item,
        state: event.ok ? "ok" : "error",
        requestId: event.requestId,
        model: event.model,
        usage: event.usage,
        durationMs: event.durationMs,
        error: event.error,
      } : item));
    } else if (event.type === "item.skip") {
      setItems((current) => current.map((item) => item.index === event.index ? { ...item, state: "skipped", error: { code: "skipped", message: event.reason } } : item));
    } else if (event.type === "batch.finish") {
      setSummary(event.summary);
    } else if (event.type === "batch.error") {
      setError(event.error);
    }
  };

  const execute = async () => {
    if (running || validation.error || validation.contexts.length === 0 || !template) return;
    setRunning(true);
    setError(null);
    setSummary(null);
    setBatchId(null);
    setItems(validation.contexts.map((_, index) => pendingItem(index)));
    const controller = new AbortController();
    abort.current = controller;
    try {
      const response = await apiFetch("/api/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateName: template, contexts: validation.contexts, concurrency, failFast, save }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json() as { error?: { code?: string; message?: string; hint?: string } };
        throw new ApiRequestError(body.error?.code ?? "batch_error", body.error?.message ?? "No se pudo ejecutar el lote", body.error?.hint, response.status);
      }
      if (!response.body) throw new Error("El servidor no devolvió el stream NDJSON del lote");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) processEvent(JSON.parse(line) as BatchEvent);
      }
      buffer += decoder.decode();
      if (buffer.trim()) processEvent(JSON.parse(buffer) as BatchEvent);
      notify("Lote finalizado");
    } catch (caught) {
      setError(describeApiError(caught));
      if (controller.signal.aborted) {
        setItems((current) => current.map((item) => ["pending", "running"].includes(item.state) ? { ...item, state: "skipped", error: { code: "cancelled", message: "Omitido al cancelar; las filas ya escritas se conservan." } } : item));
      }
    } finally {
      setRunning(false);
      abort.current = null;
    }
  };

  return (
    <section>
      <ScreenHead eyebrow="Biblioteca · jev batch" title="Lotes" description={<>Una plantilla y un array de contextos: una petición real por mapa, con pool de concurrencia y el mismo <code>batch_id</code> generado en el servidor.</>} />
      {error ? <div className="mt-12"><Callout tone="danger"><strong>{error.code}</strong>: {error.message}{error.hint ? <><br /><strong>pista:</strong> {error.hint}</> : null}</Callout></div> : null}
      <div className="grid grid-batch">
        <Panel title="Configuración del lote">
          <div className="stack" style={{ gap: 12 }}>
            {templates.length === 0 ? <Callout>No hay plantillas. <Link className="link" href="/plantillas?new=1">Crear una plantilla</Link> antes de ejecutar un lote.</Callout> : null}
            <div className="field"><label htmlFor="batch-template">Plantilla</label><select id="batch-template" className="select mono" value={template} onChange={(event) => setTemplate(event.target.value)} disabled={running || templates.length === 0}>{templates.map((item) => <option value={item.name} key={item.name}>{item.name}</option>)}</select></div>
            <div className="field"><label htmlFor="batch-contexts">Contextos (array JSON)</label><textarea id="batch-contexts" className="textarea" rows={11} spellCheck={false} value={contextsText} onChange={(event) => setContextsText(event.target.value)} disabled={running} /><p className={`hint${validation.error ? " form-error" : ""}`}>{validation.error ?? `${validation.contexts.length} contextos válidos · máximo 1.000`}{validation.invalid.length ? ` Ítems inválidos: ${validation.invalid.map((index) => index + 1).join(", ")}.` : ""}</p></div>
            <div className="inline-fields">
              <div className="field"><span className="label" id="concurrency-label">Concurrencia</span><div className="stepper" aria-labelledby="concurrency-label"><button type="button" aria-label="Reducir concurrencia" disabled={running || concurrency <= 1} onClick={() => setConcurrency((value) => Math.max(1, value - 1))}>−</button><output>{concurrency}</output><button type="button" aria-label="Aumentar concurrencia" disabled={running || concurrency >= 10} onClick={() => setConcurrency((value) => Math.min(10, value + 1))}>+</button></div></div>
              <div className="field" style={{ flex: "1 1 190px" }}><span className="label">Ante el primer error</span><div style={{ height: 32, display: "flex", alignItems: "center" }}><Switch checked={failFast} onChange={setFailFast} disabled={running} label="Detenerse (fail-fast)" /></div></div>
            </div>
            <Switch checked={save} onChange={setSave} disabled={running} label="Guardar en historial" />
            <p className="hint">Por defecto <code>--continue-on-error</code>. Al cancelar se abortan las peticiones en vuelo y no se programa ningún item nuevo.</p>
            <div className="action-row">
              <Button variant="primary" className="w-full" onClick={() => void execute()} disabled={!ready || running || Boolean(validation.error) || validation.contexts.length === 0 || !template}><Icon name="play" />{running ? "Ejecutando lote…" : "Ejecutar lote"}</Button>
              {running ? <Button variant="danger" className="w-full" onClick={() => abort.current?.abort()}><Icon name="stop" />Cancelar y conservar filas escritas</Button> : null}
            </div>
          </div>
        </Panel>

        <Panel title="Ejecución" action={<span className="mono text-muted" style={{ fontSize: 10.5 }}>{batchId ? <Link className="link" href={`/historial?batch=${encodeURIComponent(batchId)}`} title="Filtrar historial por batch">{batchId}</Link> : "sin batch"}</span>} tight>
          <div className="panel-body">
            {running ? <div style={{ marginBottom: 12 }}><Loading label="Progreso NDJSON en tiempo real" /></div> : null}
            {!running && items.length === 0 ? <EmptyState title="Sin ejecuciones todavía">Configura una plantilla y contextos reales. Los items conservan el orden del array aunque terminen en otro orden.</EmptyState> : null}
            {items.length > 0 ? <div style={{ margin: -14 }}>{items.map((item) => <div className="batch-item" key={item.index}>
              <span className="b-idx">{item.index + 1}</span>
              <div className="b-body"><div className="b-title"><strong>contexto #{item.index + 1}</strong><Pill tone={item.state === "ok" ? "ok" : item.state === "error" ? "err" : item.state === "running" ? "info" : "neutral"}>{item.state}</Pill>{item.requestId ? <Link className="link mono" href={`/historial?id=${item.requestId}`}>#{item.requestId}</Link> : null}</div><span className="b-sub">{item.model ?? "modelo —"} · {item.usage ? `${item.usage.inputTokens} in / ${item.usage.outputTokens} out · coste ${formatCost(item.usage.cost)}` : "tokens —"}{item.durationMs ? ` · ${item.durationMs} ms` : ""}</span>{item.error ? <span className="b-error">{item.error.message}{item.error.hint ? ` · pista: ${item.error.hint}` : ""}</span> : null}</div>
              <span className="cell-muted">{item.state === "running" ? <span className="spinner" aria-label="En ejecución" /> : item.state === "ok" ? <Icon name="check" /> : null}</span>
            </div>)}</div> : null}
          </div>
          {summary ? <div className="summary-grid">
            <div><div className="k">Correctas</div><div className="v">{summary.ok}</div></div>
            <div><div className="k">Errores / omitidos</div><div className="v">{summary.errors} / {summary.skipped}</div></div>
            <div><div className="k">Tokens in / out</div><div className="v">{summary.inputTokens} / {summary.outputTokens}</div></div>
            <div><div className="k">Coste</div><div className="v">{formatCost(summary.cost)}<div className="hint">{summary.costUnknown} sin informar</div></div></div>
          </div> : null}
        </Panel>
      </div>
      <CliBar command={command} />
    </section>
  );
}
