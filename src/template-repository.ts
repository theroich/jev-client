import type { SqliteDatabase } from "./database.js";

export interface Template {
  name: string;
  description: string;
  body_json: string;
  created_at: string;
  updated_at: string;
}

interface TemplateRow {
  name: string;
  description: string;
  body_json: string;
  created_at: string;
  updated_at: string;
}

/** Repositorio tipado sobre la tabla templates. */
export class TemplateRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(name: string): Template | undefined {
    return this.db
      .prepare<[string], TemplateRow>(
        "SELECT name, description, body_json, created_at, updated_at FROM templates WHERE name = ?",
      )
      .get(name);
  }

  /** Inserta o reemplaza una plantilla; conserva `created_at` al actualizar. */
  save(name: string, description: string, body_json: string): void {
    const now = new Date().toISOString();
    const created_at = this.get(name)?.created_at ?? now;
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
  }

  remove(name: string): boolean {
    return (
      this.db.prepare("DELETE FROM templates WHERE name = ?").run(name).changes >
      0
    );
  }

  list(): Template[] {
    return this.db
      .prepare<[], TemplateRow>(
        "SELECT name, description, body_json, created_at, updated_at FROM templates ORDER BY name",
      )
      .all();
  }
}
