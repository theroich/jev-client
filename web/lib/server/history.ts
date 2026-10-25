import "server-only";

import type { HistoryFilters } from "../../../dist/src/request-repository.js";
import type { HistoryFilterValues } from "@/lib/types";
import { ConsoleError } from "./api";

export interface ParsedHistoryFilters {
  repository: HistoryFilters;
  values: HistoryFilterValues;
}

export function parseHistoryFilters(params: URLSearchParams): ParsedHistoryFilters {
  const repository: HistoryFilters = {};
  const since = params.get("since")?.trim() ?? "";
  if (since) {
    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(since)
      ? new Date(`${since}T00:00:00`).toISOString()
      : since;
    if (Number.isNaN(new Date(normalized).getTime())) {
      throw new ConsoleError(400, "invalid_history_filter", "--since debe ser una fecha válida");
    }
    repository.since = normalized;
  }
  const status = params.get("status")?.trim() ?? "";
  if (status) {
    const code = Number(status);
    if (!Number.isInteger(code) || code < 100 || code > 599) {
      throw new ConsoleError(400, "invalid_history_filter", "--status debe ser un código HTTP entre 100 y 599");
    }
    repository.status = code;
  }
  const model = params.get("model") ?? "";
  const template = params.get("template") ?? "";
  const batch = params.get("batch") ?? "";
  if (model) repository.model = model;
  if (template) repository.template = template;
  if (batch) repository.batch = batch;
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ConsoleError(400, "invalid_history_filter", "--limit debe ser un entero entre 1 y 200");
  }
  repository.limit = limit;
  return {
    repository,
    values: {
      since: since.includes("T") ? localDateInput(since) : since,
      status,
      model,
      template,
      batch,
      limit,
    },
  };
}

function localDateInput(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
