import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, type CliIO } from "../src/cli.js";
import type { FetchLike } from "../src/client.js";

interface Result {
  code: number;
  stdout: string;
  stderr: string;
  calls: string[];
}

const TEMPLATE_BODY = JSON.stringify({
  model: "jev-1.13",
  state: "{{message}}",
  questions: { q: { type: "noul", instructions: "?" } },
});

function response(state: string, usage: Record<string, unknown>): string {
  return JSON.stringify({
    model: "jev-1.13",
    answers: { q: { type: "noul", noul: 0.5 } },
    usage: { ...usage },
  });
}

async function run(
  argv: string[],
  dbPath: string,
  options: {
    handler?: (url: string, init: RequestInit) => Response;
  } = {},
): Promise<Result> {
  let stdout = "";
  let stderr = "";
  const calls: string[] = [];

  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = String(input);
    if (options.handler) {
      calls.push(url);
      return options.handler(url, init);
    }
    calls.push(url);
    return new Response(
      response("", { input_tokens: 12, output_tokens: 3, cost: 1.5e-6 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
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
    env: { JEV_API_KEY: "test-key", JEV_DB: dbPath },
  };

  const code = await runCli(argv, io);
  return { code, stdout, stderr, calls };
}

async function addTemplate(dbPath: string): Promise<void> {
  const result = await run(
    ["template", "add", "order", "--body", TEMPLATE_BODY],
    dbPath,
  );
  assert.equal(result.code, 0);
}

function stateOf(init: RequestInit): string {
  const body = JSON.parse(String(init.body)) as { state: string };
  return String(body.state);
}

test("batch generates one request per map and one history row per request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");
  const contextsPath = join(root, "contexts.json");

  await addTemplate(dbPath);
  await writeFile(
    contextsPath,
    JSON.stringify([
      { message: "one" },
      { message: "two" },
      { message: "three" },
    ]),
    "utf8",
  );

  const result = await run(
    ["batch", "order", "--contexts", contextsPath],
    dbPath,
  );
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 3);

  const exported = await run(["history", "export"], dbPath);
  const rows = exported.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows.length, 3);
  const batchIds = new Set(rows.map((row) => row.batch_id));
  assert.equal(batchIds.size, 1);
  for (const row of rows) {
    assert.equal(row.template_name, "order");
  }
});

test("batch with an invalid context does not cancel the rest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");
  const contextsPath = join(root, "contexts.json");

  await addTemplate(dbPath);
  await writeFile(
    contextsPath,
    JSON.stringify([
      { message: "one" },
      {},
      { message: "three" },
    ]),
    "utf8",
  );

  const result = await run(
    ["batch", "order", "--contexts", contextsPath],
    dbPath,
  );
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 2);
  assert.match(result.stdout, /summary: 2 ok, 1 error/);
  assert.match(result.stdout, /missing macros in context/);
});

test("--fail-fast stops the run at the first error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");
  const contextsPath = join(root, "contexts.json");

  await addTemplate(dbPath);
  await writeFile(
    contextsPath,
    JSON.stringify([{}, { message: "one" }, { message: "two" }]),
    "utf8",
  );

  const result = await run(
    ["batch", "order", "--contexts", contextsPath, "--fail-fast"],
    dbPath,
  );
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stdout, /1 error/);
  assert.match(result.stdout, /2 skipped by --fail-fast/);
});

test("the cost summary adds only the reported costs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");
  const contextsPath = join(root, "contexts.json");

  await addTemplate(dbPath);
  await writeFile(
    contextsPath,
    JSON.stringify([{ message: "one" }, { message: "two" }, { message: "three" }]),
    "utf8",
  );

  const result = await run(
    ["batch", "order", "--contexts", contextsPath],
    dbPath,
    {
      handler: (_url, init) => {
        const state = stateOf(init);
        const usage =
          state === "two"
            ? { input_tokens: 20, output_tokens: 10 }
            : state === "three"
              ? { input_tokens: 30, output_tokens: 15, cost: 2.5e-6 }
              : { input_tokens: 10, output_tokens: 5, cost: 1.5e-6 };
        return new Response(response(state, usage), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /tokens: 60 in \/ 30 out/);
  assert.match(result.stdout, /cost: 4\.000e-6 \(1 without reported cost\)/);
});

test("batch with --json emits an ordered, machine-readable summary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");
  const contextsPath = join(root, "contexts.json");

  await addTemplate(dbPath);
  await writeFile(
    contextsPath,
    JSON.stringify([{ message: "one" }, { message: "two" }, { message: "three" }]),
    "utf8",
  );

  const result = await run(
    [
      "batch",
      "order",
      "--contexts",
      contextsPath,
      "--json",
      "--concurrency",
      "3",
    ],
    dbPath,
    {
      handler: (_url, init) => {
        const state = stateOf(init);
        const cost = state === "two" ? undefined : 1e-6;
        return new Response(
          response(state, { input_tokens: 1, output_tokens: 1, cost }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  );

  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout) as {
    template: string;
    total: number;
    ok: number;
    errors: number;
    cost: number;
    cost_unknown: number;
    items: Array<{ index: number; ok: boolean; cost: number | null }>;
  };
  assert.equal(parsed.template, "order");
  assert.equal(parsed.total, 3);
  assert.equal(parsed.ok, 3);
  assert.equal(parsed.errors, 0);
  assert.equal(parsed.cost, 2e-6);
  assert.equal(parsed.cost_unknown, 1);
  assert.deepEqual(
    parsed.items.map((item) => item.index),
    [0, 1, 2],
  );
  assert.deepEqual(
    parsed.items.map((item) => item.cost),
    [1e-6, null, 1e-6],
  );
});

test("--concurrency out of range is a usage error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const zero = await run(
    ["batch", "order", "--contexts", "x.json", "--concurrency", "0"],
    dbPath,
  );
  assert.equal(zero.code, 2);
  assert.match(zero.stderr, /--concurrency/);

  const tooHigh = await run(
    ["batch", "order", "--contexts", "x.json", "--concurrency", "11"],
    dbPath,
  );
  assert.equal(tooHigh.code, 2);
  assert.match(tooHigh.stderr, /--concurrency/);
});

test("batch without --contexts is a usage error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const result = await run(["batch", "order"], dbPath);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--contexts/);
});
