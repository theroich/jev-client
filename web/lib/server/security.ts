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
    return denied("invalid_host", "Invalid console host.", 403);
  }
  if (!host || hostUrl.username || hostUrl.password || hostUrl.pathname !== "/") {
    return denied("invalid_host", "Invalid console host.", 403);
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
    return denied("invalid_host", "The console only accepts its configured local host.", 403);
  }

  const expectedPort = process.env.JEV_CONSOLE_PORT;
  if (expectedPort && hostUrl.port !== expectedPort && !(hostUrl.port === "" && expectedPort === "80")) {
    return denied("invalid_host", "The Host port does not match this console.", 403);
  }

  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return denied("cross_site", "A cross-origin request was rejected.", 403);
  }
  if (mutation) {
    const origin = request.headers.get("origin");
    if (!origin) return denied("origin_required", "Mutations require an Origin header.", 403);
    try {
      const parsed = new URL(origin);
      if (parsed.host !== host || !["http:", "https:"].includes(parsed.protocol)) throw new Error("origin");
    } catch {
      return denied("invalid_origin", "Origin does not match the console.", 403);
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
    return denied("invalid_session", "The session link is invalid or was already used. Restart `jev web-console`.");
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
    return denied("invalid_session", "The session is not authenticated. Open the URL printed by `jev web-console`.");
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
    return denied("invalid_session", "Invalid console session.", 401);
  }
  if (mutation) {
    const csrf = request.headers.get("x-jev-console-token") ?? "";
    if (!csrf || !equalSecret(csrf, current.csrfToken)) {
      return denied("invalid_csrf", "The mutation token is missing or does not match the session.", 403);
    }
  }
  return null;
}

export function resetSessionForTests(): void {
  delete globalSessions.__jevConsoleSession;
}
