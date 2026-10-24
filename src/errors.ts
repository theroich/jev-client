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
