import { JevApiError } from "./errors.js";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
} from "./config.js";
import type {
  Answer,
  JevRequest,
  JevResponse,
  Question,
  State,
  Usage,
} from "./types.js";

const USER_AGENT = "jev-client-node/1.0";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ClientOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  /** Timeout de cada intento HTTP. Default: 30 s. */
  timeoutMs?: number;
  /** Reintentos ante 429/5xx y errores de red. Default: 2. */
  maxRetries?: number;
  /** Backoff base exponencial. Default: 500 ms. */
  backoffMs?: number;
  /** Tope del Retry-After y del backoff. Default: 10 s. */
  maxRetryDelayMs?: number;
  /** fetch inyectable (tests). Default: fetch global. */
  fetch?: FetchLike;
}

const RETRYABLE_STATUS = new Set([
  408, 409, 425, 429, 500, 502, 503, 504,
]);

export class JevClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: ClientOptions) {
    if (!options.apiKey) {
      throw new Error("falta la API key");
    }
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint || DEFAULT_ENDPOINT;
    this.model = options.model || DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_RETRIES);
    this.backoffMs = Math.max(0, options.backoffMs ?? 500);
    this.maxRetryDelayMs = Math.max(0, options.maxRetryDelayMs ?? 10_000);
    this.fetchImpl =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Evalúa `state` contra `questions` con el modelo del cliente. */
  async systemOne(
    state: State,
    questions: Record<string, Question>,
    options: { model?: string } = {},
  ): Promise<JevResponse> {
    return this.run({ model: options.model ?? "", state, questions });
  }

  /** Envía un request ya construido. Si `model` va vacío, usa el del cliente. */
  async run(request: JevRequest): Promise<JevResponse> {
    const questions = request.questions ?? {};
    if (Object.keys(questions).length === 0) {
      throw new Error("el request necesita al menos una pregunta");
    }

    const body = JSON.stringify({
      model: request.model || this.model,
      state: request.state,
      questions,
    });

    const attempts = this.maxRetries + 1;
    let lastError: unknown = new Error("no se intentó la petición");

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        lastError = this.networkError(error);
        if (attempt === attempts - 1) {
          throw lastError;
        }
        await sleep(this.retryDelay(attempt));
        continue;
      }

      const text = await response.text();

      if (response.ok) {
        return normalizeResponse(text);
      }

      const apiError = parseApiError(response.status, text);
      lastError = apiError;

      // Un 429 de cuota trae Retry-After de horas: no tiene sentido reintentar.
      const retryable =
        RETRYABLE_STATUS.has(response.status) &&
        apiError.code !== "FreeUsageLimitError" &&
        attempt < attempts - 1;

      if (!retryable) {
        throw apiError;
      }

      await sleep(
        this.retryDelay(attempt, response.headers.get("retry-after") ?? undefined),
      );
    }

    throw lastError;
  }

  private networkError(error: unknown): Error {
    if (error instanceof Error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        return new Error(`timeout tras ${this.timeoutMs} ms`);
      }
      return new Error(
        `no se pudo conectar con ${this.endpoint}: ${error.message}`,
      );
    }
    return new Error(`no se pudo conectar con ${this.endpoint}: ${String(error)}`);
  }

  /**
   * Retry-After se respeta pero se capa para que un servidor que pide horas no
   * bloquee el proceso.
   */
  private retryDelay(attempt: number, retryAfter?: string): number {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) {
        return Math.min(
          Math.max(0, seconds * 1000),
          this.maxRetryDelayMs,
        );
      }
    }

    const backoff = this.backoffMs * 2 ** attempt;
    return (
      Math.min(backoff, this.maxRetryDelayMs) + Math.random() * 100
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeResponse(text: string): JevResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("respuesta inválida de la API: no es JSON");
  }

  const record = (parsed ?? {}) as Record<string, unknown>;
  const answers =
    record.answers && typeof record.answers === "object"
      ? (record.answers as Record<string, Answer>)
      : {};
  const usage =
    record.usage && typeof record.usage === "object"
      ? (record.usage as Usage)
      : undefined;

  return {
    model: typeof record.model === "string" ? record.model : "",
    answers,
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      ...usage,
    },
    raw: parsed,
  };
}

/**
 * Construye un error legible. Entiende el formato de OpenCode
 * ({"error": {...}}) y el de TypeSafe/FastAPI ({"detail": ...}).
 */
export function parseApiError(status: number, body: string): JevApiError {
  let message = "";
  let code: string | undefined;

  try {
    const data: unknown = JSON.parse(body);
    if (data && typeof data === "object") {
      const record = data as Record<string, unknown>;

      const error = record.error;
      if (typeof error === "string") {
        message = error;
      } else if (error && typeof error === "object") {
        const payload = error as Record<string, unknown>;
        message = asString(payload.message) ?? asString(payload.type) ?? "";
        code = asString(payload.code) ?? asString(payload.type);
      }

      if (!message) {
        const detail = record.detail;
        if (detail && typeof detail === "object" && !Array.isArray(detail)) {
          const payload = detail as Record<string, unknown>;
          message = asString(payload.message) ?? "";
          code = asString(payload.error_type) ?? asString(payload.code) ?? code;
        } else if (Array.isArray(detail)) {
          message = detail.map(describeValidationItem).join("; ");
          code = "validation_error";
        }
      }
    }
  } catch {
    // El cuerpo no es JSON: se usa como texto plano.
  }

  if (!message) {
    message = body.trim().slice(0, 500) || "error desconocido";
  }

  return new JevApiError(status, code, message, body);
}

function describeValidationItem(item: unknown): string {
  if (!item || typeof item !== "object") {
    return String(item);
  }
  const record = item as Record<string, unknown>;
  const loc = Array.isArray(record.loc)
    ? record.loc.map((part) => String(part)).join(".")
    : "";
  const msg = asString(record.msg) ?? "inválido";
  return loc ? `${loc}: ${msg}` : msg;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
