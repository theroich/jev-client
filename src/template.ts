import type { JevRequest, Question, State } from "./types.js";

/** Mapa clave-valor usado para resolver las macros de una plantilla. */
export type TemplateContext = Record<string, unknown>;

/** Resultado de resolver una o varias macros. */
export interface MacroResolution {
  value: unknown;
  /** Claves de macros referenciadas y ausentes del contexto, en orden de aparición. */
  missing: string[];
}

interface Token {
  kind: "text" | "macro";
  value: string;
}

/**
 * Separa un string en texto literal y macros `{{clave}}`. `\` escapa al
 * siguiente carácter, de modo que `\{{...}}` produce el texto literal `{{...}}`.
 * Una macro sin cierre (`{{`) se trata como texto literal.
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
 * Busca `path` en el contexto. Primero como clave literal (permite claves con
 * puntos) y, si no existe, como ruta anidada separada por `.`.
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

/** Convierte un valor a string para interpolarlo dentro de texto. */
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
 * Resuelve las macros de un string. Si el string es exactamente una macro se
 * conserva el tipo nativo del valor; si está embebido en texto se interpola
 * como string.
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

/** Recorre un valor JSON resolviendo las macros de todos sus strings. */
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
 * Resuelve el cuerpo de una plantilla contra un contexto y lo valida como
 * request. Si falta alguna macro, falla listando todas las claves ausentes.
 */
export function resolveTemplateBody(
  bodyJson: string,
  context: TemplateContext,
): JevRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyJson);
  } catch (error) {
    throw new Error(`JSON inválido en la plantilla: ${messageOf(error)}`);
  }

  const { value, missing } = resolveJsonMacros(parsed, context);
  const unique = [...new Set(missing)].sort();
  if (unique.length > 0) {
    throw new Error(`faltan macros en el contexto: ${unique.join(", ")}`);
  }

  return validateTemplateRequest(value);
}

/** Valida un valor ya resuelto como request de Jev. */
export function validateTemplateRequest(value: unknown): JevRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("la plantilla debe ser un objeto JSON");
  }
  const record = value as Record<string, unknown>;

  const model = record.model;
  if (model === undefined) {
    throw new Error("la plantilla no tiene model");
  }
  if (typeof model !== "string" || model === "") {
    throw new Error("la plantilla tiene un model inválido");
  }

  const state = record.state;
  if (state === undefined) {
    throw new Error("la plantilla no tiene state");
  }
  if (
    typeof state !== "string" &&
    !(state !== null && typeof state === "object")
  ) {
    throw new Error("la plantilla tiene un state inválido");
  }

  return { model, state: state as State, questions: validateQuestions(record.questions) };
}

/** Valida un objeto de preguntas (nombres y tipos soportados). */
export function validateQuestions(value: unknown): Record<string, Question> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("las preguntas deben ser un objeto JSON");
  }
  const questions = value as Record<string, Question>;
  if (Object.keys(questions).length === 0) {
    throw new Error("se necesita al menos una pregunta");
  }

  for (const [name, question] of Object.entries(questions)) {
    if (!question || typeof question.type !== "string" || question.type === "") {
      throw new Error(`la pregunta ${JSON.stringify(name)} no tiene type`);
    }
    if (!["noul", "choice", "score"].includes(question.type)) {
      throw new Error(
        `la pregunta ${JSON.stringify(name)} usa un tipo no soportado: ` +
          `${JSON.stringify(question.type)} (usa noul, choice o score)`,
      );
    }
  }

  return questions;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
