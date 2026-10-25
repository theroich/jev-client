import type { Template, TemplateMacro } from "../template-repository.js";

/** Longitud máxima de la descripción de un tool (para no saturar al LLM). */
export const MAX_TOOL_DESCRIPTION_LENGTH = 2_000;

/** Longitud máxima de la descripción de un parámetro de tool. */
export const MAX_PARAM_DESCRIPTION_LENGTH = 500;

/** Patrón conservador de nombre de tool MCP. */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Prefijo reservado para las tools fijas del servidor. */
export const RESERVED_TOOL_PREFIX = "jev_";

/** Anotaciones MCP de un tool. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Keywords que ya restringen el tipo sin declarar `type`. */
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
 * Esquema JSON de un parámetro de tool, derivado de una macro.
 *
 * - Sin esquema (o `true`): `{ "type": "string" }`.
 * - Esquema objeto: se conserva completo; si no declara `type` y no restringe
 *   el tipo por `enum`/`const`/`oneOf`/`anyOf`/`allOf`/`$ref`, se añade
 *   `"type": "string"` para no invalidarlo.
 * - `false` (ningún valor válido): `{ "not": {} }`, equivalente y serializable.
 *
 * La descripción del parámetro es `macro.description`, o `schema.description`
 * si la primera está vacía. Se recorta a `MAX_PARAM_DESCRIPTION_LENGTH`.
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
 * `inputSchema` JSON Schema de una plantilla: una propiedad por macro detectada
 * con su clave exacta (incluidas rutas con puntos), todas `required` y
 * `additionalProperties: false`.
 */
export function inputSchemaForTemplate(template: Template): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const macro of template.macros) {
    properties[macro.name] = macroParamSchema(macro);
  }
  return {
    type: "object",
    properties,
    required: template.macros.map((macro) => macro.name),
    additionalProperties: false,
  };
}

/** `true` si el nombre cumple el patrón MCP y no usa el prefijo reservado. */
export function isValidToolName(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name) && !name.startsWith(RESERVED_TOOL_PREFIX);
}

/** Recorta y normaliza un nombre de plantilla a un slug `tpl_<slug>`. */
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
 * Nombre de tool para una plantilla. Devuelve el nombre exacto cuando es válido
 * y no colisiona; en otro caso un alias determinista `tpl_<slug>`.
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

/** Descripción de una plantilla para su tool; fallback determinista si vacía. */
export function toolDescriptionForTemplate(template: Template): string {
  const description = template.description.trim();
  const fallback = `Ejecuta la plantilla "${template.name}" con los valores de sus macros.`;
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

/** Hash FNV-1a corto, determinista y alfanumérico. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).slice(0, 6).padStart(6, "0");
}
