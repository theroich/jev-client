import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildQuestionsFromFlags, runCli, type CliIO } from "../src/cli.js";
import type { FetchLike } from "../src/client.js";
const stubBody = {
  model: "jev-1.13",
  answers: { is_urgent: { type: "noul", noul: 0.99 } },
  usage: { input_tokens: 12, output_tokens: 3, cost: 1.5e-6 },
};

function pngBytes(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

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
    dbPath?: string;
    handler?: (url: string, init: RequestInit) => Response;
    confirm?: (prompt: string) => Promise<boolean> | boolean;
    editor?: (filePath: string, initial: string) => Promise<string> | string;
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

  const temporaryDir =
    options.dbPath === undefined
      ? await mkdtemp(join(tmpdir(), "jev-cli-db-"))
      : undefined;
  const dbPath = options.dbPath ?? join(temporaryDir as string, "jev.db");
  const env = options.env
    ? { JEV_DB: dbPath, ...options.env }
    : { JEV_API_KEY: "test-key", JEV_DB: dbPath };

  const io: CliIO = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readStdin: async () => options.stdin ?? "",
    fetch: fetchImpl,
    env,
    confirm: options.confirm
      ? async (prompt) => (await options.confirm!(prompt)) as boolean
      : undefined,
    openInEditor: options.editor
      ? async (filePath, initial) =>
          (await options.editor!(filePath, initial)) as string
      : undefined,
  };

  try {
    const code = await runCli(argv, io);
    return { code, stdout, stderr, calls };
  } finally {
    if (temporaryDir !== undefined) {
      await rm(temporaryDir, { recursive: true, force: true });
    }
  }
}

test("with no arguments prints the usage and exits with 2", async () => {
  const result = await run([]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Usage:/);
});

test("unknown command exits with 2", async () => {
  const result = await run(["nope"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown command/);
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

test("demo with --json returns valid JSON", async () => {
  const result = await run(["demo", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout) as { model: string };
  assert.equal(parsed.model, "jev-1.13");
});

test("ask with state and inline questions", async () => {
  const result = await run([
    "ask",
    "--state",
    "I was charged twice this month.",
    "--questions",
    '{"is_urgent":{"type":"noul","instructions":"Is it urgent?"}}',
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /is_urgent: noul=0\.99/);

  const sent = JSON.parse(String(result.calls[0]?.init.body)) as {
    state: unknown;
    questions: Record<string, unknown>;
  };
  assert.equal(sent.state, "I was charged twice this month.");
  assert.deepEqual(Object.keys(sent.questions), ["is_urgent"]);
});

test("ask accepts a structured JSON state", async () => {
  const result = await run([
    "ask",
    "--state",
    '{"ticket":"hello","plan":"pro"}',
    "--questions",
    '{"q":{"type":"noul","instructions":"?"}}',
  ]);

  assert.equal(result.code, 0);
  const sent = JSON.parse(String(result.calls[0]?.init.body)) as { state: unknown };
  assert.deepEqual(sent.state, { ticket: "hello", plan: "pro" });
});

test("ask reads the state from a file and from stdin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-client-"));
  const statePath = join(dir, "state.txt");
  await writeFile(statePath, "The checkout is down.\n", "utf8");

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
    { stdin: "Text from stdin" },
  );
  assert.equal(fromStdin.code, 0);

  const sent = JSON.parse(String(fromStdin.calls[0]?.init.body)) as { state: unknown };
  assert.equal(sent.state, "Text from stdin");
});

test("ask with a full request-file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-client-"));
  const requestPath = join(dir, "request.json");
  await writeFile(
    requestPath,
    JSON.stringify({
      model: "jev-1.13-free",
      state: { ticket: "hello" },
      questions: { q: { type: "noul", instructions: "?" } },
    }),
    "utf8",
  );

  const result = await run(["ask", "--request-file", requestPath]);
  assert.equal(result.code, 0);

  const sent = JSON.parse(String(result.calls[0]?.init.body)) as { model: string };
  assert.equal(sent.model, "jev-1.13-free");
});

test("the saved model wins over the request-file model", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-client-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "jev.db");
  const requestPath = join(dir, "request.json");
  await writeFile(
    requestPath,
    JSON.stringify({
      model: "jev-1.13-free",
      state: { ticket: "hello" },
      questions: { q: { type: "noul", instructions: "?" } },
    }),
    "utf8",
  );

  const saved = await run(["config", "set", "model", "jev-1.14.0"], {
    dbPath,
    env: {},
  });
  assert.equal(saved.code, 0);

  const result = await run(["ask", "--request-file", requestPath], {
    dbPath,
    env: { JEV_API_KEY: "test-key" },
  });
  assert.equal(result.code, 0);
  const sent = JSON.parse(String(result.calls[0]?.init.body)) as { model: string };
  assert.equal(sent.model, "jev-1.14.0");

  const overridden = await run(
    ["ask", "--request-file", requestPath, "--model", "flag-model"],
    { dbPath, env: { JEV_API_KEY: "test-key" } },
  );
  assert.equal(overridden.code, 0);
  const overriddenSent = JSON.parse(
    String(overridden.calls[0]?.init.body),
  ) as { model: string };
  assert.equal(overriddenSent.model, "flag-model");
});

test("ask rejects unsupported question types", async () => {
  const result = await run([
    "ask",
    "--state",
    "hello",
    "--questions",
    '{"x":{"type":"invented"}}',
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /unsupported type/);
  assert.equal(result.calls.length, 0);
});

test("buildQuestionsFromFlags maps noul, choice and score", () => {
  assert.deepEqual(
    buildQuestionsFromFlags({ noul: ["billing=Is this about billing?"] }),
    { billing: { type: "noul", instructions: "Is this about billing?" } },
  );

  assert.deepEqual(
    buildQuestionsFromFlags({
      choice: ["team=Which team?"],
      option: ["team.billing=Billing", "team.infra=Outages"],
    }),
    {
      team: {
        type: "choice",
        instructions: "Which team?",
        criteria: { billing: "Billing", infra: "Outages" },
      },
    },
  );

  assert.deepEqual(
    buildQuestionsFromFlags({
      score: ["urgency=How urgent is it?"],
      level: [
        "urgency=It can wait",
        "urgency=This week",
        "urgency=Today",
      ],
    }),
    {
      urgency: {
        type: "score",
        instructions: "How urgent is it?",
        criteria: ["It can wait", "This week", "Today"],
      },
    },
  );
});

test("buildQuestionsFromFlags keeps the order in which --level appears", () => {
  const questions = buildQuestionsFromFlags({
    score: ["u=Urgency?"],
    level: ["u=Low", "u=Medium", "u=High"],
  });
  assert.deepEqual(questions.u?.criteria, ["Low", "Medium", "High"]);
});

test("buildQuestionsFromFlags rejects shape errors", () => {
  assert.throws(
    () => buildQuestionsFromFlags({ choice: ["team=?"] }),
    /needs at least one --option/,
  );
  assert.throws(
    () => buildQuestionsFromFlags({ score: ["u=?"] }),
    /needs at least one --level/,
  );
  assert.throws(
    () => buildQuestionsFromFlags({ option: ["team.billing=Billing"] }),
    /is not a --choice/,
  );
  assert.throws(
    () => buildQuestionsFromFlags({ level: ["u=Today"] }),
    /is not a --score/,
  );
  assert.throws(
    () =>
      buildQuestionsFromFlags({
        noul: ["team=?"],
        option: ["team.billing=Billing"],
      }),
    /is not a --choice/,
  );
  assert.throws(
    () => buildQuestionsFromFlags({ noul: ["a=?"], choice: ["a=?"] }),
    /duplicate key/,
  );
  assert.throws(
    () =>
      buildQuestionsFromFlags({
        choice: ["team=?"],
        option: ["team.b.illing=Billing"],
      }),
    /cannot contain/,
  );
});

test("ask with typed flags sends the same body as --questions", async () => {
  const noul = await run([
    "ask",
    "--state",
    "I was charged twice this month.",
    "--noul",
    "billing=Is this about billing?",
  ]);
  assert.equal(noul.code, 0);

  const choice = await run([
    "ask",
    "--state",
    "The checkout has been down for 30 minutes.",
    "--choice",
    "team=Which team should own the incident?",
    "--option",
    "team.billing=Billing, invoices or payments",
    "--option",
    "team.infra=Outages, 500 errors or platform problems",
    "--option",
    "team.sales=Pricing or sales questions",
  ]);
  assert.equal(choice.code, 0);

  const score = await run([
    "ask",
    "--state",
    "We have gone two days without an answer.",
    "--score",
    "urgency=How urgent is the incident?",
    "--level",
    "urgency=It can wait",
    "--level",
    "urgency=This week",
    "--level",
    "urgency=Today",
  ]);
  assert.equal(score.code, 0);

  const flaggedNoul = JSON.parse(String(noul.calls[0]?.init.body)) as {
    questions: Record<string, unknown>;
  };
  const flaggedChoice = JSON.parse(String(choice.calls[0]?.init.body)) as {
    questions: Record<string, unknown>;
  };
  const flaggedScore = JSON.parse(String(score.calls[0]?.init.body)) as {
    questions: Record<string, unknown>;
  };

  assert.deepEqual(flaggedNoul.questions, {
    billing: { type: "noul", instructions: "Is this about billing?" },
  });
  assert.deepEqual(flaggedChoice.questions, {
    team: {
      type: "choice",
      instructions: "Which team should own the incident?",
      criteria: {
        billing: "Billing, invoices or payments",
        infra: "Outages, 500 errors or platform problems",
        sales: "Pricing or sales questions",
      },
    },
  });
  assert.deepEqual(flaggedScore.questions, {
    urgency: {
      type: "score",
      instructions: "How urgent is the incident?",
      criteria: ["It can wait", "This week", "Today"],
    },
  });
});

test("ask with --choice but no --option is a local usage error", async () => {
  const result = await run([
    "ask",
    "--state",
    "hello",
    "--choice",
    "team=Which team?",
  ]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /needs at least one --option/);
  assert.equal(result.calls.length, 0);
});

test("ask rejects mixing typed flags with --questions", async () => {
  const result = await run([
    "ask",
    "--state",
    "hello",
    "--noul",
    "q=?",
    "--questions",
    '{"q":{"type":"noul"}}',
  ]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /do not combine/);
  assert.equal(result.calls.length, 0);
});

test("--asset ref=path loads the image and sends the header", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-asset-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const png = join(dir, "photo.png");
  await writeFile(png, pngBytes(300, 300));

  const result = await run([
    "ask",
    "--state",
    '{"photo":"ref-1"}',
    "--questions",
    '{"q":{"type":"noul","instructions":"What is in ref-1?"}}',
    "--asset",
    "ref-1=" + png,
  ]);

  assert.equal(result.code, 0);
  const headers = new Headers(result.calls[0]?.init.headers);
  assert.equal(headers.get("typeSafe-danger-zone-images"), "true");
  const sent = JSON.parse(String(result.calls[0]?.init.body)) as {
    state: { photo: string };
    assets: Record<string, { format: string; data_base64: string }>;
  };
  assert.equal(sent.state.photo, "ref-1");
  assert.equal(sent.assets["ref-1"]?.format, "png");
  assert.ok(sent.assets["ref-1"]?.data_base64);
});

test("--assets-file reads the full assets map", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-asset-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const png = join(dir, "photo.png");
  await writeFile(png, pngBytes(300, 300));

  const assetsFile = join(dir, "assets.json");
  await writeFile(assetsFile, JSON.stringify({ "ref-a": { path: png } }), "utf8");
  const file = await run([
    "ask",
    "--state",
    '{"photo":"ref-a"}',
    "--questions",
    '{"q":{"type":"noul","instructions":"ref-a"}}',
    "--assets-file",
    assetsFile,
  ]);
  assert.equal(file.code, 0);
  const fileSent = JSON.parse(String(file.calls[0]?.init.body)) as {
    assets: Record<string, { format: string }>;
  };
  assert.equal(fileSent.assets["ref-a"]?.format, "png");
});

test("--asset with data_base64 in --assets-file validates it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-asset-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assetsFile = join(dir, "assets.json");
  await writeFile(
    assetsFile,
    JSON.stringify({ "ref-b": { data_base64: pngBytes(300, 300).toString("base64"), format: "png" } }),
    "utf8",
  );
  const result = await run([
    "ask",
    "--state",
    '{"photo":"ref-b"}',
    "--questions",
    '{"q":{"type":"noul","instructions":"ref-b"}}',
    "--assets-file",
    assetsFile,
  ]);
  assert.equal(result.code, 0);
  const sent = JSON.parse(String(result.calls[0]?.init.body)) as {
    assets: Record<string, { format: string }>;
  };
  assert.equal(sent.assets["ref-b"]?.format, "png");
});

test("--no-images-header omits the images header", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-asset-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const png = join(dir, "photo.png");
  await writeFile(png, pngBytes(300, 300));

  const result = await run([
    "ask",
    "--state",
    '{"photo":"ref-1"}',
    "--questions",
    '{"q":{"type":"noul","instructions":"ref-1"}}',
    "--asset",
    "ref-1=" + png,
    "--no-images-header",
  ]);

  assert.equal(result.code, 0);
  const headers = new Headers(result.calls[0]?.init.headers);
  assert.equal(headers.get("typeSafe-danger-zone-images"), null);
});

test("--asset with an out-of-limits image fails before calling", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-asset-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const png = join(dir, "small.png");
  await writeFile(png, pngBytes(50, 50));

  const result = await run([
    "ask",
    "--state",
    "text",
    "--questions",
    '{"q":{"type":"noul","instructions":"?"}}',
    "--asset",
    png,
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /minimum per side/);
});

test("ask without an API key", async () => {
  const result = await run(
    ["ask", "--state", "hello", "--questions", '{"q":{"type":"noul"}}'],
    { env: {} },
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /missing API key/);
});

test("ask without state is a usage error", async () => {
  const result = await run(["ask"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /missing --state/);
});

test("uses the environment variables", async () => {
  const result = await run(["demo"], {
    env: {
      JEV_API_KEY: "env-key",
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

test("flags win over the environment variables", async () => {
  const result = await run(
    ["demo", "--key", "flag-key", "--url", "https://flag.test", "--model", "flag-model"],
    { env: { JEV_API_KEY: "env-key", JEV_URL: "https://env.test", JEV_MODEL: "env-model" } },
  );

  assert.equal(result.code, 0);
  assert.equal(result.calls[0]?.url, "https://flag.test");
  const headers = new Headers(result.calls[0]?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer flag-key");
  const sent = JSON.parse(String(result.calls[0]?.init.body)) as { model: string };
  assert.equal(sent.model, "flag-model");
});

test("a 401 prints a hint", async () => {
  const result = await run(["demo"], {
    handler: () =>
      new Response(
        JSON.stringify({ error: { code: "api_key_expired", message: "expired" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /hint:/);
  assert.match(result.stderr, /has expired/);
});

test("a 429 quota error prints a hint", async () => {
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
  assert.match(result.stderr, /usage limit/);
});

test("invalid --timeout and --retries are usage errors", async () => {
  const badTimeout = await run(["demo", "--timeout", "0"]);
  assert.equal(badTimeout.code, 2);

  const badRetries = await run(["demo", "--retries", "-1"]);
  assert.equal(badRetries.code, 2);
});

test("config manages the persistent values", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const setModel = await run(
    ["config", "set", "model", "jev-1.13-free"],
    { dbPath, env: {} },
  );
  assert.equal(setModel.code, 0);
  await run(["config", "set", "timeout", "15"], { dbPath, env: {} });

  const get = await run(["config", "get", "model"], { dbPath, env: {} });
  assert.equal(get.code, 0);
  assert.equal(get.stdout, "jev-1.13-free\n");

  const list = await run(["config", "list"], { dbPath, env: {} });
  assert.equal(list.stdout, "model=jev-1.13-free\ntimeout=15\n");

  const unset = await run(["config", "unset", "model"], { dbPath, env: {} });
  assert.equal(unset.code, 0);
  const missing = await run(["config", "get", "model"], { dbPath, env: {} });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /not defined/);

  const invalid = await run(
    ["config", "set", "retries", "-1"],
    { dbPath, env: {} },
  );
  assert.equal(invalid.code, 2);
});

test("demo resolves key, URL and model from SQLite", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const savedKey = await run(
    ["config", "set", "api_key", "stored-key"],
    { dbPath, env: {} },
  );
  assert.equal(savedKey.code, 0);
  assert.match(savedKey.stderr, /stored in plain text/);
  assert.match(savedKey.stderr, /To avoid persisting it/);
  await run(
    ["config", "set", "api_url", "https://stored.test/systemone"],
    { dbPath, env: {} },
  );
  await run(
    ["config", "set", "model", "stored-model"],
    { dbPath, env: {} },
  );

  const fromDatabase = await run(["demo"], { dbPath, env: {} });
  assert.equal(fromDatabase.code, 0);
  assert.equal(fromDatabase.calls[0]?.url, "https://stored.test/systemone");
  let headers = new Headers(fromDatabase.calls[0]?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer stored-key");
  let sent = JSON.parse(String(fromDatabase.calls[0]?.init.body)) as { model: string };
  assert.equal(sent.model, "stored-model");

  const fromEnv = await run(["demo"], {
    dbPath,
    env: {
      JEV_API_KEY: "env-key",
      JEV_URL: "https://env.test/systemone",
      JEV_MODEL: "env-model",
    },
  });
  assert.equal(fromEnv.calls[0]?.url, "https://env.test/systemone");
  headers = new Headers(fromEnv.calls[0]?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer env-key");
  sent = JSON.parse(String(fromEnv.calls[0]?.init.body)) as { model: string };
  assert.equal(sent.model, "env-model");

  const fromFlags = await run(
    ["demo", "--key", "flag-key", "--url", "https://flag.test", "--model", "flag-model"],
    {
      dbPath,
      env: {
        JEV_API_KEY: "env-key",
        JEV_URL: "https://env.test/systemone",
        JEV_MODEL: "env-model",
      },
    },
  );
  assert.equal(fromFlags.calls[0]?.url, "https://flag.test");
  headers = new Headers(fromFlags.calls[0]?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer flag-key");
  sent = JSON.parse(String(fromFlags.calls[0]?.init.body)) as { model: string };
  assert.equal(sent.model, "flag-model");
});

test("--db wins over JEV_DB", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envPath = join(root, "env.db");
  const flagPath = join(root, "flag.db");
  const env = { JEV_DB: envPath };

  const set = await run(
    ["config", "set", "model", "flag-model", "--db", flagPath],
    { dbPath: envPath, env },
  );
  assert.equal(set.code, 0);

  const fromFlag = await run(
    ["config", "get", "model", "--db", flagPath],
    { dbPath: envPath, env },
  );
  assert.equal(fromFlag.stdout, "flag-model\n");
  const fromEnv = await run(["config", "get", "model"], { dbPath: envPath, env });
  assert.equal(fromEnv.code, 1);
});

test("a key passed by flag is not persisted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const demo = await run(["demo", "--key", "temporary-key"], { dbPath, env: {} });
  assert.equal(demo.code, 0);
  const list = await run(["config", "list"], { dbPath, env: {} });
  assert.equal(list.stdout, "");
});

test("template manages templates and render previews without calling the API", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const body = JSON.stringify({
    model: "jev-1.13",
    state: {
      order: "{{order_state}}",
      customer: "{{customer.name}}",
    },
    questions: { urgent: { type: "noul", instructions: "Is it urgent?" } },
  });

  const add = await run(
    ["template", "add", "order", "--description", "Order with customer", "--body", body],
    { dbPath, env: {} },
  );
  assert.equal(add.code, 0);
  assert.match(add.stdout, /template saved: order/);

  const list = await run(["template", "list"], { dbPath, env: {} });
  assert.equal(list.code, 0);
  assert.equal(list.stdout, "order - Order with customer\n");

  const show = await run(["template", "show", "order", "--json"], { dbPath, env: {} });
  assert.equal(show.code, 0);
  const shown = JSON.parse(show.stdout) as { body: { state: unknown } };
  assert.deepEqual(shown.body.state, {
    order: "{{order_state}}",
    customer: "{{customer.name}}",
  });

  const render = await run(
    [
      "template",
      "render",
      "order",
      "--context",
      '{"order_state":"pending","customer":{"name":"Ana"}}',
    ],
    { dbPath, env: {} },
  );
  assert.equal(render.code, 0);
  assert.equal(render.calls.length, 0);
  const rendered = JSON.parse(render.stdout) as { state: unknown };
  assert.deepEqual(rendered.state, { order: "pending", customer: "Ana" });

  const remove = await run(["template", "remove", "order"], { dbPath, env: {} });
  assert.equal(remove.code, 0);
  const missing = await run(["template", "show", "order"], { dbPath, env: {} });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /template not found/);
});

test("template saves, keeps and clears macro descriptions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const body = JSON.stringify({
    model: "m",
    state: { ticket: "{{ticket}}", plan: "{{customer.plan}}" },
    questions: { q: { type: "noul" } },
  });
  const create = await run(
    [
      "template",
      "create",
      "order",
      "--body",
      body,
      "--macro-desc",
      "ticket=Order identifier (TCK-1042)",
      "--macro-desc",
      "customer.plan=free | pro | enterprise",
    ],
    { dbPath, env: {} },
  );
  assert.equal(create.code, 0);

  const listJson = await run(["template", "list", "--json"], { dbPath, env: {} });
  const listed = JSON.parse(listJson.stdout) as Array<{ macros: Array<{ name: string; description: string }> }>;
  assert.deepEqual(listed[0]?.macros, [
    { name: "customer.plan", description: "free | pro | enterprise", schema: null },
    { name: "ticket", description: "Order identifier (TCK-1042)", schema: null },
  ]);

  const showJson = await run(["template", "show", "order", "--json"], { dbPath, env: {} });
  assert.deepEqual(
    (JSON.parse(showJson.stdout) as { macros: unknown }).macros,
    listed[0]?.macros,
  );

  const human = await run(["template", "show", "order"], { dbPath, env: {} });
  assert.match(human.stdout, /\{\{ticket\}\}\n\s+Order identifier/);

  // Editing the body without flags keeps the description of the remaining macros.
  const withoutPlan = JSON.stringify({
    model: "m",
    state: { ticket: "{{ticket}}" },
    questions: { q: { type: "noul" } },
  });
  const file = join(root, "body.json");
  await writeFile(file, withoutPlan, "utf8");
  assert.equal(
    (await run(["template", "edit", "order", "--file", file], { dbPath, env: {} })).code,
    0,
  );
  const trimmed = await run(["template", "show", "order", "--json"], { dbPath, env: {} });
  assert.deepEqual(
    (JSON.parse(trimmed.stdout) as { macros: unknown }).macros,
    [{ name: "ticket", description: "Order identifier (TCK-1042)", schema: null }],
  );

  const cleared = await run(
    ["template", "edit", "order", "--file", file, "--clear-macro-desc", "ticket"],
    { dbPath, env: {} },
  );
  assert.equal(cleared.code, 0);
  const afterClear = await run(["template", "show", "order", "--json"], { dbPath, env: {} });
  assert.deepEqual(
    (JSON.parse(afterClear.stdout) as { macros: unknown }).macros,
    [{ name: "ticket", description: "", schema: null }],
  );

  const unknown = await run(
    ["template", "edit", "order", "--file", file, "--macro-desc", "nope=x"],
    { dbPath, env: {} },
  );
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /is not in the template body/);

  const malformed = await run(
    ["template", "create", "other", "--body", body, "--macro-desc", "no-equals"],
    { dbPath, env: {} },
  );
  assert.equal(malformed.code, 2);
  assert.match(malformed.stderr, /expects <key>=<text>/);
});

test("template saves, keeps and clears macro schemas", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const body = JSON.stringify({
    model: "m",
    state: { ticket: "{{ticket}}", plan: "{{customer.plan}}" },
    questions: { q: { type: "noul" } },
  });
  const create = await run(
    [
      "template",
      "create",
      "order",
      "--body",
      body,
      "--macro-desc",
      "ticket=Order identifier",
      "--macro-desc",
      "customer.plan=Subscribed plan",
      "--macro-schema",
      'ticket={"type":"string","format":"uuid"}',
      "--macro-type",
      "customer.plan=string",
    ],
    { dbPath, env: {} },
  );
  assert.equal(create.code, 0);

  const expected = [
    {
      name: "customer.plan",
      description: "Subscribed plan",
      schema: { type: "string" },
    },
    {
      name: "ticket",
      description: "Order identifier",
      schema: { type: "string", format: "uuid" },
    },
  ];
  const listJson = await run(["template", "list", "--json"], { dbPath, env: {} });
  assert.deepEqual(
    (JSON.parse(listJson.stdout) as Array<{ macros: unknown }>)[0]?.macros,
    expected,
  );
  const showJson = await run(["template", "show", "order", "--json"], { dbPath, env: {} });
  assert.deepEqual((JSON.parse(showJson.stdout) as { macros: unknown }).macros, expected);

  const human = await run(["template", "show", "order"], { dbPath, env: {} });
  assert.match(human.stdout, /\{\{ticket\}\}\n\s+Order identifier\n\s+schema: \{"type":"string","format":"uuid"\}/);

  // `edit` without schema flags keeps the existing ones.
  const file = join(root, "body.json");
  await writeFile(file, body, "utf8");
  assert.equal(
    (await run(["template", "edit", "order", "--file", file], { dbPath, env: {} })).code,
    0,
  );
  const preserved = await run(["template", "show", "order", "--json"], { dbPath, env: {} });
  assert.deepEqual((JSON.parse(preserved.stdout) as { macros: unknown }).macros, expected);

  // `--macro-type` replaces only the schema of the given macro.
  assert.equal(
    (await run(["template", "edit", "order", "--file", file, "--macro-type", "ticket=boolean"], { dbPath, env: {} })).code,
    0,
  );
  const retyped = await run(["template", "show", "order", "--json"], { dbPath, env: {} });
  assert.deepEqual((JSON.parse(retyped.stdout) as { macros: unknown }).macros, [
    expected[0],
    { name: "ticket", description: "Order identifier", schema: { type: "boolean" } },
  ]);

  // Clearing the schema keeps the description.
  assert.equal(
    (await run(["template", "edit", "order", "--file", file, "--clear-macro-schema", "ticket"], { dbPath, env: {} })).code,
    0,
  );
  const cleared = await run(["template", "show", "order", "--json"], { dbPath, env: {} });
  assert.deepEqual((JSON.parse(cleared.stdout) as { macros: unknown }).macros, [
    expected[0],
    { name: "ticket", description: "Order identifier", schema: null },
  ]);

  // Booleans are valid JSON Schema.
  assert.equal(
    (await run(["template", "edit", "order", "--file", file, "--macro-schema", "ticket=false"], { dbPath, env: {} })).code,
    0,
  );
  const booleanSchema = await run(["template", "show", "order", "--json"], { dbPath, env: {} });
  assert.deepEqual(
    (JSON.parse(booleanSchema.stdout) as { macros: Array<{ schema: unknown }> }).macros[1]?.schema,
    false,
  );

  const invalidJson = await run(
    ["template", "create", "other", "--body", body, "--macro-schema", "ticket={bad"],
    { dbPath, env: {} },
  );
  assert.equal(invalidJson.code, 2);
  assert.match(invalidJson.stderr, /is not valid JSON/);

  const invalidType = await run(
    ["template", "create", "other", "--body", body, "--macro-type", "ticket=text"],
    { dbPath, env: {} },
  );
  assert.equal(invalidType.code, 2);
  assert.match(invalidType.stderr, /--macro-type/);

  const invalidPattern = await run(
    ["template", "create", "other", "--body", body, "--macro-schema", 'ticket={"pattern":"("}'],
    { dbPath, env: {} },
  );
  assert.equal(invalidPattern.code, 2);
  assert.match(invalidPattern.stderr, /pattern/);

  const unknown = await run(
    ["template", "edit", "order", "--file", file, "--macro-schema", "nope={}"],
    { dbPath, env: {} },
  );
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /is not in the template body/);
});

test("template render with an incomplete context fails before the API", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const body = JSON.stringify({
    model: "{{model}}",
    state: "{{state}}",
    questions: { q: { type: "noul" } },
  });
  await run(["template", "add", "t", "--body", body], { dbPath, env: {} });

  const render = await run(
    ["template", "render", "t", "--context", "{}"],
    { dbPath, env: {} },
  );
  assert.equal(render.code, 1);
  assert.equal(render.calls.length, 0);
  assert.match(render.stderr, /missing macros in context/);
  assert.match(render.stderr, /state/);
  assert.match(render.stderr, /model/);
});

test("config path prints the resolved path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const result = await run(["config", "path", "--db", dbPath], {
    env: {},
    dbPath,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), dbPath);
});

test("config get api_key masks it and --reveal shows it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  await run(["config", "set", "api_key", "sk-abcdefgh-1234"], {
    dbPath,
    env: {},
  });

  const masked = await run(["config", "get", "api_key"], { dbPath, env: {} });
  assert.equal(masked.code, 0);
  assert.match(masked.stdout, /sk-a/);
  assert.doesNotMatch(masked.stdout, /abcdefgh/);

  const revealed = await run(
    ["config", "get", "api_key", "--reveal"],
    { dbPath, env: {} },
  );
  assert.equal(revealed.stdout, "sk-abcdefgh-1234\n");

  const asJson = await run(["config", "get", "api_key", "--json"], {
    dbPath,
    env: {},
  });
  assert.equal(asJson.code, 0);
  assert.equal(JSON.parse(asJson.stdout), "sk-abcdefgh-1234");
});

test("config list --json returns an object", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  await run(["config", "set", "model", "jev-1.13-free"], { dbPath, env: {} });

  const list = await run(["config", "list", "--json"], { dbPath, env: {} });
  assert.equal(list.code, 0);
  assert.deepEqual(JSON.parse(list.stdout), { model: "jev-1.13-free" });
});

test("templates (plural) creates, lists, shows, edits, validates and deletes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const body = JSON.stringify({
    model: "jev-1.13",
    state: "{{state}}",
    questions: { urgent: { type: "noul", instructions: "Is it urgent?" } },
  });

  const create = await run(
    [
      "templates",
      "create",
      "order",
      "--description",
      "Order with customer",
      "--body",
      body,
    ],
    { dbPath, env: {} },
  );
  assert.equal(create.code, 0);
  assert.match(create.stdout, /template saved: order/);

  const list = await run(["templates", "list"], { dbPath, env: {} });
  assert.equal(list.code, 0);
  assert.equal(list.stdout, "order - Order with customer\n");

  const listJson = await run(["templates", "list", "--json"], {
    dbPath,
    env: {},
  });
  assert.equal(listJson.code, 0);
  const listed = JSON.parse(listJson.stdout) as Array<{ name: string }>;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.name, "order");

  const show = await run(["templates", "show", "order", "--json"], { dbPath, env: {} });
  assert.equal(show.code, 0);
  assert.equal((JSON.parse(show.stdout) as { body: { model: string } }).body.model, "jev-1.13");

  const editedBody = JSON.stringify({
    model: "jev-1.13",
    state: "{{state}}",
    questions: { urgent: { type: "noul", instructions: "Urgent?" } },
  });
  const edit = await run(
    ["templates", "edit", "order"],
    {
      dbPath,
      env: {},
      editor: async (_path, _initial) => editedBody,
    },
  );
  assert.equal(edit.code, 0);

  const edited = await run(["templates", "show", "order", "--json"], {
    dbPath,
    env: {},
  });
  const editedShown = JSON.parse(edited.stdout) as { body: { questions: unknown } };
  assert.deepEqual(Object.keys(editedShown.body.questions as object), ["urgent"]);

  const validate = await run(["templates", "validate", "order"], {
    dbPath,
    env: {},
  });
  assert.equal(validate.code, 0);
  assert.match(validate.stdout, /template valid: order/);

  const decline = await run(["templates", "delete", "order"], {
    dbPath,
    env: {},
    confirm: async () => false,
  });
  assert.equal(decline.code, 0);
  assert.match(decline.stdout, /cancelled/);
  const stillThere = await run(["templates", "show", "order"], {
    dbPath,
    env: {},
  });
  assert.equal(stillThere.code, 0);

  const accept = await run(["templates", "delete", "order"], {
    dbPath,
    env: {},
    confirm: async () => true,
  });
  assert.equal(accept.code, 0);
  assert.match(accept.stdout, /template deleted: order/);

  const gone = await run(["templates", "show", "order"], { dbPath, env: {} });
  assert.equal(gone.code, 1);
  assert.match(gone.stderr, /template not found/);
});

test("templates delete with --yes does not ask for confirmation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const body = JSON.stringify({
    model: "m",
    state: "s",
    questions: { q: { type: "noul" } },
  });
  await run(["templates", "create", "t", "--body", body], { dbPath, env: {} });

  const result = await run(["templates", "delete", "t", "--yes"], {
    dbPath,
    env: {},
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /template deleted: t/);
});

test("templates create from a file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const file = join(root, "body.json");
  await writeFile(
    file,
    JSON.stringify({
      model: "m",
      state: "s",
      questions: { q: { type: "noul" } },
    }),
    "utf8",
  );

  const result = await run(
    ["templates", "create", "t", "--description", "From file", "--file", file],
    { dbPath, env: {} },
  );
  assert.equal(result.code, 0);

  const show = await run(["templates", "show", "t"], { dbPath, env: {} });
  assert.equal(JSON.parse(show.stdout).state, "s");
});

test("templates validate --file validates without persisting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const file = join(root, "body.json");
  await writeFile(
    file,
    JSON.stringify({
      model: "m",
      state: "s",
      questions: { q: { type: "noul" } },
    }),
    "utf8",
  );

  const valid = await run(["templates", "validate", "--file", file], {
    dbPath,
    env: {},
  });
  assert.equal(valid.code, 0);
  assert.match(valid.stdout, /template valid/);

  const badFile = join(root, "bad.json");
  await writeFile(badFile, '{"state":"s"}', "utf8");
  const invalid = await run(["templates", "validate", "--file", badFile], {
    dbPath,
    env: {},
  });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /has no model/);
});

test("templates edit without $EDITOR and without --file fails with a clear message", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const body = JSON.stringify({
    model: "m",
    state: "s",
    questions: { q: { type: "noul" } },
  });
  await run(["templates", "create", "t", "--body", body], { dbPath, env: {} });

  const result = await run(["templates", "edit", "t"], { dbPath, env: {} });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\$EDITOR is not set/);
});

test("templates edit with --file replaces the body", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const body = JSON.stringify({
    model: "m",
    state: "s",
    questions: { q: { type: "noul" } },
  });
  await run(["templates", "create", "t", "--body", body], { dbPath, env: {} });

  const file = join(root, "new.json");
  await writeFile(
    file,
    JSON.stringify({ model: "m", state: "new", questions: { q: { type: "noul" } } }),
    "utf8",
  );

  const result = await run(["templates", "edit", "t", "--file", file], {
    dbPath,
    env: {},
  });
  assert.equal(result.code, 0);

  const show = await run(["templates", "show", "t"], { dbPath, env: {} });
  assert.equal(JSON.parse(show.stdout).state, "new");
});
