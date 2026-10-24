/** Texto u objeto/array JSON que Jev evalúa. */
export type State = string | Record<string, unknown> | unknown[];

/**
 * Pregunta tipada. `criteria` es flexible a propósito: objeto para `choice`,
 * array ordenado para `score` y opcional para `noul`.
 */
export interface Question {
  type: string;
  instructions?: unknown;
  criteria?: Record<string, unknown> | unknown[];
}

export interface JevRequest {
  model: string;
  state: State;
  questions: Record<string, Question>;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cost?: number;
  opencode?: unknown;
}

/** Respuesta de una pregunta. Solo se rellenan los campos de su `type`. */
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
  /** Cuerpo original de la API, por si se quieren imprimir campos extra. */
  raw: unknown;
}

/**
 * Registro de una petición completa (con o sin éxito) que el cliente emite
 * mediante el hook `onRequest`. Sirve para persistir el historial.
 */
export interface RequestLog {
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  endpoint: string;
  model: string;
  /** `null` cuando la petición no llegó a obtener respuesta HTTP. */
  statusCode: number | null;
  ok: boolean;
  /** Payload enviado a la API. */
  requestBody: unknown;
  /** Cuerpo crudo recibido (también en errores); `null` si no lo hubo. */
  responseBody: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  errorCode?: string;
  errorMessage?: string;
  templateName?: string;
  batchId?: string;
}
