import type { SqliteDatabase } from "./database.js";
import type { RequestLog, RequestSource } from "./types.js";

/** Registro leído de la tabla `requests`. */
export interface RequestRecord {
  id: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  endpoint: string | null;
  model: string | null;
  statusCode: number | null;
  ok: boolean;
  /** Payload enviado, en JSON. */
  requestJson: string | null;
  /** Cuerpo crudo recibido, en JSON o texto plano. */
  responseJson: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  templateName: string | null;
  batchId: string | null;
  /** Origen de la ejecución. */
  source: RequestSource;
}

export interface HistoryFilters {
  /** Límite inferior (inclusive) de `created_at`, ISO 8601. */
  since?: string;
  status?: number;
  model?: string;
  template?: string;
  batch?: string;
  limit?: number;
}

export interface HistoryFacets {
  models: string[];
  templates: string[];
  statuses: number[];
  batches: string[];
}

interface RequestRow {
  id: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  endpoint: string | null;
  model: string | null;
  status_code: number | null;
  ok: number;
  request_json: string | null;
  response_json: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: number | null;
  error_code: string | null;
  error_message: string | null;
  template_name: string | null;
  batch_id: string | null;
  source: RequestSource;
}

const INSERT_SQL = `
  INSERT INTO requests (
    created_at, started_at, finished_at, duration_ms, endpoint, model,
    status_code, ok, request_json, response_json,
    input_tokens, output_tokens, cost,
    error_code, error_message, template_name, batch_id, source
  ) VALUES (
    @created_at, @started_at, @finished_at, @duration_ms, @endpoint, @model,
    @status_code, @ok, @request_json, @response_json,
    @input_tokens, @output_tokens, @cost,
    @error_code, @error_message, @template_name, @batch_id, @source
  )
`;

/** Repositorio del historial de peticiones sobre la tabla `requests`. */
export class RequestRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /** Inserta una petición (correcta o fallida) y devuelve su id. */
  insert(log: RequestLog): number {
    const result = this.db.prepare(INSERT_SQL).run({
      created_at: new Date().toISOString(),
      started_at: log.startedAt.toISOString(),
      finished_at: log.finishedAt.toISOString(),
      duration_ms: log.durationMs,
      endpoint: log.endpoint,
      model: log.model,
      status_code: log.statusCode,
      ok: log.ok ? 1 : 0,
      request_json: JSON.stringify(log.requestBody),
      response_json: log.responseBody ?? null,
      input_tokens: log.inputTokens ?? null,
      output_tokens: log.outputTokens ?? null,
      cost: log.cost ?? null,
      error_code: log.errorCode ?? null,
      error_message: log.errorMessage ?? null,
      template_name: log.templateName ?? null,
      batch_id: log.batchId ?? null,
      source: log.source ?? "cli",
    });
    return Number(result.lastInsertRowid);
  }

  get(id: number): RequestRecord | undefined {
    const row = this.db
      .prepare<[number], RequestRow>("SELECT * FROM requests WHERE id = ?")
      .get(id);
    return row === undefined ? undefined : toRecord(row);
  }

  list(filters: HistoryFilters = {}): RequestRecord[] {
    const { where, params } = buildWhere(filters);
    const sql =
      `SELECT * FROM requests${where} ORDER BY id DESC` +
      (filters.limit === undefined ? "" : " LIMIT ?");
    const rows = this.db
      .prepare<unknown[], RequestRow>(sql)
      .all(...params, ...(filters.limit === undefined ? [] : [filters.limit]));
    return rows.map(toRecord);
  }

  count(filters: HistoryFilters = {}): number {
    const { where, params } = buildWhere(filters);
    const row = this.db
      .prepare<unknown[], { count: number }>(
        `SELECT COUNT(*) AS count FROM requests${where}`,
      )
      .get(...params);
    return row?.count ?? 0;
  }

  /** Valores disponibles para construir los filtros del historial. */
  facets(): HistoryFacets {
    const models = this.db
      .prepare<[], { value: string }>(
        "SELECT DISTINCT model AS value FROM requests WHERE model IS NOT NULL ORDER BY model",
      )
      .all()
      .map((row) => row.value);
    const templates = this.db
      .prepare<[], { value: string }>(
        "SELECT DISTINCT template_name AS value FROM requests WHERE template_name IS NOT NULL ORDER BY template_name",
      )
      .all()
      .map((row) => row.value);
    const statuses = this.db
      .prepare<[], { value: number }>(
        "SELECT DISTINCT status_code AS value FROM requests WHERE status_code IS NOT NULL ORDER BY status_code",
      )
      .all()
      .map((row) => row.value);
    const batches = this.db
      .prepare<[], { value: string }>(
        "SELECT DISTINCT batch_id AS value FROM requests WHERE batch_id IS NOT NULL ORDER BY batch_id",
      )
      .all()
      .map((row) => row.value);
    return { models, templates, statuses, batches };
  }
}

function buildWhere(
  filters: HistoryFilters,
): { where: string; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (filters.since !== undefined) {
    clauses.push("created_at >= ?");
    params.push(filters.since);
  }
  if (filters.status !== undefined) {
    clauses.push("status_code = ?");
    params.push(filters.status);
  }
  if (filters.model !== undefined) {
    clauses.push("model = ?");
    params.push(filters.model);
  }
  if (filters.template !== undefined) {
    clauses.push("template_name = ?");
    params.push(filters.template);
  }
  if (filters.batch !== undefined) {
    clauses.push("batch_id = ?");
    params.push(filters.batch);
  }

  return {
    where: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`,
    params,
  };
}

function toRecord(row: RequestRow): RequestRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    endpoint: row.endpoint,
    model: row.model,
    statusCode: row.status_code,
    ok: row.ok === 1,
    requestJson: row.request_json,
    responseJson: row.response_json,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cost: row.cost,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    templateName: row.template_name,
    batchId: row.batch_id,
    source: row.source,
  };
}
