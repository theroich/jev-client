import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { JevClient, parseApiError, type FetchLike } from "../src/client.js";
import { JevApiError } from "../src/errors.js";

const okBody = {
  model: "jev-1.13",
  answers: {
    is_urgent: { type: "noul", noul: 0.99 },
    team: {
      type: "choice",
      choice: "infra",
      confidence: 0.64,
      probabilities: { infra: 0.76, billing: 0.24, sales: 0 },
    },
  },
  usage: { input_tokens: 449, output_tokens: 73, cost: 1.886e-5 },
};

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(
  handler: (call: Call) => Response | Promise<Response>,
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("envía el request correcto y parsea la respuesta", async () => {
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(okBody));
  const client = new JevClient({
    apiKey: "test-key",
    endpoint: "https://example.test/systemone",
    fetch: fetchImpl,
  });

  const response = await client.systemOne("hola", {
    is_urgent: { type: "noul", instructions: "¿Urgente?" },
  });

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, "https://example.test/systemone");
  assert.equal(call.init.method, "POST");

  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("authorization"), "Bearer test-key");
  assert.equal(headers.get("content-type"), "application/json");

  const sent = JSON.parse(String(call.init.body)) as {
    model: string;
    state: unknown;
    questions: Record<string, { type: string }>;
  };
  assert.equal(sent.model, "jev-1.13");
  assert.equal(sent.state, "hola");
  assert.equal(sent.questions.is_urgent?.type, "noul");

  assert.equal(response.answers.is_urgent?.noul, 0.99);
  assert.equal(response.answers.team?.choice, "infra");
  assert.equal(response.usage.input_tokens, 449);
  assert.equal(response.usage.cost, 1.886e-5);
  assert.deepEqual(response.raw, okBody);
});

test("respeta el modelo del request", async () => {
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(okBody));
  const client = new JevClient({ apiKey: "k", fetch: fetchImpl });

  await client.run({
    model: "jev-1.13-free",
    state: "x",
    questions: { q: { type: "noul" } },
  });

  const sent = JSON.parse(String(calls[0]?.init.body)) as { model: string };
  assert.equal(sent.model, "jev-1.13-free");
});

test("exige API key y al menos una pregunta", async () => {
  assert.throws(() => new JevClient({ apiKey: "" }), /falta la API key/);

  const client = new JevClient({ apiKey: "k", fetch: fakeFetch(() => jsonResponse({})).fetchImpl });
  await assert.rejects(client.systemOne("x", {}), /al menos una pregunta/);
});

test("no reintenta errores de autenticación", async () => {
  const { fetchImpl, calls } = fakeFetch(() =>
    jsonResponse(
      {
        error: {
          type: "authentication_error",
          code: "api_key_expired",
          message: "This API key has expired.",
        },
      },
      401,
    ),
  );

  const client = new JevClient({ apiKey: "k", fetch: fetchImpl });

  await assert.rejects(
    client.systemOne("x", { q: { type: "noul" } }),
    (error: unknown) => {
      assert.ok(error instanceof JevApiError);
      assert.equal(error.statusCode, 401);
      assert.equal(error.code, "api_key_expired");
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("reintenta errores 5xx", async () => {
  let attempts = 0;
  const { fetchImpl, calls } = fakeFetch(() => {
    attempts += 1;
    if (attempts < 3) {
      return jsonResponse({ error: { type: "server_error", message: "boom" } }, 500);
    }
    return jsonResponse(okBody);
  });

  const client = new JevClient({
    apiKey: "k",
    fetch: fetchImpl,
    backoffMs: 1,
    maxRetries: 2,
  });

  const response = await client.systemOne("x", { q: { type: "noul" } });
  assert.equal(calls.length, 3);
  assert.equal(response.answers.is_urgent?.noul, 0.99);
});

test("no reintenta el 429 de cuota ni espera su Retry-After", async () => {
  const { fetchImpl, calls } = fakeFetch(
    () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "FreeUsageLimitError", message: "Free usage limit reached." },
        }),
        { status: 429, headers: { "retry-after": "32594" } },
      ),
  );

  const client = new JevClient({ apiKey: "k", fetch: fetchImpl });

  const start = Date.now();
  await assert.rejects(client.systemOne("x", { q: { type: "noul" } }), (error: unknown) => {
    assert.ok(error instanceof JevApiError);
    assert.equal(error.code, "FreeUsageLimitError");
    return true;
  });

  assert.equal(calls.length, 1);
  assert.ok(Date.now() - start < 1000, "no debe esperar las horas del Retry-After");
});

test("capa el Retry-After", async () => {
  let attempts = 0;
  const { fetchImpl } = fakeFetch(() => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(JSON.stringify({ error: { message: "temporal" } }), {
        status: 503,
        headers: { "retry-after": "100" },
      });
    }
    return jsonResponse(okBody);
  });

  const client = new JevClient({
    apiKey: "k",
    fetch: fetchImpl,
    maxRetryDelayMs: 20,
    maxRetries: 1,
  });

  const start = Date.now();
  await client.systemOne("x", { q: { type: "noul" } });
  assert.ok(Date.now() - start < 1000, "el Retry-After debe quedar capado");
});

test("parsea los formatos de error conocidos", () => {
  const cases: Array<{
    name: string;
    body: string;
    message: string;
    code?: string;
  }> = [
    {
      name: "opencode",
      body: '{"error":{"type":"authentication_error","code":"api_key_expired","message":"expired"}}',
      message: "expired",
      code: "api_key_expired",
    },
    {
      name: "typesafe",
      body: '{"detail":{"error_type":"api_usage_error","message":"Invalid request."}}',
      message: "Invalid request.",
      code: "api_usage_error",
    },
    {
      name: "validación",
      body: '{"detail":[{"loc":["body","questions","x","criteria"],"msg":"Field required"}]}',
      message: "body.questions.x.criteria: Field required",
      code: "validation_error",
    },
    { name: "texto plano", body: "error code: 1010", message: "error code: 1010" },
    { name: "vacío", body: "", message: "error desconocido" },
  ];

  for (const testCase of cases) {
    const error = parseApiError(400, testCase.body);
    assert.equal(error.message, testCase.message, testCase.name);
    assert.equal(error.code, testCase.code, testCase.name);
  }
});

test("emite el hook onRequest en una petición correcta", async () => {
  let log: import("../src/types.js").RequestLog | undefined;
  const { fetchImpl } = fakeFetch(() => jsonResponse(okBody));
  const client = new JevClient({
    apiKey: "k",
    fetch: fetchImpl,
    onRequest: (entry) => {
      log = entry;
    },
  });

  await client.systemOne("x", { q: { type: "noul" } });

  assert.ok(log);
  assert.equal(log.ok, true);
  assert.equal(log.statusCode, 200);
  assert.equal(log.model, "jev-1.13");
  assert.equal(log.inputTokens, 449);
  assert.equal(log.outputTokens, 73);
  assert.equal(log.cost, 1.886e-5);
  assert.deepEqual(log.requestBody, {
    model: "jev-1.13",
    state: "x",
    questions: { q: { type: "noul" } },
  });
  assert.equal(log.responseBody, JSON.stringify(okBody));
  assert.equal(log.errorCode, undefined);
  assert.ok(log.durationMs >= 0);
});

test("emite el hook onRequest en un error de API", async () => {
  let log: import("../src/types.js").RequestLog | undefined;
  const { fetchImpl } = fakeFetch(() =>
    jsonResponse({ error: { code: "api_key_expired", message: "expired" } }, 401),
  );
  const client = new JevClient({
    apiKey: "k",
    fetch: fetchImpl,
    onRequest: (entry) => {
      log = entry;
    },
  });

  await assert.rejects(client.systemOne("x", { q: { type: "noul" } }));

  assert.ok(log);
  assert.equal(log.ok, false);
  assert.equal(log.statusCode, 401);
  assert.equal(log.errorCode, "api_key_expired");
  assert.equal(log.errorMessage, "expired");
  assert.equal(log.inputTokens, undefined);
  assert.equal(log.cost, undefined);
});

test("emite el hook onRequest en un error de red", async () => {
  let log: import("../src/types.js").RequestLog | undefined;
  const { fetchImpl } = fakeFetch(() => {
    throw new Error("conexión rechazada");
  });
  const client = new JevClient({
    apiKey: "k",
    fetch: fetchImpl,
    maxRetries: 0,
    onRequest: (entry) => {
      log = entry;
    },
  });

  await assert.rejects(client.systemOne("x", { q: { type: "noul" } }));

  assert.ok(log);
  assert.equal(log.ok, false);
  assert.equal(log.statusCode, null);
  assert.match(log.errorMessage ?? "", /no se pudo conectar/);
  assert.equal(log.responseBody, null);
});

test("funciona contra un servidor HTTP real", async (t) => {
  let receivedAuth = "";
  let receivedPath = "";

  const server = createServer((request, response) => {
    receivedAuth = request.headers.authorization ?? "";
    receivedPath = request.url ?? "";
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(okBody));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
  });

  const address = server.address() as AddressInfo;
  const client = new JevClient({
    apiKey: "real-key",
    endpoint: `http://127.0.0.1:${address.port}/inference/systemone/v1/systemone`,
  });

  const response = await client.systemOne("hola", { q: { type: "noul" } });

  assert.equal(receivedAuth, "Bearer real-key");
  assert.equal(receivedPath, "/inference/systemone/v1/systemone");
  assert.equal(response.answers.is_urgent?.noul, 0.99);
});
