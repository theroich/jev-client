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
  if (!found) throw new Error(`Missing ${key} in the configuration DTO`);
  return found;
}

function validate(values: Record<ConfigKey, string>): string[] {
  const errors: string[] = [];
  if (values.api_url) {
    try {
      const url = new URL(values.api_url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("protocol");
    } catch {
      errors.push("api_url must be a complete http(s)://… URL");
    }
  }
  if (values.timeout && (!Number.isFinite(Number(values.timeout)) || Number(values.timeout) <= 0)) errors.push("timeout must be a positive number of seconds.");
  if (values.retries && (!Number.isInteger(Number(values.retries)) || Number(values.retries) < 0)) errors.push("retries must be an integer ≥ 0.");
  if (values.model && !values.model.trim()) errors.push("model cannot be only spaces.");
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
      notify("API key revealed in this form only; it is not stored in localStorage");
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
      notify("Settings saved to SQLite");
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
      notify("SQLite values removed; environment and defaults apply again");
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
        eyebrow="System · jev config"
        title="Settings"
        description={<>Precedence: <strong>flag &gt; environment &gt; SQLite &gt; default</strong>. Empty strings <code>unset</code> the key; defaults are not written on reset.</>}
        actions={<Button variant="primary" onClick={() => void save()} disabled={saving || dirty.size === 0 || errors.length > 0}>{saving ? "Saving…" : `Save changes${dirty.size ? ` (${dirty.size})` : ""}`}</Button>}
      />
      {error ? <div className="mt-12"><Callout tone="danger">{error.message}{error.hint ? <><br /><strong>hint:</strong> {error.hint}</> : null}</Callout></div> : null}
      <div className="grid grid-config">
        <div className="stack">
          <Panel title="Provider" action={<span className="mono text-muted" style={{ fontSize: 10.5 }}>config table</span>}>
            <div className="stack" style={{ gap: 12 }}>
              <ConfigField label="api_url · full endpoint" keyName="api_url" value={values.api_url} source={source("api_url")} readOnly={readOnly("api_url")} onChange={update} />
              <div className="field">
                <label htmlFor="config-api_key">api_key</label>
                <div className="row" style={{ gap: 8 }}><input id="config-api_key" className="input mono" spellCheck={false} autoComplete="off" value={values.api_key} readOnly={readOnly("api_key")} onChange={(event) => update("api_key", event.target.value)} /><Button size="sm" onClick={() => void reveal()} disabled={saving || dirty.has("api_key")} title={dirty.has("api_key") ? "Save or discard the new key before revealing" : "Explicit reveal with Cache-Control: no-store"}>{revealed ? "Hide" : "Reveal"}</Button></div>
                <p className="hint">source: {sourceLabel(source("api_key"))}{readOnly("api_key") ? " · read-only from flag" : ""}</p>
                <Callout>The key is stored <strong>in clear text</strong> in SQLite. To avoid persisting it, use <code>--key</code> or <code>OPENCODE_API_KEY</code>/<code>JEV_API_KEY</code>. localStorage is never used.</Callout>
              </div>
              <div className="inline-fields">
                <ConfigField label="model · free value" keyName="model" value={values.model} source={source("model")} readOnly={readOnly("model")} onChange={update} />
                <ConfigField label="timeout (s)" keyName="timeout" value={values.timeout} source={source("timeout")} readOnly={readOnly("timeout")} onChange={update} type="number" />
                <ConfigField label="retries" keyName="retries" value={values.retries} source={source("retries")} readOnly={readOnly("retries")} onChange={update} type="number" />
              </div>
              {errors.length ? <div className="form-error" role="alert">{errors.map((message) => <p key={message}>{message}</p>)}</div> : <p className="hint">Valid values. Only modified keys are sent.</p>}
              <div className="row-between"><span className="hint">{dirty.size ? `${dirty.size} keys modified` : "No changes"}</span><Button variant="ghost" size="sm" onClick={() => setResetOpen(true)}>Reset to defaults</Button></div>
            </div>
          </Panel>
          <Panel title="HTTP request">
            <KvList items={[["retries on", "429, 5xx and network errors"], ["backoffMs", <span className="code-value" key="backoff">500 ms</span>], ["Retry-After cap", <span className="code-value" key="retry">10 s</span>], ["401", "no retry"]]} />
            <div className="mt-12"><Callout tone="info">Retry-After is capped at 10 s. Retries are counted per HTTP attempt, not per question.</Callout></div>
          </Panel>
        </div>

        <div className="stack">
          <Panel title="Resolved precedence" tight>
            {snapshot.entries.map((item) => <div className="prec-row" key={item.key}><span className="k">{item.key}</span><span className="v" title={item.masked}>{item.masked || "—"}</span><span className={`chip${item.source === "flag" ? "" : " chip-soft"}`}>{sourceLabel(item.source)}{!item.editable ? " · locked" : ""}</span></div>)}
            <div className="panel-body"><p className="hint">flag only fixes this session. An environment value allows editing SQLite, but keeps priority until the variable is removed.</p></div>
          </Panel>
          <Panel title="Database" action={<span className="pill pill-info">schema {snapshot.database.schemaVersion}</span>}>
            <div className="row" style={{ gap: 6 }}><code className="code-value" style={{ flex: 1 }}>{snapshot.database.path}</code><IconButton label="Copy path" onClick={() => void copy(snapshot.database.path)}><Icon name="copy" /></IconButton></div>
            <div className="mt-12"><KvList items={[["permissions", <span className="code-value" key="permissions">{snapshot.database.directoryMode} / {snapshot.database.fileMode}</span>], ["migrations", <span className="code-value" key="migrations">PRAGMA user_version</span>], ["tables", <span className="code-value" key="tables">{snapshot.database.tables.join(" · ")}</span>]]} /></div>
            <p className="hint mt-12">The CLI and Next share the same logical connection, migrations and parameterized repositories on this database.</p>
          </Panel>
          <Panel title="Exit codes">
            <div className="stack" style={{ gap: 7 }}>{[["0", "success"], ["1", "API, network or configuration error"], ["2", "misuse"]].map(([code, label]) => <div className="row-between" key={code}><span className="mono">{code}</span><span className="text-muted">{label}</span></div>)}</div>
          </Panel>
        </div>
      </div>
      <CliBar command={lastCommand} />
      {resetOpen ? <ConfirmModal title="Reset settings" description="Editable keys will be unset in SQLite. Default values are not written and this session flags are untouched; environment and defaults apply again following the precedence." confirmLabel="Reset" busy={saving} onClose={() => setResetOpen(false)} onConfirm={() => void reset()} /> : null}
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
  return <div className="field"><label htmlFor={`config-${keyName}`}>{label}</label><input id={`config-${keyName}`} className="input mono" type={type} min={keyName === "retries" ? 0 : keyName === "timeout" ? 0.001 : undefined} step={keyName === "retries" ? 1 : "any"} value={value} readOnly={readOnly} onChange={(event) => onChange(keyName, event.target.value)} /><p className="hint">source: {sourceLabel(source)}{readOnly ? " · SQLite change has no effect this session" : ""}</p></div>;
}

function sourceLabel(source: ConfigEntryDto["source"]): string {
  return { flag: "flag", env: "environment", sqlite: "SQLite", default: "default" }[source];
}
