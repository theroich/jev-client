import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

const COOKIE_NAME = "jev_console_session";

interface Session {
  id: string;
  csrfToken: string;
  bootstrapUsed: boolean;
}

const globalSessions = globalThis as typeof globalThis & {
  __jevConsoleSession?: Session;
};

function session(): Session {
  globalSessions.__jevConsoleSession ??= {
    id: randomBytes(32).toString("base64url"),
    csrfToken: randomBytes(32).toString("base64url"),
    bootstrapUsed: false,
  };
  return globalSessions.__jevConsoleSession;
}

function equalSecret(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function denied(code: string, message: string, status = 401): NextResponse {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function validateHostAndOrigin(request: NextRequest, mutation: boolean): NextResponse | null {
  const host = request.headers.get("host") ?? "";
  let hostUrl: URL;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return denied("invalid_host", "Host de la consola no válido.", 403);
  }
  if (!host || hostUrl.username || hostUrl.password || hostUrl.pathname !== "/") {
    return denied("invalid_host", "Host de la consola no válido.", 403);
  }

  const allowRemote = process.env.JEV_CONSOLE_ALLOW_REMOTE === "1";
  const hostname = hostUrl.hostname.replace(/^\[|\]$/g, "");
  const loopback = new Set(["127.0.0.1", "localhost", "::1"]);
  const configured = (process.env.JEV_CONSOLE_HOST ?? "127.0.0.1").replace(/^\[|\]$/g, "");
  const wildcard = new Set(["0.0.0.0", "::", "[::]"]);
  const hostAllowed = allowRemote
    ? wildcard.has(configured) || hostname === configured || loopback.has(hostname)
    : loopback.has(hostname);
  if (!hostAllowed) {
    return denied("invalid_host", "La consola solo acepta su Host local configurado.", 403);
  }

  const expectedPort = process.env.JEV_CONSOLE_PORT;
  if (expectedPort && hostUrl.port !== expectedPort && !(hostUrl.port === "" && expectedPort === "80")) {
    return denied("invalid_host", "El puerto del Host no coincide con esta consola.", 403);
  }

  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return denied("cross_site", "Se rechazó una petición de otro origen.", 403);
  }
  if (mutation) {
    const origin = request.headers.get("origin");
    if (!origin) return denied("origin_required", "La mutación necesita una cabecera Origin.", 403);
    try {
      const parsed = new URL(origin);
      if (parsed.host !== host || !["http:", "https:"].includes(parsed.protocol)) throw new Error("origen");
    } catch {
      return denied("invalid_origin", "Origin no coincide con la consola.", 403);
    }
  }
  return null;
}

export function exchangeSession(request: NextRequest): NextResponse {
  const invalid = validateHostAndOrigin(request, true);
  if (invalid) return invalid;
  const expected = process.env.JEV_CONSOLE_TOKEN;
  const supplied = request.headers.get("x-jev-console-token") ?? "";
  const current = session();
  if (!expected || !supplied || !equalSecret(supplied, expected) || current.bootstrapUsed) {
    return denied("invalid_session", "El enlace de sesión no es válido o ya se utilizó. Reinicia `jev web-console`.");
  }

  current.bootstrapUsed = true;
  current.id = randomBytes(32).toString("base64url");
  current.csrfToken = randomBytes(32).toString("base64url");
  const secure = request.headers.get("x-forwarded-proto") === "https" || request.nextUrl.protocol === "https:";
  const response = NextResponse.json(
    { ok: true, csrfToken: current.csrfToken },
    { headers: { "Cache-Control": "no-store" } },
  );
  response.cookies.set(COOKIE_NAME, current.id, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    maxAge: 60 * 60 * 24,
  });
  return response;
}

export function currentSession(request: NextRequest): NextResponse {
  const invalid = validateHostAndOrigin(request, false);
  if (invalid) return invalid;
  const current = session();
  if (!current.bootstrapUsed || request.cookies.get(COOKIE_NAME)?.value !== current.id) {
    return denied("invalid_session", "La sesión no está autenticada. Abre la URL impresa por `jev web-console`.");
  }
  return NextResponse.json(
    { ok: true, csrfToken: current.csrfToken },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function guardApi(request: NextRequest, mutation: boolean): NextResponse | null {
  const invalid = validateHostAndOrigin(request, mutation);
  if (invalid) return invalid;
  const current = session();
  if (!current.bootstrapUsed || request.cookies.get(COOKIE_NAME)?.value !== current.id) {
    return denied("invalid_session", "Sesión de consola no válida.", 401);
  }
  if (mutation) {
    const csrf = request.headers.get("x-jev-console-token") ?? "";
    if (!csrf || !equalSecret(csrf, current.csrfToken)) {
      return denied("invalid_csrf", "Falta el token de mutación o no coincide con la sesión.", 403);
    }
  }
  return null;
}

export function resetSessionForTests(): void {
  delete globalSessions.__jevConsoleSession;
}
