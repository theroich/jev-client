import type { ImageAsset, JevRequest, Question, State } from "./types.js";

/** Key-value map used to resolve a template's macros. */
export type TemplateContext = Record<string, unknown>;

/** Result of resolving one or more macros. */
export interface MacroResolution {
  value: unknown;
  /** Macro keys referenced but missing from the context, in order of appearance. */
  missing: string[];
}

interface Token {
  kind: "text" | "macro";
  value: string;
}

/**
 * Splits a string into literal text and `{{key}}` macros. `\` escapes the
 * next character, so `\{{...}}` produces the literal text `{{...}}`.
 * An unclosed macro (`{{`) is treated as literal text.
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let literal = "";
  let index = 0;

  const flush = () => {
    if (literal !== "") {
      tokens.push({ kind: "text", value: literal });
      literal = "";
    }
  };

  while (index < text.length) {
    const char = text[index] as string;

    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined) {
        literal += "\\";
        index += 1;
      } else {
        literal += next;
        index += 2;
      }
      continue;
    }

    if (char === "{" && text[index + 1] === "{") {
      const close = text.indexOf("}}", index + 2);
      if (close === -1) {
        literal += "{{";
        index += 2;
        continue;
      }
      const key = text.slice(index + 2, close).trim();
      flush();
      tokens.push({ kind: "macro", value: key });
      index = close + 2;
      continue;
    }

    literal += char;
    index += 1;
  }

  flush();
  return tokens;
}

/**
 * Looks up `path` in the context. First as a literal key (allows keys with
 * dots) and, if it does not exist, as a nested path separated by `.`.
 */
function lookupPath(
  context: TemplateContext,
  path: string,
): { found: boolean; value: unknown } {
  if (Object.prototype.hasOwnProperty.call(context, path)) {
    return { found: true, value: context[path] };
  }

  let current: unknown = context;
  for (const segment of path.split(".")) {
    if (current !== null && typeof current === "object") {
      const record = current as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(record, segment)) {
        current = record[segment];
        continue;
      }
    }
    return { found: false, value: undefined };
  }
  return { found: true, value: current };
}

/** Converts a value to a string for interpolation inside text. */
function stringifyInterpolation(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

/**
 * Resolves the macros of a string. If the string is exactly one macro, the
 * value's native type is preserved; if embedded in text, it is interpolated
 * as a string.
 */
export function resolveStringMacros(
  text: string,
  context: TemplateContext,
): MacroResolution {
  const tokens = tokenize(text);

  if (tokens.length === 1 && tokens[0]?.kind === "macro") {
    const key = tokens[0].value;
    const { found, value } = lookupPath(context, key);
    return { value, missing: found ? [] : [key] };
  }

  let result = "";
  const missing: string[] = [];
  for (const token of tokens) {
    if (token.kind === "text") {
      result += token.value;
      continue;
    }
    const { found, value } = lookupPath(context, token.value);
    if (found) {
      result += stringifyInterpolation(value);
    } else {
      missing.push(token.value);
    }
  }
  return { value: result, missing };
}

/** Walks a JSON value resolving the macros of all its strings. */
export function resolveJsonMacros(
  value: unknown,
  context: TemplateContext,
): MacroResolution {
  if (typeof value === "string") {
    return resolveStringMacros(value, context);
  }
  if (Array.isArray(value)) {
    const resolved: unknown[] = [];
    const missing: string[] = [];
    for (const item of value) {
      const result = resolveJsonMacros(item, context);
      resolved.push(result.value);
      missing.push(...result.missing);
    }
    return { value: resolved, missing };
  }
  if (value !== null && typeof value === "object") {
    const resolved: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const [key, item] of Object.entries(value)) {
      const result = resolveJsonMacros(item, context);
      resolved[key] = result.value;
      missing.push(...result.missing);
    }
    return { value: resolved, missing };
  }
  return { value, missing: [] };
}

/**
 * Parses a template body that is a superset of JSON: `{{macro}}` placeholders
 * may also appear bare (unquoted) as values, e.g. `"criteria": {{criterias}}`.
 * A bare macro is rewritten as the string `"{{macro}}"`, so the rest of the
 * pipeline treats it exactly like a string macro that resolves to its native
 * type (object/array/number…). Macros inside strings are left untouched.
 */
function parseTemplateJson(text: string): unknown {
  let out = "";
  let index = 0;
  let inString = false;

  while (index < text.length) {
    const char = text[index] as string;

    if (inString) {
      if (char === "\\") {
        out += char;
        const next = text[index + 1];
        if (next !== undefined) out += next;
        index += 2;
        continue;
      }
      out += char;
      if (char === '"') inString = false;
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }

    if (char === "{" && text[index + 1] === "{") {
      const close = text.indexOf("}}", index + 2);
      if (close !== -1) {
        const macro = text.slice(index + 2, close).trim();
        out += `"{{${macro}}}"`;
        index = close + 2;
        continue;
      }
    }

    out += char;
    index += 1;
  }

  return JSON.parse(out);
}

/**
 * Resolves a template body against a context and validates it as a
 * request. If any macro is missing, it fails listing all absent keys.
 */
export function resolveTemplateBody(
  bodyJson: string,
  context: TemplateContext,
): JevRequest {
  let parsed: unknown;
  try {
    parsed = parseTemplateJson(bodyJson);
  } catch (error) {
    throw new Error(`invalid JSON in template: ${messageOf(error)}`);
  }

  const { value, missing } = resolveJsonMacros(parsed, context);
  const unique = [...new Set(missing)].sort();
  if (unique.length > 0) {
    throw new Error(`missing macros in context: ${unique.join(", ")}`);
  }

  return validateTemplateRequest(value);
}

/**
 * Parses and validates a template body (with unresolved macros) as a
 * Jev request. It does not resolve macros: it only checks structure and types.
 */
export function validateTemplateBody(bodyJson: string): JevRequest {
  let parsed: unknown;
  try {
    parsed = parseTemplateJson(bodyJson);
  } catch (error) {
    throw new Error(`invalid JSON in template: ${messageOf(error)}`);
  }
  return validateTemplateRequest(parsed);
}

/**
 * Returns the `{{key}}` macro keys present in a template body, sorted and
 * without duplicates. It does not validate structure: if the JSON cannot be
 * parsed, it returns an empty list (`validateTemplateBody` does the validation).
 */
export function detectMacros(bodyJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = parseTemplateJson(bodyJson);
  } catch {
    return [];
  }
  const keys = new Set<string>();
  collectMacros(parsed, keys);
  return [...keys].sort();
}

function collectMacros(value: unknown, keys: Set<string>): void {
  if (typeof value === "string") {
    for (const token of tokenize(value)) {
      if (token.kind === "macro") {
        keys.add(token.value);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectMacros(item, keys);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectMacros(item, keys);
    }
  }
}

/** Validates an already resolved value as a Jev request. */
export function validateTemplateRequest(value: unknown): JevRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("the template must be a JSON object");
  }
  const record = value as Record<string, unknown>;

  const model = record.model;
  if (model === undefined) {
    throw new Error("the template has no model");
  }
  if (typeof model !== "string" || model === "") {
    throw new Error("the template has an invalid model");
  }

  const state = record.state;
  if (state === undefined) {
    throw new Error("the template has no state");
  }
  if (
    typeof state !== "string" &&
    !(state !== null && typeof state === "object")
  ) {
    throw new Error("the template has an invalid state");
  }

  const assets = validateTemplateAssets(record.assets);
  const request: JevRequest = {
    model,
    state: state as State,
    questions: validateQuestions(record.questions),
  };
  if (assets !== undefined) {
    request.assets = assets;
  }
  return request;
}

/**
 * Validates a template's `assets`. Templates do not store base64: they can
 * only contain references (`data_base64` is provided at run time via
 * `--asset`, MCP or the web console).
 */
export function validateTemplateAssets(
  value: unknown,
): Record<string, ImageAsset> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("assets must be a JSON object");
  }
  const assets = value as Record<string, ImageAsset>;
  for (const [ref, asset] of Object.entries(assets)) {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      throw new Error(`asset ${JSON.stringify(ref)} must be an object`);
    }
    if (asset.data_base64 !== undefined) {
      throw new Error(
        `asset ${JSON.stringify(ref)} cannot include data_base64 in a template: ` +
          "provide the image at run time (--asset, MCP or web upload)",
      );
    }
  }
  return assets;
}

/** Validates a questions object (names and supported types). */
export function validateQuestions(value: unknown): Record<string, Question> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("questions must be a JSON object");
  }
  const questions = value as Record<string, Question>;
  if (Object.keys(questions).length === 0) {
    throw new Error("at least one question is required");
  }

  for (const [name, question] of Object.entries(questions)) {
    if (!question || typeof question.type !== "string" || question.type === "") {
      throw new Error(`question ${JSON.stringify(name)} has no type`);
    }
    if (!["noul", "choice", "score"].includes(question.type)) {
      throw new Error(
        `question ${JSON.stringify(name)} uses an unsupported type: ` +
          `${JSON.stringify(question.type)} (use noul, choice or score)`,
      );
    }
  }

  return questions;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
