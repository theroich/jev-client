/** Endpoint de OpenCode para la API System One de TypeSafe. */
export const DEFAULT_ENDPOINT =
  "https://opencode.ai/inference/systemone/v1/systemone";

/** Modelo de pago; usa "jev-1.13-free" para el gratuito. */
export const DEFAULT_MODEL = "jev-1.13";

export interface ConfigFlags {
  key?: string | undefined;
  url?: string | undefined;
  model?: string | undefined;
}

export interface ResolvedConfig {
  apiKey: string;
  endpoint: string;
  model: string;
}

/**
 * Precedencia: flag > variable de entorno > valor por defecto.
 * Las cadenas vacías se tratan como "no definido".
 */
export function resolveConfig(
  flags: ConfigFlags = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  return {
    apiKey: firstNonEmpty(flags.key, env.OPENCODE_API_KEY, env.JEV_API_KEY),
    endpoint:
      firstNonEmpty(flags.url, env.JEV_URL) || DEFAULT_ENDPOINT,
    model: firstNonEmpty(flags.model, env.JEV_MODEL) || DEFAULT_MODEL,
  };
}

/**
 * Precedencia: flag > entorno > modelo del request > por defecto.
 */
export function resolveModel(
  flagModel: string | undefined,
  requestModel: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    firstNonEmpty(flagModel, env.JEV_MODEL, requestModel) || DEFAULT_MODEL
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
