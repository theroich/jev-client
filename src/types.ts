/** Text or JSON object/array that Jev evaluates. */
export type State = string | Record<string, unknown> | unknown[];

/**
 * Typed question. `criteria` is flexible on purpose: an object for `choice`,
 * an ordered array for `score` and an optional string for `noul`.
 */
export interface Question {
  type: string;
  instructions?: unknown;
  criteria?: Record<string, unknown> | unknown[] | string;
}

export type ImageFormat = "png" | "jpg" | "jpeg";

/**
 * Image attached to a request, indexed by reference. The reference is
 * written where text would go (`state`, `instructions` or `criteria`) and the
 * API replaces it with the actual image.
 */
export interface ImageAsset {
  type?: "image";
  /** Base64 without the `data:` prefix and without line breaks. */
  data_base64?: string;
  /** Required with `data_base64`. The API detects the actual byte format. */
  format?: ImageFormat;
  /** Multipart: name of the part carrying the file. */
  part?: string;
}

export interface JevRequest {
  model: string;
  state: State;
  questions: Record<string, Question>;
  /** Request images, by reference. Requires the Danger-Zone-Images header. */
  assets?: Record<string, ImageAsset>;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cost?: number;
  opencode?: unknown;
}

/** Answer to a question. Only the fields of its `type` are filled. */
export interface Answer {
  type: string;
  noul?: number;
  choice?: string;
  confidence?: number;
  score?: number;
  legend?: Record<string, unknown>;
  probabilities?: Record<string, number>;
}

export interface JevResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: Usage;
  /** Original API body, in case extra fields want to be printed. */
  raw: unknown;
}

/** Run source, for auditing the history. */
export type RequestSource = "cli" | "tui" | "web" | "mcp";

/**
 * Log of a complete request (successful or not) that the client emits
 * through the `onRequest` hook. Used to persist the history.
 */
export interface RequestLog {
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  endpoint: string;
  model: string;
  /** `null` when the request never got an HTTP response. */
  statusCode: number | null;
  ok: boolean;
  /** Payload sent to the API. */
  requestBody: unknown;
  /** Actual headers sent (useful for debugging the images header). */
  requestHeaders?: Record<string, string>;
  /** Raw body received (also on errors); `null` if there was none. */
  responseBody: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  errorCode?: string;
  errorMessage?: string;
  templateName?: string;
  batchId?: string;
  /** Run source (cli, tui, web or mcp). */
  source?: RequestSource;
}
