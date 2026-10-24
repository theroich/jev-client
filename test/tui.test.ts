import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, type CliIO } from "../src/cli.js";
import { ConfigRepository } from "../src/config-repository.js";
import { openDatabase } from "../src/database.js";
import { maskSecret } from "../src/format.js";
import { TemplateRepository } from "../src/template-repository.js";
import {
  createTuiBackend,
  keyToAction,
  TuiApp,
  type TuiBackend,
} from "../src/tui.js";

function typeText(app: TuiApp, text: string): void {
  for (const char of text) {
    app.handleAction(`char:${char}`);
  }
}

function clearLine(app: TuiApp): void {
  for (let i = 0; i < 500; i += 1) {
    app.handleAction("backspace");
  }
}

function clearAndType(app: TuiApp, text: string): void {
  clearLine(app);
  typeText(app, text);
}

test("keyToAction traduce las teclas comunes", () => {
  assert.equal(keyToAction({ name: "up" }), "up");
  assert.equal(keyToAction({ name: "return" }), "enter");
  assert.equal(keyToAction({ name: "escape" }), "esc");
  assert.equal(keyToAction({ name: "backspace" }), "backspace");
  assert.equal(keyToAction({ ctrl: true, name: "c" }), "ctrl-c");
  assert.equal(keyToAction({ sequence: "a" }), "char:a");
  assert.equal(keyToAction({ sequence: "\u001b[A" }), null);
});

test("tui cambia modelo y URL y persiste en SQLite", () => {
  const db = openDatabase(":memory:");
  const backend = createTuiBackend(db);
  const app = new TuiApp(backend);

  app.handleAction("enter"); // menu -> provider
  app.handleAction("down"); // api_key
  app.handleAction("down"); // model
  app.handleAction("enter"); // editar model
  clearAndType(app, "jev-2.0");
  app.handleAction("enter"); // guardar

  assert.equal(new ConfigRepository(db).get("model"), "jev-2.0");
  assert.match(app.render(), /configuración guardada: model/);

  app.handleAction("up"); // model -> api_key
  app.handleAction("up"); // api_key -> api_url
  app.handleAction("enter");
  clearAndType(app, "https://example.test/systemone");
  app.handleAction("enter");

  assert.equal(
    new ConfigRepository(db).get("api_url"),
    "https://example.test/systemone",
  );
});

test("la API key nunca se muestra completa en pantalla", () => {
  const db = openDatabase(":memory:");
  const backend = createTuiBackend(db);
  backend.setConfig("api_key", "sk-super-secret-123456");
  const app = new TuiApp(backend);

  app.handleAction("enter"); // provider
  const frame = app.render();
  assert.ok(frame.includes(maskSecret("sk-super-secret-123456")));
  assert.ok(!frame.includes("sk-super-secret-123456"));

  app.handleAction("down"); // api_key
  app.handleAction("enter"); // editar api_key (input vacío)
  typeText(app, "sk-nueva-key");
  const editing = app.render();
  assert.ok(!editing.includes("sk-nueva-key"));
  assert.ok(editing.includes("••••••••••••"));
  app.handleAction("enter");
  assert.equal(new ConfigRepository(db).get("api_key"), "sk-nueva-key");
});

test("el provider valida timeout y retries", () => {
  const db = openDatabase(":memory:");
  const app = new TuiApp(createTuiBackend(db));

  app.handleAction("enter"); // provider
  app.handleAction("down"); // api_key
  app.handleAction("down"); // model
  app.handleAction("down"); // timeout
  app.handleAction("enter");
  clearAndType(app, "no-un-numero");
  assert.match(app.render(), /timeout debe ser un número positivo/);
  app.handleAction("enter"); // no guarda
  assert.equal(new ConfigRepository(db).get("timeout"), undefined);
});

test("tui crea, lista y edita una plantilla", () => {
  const db = openDatabase(":memory:");
  const backend = createTuiBackend(db);
  const app = new TuiApp(backend);

  app.handleAction("down"); // Plantillas
  app.handleAction("enter");
  app.handleAction("n"); // nueva

  typeText(app, "pedido");
  app.handleAction("enter"); // -> descripción
  typeText(app, "Pedido con cliente");
  app.handleAction("enter"); // -> body

  const body =
    '{"model":"jev-1.13","state":"{{estado}}","questions":{"urgent":{"type":"noul"}}}';
  typeText(app, body);
  assert.match(app.render(), /macros: estado/);

  app.handleAction("enter"); // confirmación
  app.handleAction("enter"); // sí -> guardar

  const saved = new TemplateRepository(db).get("pedido");
  assert.ok(saved !== undefined);
  assert.equal(saved.description, "Pedido con cliente");
  assert.match(app.render(), /pedido - Pedido con cliente/);

  app.handleAction("e"); // editar (empieza en descripción)
  clearAndType(app, "Descripción nueva");
  app.handleAction("enter"); // -> body
  clearAndType(
    app,
    '{"model":"jev-1.13","state":"{{estado}}","questions":{"q":{"type":"noul"}}}',
  );
  app.handleAction("enter"); // confirmación
  app.handleAction("enter"); // sí -> guardar

  const edited = new TemplateRepository(db).get("pedido");
  assert.equal(edited?.description, "Descripción nueva");
});

test("el body con JSON inválido no se guarda y muestra el error", () => {
  const db = openDatabase(":memory:");
  const app = new TuiApp(createTuiBackend(db));

  app.handleAction("down");
  app.handleAction("enter");
  app.handleAction("n");
  typeText(app, "t");
  app.handleAction("enter");
  app.handleAction("enter"); // -> body

  typeText(app, '{"model":"x"}'); // falta state
  assert.match(app.render(), /error: la plantilla no tiene state/);
  app.handleAction("enter"); // bloqueado
  assert.match(app.render(), /Nueva plantilla/);
  assert.ok(!app.render().includes("¿Guardar"));
  assert.equal(new TemplateRepository(db).get("t"), undefined);
});

test("borrar una plantilla pide confirmación", () => {
  const db = openDatabase(":memory:");
  const backend = createTuiBackend(db);
  backend.saveTemplate(
    "x",
    "",
    '{"model":"m","state":"s","questions":{"q":{"type":"noul"}}}',
  );
  const app = new TuiApp(backend);

  app.handleAction("down");
  app.handleAction("enter"); // plantillas
  app.handleAction("d"); // borrar
  assert.match(app.render(), /¿Eliminar la plantilla 'x'/);
  app.handleAction("enter"); // sí
  assert.equal(new TemplateRepository(db).get("x"), undefined);
});

test("salir con cambios sin guardar pide confirmación", () => {
  const db = openDatabase(":memory:");
  const app = new TuiApp(createTuiBackend(db));

  app.handleAction("down");
  app.handleAction("enter");
  app.handleAction("n");
  typeText(app, "x"); // cambios sin guardar

  app.handleAction("ctrl-c"); // intenta salir
  assert.match(app.render(), /Hay cambios sin guardar/);
  app.handleAction("char:n"); // no -> vuelve al editor
  assert.match(app.render(), /Nueva plantilla/);

  app.handleAction("ctrl-c");
  app.handleAction("enter"); // sí -> sale
  assert.equal(app.done, true);
  assert.equal(app.exitCode, 0);
});

test("descartar cambios vuelve a plantillas sin guardar", () => {
  const db = openDatabase(":memory:");
  const app = new TuiApp(createTuiBackend(db));

  app.handleAction("down");
  app.handleAction("enter");
  app.handleAction("n");
  typeText(app, "y");
  app.handleAction("esc"); // descartar
  assert.match(app.render(), /Descartar los cambios/);
  app.handleAction("enter"); // sí
  assert.match(app.render(), /Plantillas/);
  assert.equal(new TemplateRepository(db).get("y"), undefined);
});

test("q desde el menú sale sin cambios", () => {
  const app = new TuiApp(createTuiBackend(openDatabase(":memory:")));
  assert.equal(app.done, false);
  app.handleAction("q");
  assert.equal(app.done, true);
  assert.equal(app.exitCode, 0);
});

interface TuiCliResult {
  code: number;
  stdout: string;
  stderr: string;
  backend?: TuiBackend;
}

async function runTuiCli(
  argv: string[],
  options: { isTty?: boolean; runner?: (backend: TuiBackend) => Promise<number> } = {},
): Promise<TuiCliResult> {
  let stdout = "";
  let stderr = "";
  let backend: TuiBackend | undefined;
  const io: CliIO = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readStdin: async () => "",
    isTty: options.isTty,
    runTui: options.runner
      ? async (value) => {
          backend = value;
          return options.runner!(value);
        }
      : undefined,
  };
  const code = await runCli(argv, io);
  return { code, stdout, stderr, backend };
}

test("tui sin TTY devuelve error claro con los comandos equivalentes", async () => {
  const result = await runTuiCli(["tui"], { isTty: false });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /requiere una terminal/);
  assert.match(result.stderr, /jev config set/);
  assert.match(result.stderr, /jev template/);
});

test("tui --help muestra el uso", async () => {
  const result = await runTuiCli(["tui", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /modo interactivo/);
});

test("tui con TTY delega en el runner inyectado", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-tui-"));
  try {
    const dbPath = join(dir, "jev.db");
    const result = await runTuiCli(["tui", "--db", dbPath], {
      isTty: true,
      runner: async () => 7,
    });
    assert.equal(result.code, 7);
    assert.ok(result.backend !== undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
