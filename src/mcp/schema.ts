import type { Template, TemplateMacro } from "../template-repository.js";

/** Maximum length of a tool description (to avoid flooding the LLM). */
export const MAX_TOOL_DESCRIPTION_LENGTH = 2_000;

/** Maximum length of a tool parameter description. */
export const MAX_PARAM_DESCRIPTION_LENGTH = 500;

/** Conservative MCP tool name pattern. */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Prefix reserved for the server's built-in tools. */
export const RESERVED_TOOL_PREFIX = "jev_";

/**
 * Argument reserved for attaching images to a template tool. It wins over a
 * macro of the same name, so `{{assets}}` is not usable as a macro.
 */
export const RESERVED_TEMPLATE_ASSETS_ARG = "assets";

/** MCP annotations for a tool. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Keywords that already restrict the type without declaring `type`. */
const TYPE_RESTRICTING_KEYWORDS = [
  "enum",
  "const",
  "oneOf",
  "anyOf",
  "allOf",
  "$ref",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function schemaDescription(schema: TemplateMacro["schema"]): string {
  if (!isPlainObject(schema)) {
    return "";
  }
  return typeof schema.description === "string" ? schema.description : "";
}

function restrictsType(schema: Record<string, unknown>): boolean {
  return TYPE_RESTRICTING_KEYWORDS.some((keyword) => keyword in schema);
}

/**
 * JSON Schema for a tool parameter, derived from a macro.
 *
 * - No schema (or `true`): `{ "type": "string" }`.
 * - Object schema: kept as-is; if it does not declare `type` and does not
 *   restrict the type through `enum`/`const`/`oneOf`/`anyOf`/`allOf`/`$ref`,
 *   `"type": "string"` is added so it is not invalidated.
 * - `false` (no valid value): `{ "not": {} }`, equivalent and serializable.
 *
 * The parameter description is `macro.description`, or `schema.description`
 * when the former is empty. It is truncated to `MAX_PARAM_DESCRIPTION_LENGTH`.
 */
export function macroParamSchema(macro: TemplateMacro): Record<string, unknown> {
  let schema: Record<string, unknown>;
  const schemaValue = macro.schema;

  if (schemaValue === undefined || schemaValue === null) {
    schema = { type: "string" };
  } else if (schemaValue === true) {
    schema = { type: "string" };
  } else if (schemaValue === false) {
    schema = { not: {} };
  } else {
    schema = cloneJson(schemaValue);
    if (schema.type === undefined && !restrictsType(schema)) {
      schema.type = "string";
    }
  }

  const description = (macro.description ?? "").trim() || schemaDescription(schemaValue);
  if (description !== "") {
    schema.description = truncate(description, MAX_PARAM_DESCRIPTION_LENGTH);
  }

  return schema;
}

/**
 * Optional `assets` parameter of a template tool: `{ ref: { path | data_base64,
 * format } }`, with the same semantics as `jev_ask`/`jev_batch`.
 */
export function assetsParamSchema(): Record<string, unknown> {
  return {
    type: "object",
    description:
      "Optional images: { ref: { path | data_base64, format } }. The reference is written " +
      "in the template body (state, instructions or criteria). Requires the experimental " +
      "TypeSafe-Danger-Zone-Images header.",
  };
}

/**
 * `inputSchema` JSON Schema for a template: one property per detected macro
 * with its exact key (including dotted paths), all `required`, plus the
 * reserved optional `assets` argument, and `additionalProperties: false`.
 */
export function inputSchemaForTemplate(template: Template): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const macro of template.macros) {
    if (macro.name === RESERVED_TEMPLATE_ASSETS_ARG) {
      // The reserved image argument wins over a macro of the same name.
      continue;
    }
    properties[macro.name] = macroParamSchema(macro);
    required.push(macro.name);
  }
  properties[RESERVED_TEMPLATE_ASSETS_ARG] = assetsParamSchema();
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

/** `true` if the name matches the MCP pattern and does not use the reserved prefix. */
export function isValidToolName(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name) && !name.startsWith(RESERVED_TOOL_PREFIX);
}

/** Trims and normalizes a template name into a `tpl_<slug>` slug. */
export function templateAlias(name: string, taken: Set<string>): string {
  const base = slugify(name) || "template";
  let candidate = `tpl_${base}`;
  if (taken.has(candidate)) {
    candidate = `tpl_${base}-${shortHash(name)}`;
  }
  let counter = 2;
  while (taken.has(candidate)) {
    candidate = `tpl_${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

/**
 * Tool name for a template. Returns the exact name when it is valid and does
 * not collide; otherwise a deterministic `tpl_<slug>` alias.
 */
export function toolNameForTemplate(
  name: string,
  taken: Set<string>,
): { toolName: string; aliased: boolean } {
  if (isValidToolName(name) && !taken.has(name)) {
    return { toolName: name, aliased: false };
  }
  return { toolName: templateAlias(name, taken), aliased: true };
}

/** Description of a template for its tool; deterministic fallback when empty. */
export function toolDescriptionForTemplate(template: Template): string {
  const description = template.description.trim();
  const fallback = `Runs the "${template.name}" template with its macro values.`;
  return truncate(description !== "" ? description : fallback, MAX_TOOL_DESCRIPTION_LENGTH);
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Short, deterministic, alphanumeric FNV-1a hash. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).slice(0, 6).padStart(6, "0");
}
