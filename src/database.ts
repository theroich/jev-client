import Database from "better-sqlite3";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SCHEMA_VERSION = 1;

export type SqliteDatabase = Database.Database;

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
];

/** Ruta por defecto dentro del directorio personal que determine el SO. */
export function defaultDatabasePath(): string {
  return join(homedir(), ".jev-client", "db", "jev.db");
}

/** Precedencia de la ruta: --db > JEV_DB > ruta por defecto. */
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
 * Abre la base, crea sus directorios y aplica las migraciones pendientes.
 * El directorio nuevo se crea con 0700 y la base queda con 0600.
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

  const db = new Database(path);
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

/** Migra cada versión en una transacción; reaplicarla no cambia los datos. */
export function migrateDatabase(db: SqliteDatabase): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `la base usa el esquema ${current}, pero esta versión solo admite hasta ${SCHEMA_VERSION}`,
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
