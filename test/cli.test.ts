import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, type CliIO } from "../src/cli.js";
import type { FetchLike } from "../src/client.js";

const stubBody = {
  model: "jev-1.13",
  answers: { is_urgent: { type: "noul", noul: 0.99 } },
  usage: { input_tokens: 12, output_tokens: 3, cost: 1.5e-6 },
};

interface Harness {
  code: number;
  stdout: string;
  stderr: string;
  calls: Array<{ url: string; init: RequestInit }>;
}

async function run(
  argv: string[],
  options: {
    stdin?: string;
    env?: NodeJS.ProcessEnv;
    handler?: (url: string, init: RequestInit) => Response;
  } = {},
): Promise<Harness> {
  let stdout = "";
  let stderr = "";
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({ url, init });
    if (options.handler) {
      return options.handler(url, init);
    }
    return new Response(JSON.stringify(stubBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const io: CliIO = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readStdin: async () => options.stdin ?? "",
    fetch: fetchImpl,
    env: options.env ?? { OPENCODE_API_KEY: "test-key" },
  };

  const code = await runCli(argv, io);
  return { code, stdout, stderr, calls };
}

test("sin argumentos muestra el uso y sale con 2", async () => {
  const result = await run([]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Uso:/);
});

test("comando desconocido sale con 2", async () => {
  const result = await run(["nope"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /comando desconocido/);
});

test("version", async () => {
  const result = await run(["version"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^jev-client \d+\.\d+\.\d+/);
});

test("demo", async () => {
  const result = await run(["demo"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /is_urgent: noul=0\.99/);
  assert.match(result.stderr, /tokens: 12 in \/ 3 out/);
  assert.equal(result.calls[0]?.url, "https://opencode.ai/inference/systemone/v1/systemone");
});

test("demo con --json devuelve JSON válido", async () => {
  const result = await run(["demo", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout) as { model: string };
  assert.equal(parsed.model, "jev-1.13");
});

test("ask con state y preguntas inline", async () => {
  const result = await run([
    "ask",
    "--state",
    "Me han cobrado dos veces este mes.",
    "--questions",
    '{"is_urgent":{"type":"noul","instructions":"¿Es urgente?"}}',
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /is_urgent: noul=0\.99/);

  const sent = JSON.parse(String(result.calls[0]?.init.body)) as {
    state: unknown;
    questions: Record<string, unknown>;
  };
  assert.equal(sent.state, "Me han cobrado dos veces este mes.");
  assert.deepEqual(Object.keys(sent.questions), ["is_urgent"]);
});

test("ask acepta state JSON estructurado", async () => {
  const result = await run([
    "ask",
    "--state",
    '{"ticket":"hola","plan":"pro"}',
    "--questions",
    '{"q":{"type":"noul","instructions":"?"}}',
  ]);

  assert.equal(result.code, 0);
  const sent = JSON.parse(String(result.calls[0]?.init.body)) as { state: unknown };
  assert.deepEqual(sent.state, { ticket: "hola", plan: "pro" });
});

test("ask lee el state de un fichero y de stdin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-client-"));
  const statePath = join(dir, "state.txt");
  await writeFile(statePath, "El checkout está caído.\n", "utf8");

  const fromFile = await run([
    "ask",
    "--state-file",
    statePath,
    "--questions",
    '{"q":{"type":"noul","instructions":"?"}}',
  ]);
  assert.equal(fromFile.code, 0);

  const fromStdin = await run(
    ["ask", "--state", "-", "--questions", '{"q":{"type":"noul","instructions":"?"}}'],
    { stdin: "Texto por stdin" },
  );
  assert.equal(fromStdin.code, 0);

  const sent = JSON.parse(String(fromStdin.calls[0]?.init.body)) as { state: unknown };
  assert.equal(sent.state, "Texto por stdin");
});

test("ask con request-file completo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-client-"));
  const requestPath = join(dir, "request.json");
  await writeFile(
    requestPath,
    JSON.stringify({
      model: "jev-1.13-free",
      state: { ticket: "hola" },
      questions: { q: { type: "noul", instructions: "?" } },
    }),
    "utf8",
  );

  const result = await run(["ask", "--request-file", requestPath]);
  assert.equal(result.code, 0);

  const sent = JSON.parse(String(result.calls[0]?.init.body)) as { model: string };
  assert.equal(sent.model, "jev-1.13-free");
});

test("ask rechaza tipos de pregunta no soportados", async () => {
  const result = await run([
    "ask",
    "--state",
    "hola",
    "--questions",
    '{"x":{"type":"invented"}}',
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /tipo no soportado/);
  assert.equal(result.calls.length, 0);
});

test("ask sin API key", async () => {
  const result = await run(
    ["ask", "--state", "hola", "--questions", '{"q":{"type":"noul"}}'],
    { env: {} },
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /falta la API key/);
});

test("ask sin state es error de uso", async () => {
  const result = await run(["ask"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /falta --state/);
});

test("usa las variables de entorno", async () => {
  const result = await run(["demo"], {
    env: {
      OPENCODE_API_KEY: "env-key",
      JEV_URL: "https://env.test/systemone",
      JEV_MODEL: "jev-1.13-free",
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.calls[0]?.url, "https://env.test/systemone");
  const sent = JSON.parse(String(result.calls[0]?.init.body)) as { model: string };
  assert.equal(sent.model, "jev-1.13-free");

  const headers = new Headers(result.calls[0]?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer env-key");
});

test("los flags ganan a las variables de entorno", async () => {
  const result = await run(
    ["demo", "--key", "flag-key", "--url", "https://flag.test", "--model", "flag-model"],
    { env: { OPENCODE_API_KEY: "env-key", JEV_URL: "https://env.test", JEV_MODEL: "env-model" } },
  );

  assert.equal(result.code, 0);
  assert.equal(result.calls[0]?.url, "https://flag.test");
  const headers = new Headers(result.calls[0]?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer flag-key");
  const sent = JSON.parse(String(result.calls[0]?.init.body)) as { model: string };
  assert.equal(sent.model, "flag-model");
});

test("un 401 imprime una pista", async () => {
  const result = await run(["demo"], {
    handler: () =>
      new Response(
        JSON.stringify({ error: { code: "api_key_expired", message: "expired" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /pista:/);
  assert.match(result.stderr, /ha caducado/);
});

test("un 429 de cuota imprime una pista", async () => {
  const result = await run(["demo"], {
    handler: () =>
      new Response(
        JSON.stringify({
          error: { type: "FreeUsageLimitError", message: "Free usage limit reached." },
        }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "32594" } },
      ),
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /límite de uso/);
});

test("--timeout y --retries inválidos son error de uso", async () => {
  const badTimeout = await run(["demo", "--timeout", "0"]);
  assert.equal(badTimeout.code, 2);

  const badRetries = await run(["demo", "--retries", "-1"]);
  assert.equal(badRetries.code, 2);
});
