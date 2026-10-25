/** Error devuelto por la API de Jev. */
export class JevApiError extends Error {
  override readonly name = "JevApiError";

  constructor(
    readonly statusCode: number,
    readonly code: string | undefined,
    message: string,
    readonly body: string,
  ) {
    super(message);
  }
}

/** Pista compartida por CLI, API local y resultados de lotes. */
export function jevErrorHint(error: JevApiError): string | undefined {
  if (error.statusCode === 401 || error.code === "api_key_expired") {
    return (
      "la API key no es válida o ha caducado. Crea una nueva en " +
      "https://opencode.ai/console y expórtala como OPENCODE_API_KEY."
    );
  }
  if (error.code === "FreeUsageLimitError" || error.statusCode === 429) {
    return (
      "jev-1.13-free tiene límite de uso. Prueba con 'jev-1.13' " +
      "o revisa https://opencode.ai/go."
    );
  }
  if (
    error.code === "api_usage_error" ||
    error.code === "validation_error" ||
    error.statusCode === 422
  ) {
    return (
      "un 422 suele ser una pregunta mal formada (falta criteria, " +
      "tipo inválido) o un fallo del upstream. Revisa " +
      "https://docs.typesafe.ai/primitives"
    );
  }
  return undefined;
}
