import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, type CliIO } from "../src/cli.js";
import type { FetchLike } from "../src/client.js";

const stubBody = {
  model: "jev-1.13",
  answers: { is_urgent: { type: "noul", noul: 0.99 } },
  usage: { input_tokens: 12, output_tokens: 3, cost: 1.5e-6 },
};

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  argv: string[],
  dbPath: string,
  options: { handler?: (url: string, init: RequestInit) => Response } = {},
): Promise<Result> {
  let stdout = "";
  let stderr = "";

  const fetchImpl: FetchLike = async (input, init = {}) => {
    if (options.handler) {
      return options.handler(String(input), init);
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
    readStdin: async () => "",
    fetch: fetchImpl,
    env: { OPENCODE_API_KEY: "test-key", JEV_DB: dbPath },
  };

  const code = await runCli(argv, io);
  return { code, stdout, stderr };
}

test("ask registra la petición y history la consulta", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const ask = await run(
    ["ask", "--state", "hola", "--questions", '{"q":{"type":"noul"}}'],
    dbPath,
  );
  assert.equal(ask.code, 0);

  const list = await run(["history", "list"], dbPath);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /#1 /);
  assert.match(list.stdout, /jev-1\.13 200 ok/);
  assert.match(list.stdout, /12\/3/);

  const show = await run(["history", "show", "1"], dbPath);
  assert.equal(show.code, 0);
  assert.match(show.stdout, /id: 1/);
  assert.match(show.stdout, /status: 200/);
  assert.match(show.stdout, /ok: true/);
  assert.match(show.stdout, /"state": "hola"/);
  assert.match(show.stdout, /"noul": 0\.99/);

  const exported = await run(["history", "export"], dbPath);
  assert.equal(exported.code, 0);
  const record = JSON.parse(exported.stdout.trim()) as Record<string, unknown>;
  assert.equal(record.id, 1);
  assert.equal(record.ok, true);
  assert.equal(record.status_code, 200);
  assert.equal(record.cost, 1.5e-6);
  assert.deepEqual(record.request, {
    model: "jev-1.13",
    state: "hola",
    questions: { q: { type: "noul" } },
  });
  assert.deepEqual(record.response, stubBody);
});

test("registra las peticiones fallidas con su error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const ask = await run(
    ["ask", "--state", "hola", "--questions", '{"q":{"type":"noul"}}'],
    dbPath,
    {
      handler: () =>
        new Response(
          JSON.stringify({ error: { code: "api_key_expired", message: "expired" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    },
  );
  assert.equal(ask.code, 1);

  const show = await run(["history", "show", "1"], dbPath);
  assert.equal(show.code, 0);
  assert.match(show.stdout, /status: 401/);
  assert.match(show.stdout, /ok: false/);
  assert.match(show.stdout, /error_code: api_key_expired/);
  assert.match(show.stdout, /error_message: expired/);
  assert.match(show.stdout, /cost: -/);
});

test("--no-save no registra la ejecución", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const ask = await run(
    [
      "ask",
      "--state",
      "hola",
      "--questions",
      '{"q":{"type":"noul"}}',
      "--no-save",
    ],
    dbPath,
  );
  assert.equal(ask.code, 0);

  const list = await run(["history", "list"], dbPath);
  assert.equal(list.code, 0);
  assert.equal(list.stdout, "");
});

test("history lista con filtros", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  await run(
    [
      "ask",
      "--state",
      "a",
      "--questions",
      '{"q":{"type":"noul"}}',
      "--model",
      "m1",
    ],
    dbPath,
  );
  await run(
    [
      "ask",
      "--state",
      "b",
      "--questions",
      '{"q":{"type":"noul"}}',
      "--model",
      "m2",
    ],
    dbPath,
    {
      handler: () =>
        new Response(JSON.stringify({ error: { message: "boom" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    },
  );

  const byModel = await run(["history", "list", "--model", "m1"], dbPath);
  assert.equal(byModel.code, 0);
  assert.match(byModel.stdout, /m1/);
  assert.doesNotMatch(byModel.stdout, /m2/);

  const byStatus = await run(["history", "list", "--status", "500"], dbPath);
  assert.equal(byStatus.code, 0);
  assert.match(byStatus.stdout, /500 fail/);
  assert.doesNotMatch(byStatus.stdout, /200 ok/);

  const limited = await run(["history", "list", "--limit", "1"], dbPath);
  assert.equal(limited.code, 0);
  assert.equal(limited.stdout.trim().split("\n").length, 1);

  const since = await run(
    ["history", "list", "--since", "2099-01-01T00:00:00.000Z"],
    dbPath,
  );
  assert.equal(since.stdout, "");

  const invalid = await run(["history", "list", "--status", "abc"], dbPath);
  assert.equal(invalid.code, 2);
});

test("history show de un id inexistente devuelve error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const show = await run(["history", "show", "42"], dbPath);
  assert.equal(show.code, 1);
  assert.match(show.stderr, /no existe la petición 42/);
});

test("demo también se registra", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const demo = await run(["demo"], dbPath);
  assert.equal(demo.code, 0);

  const list = await run(["history", "list"], dbPath);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /#1 /);
});
