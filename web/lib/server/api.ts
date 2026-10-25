import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { JevApiError, jevErrorHint } from "../../../dist/src/errors.js";
import { guardApi } from "./security";

export class ConsoleError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConsoleError";
  }
}

export function json(value: unknown, status = 200): NextResponse {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function readJson(request: NextRequest, maxBytes = 2_000_000): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new ConsoleError(413, "body_too_large", `El body supera el límite de ${maxBytes} bytes.`);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new ConsoleError(413, "body_too_large", `El body supera el límite de ${maxBytes} bytes.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ConsoleError(400, "invalid_json", `JSON inválido: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConsoleError(400, "invalid_body", "El body debe ser un objeto JSON.");
  }
  return value as Record<string, unknown>;
}

export async function withApi(
  request: NextRequest,
  mutation: boolean,
  handler: () => Promise<Response> | Response,
): Promise<Response> {
  const denied = guardApi(request, mutation);
  if (denied) return denied;
  try {
    const response = await handler();
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof ConsoleError) {
    return json({
      error: {
        code: error.code,
        message: error.message,
        hint: error.hint,
        details: error.details,
      },
    }, error.status);
  }
  if (error instanceof JevApiError) {
    const status = error.statusCode === 429 ? 429 : error.statusCode === 422 ? 422 : 502;
    return json({
      error: {
        code: error.code ?? "provider_error",
        message: error.message,
        hint: providerHint(error),
        details: { providerStatus: error.statusCode },
      },
    }, status);
  }
  const message = error instanceof Error ? error.message : String(error);
  const missingKey = message.includes("falta la API key");
  return json({
    error: {
      code: missingKey ? "api_key_missing" : "console_error",
      message,
      hint: missingKey
        ? "Configura api_key, usa --key o define OPENCODE_API_KEY/JEV_API_KEY."
        : undefined,
    },
  }, missingKey ? 400 : 500);
}

export function providerHint(error: JevApiError): string | undefined {
  return jevErrorHint(error);
}
