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

test("buildQuestionsFromFlags mapea noul, choice y score", () => {
  assert.deepEqual(
    buildQuestionsFromFlags({ noul: ["billing=¿Es de facturación?"] }),
    { billing: { type: "noul", instructions: "¿Es de facturación?" } },
  );

  assert.deepEqual(
    buildQuestionsFromFlags({
      choice: ["team=¿Qué equipo?"],
      option: ["team.billing=Cobros", "team.infra=Caídas"],
    }),
    {
      team: {
        type: "choice",
        instructions: "¿Qué equipo?",
        criteria: { billing: "Cobros", infra: "Caídas" },
      },
    },
  );

  assert.deepEqual(
    buildQuestionsFromFlags({
      score: ["urgency=¿Cómo de urgente?"],
      level: [
        "urgency=Puede esperar",
        "urgency=Esta semana",
        "urgency=Hoy mismo",
      ],
    }),
    {
      urgency: {
        type: "score",
        instructions: "¿Cómo de urgente?",
        criteria: ["Puede esperar", "Esta semana", "Hoy mismo"],
      },
    },
  );
});

test("buildQuestionsFromFlags conserva el orden de aparición de --level", () => {
  const questions = buildQuestionsFromFlags({
    score: ["u=¿Urgencia?"],
    level: ["u=Bajo", "u=Medio", "u=Alto"],
  });
  assert.deepEqual(questions.u?.criteria, ["Bajo", "Medio", "Alto"]);
});

test("buildQuestionsFromFlags rechaza errores de forma", () => {
  assert.throws(
    () => buildQuestionsFromFlags({ choice: ["team=¿?"] }),
    /necesita al menos un --option/,
  );
  assert.throws(
    () => buildQuestionsFromFlags({ score: ["u=¿?"] }),
    /necesita al menos un --level/,
  );
  assert.throws(
    () => buildQuestionsFromFlags({ option: ["team.billing=Cobros"] }),
    /no es un --choice/,
  );
  assert.throws(
    () => buildQuestionsFromFlags({ level: ["u=Hoy"] }),
    /no es un --score/,
  );
  assert.throws(
    () =>
      buildQuestionsFromFlags({
        noul: ["team=¿?"],
        option: ["team.billing=Cobros"],
      }),
    /no es un --choice/,
  );
  assert.throws(
    () => buildQuestionsFromFlags({ noul: ["a=¿?"], choice: ["a=¿?"] }),
    /clave duplicada/,
  );
  assert.throws(
    () =>
      buildQuestionsFromFlags({
        choice: ["team=¿?"],
        option: ["team.b.illing=Cobros"],
      }),
    /no puede contener/,
  );
});

test("ask con flags tipados envía el mismo body que --questions", async () => {
  const noul = await run([
    "ask",
    "--state",
    "Me han cobrado dos veces este mes.",
    "--noul",
    "billing=¿Es de facturación?",
  ]);
  assert.equal(noul.code, 0);

  const choice = await run([
    "ask",
    "--state",
    "El checkout lleva caído 30 minutos.",
    "--choice",
    "team=¿Qué equipo debería gestionar la incidencia?",
    "--option",
    "team.billing=Cobros, facturas o pagos",
    "--option",
    "team.infra=Caídas, errores 500 o problemas de plataforma",
    "--option",
    "team.sales=Precios o dudas comerciales",
  ]);
  assert.equal(choice.code, 0);

  const score = await run([
    "ask",
    "--state",
    "Llevamos dos días sin respuesta.",
    "--score",
    "urgency=¿Cómo de urgente es la incidencia?",
    "--level",
    "urgency=Puede esperar",
    "--level",
    "urgency=Esta semana",
    "--level",
    "urgency=Hoy mismo",
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
    billing: { type: "noul", instructions: "¿Es de facturación?" },
  });
  assert.deepEqual(flaggedChoice.questions, {
    team: {
      type: "choice",
      instructions: "¿Qué equipo debería gestionar la incidencia?",
      criteria: {
        billing: "Cobros, facturas o pagos",
        infra: "Caídas, errores 500 o problemas de plataforma",
        sales: "Precios o dudas comerciales",
      },
    },
  });
  assert.deepEqual(flaggedScore.questions, {
    urgency: {
      type: "score",
      instructions: "¿Cómo de urgente es la incidencia?",
      criteria: ["Puede esperar", "Esta semana", "Hoy mismo"],
    },
  });
});

test("ask con --choice sin --option es error de uso local", async () => {
  const result = await run([
    "ask",
    "--state",
    "hola",
    "--choice",
    "team=¿Qué equipo?",
  ]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /necesita al menos un --option/);
  assert.equal(result.calls.length, 0);
});

test("ask rechaza mezclar flags tipados con --questions", async () => {
  const result = await run([
    "ask",
    "--state",
    "hola",
    "--noul",
    "q=¿?",
    "--questions",
    '{"q":{"type":"noul"}}',
  ]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /no se combinan/);
  assert.equal(result.calls.length, 0);
});

test("--asset ref=ruta carga la imagen y manda el header", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-asset-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const png = join(dir, "foto.png");
  await writeFile(png, pngBytes(300, 300));

  const result = await run([
    "ask",
    "--state",
    '{"foto":"ref-1"}',
    "--questions",
    '{"q":{"type":"noul","instructions":"¿Qué hay en ref-1?"}}',
    "--asset",
    "ref-1=" + png,
  ]);

  assert.equal(result.code, 0);
  const headers = new Headers(result.calls[0]?.init.headers);
  assert.equal(headers.get("typeSafe-danger-zone-images"), "true");
  const sent = JSON.parse(String(result.calls[0]?.init.body)) as {
    state: { foto: string };
    assets: Record<string, { format: string; data_base64: string }>;
  };
  assert.equal(sent.state.foto, "ref-1");
  assert.equal(sent.assets["ref-1"]?.format, "png");
  assert.ok(sent.assets["ref-1"]?.data_base64);
});

test("--assets-file lee el mapa assets completo", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-asset-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const png = join(dir, "foto.png");
  await writeFile(png, pngBytes(300, 300));

  const assetsFile = join(dir, "assets.json");
  await writeFile(assetsFile, JSON.stringify({ "ref-a": { path: png } }), "utf8");
  const file = await run([
    "ask",
    "--state",
    '{"foto":"ref-a"}',
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

test("--asset con data_base64 en --assets-file lo valida", async (t) => {
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
    '{"foto":"ref-b"}',
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

test("--no-images-header omite el header de imágenes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-asset-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const png = join(dir, "foto.png");
  await writeFile(png, pngBytes(300, 300));

  const result = await run([
    "ask",
    "--state",
    '{"foto":"ref-1"}',
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

test("--asset con imagen fuera de límites falla antes de llamar", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-asset-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const png = join(dir, "small.png");
  await writeFile(png, pngBytes(50, 50));

  const result = await run([
    "ask",
    "--state",
    "texto",
    "--questions",
    '{"q":{"type":"noul","instructions":"?"}}',
    "--asset",
    png,
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.match(result.stderr, /mínimo por lado/);
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

  const show = await run(["template", "show", "pedido", "--json"], { dbPath, env: {} });
  assert.equal(show.code, 0);
  const shown = JSON.parse(show.stdout) as { body: { state: unknown } };
  assert.deepEqual(shown.body.state, {
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

test("template guarda, conserva y limpia descripciones de macros", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const body = JSON.stringify({
    model: "m",
    state: { ticket: "{{ticket}}", plan: "{{cliente.plan}}" },
    questions: { q: { type: "noul" } },
  });
  const create = await run(
    [
      "template",
      "create",
      "pedido",
      "--body",
      body,
      "--macro-desc",
      "ticket=Identificador del pedido (TCK-1042)",
      "--macro-desc",
      "cliente.plan=free | pro | enterprise",
    ],
    { dbPath, env: {} },
  );
  assert.equal(create.code, 0);

  const listJson = await run(["template", "list", "--json"], { dbPath, env: {} });
  const listed = JSON.parse(listJson.stdout) as Array<{ macros: Array<{ name: string; description: string }> }>;
  assert.deepEqual(listed[0]?.macros, [
    { name: "cliente.plan", description: "free | pro | enterprise", schema: null },
    { name: "ticket", description: "Identificador del pedido (TCK-1042)", schema: null },
  ]);

  const showJson = await run(["template", "show", "pedido", "--json"], { dbPath, env: {} });
  assert.deepEqual(
    (JSON.parse(showJson.stdout) as { macros: unknown }).macros,
    listed[0]?.macros,
  );

  const human = await run(["template", "show", "pedido"], { dbPath, env: {} });
  assert.match(human.stdout, /\{\{ticket\}\}\n\s+Identificador del pedido/);

  // Editar el body sin flags conserva la descripción de las macros que siguen.
  const withoutPlan = JSON.stringify({
    model: "m",
    state: { ticket: "{{ticket}}" },
    questions: { q: { type: "noul" } },
  });
  const file = join(root, "body.json");
  await writeFile(file, withoutPlan, "utf8");
  assert.equal(
    (await run(["template", "edit", "pedido", "--file", file], { dbPath, env: {} })).code,
    0,
  );
  const trimmed = await run(["template", "show", "pedido", "--json"], { dbPath, env: {} });
  assert.deepEqual(
    (JSON.parse(trimmed.stdout) as { macros: unknown }).macros,
    [{ name: "ticket", description: "Identificador del pedido (TCK-1042)", schema: null }],
  );

  const cleared = await run(
    ["template", "edit", "pedido", "--file", file, "--clear-macro-desc", "ticket"],
    { dbPath, env: {} },
  );
  assert.equal(cleared.code, 0);
  const afterClear = await run(["template", "show", "pedido", "--json"], { dbPath, env: {} });
  assert.deepEqual(
    (JSON.parse(afterClear.stdout) as { macros: unknown }).macros,
    [{ name: "ticket", description: "", schema: null }],
  );

  const unknown = await run(
    ["template", "edit", "pedido", "--file", file, "--macro-desc", "nope=x"],
    { dbPath, env: {} },
  );
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /no está en el body/);

  const malformed = await run(
    ["template", "create", "otra", "--body", body, "--macro-desc", "sin-igual"],
    { dbPath, env: {} },
  );
  assert.equal(malformed.code, 2);
  assert.match(malformed.stderr, /espera <clave>=<texto>/);
});

test("template guarda, conserva y limpia esquemas de macros", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");

  const body = JSON.stringify({
    model: "m",
    state: { ticket: "{{ticket}}", plan: "{{cliente.plan}}" },
    questions: { q: { type: "noul" } },
  });
  const create = await run(
    [
      "template",
      "create",
      "pedido",
      "--body",
      body,
      "--macro-desc",
      "ticket=Identificador del pedido",
      "--macro-desc",
      "cliente.plan=Plan contratado",
      "--macro-schema",
      'ticket={"type":"string","format":"uuid"}',
      "--macro-type",
      "cliente.plan=string",
    ],
    { dbPath, env: {} },
  );
  assert.equal(create.code, 0);

  const expected = [
    {
      name: "cliente.plan",
      description: "Plan contratado",
      schema: { type: "string" },
    },
    {
      name: "ticket",
      description: "Identificador del pedido",
      schema: { type: "string", format: "uuid" },
    },
  ];
  const listJson = await run(["template", "list", "--json"], { dbPath, env: {} });
  assert.deepEqual(
    (JSON.parse(listJson.stdout) as Array<{ macros: unknown }>)[0]?.macros,
    expected,
  );
  const showJson = await run(["template", "show", "pedido", "--json"], { dbPath, env: {} });
  assert.deepEqual((JSON.parse(showJson.stdout) as { macros: unknown }).macros, expected);

  const human = await run(["template", "show", "pedido"], { dbPath, env: {} });
  assert.match(human.stdout, /\{\{ticket\}\}\n\s+Identificador del pedido\n\s+schema: \{"type":"string","format":"uuid"\}/);

  // `edit` sin flags de esquema conserva los existentes.
  const file = join(root, "body.json");
  await writeFile(file, body, "utf8");
  assert.equal(
    (await run(["template", "edit", "pedido", "--file", file], { dbPath, env: {} })).code,
    0,
  );
  const preserved = await run(["template", "show", "pedido", "--json"], { dbPath, env: {} });
  assert.deepEqual((JSON.parse(preserved.stdout) as { macros: unknown }).macros, expected);

  // `--macro-type` reemplaza solo el esquema de la macro indicada.
  assert.equal(
    (await run(["template", "edit", "pedido", "--file", file, "--macro-type", "ticket=boolean"], { dbPath, env: {} })).code,
    0,
  );
  const retyped = await run(["template", "show", "pedido", "--json"], { dbPath, env: {} });
  assert.deepEqual((JSON.parse(retyped.stdout) as { macros: unknown }).macros, [
    expected[0],
    { name: "ticket", description: "Identificador del pedido", schema: { type: "boolean" } },
  ]);

  // Limpiar el esquema conserva la descripción.
  assert.equal(
    (await run(["template", "edit", "pedido", "--file", file, "--clear-macro-schema", "ticket"], { dbPath, env: {} })).code,
    0,
  );
  const cleared = await run(["template", "show", "pedido", "--json"], { dbPath, env: {} });
  assert.deepEqual((JSON.parse(cleared.stdout) as { macros: unknown }).macros, [
    expected[0],
    { name: "ticket", description: "Identificador del pedido", schema: null },
  ]);

  // Los booleanos son JSON Schema válido.
  assert.equal(
    (await run(["template", "edit", "pedido", "--file", file, "--macro-schema", "ticket=false"], { dbPath, env: {} })).code,
    0,
  );
  const booleanSchema = await run(["template", "show", "pedido", "--json"], { dbPath, env: {} });
  assert.deepEqual(
    (JSON.parse(booleanSchema.stdout) as { macros: Array<{ schema: unknown }> }).macros[1]?.schema,
    false,
  );

  const invalidJson = await run(
    ["template", "create", "otra", "--body", body, "--macro-schema", "ticket={bad"],
    { dbPath, env: {} },
  );
  assert.equal(invalidJson.code, 2);
  assert.match(invalidJson.stderr, /no es JSON válido/);

  const invalidType = await run(
    ["template", "create", "otra", "--body", body, "--macro-type", "ticket=texto"],
    { dbPath, env: {} },
  );
  assert.equal(invalidType.code, 2);
  assert.match(invalidType.stderr, /--macro-type/);

  const invalidPattern = await run(
    ["template", "create", "otra", "--body", body, "--macro-schema", 'ticket={"pattern":"("}'],
    { dbPath, env: {} },
  );
  assert.equal(invalidPattern.code, 2);
  assert.match(invalidPattern.stderr, /pattern/);

  const unknown = await run(
    ["template", "edit", "pedido", "--file", file, "--macro-schema", "nope={}"],
    { dbPath, env: {} },
  );
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /no está en el body/);
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

  const show = await run(["templates", "show", "pedido", "--json"], { dbPath, env: {} });
  assert.equal(show.code, 0);
  assert.equal((JSON.parse(show.stdout) as { body: { model: string } }).body.model, "jev-1.13");

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

  const edited = await run(["templates", "show", "pedido", "--json"], {
    dbPath,
    env: {},
  });
  const editedShown = JSON.parse(edited.stdout) as { body: { questions: unknown } };
  assert.deepEqual(Object.keys(editedShown.body.questions as object), ["urgente"]);

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
