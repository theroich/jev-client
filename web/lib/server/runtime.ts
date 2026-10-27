import "server-only";

import packageManifest from "../../../package.json";
import type { FetchLike } from "../../../dist/src/client.js";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  resolveConfig,
  type ConfigFlags,
  type StoredConfig,
} from "../../../dist/src/config.js";
import {
  CONFIG_KEYS,
  ConfigRepository,
  isConfigKey,
  validateConfigValue,
  type ConfigKey,
} from "../../../dist/src/config-repository.js";
import { JevApiError } from "../../../dist/src/errors.js";
import { historyRecordToJson, maskSecret } from "../../../dist/src/format.js";
import {
  RequestRepository,
  type HistoryFilters,
  type RequestRecord,
} from "../../../dist/src/request-repository.js";
import { JevService } from "../../../dist/src/service.js";
import {
  TemplateRepository,
  MAX_MACRO_DESCRIPTION_LENGTH,
  MacroSchemaError,
  validateMacroSchema,
  type MacroSchema,
  type Template,
  type TemplateMacro,
} from "../../../dist/src/template-repository.js";
import {
  detectMacros,
  resolveTemplateBody,
  validateQuestions,
  validateTemplateBody,
  type TemplateContext,
} from "../../../dist/src/template.js";
import type { ImageAsset, JevRequest, State } from "../../../dist/src/types.js";
import type {
  ConfigEntryDto,
  ConfigSnapshot,
  ConfigSource,
  ExecutionResult,
  HistoryDetail,
  HistoryPage,
  Overview,
  RequestSummary,
  ShellData,
  TemplateDetail,
  TemplateSummary,
} from "@/lib/types";
import { ConsoleError, providerHint } from "./api";
import type { ParsedHistoryFilters } from "./history";

export interface ConsoleRuntimeOptions {
  flags?: ConfigFlags;
  env?: NodeJS.ProcessEnv;
  dbPath?: string;
  fetch?: FetchLike;
}

export interface ConsoleRuntime {
  service: JevService;
  requests: RequestRepository;
  templates: TemplateRepository;
  config: ConfigRepository;
  flags: ConfigFlags;
  env: NodeJS.ProcessEnv;
  startedAt: number;
  providerStatus: "unknown" | "ok" | "error";
}

const globalRuntime = globalThis as typeof globalThis & {
  __jevConsoleRuntime?: ConsoleRuntime;
};

export function createConsoleRuntime(options: ConsoleRuntimeOptions = {}): ConsoleRuntime {
  const env = options.env ?? process.env;
  const flags = options.flags ?? flagsFromEnvironment(env);
  const service = new JevService({
    flags,
    env,
    dbPath: options.dbPath ?? env.JEV_CONSOLE_DB_PATH,
    fetch: options.fetch,
  });
  return {
    service,
    requests: new RequestRepository(service.db),
    templates: new TemplateRepository(service.db),
    config: new ConfigRepository(service.db),
    flags,
    env,
    startedAt: Date.now(),
    providerStatus: "unknown",
  };
}

export function getConsoleRuntime(): ConsoleRuntime {
  globalRuntime.__jevConsoleRuntime ??= createConsoleRuntime();
  return globalRuntime.__jevConsoleRuntime;
}

export function installConsoleRuntime(runtime: ConsoleRuntime): void {
  globalRuntime.__jevConsoleRuntime = runtime;
}

export function closeConsoleRuntime(): void {
  globalRuntime.__jevConsoleRuntime?.service.close();
  delete globalRuntime.__jevConsoleRuntime;
}

function flagsFromEnvironment(env: NodeJS.ProcessEnv): ConfigFlags {
  const timeout = env.JEV_CONSOLE_TIMEOUT;
  const retries = env.JEV_CONSOLE_RETRIES;
  return {
    key: env.JEV_CONSOLE_API_KEY,
    url: env.JEV_CONSOLE_API_URL,
    model: env.JEV_CONSOLE_MODEL,
    timeoutMs: timeout === undefined ? undefined : Number(timeout) * 1000,
    retries: retries === undefined ? undefined : Number(retries),
  };
}

function storedConfig(runtime: ConsoleRuntime): StoredConfig {
  const stored: StoredConfig = {};
  for (const { key, value } of runtime.config.list()) stored[key] = value;
  return stored;
}

function resolvedConfig(runtime: ConsoleRuntime) {
  return resolveConfig(runtime.flags, runtime.env, storedConfig(runtime));
}

function flagSource(runtime: ConsoleRuntime, key: ConfigKey): boolean {
  if (key === "api_url") return Boolean(runtime.flags.url);
  if (key === "api_key") return Boolean(runtime.flags.key);
  if (key === "model") return Boolean(runtime.flags.model);
  if (key === "timeout") return runtime.flags.timeoutMs !== undefined;
  return runtime.flags.retries !== undefined;
}

function envSource(runtime: ConsoleRuntime, key: ConfigKey): boolean {
  if (key === "api_url") return Boolean(runtime.env.JEV_URL);
  if (key === "api_key") return Boolean(runtime.env.OPENCODE_API_KEY || runtime.env.JEV_API_KEY);
  if (key === "model") return Boolean(runtime.env.JEV_MODEL);
  return false;
}

function configEntries(runtime: ConsoleRuntime): ConfigEntryDto[] {
  const stored = storedConfig(runtime);
  const resolved = resolveConfig(runtime.flags, runtime.env, stored);
  return CONFIG_KEYS.map((key) => {
    const source: ConfigSource = flagSource(runtime, key)
      ? "flag"
      : envSource(runtime, key)
        ? "env"
        : stored[key] !== undefined && stored[key] !== "" ? "sqlite" : "default";
    let value: string | number | null;
    if (key === "api_url") value = resolved.endpoint;
    else if (key === "api_key") value = resolved.apiKey ? maskSecret(resolved.apiKey) : null;
    else if (key === "model") value = resolved.model;
    else if (key === "timeout") value = resolved.timeoutMs / 1000;
    else value = resolved.retries;
    return {
      key,
      value,
      masked: key === "api_key" ? (resolved.apiKey ? maskSecret(resolved.apiKey) : "—") : String(value),
      source,
      editable: source !== "flag",
    };
  });
}

export function getConfigSnapshot(runtime = getConsoleRuntime()): ConfigSnapshot {
  return {
    entries: configEntries(runtime),
    database: {
      path: runtime.service.databasePath,
      schemaVersion: runtime.service.db.pragma("user_version", { simple: true }) as number,
      directoryMode: "0700",
      fileMode: "0600",
      tables: ["config", "templates", "template_macros", "requests"],
    },
  };
}

export function getShellData(runtime = getConsoleRuntime()): ShellData {
  const resolved = resolvedConfig(runtime);
  return {
    version: packageManifest.version,
    schemaVersion: runtime.service.db.pragma("user_version", { simple: true }) as number,
    dbPath: runtime.service.databasePath,
    listen: listenAddress(runtime.env),
    provider: { model: resolved.model, status: runtime.providerStatus },
    counts: { templates: runtime.templates.list().length, history: runtime.requests.count() },
  };
}

function listenAddress(env: NodeJS.ProcessEnv): { host: string; port: number } {
  return {
    host: env.JEV_CONSOLE_HOST ?? "127.0.0.1",
    port: Number(env.JEV_CONSOLE_PORT ?? env.PORT ?? 7411),
  };
}

export function getOverview(window = 30, runtime = getConsoleRuntime()): Overview {
  if (!Number.isInteger(window) || window < 1 || window > 200) {
    throw new ConsoleError(400, "invalid_window", "The window must be an integer between 1 and 200");
  }
  const rows = runtime.requests.list({ limit: window });
  const ok = rows.filter((row) => row.ok).length;
  const resolved = resolvedConfig(runtime);
  const keySource = configEntries(runtime).find((entry) => entry.key === "api_key")?.source ?? "default";
  return {
    version: packageManifest.version,
    schemaVersion: runtime.service.db.pragma("user_version", { simple: true }) as number,
    dbPath: runtime.service.databasePath,
    listen: listenAddress(runtime.env),
    launchCommand: "jev web-console",
    provider: {
      endpoint: resolved.endpoint || DEFAULT_ENDPOINT,
      model: resolved.model || DEFAULT_MODEL,
      apiKeyMasked: resolved.apiKey ? maskSecret(resolved.apiKey) : "—",
      apiKeySource: keySource,
      timeoutMs: resolved.timeoutMs || DEFAULT_TIMEOUT_MS,
      retries: resolved.retries ?? DEFAULT_RETRIES,
      status: runtime.providerStatus,
    },
    stats: {
      total: runtime.requests.count(),
      window,
      ok,
      errors: rows.length - ok,
      successRate: rows.length ? ok / rows.length * 100 : 0,
      inputTokens: rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
      outputTokens: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
      cost: rows.reduce((sum, row) => sum + (row.cost ?? 0), 0),
      costUnknown: rows.filter((row) => row.ok && row.cost === null).length,
    },
    recent: runtime.requests.list({ limit: 6 }).map(requestSummary),
  };
}

function requestSummary(record: RequestRecord): RequestSummary {
  return {
    id: record.id,
    createdAt: record.createdAt,
    statusCode: record.statusCode,
    ok: record.ok,
    model: record.model,
    templateName: record.templateName,
    batchId: record.batchId,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cost: record.cost,
    durationMs: record.durationMs,
  };
}

export function getHealth(runtime = getConsoleRuntime()) {
  return {
    ok: true,
    version: packageManifest.version,
    schemaVersion: runtime.service.db.pragma("user_version", { simple: true }) as number,
    dbPath: runtime.service.databasePath,
    uptime: Math.max(0, Math.floor((Date.now() - runtime.startedAt) / 1000)),
  };
}

export function getHistoryPage(parsed: ParsedHistoryFilters, runtime = getConsoleRuntime()): HistoryPage {
  const facets = runtime.requests.facets();
  return {
    items: runtime.requests.list(parsed.repository).map(requestSummary),
    facets: {
      statuses: [...new Set([200, 401, 422, 429, ...facets.statuses])].sort((a, b) => a - b),
      models: facets.models,
      templates: facets.templates,
    },
    filters: parsed.values,
  };
}

export function getHistoryDetail(id: number, runtime = getConsoleRuntime()): HistoryDetail {
  if (!Number.isInteger(id) || id < 1) throw new ConsoleError(400, "invalid_history_id", "The id must be a positive integer");
  const record = runtime.requests.get(id);
  if (!record) throw new ConsoleError(404, "history_not_found", `no request exists with id ${id}`);
  return {
    ...requestSummary(record),
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    endpoint: record.endpoint,
    request: parseStoredJson(record.requestJson),
    response: parseStoredJson(record.responseJson),
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    exportRecord: historyRecordToJson(record),
  };
}

function parseStoredJson(value: string | null): unknown {
  if (value === null) return null;
  try { return JSON.parse(value); } catch { return value; }
}

export function getHistoryExport(filters: HistoryFilters, runtime = getConsoleRuntime()): string {
  return runtime.requests.list(filters).map((record) => `${JSON.stringify(historyRecordToJson(record))}\n`).join("");
}

function templateSummary(template: Template): TemplateSummary {
  return {
    name: template.name,
    description: template.description,
    createdAt: template.created_at,
    updatedAt: template.updated_at,
    macros: template.macros,
  };
}

export function listTemplates(runtime = getConsoleRuntime()): TemplateSummary[] {
  return runtime.templates.list().map(templateSummary);
}

export function getTemplate(name: string, runtime = getConsoleRuntime()): TemplateDetail {
  const template = runtime.templates.get(name);
  if (!template) throw new ConsoleError(404, "template_not_found", `template not found: ${name}`);
  return { ...templateSummary(template), bodyJson: template.body_json };
}

function validTemplateName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConsoleError(400, "invalid_template_name", "the template name cannot be empty");
  }
  if (value.length > 200 || /[\u0000-\u001f]/.test(value)) {
    throw new ConsoleError(400, "invalid_template_name", "the template name is invalid or too long");
  }
  return value.trim();
}

export function bodyJsonFromInput(body: Record<string, unknown>): string {
  const raw = body.bodyJson ?? body.body;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return JSON.stringify(raw);
  throw new ConsoleError(400, "invalid_template_body", "bodyJson or the template body is missing");
}

function macrosFromInput(
  body: Record<string, unknown>,
  bodyJson: string,
): TemplateMacro[] | undefined {
  if (body.macros === undefined) return undefined;
  if (!Array.isArray(body.macros)) {
    throw new ConsoleError(400, "invalid_macros", "macros must be an array of {name, description, schema?}");
  }
  const detected = new Set(detectMacros(bodyJson));
  const normalized = new Map<string, TemplateMacro>();
  for (const entry of body.macros) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConsoleError(400, "invalid_macro", "each macro must be an object {name, description, schema?}");
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (name === "") {
      throw new ConsoleError(400, "invalid_macro", "each macro needs a non-empty name");
    }
    if (!detected.has(name)) {
      throw new ConsoleError(
        400,
        "invalid_macro",
        `macro ${JSON.stringify(name)} is not in the template body`,
      );
    }
    if (record.description !== undefined && typeof record.description !== "string") {
      throw new ConsoleError(
        400,
        "invalid_macro_description",
        `the description of macro ${JSON.stringify(name)} must be text`,
      );
    }
    const description = (record.description ?? "").trim();
    if (description.length > MAX_MACRO_DESCRIPTION_LENGTH) {
      throw new ConsoleError(
        400,
        "invalid_macro_description",
        `the description of macro ${JSON.stringify(name)} exceeds ${MAX_MACRO_DESCRIPTION_LENGTH} characters`,
      );
    }
    let schema: MacroSchema | null = null;
    if (record.schema !== undefined && record.schema !== null) {
      try {
        schema = validateMacroSchema(record.schema);
      } catch (error) {
        if (error instanceof MacroSchemaError) {
          throw new ConsoleError(400, error.code, error.message);
        }
        throw error;
      }
    }
    normalized.set(name, { name, description, schema });
  }
  return [...normalized.values()];
}

export function createTemplate(body: Record<string, unknown>, runtime = getConsoleRuntime()): TemplateDetail {
  const name = validTemplateName(body.name);
  const description = typeof body.description === "string" ? body.description : "";
  const bodyJson = bodyJsonFromInput(body);
  validateBody(bodyJson);
  const macros = macrosFromInput(body, bodyJson);
  if (runtime.templates.get(name)) throw new ConsoleError(409, "template_conflict", `template already exists: ${name}`);
  runtime.templates.save(name, description, bodyJson, macros);
  return getTemplate(name, runtime);
}

export function updateTemplate(nameValue: string, body: Record<string, unknown>, runtime = getConsoleRuntime()): TemplateDetail {
  const name = validTemplateName(nameValue);
  const description = typeof body.description === "string" ? body.description : "";
  const bodyJson = bodyJsonFromInput(body);
  validateBody(bodyJson);
  const macros = macrosFromInput(body, bodyJson);
  runtime.templates.save(name, description, bodyJson, macros);
  return getTemplate(name, runtime);
}

export function renameTemplate(name: string, body: Record<string, unknown>, runtime = getConsoleRuntime()): TemplateDetail {
  const newName = validTemplateName(body.name ?? body.newName);
  try {
    runtime.templates.rename(name, newName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("template already exists")) throw new ConsoleError(409, "template_conflict", message);
    if (message.startsWith("template not found")) throw new ConsoleError(404, "template_not_found", message);
    throw error;
  }
  return getTemplate(newName, runtime);
}

export function deleteTemplate(name: string, runtime = getConsoleRuntime()): void {
  if (!runtime.templates.remove(name)) throw new ConsoleError(404, "template_not_found", `template not found: ${name}`);
}

function validateBody(bodyJson: string): void {
  try { validateTemplateBody(bodyJson); } catch (error) {
    throw new ConsoleError(400, "invalid_template_body", error instanceof Error ? error.message : String(error));
  }
}

export function validateTemplateDraft(body: Record<string, unknown>): { ok: true; macros: string[] } {
  const bodyJson = bodyJsonFromInput(body);
  validateBody(bodyJson);
  return { ok: true, macros: detectMacros(bodyJson) };
}

export function renderTemplateDraft(body: Record<string, unknown>): { request: JevRequest } {
  const bodyJson = bodyJsonFromInput(body);
  const context = body.context ?? {};
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new ConsoleError(400, "invalid_context", "the context must be a JSON object");
  }
  try {
    return { request: resolveTemplateBody(bodyJson, context as TemplateContext) };
  } catch (error) {
    throw new ConsoleError(400, "invalid_render", error instanceof Error ? error.message : String(error));
  }
}

export function saveConfigChanges(body: Record<string, unknown>, runtime = getConsoleRuntime()): ConfigSnapshot {
  const entries = Object.entries(body).filter(([key]) => isConfigKey(key));
  if (entries.length === 0) throw new ConsoleError(400, "empty_config", "There are no configuration keys to save");
  const readonly = entries.filter(([key]) => flagSource(runtime, key as ConfigKey));
  if (readonly.length) throw new ConsoleError(409, "config_readonly", `Keys fixed by flag are read-only: ${readonly.map(([key]) => key).join(", ")}`);
  for (const [key, raw] of entries) {
    if (typeof raw !== "string" && typeof raw !== "number") throw new ConsoleError(400, "invalid_config", `The value of ${key} must be text or a number`);
    const value = String(raw);
    if (value !== "") {
      try { validateConfigValue(key as ConfigKey, value); } catch (error) {
        throw new ConsoleError(400, "invalid_config", error instanceof Error ? error.message : String(error));
      }
    }
  }
  runtime.service.db.transaction(() => {
    for (const [key, raw] of entries) {
      const value = String(raw);
      if (value === "") runtime.config.unset(key as ConfigKey);
      else runtime.config.set(key as ConfigKey, value);
    }
  })();
  return getConfigSnapshot(runtime);
}

export function unsetConfig(key: string, runtime = getConsoleRuntime()): ConfigSnapshot {
  if (!isConfigKey(key)) throw new ConsoleError(400, "invalid_config_key", `invalid key: ${key}`);
  if (flagSource(runtime, key)) throw new ConsoleError(409, "config_readonly", `${key} is fixed by flag and is read-only`);
  runtime.config.unset(key);
  return getConfigSnapshot(runtime);
}

export function resetConfig(runtime = getConsoleRuntime()): ConfigSnapshot {
  runtime.service.db.transaction(() => {
    for (const key of CONFIG_KEYS) if (!flagSource(runtime, key)) runtime.config.unset(key);
  })();
  return getConfigSnapshot(runtime);
}

export function revealApiKey(runtime = getConsoleRuntime()): { key: string; value: string } {
  const value = resolvedConfig(runtime).apiKey;
  if (!value) throw new ConsoleError(404, "api_key_missing", "There is no effective API key to reveal");
  return { key: "api_key", value };
}

export async function executeAsk(body: Record<string, unknown>, runtime = getConsoleRuntime()): Promise<ExecutionResult> {
  if (!("state" in body)) throw new ConsoleError(400, "invalid_request", "the request has no state");
  if (
    (typeof body.state !== "string" && (body.state === null || typeof body.state !== "object")) ||
    (typeof body.state === "string" && body.state.trim() === "")
  ) {
    throw new ConsoleError(400, "invalid_request", "the state is empty or has an invalid type");
  }
  if (body.model !== undefined && (typeof body.model !== "string" || !body.model.trim())) {
    throw new ConsoleError(400, "invalid_request", "model must be a non-empty string");
  }
  let questions;
  try { questions = validateQuestions(body.questions); } catch (error) {
    throw new ConsoleError(400, "invalid_request", error instanceof Error ? error.message : String(error));
  }
  const assets = parseAssetsInput(body.assets);
  const save = body.save !== false;
  const result = await runtime.service.ask({
    model: typeof body.model === "string" ? body.model : "",
    state: body.state as State,
    questions,
    assets,
  }, { save, model: typeof body.model === "string" ? body.model : undefined });
  return { ...result, save, demo: false };
}

/**
 * Normalizes the console body `assets`: `{ ref: { data_base64, format } }`.
 * The image already arrives as base64 from the client (it is not persisted as
 * is: the repository redacts it).
 */
function parseAssetsInput(value: unknown): Record<string, ImageAsset> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConsoleError(400, "invalid_assets", "assets must be an object { ref: { data_base64, format } }");
  }
  const assets: Record<string, ImageAsset> = {};
  for (const [ref, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConsoleError(400, "invalid_assets", `asset ${JSON.stringify(ref)} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    if (record.data_base64 === undefined) {
      throw new ConsoleError(400, "invalid_assets", `asset ${JSON.stringify(ref)} needs data_base64`);
    }
    if (typeof record.data_base64 !== "string") {
      throw new ConsoleError(400, "invalid_assets", `asset ${JSON.stringify(ref)} has an invalid data_base64`);
    }
    assets[ref] = {
      type: "image",
      data_base64: record.data_base64,
      format: record.format as ImageAsset["format"],
    };
  }
  return Object.keys(assets).length === 0 ? undefined : assets;
}

export async function executeDemo(body: Record<string, unknown>, runtime = getConsoleRuntime()): Promise<ExecutionResult> {
  const save = body.save !== false;
  const result = await runtime.service.demo({ save });
  return { ...result, save, demo: true };
}

export async function checkProvider(runtime = getConsoleRuntime()) {
  const started = Date.now();
  try {
    const result = await runtime.service.ask({
      model: "",
      state: "ping",
      questions: { ping: { type: "noul", instructions: "Check that the provider can evaluate a minimal request." } },
    }, { save: false });
    runtime.providerStatus = "ok";
    return {
      status: "ok" as const,
      statusCode: result.statusCode,
      latencyMs: result.durationMs || Date.now() - started,
      model: result.response.model || result.request.model,
    };
  } catch (error) {
    runtime.providerStatus = "error";
    const latencyMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("missing API key")) throw error;
    if (error instanceof JevApiError) {
      const status = error.statusCode === 429 ? 429 : error.statusCode === 422 ? 422 : 502;
      throw new ConsoleError(
        status,
        error.code ?? "provider_error",
        message,
        providerHint(error),
        { providerStatus: error.statusCode, latencyMs },
      );
    }
    throw new ConsoleError(502, "provider_error", message, undefined, { latencyMs });
  }
}
