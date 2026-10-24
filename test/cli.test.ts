import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    : { OPENCODE_API_KEY: "test-key", JEV_DB: dbPath };

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

test("config gestiona los valores persistentes", async (t) => {
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
  assert.match(missing.stderr, /no definida/);

  const invalid = await run(
    ["config", "set", "retries", "-1"],
    { dbPath, env: {} },
  );
  assert.equal(invalid.code, 2);
});

test("demo resuelve key, URL y modelo desde SQLite", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const savedKey = await run(
    ["config", "set", "api_key", "stored-key"],
    { dbPath, env: {} },
  );
  assert.equal(savedKey.code, 0);
  assert.match(savedKey.stderr, /se guarda en claro/);
  assert.match(savedKey.stderr, /Para no persistirla/);
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
      OPENCODE_API_KEY: "env-key",
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
        OPENCODE_API_KEY: "env-key",
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

test("--db gana a JEV_DB", async (t) => {
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

test("una key pasada por flag no se persiste", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const demo = await run(["demo", "--key", "temporary-key"], { dbPath, env: {} });
  assert.equal(demo.code, 0);
  const list = await run(["config", "list"], { dbPath, env: {} });
  assert.equal(list.stdout, "");
});

test("template gestiona plantillas y render previsualiza sin llamar a la API", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const body = JSON.stringify({
    model: "jev-1.13",
    state: {
      pedido: "{{estado_de_pedido}}",
      cliente: "{{cliente.nombre}}",
    },
    questions: { urgent: { type: "noul", instructions: "¿Es urgente?" } },
  });

  const add = await run(
    ["template", "add", "pedido", "--description", "Pedido con cliente", "--body", body],
    { dbPath, env: {} },
  );
  assert.equal(add.code, 0);
  assert.match(add.stdout, /plantilla guardada: pedido/);

  const list = await run(["template", "list"], { dbPath, env: {} });
  assert.equal(list.code, 0);
  assert.equal(list.stdout, "pedido - Pedido con cliente\n");

  const show = await run(["template", "show", "pedido"], { dbPath, env: {} });
  assert.equal(show.code, 0);
  const shown = JSON.parse(show.stdout) as { state: unknown };
  assert.deepEqual(shown.state, {
    pedido: "{{estado_de_pedido}}",
    cliente: "{{cliente.nombre}}",
  });

  const render = await run(
    [
      "template",
      "render",
      "pedido",
      "--context",
      '{"estado_de_pedido":"pendiente","cliente":{"nombre":"Ana"}}',
    ],
    { dbPath, env: {} },
  );
  assert.equal(render.code, 0);
  assert.equal(render.calls.length, 0);
  const rendered = JSON.parse(render.stdout) as { state: unknown };
  assert.deepEqual(rendered.state, { pedido: "pendiente", cliente: "Ana" });

  const remove = await run(["template", "remove", "pedido"], { dbPath, env: {} });
  assert.equal(remove.code, 0);
  const missing = await run(["template", "show", "pedido"], { dbPath, env: {} });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /plantilla no encontrada/);
});

test("template render con contexto incompleto falla antes de la API", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const body = JSON.stringify({
    model: "{{modelo}}",
    state: "{{estado}}",
    questions: { q: { type: "noul" } },
  });
  await run(["template", "add", "t", "--body", body], { dbPath, env: {} });

  const render = await run(
    ["template", "render", "t", "--context", "{}"],
    { dbPath, env: {} },
  );
  assert.equal(render.code, 1);
  assert.equal(render.calls.length, 0);
  assert.match(render.stderr, /faltan macros en el contexto/);
  assert.match(render.stderr, /estado/);
  assert.match(render.stderr, /modelo/);
});

test("config path imprime la ruta resuelta", async (t) => {
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

test("config get api_key enmascara y --reveal la muestra", async (t) => {
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

test("config list --json devuelve un objeto", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  await run(["config", "set", "model", "jev-1.13-free"], { dbPath, env: {} });

  const list = await run(["config", "list", "--json"], { dbPath, env: {} });
  assert.equal(list.code, 0);
  assert.deepEqual(JSON.parse(list.stdout), { model: "jev-1.13-free" });
});

test("templates (plural) crea, lista, muestra, edita, valida y borra", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const body = JSON.stringify({
    model: "jev-1.13",
    state: "{{estado}}",
    questions: { urgent: { type: "noul", instructions: "¿Es urgente?" } },
  });

  const create = await run(
    [
      "templates",
      "create",
      "pedido",
      "--description",
      "Pedido con cliente",
      "--body",
      body,
    ],
    { dbPath, env: {} },
  );
  assert.equal(create.code, 0);
  assert.match(create.stdout, /plantilla guardada: pedido/);

  const list = await run(["templates", "list"], { dbPath, env: {} });
  assert.equal(list.code, 0);
  assert.equal(list.stdout, "pedido - Pedido con cliente\n");

  const listJson = await run(["templates", "list", "--json"], {
    dbPath,
    env: {},
  });
  assert.equal(listJson.code, 0);
  const listed = JSON.parse(listJson.stdout) as Array<{ name: string }>;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.name, "pedido");

  const show = await run(["templates", "show", "pedido"], { dbPath, env: {} });
  assert.equal(show.code, 0);
  assert.equal(JSON.parse(show.stdout).model, "jev-1.13");

  const editedBody = JSON.stringify({
    model: "jev-1.13",
    state: "{{estado}}",
    questions: { urgente: { type: "noul", instructions: "¿Urgente?" } },
  });
  const edit = await run(
    ["templates", "edit", "pedido"],
    {
      dbPath,
      env: {},
      editor: async (_path, _initial) => editedBody,
    },
  );
  assert.equal(edit.code, 0);

  const edited = await run(["templates", "show", "pedido"], {
    dbPath,
    env: {},
  });
  const editedShown = JSON.parse(edited.stdout) as { questions: unknown };
  assert.deepEqual(Object.keys(editedShown.questions as object), ["urgente"]);

  const validate = await run(["templates", "validate", "pedido"], {
    dbPath,
    env: {},
  });
  assert.equal(validate.code, 0);
  assert.match(validate.stdout, /plantilla válida: pedido/);

  const decline = await run(["templates", "delete", "pedido"], {
    dbPath,
    env: {},
    confirm: async () => false,
  });
  assert.equal(decline.code, 0);
  assert.match(decline.stdout, /cancelado/);
  const stillThere = await run(["templates", "show", "pedido"], {
    dbPath,
    env: {},
  });
  assert.equal(stillThere.code, 0);

  const accept = await run(["templates", "delete", "pedido"], {
    dbPath,
    env: {},
    confirm: async () => true,
  });
  assert.equal(accept.code, 0);
  assert.match(accept.stdout, /plantilla eliminada: pedido/);

  const gone = await run(["templates", "show", "pedido"], { dbPath, env: {} });
  assert.equal(gone.code, 1);
  assert.match(gone.stderr, /plantilla no encontrada/);
});

test("templates delete con --yes no pide confirmación", async (t) => {
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
  assert.match(result.stdout, /plantilla eliminada: t/);
});

test("templates create desde fichero", async (t) => {
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
    ["templates", "create", "t", "--description", "Desde fichero", "--file", file],
    { dbPath, env: {} },
  );
  assert.equal(result.code, 0);

  const show = await run(["templates", "show", "t"], { dbPath, env: {} });
  assert.equal(JSON.parse(show.stdout).state, "s");
});

test("templates validate --file valida sin persistir", async (t) => {
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
  assert.match(valid.stdout, /plantilla válida/);

  const badFile = join(root, "bad.json");
  await writeFile(badFile, '{"state":"s"}', "utf8");
  const invalid = await run(["templates", "validate", "--file", badFile], {
    dbPath,
    env: {},
  });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /no tiene model/);
});

test("templates edit sin $EDITOR y sin --file falla con mensaje claro", async (t) => {
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
  assert.match(result.stderr, /\$EDITOR no está definido/);
});

test("templates edit con --file reemplaza el body", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const body = JSON.stringify({
    model: "m",
    state: "s",
    questions: { q: { type: "noul" } },
  });
  await run(["templates", "create", "t", "--body", body], { dbPath, env: {} });

  const file = join(root, "nuevo.json");
  await writeFile(
    file,
    JSON.stringify({ model: "m", state: "nuevo", questions: { q: { type: "noul" } } }),
    "utf8",
  );

  const result = await run(["templates", "edit", "t", "--file", file], {
    dbPath,
    env: {},
  });
  assert.equal(result.code, 0);

  const show = await run(["templates", "show", "t"], { dbPath, env: {} });
  assert.equal(JSON.parse(show.stdout).state, "nuevo");
});
