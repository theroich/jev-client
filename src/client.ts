import { JevApiError } from "./errors.js";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
} from "./config.js";
import { IMAGES_HEADER, orphanAssetRefs, validateAssets } from "./assets.js";
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
  /** Cancels the request in progress and any wait between retries. */
  signal?: AbortSignal;
}

export interface ClientOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  /** Timeout of each HTTP attempt. Default: 30 s. */
  timeoutMs?: number;
  /** Retries on 429/5xx and network errors. Default: 2. */
  maxRetries?: number;
  /** Base exponential backoff. Default: 500 ms. */
  backoffMs?: number;
  /** Cap for Retry-After and backoff. Default: 10 s. */
  maxRetryDelayMs?: number;
  /** Injectable fetch (tests). Default: global fetch. */
  fetch?: FetchLike;
  /** Extra headers merged with the defaults (cannot override `Authorization`). */
  extraHeaders?: Record<string, string>;
  /**
   * Adds `TypeSafe-Danger-Zone-Images: true` when the request carries `assets`.
   * Default: true. Can be disabled to check the API 400.
   */
  imagesHeader?: boolean;
  /** Hook that receives the log of every run (successful or not). */
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
  private readonly extraHeaders: Record<string, string>;
  private readonly imagesHeader: boolean;
  private readonly onRequest?: (log: RequestLog) => void;

  constructor(options: ClientOptions) {
    if (!options.apiKey) {
      throw new Error("missing API key");
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
    this.extraHeaders = options.extraHeaders ?? {};
    this.imagesHeader = options.imagesHeader ?? true;
    this.onRequest = options.onRequest;
  }

  /** Evaluates `state` against `questions` with the client's model. */
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

  /** Sends an already built request. If `model` is empty, uses the client's. */
  async run(
    request: JevRequest,
    options: RunOptions = {},
  ): Promise<JevResponse> {
    throwIfAborted(options.signal);
    const questions = request.questions ?? {};
    if (Object.keys(questions).length === 0) {
      throw new Error("the request needs at least one question");
    }

    const assets = request.assets;
    const hasAssets = assets !== undefined && Object.keys(assets).length > 0;
    if (hasAssets) {
      validateAssets(assets);
      const orphan = orphanAssetRefs(request);
      if (orphan.length > 0) {
        throw new Error(
          `assets are not referenced in state/questions: ${orphan.join(", ")} ` +
            "(the API would return 400)",
        );
      }
    }

    const model = request.model || this.model;
    const bodyObject: Record<string, unknown> = { model, state: request.state, questions };
    if (hasAssets) {
      bodyObject.assets = assets;
    }
    const body = JSON.stringify(bodyObject);

    const headers = this.buildHeaders(hasAssets);

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
      let lastError: unknown = new Error("the request was not attempted");

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
            headers,
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

        // A quota 429 carries a Retry-After of hours: retrying makes no sense.
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
        requestHeaders: headers,
        responseBody,
        inputTokens,
        outputTokens,
        cost,
        errorCode,
        errorMessage,
      });
    }
  }

  private buildHeaders(hasAssets: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    for (const [key, value] of Object.entries(this.extraHeaders)) {
      if (key.toLowerCase() === "authorization") {
        continue;
      }
      headers[key] = value;
    }
    if (hasAssets && this.imagesHeader) {
      headers[IMAGES_HEADER] = "true";
    }
    return headers;
  }

  private networkError(error: unknown): Error {
    if (error instanceof Error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        return new Error(`timeout after ${this.timeoutMs} ms`);
      }
      return new Error(
        `could not connect to ${this.endpoint}: ${error.message}`,
      );
    }
    return new Error(`could not connect to ${this.endpoint}: ${String(error)}`);
  }

  /**
   * Retry-After is honored but capped so a server asking for hours does not
   * block the process.
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

/** Extracts tokens/cost from the raw body without forcing default values. */
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
    // The body is not JSON: no tokens or cost.
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
    throw new Error("invalid API response: not JSON");
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
 * Builds a readable error. Understands the OpenCode format
 * ({"error": {...}}) and the TypeSafe/FastAPI one ({"detail": ...}).
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
    // The body is not JSON: it is used as plain text.
  }

  if (!message) {
    message = body.trim().slice(0, 500) || "unknown error";
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
  const msg = asString(record.msg) ?? "invalid";
  return loc ? `${loc}: ${msg}` : msg;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
