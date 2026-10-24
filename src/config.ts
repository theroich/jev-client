import type { ConfigValues } from "./config-repository.js";

/** Endpoint de OpenCode para la API System One de TypeSafe. */
export const DEFAULT_ENDPOINT =
  "https://opencode.ai/inference/systemone/v1/systemone";

/** Modelo de pago; usa "jev-1.13-free" para el gratuito. */
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
 * Precedencia: flag > variable de entorno > base de datos > valor por defecto.
 * Las cadenas vacías se tratan como "no definido".
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
    throw new Error("timeout debe ser un número positivo en segundos");
  }
  if (!Number.isInteger(retries) || retries < 0) {
    throw new Error("retries debe ser un entero >= 0");
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
 * Precedencia: flag > entorno > modelo del request > base de datos > defecto.
 * El modelo explícito del request se conserva por compatibilidad.
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
