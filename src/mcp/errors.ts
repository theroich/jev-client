import { JevApiError, jevErrorHint } from "../errors.js";

/**
 * Error de tool MCP con un código estable. Se convierte en un resultado MCP
 * `isError: true` con `code`, `message`, `hint` y `requestId` cuando aplica.
 */
export class McpToolError extends Error {
  override readonly name = "McpToolError";

  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly requestId?: number | null,
  ) {
    super(message);
  }
}

/** Código estable para un error arbitrario lanzado por un handler de tool. */
export function errorCodeOf(error: unknown): string {
  if (error instanceof McpToolError) {
    return error.code;
  }
  if (error instanceof JevApiError) {
    return error.code ?? "api_error";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "aborted";
  }
  return "execution_error";
}

/** Pista accionable cuando la hay; nunca incluye la API key. */
export function errorHintOf(error: unknown): string | undefined {
  if (error instanceof McpToolError) {
    return error.hint;
  }
  if (error instanceof JevApiError) {
    return jevErrorHint(error);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("falta la API key")) {
    return (
      "Configura la API key con 'jev config set api_key', --key o la variable " +
      "OPENCODE_API_KEY/JEV_API_KEY. Sin ella, las tools de lectura siguen funcionando."
    );
  }
  return undefined;
}

/** `requestId` asociado al error, cuando el handler lo aporta. */
export function errorRequestIdOf(error: unknown): number | null | undefined {
  return error instanceof McpToolError ? error.requestId : undefined;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
