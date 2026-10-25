import type { SqliteDatabase } from "./database.js";
import { detectMacros } from "./template.js";

/** Longitud máxima de la descripción libre de una macro. */
export const MAX_MACRO_DESCRIPTION_LENGTH = 500;

/** Tamaño máximo del JSON compacto de un esquema de macro. */
export const MAX_MACRO_SCHEMA_BYTES = 8 * 1024;

/** Tipos admitidos por el editor básico de JSON Schema. */
export const MACRO_SCHEMA_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
] as const;

export type MacroSchemaType = (typeof MACRO_SCHEMA_TYPES)[number];

/** Esquema JSON informativo de una macro (objeto o booleano). */
export type MacroSchema = boolean | Record<string, unknown>;

/** Códigos estables que la API traduce a 400. */
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

/** Metadatos de una macro detectada en el body de una plantilla. */
export interface TemplateMacro {
  name: string;
  description: string;
  /** Esquema persistido; `null` o ausente equivale a macro sin esquema. */
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

/** Comprueba que ningún `$ref` apunte fuera del documento. */
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
          "$ref remoto no permitido: solo se admiten referencias locales que empiecen por #",
        );
      }
      continue;
    }
    assertLocalRefs(child);
  }
}

/**
 * Valida la estructura mínima de un esquema de macro sin resolver el
 * meta-esquema completo: forma JSON, `type`, keywords del editor básico,
 * `$ref` locales y tamaño máximo.
 */
export function validateMacroSchema(value: unknown): MacroSchema {
  if (typeof value === "boolean") return value;
  if (!isPlainObject(value)) {
    throw schemaError("el esquema debe ser un objeto JSON o un booleano");
  }

  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw schemaError("el esquema no se pudo serializar como JSON");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_MACRO_SCHEMA_BYTES) {
    throw schemaError(
      `el esquema supera el límite de ${MAX_MACRO_SCHEMA_BYTES} bytes`,
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
        `type debe ser ${MACRO_SCHEMA_TYPES.join(" | ")} o un array no vacío de esos valores`,
      );
    }
  }

  if ("enum" in value && (!Array.isArray(value.enum) || value.enum.length === 0)) {
    throw schemaError("enum debe ser un array no vacío");
  }
  if ("format" in value && typeof value.format !== "string") {
    throw schemaError("format debe ser un string");
  }
  if ("pattern" in value) {
    if (typeof value.pattern !== "string") {
      throw schemaError("pattern debe ser un string");
    }
    try {
      new RegExp(value.pattern);
    } catch {
      throw schemaError("pattern no es una expresión regular compilable");
    }
  }
  for (const keyword of ["minLength", "maxLength", "minimum", "maximum"]) {
    if (keyword in value && typeof value[keyword] !== "number") {
      throw schemaError(`${keyword} debe ser un número`);
    }
  }

  return value;
}

/** Serializa un esquema ya validado en formato compacto; `null` lo limpia. */
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
  /** Macros del body fusionadas con sus metadatos persistidos. */
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
 * Normaliza las descripciones y esquemas recibidos y comprueba que cada macro
 * exista en el body. La última entrada de una macro repetida prevalece.
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
      throw new Error(`la macro ${JSON.stringify(name)} no está en el body de la plantilla`);
    }
    const description = typeof entry.description === "string" ? entry.description.trim() : "";
    if (description.length > MAX_MACRO_DESCRIPTION_LENGTH) {
      throw new Error(
        `la descripción de la macro ${JSON.stringify(name)} supera los ${MAX_MACRO_DESCRIPTION_LENGTH} caracteres`,
      );
    }
    let schema_json: string | null = null;
    if (entry.schema !== undefined && entry.schema !== null) {
      try {
        schema_json = serializeMacroSchema(entry.schema);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw error instanceof MacroSchemaError
          ? new MacroSchemaError(error.code, `esquema de ${JSON.stringify(name)}: ${message}`)
          : error;
      }
    }
    normalized.set(name, { description, schema_json });
  }
  return normalized;
}

/** Repositorio tipado sobre las tablas templates y template_macros. */
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
   * Inserta o reemplaza una plantilla; conserva `created_at` al actualizar.
   * Sincroniza `template_macros` con las macros detectadas en el body: elimina
   * las filas huérfanas y conserva descripciones y esquemas existentes cuando
   * no se pasan explícitamente. Sin descripción, la fila queda con `""`; sin
   * esquema, `schema_json` queda en `NULL`.
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

  /** Renombra sin sobrescribir; cualquier fallo conserva la plantilla original. */
  rename(name: string, newName: string): void {
    if (newName.trim() === "") {
      throw new Error("el nombre de la plantilla no puede estar vacío");
    }

    this.db.transaction(() => {
      const source = this.get(name);
      if (source === undefined) {
        throw new Error(`plantilla no encontrada: ${name}`);
      }
      if (name === newName) {
        return;
      }
      if (this.get(newName) !== undefined) {
        throw new Error(`ya existe la plantilla: ${newName}`);
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
