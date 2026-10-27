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
 * Data access needed by the TUI. Backed by the same repositories and SQLite
 * tables used by the non-interactive commands.
 */
export interface TuiBackend {
  getConfig(): ConfigEntry[];
  setConfig(key: ConfigKey, value: string): void;
  listTemplates(): Template[];
  getTemplate(name: string): Template | undefined;
  saveTemplate(name: string, description: string, body: string): void;
  removeTemplate(name: string): boolean;
}

/** Creates the TUI backend over an already-open database. */
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
  model: "Model",
  timeout: "Timeout (s)",
  retries: "Retries",
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

const MENU_ITEMS = ["Provider settings", "Templates", "Quit"] as const;

const BODY_EMPTY = "body cannot be empty";

/**
 * Canonical logical action consumed by the state machine. Printable
 * characters always carry the `char:` prefix to distinguish them from
 * navigation actions (`n` is text, `char:n` is the action).
 */
export type TuiAction =
  | "up"
  | "down"
  | "left"
  | "right"
  | "enter"
  | "esc"
  | "backspace"
  | "delete"
  | "ctrl-a"
  | "ctrl-c"
  | "ctrl-e"
  | `char:${string}`;

/**
 * Checks whether the action is a single-key command, ignoring case
 * (`char:n` and `char:N`). Editor text does not go through here, so it
 * preserves its case.
 */
function isCommand(action: TuiAction, command: string): boolean {
  if (!action.startsWith("char:")) {
    return false;
  }
  return action.slice("char:".length).toLowerCase() === command.toLowerCase();
}

/**
 * TUI state machine, pure and testable: it never touches the terminal.
 * It receives logical "actions" (`up`, `down`, `enter`, `char:x`, …) and
 * exposes the frame to render, besides performing changes through the backend.
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

  handleAction(action: TuiAction): void {
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

  // ── main menu ──────────────────────────────────────────────────────

  private handleMenu(screen: Extract<Screen, { kind: "menu" }>, action: TuiAction): void {
    if (isCommand(action, "q")) {
      this.requestQuit(this.screen);
      return;
    }
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
        this.requestQuit(this.screen);
        break;
      default:
        break;
    }
  }

  private renderMenu(screen: Extract<Screen, { kind: "menu" }>): string[] {
    const lines = [" Jev — interactive mode", " ───────────────────────"];
    MENU_ITEMS.forEach((item, index) => {
      lines.push(`${index === screen.cursor ? "›" : " "} ${item}`);
    });
    lines.push(" ───────────────────────", " ↑/↓ move · Enter select · q quit");
    return lines;
  }

  // ── provider settings ─────────────────────────────────────────────

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
    action: TuiAction,
  ): void {
    if (isCommand(action, "q")) {
      this.screen = { kind: "menu", cursor: 0 };
      return;
    }
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
    action: TuiAction,
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
      this.notice = `settings saved: ${screen.field}`;
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
    const lines = [" Provider settings", " ─────────────────────────"];
    CONFIG_FIELDS.forEach((field, index) => {
      const selected = index === screen.cursor;
      const value = this.configValue(field);
      const display =
        field === "api_key"
          ? value === ""
            ? "(not set)"
            : maskSecret(value)
          : value;
      lines.push(`${selected ? "›" : " "} ${CONFIG_LABELS[field].padEnd(12)} ${display}`);
    });
    lines.push(" ─────────────────────────", " ↑/↓ move · Enter edit · q menu");
    return lines;
  }

  private renderProviderEdit(
    screen: Extract<Screen, { kind: "provider-edit" }>,
  ): string[] {
    const label = CONFIG_LABELS[screen.field];
    const masked = screen.field === "api_key";
    const lines = [` Edit ${label}`, " ─────────────────────────", ""];
    lines.push(` ${label} > ${renderInput(screen.value, screen.cursor, masked)}`);
    if (screen.field === "api_key") {
      lines.push("", " (the key is stored in plain text in the SQLite database)");
    }
    if (screen.error !== null) {
      lines.push("", ` error: ${screen.error}`);
    }
    lines.push("", " Enter save · Esc cancel");
    return lines;
  }

  // ── templates ──────────────────────────────────────────────────────

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
    action: TuiAction,
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

    if (isCommand(action, "/")) {
      screen.filtering = true;
      return;
    }
    if (isCommand(action, "n")) {
      this.screen = this.newEditor();
      return;
    }
    if (isCommand(action, "e")) {
      const template = matches[screen.cursor];
      if (template !== undefined) {
        this.screen = this.editEditor(template);
      }
      return;
    }
    if (isCommand(action, "d")) {
      const template = matches[screen.cursor];
      if (template !== undefined) {
        this.screen = {
          kind: "confirm",
          action: "delete-template",
          name: template.name,
          returnTo: this.screen,
        };
      }
      return;
    }
    if (isCommand(action, "q")) {
      this.screen = { kind: "menu", cursor: 1 };
      return;
    }

    switch (action) {
      case "up":
        screen.cursor = Math.max(0, screen.cursor - 1);
        break;
      case "down":
        screen.cursor = Math.min(Math.max(0, matches.length - 1), screen.cursor + 1);
        break;
      case "enter": {
        const template = matches[screen.cursor];
        if (template !== undefined) {
          this.screen = { kind: "template-detail", name: template.name };
        }
        break;
      }
      case "esc":
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
    const lines = [" Templates", " ──────────"];
    const cursor = screen.filtering ? "█" : "";
    lines.push(` Search: ${screen.query}${cursor}`);
    lines.push("");
    const matches = this.matchingTemplates(screen.query);
    if (matches.length === 0) {
      lines.push(" (no results)");
    } else {
      matches.forEach((template, index) => {
        const selected = !screen.filtering && index === screen.cursor;
        const suffix = template.description ? ` - ${template.description}` : "";
        lines.push(`${selected ? "›" : " "} ${template.name}${suffix}`);
      });
    }
    lines.push(
      "",
      " (n) new · (e) edit · (d) delete · (/) search · Enter view · q menu",
    );
    return lines;
  }

  private handleTemplateDetail(
    screen: Extract<Screen, { kind: "template-detail" }>,
    action: TuiAction,
  ): void {
    if (isCommand(action, "b") || isCommand(action, "q")) {
      this.openTemplates();
      return;
    }
    if (isCommand(action, "e")) {
      const template = this.backend.getTemplate(screen.name);
      if (template !== undefined) {
        this.screen = this.editEditor(template);
      }
      return;
    }
    if (isCommand(action, "d")) {
      this.screen = {
        kind: "confirm",
        action: "delete-template",
        name: screen.name,
        returnTo: this.screen,
      };
      return;
    }

    switch (action) {
      case "esc":
        this.openTemplates();
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
      return [` Template: ${screen.name}`, " ─────────────────", " (not found)"];
    }
    const macros = template.macros;
    const lines = [
      ` Template: ${template.name}`,
      " ─────────────────",
      ` Description: ${template.description || "-"}`,
      ` Macros: ${macros.length > 0 ? macros.map((macro) => macro.name).join(", ") : "(none)"}`,
      "",
      " Body:",
      prettyJson(template.body_json),
    ];
    if (macros.some((macro) => macro.description !== "")) {
      lines.push("", " Descriptions:");
      for (const macro of macros) {
        if (macro.description !== "") {
          lines.push(`  {{${macro.name}}}: ${macro.description}`);
        }
      }
    }
    lines.push("", " (e) edit · (d) delete · b back");
    return lines;
  }

  // ── template editor ───────────────────────────────────────────────

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

  private handleTemplateEditor(screen: TemplateEditor, action: TuiAction): void {
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
          this.notice = `a template named ${name} already exists`;
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

    // body step
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
      screen.mode === "create" ? "New template" : `Edit template: ${screen.name}`;
    const lines = [` ${title}`, " ─────────────────"];

    const nameCursor = screen.step === "name" ? "█" : "";
    lines.push(` Name: ${screen.name}${nameCursor}`);

    const descCursor = screen.step === "description" ? "█" : "";
    lines.push(` Description: ${screen.description}${descCursor}`);

    if (screen.step === "body") {
      lines.push(
        ` Body (JSON): ${renderInput(screen.body, screen.bodyCursor, false)}`,
      );
    } else {
      lines.push(` Body (JSON): ${screen.body}`);
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
          ` ✓ valid · macros: ${macros.length > 0 ? macros.join(", ") : "(none)"}`,
        );
      }
    }

    lines.push("", " Enter next · Esc cancel");
    return lines;
  }

  // ── confirmations ──────────────────────────────────────────────────

  private handleConfirm(screen: Confirm, action: TuiAction): void {
    const yes =
      action === "enter" || isCommand(action, "s") || isCommand(action, "y");
    const no =
      action === "esc" ||
      isCommand(action, "n") ||
      (action === "ctrl-c" && screen.action !== "quit");

    if (yes || (action === "ctrl-c" && screen.action === "quit")) {
      switch (screen.action) {
        case "delete-template":
          this.backend.removeTemplate(screen.name);
          this.notice = `template deleted: ${screen.name}`;
          this.openTemplates();
          break;
        case "save-template":
          this.backend.saveTemplate(screen.name, screen.description, screen.body);
          this.dirty = false;
          this.notice = `template saved: ${screen.name}`;
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
        prompt = `Delete template '${screen.name}'? [y/N]`;
        break;
      case "save-template":
        prompt = `Save template '${screen.name}'? [y/N]`;
        break;
      case "discard":
        prompt = "Discard unsaved changes? [y/N]";
        break;
      case "quit":
        prompt = "There are unsaved changes. Quit anyway? [y/N]";
        break;
    }
    return [" ─────────────────", ` ${prompt}`, " ─────────────────"];
  }

  // ── exit ───────────────────────────────────────────────────────────

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
  action: TuiAction,
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

// ── terminal driver ─────────────────────────────────────────────────

export interface KeypressKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
}

/** Translates a readline key event into a logical action. */
export function keyToAction(key: KeypressKey): TuiAction | null {
  const name = key.name;
  if (key.ctrl === true) {
    if (name === "c") return "ctrl-c";
    if (name === "a") return "ctrl-a";
    if (name === "e") return "ctrl-e";
  }
  // ESC only arrives with `meta: true`, so it is checked before discarding
  // sequences with meta (Alt+key).
  if (name === "escape") {
    return "esc";
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
 * Runs the TUI on the current terminal (raw mode). Returns the exit code.
 * Requires a TTY; `runCli` checks this before calling it.
 */
export async function runTui(backend: TuiBackend): Promise<number> {
  const app = new TuiApp(backend);
  const stdin = process.stdin;
  const stdout = process.stdout;

  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();

  const queue: TuiAction[] = [];
  let resolveNext: ((action: TuiAction) => void) | null = null;

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

  const nextAction = (): Promise<TuiAction> =>
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
