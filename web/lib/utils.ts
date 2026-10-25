import type { HistoryFilterValues, Question, State, TemplateMacro } from "./types";

export const DEFAULT_HISTORY_FILTERS: HistoryFilterValues = {
  since: "",
  status: "",
  model: "",
  template: "",
  batch: "",
  limit: 50,
};

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value !== 0 && Math.abs(value) < 1e-4) return value.toExponential(3);
  return String(value);
}

export function formatTokens(
  input: number | null | undefined,
  output: number | null | undefined,
): string {
  if (input === null || input === undefined) return "—";
  return `${input} / ${output ?? "—"}`;
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function relativeDate(value: string, now = Date.now()): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return value;
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return "ahora";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}

export interface ParsedState {
  value: State;
  kind: "texto" | "JSON" | "vacío";
  error: string | null;
}

export function parseStateInput(raw: string): ParsedState {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { value: JSON.parse(trimmed) as State, kind: "JSON", error: null };
    } catch (error) {
      return {
        value: raw,
        kind: "JSON",
        error: `JSON inválido en el state: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { value: raw, kind: trimmed === "" ? "vacío" : "texto", error: null };
}

export function buildAskCommand(
  state: string,
  questions: Record<string, Question>,
  model: string,
  defaultModel: string,
  save: boolean,
): string {
  const parts = [
    "jev ask --state",
    shellQuote(state),
    "--questions",
    shellQuote(JSON.stringify(questions)),
  ];
  if (model !== defaultModel) parts.push(`--model ${shellQuote(model)}`);
  if (!save) parts.push("--no-save");
  return parts.join(" ");
}

export function buildBatchCommand(
  template: string,
  concurrency: number,
  failFast: boolean,
  save: boolean,
): string {
  const parts = [
    `jev batch ${shellQuote(template || "plantilla")} --contexts contexts.json`,
    `--concurrency ${concurrency}`,
  ];
  if (failFast) parts.push("--fail-fast");
  if (!save) parts.push("--no-save");
  return parts.join(" ");
}

export function filtersFromSearchParams(
  params: Pick<URLSearchParams, "get">,
): HistoryFilterValues {
  const rawLimit = Number(params.get("limit") ?? "50");
  return {
    since: params.get("since") ?? "",
    status: params.get("status") ?? "",
    model: params.get("model") ?? "",
    template: params.get("template") ?? "",
    batch: params.get("batch") ?? "",
    limit: Number.isInteger(rawLimit)
      ? Math.max(1, Math.min(200, rawLimit))
      : 50,
  };
}

export function filtersToSearchParams(
  filters: HistoryFilterValues,
  forApi = false,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of ["since", "status", "model", "template", "batch"] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  params.set("limit", String(filters.limit));
  if (forApi && filters.since && /^\d{4}-\d{2}-\d{2}$/.test(filters.since)) {
    const [year, month, day] = filters.since.split("-").map(Number);
    const local = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
    params.set("since", local.toISOString());
  }
  return params;
}

export function buildHistoryCommand(filters: HistoryFilterValues): string {
  const parts = ["jev history list"];
  if (filters.since) {
    const params = filtersToSearchParams({ ...filters, limit: 50 }, true);
    parts.push(`--since ${shellQuote(params.get("since") ?? filters.since)}`);
  }
  if (filters.status) parts.push(`--status ${shellQuote(filters.status)}`);
  if (filters.model) parts.push(`--model ${shellQuote(filters.model)}`);
  if (filters.template) parts.push(`--template ${shellQuote(filters.template)}`);
  if (filters.batch) parts.push(`--batch ${shellQuote(filters.batch)}`);
  parts.push(`--limit ${filters.limit}`);
  return parts.join(" ");
}

export function parseJsonObject(text: string): {
  value: Record<string, unknown> | null;
  error: string | null;
} {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { value: null, error: "Debe ser un objeto JSON." };
    }
    return { value: value as Record<string, unknown>, error: null };
  } catch (error) {
    return {
      value: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Esqueleto de contextos con una clave plana por macro y `""` como marcador.
 * Mantiene el orden alfabético de `detectMacros` y devuelve `[]` sin macros.
 */
export function buildContextsSkeleton(
  macros: readonly TemplateMacro[],
): string {
  if (macros.length === 0) return "[]";
  return JSON.stringify(
    [Object.fromEntries(macros.map(({ name }) => [name, ""]))],
    null,
    2,
  );
}

/** Cuenta valores de marcador (`""` o solo espacios) en los contextos, incluidos los anidados. */
export function countEmptyContextValues(
  contexts: readonly Record<string, unknown>[],
): number {
  let total = 0;
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.trim() === "") total += 1;
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) walk(item);
    }
  };
  for (const context of contexts) walk(context);
  return total;
}

export function validateContexts(text: string): {
  contexts: Array<Record<string, unknown>>;
  invalid: number[];
  error: string | null;
} {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      return { contexts: [], invalid: [], error: "Los contextos deben ser un array JSON." };
    }
    if (parsed.length > 1000) {
      return { contexts: [], invalid: [], error: "El máximo es 1.000 contextos por lote." };
    }
    const invalid = parsed.flatMap((value, index) =>
      value && typeof value === "object" && !Array.isArray(value) ? [] : [index],
    );
    return {
      contexts: parsed as Array<Record<string, unknown>>,
      invalid,
      error: invalid.length > 0 ? "Hay contextos que no son objetos." : null,
    };
  } catch (error) {
    return {
      contexts: [],
      invalid: [],
      error: `JSON inválido: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
