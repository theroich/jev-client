"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import {
  MACRO_SCHEMA_TYPES,
  validateMacroSchema,
  type MacroSchema,
} from "../../dist/src/template-repository.js";
import { detectMacros, validateTemplateBody } from "../../dist/src/template.js";
import {
  createTemplateStarterBody,
  DEFAULT_TEMPLATE_STARTER,
  getTemplateStarter,
  type TemplateStarterId,
} from "../../dist/src/template-starters.js";
import type { JevRequest, TemplateDetail, TemplateMacro, TemplateSummary } from "@/lib/types";
import { parseJsonObject, relativeDate, shellQuote } from "@/lib/utils";
import { describeApiError, useConsole } from "./console-context";
import { ConfirmModal } from "./modal";
import { TemplateStarterModal } from "./template-starter-modal";
import {
  Button,
  Callout,
  CliBar,
  EmptyState,
  Icon,
  IconButton,
  JsonBlock,
  Panel,
  ScreenHead,
  Tabs,
} from "./ui";

interface Draft {
  originalName: string | null;
  name: string;
  description: string;
  bodyJson: string;
  macroDescriptions: Record<string, string>;
  /** Compact (or formatted) schema per macro; `""` = no schema. */
  macroSchemas: Record<string, string>;
}

function descriptionsFromMacros(macros: TemplateMacro[]): Record<string, string> {
  return Object.fromEntries(macros.map((macro) => [macro.name, macro.description]));
}

function schemaText(schema: MacroSchema | null | undefined): string {
  return schema === undefined || schema === null ? "" : JSON.stringify(schema);
}

function schemasFromMacros(macros: TemplateMacro[]): Record<string, string> {
  return Object.fromEntries(macros.map((macro) => [macro.name, schemaText(macro.schema)]));
}

/** Parses and validates a row text; `null` when empty. */
function parseMacroSchemaField(text: string): MacroSchema | null {
  if (text.trim() === "") return null;
  return validateMacroSchema(JSON.parse(text));
}

function macroSchemaError(text: string): string | null {
  if (text.trim() === "") return null;
  try {
    parseMacroSchemaField(text);
    return null;
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
}

function macroSchemaTypeLabel(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const type = (parsed as Record<string, unknown>).type;
    if (typeof type === "string") return type;
    if (Array.isArray(type) && type.length > 0 && type.every((item) => typeof item === "string")) {
      return type.join(" | ");
    }
  } catch {
    return null;
  }
  return null;
}

/** Comparable value for `dirty`: valid object or the raw text when invalid. */
function macroSchemaForComparison(text: string): unknown {
  try {
    return parseMacroSchemaField(text);
  } catch {
    return text.trim();
  }
}

/** Compact schema to save or copy to the CLI; `null` when empty. */
function macroSchemaValue(text: string): MacroSchema | null {
  try {
    return parseMacroSchemaField(text);
  } catch {
    return null;
  }
}

function macroSchemaCompact(text: string): string {
  const value = macroSchemaValue(text);
  return value === null ? "" : JSON.stringify(value);
}

function macroSchemaHintId(macro: string): string {
  return `macro-schema-hint-${macro.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function uniqueDraftName(templates: TemplateSummary[]): string {
  const used = new Set(templates.map((template) => template.name));
  if (!used.has("new-template")) return "new-template";
  let index = 2;
  while (used.has(`new-template-${index}`)) index += 1;
  return `new-template-${index}`;
}

function starterBodyJson(id: TemplateStarterId, model: string): string {
  return JSON.stringify(createTemplateStarterBody(id, model), null, 2);
}

function starterDraft(id: TemplateStarterId, model: string, templates: TemplateSummary[]): Draft {
  const starter = getTemplateStarter(id);
  return {
    originalName: null,
    name: uniqueDraftName(templates),
    description: starter?.description ?? "",
    bodyJson: starterBodyJson(id, model),
    macroDescriptions: {},
    macroSchemas: {},
  };
}

function fromDetail(detail: TemplateDetail): Draft {
  return {
    originalName: detail.name,
    name: detail.name,
    description: detail.description,
    bodyJson: JSON.stringify(JSON.parse(detail.bodyJson), null, 2),
    macroDescriptions: descriptionsFromMacros(detail.macros),
    macroSchemas: schemasFromMacros(detail.macros),
  };
}

export function TemplatesScreen({
  templates,
  selected,
  missingName,
  defaultModel,
}: {
  templates: TemplateSummary[];
  selected?: TemplateDetail | null;
  missingName?: string;
  defaultModel: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const startsNew = searchParams.get("new") === "1";
  const requestedStarter = searchParams.get("starter") as TemplateStarterId | null;
  const initialStarter = (requestedStarter && getTemplateStarter(requestedStarter)?.id) ?? DEFAULT_TEMPLATE_STARTER;
  const [draft, setDraft] = useState<Draft | null>(() => {
    if (startsNew) return starterDraft(initialStarter, defaultModel, templates);
    if (selected) return fromDetail(selected);
    return null;
  });
  const [tab, setTab] = useState("editor");
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [contextText, setContextText] = useState("{}");
  const [rendered, setRendered] = useState<JevRequest | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [starterOpen, setStarterOpen] = useState(false);
  const [focusName, setFocusName] = useState(startsNew);
  const [schemaOpen, setSchemaOpen] = useState<Record<string, boolean>>({});
  const { request, notify } = useConsole();

  const bodyError = useMemo(() => {
    if (!draft) return null;
    try {
      validateTemplateBody(draft.bodyJson);
      return null;
    } catch (caught) {
      return caught instanceof Error ? caught.message : String(caught);
    }
  }, [draft]);
  const macros = useMemo(() => draft ? detectMacros(draft.bodyJson) : [], [draft]);
  const describedCount = useMemo(
    () => draft ? macros.filter((name) => (draft.macroDescriptions[name] ?? "").trim() !== "").length : 0,
    [draft, macros],
  );
  const typedCount = useMemo(
    () => draft
      ? macros.filter((name) => macroSchemaTypeLabel(draft.macroSchemas[name] ?? "") !== null).length
      : 0,
    [draft, macros],
  );
  const schemaErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    if (!draft) return errors;
    for (const name of macros) {
      const error = macroSchemaError(draft.macroSchemas[name] ?? "");
      if (error) errors[name] = error;
    }
    return errors;
  }, [draft, macros]);
  const invalidSchemas = Object.keys(schemaErrors).length > 0;
  const removedDescribed = useMemo(
    () => draft
      ? Object.entries(draft.macroDescriptions).filter(([name, description]) => description.trim() !== "" && !macros.includes(name))
      : [],
    [draft, macros],
  );
  const removedSchemas = useMemo(
    () => draft
      ? Object.entries(draft.macroSchemas).filter(([name, schema]) => schema.trim() !== "" && !macros.includes(name))
      : [],
    [draft, macros],
  );
  const nameError = useMemo(() => {
    if (!draft) return null;
    if (!draft.name.trim()) return "The name cannot be empty.";
    if (templates.some((template) => template.name === draft.name.trim() && template.name !== draft.originalName)) {
      return "A template with that name already exists.";
    }
    return null;
  }, [draft, templates]);
  const dirty = useMemo(() => {
    if (!draft) return false;
    if (!draft.originalName || !selected) return true;
    const currentMacros = JSON.stringify(macros.map((name) => ({
      name,
      description: (draft.macroDescriptions[name] ?? "").trim(),
      schema: macroSchemaForComparison(draft.macroSchemas[name] ?? ""),
    })));
    const storedMacros = JSON.stringify(selected.macros.map((macro) => ({
      name: macro.name,
      description: macro.description,
      schema: macro.schema ?? null,
    })));
    return draft.name !== selected.name
      || draft.description !== selected.description
      || draft.bodyJson !== JSON.stringify(JSON.parse(selected.bodyJson), null, 2)
      || currentMacros !== storedMacros;
  }, [draft, selected, macros]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const guardLinks = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!anchor || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#") || href.startsWith("mailto:")) return;
      if (!window.confirm("There are unsaved changes. Leave and discard them?")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", guardLinks, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", guardLinks, true);
    };
  }, [dirty]);

  useEffect(() => {
    if (!focusName) return;
    const input = document.getElementById("template-name");
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
    setFocusName(false);
  }, [focusName]);

  const filtered = templates.filter((template) => `${template.name} ${template.description}`.toLocaleLowerCase("en").includes(search.toLocaleLowerCase("en")));
  const updateSearch = (value: string) => {
    setSearch(value);
    const params = new URLSearchParams(window.location.search);
    if (value) params.set("q", value); else params.delete("q");
    params.delete("new");
    params.delete("starter");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
  };

  const confirmDiscard = () => !dirty || window.confirm("There are unsaved changes. Leave and discard them?");
  const openTemplate = (name: string) => {
    if (!confirmDiscard()) return;
    router.push(`/templates/${encodeURIComponent(name)}${search ? `?q=${encodeURIComponent(search)}` : ""}`);
  };
  const startNew = () => {
    if (!confirmDiscard()) return;
    setError(null);
    setStarterOpen(true);
  };
  const startWithStarter = (id: TemplateStarterId) => {
    setDraft(starterDraft(id, defaultModel, templates));
    setRendered(null);
    setError(null);
    setTab("editor");
    setStarterOpen(false);
    setFocusName(true);
    router.replace(`/templates?new=1&starter=${id}`, { scroll: false });
  };

  const save = async () => {
    if (!draft || bodyError || nameError || saving || invalidSchemas) return;
    setSaving(true);
    setError(null);
    try {
      const name = draft.name.trim();
      const originalName = draft.originalName;
      if (originalName && originalName !== name) {
        await request(`/api/templates/${encodeURIComponent(originalName)}`, { method: "PATCH", body: JSON.stringify({ name }) });
      }
      const path = originalName && originalName === name
        ? `/api/templates/${encodeURIComponent(originalName)}`
        : originalName ? `/api/templates/${encodeURIComponent(name)}` : "/api/templates";
      const saved = await request<TemplateDetail>(path, {
        method: originalName ? "PUT" : "POST",
        body: JSON.stringify({
          name,
          description: draft.description,
          bodyJson: draft.bodyJson,
          macros: macros.map((macro) => ({
            name: macro,
            description: draft.macroDescriptions[macro] ?? "",
            schema: macroSchemaValue(draft.macroSchemas[macro] ?? ""),
          })),
        }),
      });
      setDraft(fromDetail(saved));
      notify(originalName ? "Template saved to SQLite" : "Template created in SQLite");
      router.push(`/templates/${encodeURIComponent(name)}`);
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft?.originalName) return;
    setSaving(true);
    try {
      await request(`/api/templates/${encodeURIComponent(draft.originalName)}`, { method: "DELETE" });
      notify("Template deleted");
      setDeleteOpen(false);
      router.push("/templates");
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setSaving(false);
    }
  };

  const render = async () => {
    if (!draft || bodyError) return;
    const context = parseJsonObject(contextText);
    if (context.error || !context.value) {
      setError({ message: `Invalid context: ${context.error}` });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await request<{ request: JevRequest }>("/api/templates/render", {
        method: "POST",
        body: JSON.stringify({ bodyJson: draft.bodyJson, context: context.value }),
      });
      setRendered(result.request);
      notify("Request resolved without calling the API");
    } catch (caught) {
      setRendered(null);
      setError(describeApiError(caught));
    } finally {
      setSaving(false);
    }
  };

  const updateMacroDescription = (name: string, value: string) => {
    setDraft((current) => current
      ? { ...current, macroDescriptions: { ...current.macroDescriptions, [name]: value } }
      : current);
  };

  const updateMacroSchema = (name: string, value: string) => {
    setDraft((current) => current
      ? { ...current, macroSchemas: { ...current.macroSchemas, [name]: value } }
      : current);
  };

  const updateMacroType = (name: string, type: string) => {
    if (type === "") {
      updateMacroSchema(name, "");
      return;
    }
    let next: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(draft?.macroSchemas[name] ?? "") as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        next = parsed as Record<string, unknown>;
      }
    } catch {
      // An invalid draft is replaced by the chosen type.
    }
    updateMacroSchema(name, JSON.stringify({ ...next, type }));
  };

  const formatMacroSchema = (name: string) => {
    const text = draft?.macroSchemas[name] ?? "";
    try {
      updateMacroSchema(name, JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      // The live error already reports the invalid JSON.
    }
  };

  const toggleMacroSchema = (name: string) => {
    setSchemaOpen((current) => ({ ...current, [name]: !current[name] }));
  };

  const createBody = (() => {
    if (!draft) return "";
    try {
      return JSON.stringify(JSON.parse(draft.bodyJson));
    } catch {
      return draft.bodyJson;
    }
  })();
  const macroDescriptionFlags = draft
    ? macros
        .filter((name) => (draft.macroDescriptions[name] ?? "").trim() !== "")
        .map((name) => `--macro-desc ${shellQuote(`${name}=${(draft.macroDescriptions[name] ?? "").trim()}`)}`)
    : [];
  const macroSchemaFlags = draft
    ? macros
        .filter((name) => (draft.macroSchemas[name] ?? "").trim() !== "")
        .map((name) => `--macro-schema ${shellQuote(`${name}=${macroSchemaCompact(draft.macroSchemas[name] ?? "")}`)}`)
    : [];
  const macroFlags = [...macroDescriptionFlags, ...macroSchemaFlags].join(" ");
  const withMacroFlags = (base: string) => macroFlags ? `${base} ${macroFlags}` : base;
  const command = !draft ? "jev template list" : tab === "render"
    ? `jev template render ${shellQuote(draft.name)} --context-file context.json`
    : draft.originalName
      ? withMacroFlags(`jev template edit ${shellQuote(draft.name)} --file template.json`)
      : withMacroFlags(`jev template create ${shellQuote(draft.name)} --description ${shellQuote(draft.description)} --body ${shellQuote(createBody)}`);

  return (
    <section>
      <ScreenHead
        eyebrow="Library · jev template"
        title="Templates"
        description={<>Jev requests with <code>{"{{key}}"}</code> placeholders. They are stored in the <code>templates</code> table and use the same macros as <code>jev batch</code>.</>}
        actions={<Button onClick={startNew}><Icon name="plus" />New template</Button>}
      />
      {missingName ? <div className="mt-12"><Callout tone="danger">The template “{missingName}” does not exist. You can create a new one or pick another.</Callout></div> : null}
      {error ? <div className="mt-12"><Callout tone="danger">{error.message}{error.hint ? <><br /><strong>hint:</strong> {error.hint}</> : null}</Callout></div> : null}
      <div className="grid grid-tpl">
        <Panel tight>
          <div className="search-wrap"><Icon name="search" /><input className="input" placeholder="Search templates…" aria-label="Search templates" value={search} onChange={(event) => updateSearch(event.target.value)} /></div>
          <div className="tpl-list" role="listbox" aria-label="Templates">
            {filtered.map((template) => <button type="button" role="option" aria-selected={draft?.originalName === template.name} className="tpl-item" key={template.name} onClick={() => openTemplate(template.name)}>
              <span className="t-name">{template.name}{draft?.originalName === template.name && dirty ? <span className="dirty-badge">unsaved</span> : null}</span>
              <span className="t-desc">{template.description || "No description"}</span>
              <span className="t-meta"><span>{template.macros.length} macros</span><span suppressHydrationWarning>{relativeDate(template.updatedAt)}</span></span>
            </button>)}
            {filtered.length === 0 ? <EmptyState title={templates.length === 0 ? "No templates" : "No matches"} action={<Button size="sm" onClick={startNew}>Create template</Button>}>{templates.length === 0 ? "Create the first one to reuse requests and run batches." : "Try another search by name or description."}</EmptyState> : null}
          </div>
          <div className="panel-foot"><span>{filtered.length} of {templates.length} templates</span><span className="mono" style={{ fontSize: 10.5 }}>templates</span></div>
        </Panel>

        {!draft ? <Panel><EmptyState title="Select a template" action={<Button variant="primary" onClick={startNew}>New template</Button>}>Pick one from the library to edit, validate or render.</EmptyState></Panel> : (
          <Panel tight>
            <div className="panel-body" style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="inline-fields">
                <div className="field"><label htmlFor="template-name">Name</label><input id="template-name" className="input mono" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} aria-invalid={Boolean(nameError)} /></div>
                <div className="field" style={{ flexGrow: 2 }}><label htmlFor="template-description">Description</label><input id="template-description" className="input" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></div>
              </div>
              {nameError ? <p className="form-error">{nameError}</p> : null}
              <div className="row-between mt-8"><span className="hint" suppressHydrationWarning>{draft.originalName && selected ? `created ${new Date(selected.createdAt).toLocaleString("en-US")} · updated ${new Date(selected.updatedAt).toLocaleString("en-US")}` : "new draft"}{dirty ? " · unsaved changes" : ""}</span><span className="chip">{macros.length} macros</span></div>
            </div>
            <Tabs label="Template tools" value={tab} onChange={(value) => { setTab(value); setError(null); }} items={[{ id: "editor", label: "Editor" }, { id: "render", label: "Render" }, { id: "macros", label: "Macros" }]} />
            <div className="panel-body">
              {tab === "editor" ? <div className="stack" style={{ gap: 10 }}>
                <textarea className="textarea" style={{ minHeight: 330 }} spellCheck={false} aria-label="Template body JSON" aria-invalid={Boolean(bodyError)} value={draft.bodyJson} onChange={(event) => { setDraft({ ...draft, bodyJson: event.target.value }); setRendered(null); }} />
                {bodyError ? <p className="form-error" role="alert">{bodyError}</p> : <p className="hint">Valid body: an object with model, state and noul/choice/score questions. Validation uses validateTemplateBody.</p>}
              </div> : null}
              {tab === "render" ? <div className="stack" style={{ gap: 10 }}>
                <div className="field"><label htmlFor="template-context">Context JSON</label><textarea id="template-context" className="textarea" rows={8} spellCheck={false} value={contextText} onChange={(event) => { setContextText(event.target.value); setRendered(null); }} /></div>
                <p className="hint">Resolves every macro and validates the request without sending it to Jev. Missing keys are listed together.</p>
                <Button variant="primary" onClick={() => void render()} disabled={saving || Boolean(bodyError)}>{saving ? "Resolving…" : "Render without sending"}</Button>
                {rendered ? <JsonBlock value={rendered} /> : null}
              </div> : null}
              {tab === "macros" ? <div className="stack" style={{ gap: 10 }}>
                <div className="row-between" style={{ alignItems: "flex-start" }}>
                  <p className="hint" id="template-macros-hint" style={{ margin: 0 }}>Required keys detected in the draft. Nested paths such as <code>{"{{customer.name}}"}</code> are supported; <code>\{"{{literal}}"}</code> escapes a macro. The description and schema are optional and are not sent to Jev.</p>
                  <div className="macro-summary" aria-live="polite">
                    <span className="chip">{describedCount} of {macros.length} described</span>
                    <span className="chip">{typedCount} typed</span>
                  </div>
                </div>
                {macros.length ? <div className="macro-rows">
                  {macros.map((macro) => {
                    const description = draft.macroDescriptions[macro] ?? "";
                    const schema = draft.macroSchemas[macro] ?? "";
                    const typeLabel = macroSchemaTypeLabel(schema);
                    const typeValue = typeLabel && (MACRO_SCHEMA_TYPES as readonly string[]).includes(typeLabel) ? typeLabel : "";
                    const schemaError = schemaErrors[macro];
                    const open = schemaOpen[macro] === true;
                    const hintId = macroSchemaHintId(macro);
                    return <div className="macro-entry" key={macro}>
                      <div className="macro-row">
                        <span className="macro-head">
                          <code className="macro-key">{"{{"}{macro}{"}}"}</code>
                          {typeLabel ? <span className="chip chip-soft macro-type-chip">{typeLabel}</span> : null}
                        </span>
                        <div className="field">
                          <label className="sr-only" htmlFor={`macro-description-${hintId}`}>Description of {"{{"}{macro}{"}}"}</label>
                          <input
                            id={`macro-description-${hintId}`}
                            className="input"
                            type="text"
                            maxLength={500}
                            value={description}
                            aria-label={`Description of {{${macro}}}`}
                            aria-describedby="template-macros-hint"
                            placeholder="What it represents and which format/values it expects"
                            onChange={(event) => updateMacroDescription(macro, event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape" && description !== "") {
                                event.preventDefault();
                                updateMacroDescription(macro, "");
                              }
                            }}
                          />
                        </div>
                        <div className="field macro-type-field">
                          <label className="sr-only" htmlFor={`macro-type-${hintId}`}>Type of {"{{"}{macro}{"}}"}</label>
                          <select
                            id={`macro-type-${hintId}`}
                            className="select mono"
                            value={typeValue}
                            aria-label={`Type of {{${macro}}}`}
                            onChange={(event) => updateMacroType(macro, event.target.value)}
                          >
                            <option value="">(no type)</option>
                            {MACRO_SCHEMA_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                          </select>
                        </div>
                        <IconButton
                          label={`Clear description of {{${macro}}}`}
                          disabled={description === ""}
                          onClick={() => updateMacroDescription(macro, "")}
                        >
                          <Icon name="close" />
                        </IconButton>
                      </div>
                      <div className="macro-schema-bar">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`${open ? "Hide" : "Show"} JSON schema of {{${macro}}}`}
                          aria-expanded={open}
                          aria-controls={`macro-schema-editor-${hintId}`}
                          onClick={() => toggleMacroSchema(macro)}
                        >
                          {open ? "Hide" : "JSON schema"}
                        </Button>
                        {schema && !open ? <code className="macro-schema-preview" title={schema}>{schema}</code> : null}
                      </div>
                      {open ? <div className="field macro-schema-editor" id={`macro-schema-editor-${hintId}`}>
                        <div className="row-between">
                          <label htmlFor={`macro-schema-${hintId}`}>JSON schema of {"{{"}{macro}{"}}"}</label>
                          <span className="macro-schema-actions">
                            <Button size="sm" variant="outline" disabled={schema.trim() === "" || Boolean(schemaError)} onClick={() => formatMacroSchema(macro)}>Format</Button>
                            <Button size="sm" variant="ghost" disabled={schema === ""} onClick={() => updateMacroSchema(macro, "")}>Remove schema</Button>
                          </span>
                        </div>
                        <textarea
                          id={`macro-schema-${hintId}`}
                          className="textarea"
                          rows={5}
                          spellCheck={false}
                          value={schema}
                          aria-label={`JSON schema of {{${macro}}}`}
                          aria-describedby={hintId}
                          aria-invalid={Boolean(schemaError)}
                          placeholder={'{"type":"string","enum":["free","pro"]}'}
                          onChange={(event) => updateMacroSchema(macro, event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape" && schema !== "") {
                              event.preventDefault();
                              updateMacroSchema(macro, "");
                            }
                          }}
                        />
                        {schemaError
                          ? <p className="form-error" role="alert">{schemaError}</p>
                          : <p className="hint" id={hintId}>Informational JSON Schema. Supports booleans, <code>enum</code>, <code>format</code>, <code>pattern</code>, limits, <code>default</code> and <code>examples</code>; <code>$ref</code> must be local (<code>#</code>).</p>}
                      </div> : null}
                    </div>;
                  })}
                </div> : <span className="hint">No macros.</span>}
                {removedDescribed.length ? <Callout tone="warn">Saving will remove the description of {removedDescribed.map(([name]) => `{{${name}}}`).join(", ")} because it no longer appears in the body.</Callout> : null}
                {removedSchemas.length ? <Callout tone="warn">Saving will remove the schema of {removedSchemas.map(([name]) => `{{${name}}}`).join(", ")} because it no longer appears in the body.</Callout> : null}
                {macros.length ? <Callout tone="info">The context must provide {macros.length === 1 ? "this key" : "all these keys"}. Rendering validates the missing ones before any call.</Callout> : null}
              </div> : null}
            </div>
            <div className="panel-foot">
              <span>{dirty ? <span className="dirty-badge">unsaved</span> : "saved to SQLite"}</span>
              <div className="template-actions">
                {draft.originalName ? <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}><Icon name="trash" />Delete</Button> : null}
                <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving || Boolean(bodyError) || Boolean(nameError) || invalidSchemas || (!dirty && Boolean(draft.originalName))}>{saving ? "Saving…" : draft.originalName ? "Save changes" : "Create template"}</Button>
              </div>
            </div>
          </Panel>
        )}
      </div>
      <CliBar command={command} />
      {starterOpen ? <TemplateStarterModal onClose={() => setStarterOpen(false)} onChoose={startWithStarter} /> : null}
      {deleteOpen && draft?.originalName ? <ConfirmModal title={`Delete ${draft.originalName}`} description="The template will be removed from SQLite. Existing history keeps template_name and is not deleted. This action cannot be undone." confirmLabel="Delete" danger busy={saving} onClose={() => setDeleteOpen(false)} onConfirm={() => void remove()} /> : null}
    </section>
  );
}
