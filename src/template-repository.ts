import type { SqliteDatabase } from "./database.js";
import { detectMacros } from "./template.js";

/** Maximum length of a macro's free-form description. */
export const MAX_MACRO_DESCRIPTION_LENGTH = 500;

/** Maximum size of a macro schema's compact JSON. */
export const MAX_MACRO_SCHEMA_BYTES = 8 * 1024;

/**
 * Types accepted by the basic JSON Schema editor. `image` is a Jev extension:
 * it marks a macro that must be filled with an image file instead of text, so
 * the batch editor can render a per-row file picker for it.
 */
export const MACRO_SCHEMA_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
  "image",
] as const;

export type MacroSchemaType = (typeof MACRO_SCHEMA_TYPES)[number];

/** Informative JSON schema for a macro (object or boolean). */
export type MacroSchema = boolean | Record<string, unknown>;

/** Stable codes that the API maps to 400. */
export type MacroSchemaErrorCode =
  | "invalid_macro_schema"
  | "invalid_macro_schema_type";

export class MacroSchemaError extends Error {
  constructor(
    readonly code: MacroSchemaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MacroSchemaError";
  }
}

/** Metadata of a macro detected in a template body. */
export interface TemplateMacro {
  name: string;
  description: string;
  /** Persisted schema; `null` or absent means a macro without a schema. */
  schema?: MacroSchema | null;
}

interface StoredMacro {
  description: string;
  schema_json: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaError(message: string): MacroSchemaError {
  return new MacroSchemaError("invalid_macro_schema", message);
}

/** Checks that no `$ref` points outside the document. */
function assertLocalRefs(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertLocalRefs(item);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref") {
      if (typeof child !== "string" || !child.startsWith("#")) {
        throw schemaError(
          "remote $ref not allowed: only local references starting with # are accepted",
        );
      }
      continue;
    }
    assertLocalRefs(child);
  }
}

/**
 * Validates the minimal structure of a macro schema without resolving the
 * full meta-schema: JSON shape, `type`, basic-editor keywords, local
 * `$ref`s and maximum size.
 */
export function validateMacroSchema(value: unknown): MacroSchema {
  if (typeof value === "boolean") return value;
  if (!isPlainObject(value)) {
    throw schemaError("the schema must be a JSON object or a boolean");
  }

  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw schemaError("the schema could not be serialized as JSON");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_MACRO_SCHEMA_BYTES) {
    throw schemaError(
      `the schema exceeds the limit of ${MAX_MACRO_SCHEMA_BYTES} bytes`,
    );
  }

  assertLocalRefs(value);

  if ("type" in value) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    const valid = types.length > 0 && types.every(
      (type) =>
        typeof type === "string" &&
        (MACRO_SCHEMA_TYPES as readonly string[]).includes(type),
    );
    if (!valid) {
      throw new MacroSchemaError(
        "invalid_macro_schema_type",
        `type must be ${MACRO_SCHEMA_TYPES.join(" | ")} or a non-empty array of those values`,
      );
    }
  }

  if ("enum" in value && (!Array.isArray(value.enum) || value.enum.length === 0)) {
    throw schemaError("enum must be a non-empty array");
  }
  if ("format" in value && typeof value.format !== "string") {
    throw schemaError("format must be a string");
  }
  if ("pattern" in value) {
    if (typeof value.pattern !== "string") {
      throw schemaError("pattern must be a string");
    }
    try {
      new RegExp(value.pattern);
    } catch {
      throw schemaError("pattern is not a compilable regular expression");
    }
  }
  for (const keyword of ["minLength", "maxLength", "minimum", "maximum"]) {
    if (keyword in value && typeof value[keyword] !== "number") {
      throw schemaError(`${keyword} must be a number`);
    }
  }

  return value;
}

/** Serializes an already validated schema in compact form; `null` clears it. */
export function serializeMacroSchema(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(validateMacroSchema(value));
}

function parseStoredSchema(raw: string | null): MacroSchema | null {
  if (raw === null) return null;
  try {
    return validateMacroSchema(JSON.parse(raw));
  } catch {
    return null;
  }
}

export interface Template {
  name: string;
  description: string;
  body_json: string;
  created_at: string;
  updated_at: string;
  /** Body macros merged with their persisted metadata. */
  macros: TemplateMacro[];
}

interface TemplateRow {
  name: string;
  description: string;
  body_json: string;
  created_at: string;
  updated_at: string;
}

interface MacroRow {
  template_name: string;
  macro: string;
  description: string;
  schema_json: string | null;
  created_at: string;
}

/**
 * Normalizes the received descriptions and schemas and checks that each macro
 * exists in the body. The last entry of a repeated macro wins.
 */
function normalizeMacros(
  bodyJson: string,
  entries: Iterable<TemplateMacro>,
): Map<string, StoredMacro> {
  const detected = new Set(detectMacros(bodyJson));
  const normalized = new Map<string, StoredMacro>();
  for (const entry of entries) {
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!detected.has(name)) {
      throw new Error(`macro ${JSON.stringify(name)} is not in the template body`);
    }
    const description = typeof entry.description === "string" ? entry.description.trim() : "";
    if (description.length > MAX_MACRO_DESCRIPTION_LENGTH) {
      throw new Error(
        `the description of macro ${JSON.stringify(name)} exceeds ${MAX_MACRO_DESCRIPTION_LENGTH} characters`,
      );
    }
    let schema_json: string | null = null;
    if (entry.schema !== undefined && entry.schema !== null) {
      try {
        schema_json = serializeMacroSchema(entry.schema);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw error instanceof MacroSchemaError
          ? new MacroSchemaError(error.code, `schema of ${JSON.stringify(name)}: ${message}`)
          : error;
      }
    }
    normalized.set(name, { description, schema_json });
  }
  return normalized;
}

/** Typed repository over the templates and template_macros tables. */
export class TemplateRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(name: string): Template | undefined {
    const row = this.db
      .prepare<[string], TemplateRow>(
        "SELECT name, description, body_json, created_at, updated_at FROM templates WHERE name = ?",
      )
      .get(name);
    if (row === undefined) {
      return undefined;
    }
    return this.withMacros(row, this.storedMacros(name));
  }

  /**
   * Inserts or replaces a template; preserves `created_at` on update.
   * Syncs `template_macros` with the macros detected in the body: removes
   * orphan rows and keeps existing descriptions and schemas when they are not
   * passed explicitly. Without a description, the row keeps `""`; without a
   * schema, `schema_json` stays `NULL`.
   */
  save(
    name: string,
    description: string,
    body_json: string,
    macros?: Iterable<TemplateMacro>,
  ): void {
    const provided = macros === undefined
      ? undefined
      : normalizeMacros(body_json, macros);
    const detected = detectMacros(body_json);
    const now = new Date().toISOString();

    this.db.transaction(() => {
      const created_at = this.db
        .prepare<[string], { created_at: string }>(
          "SELECT created_at FROM templates WHERE name = ?",
        )
        .get(name)?.created_at ?? now;
      this.db
        .prepare(
          `INSERT INTO templates (name, description, body_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             description = excluded.description,
             body_json = excluded.body_json,
             updated_at = excluded.updated_at`,
        )
        .run(name, description, body_json, created_at, now);

      const existing = new Map(
        this.db
          .prepare<[string], Pick<MacroRow, "macro" | "description" | "schema_json" | "created_at">>(
            "SELECT macro, description, schema_json, created_at FROM template_macros WHERE template_name = ?",
          )
          .all(name)
          .map((row) => [row.macro, row] as const),
      );

      if (detected.length === 0) {
        this.db
          .prepare("DELETE FROM template_macros WHERE template_name = ?")
          .run(name);
      } else {
        const placeholders = detected.map(() => "?").join(", ");
        this.db
          .prepare(
            `DELETE FROM template_macros
             WHERE template_name = ? AND macro NOT IN (${placeholders})`,
          )
          .run(name, ...detected);
      }

      const upsert = this.db.prepare(
        `INSERT INTO template_macros (template_name, macro, description, schema_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(template_name, macro) DO UPDATE SET
           description = excluded.description,
           schema_json = excluded.schema_json,
           updated_at = excluded.updated_at`,
      );
      for (const macro of detected) {
        const current = existing.get(macro);
        const stored = provided === undefined
          ? { description: current?.description ?? "", schema_json: current?.schema_json ?? null }
          : provided.get(macro) ?? { description: "", schema_json: null };
        upsert.run(
          name,
          macro,
          stored.description,
          stored.schema_json,
          current?.created_at ?? now,
          now,
        );
      }
    })();
  }

  remove(name: string): boolean {
    return (
      this.db.prepare("DELETE FROM templates WHERE name = ?").run(name).changes >
      0
    );
  }

  /** Renames without overwriting; any failure keeps the original template. */
  rename(name: string, newName: string): void {
    if (newName.trim() === "") {
      throw new Error("the template name cannot be empty");
    }

    this.db.transaction(() => {
      const source = this.get(name);
      if (source === undefined) {
        throw new Error(`template not found: ${name}`);
      }
      if (name === newName) {
        return;
      }
      if (this.get(newName) !== undefined) {
        throw new Error(`template already exists: ${newName}`);
      }

      this.db
        .prepare("UPDATE templates SET name = ?, updated_at = ? WHERE name = ?")
        .run(newName, new Date().toISOString(), name);
    })();
  }

  list(): Template[] {
    const stored = this.allStoredMacros();
    return this.db
      .prepare<[], TemplateRow>(
        "SELECT name, description, body_json, created_at, updated_at FROM templates ORDER BY name",
      )
      .all()
      .map((row) => this.withMacros(row, stored.get(row.name) ?? new Map()));
  }

  private withMacros(
    row: TemplateRow,
    stored: Map<string, StoredMacro>,
  ): Template {
    return {
      ...row,
      macros: detectMacros(row.body_json).map((name) => {
        const metadata = stored.get(name);
        return {
          name,
          description: metadata?.description ?? "",
          schema: parseStoredSchema(metadata?.schema_json ?? null),
        };
      }),
    };
  }

  private storedMacros(name: string): Map<string, StoredMacro> {
    return new Map(
      this.db
        .prepare<[string], Pick<MacroRow, "macro" | "description" | "schema_json">>(
          "SELECT macro, description, schema_json FROM template_macros WHERE template_name = ?",
        )
        .all(name)
        .map((row) => [
          row.macro,
          { description: row.description, schema_json: row.schema_json },
        ] as const),
    );
  }

  private allStoredMacros(): Map<string, Map<string, StoredMacro>> {
    const grouped = new Map<string, Map<string, StoredMacro>>();
    for (const row of this.db
      .prepare<[], Pick<MacroRow, "template_name" | "macro" | "description" | "schema_json">>(
        "SELECT template_name, macro, description, schema_json FROM template_macros",
      )
      .all()) {
      const current = grouped.get(row.template_name) ?? new Map<string, StoredMacro>();
      current.set(row.macro, {
        description: row.description,
        schema_json: row.schema_json,
      });
      grouped.set(row.template_name, current);
    }
    return grouped;
  }
}
