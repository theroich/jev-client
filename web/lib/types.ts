import type {
  Answer,
  JevRequest,
  JevResponse,
  Question,
  RequestLog,
  State,
} from "../../dist/src/types.js";

export type { Answer, JevRequest, JevResponse, Question, RequestLog, State };

export type ConfigKey = "api_url" | "api_key" | "model" | "timeout" | "retries";
export type ConfigSource = "flag" | "env" | "sqlite" | "default";

export interface ConfigEntryDto {
  key: ConfigKey;
  value: string | number | null;
  masked: string;
  source: ConfigSource;
  editable: boolean;
}

export interface DatabaseInfo {
  path: string;
  schemaVersion: number;
  directoryMode: string;
  fileMode: string;
  tables: string[];
}

export interface ConfigSnapshot {
  entries: ConfigEntryDto[];
  database: DatabaseInfo;
}

export interface RequestSummary {
  id: number;
  createdAt: string;
  statusCode: number | null;
  ok: boolean;
  model: string | null;
  templateName: string | null;
  batchId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  durationMs: number | null;
}

export interface HistoryDetail extends RequestSummary {
  startedAt: string | null;
  finishedAt: string | null;
  endpoint: string | null;
  request: unknown;
  response: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  exportRecord: Record<string, unknown>;
}

export interface Overview {
  version: string;
  schemaVersion: number;
  dbPath: string;
  listen: { host: string; port: number };
  launchCommand: string;
  provider: {
    endpoint: string;
    model: string;
    apiKeyMasked: string;
    apiKeySource: ConfigSource;
    timeoutMs: number;
    retries: number;
    status: "unknown" | "ok" | "error";
  };
  stats: {
    total: number;
    window: number;
    ok: number;
    errors: number;
    successRate: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    costUnknown: number;
  };
  recent: RequestSummary[];
}

export interface ShellData {
  version: string;
  schemaVersion: number;
  dbPath: string;
  listen: { host: string; port: number };
  provider: { model: string; status: "unknown" | "ok" | "error" };
  counts: { templates: number; history: number };
}

export interface ExecutionResult {
  request: JevRequest;
  response: JevResponse;
  requestId: number | null;
  statusCode: number | null;
  durationMs: number;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cost: number | null;
  };
  save: boolean;
  demo: boolean;
}

export interface TemplateSummary {
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  macros: string[];
}

export interface TemplateDetail extends TemplateSummary {
  bodyJson: string;
}

export interface HistoryFacets {
  statuses: number[];
  models: string[];
  templates: string[];
}

export interface HistoryPage {
  items: RequestSummary[];
  facets: HistoryFacets;
  filters: HistoryFilterValues;
}

export interface HistoryFilterValues {
  since: string;
  status: string;
  model: string;
  template: string;
  batch: string;
  limit: number;
}

export type BatchItemState = "pending" | "running" | "ok" | "error" | "skipped";

export interface BatchItemView {
  index: number;
  state: BatchItemState;
  requestId: number | null;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number; cost: number | null } | null;
  durationMs: number;
  error: { code: string; message: string; hint?: string } | null;
}

export interface BatchSummary {
  ok: number;
  errors: number;
  skipped: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  costUnknown: number;
}

export type BatchEvent =
  | { type: "batch.start"; batchId: string; total: number; concurrency: number }
  | { type: "item.start"; index: number }
  | {
      type: "item.finish";
      index: number;
      ok: boolean;
      requestId: number | null;
      model: string | null;
      usage: { inputTokens: number; outputTokens: number; cost: number | null } | null;
      durationMs: number;
      error: { code: string; message: string; hint?: string } | null;
    }
  | { type: "item.skip"; index: number; reason: string }
  | { type: "batch.finish"; batchId: string; summary: BatchSummary }
  | { type: "batch.error"; error: ApiErrorBody };

export interface ApiErrorBody {
  code: string;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly status = 500,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}
