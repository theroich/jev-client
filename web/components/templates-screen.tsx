"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { detectMacros, validateTemplateBody } from "../../dist/src/template.js";
import type { JevRequest, TemplateDetail, TemplateSummary } from "@/lib/types";
import { parseJsonObject, relativeDate, shellQuote } from "@/lib/utils";
import { describeApiError, useConsole } from "./console-context";
import { ConfirmModal } from "./modal";
import {
  Button,
  Callout,
  CliBar,
  EmptyState,
  Icon,
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
}

function initialBody(model: string): string {
  return JSON.stringify({
    model,
    state: "{{state}}",
    questions: { q: { type: "noul", instructions: "¿Se cumple la condición?" } },
  }, null, 2);
}

function fromDetail(detail: TemplateDetail): Draft {
  return {
    originalName: detail.name,
    name: detail.name,
    description: detail.description,
    bodyJson: JSON.stringify(JSON.parse(detail.bodyJson), null, 2),
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
  const [draft, setDraft] = useState<Draft | null>(() => {
    if (startsNew) {
      const used = new Set(templates.map((template) => template.name));
      let index = 1;
      let name = "nueva-plantilla";
      while (used.has(name)) name = `nueva-plantilla-${++index}`;
      return { originalName: null, name, description: "", bodyJson: initialBody(defaultModel) };
    }
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
  const nameError = useMemo(() => {
    if (!draft) return null;
    if (!draft.name.trim()) return "El nombre no puede estar vacío.";
    if (templates.some((template) => template.name === draft.name.trim() && template.name !== draft.originalName)) {
      return "Ya existe una plantilla con ese nombre.";
    }
    return null;
  }, [draft, templates]);
  const dirty = useMemo(() => {
    if (!draft) return false;
    if (!draft.originalName || !selected) return true;
    return draft.name !== selected.name || draft.description !== selected.description || draft.bodyJson !== JSON.stringify(JSON.parse(selected.bodyJson), null, 2);
  }, [draft, selected]);

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
      if (!window.confirm("Hay cambios sin guardar. ¿Salir y descartarlos?")) {
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

  const filtered = templates.filter((template) => `${template.name} ${template.description}`.toLocaleLowerCase("es").includes(search.toLocaleLowerCase("es")));
  const updateSearch = (value: string) => {
    setSearch(value);
    const params = new URLSearchParams(window.location.search);
    if (value) params.set("q", value); else params.delete("q");
    params.delete("new");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
  };

  const confirmDiscard = () => !dirty || window.confirm("Hay cambios sin guardar. ¿Salir y descartarlos?");
  const openTemplate = (name: string) => {
    if (!confirmDiscard()) return;
    router.push(`/plantillas/${encodeURIComponent(name)}${search ? `?q=${encodeURIComponent(search)}` : ""}`);
  };
  const startNew = () => {
    if (!confirmDiscard()) return;
    const used = new Set(templates.map((template) => template.name));
    let index = 1;
    let name = "nueva-plantilla";
    while (used.has(name)) name = `nueva-plantilla-${++index}`;
    setDraft({ originalName: null, name, description: "", bodyJson: initialBody(defaultModel) });
    setRendered(null);
    setError(null);
    router.replace("/plantillas?new=1", { scroll: false });
  };

  const save = async () => {
    if (!draft || bodyError || nameError || saving) return;
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
      await request(path, {
        method: originalName ? "PUT" : "POST",
        body: JSON.stringify({ name, description: draft.description, bodyJson: draft.bodyJson }),
      });
      notify(originalName ? "Plantilla guardada en SQLite" : "Plantilla creada en SQLite");
      router.push(`/plantillas/${encodeURIComponent(name)}`);
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
      notify("Plantilla eliminada");
      setDeleteOpen(false);
      router.push("/plantillas");
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
      setError({ message: `Contexto inválido: ${context.error}` });
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
      notify("Request resuelto sin llamar a la API");
    } catch (caught) {
      setRendered(null);
      setError(describeApiError(caught));
    } finally {
      setSaving(false);
    }
  };

  const command = !draft ? "jev template list" : tab === "render"
    ? `jev template render ${shellQuote(draft.name)} --context-file context.json`
    : tab === "macros" ? `jev template show ${shellQuote(draft.name)} --json`
      : draft.originalName ? `jev template edit ${shellQuote(draft.name)} --file plantilla.json`
        : `jev template create ${shellQuote(draft.name)} --file plantilla.json --description ${shellQuote(draft.description)}`;

  return (
    <section>
      <ScreenHead
        eyebrow="Biblioteca · jev template"
        title="Plantillas"
        description={<>Requests de Jev con huecos <code>{"{{clave}}"}</code>. Se guardan en la tabla <code>templates</code> y usa las mismas macros que <code>jev batch</code>.</>}
        actions={<Button onClick={startNew}><Icon name="plus" />Nueva plantilla</Button>}
      />
      {missingName ? <div className="mt-12"><Callout tone="danger">No existe la plantilla «{missingName}». Puedes crear una nueva o elegir otra.</Callout></div> : null}
      {error ? <div className="mt-12"><Callout tone="danger">{error.message}{error.hint ? <><br /><strong>pista:</strong> {error.hint}</> : null}</Callout></div> : null}
      <div className="grid grid-tpl">
        <Panel tight>
          <div className="search-wrap"><Icon name="search" /><input className="input" placeholder="Buscar plantilla…" aria-label="Buscar plantilla" value={search} onChange={(event) => updateSearch(event.target.value)} /></div>
          <div className="tpl-list" role="listbox" aria-label="Plantillas">
            {filtered.map((template) => <button type="button" role="option" aria-selected={draft?.originalName === template.name} className="tpl-item" key={template.name} onClick={() => openTemplate(template.name)}>
              <span className="t-name">{template.name}{draft?.originalName === template.name && dirty ? <span className="dirty-badge">sin guardar</span> : null}</span>
              <span className="t-desc">{template.description || "Sin descripción"}</span>
              <span className="t-meta"><span>{template.macros.length} macros</span><span suppressHydrationWarning>{relativeDate(template.updatedAt)}</span></span>
            </button>)}
            {filtered.length === 0 ? <EmptyState title={templates.length === 0 ? "No hay plantillas" : "Sin coincidencias"} action={<Button size="sm" onClick={startNew}>Crear plantilla</Button>}>{templates.length === 0 ? "Crea la primera para reutilizar requests y ejecutar lotes." : "Prueba otra búsqueda por nombre o descripción."}</EmptyState> : null}
          </div>
          <div className="panel-foot"><span>{filtered.length} de {templates.length} plantillas</span><span className="mono" style={{ fontSize: 10.5 }}>templates</span></div>
        </Panel>

        {!draft ? <Panel><EmptyState title="Selecciona una plantilla" action={<Button variant="primary" onClick={startNew}>Nueva plantilla</Button>}>Elige una de la biblioteca para editar, validar o renderizar.</EmptyState></Panel> : (
          <Panel tight>
            <div className="panel-body" style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="inline-fields">
                <div className="field"><label htmlFor="template-name">Nombre</label><input id="template-name" className="input mono" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} aria-invalid={Boolean(nameError)} /></div>
                <div className="field" style={{ flexGrow: 2 }}><label htmlFor="template-description">Descripción</label><input id="template-description" className="input" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></div>
              </div>
              {nameError ? <p className="form-error">{nameError}</p> : null}
              <div className="row-between mt-8"><span className="hint" suppressHydrationWarning>{draft.originalName && selected ? `creada ${new Date(selected.createdAt).toLocaleString("es-ES")} · actualizada ${new Date(selected.updatedAt).toLocaleString("es-ES")}` : "borrador nuevo"}{dirty ? " · cambios sin guardar" : ""}</span><span className="chip">{macros.length} macros</span></div>
            </div>
            <Tabs label="Herramientas de plantilla" value={tab} onChange={(value) => { setTab(value); setError(null); }} items={[{ id: "editor", label: "Editor" }, { id: "render", label: "Renderizar" }, { id: "macros", label: "Macros" }]} />
            <div className="panel-body">
              {tab === "editor" ? <div className="stack" style={{ gap: 10 }}>
                <textarea className="textarea" style={{ minHeight: 330 }} spellCheck={false} aria-label="Body JSON de la plantilla" aria-invalid={Boolean(bodyError)} value={draft.bodyJson} onChange={(event) => { setDraft({ ...draft, bodyJson: event.target.value }); setRendered(null); }} />
                {bodyError ? <p className="form-error" role="alert">{bodyError}</p> : <p className="hint">Body válido: objeto con model, state y preguntas noul/choice/score. La validación usa validateTemplateBody.</p>}
              </div> : null}
              {tab === "render" ? <div className="stack" style={{ gap: 10 }}>
                <div className="field"><label htmlFor="template-context">Contexto JSON</label><textarea id="template-context" className="textarea" rows={8} spellCheck={false} value={contextText} onChange={(event) => { setContextText(event.target.value); setRendered(null); }} /></div>
                <p className="hint">Resuelve todas las macros y valida el request sin enviarlo a Jev. Las claves ausentes se listan juntas.</p>
                <Button variant="primary" onClick={() => void render()} disabled={saving || Boolean(bodyError)}>{saving ? "Resolviendo…" : "Renderizar sin enviar"}</Button>
                {rendered ? <JsonBlock value={rendered} /> : null}
              </div> : null}
              {tab === "macros" ? <div className="stack" style={{ gap: 10 }}>
                <p className="hint">Claves necesarias detectadas en el draft. Se admiten rutas anidadas como <code>{"{{cliente.nombre}}"}</code>; <code>\{"{{literal}}"}</code> escapa una macro.</p>
                <div className="chip-row">{macros.length ? macros.map((macro) => <span className="chip" key={macro}>{"{{"}{macro}{"}}"}</span>) : <span className="hint">Sin macros.</span>}</div>
                {macros.length ? <Callout tone="info">El contexto debe proporcionar {macros.length === 1 ? "esta clave" : "todas estas claves"}. El render valida las ausentes antes de cualquier llamada.</Callout> : null}
              </div> : null}
            </div>
            <div className="panel-foot">
              <span>{dirty ? <span className="dirty-badge">sin guardar</span> : "guardada en SQLite"}</span>
              <div className="template-actions">
                {draft.originalName ? <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}><Icon name="trash" />Eliminar</Button> : null}
                <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving || Boolean(bodyError) || Boolean(nameError) || (!dirty && Boolean(draft.originalName))}>{saving ? "Guardando…" : draft.originalName ? "Guardar cambios" : "Crear plantilla"}</Button>
              </div>
            </div>
          </Panel>
        )}
      </div>
      <CliBar command={command} />
      {deleteOpen && draft?.originalName ? <ConfirmModal title={`Eliminar ${draft.originalName}`} description="Se eliminará la plantilla de SQLite. El historial existente conserva template_name y no se borra. Esta acción no se puede deshacer." confirmLabel="Eliminar" danger busy={saving} onClose={() => setDeleteOpen(false)} onConfirm={() => void remove()} /> : null}
    </section>
  );
}
