import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { openSqlite } from "./sqlite.js";
import type { SqliteDatabase } from "./sqlite.js";

export type { SqliteDatabase } from "./sqlite.js";

export const SCHEMA_VERSION = 6;

interface Migration {
  version: number;
  up(db: SqliteDatabase): void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS templates (
          name TEXT PRIMARY KEY,
          description TEXT NOT NULL DEFAULT '',
          body_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
    },
  },
  {
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          duration_ms INTEGER,
          endpoint TEXT,
          model TEXT,
          status_code INTEGER,
          ok INTEGER NOT NULL,
          request_json TEXT,
          response_json TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cost REAL,
          error_code TEXT,
          error_message TEXT,
          template_name TEXT,
          batch_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests (created_at);
        CREATE INDEX IF NOT EXISTS idx_requests_model ON requests (model);
        CREATE INDEX IF NOT EXISTS idx_requests_template_name ON requests (template_name);
      `);
    },
  },
  {
    version: 4,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS template_macros (
          template_name TEXT NOT NULL,
          macro TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (template_name, macro),
          FOREIGN KEY (template_name) REFERENCES templates (name)
            ON DELETE CASCADE ON UPDATE CASCADE
        )
      `);
    },
  },
  {
    version: 5,
    up(db) {
      // `ALTER TABLE ... ADD COLUMN` does not support IF NOT EXISTS: the
      // catalog is queried so reapplying the migration stays harmless.
      const columns = db
        .prepare<[], { name: string }>("PRAGMA table_info(template_macros)")
        .all();
      if (!columns.some((column) => column.name === "schema_json")) {
        db.exec("ALTER TABLE template_macros ADD COLUMN schema_json TEXT");
      }
    },
  },
  {
    version: 6,
    up(db) {
      // The requests table is created by migration v3; in hand-made test
      // databases it may not exist, so it is checked before altering.
      const table = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'requests'",
        )
        .get();
      if (table === undefined) {
        return;
      }
      // `ALTER TABLE ... ADD COLUMN` does not support IF NOT EXISTS: the
      // catalog is queried so reapplying the migration stays harmless.
      const columns = db
        .prepare<[], { name: string }>("PRAGMA table_info(requests)")
        .all();
      if (!columns.some((column) => column.name === "source")) {
        db.exec(
          "ALTER TABLE requests ADD COLUMN source TEXT NOT NULL DEFAULT 'cli'",
        );
      }
    },
  },
];

/** Default path inside the home directory determined by the OS. */
export function defaultDatabasePath(): string {
  return join(homedir(), ".jev-client", "db", "jev.db");
}

/** Path precedence: --db > JEV_DB > default path. */
export function resolveDatabasePath(
  flag?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = flag || env.JEV_DB;
  if (configured === ":memory:") {
    return configured;
  }
  return configured ? resolve(configured) : defaultDatabasePath();
}

/**
 * Opens the database, creates its directories and applies pending migrations.
 * A new directory is created with 0700 and the database ends up with 0600.
 */
export function openDatabase(path: string): SqliteDatabase {
  if (path !== ":memory:") {
    const directory = dirname(path);
    const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (created !== undefined) {
      chmodSync(directory, 0o700);
    }
    const descriptor = openSync(path, "a+", 0o600);
    closeSync(descriptor);
    chmodSync(path, 0o600);
  }

  const db = openSqlite(path);
  try {
    db.pragma("foreign_keys = ON");
    migrateDatabase(db);
    if (path !== ":memory:") {
      chmodSync(path, 0o600);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Migrates each version in a transaction; reapplying it does not change the data. */
export function migrateDatabase(db: SqliteDatabase): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `the database uses schema ${current}, but this version only supports up to ${SCHEMA_VERSION}`,
    );
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
