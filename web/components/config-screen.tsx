"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import type { ConfigEntryDto, ConfigKey, ConfigSnapshot } from "@/lib/types";
import { shellQuote } from "@/lib/utils";
import { describeApiError, useConsole } from "./console-context";
import { ConfirmModal } from "./modal";
import {
  Button,
  Callout,
  CliBar,
  Icon,
  IconButton,
  KvList,
  Panel,
  ScreenHead,
} from "./ui";

function formValues(snapshot: ConfigSnapshot): Record<ConfigKey, string> {
  return Object.fromEntries(snapshot.entries.map((entry) => [entry.key, entry.value === null ? "" : String(entry.value)])) as Record<ConfigKey, string>;
}

function entry(snapshot: ConfigSnapshot, key: ConfigKey): ConfigEntryDto {
  const found = snapshot.entries.find((item) => item.key === key);
  if (!found) throw new Error(`Falta ${key} en el DTO de configuración`);
  return found;
}

function validate(values: Record<ConfigKey, string>): string[] {
  const errors: string[] = [];
  if (values.api_url) {
    try {
      const url = new URL(values.api_url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("protocolo");
    } catch {
      errors.push("api_url debe ser una URL completa http(s)://…");
    }
  }
  if (values.timeout && (!Number.isFinite(Number(values.timeout)) || Number(values.timeout) <= 0)) errors.push("timeout debe ser un número positivo en segundos.");
  if (values.retries && (!Number.isInteger(Number(values.retries)) || Number(values.retries) < 0)) errors.push("retries debe ser un entero ≥ 0.");
  if (values.model && !values.model.trim()) errors.push("model no puede contener solo espacios.");
  return errors;
}

export function ConfigScreen({ initialSnapshot }: { initialSnapshot: ConfigSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [values, setValues] = useState(() => formValues(initialSnapshot));
  const [dirty, setDirty] = useState<Set<ConfigKey>>(new Set());
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [lastCommand, setLastCommand] = useState("jev config list --json");
  const { request, copy, notify } = useConsole();
  const router = useRouter();
  const errors = useMemo(() => validate(values), [values]);

  const update = (key: ConfigKey, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty((current) => new Set(current).add(key));
    setLastCommand(value === "" ? `jev config unset ${key}` : `jev config set ${key} ${shellQuote(value)}`);
  };

  const reveal = async () => {
    if (revealed) {
      setRevealed(false);
      setValues((current) => ({ ...current, api_key: entry(snapshot, "api_key").masked }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await request<{ value: string }>("/api/config/api_key/reveal", { method: "POST", body: "{}" });
      setValues((current) => ({ ...current, api_key: result.value }));
      setRevealed(true);
      notify("API key revelada solo en este formulario; no se guarda en localStorage");
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (dirty.size === 0 || errors.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const changes = Object.fromEntries([...dirty].map((key) => [key, values[key]]));
      const next = await request<ConfigSnapshot>("/api/config", { method: "PUT", body: JSON.stringify(changes) });
      setSnapshot(next);
      setValues(formValues(next));
      setDirty(new Set());
      setRevealed(false);
      notify("Configuración guardada en SQLite");
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await request<ConfigSnapshot>("/api/config/reset", { method: "POST", body: "{}" });
      setSnapshot(next);
      setValues(formValues(next));
      setDirty(new Set());
      setRevealed(false);
      setResetOpen(false);
      setLastCommand("jev config list --json");
      notify("Valores SQLite eliminados; vuelve a aplicar entorno y defaults");
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setSaving(false);
    }
  };

  const source = (key: ConfigKey) => entry(snapshot, key).source;
  const readOnly = (key: ConfigKey) => !entry(snapshot, key).editable;

  return (
    <section>
      <ScreenHead
        eyebrow="Sistema · jev config"
        title="Configuración"
        description={<>Precedencia: <strong>flag &gt; entorno &gt; SQLite &gt; defecto</strong>. Las cadenas vacías hacen <code>unset</code>; no se escriben defaults al restablecer.</>}
        actions={<Button variant="primary" onClick={() => void save()} disabled={saving || dirty.size === 0 || errors.length > 0}>{saving ? "Guardando…" : `Guardar cambios${dirty.size ? ` (${dirty.size})` : ""}`}</Button>}
      />
      {error ? <div className="mt-12"><Callout tone="danger">{error.message}{error.hint ? <><br /><strong>pista:</strong> {error.hint}</> : null}</Callout></div> : null}
      <div className="grid grid-config">
        <div className="stack">
          <Panel title="Provider" action={<span className="mono text-muted" style={{ fontSize: 10.5 }}>tabla config</span>}>
            <div className="stack" style={{ gap: 12 }}>
              <ConfigField label="api_url · endpoint completo" keyName="api_url" value={values.api_url} source={source("api_url")} readOnly={readOnly("api_url")} onChange={update} />
              <div className="field">
                <label htmlFor="config-api_key">api_key</label>
                <div className="row" style={{ gap: 8 }}><input id="config-api_key" className="input mono" spellCheck={false} autoComplete="off" value={values.api_key} readOnly={readOnly("api_key")} onChange={(event) => update("api_key", event.target.value)} /><Button size="sm" onClick={() => void reveal()} disabled={saving || dirty.has("api_key")} title={dirty.has("api_key") ? "Guarda o descarta la nueva key antes de revelar" : "Revelado explícito con Cache-Control: no-store"}>{revealed ? "Ocultar" : "Revelar"}</Button></div>
                <p className="hint">origen: {sourceLabel(source("api_key"))}{readOnly("api_key") ? " · solo lectura por flag" : ""}</p>
                <Callout>La key se guarda <strong>en claro</strong> en SQLite. Para no persistirla, usa <code>--key</code> o <code>OPENCODE_API_KEY</code>/<code>JEV_API_KEY</code>. Nunca se usa localStorage.</Callout>
              </div>
              <div className="inline-fields">
                <ConfigField label="model · valor libre" keyName="model" value={values.model} source={source("model")} readOnly={readOnly("model")} onChange={update} />
                <ConfigField label="timeout (s)" keyName="timeout" value={values.timeout} source={source("timeout")} readOnly={readOnly("timeout")} onChange={update} type="number" />
                <ConfigField label="retries" keyName="retries" value={values.retries} source={source("retries")} readOnly={readOnly("retries")} onChange={update} type="number" />
              </div>
              {errors.length ? <div className="form-error" role="alert">{errors.map((message) => <p key={message}>{message}</p>)}</div> : <p className="hint">Valores válidos. Solo se envían las claves modificadas.</p>}
              <div className="row-between"><span className="hint">{dirty.size ? `${dirty.size} claves modificadas` : "Sin cambios"}</span><Button variant="ghost" size="sm" onClick={() => setResetOpen(true)}>Restablecer por defecto</Button></div>
            </div>
          </Panel>
          <Panel title="Petición HTTP">
            <KvList items={[["reintenta en", "429, 5xx y errores de red"], ["backoffMs", <span className="code-value" key="backoff">500 ms</span>], ["tope Retry-After", <span className="code-value" key="retry">10 s</span>], ["401", "no se reintenta"]]} />
            <div className="mt-12"><Callout tone="info">El Retry-After se capa a 10 s. Los reintentos se cuentan por intento HTTP, no por pregunta.</Callout></div>
          </Panel>
        </div>

        <div className="stack">
          <Panel title="Precedencia resuelta" tight>
            {snapshot.entries.map((item) => <div className="prec-row" key={item.key}><span className="k">{item.key}</span><span className="v" title={item.masked}>{item.masked || "—"}</span><span className={`chip${item.source === "flag" ? "" : " chip-soft"}`}>{sourceLabel(item.source)}{!item.editable ? " · bloqueada" : ""}</span></div>)}
            <div className="panel-body"><p className="hint">flag fija solo esta sesión. Un valor de entorno permite editar SQLite, pero seguirá teniendo prioridad hasta retirar la variable.</p></div>
          </Panel>
          <Panel title="Base de datos" action={<span className="pill pill-info">esquema {snapshot.database.schemaVersion}</span>}>
            <div className="row" style={{ gap: 6 }}><code className="code-value" style={{ flex: 1 }}>{snapshot.database.path}</code><IconButton label="Copiar ruta" onClick={() => void copy(snapshot.database.path)}><Icon name="copy" /></IconButton></div>
            <div className="mt-12"><KvList items={[["permisos", <span className="code-value" key="permissions">{snapshot.database.directoryMode} / {snapshot.database.fileMode}</span>], ["migraciones", <span className="code-value" key="migrations">PRAGMA user_version</span>], ["tablas", <span className="code-value" key="tables">{snapshot.database.tables.join(" · ")}</span>]]} /></div>
            <p className="hint mt-12">La CLI y Next comparten conexión lógica, migraciones y repositorios parametrizados sobre esta misma base.</p>
          </Panel>
          <Panel title="Códigos de salida">
            <div className="stack" style={{ gap: 7 }}>{[["0", "correcto"], ["1", "error de API, red o configuración"], ["2", "uso incorrecto"]].map(([code, label]) => <div className="row-between" key={code}><span className="mono">{code}</span><span className="text-muted">{label}</span></div>)}</div>
          </Panel>
        </div>
      </div>
      <CliBar command={lastCommand} />
      {resetOpen ? <ConfirmModal title="Restablecer configuración" description="Se hará unset de las claves editables en SQLite. No se escriben valores por defecto y no se tocan flags de esta sesión; entorno y defaults vuelven a aplicar según la precedencia." confirmLabel="Restablecer" busy={saving} onClose={() => setResetOpen(false)} onConfirm={() => void reset()} /> : null}
    </section>
  );
}

function ConfigField({ label, keyName, value, source, readOnly, onChange, type = "text" }: {
  label: string;
  keyName: ConfigKey;
  value: string;
  source: ConfigEntryDto["source"];
  readOnly: boolean;
  onChange(key: ConfigKey, value: string): void;
  type?: "text" | "number";
}) {
  return <div className="field"><label htmlFor={`config-${keyName}`}>{label}</label><input id={`config-${keyName}`} className="input mono" type={type} min={keyName === "retries" ? 0 : keyName === "timeout" ? 0.001 : undefined} step={keyName === "retries" ? 1 : "any"} value={value} readOnly={readOnly} onChange={(event) => onChange(keyName, event.target.value)} /><p className="hint">origen: {sourceLabel(source)}{readOnly ? " · cambio en SQLite sin efecto esta sesión" : ""}</p></div>;
}

function sourceLabel(source: ConfigEntryDto["source"]): string {
  return { flag: "flag", env: "entorno", sqlite: "SQLite", default: "defecto" }[source];
}
