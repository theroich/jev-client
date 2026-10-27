import type { RequestRecord } from "./request-repository.js";
import type { Answer, JevResponse } from "./types.js";

/** Summarizes an answer in one line. */
export function answerSummary(answer: Answer): string {
  switch (answer.type) {
    case "noul":
      return answer.noul === undefined
        ? "noul=?"
        : `noul=${formatNumber(answer.noul)}`;

    case "choice": {
      let text = `choice=${answer.choice ?? ""}`;
      if (answer.confidence !== undefined) {
        text += ` (confidence=${formatNumber(answer.confidence)})`;
      }
      return text;
    }

    case "score": {
      if (answer.score === undefined) {
        return "score=?";
      }
      let text = `score=${formatNumber(answer.score)}`;
      const level = legendLevel(answer.legend, answer.score);
      if (level) {
        text += level.exact
          ? ` ${quote(level.label)}`
          : ` ≈ ${quote(level.label)}`;
      }
      if (answer.confidence !== undefined) {
        text += ` (confidence=${formatNumber(answer.confidence)})`;
      }
      return text;
    }

    default:
      return answer.type;
  }
}

/**
 * Human-readable report. Answer names are sorted so the output is stable
 * across runs.
 */
export function formatReport(response: JevResponse): string {
  const lines = [`model: ${response.model}`];

  for (const name of Object.keys(response.answers).sort()) {
    const answer = response.answers[name];
    if (!answer) {
      continue;
    }
    lines.push(`  ${name}: ${answerSummary(answer)}`);
    if (
      answer.probabilities &&
      Object.keys(answer.probabilities).length > 0
    ) {
      lines.push(`    ${formatProbabilities(answer.probabilities)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Probabilities sorted from highest to lowest. */
export function formatProbabilities(
  probabilities: Record<string, number>,
): string {
  return Object.entries(probabilities)
    .sort(([nameA, valueA], [nameB, valueB]) =>
      valueA === valueB ? nameA.localeCompare(nameB) : valueB - valueA,
    )
    .map(([name, value]) => `${name}=${formatNumber(value)}`)
    .join(", ");
}

interface LegendLevel {
  label: string;
  exact: boolean;
}

/**
 * Returns the closest rubric level. `exact` is false when the score falls
 * between two levels, so it can be marked as approximate.
 */
export function legendLevel(
  legend: Record<string, unknown> | undefined,
  score: number,
): LegendLevel | undefined {
  if (!legend || !Number.isFinite(score)) {
    return undefined;
  }
  const rounded = Math.round(score);
  const value = legend[String(rounded)];
  if (value === undefined) {
    return undefined;
  }
  return {
    label: describeLevel(value),
    exact: Math.abs(score - rounded) < 1e-9,
  };
}

function describeLevel(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const json = JSON.stringify(value);
  return json ?? String(value);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export function formatNumber(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}

/** Masks a secret, leaving the first and last 4 characters visible. */
export function maskSecret(value: string): string {
  if (value.length <= 8) {
    return "********";
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Cost with scientific notation only when it is very small. */
export function formatCost(value: number): string {
  if (value !== 0 && Math.abs(value) < 1e-4) {
    return value.toExponential(3);
  }
  return String(value);
}

/** Human-readable size in bytes (KiB/MiB). */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "—";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** One line per request for `history list`. */
export function formatHistoryRecord(record: RequestRecord): string {
  const model = record.model ?? "-";
  const status = record.statusCode === null ? "-" : String(record.statusCode);
  const ok = record.ok ? "ok" : "fail";
  const duration =
    record.durationMs === null ? "-" : `${record.durationMs}ms`;
  const tokens = `${record.inputTokens ?? "-"}/${record.outputTokens ?? "-"}`;
  const cost = record.cost === null ? "-" : formatCost(record.cost);
  return `#${record.id} ${record.createdAt} ${model} ${status} ${ok} ${duration} ${tokens} ${cost}`;
}

/** Full detail for `history show`. */
export function formatHistoryDetail(record: RequestRecord): string {
  const lines = [
    `id: ${record.id}`,
    `created_at: ${record.createdAt}`,
    `started_at: ${record.startedAt ?? "-"}`,
    `finished_at: ${record.finishedAt ?? "-"}`,
    `duration: ${record.durationMs === null ? "-" : `${record.durationMs}ms`}`,
    `endpoint: ${record.endpoint ?? "-"}`,
    `model: ${record.model ?? "-"}`,
    `status: ${record.statusCode === null ? "-" : String(record.statusCode)}`,
    `ok: ${record.ok}`,
    `tokens: ${record.inputTokens ?? "-"} in / ${record.outputTokens ?? "-"} out`,
    `cost: ${record.cost === null ? "-" : formatCost(record.cost)}`,
    `error_code: ${record.errorCode ?? "-"}`,
    `error_message: ${record.errorMessage ?? "-"}`,
    `template_name: ${record.templateName ?? "-"}`,
    `batch_id: ${record.batchId ?? "-"}`,
    `source: ${record.source ?? "-"}`,
    `request:`,
    prettyJson(record.requestJson),
    `response:`,
    prettyJson(record.responseJson),
  ];
  return `${lines.join("\n")}\n`;
}

/** JSON object for `history export` (one line per request). */
export function historyRecordToJson(
  record: RequestRecord,
): Record<string, unknown> {
  return {
    id: record.id,
    created_at: record.createdAt,
    started_at: record.startedAt,
    finished_at: record.finishedAt,
    duration_ms: record.durationMs,
    endpoint: record.endpoint,
    model: record.model,
    status_code: record.statusCode,
    ok: record.ok,
    request: parseJson(record.requestJson),
    response: parseJson(record.responseJson),
    input_tokens: record.inputTokens,
    output_tokens: record.outputTokens,
    cost: record.cost,
    error_code: record.errorCode,
    error_message: record.errorMessage,
    template_name: record.templateName,
    batch_id: record.batchId,
    source: record.source,
  };
}

function prettyJson(text: string | null): string {
  if (text === null) {
    return "null";
  }
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function parseJson(text: string | null): unknown {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
