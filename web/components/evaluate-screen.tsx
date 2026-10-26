"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ExecutionResult, JevRequest } from "@/lib/types";
import {
  draftsFromQuestions,
  newDraft,
  questionsFromDrafts,
  type QuestionDraft,
} from "@/lib/questions";
import { buildAskCommand, formatBytes, formatCost, parseStateInput } from "@/lib/utils";
import { AnswerCard } from "./answer-card";
import { describeApiError, useConsole } from "./console-context";
import {
  Button,
  Callout,
  CliBar,
  Icon,
  IconButton,
  JsonBlock,
  Loading,
  Panel,
  ScreenHead,
  Switch,
  Tabs,
} from "./ui";

function validationErrors(drafts: QuestionDraft[], stateEmpty: boolean, stateError: string | null): string[] {
  const errors: string[] = [];
  if (stateEmpty) errors.push("El state está vacío.");
  if (stateError) errors.push(stateError);
  if (drafts.length === 0) errors.push("Añade al menos una pregunta.");
  const names = new Set<string>();
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!name) errors.push("Todas las preguntas necesitan un nombre.");
    if (name && names.has(name)) errors.push(`El nombre de pregunta «${name}» está duplicado.`);
    names.add(name);
    if (draft.type === "choice") {
      const keys = draft.criteria.map((row) => row.key.trim()).filter(Boolean);
      if (keys.length === 0) errors.push(`«${name || "Sin nombre"}» necesita al menos un criterio choice.`);
      if (new Set(keys).size !== keys.length) errors.push(`«${name}» tiene claves choice duplicadas.`);
    }
    if (draft.type === "score" && !draft.levels.some((level) => level.trim())) {
      errors.push(`«${name || "Sin nombre"}» necesita al menos un nivel score.`);
    }
  }
  return [...new Set(errors)];
}

interface AttachedImage {
  ref: string;
  name: string;
  format: "png" | "jpg";
  dataBase64: string;
  bytes: number;
  width: number;
  height: number;
  dataUrl: string;
}

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("no se pudo leer el fichero"));
    reader.readAsDataURL(file);
  });
}

function measureImage(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
}

async function fileToImage(file: File): Promise<AttachedImage> {
  const format = file.type === "image/png" ? "png" : "jpg";
  const ref = crypto.randomUUID();
  const dataUrl = await readAsDataUrl(file);
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const size = await measureImage(dataUrl);
  return {
    ref,
    name: file.name,
    format,
    dataBase64: base64,
    bytes: file.size,
    width: size.width,
    height: size.height,
    dataUrl,
  };
}

export function EvaluateScreen({ defaultModel }: { defaultModel: string }) {
  const [stateText, setStateText] = useState("");
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [drafts, setDrafts] = useState<QuestionDraft[]>([newDraft(1)]);
  const [model, setModel] = useState(defaultModel);
  const [save, setSave] = useState(true);
  const [running, setRunning] = useState<"ask" | "demo" | null>(null);
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [tab, setTab] = useState("report");
  const [error, setError] = useState<{ code: string; message: string; hint?: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const queryHandled = useRef(false);
  const { request, ready, notify } = useConsole();
  const router = useRouter();
  const searchParams = useSearchParams();

  const parsedState = useMemo(() => parseStateInput(stateText), [stateText]);
  const questions = useMemo(() => questionsFromDrafts(drafts), [drafts]);
  const errors = useMemo(() => validationErrors(drafts, parsedState.kind === "vacío" && images.length === 0, parsedState.error), [drafts, parsedState, images]);
  const command = buildAskCommand(stateText, questions, model, defaultModel, save);

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    const accepted: AttachedImage[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/png") && !file.type.startsWith("image/jpeg")) {
        notify(`Ignorado ${file.name}: solo se admiten PNG/JPEG`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        notify(`Ignorado ${file.name}: supera los 16 MiB`);
        continue;
      }
      try {
        accepted.push(await fileToImage(file));
      } catch {
        notify(`No se pudo leer ${file.name}`);
      }
    }
    if (accepted.length > 0) setImages((current) => [...current, ...accepted]);
  };

  const assetsForRequest = () => {
    if (images.length === 0) return undefined;
    const assets: Record<string, { type: "image"; format: "png" | "jpg"; data_base64: string }> = {};
    for (const image of images) {
      assets[image.ref] = { type: "image", format: image.format, data_base64: image.dataBase64 };
    }
    return assets;
  };

  const stateForRequest = () => {
    if (images.length === 0) return parsedState.value;
    const keys = images.length === 1 ? ["foto"] : images.map((_, index) => `foto_${index + 1}`);
    const refs: Record<string, string> = {};
    images.forEach((image, index) => {
      refs[keys[index] ?? `foto_${index + 1}`] = image.ref;
    });
    const base =
      parsedState.kind === "JSON" &&
      parsedState.value !== null &&
      typeof parsedState.value === "object" &&
      !Array.isArray(parsedState.value)
        ? (parsedState.value as Record<string, unknown>)
        : parsedState.kind === "vacío"
          ? {}
          : { texto: stateText };
    return { ...base, ...refs };
  };

  const execute = async (demo: boolean) => {
    if (running || (!demo && errors.length > 0)) return;
    setRunning(demo ? "demo" : "ask");
    setError(null);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const execution = await request<ExecutionResult>(demo ? "/api/demo" : "/api/ask", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify(demo ? { save } : { state: stateForRequest(), questions, model, save, assets: assetsForRequest() }),
      });
      setResult(execution);
      setTab("report");
      notify(demo ? "Demo ejecutado" : "Evaluación completada");
      if (!save) notify("Esta ejecución no se ha guardado en el historial");
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setRunning(null);
      abort.current = null;
    }
  };

  useEffect(() => {
    if (!ready || searchParams.get("run") !== "demo" || queryHandled.current) return;
    queryHandled.current = true;
    router.replace("/evaluar", { scroll: false });
    void execute(true);
    // La acción de la paleta solo se dispara al entrar con ?run=demo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, router, searchParams]);

  const updateDraft = (id: number, update: Partial<QuestionDraft>) => {
    setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, ...update } : draft));
  };

  const loadExample = async () => {
    try {
      const response = await fetch("/examples/request.json", { cache: "no-store" });
      if (!response.ok) throw new Error("No se pudo leer examples/request.json");
      const example = await response.json() as JevRequest;
      setStateText(JSON.stringify(example.state, null, 2));
      setDrafts(draftsFromQuestions(example.questions));
      if (example.model) setModel(example.model);
      setResult(null);
      setError(null);
      notify("Ejemplo real de examples/request.json cargado");
    } catch (caught) {
      setError(describeApiError(caught));
    }
  };

  const modelOptions = [...new Set([defaultModel, "jev-1.13", "jev-1.13-free", model].filter(Boolean))];

  return (
    <section>
      <ScreenHead
        eyebrow="Inferencia · jev ask"
        title="Evaluar"
        description={<>Un <code>state</code> y una o más preguntas tipadas. Jev devuelve una respuesta real por pregunta con sus probabilidades.</>}
        actions={<Button variant="ghost" size="sm" onClick={() => void loadExample()}>Cargar ejemplo del ticket</Button>}
      />
      {error ? <div className="mt-12"><Callout tone="danger"><strong>{error.code}</strong>: {error.message}{error.hint ? <><br /><strong>pista:</strong> {error.hint}</> : null}{["api_key_missing", "api_key_expired"].includes(error.code) ? <> <Link className="link" href="/configuracion">Abrir Configuración</Link></> : null}</Callout></div> : null}
      <div className="grid grid-ask">
        <div className="stack">
          <Panel title="State" action={<span className="mono text-muted" style={{ fontSize: 10.5 }}>{parsedState.error ? "JSON inválido" : parsedState.kind}</span>}>
            <textarea className="textarea" rows={5} spellCheck={false} aria-label="Contenido a evaluar" aria-invalid={Boolean(parsedState.error)} value={stateText} onChange={(event) => setStateText(event.target.value)} placeholder="Texto plano, objeto JSON o array JSON" />
            <p className={`hint${parsedState.error ? " form-error" : ""}`}>{parsedState.error ?? <>Si empieza por <code>{"{"}</code> o <code>[</code> se envía como JSON estricto; si no, como string.</>}</p>
            <div className="stack" style={{ gap: 6, marginTop: 8 }}>
              <label className="hint">Imagen (experimental) · PNG/JPEG · máx. 16 MiB</label>
              <input type="file" accept="image/png,image/jpeg" multiple onChange={(event) => void onFiles(event.target.files)} aria-label="Adjuntar imágenes" />
              {images.length > 0 ? <div className="stack" style={{ gap: 6 }}>
                {images.map((image) => <div className="row" key={image.ref} style={{ gap: 8, alignItems: "center" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image.dataUrl} alt={image.name} width={40} height={40} style={{ objectFit: "cover", borderRadius: 4, border: "1px solid var(--border)" }} />
                  <div className="stack" style={{ gap: 1 }}>
                    <span className="mono" style={{ fontSize: 11 }}>{image.ref}</span>
                    <span className="hint">{image.name} · {image.width}×{image.height} px · {formatBytes(image.bytes)}</span>
                  </div>
                  <IconButton label={`Quitar ${image.name}`} onClick={() => setImages((current) => current.filter((item) => item.ref !== image.ref))}><Icon name="close" /></IconButton>
                </div>)}
                <p className="hint">La referencia se inserta en <code>state</code>; úsala en las <code>instructions</code> (p. ej. «¿Qué animal aparece en <code>foto</code>?»).</p>
              </div> : null}
            </div>
          </Panel>

          <Panel title="Preguntas" action={<span className="mono text-muted" style={{ fontSize: 10.5 }}>{drafts.length} {drafts.length === 1 ? "pregunta" : "preguntas"}</span>}>
            <div className="stack" style={{ gap: 10 }}>
              {drafts.map((draft, index) => <article className="qcard" key={draft.id}>
                <div className="qcard-head">
                  <input className="input" aria-label={`Nombre de la pregunta ${index + 1}`} value={draft.name} onChange={(event) => updateDraft(draft.id, { name: event.target.value })} />
                  <select className="select" aria-label={`Tipo de la pregunta ${index + 1}`} value={draft.type} onChange={(event) => updateDraft(draft.id, { type: event.target.value as QuestionDraft["type"] })}><option value="noul">noul</option><option value="choice">choice</option><option value="score">score</option></select>
                  <IconButton label={`Eliminar pregunta ${index + 1}`} disabled={drafts.length === 1} onClick={() => setDrafts((current) => current.filter((item) => item.id !== draft.id))}><Icon name="close" /></IconButton>
                </div>
                <textarea className="textarea" rows={2} aria-label={`Instrucciones de la pregunta ${index + 1}`} placeholder="Instrucciones para el modelo" value={draft.instructions} onChange={(event) => updateDraft(draft.id, { instructions: event.target.value })} />
                {draft.type === "noul" ? <input className="input" aria-label={`Criterio noul ${index + 1}`} placeholder="Criterio de decisión (opcional)" value={draft.noulCriteria} onChange={(event) => updateDraft(draft.id, { noulCriteria: event.target.value })} /> : null}
                {draft.type === "choice" ? <div className="crit-list">
                  {draft.criteria.map((criterion, criterionIndex) => <div className="crit-row" key={criterionIndex}>
                    <input className="input k" aria-label={`Clave del criterio ${criterionIndex + 1} de ${draft.name}`} placeholder="clave" value={criterion.key} onChange={(event) => updateDraft(draft.id, { criteria: draft.criteria.map((row, i) => i === criterionIndex ? { ...row, key: event.target.value } : row) })} />
                    <input className="input v" aria-label={`Descripción del criterio ${criterionIndex + 1} de ${draft.name}`} placeholder="descripción" value={criterion.value} onChange={(event) => updateDraft(draft.id, { criteria: draft.criteria.map((row, i) => i === criterionIndex ? { ...row, value: event.target.value } : row) })} />
                    <IconButton label="Quitar criterio" onClick={() => updateDraft(draft.id, { criteria: draft.criteria.filter((_, i) => i !== criterionIndex) })}><Icon name="close" /></IconButton>
                  </div>)}
                  <Button variant="ghost" size="sm" onClick={() => updateDraft(draft.id, { criteria: [...draft.criteria, { key: "", value: "" }] })}>+ criterio</Button>
                </div> : null}
                {draft.type === "score" ? <div className="crit-list">
                  {draft.levels.map((level, levelIndex) => <div className="crit-row" key={levelIndex}>
                    <span className="crit-index" title={`Nota ${levelIndex}`}>{levelIndex}</span>
                    <input className="input v" aria-label={`Nivel ${levelIndex} de ${draft.name}`} placeholder={`nivel ${levelIndex}`} value={level} onChange={(event) => updateDraft(draft.id, { levels: draft.levels.map((row, i) => i === levelIndex ? event.target.value : row) })} />
                    <IconButton label="Quitar nivel" onClick={() => updateDraft(draft.id, { levels: draft.levels.filter((_, i) => i !== levelIndex) })}><Icon name="close" /></IconButton>
                  </div>)}
                  <Button variant="ghost" size="sm" onClick={() => updateDraft(draft.id, { levels: [...draft.levels, ""] })}>+ nivel</Button>
                </div> : null}
              </article>)}
              <button type="button" className="add-dashed" onClick={() => { const id = Math.max(0, ...drafts.map((draft) => draft.id)) + 1; setDrafts((current) => [...current, newDraft(id)]); }}><Icon name="plus" />Añadir pregunta</button>
              {errors.length > 0 ? <div className="form-error" role="alert">{errors.map((message) => <div key={message}>{message}</div>)}</div> : null}
            </div>
          </Panel>

          <div className="run-bar">
            <div className="field" style={{ flex: "0 1 190px" }}><label htmlFor="ask-model">Modelo · permite valor libre</label><input id="ask-model" className="input mono" list="jev-models" value={model} onChange={(event) => setModel(event.target.value)} /><datalist id="jev-models">{modelOptions.map((option) => <option value={option} key={option} />)}</datalist></div>
            <Switch checked={save} onChange={setSave} label="Guardar en historial" />
            <div className="row push" style={{ gap: 8 }}>
              {running ? <Button variant="danger" onClick={() => abort.current?.abort()}><Icon name="stop" />Cancelar</Button> : null}
              <Button onClick={() => void execute(true)} disabled={running !== null}>{running === "demo" ? "Ejecutando…" : "Ejecutar demo"}</Button>
              <Button variant="primary" onClick={() => void execute(false)} disabled={running !== null || errors.length > 0 || !model.trim()}>{running === "ask" ? "Ejecutando…" : "Evaluar"}</Button>
            </div>
          </div>
        </div>

        <Panel title="Resultado" action={result ? <div style={{ margin: -10 }}><Tabs label="Formato del resultado" value={tab} onChange={setTab} items={[{ id: "report", label: "Informe" }, { id: "json", label: "JSON crudo" }]} /></div> : undefined} className="result-panel">
          {running ? <Loading label="Esperando la respuesta real de Jev…" /> : null}
          {!running && !result ? <div className="empty" style={{ border: 0, paddingTop: 80 }}><Icon name="evaluate" size={22} /><strong>Sin resultados todavía</strong><span>Ejecuta una evaluación o el demo integrado para ver las probabilidades por pregunta.</span></div> : null}
          {!running && result && tab === "json" ? <JsonBlock value={result.response.raw} /> : null}
          {!running && result && tab === "report" ? <>
            <div className="result-meta" style={{ marginBottom: 10 }}>
              <span>modelo <b>{result.response.model || result.request.model}</b></span><span>estado <b>{result.statusCode ?? "—"}</b></span><span><b>{result.usage.inputTokens ?? "—"}</b> in / <b>{result.usage.outputTokens ?? "—"}</b> out</span><span>coste <b>{formatCost(result.usage.cost)}</b></span><span><b>{result.durationMs} ms</b></span>{result.demo ? <span className="chip chip-soft">demo</span> : null}{!result.save ? <span className="chip chip-soft">--no-save</span> : null}{result.requestId ? <span>id <b>#{result.requestId}</b></span> : null}
            </div>
            <div className="stack" style={{ gap: 9 }}>{Object.keys(result.request.questions).map((name) => {
              const answer = result.response.answers[name];
              return answer ? <AnswerCard key={name} name={name} answer={answer} question={result.request.questions[name]} /> : <Callout key={name}>La API no devolvió una respuesta para <code>{name}</code>.</Callout>;
            })}</div>
          </> : null}
        </Panel>
      </div>
      <CliBar command={command} />
    </section>
  );
}
