import type { SqliteDatabase } from "./database.js";

export interface ConfigValues {
  api_url: string;
  api_key: string;
  model: string;
  /** Timeout of each HTTP attempt, in seconds. */
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

/** Typed repository over the config table (key/value). */
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
    throw new Error(`the value of ${key} cannot be empty`);
  }
  if (key === "api_url") {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("api_url must be a full URL with an http(s) protocol");
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.hostname === ""
    ) {
      throw new Error("api_url must be a full URL with an http(s) protocol");
    }
  } else if (key === "timeout") {
    const timeout = Number(value);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error("timeout must be a positive number of seconds");
    }
  } else if (key === "retries") {
    const retries = Number(value);
    if (!Number.isInteger(retries) || retries < 0) {
      throw new Error("retries must be an integer >= 0");
    }
  }
}
