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
  RequestLog,
  State,
  Usage,
} from "./types.js";

const USER_AGENT = "jev-client-node/1.0";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface RunOptions {
  /** Cancela la petición en curso y cualquier espera entre reintentos. */
  signal?: AbortSignal;
}

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
  /** Hook que recibe el registro de cada ejecución (con o sin éxito). */
  onRequest?: (log: RequestLog) => void;
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
  private readonly onRequest?: (log: RequestLog) => void;

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
    this.onRequest = options.onRequest;
  }

  /** Evalúa `state` contra `questions` con el modelo del cliente. */
  async systemOne(
    state: State,
    questions: Record<string, Question>,
    options: { model?: string; signal?: AbortSignal } = {},
  ): Promise<JevResponse> {
    return this.run(
      { model: options.model ?? "", state, questions },
      { signal: options.signal },
    );
  }

  /** Envía un request ya construido. Si `model` va vacío, usa el del cliente. */
  async run(
    request: JevRequest,
    options: RunOptions = {},
  ): Promise<JevResponse> {
    throwIfAborted(options.signal);
    const questions = request.questions ?? {};
    if (Object.keys(questions).length === 0) {
      throw new Error("el request necesita al menos una pregunta");
    }

    const model = request.model || this.model;
    const bodyObject = { model, state: request.state, questions };
    const body = JSON.stringify(bodyObject);

    const startedAt = new Date();
    let statusCode: number | null = null;
    let responseBody: string | null = null;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cost: number | undefined;
    let errorCode: string | undefined;
    let errorMessage: string | undefined;
    let ok = false;

    try {
      const attempts = this.maxRetries + 1;
      let lastError: unknown = new Error("no se intentó la petición");

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        throwIfAborted(options.signal);
        const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
        const signal = options.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal;
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
            signal,
          });
        } catch (error) {
          if (options.signal?.aborted) {
            throwIfAborted(options.signal);
          }
          lastError = this.networkError(error);
          if (attempt === attempts - 1) {
            throw lastError;
          }
          await sleep(this.retryDelay(attempt), options.signal);
          continue;
        }

        throwIfAborted(options.signal);
        const text = await response.text();
        throwIfAborted(options.signal);
        statusCode = response.status;
        responseBody = text;

        if (response.ok) {
          const result = normalizeResponse(text);
          const usage = usageFromText(text);
          inputTokens = usage.inputTokens;
          outputTokens = usage.outputTokens;
          cost = usage.cost;
          ok = true;
          return result;
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
          options.signal,
        );
      }

      throw lastError;
    } catch (error) {
      errorMessage = messageOf(error);
      if (error instanceof JevApiError) {
        errorCode = error.code;
        statusCode = error.statusCode;
        responseBody = responseBody ?? error.body;
      }
      throw error;
    } finally {
      const finishedAt = new Date();
      this.onRequest?.({
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        endpoint: this.endpoint,
        model,
        statusCode,
        ok,
        requestBody: bodyObject,
        responseBody,
        inputTokens,
        outputTokens,
        cost,
        errorCode,
        errorMessage,
      });
    }
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

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal) {
        reject(abortReason(signal));
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Extrae tokens/coste del cuerpo crudo sin forzar valores por defecto. */
function usageFromText(
  text: string,
): { inputTokens?: number; outputTokens?: number; cost?: number } {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const usage = parsed.usage;
    if (usage && typeof usage === "object") {
      const record = usage as Record<string, unknown>;
      return {
        inputTokens: asNumber(record.input_tokens),
        outputTokens: asNumber(record.output_tokens),
        cost: asNumber(record.cost),
      };
    }
  } catch {
    // El cuerpo no es JSON: no hay tokens ni coste.
  }
  return {};
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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
