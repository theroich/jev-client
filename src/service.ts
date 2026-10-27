import { randomUUID } from "node:crypto";

import { JevClient, type FetchLike } from "./client.js";
import {
  resolveConfig,
  resolveModel,
  type ConfigFlags,
  type ResolvedConfig,
  type StoredConfig,
} from "./config.js";
import { ConfigRepository } from "./config-repository.js";
import {
  openDatabase,
  resolveDatabasePath,
  type SqliteDatabase,
} from "./database.js";
import { JevApiError, jevErrorHint } from "./errors.js";
import { RequestRepository } from "./request-repository.js";
import { TemplateRepository } from "./template-repository.js";
import {
  resolveTemplateBody,
  type TemplateContext,
} from "./template.js";
import type {
  ImageAsset,
  JevRequest,
  JevResponse,
  Question,
  RequestLog,
  RequestSource,
} from "./types.js";

export const MAX_CONCURRENCY = 10;

export const DEMO_STATE =
  "Our checkout has been down for 30 minutes and we lose sales every minute. " +
  "We have had no response from support for two days. We need a solution now.";

/** Returns fresh questions so the consumer can modify them. */
export function demoQuestions(): Record<string, Question> {
  return {
    is_urgent: {
      type: "noul",
      instructions: "Does the message convey urgency or time pressure?",
    },
    team: {
      type: "choice",
      instructions: "Which team should handle the incident?",
      criteria: {
        billing: "Billing, invoices or payments",
        infra: "Outages, 500 errors or platform issues",
        sales: "Pricing or sales questions",
      },
    },
    frustration: {
      type: "score",
      instructions: "How frustrated is the customer?",
      criteria: ["Calm", "Annoyed but polite", "Very angry"],
    },
  };
}

export interface JevServiceOptions {
  /** Session flags; they have the same precedence as in the CLI. */
  flags?: ConfigFlags;
  /** Injectable environment. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Equivalent to --db; if missing, JEV_DB or the default path is used. */
  dbPath?: string;
  /** Injectable fetch (tests). */
  fetch?: FetchLike;
}

export interface ExecutionOptions {
  /** Model for this run; a session flag takes precedence. */
  model?: string;
  /** Saves the request in requests. Default: true. */
  save?: boolean;
  /** Run source, for auditing the history. Default: 'cli'. */
  source?: RequestSource;
  /** Associated template name; stored in `requests.template_name`. */
  templateName?: string;
  /** Sends the images header when there are `assets`. Default: true. */
  imagesHeader?: boolean;
  signal?: AbortSignal;
}

export interface ExecutionResult {
  /** Effective request, with the model already resolved. */
  request: JevRequest;
  response: JevResponse;
  /** SQLite requests id, or null when save is false. */
  requestId: number | null;
  statusCode: number | null;
  durationMs: number;
  /** Actual usage reported by the API; null means not reported. */
  usage: BatchUsage;
}

export interface BatchUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
}

export type BatchItemStatus = "ok" | "error" | "skipped";
export type BatchSkipReason = "fail-fast" | "cancelled";

export interface BatchItemResult {
  index: number;
  status: BatchItemStatus;
  ok: boolean;
  requestId: number | null;
  durationMs: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  error?: string;
  errorCode?: string;
  errorHint?: string;
  raw?: unknown;
  skipReason?: BatchSkipReason;
}

export interface BatchSummary {
  total: number;
  processed: number;
  skipped: number;
  ok: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  costUnknown: number;
}

export type BatchEvent =
  | {
      type: "batch.start";
      batchId: string;
      total: number;
      concurrency: number;
    }
  | { type: "item.start"; index: number }
  | {
      type: "item.finish";
      index: number;
      ok: boolean;
      requestId: number | null;
      model: string | null;
      usage: BatchUsage | null;
      durationMs: number;
      error: { code: string; message: string; hint?: string } | null;
    }
  | { type: "item.skip"; index: number; reason: BatchSkipReason }
  | { type: "batch.finish"; summary: BatchSummary };

export interface BatchExecutionOptions extends ExecutionOptions {
  /** Simultaneous workers, from 1 to 10. Default: 1. */
  concurrency?: number;
  /** Does not schedule new items after the first error. Default: false. */
  failFast?: boolean;
  /** Images provided at run time, attached to each request. */
  assets?: Record<string, ImageAsset>;
  onEvent?: (event: BatchEvent) => void;
}

export interface BatchResult {
  batchId: string;
  templateName: string;
  items: BatchItemResult[];
  summary: BatchSummary;
  cancelled: boolean;
}

interface PreparedExecution {
  config: ResolvedConfig;
  stored: StoredConfig;
}

interface RequestMetadata {
  templateName?: string;
  batchId?: string;
}

interface RequestCapture {
  requestId: number | null;
  log?: RequestLog;
}

/**
 * Runs ask/demo/batch with the CLI's configuration and SQLite database.
 * The connection is reused until close() is called.
 */
export class JevService {
  readonly databasePath: string;

  /** Single connection also reused by the console repositories. */
  readonly db: SqliteDatabase;
  private readonly flags: ConfigFlags;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly requests: RequestRepository;

  constructor(options: JevServiceOptions = {}) {
    this.flags = options.flags ?? {};
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetch;
    this.databasePath = resolveDatabasePath(options.dbPath, this.env);
    this.db = openDatabase(this.databasePath);
    this.requests = new RequestRepository(this.db);
  }

  close(): void {
    this.db.close();
  }

  async ask(
    request: JevRequest,
    options: ExecutionOptions = {},
  ): Promise<ExecutionResult> {
    const prepared = this.prepare();
    const resolved = this.withModel(request, options, prepared.stored);
    return this.executeRequest(resolved, options, prepared.config, {
      templateName: options.templateName,
    });
  }

  async demo(options: ExecutionOptions = {}): Promise<ExecutionResult> {
    return this.ask(
      { model: "", state: DEMO_STATE, questions: demoQuestions() },
      options,
    );
  }

  async batch(
    templateName: string,
    contexts: readonly unknown[],
    options: BatchExecutionOptions = {},
  ): Promise<BatchResult> {
    const concurrency = options.concurrency ?? 1;
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > MAX_CONCURRENCY
    ) {
      throw new Error(
        `concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`,
      );
    }
    if (!Array.isArray(contexts)) {
      throw new Error("contexts must be an array of context maps");
    }
    if (templateName.trim() === "") {
      throw new Error("the template name cannot be empty");
    }

    const template = new TemplateRepository(this.db).get(templateName);
    if (template === undefined) {
      throw new Error(`template not found: ${templateName}`);
    }
    const prepared = this.prepare();
    const batchId = randomUUID();
    const items: Array<BatchItemResult | undefined> = Array.from({
      length: contexts.length,
    });
    let cursor = 0;
    let stopReason: BatchSkipReason | undefined;

    options.onEvent?.({
      type: "batch.start",
      batchId,
      total: contexts.length,
      concurrency,
    });

    const runItem = async (index: number): Promise<BatchItemResult> => {
      const startedAt = Date.now();
      const rawContext = contexts[index];
      if (
        !rawContext ||
        typeof rawContext !== "object" ||
        Array.isArray(rawContext)
      ) {
        return {
          index,
          status: "error",
          ok: false,
          requestId: null,
          durationMs: Date.now() - startedAt,
          error: `context #${index + 1} is not an object`,
          errorCode: "invalid_context",
        };
      }

      let request: JevRequest;
      try {
        request = resolveTemplateBody(
          template.body_json,
          rawContext as TemplateContext,
        );
        request = this.withModel(request, options, prepared.stored);
        if (options.assets !== undefined && Object.keys(options.assets).length > 0) {
          request = { ...request, assets: options.assets };
        }
      } catch (error) {
        return {
          index,
          status: "error",
          ok: false,
          requestId: null,
          durationMs: Date.now() - startedAt,
          error: messageOf(error),
          errorCode: "invalid_request",
        };
      }

      const capture: RequestCapture = { requestId: null };
      try {
        const result = await this.executeRequest(
          request,
          options,
          prepared.config,
          { templateName, batchId },
          capture,
        );
        return {
          index,
          status: "ok",
          ok: true,
          requestId: result.requestId,
          model: result.response.model,
          inputTokens: result.usage.inputTokens ?? undefined,
          outputTokens: result.usage.outputTokens ?? undefined,
          cost: result.usage.cost ?? undefined,
          raw: result.response.raw,
          durationMs: result.durationMs,
        };
      } catch (error) {
        return {
          index,
          status: "error",
          ok: false,
          requestId: capture.requestId,
          model: capture.log?.model,
          durationMs:
            capture.log?.durationMs ?? Math.max(0, Date.now() - startedAt),
          error: messageOf(error),
          errorCode: errorCodeOf(error),
          errorHint:
            error instanceof JevApiError ? jevErrorHint(error) : undefined,
        };
      }
    };

    const worker = async (): Promise<void> => {
      while (stopReason === undefined) {
        if (options.signal?.aborted) {
          stopReason = "cancelled";
          break;
        }
        const index = cursor;
        if (index >= contexts.length) {
          return;
        }
        cursor += 1;
        options.onEvent?.({ type: "item.start", index });
        const item = await runItem(index);
        items[index] = item;
        options.onEvent?.(itemFinishEvent(item));
        if (options.signal?.aborted) {
          stopReason = "cancelled";
        } else if (!item.ok && options.failFast === true) {
          stopReason = "fail-fast";
        }
      }
    };

    const workers = Math.min(concurrency, contexts.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));

    for (let index = 0; index < items.length; index += 1) {
      if (items[index] !== undefined) {
        continue;
      }
      const reason = stopReason ?? "fail-fast";
      const skipped: BatchItemResult = {
        index,
        status: "skipped",
        ok: false,
        requestId: null,
        durationMs: 0,
        skipReason: reason,
      };
      items[index] = skipped;
      options.onEvent?.({ type: "item.skip", index, reason });
    }

    const completedItems = items.map((item) => {
      if (item === undefined) {
        throw new Error("incomplete internal batch state");
      }
      return item;
    });
    const summary = summarize(completedItems);
    options.onEvent?.({ type: "batch.finish", summary });
    return {
      batchId,
      templateName,
      items: completedItems,
      summary,
      cancelled: stopReason === "cancelled",
    };
  }

  private prepare(): PreparedExecution {
    const stored: StoredConfig = {};
    for (const { key, value } of new ConfigRepository(this.db).list()) {
      stored[key] = value;
    }
    const config = resolveConfig(this.flags, this.env, stored);
    if (!config.apiKey) {
      throw new Error(
        "missing API key: use --key, set OPENCODE_API_KEY (or JEV_API_KEY) " +
          "or save api_key with 'jev config set'",
      );
    }
    return { config, stored };
  }

  private withModel(
    request: JevRequest,
    options: ExecutionOptions,
    stored: StoredConfig,
  ): JevRequest {
    return {
      ...request,
      model: resolveModel(
        this.flags.model || options.model,
        request.model,
        this.env,
        stored.model,
      ),
    };
  }

  private async executeRequest(
    request: JevRequest,
    options: ExecutionOptions,
    config: ResolvedConfig,
    metadata: RequestMetadata = {},
    capture: RequestCapture = { requestId: null },
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const client = new JevClient({
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      model: config.model,
      timeoutMs: config.timeoutMs,
      maxRetries: config.retries,
      imagesHeader: options.imagesHeader,
      fetch: this.fetchImpl,
      onRequest: (log) => {
        if (metadata.templateName !== undefined) {
          log.templateName = metadata.templateName;
        }
        if (metadata.batchId !== undefined) {
          log.batchId = metadata.batchId;
        }
        log.source = options.source ?? "cli";
        capture.log = log;
        if (options.save !== false) {
          capture.requestId = this.requests.insert(log);
        }
      },
    });

    const response = await client.run(request, { signal: options.signal });
    return {
      request,
      response,
      requestId: capture.requestId,
      statusCode: capture.log?.statusCode ?? null,
      durationMs: capture.log?.durationMs ?? Date.now() - startedAt,
      usage: {
        inputTokens: capture.log?.inputTokens ?? null,
        outputTokens: capture.log?.outputTokens ?? null,
        cost: capture.log?.cost ?? null,
      },
    };
  }
}

function itemFinishEvent(item: BatchItemResult): BatchEvent {
  return {
    type: "item.finish",
    index: item.index,
    ok: item.ok,
    requestId: item.requestId,
    model: item.model ?? null,
    usage:
      item.status === "ok"
        ? {
            inputTokens: item.inputTokens ?? null,
            outputTokens: item.outputTokens ?? null,
            cost: item.cost ?? null,
          }
        : null,
    durationMs: item.durationMs,
    error:
      item.status === "error"
        ? {
            code: item.errorCode ?? "execution_error",
            message: item.error ?? "unknown",
            hint: item.errorHint,
          }
        : null,
  };
}

function summarize(items: BatchItemResult[]): BatchSummary {
  const processed = items.filter((item) => item.status !== "skipped");
  const ok = processed.filter((item) => item.ok).length;
  return {
    total: items.length,
    processed: processed.length,
    skipped: items.length - processed.length,
    ok,
    errors: processed.length - ok,
    inputTokens: sumDefined(processed.map((item) => item.inputTokens)),
    outputTokens: sumDefined(processed.map((item) => item.outputTokens)),
    cost: sumDefined(processed.map((item) => item.cost)),
    costUnknown: processed.filter(
      (item) => item.ok && item.cost === undefined,
    ).length,
  };
}

function sumDefined(values: Array<number | undefined>): number {
  let total = 0;
  for (const value of values) {
    if (value !== undefined) {
      total += value;
    }
  }
  return total;
}

function errorCodeOf(error: unknown): string {
  if (error instanceof JevApiError) {
    return error.code ?? "api_error";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "aborted";
  }
  return "execution_error";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
