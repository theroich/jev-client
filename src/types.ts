/** Texto u objeto/array JSON que Jev evalúa. */
export type State = string | Record<string, unknown> | unknown[];

/**
 * Pregunta tipada. `criteria` es flexible a propósito: objeto para `choice`,
 * array ordenado para `score` y string opcional para `noul`.
 */
export interface Question {
  type: string;
  instructions?: unknown;
  criteria?: Record<string, unknown> | unknown[] | string;
}

export type ImageFormat = "png" | "jpg" | "jpeg";

/**
 * Imagen adjunta a un request, indexada por referencia. La referencia se
 * escribe donde iría texto (`state`, `instructions` o `criteria`) y la API
 * la sustituye por la imagen real.
 */
export interface ImageAsset {
  type?: "image";
  /** Base64 sin prefijo `data:` y sin saltos de línea. */
  data_base64?: string;
  /** Requerido con `data_base64`. La API detecta el formato real de los bytes. */
  format?: ImageFormat;
  /** Multipart: nombre de la parte que lleva el fichero. */
  part?: string;
}

export interface JevRequest {
  model: string;
  state: State;
  questions: Record<string, Question>;
  /** Imágenes del request, por referencia. Requiere el header Danger-Zone-Images. */
  assets?: Record<string, ImageAsset>;
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

/** Origen de una ejecución, para auditar el historial. */
export type RequestSource = "cli" | "tui" | "web" | "mcp";

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
  /** Cabeceras reales enviadas (útil para depurar el header de imágenes). */
  requestHeaders?: Record<string, string>;
  /** Cuerpo crudo recibido (también en errores); `null` si no lo hubo. */
  responseBody: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  errorCode?: string;
  errorMessage?: string;
  templateName?: string;
  batchId?: string;
  /** Origen de la ejecución (cli, tui, web o mcp). */
  source?: RequestSource;
}
