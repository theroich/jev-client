import { emitKeypressEvents, type Key } from "node:readline";

import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
} from "./config.js";
import {
  ConfigRepository,
  validateConfigValue,
  type ConfigEntry,
  type ConfigKey,
} from "./config-repository.js";
import type { SqliteDatabase } from "./database.js";
import { maskSecret } from "./format.js";
import { detectMacros, validateTemplateBody } from "./template.js";
import type { Template } from "./template-repository.js";
import { TemplateRepository } from "./template-repository.js";

/**
 * Acceso a los datos que necesita la TUI. Respaldado por los mismos
 * repositorios y tablas SQLite que usan los comandos no interactivos.
 */
export interface TuiBackend {
  getConfig(): ConfigEntry[];
  setConfig(key: ConfigKey, value: string): void;
  listTemplates(): Template[];
  getTemplate(name: string): Template | undefined;
  saveTemplate(name: string, description: string, body: string): void;
  removeTemplate(name: string): boolean;
}

/** Crea el backend de la TUI sobre una base ya abierta. */
export function createTuiBackend(db: SqliteDatabase): TuiBackend {
  const config = new ConfigRepository(db);
  const templates = new TemplateRepository(db);
  return {
    getConfig: () => config.list(),
    setConfig: (key, value) => config.set(key, value),
    listTemplates: () => templates.list(),
    getTemplate: (name) => templates.get(name),
    saveTemplate: (name, description, body) =>
      templates.save(name, description, body),
    removeTemplate: (name) => templates.remove(name),
  };
}

const CONFIG_FIELDS: readonly ConfigKey[] = [
  "api_url",
  "api_key",
  "model",
  "timeout",
  "retries",
];

const CONFIG_LABELS: Record<ConfigKey, string> = {
  api_url: "URL",
  api_key: "API key",
  model: "Modelo",
  timeout: "Timeout (s)",
  retries: "Reintentos",
};

type Confirm =
  | { kind: "confirm"; action: "delete-template"; name: string; returnTo: Screen }
  | {
      kind: "confirm";
      action: "save-template";
      mode: "create" | "edit";
      name: string;
      description: string;
      body: string;
      returnTo: Screen;
    }
  | { kind: "confirm"; action: "discard"; returnTo: Screen }
  | { kind: "confirm"; action: "quit"; returnTo: Screen };

interface TemplateEditor {
  kind: "template-editor";
  mode: "create" | "edit";
  original: { name: string; description: string; body: string };
  name: string;
  description: string;
  body: string;
  bodyCursor: number;
  step: "name" | "description" | "body";
  error: string | null;
}

type Screen =
  | { kind: "menu"; cursor: number }
  | { kind: "provider"; cursor: number }
  | { kind: "provider-edit"; field: ConfigKey; value: string; cursor: number; error: string | null }
  | { kind: "templates"; query: string; filtering: boolean; cursor: number }
  | { kind: "template-detail"; name: string }
  | TemplateEditor
  | Confirm;

const MENU_ITEMS = [
  "Configuración del provider",
  "Plantillas",
  "Salir",
] as const;

const BODY_EMPTY = "el cuerpo no puede estar vacío";

/**
 * Máquina de estados de la TUI, pura y testeable: no toca la terminal.
 * Recibe "acciones" lógicas (`up`, `down`, `enter`, `char:x`, …) y expone el
 * frame a renderizar, además de realizar los cambios a través del backend.
 */
export class TuiApp {
  done = false;
  exitCode = 0;

  private screen: Screen;
  private dirty = false;
  private notice: string | null = null;
  private readonly config = new Map<ConfigKey, string>();
  private templates: Template[];

  constructor(private readonly backend: TuiBackend) {
    this.screen = { kind: "menu", cursor: 0 };
    for (const entry of backend.getConfig()) {
      this.config.set(entry.key, entry.value);
    }
    this.templates = backend.listTemplates();
  }

  handleAction(action: string): void {
    if (this.done) {
      return;
    }
    const screen = this.screen;
    if (screen.kind === "confirm") {
      this.handleConfirm(screen, action);
      return;
    }
    this.notice = null;
    switch (screen.kind) {
      case "menu":
        this.handleMenu(screen, action);
        break;
      case "provider":
        this.handleProvider(screen, action);
        break;
      case "provider-edit":
        this.handleProviderEdit(screen, action);
        break;
      case "templates":
        this.handleTemplates(screen, action);
        break;
      case "template-detail":
        this.handleTemplateDetail(screen, action);
        break;
      case "template-editor":
        this.handleTemplateEditor(screen, action);
        break;
    }
  }

  render(): string {
    const screen = this.screen;
    let lines: string[];
    switch (screen.kind) {
      case "menu":
        lines = this.renderMenu(screen);
        break;
      case "provider":
        lines = this.renderProvider(screen);
        break;
      case "provider-edit":
        lines = this.renderProviderEdit(screen);
        break;
      case "templates":
        lines = this.renderTemplates(screen);
        break;
      case "template-detail":
        lines = this.renderTemplateDetail(screen);
        break;
      case "template-editor":
        lines = this.renderTemplateEditor(screen);
        break;
      case "confirm":
        lines = this.renderConfirm(screen);
        break;
    }
    if (this.notice !== null && !(this.screen.kind === "confirm")) {
      lines.push(` (${this.notice})`);
    }
    return `${lines.join("\n")}\n`;
  }

  // ── menú principal ────────────────────────────────────────────────

  private handleMenu(screen: Extract<Screen, { kind: "menu" }>, action: string): void {
    switch (action) {
      case "up":
        screen.cursor = Math.max(0, screen.cursor - 1);
        break;
      case "down":
        screen.cursor = Math.min(MENU_ITEMS.length - 1, screen.cursor + 1);
        break;
      case "enter":
        if (screen.cursor === 0) {
          this.screen = { kind: "provider", cursor: 0 };
        } else if (screen.cursor === 1) {
          this.openTemplates();
        } else {
          this.requestQuit(this.screen);
        }
        break;
      case "ctrl-c":
      case "q":
        this.requestQuit(this.screen);
        break;
      default:
        break;
    }
  }

  private renderMenu(screen: Extract<Screen, { kind: "menu" }>): string[] {
    const lines = [
      " Jev — modo interactivo",
      " ───────────────────────",
    ];
    MENU_ITEMS.forEach((item, index) => {
      lines.push(`${index === screen.cursor ? "›" : " "} ${item}`);
    });
    lines.push(" ───────────────────────", " ↑/↓ mover · Enter elegir · q salir");
    return lines;
  }

  // ── configuración del provider ────────────────────────────────────

  private configValue(key: ConfigKey): string {
    const stored = this.config.get(key);
    if (stored !== undefined) {
      return stored;
    }
    switch (key) {
      case "api_url":
        return DEFAULT_ENDPOINT;
      case "model":
        return DEFAULT_MODEL;
      case "timeout":
        return String(Math.round(DEFAULT_TIMEOUT_MS / 1000));
      case "retries":
        return String(DEFAULT_RETRIES);
      default:
        return "";
    }
  }

  private handleProvider(
    screen: Extract<Screen, { kind: "provider" }>,
    action: string,
  ): void {
    switch (action) {
      case "up":
        screen.cursor = Math.max(0, screen.cursor - 1);
        break;
      case "down":
        screen.cursor = Math.min(CONFIG_FIELDS.length - 1, screen.cursor + 1);
        break;
      case "enter": {
        const field = CONFIG_FIELDS[screen.cursor] as ConfigKey;
        const value = field === "api_key" ? "" : this.configValue(field);
        this.screen = {
          kind: "provider-edit",
          field,
          value,
          cursor: value.length,
          error: null,
        };
        break;
      }
      case "esc":
      case "q":
        this.screen = { kind: "menu", cursor: 0 };
        break;
      case "ctrl-c":
        this.requestQuit(this.screen);
        break;
      default:
        break;
    }
  }

  private handleProviderEdit(
    screen: Extract<Screen, { kind: "provider-edit" }>,
    action: string,
  ): void {
    if (action === "esc") {
      this.screen = { kind: "provider", cursor: CONFIG_FIELDS.indexOf(screen.field) };
      return;
    }
    if (action === "ctrl-c") {
      this.requestQuit(this.screen);
      return;
    }
    if (action === "enter") {
      const value = screen.value.trim();
      if (value === "") {
        this.screen = { kind: "provider", cursor: CONFIG_FIELDS.indexOf(screen.field) };
        return;
      }
      try {
        validateConfigValue(screen.field, value);
      } catch (error) {
        screen.error = messageOf(error);
        return;
      }
      this.backend.setConfig(screen.field, value);
      this.config.set(screen.field, value);
      this.notice = `configuración guardada: ${screen.field}`;
      this.screen = { kind: "provider", cursor: CONFIG_FIELDS.indexOf(screen.field) };
      return;
    }
    const next = editValue(screen.value, screen.cursor, action);
    screen.value = next.value;
    screen.cursor = next.cursor;
    screen.error = this.validateConfigField(screen.field, screen.value);
  }

  private validateConfigField(field: ConfigKey, value: string): string | null {
    if (value.trim() === "") {
      return null;
    }
    try {
      validateConfigValue(field, value);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  private renderProvider(screen: Extract<Screen, { kind: "provider" }>): string[] {
    const lines = [" Configuración del provider", " ─────────────────────────"];
    CONFIG_FIELDS.forEach((field, index) => {
      const selected = index === screen.cursor;
      const value = this.configValue(field);
      const display =
        field === "api_key"
          ? value === ""
            ? "(no definida)"
            : maskSecret(value)
          : value;
      lines.push(`${selected ? "›" : " "} ${CONFIG_LABELS[field].padEnd(12)} ${display}`);
    });
    lines.push(" ─────────────────────────", " ↑/↓ mover · Enter editar · q menú");
    return lines;
  }

  private renderProviderEdit(
    screen: Extract<Screen, { kind: "provider-edit" }>,
  ): string[] {
    const label = CONFIG_LABELS[screen.field];
    const masked = screen.field === "api_key";
    const lines = [` Editar ${label}`, " ─────────────────────────", ""];
    lines.push(` ${label} > ${renderInput(screen.value, screen.cursor, masked)}`);
    if (screen.field === "api_key") {
      lines.push("", " (la key se guarda en claro en la base SQLite)");
    }
    if (screen.error !== null) {
      lines.push("", ` error: ${screen.error}`);
    }
    lines.push("", " Enter guardar · Esc cancelar");
    return lines;
  }

  // ── plantillas ─────────────────────────────────────────────────────

  private openTemplates(): void {
    this.templates = this.backend.listTemplates();
    this.screen = { kind: "templates", query: "", filtering: false, cursor: 0 };
  }

  private matchingTemplates(query: string): Template[] {
    const q = query.trim().toLowerCase();
    if (q === "") {
      return this.templates;
    }
    return this.templates.filter(
      (template) =>
        template.name.toLowerCase().includes(q) ||
        template.description.toLowerCase().includes(q),
    );
  }

  private handleTemplates(
    screen: Extract<Screen, { kind: "templates" }>,
    action: string,
  ): void {
    if (screen.filtering) {
      if (action === "esc" || action === "enter") {
        screen.filtering = false;
      } else if (action === "backspace") {
        screen.query = screen.query.slice(0, -1);
        screen.cursor = 0;
      } else if (action.startsWith("char:")) {
        screen.query += action.slice("char:".length);
        screen.cursor = 0;
      }
      return;
    }

    const matches = this.matchingTemplates(screen.query);
    screen.cursor = Math.min(screen.cursor, Math.max(0, matches.length - 1));

    switch (action) {
      case "up":
        screen.cursor = Math.max(0, screen.cursor - 1);
        break;
      case "down":
        screen.cursor = Math.min(Math.max(0, matches.length - 1), screen.cursor + 1);
        break;
      case "/":
        screen.filtering = true;
        break;
      case "enter": {
        const template = matches[screen.cursor];
        if (template !== undefined) {
          this.screen = { kind: "template-detail", name: template.name };
        }
        break;
      }
      case "n":
        this.screen = this.newEditor();
        break;
      case "e": {
        const template = matches[screen.cursor];
        if (template !== undefined) {
          this.screen = this.editEditor(template);
        }
        break;
      }
      case "d": {
        const template = matches[screen.cursor];
        if (template !== undefined) {
          this.screen = {
            kind: "confirm",
            action: "delete-template",
            name: template.name,
            returnTo: this.screen,
          };
        }
        break;
      }
      case "esc":
      case "q":
        this.screen = { kind: "menu", cursor: 1 };
        break;
      case "ctrl-c":
        this.requestQuit(this.screen);
        break;
      default:
        break;
    }
  }

  private renderTemplates(
    screen: Extract<Screen, { kind: "templates" }>,
  ): string[] {
    const lines = [" Plantillas", " ──────────"];
    const cursor = screen.filtering ? "█" : "";
    lines.push(` Buscar: ${screen.query}${cursor}`);
    lines.push("");
    const matches = this.matchingTemplates(screen.query);
    if (matches.length === 0) {
      lines.push(" (sin resultados)");
    } else {
      matches.forEach((template, index) => {
        const selected = !screen.filtering && index === screen.cursor;
        const suffix = template.description ? ` - ${template.description}` : "";
        lines.push(`${selected ? "›" : " "} ${template.name}${suffix}`);
      });
    }
    lines.push(
      "",
      " (n) nueva · (e) editar · (d) borrar · (/) buscar · Enter ver · q menú",
    );
    return lines;
  }

  private handleTemplateDetail(
    screen: Extract<Screen, { kind: "template-detail" }>,
    action: string,
  ): void {
    switch (action) {
      case "esc":
      case "b":
      case "q":
        this.openTemplates();
        break;
      case "e": {
        const template = this.backend.getTemplate(screen.name);
        if (template !== undefined) {
          this.screen = this.editEditor(template);
        }
        break;
      }
      case "d":
        this.screen = {
          kind: "confirm",
          action: "delete-template",
          name: screen.name,
          returnTo: this.screen,
        };
        break;
      case "ctrl-c":
        this.requestQuit(this.screen);
        break;
      default:
        break;
    }
  }

  private renderTemplateDetail(
    screen: Extract<Screen, { kind: "template-detail" }>,
  ): string[] {
    const template = this.backend.getTemplate(screen.name);
    if (template === undefined) {
      return [` Plantilla: ${screen.name}`, " ─────────────────", " (no encontrada)"];
    }
    const macros = detectMacros(template.body_json);
    const lines = [
      ` Plantilla: ${template.name}`,
      " ─────────────────",
      ` Descripción: ${template.description || "-"}`,
      ` Macros: ${macros.length > 0 ? macros.join(", ") : "(ninguna)"}`,
      "",
      " Cuerpo:",
      prettyJson(template.body_json),
      "",
      " (e) editar · (d) borrar · b volver",
    ];
    return lines;
  }

  // ── editor de plantillas ──────────────────────────────────────────

  private newEditor(): Screen {
    this.dirty = false;
    return {
      kind: "template-editor",
      mode: "create",
      original: { name: "", description: "", body: "" },
      name: "",
      description: "",
      body: "",
      bodyCursor: 0,
      step: "name",
      error: null,
    };
  }

  private editEditor(template: Template): Screen {
    this.dirty = false;
    const body = compactJson(template.body_json);
    return {
      kind: "template-editor",
      mode: "edit",
      original: { name: template.name, description: template.description, body },
      name: template.name,
      description: template.description,
      body,
      bodyCursor: body.length,
      step: "description",
      error: null,
    };
  }

  private hasChanges(screen: TemplateEditor): boolean {
    return (
      screen.name !== screen.original.name ||
      screen.description !== screen.original.description ||
      screen.body !== screen.original.body
    );
  }

  private handleTemplateEditor(screen: TemplateEditor, action: string): void {
    if (action === "ctrl-c") {
      this.requestQuit(this.screen);
      return;
    }
    if (action === "esc") {
      this.cancelEditor(screen);
      return;
    }

    if (screen.step === "name") {
      if (action === "enter") {
        const name = screen.name.trim();
        if (name === "") {
          return;
        }
        if (this.backend.getTemplate(name) !== undefined) {
          this.notice = `ya existe una plantilla con el nombre ${name}`;
          return;
        }
        screen.step = "description";
        return;
      }
      const next = editValue(screen.name, screen.name.length, action);
      screen.name = next.value;
      this.dirty = this.hasChanges(screen);
      return;
    }

    if (screen.step === "description") {
      if (action === "enter") {
        screen.step = "body";
        screen.error = this.validateBody(screen.body);
        return;
      }
      const next = editValue(screen.description, screen.description.length, action);
      screen.description = next.value;
      this.dirty = this.hasChanges(screen);
      return;
    }

    // paso body
    if (action === "enter") {
      if (screen.error === null && screen.body.trim() !== "") {
        this.screen = {
          kind: "confirm",
          action: "save-template",
          mode: screen.mode,
          name: screen.name.trim(),
          description: screen.description,
          body: screen.body,
          returnTo: this.screen,
        };
      }
      return;
    }
    const next = editValue(screen.body, screen.bodyCursor, action);
    screen.body = next.value;
    screen.bodyCursor = next.cursor;
    screen.error = this.validateBody(screen.body);
    this.dirty = this.hasChanges(screen);
  }

  private validateBody(body: string): string | null {
    if (body.trim() === "") {
      return BODY_EMPTY;
    }
    try {
      validateTemplateBody(body);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  private cancelEditor(screen: TemplateEditor): void {
    if (this.dirty) {
      this.screen = { kind: "confirm", action: "discard", returnTo: this.screen };
    } else {
      this.openTemplates();
    }
  }

  private renderTemplateEditor(screen: TemplateEditor): string[] {
    const title =
      screen.mode === "create" ? "Nueva plantilla" : `Editar plantilla: ${screen.name}`;
    const lines = [` ${title}`, " ─────────────────"];

    const nameCursor = screen.step === "name" ? "█" : "";
    lines.push(` Nombre: ${screen.name}${nameCursor}`);

    const descCursor = screen.step === "description" ? "█" : "";
    lines.push(` Descripción: ${screen.description}${descCursor}`);

    if (screen.step === "body") {
      lines.push(
        ` Cuerpo (JSON): ${renderInput(screen.body, screen.bodyCursor, false)}`,
      );
    } else {
      lines.push(` Cuerpo (JSON): ${screen.body}`);
    }

    lines.push("");
    if (screen.step === "body") {
      if (screen.error !== null) {
        lines.push(` error: ${screen.error}`);
      } else if (screen.body.trim() === "") {
        lines.push(` ${BODY_EMPTY}`);
      } else {
        const macros = detectMacros(screen.body);
        lines.push(
          ` ✓ válido · macros: ${macros.length > 0 ? macros.join(", ") : "(ninguna)"}`,
        );
      }
    }

    lines.push("", " Enter siguiente · Esc cancelar");
    return lines;
  }

  // ── confirmaciones ─────────────────────────────────────────────────

  private handleConfirm(screen: Confirm, action: string): void {
    const yes =
      action === "enter" ||
      ["char:s", "char:S", "char:y", "char:Y", "char:sí", "char:si"].includes(action);
    const no =
      action === "esc" ||
      action === "char:n" ||
      action === "char:N" ||
      (action === "ctrl-c" && screen.action !== "quit");

    if (yes || (action === "ctrl-c" && screen.action === "quit")) {
      switch (screen.action) {
        case "delete-template":
          this.backend.removeTemplate(screen.name);
          this.notice = `plantilla eliminada: ${screen.name}`;
          this.openTemplates();
          break;
        case "save-template":
          this.backend.saveTemplate(screen.name, screen.description, screen.body);
          this.dirty = false;
          this.notice = `plantilla guardada: ${screen.name}`;
          this.openTemplates();
          break;
        case "discard":
          this.dirty = false;
          this.openTemplates();
          break;
        case "quit":
          this.finish(0);
          break;
      }
      return;
    }

    if (no) {
      this.screen = screen.returnTo;
    }
  }

  private renderConfirm(screen: Confirm): string[] {
    let prompt: string;
    switch (screen.action) {
      case "delete-template":
        prompt = `¿Eliminar la plantilla '${screen.name}'? [s/N]`;
        break;
      case "save-template":
        prompt = `¿Guardar la plantilla '${screen.name}'? [s/N]`;
        break;
      case "discard":
        prompt = "¿Descartar los cambios sin guardar? [s/N]";
        break;
      case "quit":
        prompt = "Hay cambios sin guardar. ¿Salir igualmente? [s/N]";
        break;
    }
    return [" ─────────────────", ` ${prompt}`, " ─────────────────"];
  }

  // ── salida ─────────────────────────────────────────────────────────

  private requestQuit(from: Screen): void {
    if (this.dirty) {
      this.screen = { kind: "confirm", action: "quit", returnTo: from };
    } else {
      this.finish(0);
    }
  }

  private finish(code: number): void {
    this.done = true;
    this.exitCode = code;
  }
}

function renderInput(value: string, cursor: number, masked: boolean): string {
  const display = masked ? "•".repeat(value.length) : value;
  const before = display.slice(0, cursor);
  const after = display.slice(cursor);
  return `${before}█${after}`;
}

function editValue(
  value: string,
  cursor: number,
  action: string,
): { value: string; cursor: number } {
  if (action === "left") {
    return { value, cursor: Math.max(0, cursor - 1) };
  }
  if (action === "right") {
    return { value, cursor: Math.min(value.length, cursor + 1) };
  }
  if (action === "backspace") {
    if (cursor === 0) {
      return { value, cursor };
    }
    return {
      value: value.slice(0, cursor - 1) + value.slice(cursor),
      cursor: cursor - 1,
    };
  }
  if (action === "delete") {
    if (cursor >= value.length) {
      return { value, cursor };
    }
    return {
      value: value.slice(0, cursor) + value.slice(cursor + 1),
      cursor,
    };
  }
  if (action === "ctrl-a") {
    return { value, cursor: 0 };
  }
  if (action === "ctrl-e") {
    return { value, cursor: value.length };
  }
  if (action.startsWith("char:")) {
    const char = action.slice("char:".length);
    return {
      value: value.slice(0, cursor) + char + value.slice(cursor),
      cursor: cursor + char.length,
    };
  }
  return { value, cursor };
}

function compactJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body));
  } catch {
    return body;
  }
}

function prettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── driver de terminal ───────────────────────────────────────────────

interface KeypressKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
}

/** Traduce un evento de teclado de readline a una acción lógica. */
export function keyToAction(key: KeypressKey): string | null {
  const name = key.name;
  if (key.ctrl === true) {
    if (name === "c") return "ctrl-c";
    if (name === "a") return "ctrl-a";
    if (name === "e") return "ctrl-e";
  }
  if (key.meta === true) {
    return null;
  }
  if (name === "up" || name === "down" || name === "left" || name === "right") {
    return name;
  }
  if (name === "return" || name === "enter") {
    return "enter";
  }
  if (name === "escape") {
    return "esc";
  }
  if (name === "backspace") {
    return "backspace";
  }
  if (name === "delete") {
    return "delete";
  }
  if (key.sequence !== undefined && key.sequence.length === 1) {
    return `char:${key.sequence}`;
  }
  return null;
}

/**
 * Ejecuta la TUI sobre la terminal actual (modo raw). Devuelve el código de
 * salida. Requiere una TTY; `runCli` comprueba esto antes de llamarla.
 */
export async function runTui(backend: TuiBackend): Promise<number> {
  const app = new TuiApp(backend);
  const stdin = process.stdin;
  const stdout = process.stdout;

  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();

  const queue: string[] = [];
  let resolveNext: ((action: string) => void) | null = null;

  const onKeypress = (_str: string, key: Key) => {
    const action = keyToAction(key);
    if (action === null) {
      return;
    }
    if (resolveNext !== null) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve(action);
    } else {
      queue.push(action);
    }
  };

  stdin.on("keypress", onKeypress);

  const nextAction = (): Promise<string> =>
    new Promise((resolve) => {
      const queued = queue.shift();
      if (queued !== undefined) {
        resolve(queued);
        return;
      }
      resolveNext = resolve;
    });

  const writeFrame = () => {
    stdout.write("\x1b[?25l");
    stdout.write("\x1b[2J\x1b[H");
    stdout.write(app.render());
  };

  try {
    writeFrame();
    while (!app.done) {
      const action = await nextAction();
      app.handleAction(action);
      writeFrame();
    }
    return app.exitCode;
  } finally {
    stdout.write("\x1b[?25h");
    stdin.setRawMode(false);
    stdin.off("keypress", onKeypress);
    stdin.pause();
  }
}
