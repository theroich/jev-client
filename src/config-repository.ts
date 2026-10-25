import type { SqliteDatabase } from "./database.js";

export interface ConfigValues {
  api_url: string;
  api_key: string;
  model: string;
  /** Timeout de cada intento HTTP, en segundos. */
  timeout: string;
  retries: string;
}

export type ConfigKey = keyof ConfigValues;

export interface ConfigEntry<K extends ConfigKey = ConfigKey> {
  key: K;
  value: ConfigValues[K];
}

export const CONFIG_KEYS = [
  "api_url",
  "api_key",
  "model",
  "timeout",
  "retries",
] as const satisfies readonly ConfigKey[];

interface ConfigRow {
  key: string;
  value: string;
}

/** Repositorio tipado sobre la tabla config (clave/valor). */
export class ConfigRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get<K extends ConfigKey>(key: K): ConfigValues[K] | undefined {
    const row = this.db
      .prepare<[ConfigKey], { value: string }>(
        "SELECT value FROM config WHERE key = ?",
      )
      .get(key);
    return row?.value as ConfigValues[K] | undefined;
  }

  set<K extends ConfigKey>(key: K, value: ConfigValues[K]): void {
    validateConfigValue(key, value);
    this.db
      .prepare("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  unset(key: ConfigKey): boolean {
    return this.db.prepare("DELETE FROM config WHERE key = ?").run(key).changes > 0;
  }

  list(): ConfigEntry[] {
    const rows = this.db
      .prepare<[], ConfigRow>("SELECT key, value FROM config ORDER BY key")
      .all();
    return rows
      .filter((row): row is ConfigRow & { key: ConfigKey } => isConfigKey(row.key))
      .map((row) => ({ key: row.key, value: row.value }));
  }
}

export function isConfigKey(value: string): value is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(value);
}

export function validateConfigValue(key: ConfigKey, value: string): void {
  if (value === "" || (key === "model" && value.trim() === "")) {
    throw new Error(`el valor de ${key} no puede estar vacío`);
  }
  if (key === "api_url") {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("api_url debe ser una URL completa con protocolo http(s)");
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.hostname === ""
    ) {
      throw new Error("api_url debe ser una URL completa con protocolo http(s)");
    }
  } else if (key === "timeout") {
    const timeout = Number(value);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error("timeout debe ser un número positivo en segundos");
    }
  } else if (key === "retries") {
    const retries = Number(value);
    if (!Number.isInteger(retries) || retries < 0) {
      throw new Error("retries debe ser un entero >= 0");
    }
  }
}
