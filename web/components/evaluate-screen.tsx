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
  if (stateEmpty) errors.push("The state is empty.");
  if (stateError) errors.push(stateError);
  if (drafts.length === 0) errors.push("Add at least one question.");
  const names = new Set<string>();
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!name) errors.push("Every question needs a name.");
    if (name && names.has(name)) errors.push(`The question name “${name}” is duplicated.`);
    names.add(name);
    if (draft.type === "choice") {
      const keys = draft.criteria.map((row) => row.key.trim()).filter(Boolean);
      if (keys.length === 0) errors.push(`“${name || "Unnamed"}” needs at least one choice criterion.`);
      if (new Set(keys).size !== keys.length) errors.push(`“${name}” has duplicated choice keys.`);
    }
    if (draft.type === "score" && !draft.levels.some((level) => level.trim())) {
      errors.push(`“${name || "Unnamed"}” needs at least one score level.`);
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
    reader.onerror = () => reject(reader.error ?? new Error("the file could not be read"));
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
  const fileInput = useRef<HTMLInputElement | null>(null);
  const queryHandled = useRef(false);
  const { request, ready, notify } = useConsole();
  const router = useRouter();
  const searchParams = useSearchParams();

  const parsedState = useMemo(() => parseStateInput(stateText), [stateText]);
  const questions = useMemo(() => questionsFromDrafts(drafts), [drafts]);
  const errors = useMemo(() => validationErrors(drafts, parsedState.kind === "empty" && images.length === 0, parsedState.error), [drafts, parsedState, images]);
  const command = buildAskCommand(stateText, questions, model, defaultModel, save);

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    const accepted: AttachedImage[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/png") && !file.type.startsWith("image/jpeg")) {
        notify(`Ignored ${file.name}: only PNG/JPEG are accepted`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        notify(`Ignored ${file.name}: exceeds 16 MiB`);
        continue;
      }
      try {
        accepted.push(await fileToImage(file));
      } catch {
        notify(`Could not read ${file.name}`);
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
    const keys = images.length === 1 ? ["photo"] : images.map((_, index) => `photo_${index + 1}`);
    const refs: Record<string, string> = {};
    images.forEach((image, index) => {
      refs[keys[index] ?? `photo_${index + 1}`] = image.ref;
    });
    const base =
      parsedState.kind === "JSON" &&
      parsedState.value !== null &&
      typeof parsedState.value === "object" &&
      !Array.isArray(parsedState.value)
        ? (parsedState.value as Record<string, unknown>)
        : parsedState.kind === "empty"
          ? {}
          : { text: stateText };
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
      notify(demo ? "Demo run" : "Evaluation completed");
      if (!save) notify("This run was not saved to history");
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
    router.replace("/evaluate", { scroll: false });
    void execute(true);
    // The palette action only fires when entering with ?run=demo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, router, searchParams]);

  const updateDraft = (id: number, update: Partial<QuestionDraft>) => {
    setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, ...update } : draft));
  };

  const loadExample = async () => {
    try {
      const response = await fetch("/examples/request.json", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not read examples/request.json");
      const example = await response.json() as JevRequest;
      setStateText(JSON.stringify(example.state, null, 2));
      setDrafts(draftsFromQuestions(example.questions));
      // The example's model is only a fallback: keep the configured model
      // selected, matching the CLI/service precedence.
      setResult(null);
      setError(null);
      notify("Real example from examples/request.json loaded");
    } catch (caught) {
      setError(describeApiError(caught));
    }
  };

  const modelOptions = [...new Set([defaultModel, "jev-1.13", "jev-1.13-free", model].filter(Boolean))];

  return (
    <section>
      <ScreenHead
        eyebrow="Inference · jev ask"
        title="Evaluate"
        description={<>A <code>state</code> and one or more typed questions. Jev returns a real answer per question with its probabilities.</>}
        actions={<Button variant="ghost" size="sm" onClick={() => void loadExample()}>Load the ticket example</Button>}
      />
      {error ? <div className="mt-12"><Callout tone="danger"><strong>{error.code}</strong>: {error.message}{error.hint ? <><br /><strong>hint:</strong> {error.hint}</> : null}{["api_key_missing", "api_key_expired"].includes(error.code) ? <> <Link className="link" href="/settings">Open Settings</Link></> : null}</Callout></div> : null}
      <div className="grid grid-ask">
        <div className="stack">
          <Panel title="State" action={<span className="mono text-muted" style={{ fontSize: 10.5 }}>{parsedState.error ? "Invalid JSON" : parsedState.kind}</span>}>
            <textarea className="textarea" rows={5} spellCheck={false} aria-label="Content to evaluate" aria-invalid={Boolean(parsedState.error)} value={stateText} onChange={(event) => setStateText(event.target.value)} placeholder="Plain text, JSON object or JSON array" />
            <p className={`hint${parsedState.error ? " form-error" : ""}`}>{parsedState.error ?? <>If it starts with <code>{"{"}</code> or <code>[</code> it is sent as strict JSON; otherwise as a string.</>}</p>
            <div className="stack" style={{ gap: 6, marginTop: 8 }}>
              <label className="hint">Image (experimental) · PNG/JPEG · max 16 MiB</label>
              <input
                ref={fileInput}
                className="sr-only"
                type="file"
                accept="image/png,image/jpeg"
                multiple
                tabIndex={-1}
                onChange={(event) => {
                  void onFiles(event.target.files);
                  event.target.value = "";
                }}
                aria-label="Attach images"
              />
              <div>
                <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                  <Icon name="upload" />
                  Upload images
                </Button>
              </div>
              {images.length > 0 ? <div className="stack" style={{ gap: 6 }}>
                {images.map((image) => <div className="row" key={image.ref} style={{ gap: 8, alignItems: "center" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image.dataUrl} alt={image.name} width={40} height={40} style={{ objectFit: "cover", borderRadius: 4, border: "1px solid var(--border)" }} />
                  <div className="stack" style={{ gap: 1 }}>
                    <span className="mono" style={{ fontSize: 11 }}>{image.ref}</span>
                    <span className="hint">{image.name} · {image.width}×{image.height} px · {formatBytes(image.bytes)}</span>
                  </div>
                  <IconButton label={`Remove ${image.name}`} onClick={() => setImages((current) => current.filter((item) => item.ref !== image.ref))}><Icon name="close" /></IconButton>
                </div>)}
                <p className="hint">The reference is inserted into <code>state</code>; use it in the <code>instructions</code> (e.g. “Which animal appears in <code>photo</code>?”).</p>
              </div> : null}
            </div>
          </Panel>

          <Panel title="Questions" action={<span className="mono text-muted" style={{ fontSize: 10.5 }}>{drafts.length} {drafts.length === 1 ? "question" : "questions"}</span>}>
            <div className="stack" style={{ gap: 10 }}>
              {drafts.map((draft, index) => <article className="qcard" key={draft.id}>
                <div className="qcard-head">
                  <input className="input" aria-label={`Question name ${index + 1}`} value={draft.name} onChange={(event) => updateDraft(draft.id, { name: event.target.value })} />
                  <select className="select" aria-label={`Question type ${index + 1}`} value={draft.type} onChange={(event) => updateDraft(draft.id, { type: event.target.value as QuestionDraft["type"] })}><option value="noul">noul</option><option value="choice">choice</option><option value="score">score</option></select>
                  <IconButton label={`Delete question ${index + 1}`} disabled={drafts.length === 1} onClick={() => setDrafts((current) => current.filter((item) => item.id !== draft.id))}><Icon name="close" /></IconButton>
                </div>
                <textarea className="textarea" rows={2} aria-label={`Instructions for question ${index + 1}`} placeholder="Instructions for the model" value={draft.instructions} onChange={(event) => updateDraft(draft.id, { instructions: event.target.value })} />
                {draft.type === "noul" ? <input className="input" aria-label={`noul criterion ${index + 1}`} placeholder="Decision criterion (optional)" value={draft.noulCriteria} onChange={(event) => updateDraft(draft.id, { noulCriteria: event.target.value })} /> : null}
                {draft.type === "choice" ? <div className="crit-list">
                  {draft.criteria.map((criterion, criterionIndex) => <div className="crit-row" key={criterionIndex}>
                    <input className="input k" aria-label={`Criterion key ${criterionIndex + 1} of ${draft.name}`} placeholder="key" value={criterion.key} onChange={(event) => updateDraft(draft.id, { criteria: draft.criteria.map((row, i) => i === criterionIndex ? { ...row, key: event.target.value } : row) })} />
                    <input className="input v" aria-label={`Criterion description ${criterionIndex + 1} of ${draft.name}`} placeholder="description" value={criterion.value} onChange={(event) => updateDraft(draft.id, { criteria: draft.criteria.map((row, i) => i === criterionIndex ? { ...row, value: event.target.value } : row) })} />
                    <IconButton label="Remove criterion" onClick={() => updateDraft(draft.id, { criteria: draft.criteria.filter((_, i) => i !== criterionIndex) })}><Icon name="close" /></IconButton>
                  </div>)}
                  <Button variant="ghost" size="sm" onClick={() => updateDraft(draft.id, { criteria: [...draft.criteria, { key: "", value: "" }] })}>+ criterion</Button>
                </div> : null}
                {draft.type === "score" ? <div className="crit-list">
                  {draft.levels.map((level, levelIndex) => <div className="crit-row" key={levelIndex}>
                    <span className="crit-index" title={`Score ${levelIndex}`}>{levelIndex}</span>
                    <input className="input v" aria-label={`Level ${levelIndex} of ${draft.name}`} placeholder={`level ${levelIndex}`} value={level} onChange={(event) => updateDraft(draft.id, { levels: draft.levels.map((row, i) => i === levelIndex ? event.target.value : row) })} />
                    <IconButton label="Remove level" onClick={() => updateDraft(draft.id, { levels: draft.levels.filter((_, i) => i !== levelIndex) })}><Icon name="close" /></IconButton>
                  </div>)}
                  <Button variant="ghost" size="sm" onClick={() => updateDraft(draft.id, { levels: [...draft.levels, ""] })}>+ level</Button>
                </div> : null}
              </article>)}
              <button type="button" className="add-dashed" onClick={() => { const id = Math.max(0, ...drafts.map((draft) => draft.id)) + 1; setDrafts((current) => [...current, newDraft(id)]); }}><Icon name="plus" />Add question</button>
              {errors.length > 0 ? <div className="form-error" role="alert">{errors.map((message) => <div key={message}>{message}</div>)}</div> : null}
            </div>
          </Panel>

          <div className="run-bar">
            <div className="field" style={{ flex: "0 1 190px" }}><label htmlFor="ask-model">Model · free value allowed</label><input id="ask-model" className="input mono" list="jev-models" value={model} onChange={(event) => setModel(event.target.value)} /><datalist id="jev-models">{modelOptions.map((option) => <option value={option} key={option} />)}</datalist></div>
            <Switch checked={save} onChange={setSave} label="Save to history" />
            <div className="row push" style={{ gap: 8 }}>
              {running ? <Button variant="danger" onClick={() => abort.current?.abort()}><Icon name="stop" />Cancel</Button> : null}
              <Button onClick={() => void execute(true)} disabled={running !== null}>{running === "demo" ? "Running…" : "Run demo"}</Button>
              <Button variant="primary" onClick={() => void execute(false)} disabled={running !== null || errors.length > 0 || !model.trim()}>{running === "ask" ? "Running…" : "Evaluate"}</Button>
            </div>
          </div>
        </div>

        <Panel title="Result" action={result ? <div style={{ margin: -10 }}><Tabs label="Result format" value={tab} onChange={setTab} items={[{ id: "report", label: "Report" }, { id: "json", label: "Raw JSON" }]} /></div> : undefined} className="result-panel">
          {running ? <Loading label="Waiting for the real Jev response…" /> : null}
          {!running && !result ? <div className="empty" style={{ border: 0, paddingTop: 80 }}><Icon name="evaluate" size={22} /><strong>No results yet</strong><span>Run an evaluation or the built-in demo to see the probabilities per question.</span></div> : null}
          {!running && result && tab === "json" ? <JsonBlock value={result.response.raw} /> : null}
          {!running && result && tab === "report" ? <>
            <div className="result-meta" style={{ marginBottom: 10 }}>
              <span>model <b>{result.response.model || result.request.model}</b></span><span>status <b>{result.statusCode ?? "—"}</b></span><span><b>{result.usage.inputTokens ?? "—"}</b> in / <b>{result.usage.outputTokens ?? "—"}</b> out</span><span>cost <b>{formatCost(result.usage.cost)}</b></span><span><b>{result.durationMs} ms</b></span>{result.demo ? <span className="chip chip-soft">demo</span> : null}{!result.save ? <span className="chip chip-soft">--no-save</span> : null}{result.requestId ? <span>id <b>#{result.requestId}</b></span> : null}
            </div>
            <div className="stack" style={{ gap: 9 }}>{Object.keys(result.request.questions).map((name) => {
              const answer = result.response.answers[name];
              return answer ? <AnswerCard key={name} name={name} answer={answer} question={result.request.questions[name]} /> : <Callout key={name}>The API did not return an answer for <code>{name}</code>.</Callout>;
            })}</div>
          </> : null}
        </Panel>
      </div>
      <CliBar command={command} />
    </section>
  );
}
