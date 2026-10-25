import type { SqliteDatabase } from "./database.js";
import { detectMacros } from "./template.js";

/** Longitud máxima de la descripción libre de una macro. */
export const MAX_MACRO_DESCRIPTION_LENGTH = 500;

/** Metadatos de una macro detectada en el body de una plantilla. */
export interface TemplateMacro {
  name: string;
  description: string;
}

export interface Template {
  name: string;
  description: string;
  body_json: string;
  created_at: string;
  updated_at: string;
  /** Macros del body fusionadas con las descripciones persistidas. */
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
  created_at: string;
}

/**
 * Normaliza las descripciones recibidas y comprueba que cada macro exista en
 * el body. La última descripción de una macro repetida prevalece.
 */
function normalizeMacroDescriptions(
  bodyJson: string,
  entries: Iterable<TemplateMacro>,
): Map<string, string> {
  const detected = new Set(detectMacros(bodyJson));
  const normalized = new Map<string, string>();
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
    normalized.set(name, description);
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
    return this.withMacros(row, this.storedDescriptions(name));
  }

  /**
   * Inserta o reemplaza una plantilla; conserva `created_at` al actualizar.
   * Sincroniza `template_macros` con las macros detectadas en el body: elimina
   * las filas huérfanas y conserva las descripciones existentes cuando no se
   * pasan explícitamente. Sin descripción, la fila queda con `""`.
   */
  save(
    name: string,
    description: string,
    body_json: string,
    macros?: Iterable<TemplateMacro>,
  ): void {
    const provided = macros === undefined
      ? undefined
      : normalizeMacroDescriptions(body_json, macros);
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
          .prepare<[string], Pick<MacroRow, "macro" | "description" | "created_at">>(
            "SELECT macro, description, created_at FROM template_macros WHERE template_name = ?",
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
        `INSERT INTO template_macros (template_name, macro, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(template_name, macro) DO UPDATE SET
           description = excluded.description,
           updated_at = excluded.updated_at`,
      );
      for (const macro of detected) {
        const current = existing.get(macro);
        const macroDescription = provided === undefined
          ? current?.description ?? ""
          : provided.get(macro) ?? "";
        upsert.run(name, macro, macroDescription, current?.created_at ?? now, now);
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
    const stored = this.allStoredDescriptions();
    return this.db
      .prepare<[], TemplateRow>(
        "SELECT name, description, body_json, created_at, updated_at FROM templates ORDER BY name",
      )
      .all()
      .map((row) => this.withMacros(row, stored.get(row.name) ?? new Map()));
  }

  private withMacros(
    row: TemplateRow,
    stored: Map<string, string>,
  ): Template {
    return {
      ...row,
      macros: detectMacros(row.body_json).map((name) => ({
        name,
        description: stored.get(name) ?? "",
      })),
    };
  }

  private storedDescriptions(name: string): Map<string, string> {
    return new Map(
      this.db
        .prepare<[string], Pick<MacroRow, "macro" | "description">>(
          "SELECT macro, description FROM template_macros WHERE template_name = ?",
        )
        .all(name)
        .map((row) => [row.macro, row.description] as const),
    );
  }

  private allStoredDescriptions(): Map<string, Map<string, string>> {
    const grouped = new Map<string, Map<string, string>>();
    for (const row of this.db
      .prepare<[], Pick<MacroRow, "template_name" | "macro" | "description">>(
        "SELECT template_name, macro, description FROM template_macros",
      )
      .all()) {
      const current = grouped.get(row.template_name) ?? new Map<string, string>();
      current.set(row.macro, row.description);
      grouped.set(row.template_name, current);
    }
    return grouped;
  }
}
