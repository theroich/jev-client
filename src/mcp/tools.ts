import { historyRecordToJson, maskSecret } from "../format.js";
import { MAX_CONCURRENCY, type BatchResult, type ExecutionResult } from "../service.js";
import { type Template, type TemplateMacro } from "../template-repository.js";
import {
  getTemplateStarter,
  TEMPLATE_STARTERS,
  type TemplateStarterId,
} from "../template-starters.js";
import {
  detectMacros,
  resolveTemplateBody,
  validateQuestions,
  validateTemplateBody,
  type TemplateContext,
} from "../template.js";
import type { JevRequest, Question, State } from "../types.js";
import { VERSION } from "../version.js";
import {
  resolvedConfig,
  schemaVersion,
  type McpContext,
} from "./context.js";
import { McpToolError } from "./errors.js";
import {
  inputSchemaForTemplate,
  toolDescriptionForTemplate,
  toolNameForTemplate,
  type ToolAnnotations,
} from "./schema.js";

/** Límite de contextos por llamada a `jev_batch`. */
export const MCP_BATCH_LIMIT = 100;

/** Tools cuya ejecución muta el catálogo y debe emitir `tools/list_changed`. */
export const TEMPLATE_MUTATION_TOOLS = new Set([
  "jev_template_create",
  "jev_template_update",
  "jev_template_delete",
]);

/** Una tool publicada por el servidor MCP (fija o generada por plantilla). */
export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: ToolAnnotations;
  source: "builtin" | "template";
  templateName?: string;
  /** `false` cuando un flag del servidor la deshabilita. */
  enabled: boolean;
  disabledReason?: string;
  run(args: Record<string, unknown>, ctx: McpContext): Promise<unknown>;
}

interface CatalogedTemplate {
  template: Template;
  toolName: string;
  enabled: boolean;
  disabledReason?: string;
}

const READONLY: ToolAnnotations = { readOnlyHint: true };
const MUTATION: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const EXECUTION: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

function fail(code: string, message: string, hint?: string): never {
  throw new McpToolError(code, message, hint);
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
  options: { required?: boolean } = {},
): string | undefined {
  const value = args[key];
  if (value === undefined) {
    if (options.required) {
      fail("invalid_arguments", `falta el argumento requerido: ${key}`);
    }
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    fail("invalid_arguments", `${key} debe ser una cadena no vacía`);
  }
  return value;
}

function objectArg(
  args: Record<string, unknown>,
  key: string,
  options: { required?: boolean } = {},
): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined) {
    if (options.required) {
      fail("invalid_arguments", `falta el argumento requerido: ${key}`);
    }
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_arguments", `${key} debe ser un objeto JSON`);
  }
  return value as Record<string, unknown>;
}

function integerArg(
  args: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value)) {
    fail("invalid_arguments", `${key} debe ser un entero`);
  }
  const number = value as number;
  if (options.min !== undefined && number < options.min) {
    fail("invalid_arguments", `${key} debe ser >= ${options.min}`);
  }
  if (options.max !== undefined && number > options.max) {
    fail("invalid_arguments", `${key} debe ser <= ${options.max}`);
  }
  return number;
}

function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    fail("invalid_arguments", `${key} debe ser un booleano`);
  }
  return value;
}

/** Acepta un body como cadena JSON o como objeto y devuelve la cadena JSON. */
function bodyJsonFromArgs(value: unknown): string {
  if (typeof value === "string") {
    if (value.trim() === "") {
      fail("invalid_template_body", "el body no puede estar vacío");
    }
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return JSON.stringify(value);
  }
  fail("invalid_template_body", "body debe ser una cadena JSON o un objeto");
}

/** Normaliza y valida las macros de entrada (create/update). */
function macrosFromArgs(value: unknown): TemplateMacro[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    fail("invalid_macros", "macros debe ser un array de { name, description?, schema? }");
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("invalid_macro", `la macro #${index + 1} debe ser un objeto`);
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (name === "") {
      fail("invalid_macro", `la macro #${index + 1} necesita un name no vacío`);
    }
    const description = typeof record.description === "string" ? record.description : "";
    if (record.description !== undefined && typeof record.description !== "string") {
      fail("invalid_macro", `la descripción de ${JSON.stringify(name)} debe ser texto`);
    }
    return {
      name,
      description,
      schema:
        record.schema === undefined || record.schema === null
          ? null
          : (record.schema as TemplateMacro["schema"]),
    };
  });
}

function templateDetail(template: Template, toolName: string): Record<string, unknown> {
  return {
    name: template.name,
    description: template.description,
    body: safeParse(template.body_json),
    bodyJson: template.body_json,
    macros: template.macros,
    createdAt: template.created_at,
    updatedAt: template.updated_at,
    toolName,
  };
}

function templateSummary(entry: CatalogedTemplate): Record<string, unknown> {
  return {
    name: entry.template.name,
    description: entry.template.description,
    macros: entry.template.macros,
    createdAt: entry.template.created_at,
    updatedAt: entry.template.updated_at,
    toolName: entry.toolName,
    toolEnabled: entry.enabled,
    toolDisabledReason: entry.disabledReason ?? null,
  };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function mapTemplateError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ya existe")) {
    fail("template_conflict", message);
  }
  if (message.includes("no encontrada")) {
    fail("template_not_found", message);
  }
  if (message.includes("macro") || message.includes("esquema") || message.includes("descripción")) {
    fail("invalid_macro", message);
  }
  throw error;
}

/** Valida el body y traduce los errores de dominio a códigos MCP. */
function validateBody(bodyJson: string): void {
  try {
    validateTemplateBody(bodyJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail("invalid_template_body", message);
  }
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

/**
 * Devuelve las tools fijas y dinámicas del servidor. Se calcula contra SQLite
 * en cada llamada, de modo que los cambios externos se ven sin reiniciar.
 */
export function buildToolCatalog(ctx: McpContext): ToolDefinition[] {
  return [...builtinTools(ctx), ...dynamicTools(ctx)];
}

/** Solo las tools habilitadas, en el orden canónico. */
export function enabledTools(ctx: McpContext): ToolDefinition[] {
  return buildToolCatalog(ctx).filter((tool) => tool.enabled);
}

function dynamicTools(ctx: McpContext): ToolDefinition[] {
  const taken = new Set(builtinTools(ctx).map((tool) => tool.name));
  return ctx.templates.list().map((template) => {
    const { toolName } = toolNameForTemplate(template.name, taken);
    taken.add(toolName);
    const disabledReason = ctx.options.noExecute ? "no-execute" : undefined;
    return {
      name: toolName,
      description: toolDescriptionForTemplate(template),
      inputSchema: inputSchemaForTemplate(template),
      annotations: EXECUTION,
      source: "template" as const,
      templateName: template.name,
      enabled: disabledReason === undefined,
      disabledReason,
      run: async (args: Record<string, unknown>, ctx: McpContext) =>
        runTemplateTool(template.name, args, ctx),
    };
  });
}

function builtinTools(ctx: McpContext): ToolDefinition[] {
  const { readOnly, noExecute, allowDestructive } = ctx.options;
  const tools: ToolDefinition[] = [
    readOnlyTool({
      name: "jev_overview",
      title: "Estado de jev-client",
      description: overviewDescription(),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: overviewRun,
    }),
    readOnlyTool({
      name: "jev_docs",
      title: "Documentación de la app o de una tool",
      description:
        "Devuelve la documentación de jev-client o el detalle de una tool. Usa 'topic' con " +
        "'overview', 'tools', 'mcp', 'examples' o el nombre de una tool. Es la primera tool que " +
        "conviene consultar para orientarse.",
      inputSchema: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "Tema: 'overview' | 'tools' | 'mcp' | 'examples' o el nombre de una tool concreta.",
          },
        },
        additionalProperties: false,
      },
      run: docsRun,
    }),
    readOnlyTool({
      name: "jev_template_list",
      title: "Lista plantillas",
      description:
        "Lista las plantillas guardadas con descripción, macros, metadatos y el nombre de la tool " +
        "MCP con que se publica cada una (toolName/toolEnabled). Admite 'query' (filtro por nombre " +
        "o descripción) y 'limit'.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Filtro parcial por nombre o descripción." },
          limit: { type: "integer", minimum: 1, description: "Número máximo de resultados." },
        },
        additionalProperties: false,
      },
      run: templateListRun,
    }),
    readOnlyTool({
      name: "jev_template_get",
      title: "Detalle de plantilla",
      description:
        "Devuelve el body JSON, las macros (con descripción y JSON Schema), las fechas y el nombre " +
        "de su tool MCP. Úsala para conocer las macros antes de generar un contexto.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Nombre de la plantilla." } },
        required: ["name"],
        additionalProperties: false,
      },
      run: templateGetRun,
    }),
    readOnlyTool({
      name: "jev_template_starters",
      title: "Plantillas de ejemplo",
      description:
        "Devuelve los starters integrados (noul, choice, score) listos para crear una plantilla. " +
        "Con 'id' devuelve solo uno.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", enum: ["noul", "choice", "score"] } },
        additionalProperties: false,
      },
      run: templateStartersRun,
    }),
    readOnlyTool({
      name: "jev_template_validate",
      title: "Valida una plantilla",
      description:
        "Valida un body inline (o una plantilla guardada) sin llamar a Jev y devuelve las macros " +
        "detectadas. Usa 'body' o 'name', no ambos.",
      inputSchema: {
        type: "object",
        properties: {
          body: { type: "string", description: "Body JSON inline (con macros)." },
          name: { type: "string", description: "Nombre de una plantilla guardada." },
        },
        additionalProperties: false,
      },
      run: templateValidateRun,
    }),
    readOnlyTool({
      name: "jev_template_render",
      title: "Renderiza una plantilla (dry-run)",
      description:
        "Resuelve las macros de una plantilla con un contexto y devuelve el request resultante sin " +
        "llamar a Jev. Es el dry-run recomendado antes de ejecutar: falla listando las macros ausentes.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nombre de la plantilla." },
          context: { type: "object", description: "Mapa clave → valor para las macros." },
        },
        required: ["name", "context"],
        additionalProperties: false,
      },
      run: templateRenderRun,
    }),
  ];

  if (!readOnly) {
    tools.push(
      mutationTool({
        name: "jev_template_create",
        title: "Crea una plantilla",
        description:
          "Crea una plantilla validando el body y los metadatos de sus macros. El body puede ser una " +
          "cadena JSON o un objeto. 'macros' es opcional: array de { name, description?, schema? }.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Nombre único de la plantilla." },
            description: { type: "string", description: "Descripción opcional." },
            body: {
              description: "Body JSON (cadena u objeto) con macros {{clave}}.",
            },
            macros: {
              type: "array",
              description: "Metadatos de macros: { name, description?, schema? }.",
            },
          },
          required: ["name", "body"],
          additionalProperties: false,
        },
        run: templateCreateRun,
      }),
      mutationTool({
        name: "jev_template_update",
        title: "Actualiza una plantilla",
        description:
          "Actualiza body, descripción y/o macros de una plantilla; con 'renameTo' también la " +
          "renombra. Solo los campos presentes se modifican.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Nombre actual de la plantilla." },
            description: { type: "string", description: "Nueva descripción." },
            body: { description: "Nuevo body JSON (cadena u objeto)." },
            macros: { type: "array", description: "Metadatos de macros." },
            renameTo: { type: "string", description: "Nuevo nombre (renombra)." },
          },
          required: ["name"],
          additionalProperties: false,
        },
        run: templateUpdateRun,
      }),
    );
  }

  if (allowDestructive && !readOnly) {
    tools.push(
      destructiveTool({
        name: "jev_template_delete",
        title: "Borra una plantilla",
        description:
          "Borra una plantilla de forma permanente (sus macros se borran en cascada; el historial " +
          "conserva template_name). Exige 'confirm: true'.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Nombre de la plantilla." },
            confirm: { type: "boolean", description: "Debe ser true para confirmar el borrado." },
          },
          required: ["name", "confirm"],
          additionalProperties: false,
        },
        run: templateDeleteRun,
      }),
    );
  }

  if (!noExecute) {
    tools.push(
      executionTool({
        name: "jev_ask",
        title: "Ejecuta un request ad-hoc",
        description:
          "Ejecuta un request contra Jev y guarda la petición en el historial (source='mcp'). " +
          "'state' puede ser texto u objeto/array JSON; 'questions' es un mapa noul/choice/score. " +
          "Devuelve answers, usage y requestId.",
        inputSchema: {
          type: "object",
          properties: {
            state: {
              description: "Contenido a evaluar: texto, objeto JSON o array.",
              oneOf: [{ type: "string" }, { type: "object" }, { type: "array" }],
            },
            questions: {
              type: "object",
              description: "Preguntas tipadas (noul, choice, score) con instructions/criteria.",
            },
            model: { type: "string", description: "Modelo opcional para esta ejecución." },
          },
          required: ["state", "questions"],
          additionalProperties: false,
        },
        run: askRun,
      }),
      executionTool({
        name: "jev_batch",
        title: "Ejecuta una plantilla sobre varios contextos",
        description:
          "Ejecuta una plantilla una vez por cada contexto y guarda cada petición con el mismo " +
          "batch_id. Admite concurrency 1-10 y failFast. Máximo 100 contextos por llamada.",
        inputSchema: {
          type: "object",
          properties: {
            template: { type: "string", description: "Nombre de la plantilla." },
            contexts: { type: "array", description: "Array de mapas de contexto." },
            concurrency: { type: "integer", minimum: 1, maximum: 10 },
            failFast: { type: "boolean", description: "Detenerse ante el primer error." },
          },
          required: ["template", "contexts"],
          additionalProperties: false,
        },
        run: batchRun,
      }),
    );
  }

  tools.push(
    readOnlyTool({
      name: "jev_history_list",
      title: "Historial de peticiones",
      description:
        "Lista las peticiones guardadas (incluidas las de MCP) con filtros: since (ISO), status, " +
        "model, template, batch y limit.",
      inputSchema: {
        type: "object",
        properties: {
          since: { type: "string", description: "Solo peticiones con created_at >= esta fecha ISO." },
          status: { type: "integer", description: "Código HTTP exacto." },
          model: { type: "string", description: "Modelo exacto." },
          template: { type: "string", description: "Nombre de plantilla exacto." },
          batch: { type: "string", description: "batch_id exacto." },
          limit: { type: "integer", minimum: 0, description: "Número máximo de resultados." },
        },
        additionalProperties: false,
      },
      run: historyListRun,
    }),
    readOnlyTool({
      name: "jev_history_get",
      title: "Detalle de una petición",
      description: "Devuelve el detalle completo de una petición: request, response, uso, error y source.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "integer", minimum: 1, description: "Id de la petición." } },
        required: ["id"],
        additionalProperties: false,
      },
      run: historyGetRun,
    }),
    readOnlyTool({
      name: "jev_config_get",
      title: "Configuración efectiva",
      description:
        "Devuelve la configuración efectiva (endpoint, modelo, timeout, retries) con la API key " +
        "enmascarada. Nunca revela la API key.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: configGetRun,
    }),
  );

  return tools;
}

function overviewDescription(): string {
  return (
    "Estado de la app: versión, esquema SQLite, ruta de la base, contadores, si hay API key y las " +
    "tools disponibles (fijas y dinámicas). Sin efectos secundarios ni secretos."
  );
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function overviewRun(_args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const config = resolvedConfig(ctx);
  const tools = enabledTools(ctx);
  return {
    version: VERSION,
    schemaVersion: schemaVersion(ctx),
    databasePath: ctx.service.databasePath,
    hasApiKey: config.apiKey !== "",
    config: {
      endpoint: config.endpoint,
      model: config.model,
      timeoutMs: config.timeoutMs,
      retries: config.retries,
    },
    counts: {
      templates: ctx.templates.list().length,
      requests: ctx.requests.count(),
      tools: tools.length,
      dynamicTools: tools.filter((tool) => tool.source === "template").length,
    },
    flags: {
      readOnly: ctx.options.readOnly === true,
      noExecute: ctx.options.noExecute === true,
      allowDestructive: ctx.options.allowDestructive === true,
    },
    tools: tools.map((tool) => tool.name),
  };
}

async function docsRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const topic = typeof args.topic === "string" ? args.topic.trim() : "";
  const { docsProvider } = await import("./docs.js");
  const content = docsProvider(ctx).contentFor(topic);
  if (content === undefined) {
    fail("tool_not_found", `tema o tool desconocida: ${JSON.stringify(topic)}`);
  }
  return { topic: topic || "overview", content: content.text };
}

async function templateListRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const limit = integerArg(args, "limit", { min: 1 });
  return listTemplatesPayload(ctx, query, limit);
}

/** Payload de `jev_template_list` y del resource `jev://templates`. */
export function listTemplatesPayload(
  ctx: McpContext,
  query = "",
  limit?: number,
): Record<string, unknown>[] {
  const normalized = query.trim().toLowerCase();
  const filtered = catalogedTemplates(ctx).filter((entry) => {
    if (normalized === "") {
      return true;
    }
    return (
      entry.template.name.toLowerCase().includes(normalized) ||
      entry.template.description.toLowerCase().includes(normalized)
    );
  });
  const items = filtered.map(templateSummary);
  return limit === undefined ? items : items.slice(0, limit);
}

async function templateGetRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const name = stringArg(args, "name", { required: true }) as string;
  return getTemplatePayload(ctx, name);
}

/** Payload de `jev_template_get` y del resource `jev://templates/{name}`. */
export function getTemplatePayload(
  ctx: McpContext,
  name: string,
): Record<string, unknown> {
  const entry = findTemplate(ctx, name);
  if (entry === undefined) {
    fail("template_not_found", `plantilla no encontrada: ${name}`);
  }
  return templateDetail(entry.template, entry.toolName);
}

async function templateStartersRun(args: Record<string, unknown>, _ctx: McpContext): Promise<unknown> {
  if (args.id === undefined) {
    return { items: TEMPLATE_STARTERS };
  }
  const starter = getTemplateStarter(args.id as TemplateStarterId);
  if (starter === undefined) {
    fail("invalid_arguments", `starter desconocido: ${JSON.stringify(args.id)}`);
  }
  return starter;
}

async function templateValidateRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const bodyInline = args.body;
  const name = args.name;
  if (bodyInline !== undefined && name !== undefined) {
    fail("invalid_arguments", "usa 'body' o 'name', no ambos");
  }
  let bodyJson: string;
  let label: string;
  if (name !== undefined) {
    const templateName = stringArg(args, "name") as string;
    const template = ctx.templates.get(templateName);
    if (template === undefined) {
      fail("template_not_found", `plantilla no encontrada: ${templateName}`);
    }
    bodyJson = template.body_json;
    label = templateName;
  } else {
    bodyJson = bodyJsonFromArgs(bodyInline);
    label = "inline";
  }
  validateBody(bodyJson);
  return { valid: true, label, macros: detectMacros(bodyJson) };
}

async function templateRenderRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const name = stringArg(args, "name", { required: true }) as string;
  const context = objectArg(args, "context", { required: true }) as Record<string, unknown>;
  const template = ctx.templates.get(name);
  if (template === undefined) {
    fail("template_not_found", `plantilla no encontrada: ${name}`);
  }
  try {
    return { request: resolveTemplateBody(template.body_json, context as TemplateContext) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail("invalid_render", message);
  }
}

async function templateCreateRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const name = stringArg(args, "name", { required: true }) as string;
  if (args.description !== undefined && typeof args.description !== "string") {
    fail("invalid_arguments", "description debe ser una cadena");
  }
  const description = typeof args.description === "string" ? args.description : "";
  const bodyJson = bodyJsonFromArgs(args.body);
  validateBody(bodyJson);
  const macros = macrosFromArgs(args.macros);
  try {
    if (ctx.templates.get(name) !== undefined) {
      fail("template_conflict", `ya existe la plantilla: ${name}`);
    }
    ctx.templates.save(name, description, bodyJson, macros);
  } catch (error) {
    if (error instanceof McpToolError) {
      throw error;
    }
    mapTemplateError(error);
  }
  ctx.log(`plantilla creada: ${name}`);
  return templateDetail(ctx.templates.get(name) as Template, toolNameFor(ctx, name));
}

async function templateUpdateRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const name = stringArg(args, "name", { required: true }) as string;
  const existing = ctx.templates.get(name);
  if (existing === undefined) {
    fail("template_not_found", `plantilla no encontrada: ${name}`);
  }
  const bodyJson = args.body === undefined ? existing.body_json : bodyJsonFromArgs(args.body);
  if (args.body !== undefined) {
    validateBody(bodyJson);
  }
  let description = existing.description;
  if (args.description !== undefined) {
    if (typeof args.description !== "string") {
      fail("invalid_arguments", "description debe ser una cadena");
    }
    description = args.description;
  }
  const macros = args.macros === undefined ? undefined : macrosFromArgs(args.macros);
  try {
    ctx.templates.save(name, description, bodyJson, macros);
  } catch (error) {
    mapTemplateError(error);
  }

  let finalName = name;
  if (args.renameTo !== undefined) {
    if (typeof args.renameTo !== "string" || args.renameTo.trim() === "") {
      fail("invalid_arguments", "renameTo debe ser una cadena no vacía");
    }
    if (args.renameTo !== name) {
      try {
        ctx.templates.rename(name, args.renameTo);
      } catch (error) {
        mapTemplateError(error);
      }
      finalName = args.renameTo;
    }
  }
  ctx.log(`plantilla actualizada: ${finalName}`);
  return templateDetail(ctx.templates.get(finalName) as Template, toolNameFor(ctx, finalName));
}

async function templateDeleteRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const name = stringArg(args, "name", { required: true }) as string;
  if (args.confirm !== true) {
    fail(
      "confirmation_required",
      "borrar una plantilla es irreversible: pasa 'confirm: true' para confirmar",
    );
  }
  if (!ctx.templates.remove(name)) {
    fail("template_not_found", `plantilla no encontrada: ${name}`);
  }
  ctx.log(`plantilla eliminada: ${name}`);
  return { ok: true, deleted: name };
}

async function runTemplateTool(
  templateName: string,
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<unknown> {
  const template = ctx.templates.get(templateName);
  if (template === undefined) {
    fail(
      "template_not_found",
      `la plantilla "${templateName}" ya no existe; refresca la lista de tools`,
    );
  }
  const macroNames = new Set(template.macros.map((macro) => macro.name));
  for (const key of Object.keys(args)) {
    if (!macroNames.has(key)) {
      fail("invalid_arguments", `argumento desconocido para la plantilla: ${key}`);
    }
  }
  let request: JevRequest;
  try {
    request = resolveTemplateBody(template.body_json, args as TemplateContext);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail("invalid_render", message);
  }
  const result = await ctx.service.ask(request, { source: "mcp", templateName });
  return executionResultJson(result);
}

async function askRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  if (!("state" in args)) {
    fail("invalid_request", "el request no tiene state");
  }
  const state = args.state;
  const stateValid =
    typeof state === "string"
      ? state.trim() !== ""
      : state !== null && typeof state === "object";
  if (!stateValid) {
    fail("invalid_request", "state debe ser texto no vacío u objeto/array JSON");
  }
  const model = args.model;
  if (model !== undefined && (typeof model !== "string" || model.trim() === "")) {
    fail("invalid_request", "model debe ser una cadena no vacía");
  }
  let questions: Record<string, Question>;
  try {
    questions = validateQuestions(args.questions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail("invalid_request", message);
  }
  const request: JevRequest = {
    model: typeof model === "string" ? model : "",
    state: state as State,
    questions,
  };
  const result = await ctx.service.ask(request, { source: "mcp" });
  return executionResultJson(result);
}

async function batchRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const template = stringArg(args, "template", { required: true }) as string;
  if (ctx.templates.get(template) === undefined) {
    fail("template_not_found", `plantilla no encontrada: ${template}`);
  }
  const contexts = args.contexts;
  if (!Array.isArray(contexts)) {
    fail("invalid_contexts", "contexts debe ser un array de mapas de contexto");
  }
  if (contexts.length === 0) {
    fail("invalid_contexts", "contexts no puede estar vacío");
  }
  if (contexts.length > MCP_BATCH_LIMIT) {
    fail("batch_too_large", `máximo ${MCP_BATCH_LIMIT} contextos por llamada`);
  }
  const concurrency = integerArg(args, "concurrency", { min: 1, max: MAX_CONCURRENCY }) ?? 1;
  const failFast = booleanArg(args, "failFast") ?? false;
  const batch = await ctx.service.batch(template, contexts as unknown[], {
    concurrency,
    failFast,
    source: "mcp",
  });
  return batchResultJson(batch);
}

async function historyListRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const filters: Record<string, string | number> = {};
  if (typeof args.since === "string" && args.since !== "") {
    filters.since = args.since;
  }
  if (args.status !== undefined) {
    filters.status = integerArg(args, "status", { min: 100, max: 599 }) as number;
  }
  if (typeof args.model === "string" && args.model !== "") {
    filters.model = args.model;
  }
  if (typeof args.template === "string" && args.template !== "") {
    filters.template = args.template;
  }
  if (typeof args.batch === "string" && args.batch !== "") {
    filters.batch = args.batch;
  }
  const limit = integerArg(args, "limit", { min: 0 });
  if (limit !== undefined) {
    filters.limit = limit;
  }
  return ctx.requests.list(filters).map(historyRecordToJson);
}

async function historyGetRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const id = integerArg(args, "id", { min: 1 }) as number;
  const record = ctx.requests.get(id);
  if (record === undefined) {
    fail("history_not_found", `no existe la petición ${id}`);
  }
  return historyRecordToJson(record);
}

async function configGetRun(_args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const config = resolvedConfig(ctx);
  return {
    endpoint: config.endpoint,
    model: config.model,
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    hasApiKey: config.apiKey !== "",
    apiKeyMasked: config.apiKey === "" ? null : maskSecret(config.apiKey),
  };
}

// ---------------------------------------------------------------------------
// Helpers de catálogo
// ---------------------------------------------------------------------------

function catalogedTemplates(ctx: McpContext): CatalogedTemplate[] {
  const taken = new Set(builtinTools(ctx).map((tool) => tool.name));
  return ctx.templates.list().map((template) => {
    const { toolName } = toolNameForTemplate(template.name, taken);
    taken.add(toolName);
    const disabledReason = ctx.options.noExecute ? "no-execute" : undefined;
    return {
      template,
      toolName,
      enabled: disabledReason === undefined,
      disabledReason,
    };
  });
}

function findTemplate(ctx: McpContext, name: string): CatalogedTemplate | undefined {
  return catalogedTemplates(ctx).find((entry) => entry.template.name === name);
}

function toolNameFor(ctx: McpContext, name: string): string {
  return findTemplate(ctx, name)?.toolName ?? name;
}

function executionResultJson(result: ExecutionResult): Record<string, unknown> {
  return {
    model: result.response.model || result.request.model,
    answers: result.response.answers,
    usage: {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      cost: result.usage.cost ?? null,
    },
    requestId: result.requestId,
    statusCode: result.statusCode,
    durationMs: result.durationMs,
  };
}

function batchResultJson(batch: BatchResult): Record<string, unknown> {
  return {
    batchId: batch.batchId,
    template: batch.templateName,
    summary: batch.summary,
    cancelled: batch.cancelled,
    items: batch.items.map((item) => ({
      index: item.index,
      status: item.status,
      ok: item.ok,
      requestId: item.requestId,
      model: item.model ?? null,
      inputTokens: item.inputTokens ?? null,
      outputTokens: item.outputTokens ?? null,
      cost: item.cost ?? null,
      error: item.error ?? null,
      errorCode: item.errorCode ?? null,
      errorHint: item.errorHint ?? null,
      skipReason: item.skipReason ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Registro de tools
// ---------------------------------------------------------------------------

function readOnlyTool(tool: Omit<ToolDefinition, "source" | "annotations" | "enabled">): ToolDefinition {
  return { ...tool, source: "builtin", annotations: READONLY, enabled: true };
}

function mutationTool(tool: Omit<ToolDefinition, "source" | "annotations" | "enabled">): ToolDefinition {
  return { ...tool, source: "builtin", annotations: MUTATION, enabled: true };
}

function executionTool(tool: Omit<ToolDefinition, "source" | "annotations" | "enabled">): ToolDefinition {
  return { ...tool, source: "builtin", annotations: EXECUTION, enabled: true };
}

function destructiveTool(tool: Omit<ToolDefinition, "source" | "annotations" | "enabled">): ToolDefinition {
  return { ...tool, source: "builtin", annotations: DESTRUCTIVE, enabled: true };
}
