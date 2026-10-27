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
import {
  assertImageLimits,
  detectImageFormat,
  loadImageAsset,
  newImageRef,
  orphanAssetRefs,
  readImageSize,
  validateImageAsset,
} from "../assets.js";
import type { ImageAsset, JevRequest, Question, State } from "../types.js";
import { VERSION } from "../version.js";
import {
  resolvedConfig,
  schemaVersion,
  type McpContext,
} from "./context.js";
import { McpToolError } from "./errors.js";
import {
  inputSchemaForTemplate,
  RESERVED_TEMPLATE_ASSETS_ARG,
  toolDescriptionForTemplate,
  toolNameForTemplate,
  type ToolAnnotations,
} from "./schema.js";

/** Context limit per `jev_batch` call. */
export const MCP_BATCH_LIMIT = 100;

/** Tools whose execution mutates the catalog and must emit `tools/list_changed`. */
export const TEMPLATE_MUTATION_TOOLS = new Set([
  "jev_template_create",
  "jev_template_update",
  "jev_template_delete",
]);

/** A tool published by the MCP server (built-in or generated from a template). */
export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: ToolAnnotations;
  source: "builtin" | "template";
  templateName?: string;
  /** `false` when a server flag disables it. */
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
      fail("invalid_arguments", `missing required argument: ${key}`);
    }
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    fail("invalid_arguments", `${key} must be a non-empty string`);
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
      fail("invalid_arguments", `missing required argument: ${key}`);
    }
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_arguments", `${key} must be a JSON object`);
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
    fail("invalid_arguments", `${key} must be an integer`);
  }
  const number = value as number;
  if (options.min !== undefined && number < options.min) {
    fail("invalid_arguments", `${key} must be >= ${options.min}`);
  }
  if (options.max !== undefined && number > options.max) {
    fail("invalid_arguments", `${key} must be <= ${options.max}`);
  }
  return number;
}

function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    fail("invalid_arguments", `${key} must be a boolean`);
  }
  return value;
}

/**
 * Normalizes the `assets` parameter: `{ ref: { path?, data_base64?, format? } }`.
 * With `path` the server reads the file (local stdio); with `data_base64` it is
 * used as-is (validating the format).
 */
async function assetsFromArgs(
  args: Record<string, unknown>,
): Promise<Record<string, ImageAsset> | undefined> {
  const value = args.assets;
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_arguments", "assets must be an object { ref: { path | data_base64 } }");
  }
  const assets: Record<string, ImageAsset> = {};
  for (const [ref, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      assets[ref] = (await loadImageAsset(entry, ref)).asset;
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("invalid_arguments", `asset ${JSON.stringify(ref)} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.path === "string") {
      assets[ref] = (await loadImageAsset(record.path, ref)).asset;
      continue;
    }
    try {
      assets[ref] = validateImageAsset(ref, record as unknown as ImageAsset);
    } catch (error) {
      fail("invalid_arguments", error instanceof Error ? error.message : String(error));
    }
  }
  return Object.keys(assets).length === 0 ? undefined : assets;
}

/** Accepts a body as a JSON string or as an object and returns the JSON string. */
function bodyJsonFromArgs(value: unknown): string {
  if (typeof value === "string") {
    if (value.trim() === "") {
      fail("invalid_template_body", "body cannot be empty");
    }
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return JSON.stringify(value);
  }
  fail("invalid_template_body", "body must be a JSON string or an object");
}

/** Normalizes and validates the input macros (create/update). */
function macrosFromArgs(value: unknown): TemplateMacro[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    fail("invalid_macros", "macros must be an array of { name, description?, schema? }");
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("invalid_macro", `macro #${index + 1} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (name === "") {
      fail("invalid_macro", `macro #${index + 1} needs a non-empty name`);
    }
    const description = typeof record.description === "string" ? record.description : "";
    if (record.description !== undefined && typeof record.description !== "string") {
      fail("invalid_macro", `the description of ${JSON.stringify(name)} must be text`);
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
  if (message.includes("template already exists")) {
    fail("template_conflict", message);
  }
  if (message.includes("template not found")) {
    fail("template_not_found", message);
  }
  if (message.includes("macro") || message.includes("schema") || message.includes("description")) {
    fail("invalid_macro", message);
  }
  throw error;
}

/** Validates the body and translates domain errors into MCP codes. */
function validateBody(bodyJson: string): void {
  try {
    validateTemplateBody(bodyJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail("invalid_template_body", message);
  }
  if (detectMacros(bodyJson).includes(RESERVED_TEMPLATE_ASSETS_ARG)) {
    fail(
      "invalid_template_body",
      `"${RESERVED_TEMPLATE_ASSETS_ARG}" is a reserved argument for attaching ` +
        "images and cannot be used as a macro",
    );
  }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Returns the server's built-in and dynamic tools. It is computed against
 * SQLite on every call, so external changes are visible without a restart.
 */
export function buildToolCatalog(ctx: McpContext): ToolDefinition[] {
  return [...builtinTools(ctx), ...dynamicTools(ctx)];
}

/** Only enabled tools, in canonical order. */
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
      title: "jev-client status",
      description: overviewDescription(),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: overviewRun,
    }),
    readOnlyTool({
      name: "jev_docs",
      title: "App or tool documentation",
      description:
        "Returns the jev-client documentation or the details of one tool. Use 'topic' with " +
        "'overview', 'tools', 'mcp', 'examples' or the name of a tool. It is the first tool " +
        "worth consulting to get oriented.",
      inputSchema: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "Topic: 'overview' | 'tools' | 'mcp' | 'examples' or the name of a specific tool.",
          },
        },
        additionalProperties: false,
      },
      run: docsRun,
    }),
    readOnlyTool({
      name: "jev_template_list",
      title: "List templates",
      description:
        "Lists the saved templates with description, macros, metadata and the name of the MCP " +
        "tool each one is published as (toolName/toolEnabled). Accepts 'query' (filter by name " +
        "or description) and 'limit'.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Partial filter by name or description." },
          limit: { type: "integer", minimum: 1, description: "Maximum number of results." },
        },
        additionalProperties: false,
      },
      run: templateListRun,
    }),
    readOnlyTool({
      name: "jev_template_get",
      title: "Template details",
      description:
        "Returns the JSON body, the macros (with description and JSON Schema), the timestamps and " +
        "the name of its MCP tool. Use it to learn the macros before generating a context.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Template name." } },
        required: ["name"],
        additionalProperties: false,
      },
      run: templateGetRun,
    }),
    readOnlyTool({
      name: "jev_template_starters",
      title: "Starter templates",
      description:
        "Returns the built-in starters (noul, choice, score) ready to create a template. " +
        "With 'id' it returns only one.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", enum: ["noul", "choice", "score"] } },
        additionalProperties: false,
      },
      run: templateStartersRun,
    }),
    readOnlyTool({
      name: "jev_template_validate",
      title: "Validate a template",
      description:
        "Validates an inline body (or a saved template) without calling Jev and returns the " +
        "detected macros. Use 'body' or 'name', not both.",
      inputSchema: {
        type: "object",
        properties: {
          body: { type: "string", description: "Inline JSON body (with macros)." },
          name: { type: "string", description: "Name of a saved template." },
        },
        additionalProperties: false,
      },
      run: templateValidateRun,
    }),
    readOnlyTool({
      name: "jev_template_render",
      title: "Render a template (dry-run)",
      description:
        "Resolves a template's macros with a context and returns the resulting request without " +
        "calling Jev. It is the recommended dry-run before executing: it fails listing missing macros.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Template name." },
          context: { type: "object", description: "Key → value map for the macros." },
          assets: {
            type: "object",
            description: "Optional images: { ref: { path | data_base64, format } }. Requires the experimental header.",
          },
        },
        required: ["name", "context"],
        additionalProperties: false,
      },
      run: templateRenderRun,
    }),
    readOnlyTool({
      name: "jev_image_check",
      title: "Validate an image without spending a call",
      description:
        "Checks an image (by path or data_base64) and returns format, dimensions, bytes, whether " +
        "it meets the image API limits and the rejection reason. It is the dry-run to avoid " +
        "spending a real call. Images are experimental and require the " +
        "TypeSafe-Danger-Zone-Images header.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Local path of the image file (PNG/JPEG)." },
          data_base64: { type: "string", description: "Base64 without the data: prefix and without line breaks." },
          format: { type: "string", enum: ["png", "jpg", "jpeg"], description: "Format when data_base64 is used." },
        },
        additionalProperties: false,
      },
      run: imageCheckRun,
    }),
  ];

  if (!readOnly) {
    tools.push(
      mutationTool({
        name: "jev_template_create",
        title: "Create a template",
        description:
          "Creates a template after validating the body and its macro metadata. The body can be a " +
          "JSON string or an object. 'macros' is optional: array of { name, description?, schema? }.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Unique template name." },
            description: { type: "string", description: "Optional description." },
            body: {
              description: "JSON body (string or object) with {{key}} macros.",
            },
            macros: {
              type: "array",
              description: "Macro metadata: { name, description?, schema? }.",
            },
          },
          required: ["name", "body"],
          additionalProperties: false,
        },
        run: templateCreateRun,
      }),
      mutationTool({
        name: "jev_template_update",
        title: "Update a template",
        description:
          "Updates the body, description and/or macros of a template; with 'renameTo' it also " +
          "renames it. Only the fields present are modified.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Current template name." },
            description: { type: "string", description: "New description." },
            body: { description: "New JSON body (string or object)." },
            macros: { type: "array", description: "Macro metadata." },
            renameTo: { type: "string", description: "New name (renames)." },
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
        title: "Delete a template",
        description:
          "Permanently deletes a template (its macros are deleted in cascade; the history " +
          "keeps template_name). Requires 'confirm: true'.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Template name." },
            confirm: { type: "boolean", description: "Must be true to confirm the deletion." },
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
        title: "Run an ad-hoc request",
        description:
          "Runs a request against Jev and stores the request in the history (source='mcp'). " +
          "'state' can be text or a JSON object/array; 'questions' is a noul/choice/score map. " +
          "Returns answers, usage and requestId.",
        inputSchema: {
          type: "object",
          properties: {
            state: {
              description: "Content to evaluate: text, JSON object or array.",
              oneOf: [{ type: "string" }, { type: "object" }, { type: "array" }],
            },
            questions: {
              type: "object",
              description: "Typed questions (noul, choice, score) with instructions/criteria.",
            },
            model: { type: "string", description: "Optional model for this execution." },
            assets: {
              type: "object",
              description:
                "Optional images: { ref: { path | data_base64, format } }. The reference is written " +
                "in state/instructions/criteria. Requires the experimental TypeSafe-Danger-Zone-Images header.",
            },
          },
          required: ["state", "questions"],
          additionalProperties: false,
        },
        run: askRun,
      }),
      executionTool({
        name: "jev_batch",
        title: "Run a template over several contexts",
        description:
          "Runs a template once per context and stores each request with the same " +
          "batch_id. Accepts concurrency 1-10 and failFast. Maximum 100 contexts per call.",
        inputSchema: {
          type: "object",
          properties: {
            template: { type: "string", description: "Template name." },
            contexts: { type: "array", description: "Array of context maps." },
            concurrency: { type: "integer", minimum: 1, maximum: 10 },
            failFast: { type: "boolean", description: "Stop at the first error." },
            assets: {
              type: "object",
              description: "Optional images attached to each request in the batch.",
            },
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
      title: "Request history",
      description:
        "Lists the saved requests (including MCP ones) with filters: since (ISO), status, " +
        "model, template, batch and limit.",
      inputSchema: {
        type: "object",
        properties: {
          since: { type: "string", description: "Only requests with created_at >= this ISO date." },
          status: { type: "integer", description: "Exact HTTP status code." },
          model: { type: "string", description: "Exact model." },
          template: { type: "string", description: "Exact template name." },
          batch: { type: "string", description: "Exact batch_id." },
          limit: { type: "integer", minimum: 0, description: "Maximum number of results." },
        },
        additionalProperties: false,
      },
      run: historyListRun,
    }),
    readOnlyTool({
      name: "jev_history_get",
      title: "Request details",
      description: "Returns the full details of a request: request, response, usage, error and source.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "integer", minimum: 1, description: "Request id." } },
        required: ["id"],
        additionalProperties: false,
      },
      run: historyGetRun,
    }),
    readOnlyTool({
      name: "jev_config_get",
      title: "Effective config",
      description:
        "Returns the effective config (endpoint, model, timeout, retries) with the API key " +
        "masked. It never reveals the API key.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: configGetRun,
    }),
  );

  return tools;
}

function overviewDescription(): string {
  return (
    "App status: version, SQLite schema, database path, counters, whether an API key is present and " +
    "the available tools (built-in and dynamic). No side effects and no secrets."
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
    fail("tool_not_found", `unknown topic or tool: ${JSON.stringify(topic)}`);
  }
  return { topic: topic || "overview", content: content.text };
}

async function templateListRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const limit = integerArg(args, "limit", { min: 1 });
  return listTemplatesPayload(ctx, query, limit);
}

/** Payload of `jev_template_list` and the `jev://templates` resource. */
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

/** Payload of `jev_template_get` and the `jev://templates/{name}` resource. */
export function getTemplatePayload(
  ctx: McpContext,
  name: string,
): Record<string, unknown> {
  const entry = findTemplate(ctx, name);
  if (entry === undefined) {
    fail("template_not_found", `template not found: ${name}`);
  }
  return templateDetail(entry.template, entry.toolName);
}

async function templateStartersRun(args: Record<string, unknown>, _ctx: McpContext): Promise<unknown> {
  if (args.id === undefined) {
    return { items: TEMPLATE_STARTERS };
  }
  const starter = getTemplateStarter(args.id as TemplateStarterId);
  if (starter === undefined) {
    fail("invalid_arguments", `unknown starter: ${JSON.stringify(args.id)}`);
  }
  return starter;
}

async function templateValidateRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const bodyInline = args.body;
  const name = args.name;
  if (bodyInline !== undefined && name !== undefined) {
    fail("invalid_arguments", "use 'body' or 'name', not both");
  }
  let bodyJson: string;
  let label: string;
  if (name !== undefined) {
    const templateName = stringArg(args, "name") as string;
    const template = ctx.templates.get(templateName);
    if (template === undefined) {
      fail("template_not_found", `template not found: ${templateName}`);
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
    fail("template_not_found", `template not found: ${name}`);
  }
  try {
    const request = resolveTemplateBody(template.body_json, context as TemplateContext);
    const assets = await assetsFromArgs(args);
    return { request: assets === undefined ? request : { ...request, assets } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail("invalid_render", message);
  }
}

async function imageCheckRun(args: Record<string, unknown>, _ctx: McpContext): Promise<unknown> {
  const path = args.path;
  const dataBase64 = args.data_base64;

  if (path === undefined && dataBase64 === undefined) {
    fail("invalid_arguments", "use 'path' or 'data_base64' (not both)");
  }
  if (path !== undefined && dataBase64 !== undefined) {
    fail("invalid_arguments", "use 'path' or 'data_base64', not both");
  }

  let buffer: Buffer;
  let format: ImageAsset["format"];
  if (typeof path === "string") {
    if (path.trim() === "") {
      fail("invalid_arguments", "path must be a non-empty string");
    }
    const loaded = await loadImageAsset(path);
    buffer = Buffer.from(loaded.asset.data_base64 ?? "", "base64");
    format = loaded.asset.format;
  } else {
    if (typeof dataBase64 !== "string" || dataBase64.trim() === "") {
      fail("invalid_arguments", "data_base64 must be a non-empty string");
    }
    if (args.format !== undefined && typeof args.format !== "string") {
      fail("invalid_arguments", "format must be png|jpg|jpeg");
    }
    let asset: ImageAsset;
    try {
      asset = validateImageAsset(newImageRef(), {
        data_base64: dataBase64,
        format: (args.format as ImageAsset["format"]) ?? undefined,
      });
    } catch (error) {
      fail("invalid_arguments", error instanceof Error ? error.message : String(error));
    }
    buffer = Buffer.from(asset.data_base64 ?? "", "base64");
    format = asset.format;
  }

  const detected = detectImageFormat(buffer);
  const size = readImageSize(buffer);
  const report = assertImageLimits(buffer);
  return {
    format: format ?? detected ?? "unknown",
    width: size?.width ?? report.width ?? null,
    height: size?.height ?? report.height ?? null,
    bytes: buffer.length,
    ok: report.ok,
    reason: report.ok ? null : report.reason,
    experimental: true,
    header: "TypeSafe-Danger-Zone-Images",
  };
}

async function templateCreateRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const name = stringArg(args, "name", { required: true }) as string;
  if (args.description !== undefined && typeof args.description !== "string") {
    fail("invalid_arguments", "description must be a string");
  }
  const description = typeof args.description === "string" ? args.description : "";
  const bodyJson = bodyJsonFromArgs(args.body);
  validateBody(bodyJson);
  const macros = macrosFromArgs(args.macros);
  try {
    if (ctx.templates.get(name) !== undefined) {
      fail("template_conflict", `template already exists: ${name}`);
    }
    ctx.templates.save(name, description, bodyJson, macros);
  } catch (error) {
    if (error instanceof McpToolError) {
      throw error;
    }
    mapTemplateError(error);
  }
  ctx.log(`template created: ${name}`);
  return templateDetail(ctx.templates.get(name) as Template, toolNameFor(ctx, name));
}

async function templateUpdateRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const name = stringArg(args, "name", { required: true }) as string;
  const existing = ctx.templates.get(name);
  if (existing === undefined) {
    fail("template_not_found", `template not found: ${name}`);
  }
  const bodyJson = args.body === undefined ? existing.body_json : bodyJsonFromArgs(args.body);
  if (args.body !== undefined) {
    validateBody(bodyJson);
  }
  let description = existing.description;
  if (args.description !== undefined) {
    if (typeof args.description !== "string") {
      fail("invalid_arguments", "description must be a string");
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
      fail("invalid_arguments", "renameTo must be a non-empty string");
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
  ctx.log(`template updated: ${finalName}`);
  return templateDetail(ctx.templates.get(finalName) as Template, toolNameFor(ctx, finalName));
}

async function templateDeleteRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const name = stringArg(args, "name", { required: true }) as string;
  if (args.confirm !== true) {
    fail(
      "confirmation_required",
      "deleting a template is irreversible: pass 'confirm: true' to confirm",
    );
  }
  if (!ctx.templates.remove(name)) {
    fail("template_not_found", `template not found: ${name}`);
  }
  ctx.log(`template deleted: ${name}`);
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
      `template "${templateName}" no longer exists; refresh the tool list`,
    );
  }
  const macroNames = new Set(template.macros.map((macro) => macro.name));
  const context: TemplateContext = {};
  for (const key of Object.keys(args)) {
    if (key === RESERVED_TEMPLATE_ASSETS_ARG) {
      continue;
    }
    if (!macroNames.has(key)) {
      fail("invalid_arguments", `unknown argument for the template: ${key}`);
    }
    context[key] = args[key];
  }
  let request: JevRequest;
  try {
    request = resolveTemplateBody(template.body_json, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail("invalid_render", message);
  }
  const assets = await assetsFromArgs(args);
  if (assets !== undefined) {
    request = { ...request, assets: { ...(request.assets ?? {}), ...assets } };
    const orphan = orphanAssetRefs(request);
    if (orphan.length > 0) {
      fail(
        "invalid_arguments",
        `assets are not referenced in the resolved template: ${orphan.join(", ")} ` +
          "(the API would return 400)",
      );
    }
  }
  const result = await ctx.service.ask(request, { source: "mcp", templateName });
  return executionResultJson(result);
}

async function askRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  if (!("state" in args)) {
    fail("invalid_request", "the request has no state");
  }
  const state = args.state;
  const stateValid =
    typeof state === "string"
      ? state.trim() !== ""
      : state !== null && typeof state === "object";
  if (!stateValid) {
    fail("invalid_request", "state must be non-empty text or a JSON object/array");
  }
  const model = args.model;
  if (model !== undefined && (typeof model !== "string" || model.trim() === "")) {
    fail("invalid_request", "model must be a non-empty string");
  }
  let questions: Record<string, Question>;
  try {
    questions = validateQuestions(args.questions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail("invalid_request", message);
  }
  const assets = await assetsFromArgs(args);
  const request: JevRequest = {
    model: typeof model === "string" ? model : "",
    state: state as State,
    questions,
    assets,
  };
  const result = await ctx.service.ask(request, { source: "mcp" });
  return executionResultJson(result);
}

async function batchRun(args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const template = stringArg(args, "template", { required: true }) as string;
  if (ctx.templates.get(template) === undefined) {
    fail("template_not_found", `template not found: ${template}`);
  }
  const contexts = args.contexts;
  if (!Array.isArray(contexts)) {
    fail("invalid_contexts", "contexts must be an array of context maps");
  }
  if (contexts.length === 0) {
    fail("invalid_contexts", "contexts cannot be empty");
  }
  if (contexts.length > MCP_BATCH_LIMIT) {
    fail("batch_too_large", `maximum ${MCP_BATCH_LIMIT} contexts per call`);
  }
  const concurrency = integerArg(args, "concurrency", { min: 1, max: MAX_CONCURRENCY }) ?? 1;
  const failFast = booleanArg(args, "failFast") ?? false;
  const assets = await assetsFromArgs(args);
  const batch = await ctx.service.batch(template, contexts as unknown[], {
    concurrency,
    failFast,
    assets,
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
    fail("history_not_found", `request ${id} does not exist`);
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
// Catalog helpers
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
// Tool registry
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
