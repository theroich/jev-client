/** Error returned by the Jev API. */
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

/** Hint shared by the CLI, the local API and batch results. */
export function jevErrorHint(error: JevApiError): string | undefined {
  if (error.statusCode === 401 || error.code === "api_key_expired") {
    return (
      "the API key is not valid or has expired. Create a new one at " +
      "https://opencode.ai/console and export it as JEV_API_KEY."
    );
  }
  if (error.code === "FreeUsageLimitError" || error.statusCode === 429) {
    return (
      "jev-1.13-free has a usage limit. Try 'jev-1.13' " +
      "or check https://opencode.ai/go."
    );
  }
  if (
    error.code === "api_usage_error" ||
    error.code === "validation_error" ||
    error.statusCode === 422
  ) {
    return (
      "a 422 is usually a malformed question (missing criteria, " +
      "invalid type) or an upstream failure. Check " +
      "https://docs.typesafe.ai/primitives"
    );
  }
  return undefined;
}
