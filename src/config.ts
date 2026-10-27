import type { ConfigValues } from "./config-repository.js";

/** OpenCode endpoint for the TypeSafe System One API. */
export const DEFAULT_ENDPOINT =
  "https://opencode.ai/inference/systemone/v1/systemone";

/** Paid model; use "jev-1.13-free" for the free one. */
export const DEFAULT_MODEL = "jev-1.13";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_RETRIES = 2;

export interface ConfigFlags {
  key?: string | undefined;
  url?: string | undefined;
  model?: string | undefined;
  timeoutMs?: number | undefined;
  retries?: number | undefined;
}

export type StoredConfig = Partial<ConfigValues>;

export interface ResolvedConfig {
  apiKey: string;
  endpoint: string;
  model: string;
  timeoutMs: number;
  retries: number;
}

/**
 * Precedence: flag > environment variable > database > default value.
 * Empty strings are treated as "undefined".
 */
export function resolveConfig(
  flags: ConfigFlags = {},
  env: NodeJS.ProcessEnv = process.env,
  stored: StoredConfig = {},
): ResolvedConfig {
  const storedTimeout = stored.timeout ? Number(stored.timeout) : undefined;
  const timeoutMs =
    flags.timeoutMs ??
    (storedTimeout === undefined ? undefined : Math.round(storedTimeout * 1000)) ??
    DEFAULT_TIMEOUT_MS;
  const retries =
    flags.retries ??
    (stored.retries ? Number(stored.retries) : undefined) ??
    DEFAULT_RETRIES;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeout must be a positive number of seconds");
  }
  if (!Number.isInteger(retries) || retries < 0) {
    throw new Error("retries must be an integer >= 0");
  }

  return {
    apiKey: firstNonEmpty(
      flags.key,
      env.OPENCODE_API_KEY,
      env.JEV_API_KEY,
      stored.api_key,
    ),
    endpoint:
      firstNonEmpty(flags.url, env.JEV_URL, stored.api_url) || DEFAULT_ENDPOINT,
    model:
      firstNonEmpty(flags.model, env.JEV_MODEL, stored.model) || DEFAULT_MODEL,
    timeoutMs,
    retries,
  };
}

/**
 * Precedence: flag > environment > request model > database > default.
 * The explicit request model is preserved for compatibility.
 */
export function resolveModel(
  flagModel: string | undefined,
  requestModel: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  storedModel?: string,
): string {
  return (
    firstNonEmpty(flagModel, env.JEV_MODEL, requestModel, storedModel) ||
    DEFAULT_MODEL
  );
}

export function firstNonEmpty(
  ...values: Array<string | undefined>
): string {
  for (const value of values) {
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return "";
}
