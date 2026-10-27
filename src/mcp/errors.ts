import { JevApiError, jevErrorHint } from "../errors.js";

/**
 * MCP tool error with a stable code. It becomes an MCP result with
 * `isError: true` carrying `code`, `message`, `hint` and `requestId` when applicable.
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

/** Stable code for an arbitrary error thrown by a tool handler. */
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

/** Actionable hint when available; never includes the API key. */
export function errorHintOf(error: unknown): string | undefined {
  if (error instanceof McpToolError) {
    return error.hint;
  }
  if (error instanceof JevApiError) {
    return jevErrorHint(error);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("missing API key")) {
    return (
      "Configure the API key with 'jev config set api_key', --key or the " +
      "OPENCODE_API_KEY/JEV_API_KEY variable. Without it, read tools keep working."
    );
  }
  return undefined;
}

/** `requestId` associated with the error, when the handler provides it. */
export function errorRequestIdOf(error: unknown): number | null | undefined {
  return error instanceof McpToolError ? error.requestId : undefined;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
