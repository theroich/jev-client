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
  type KeypressKey,
  type TuiBackend,
} from "../src/tui.js";

const VALID_BODY =
  '{"model":"m","state":"s","questions":{"q":{"type":"noul"}}}';

const SPECIAL_KEYS = {
  up: { name: "up" },
  down: { name: "down" },
  left: { name: "left" },
  right: { name: "right" },
  enter: { name: "return" },
  esc: { name: "escape", sequence: "\u001b", meta: true },
  backspace: { name: "backspace" },
  delete: { name: "delete" },
  ctrlA: { ctrl: true, name: "a" },
  ctrlC: { ctrl: true, name: "c" },
  ctrlE: { ctrl: true, name: "e" },
} satisfies Record<string, KeypressKey>;

/** Pulsa una tecla usando el mismo driver que la TUI real. */
function press(app: TuiApp, key: KeypressKey): void {
  const action = keyToAction(key);
  assert.ok(action !== null, `tecla sin acción: ${JSON.stringify(key)}`);
  app.handleAction(action);
}

function pressKey(app: TuiApp, key: keyof typeof SPECIAL_KEYS): void {
  press(app, SPECIAL_KEYS[key]);
}

/** Pulsa un carácter imprimible (conserva mayúsculas/minúsculas). */
function pressChar(app: TuiApp, char: string): void {
  press(app, { name: char, sequence: char });
}

function typeText(app: TuiApp, text: string): void {
  for (const char of text) {
    pressChar(app, char);
  }
}

function clearLine(app: TuiApp): void {
  for (let i = 0; i < 500; i += 1) {
    pressKey(app, "backspace");
  }
}

function clearAndType(app: TuiApp, text: string): void {
  clearLine(app);
  typeText(app, text);
}

function openTemplates(app: TuiApp): void {
  pressKey(app, "down"); // Plantillas
  pressKey(app, "enter");
}

test("keyToAction traduce las teclas comunes a acciones canónicas", () => {
  assert.equal(keyToAction({ name: "up" }), "up");
  assert.equal(keyToAction({ name: "return" }), "enter");
  assert.equal(keyToAction({ name: "escape" }), "esc");
  // readline marca el ESC solitario con meta: true.
  assert.equal(
    keyToAction({ name: "escape", sequence: "\u001b", meta: true }),
    "esc",
  );
  // Alt+tecla sigue ignorándose.
  assert.equal(keyToAction({ name: "x", sequence: "\u001bx", meta: true }), null);
  assert.equal(keyToAction({ name: "backspace" }), "backspace");
  assert.equal(keyToAction({ ctrl: true, name: "c" }), "ctrl-c");
  assert.equal(keyToAction({ sequence: "a" }), "char:a");
  assert.equal(keyToAction({ sequence: "A" }), "char:A");
  assert.equal(keyToAction({ sequence: "n" }), "char:n");
  assert.equal(keyToAction({ sequence: "N" }), "char:N");
  assert.equal(keyToAction({ sequence: "/" }), "char:/");
  assert.equal(keyToAction({ sequence: "\u001b[A" }), null);
});

test("el editor conserva mayúsculas y minúsculas del texto", () => {
  const app = new TuiApp(createTuiBackend(openDatabase(":memory:")));

  openTemplates(app);
  pressChar(app, "n"); // nueva
  typeText(app, "PedidoCliente");

  assert.match(app.render(), /Nombre: PedidoCliente/);
});

test("tui cambia modelo y URL y persiste en SQLite", () => {
  const db = openDatabase(":memory:");
  const backend = createTuiBackend(db);
  const app = new TuiApp(backend);

  pressKey(app, "enter"); // menu -> provider
  pressKey(app, "down"); // api_key
  pressKey(app, "down"); // model
  pressKey(app, "enter"); // editar model
  clearAndType(app, "jev-2.0");
  pressKey(app, "enter"); // guardar

  assert.equal(new ConfigRepository(db).get("model"), "jev-2.0");
  assert.match(app.render(), /configuración guardada: model/);

  pressKey(app, "up"); // model -> api_key
  pressKey(app, "up"); // api_key -> api_url
  pressKey(app, "enter");
  clearAndType(app, "https://example.test/systemone");
  pressKey(app, "enter");

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

  pressKey(app, "enter"); // provider
  const frame = app.render();
  assert.ok(frame.includes(maskSecret("sk-super-secret-123456")));
  assert.ok(!frame.includes("sk-super-secret-123456"));

  pressKey(app, "down"); // api_key
  pressKey(app, "enter"); // editar api_key (input vacío)
  typeText(app, "sk-nueva-key");
  const editing = app.render();
  assert.ok(!editing.includes("sk-nueva-key"));
  assert.ok(editing.includes("••••••••••••"));
  pressKey(app, "enter");
  assert.equal(new ConfigRepository(db).get("api_key"), "sk-nueva-key");
});

test("el provider valida timeout y retries", () => {
  const db = openDatabase(":memory:");
  const app = new TuiApp(createTuiBackend(db));

  pressKey(app, "enter"); // provider
  pressKey(app, "down"); // api_key
  pressKey(app, "down"); // model
  pressKey(app, "down"); // timeout
  pressKey(app, "enter");
  clearAndType(app, "no-un-numero");
  assert.match(app.render(), /timeout debe ser un número positivo/);
  pressKey(app, "enter"); // no guarda
  assert.equal(new ConfigRepository(db).get("timeout"), undefined);
});

test("q en provider vuelve al menú", () => {
  const app = new TuiApp(createTuiBackend(openDatabase(":memory:")));

  pressKey(app, "enter"); // provider
  assert.match(app.render(), /Configuración del provider/);
  pressChar(app, "q");
  assert.match(app.render(), /Jev — modo interactivo/);
  assert.equal(app.done, false);
});

test("tui crea, lista y edita una plantilla con el driver real", () => {
  const db = openDatabase(":memory:");
  const backend = createTuiBackend(db);
  const app = new TuiApp(backend);

  openTemplates(app);
  pressChar(app, "N"); // nueva (los comandos no distinguen mayúsculas)

  typeText(app, "pedido");
  pressKey(app, "enter"); // -> descripción
  typeText(app, "Pedido con cliente");
  pressKey(app, "enter"); // -> body

  const body =
    '{"model":"jev-1.13","state":"{{estado}}","questions":{"urgent":{"type":"noul"}}}';
  typeText(app, body);
  assert.match(app.render(), /macros: estado/);

  pressKey(app, "enter"); // confirmación
  pressKey(app, "enter"); // sí -> guardar

  const saved = new TemplateRepository(db).get("pedido");
  assert.ok(saved !== undefined);
  assert.equal(saved.description, "Pedido con cliente");
  assert.match(app.render(), /pedido - Pedido con cliente/);

  pressChar(app, "e"); // editar (empieza en descripción)
  clearAndType(app, "Descripción Nueva");
  pressKey(app, "enter"); // -> body
  clearAndType(
    app,
    '{"model":"jev-1.13","state":"{{estado}}","questions":{"q":{"type":"noul"}}}',
  );
  pressKey(app, "enter"); // confirmación
  pressKey(app, "enter"); // sí -> guardar

  const edited = new TemplateRepository(db).get("pedido");
  assert.equal(edited?.description, "Descripción Nueva");
});

test("el body con JSON inválido no se guarda y muestra el error", () => {
  const db = openDatabase(":memory:");
  const app = new TuiApp(createTuiBackend(db));

  openTemplates(app);
  pressChar(app, "n");
  typeText(app, "t");
  pressKey(app, "enter");
  pressKey(app, "enter"); // -> body

  typeText(app, '{"model":"x"}'); // falta state
  assert.match(app.render(), /error: la plantilla no tiene state/);
  pressKey(app, "enter"); // bloqueado
  assert.match(app.render(), /Nueva plantilla/);
  assert.ok(!app.render().includes("¿Guardar"));
  assert.equal(new TemplateRepository(db).get("t"), undefined);
});

test("borrar una plantilla pide confirmación", () => {
  const db = openDatabase(":memory:");
  const backend = createTuiBackend(db);
  backend.saveTemplate("x", "", VALID_BODY);
  const app = new TuiApp(backend);

  openTemplates(app);
  pressChar(app, "d"); // borrar
  assert.match(app.render(), /¿Eliminar la plantilla 'x'/);
  pressKey(app, "enter"); // sí
  assert.equal(new TemplateRepository(db).get("x"), undefined);
  assert.match(app.render(), /plantilla eliminada: x/);
});

test("/ activa la búsqueda; escribir filtra, Backspace borra y Esc/Enter salen", () => {
  const backend = createTuiBackend(openDatabase(":memory:"));
  backend.saveTemplate("alfa", "primera", VALID_BODY);
  backend.saveTemplate("beta", "segunda", VALID_BODY);
  const app = new TuiApp(backend);

  openTemplates(app);
  pressChar(app, "/");
  assert.match(app.render(), /Buscar: █/);

  typeText(app, "be");
  assert.match(app.render(), /Buscar: be█/);
  assert.match(app.render(), /beta/);
  assert.ok(!app.render().includes("alfa"));

  pressKey(app, "backspace");
  assert.match(app.render(), /Buscar: b█/);

  pressKey(app, "esc");
  assert.doesNotMatch(app.render(), /Buscar: .*█/);
  assert.match(app.render(), /Buscar: b/);
  assert.match(app.render(), /beta/);
  assert.ok(!app.render().includes("alfa"));

  // Enter también sale del filtro sin abrir el detalle (la query se conserva).
  pressChar(app, "/");
  clearLine(app); // borra la query anterior
  typeText(app, "al");
  pressKey(app, "enter");
  assert.doesNotMatch(app.render(), /Buscar: .*█/);
  assert.match(app.render(), /Buscar: al/);
  assert.match(app.render(), /alfa/);
  assert.ok(!app.render().includes("beta"));

  // Con la búsqueda vacía vuelven a aparecer todas.
  pressChar(app, "/");
  clearLine(app);
  pressKey(app, "esc");
  assert.match(app.render(), /alfa/);
  assert.match(app.render(), /beta/);
});

test("Enter abre el detalle y e/d/b/q responden", () => {
  const backend = createTuiBackend(openDatabase(":memory:"));
  backend.saveTemplate("uno", "primera", VALID_BODY);
  const app = new TuiApp(backend);

  openTemplates(app);
  pressKey(app, "enter"); // detalle
  assert.match(app.render(), /Plantilla: uno/);

  pressChar(app, "e"); // editar
  assert.match(app.render(), /Editar plantilla: uno/);
  pressKey(app, "esc"); // sin cambios -> listado
  assert.match(app.render(), /Plantillas/);

  pressKey(app, "enter"); // detalle
  pressChar(app, "b"); // volver
  assert.match(app.render(), /Plantillas/);

  pressKey(app, "enter"); // detalle
  pressChar(app, "d"); // borrar -> confirmación
  assert.match(app.render(), /¿Eliminar la plantilla 'uno'/);
  pressChar(app, "N"); // rechazar
  assert.match(app.render(), /Plantilla: uno/);

  pressChar(app, "q"); // volver desde el detalle
  assert.match(app.render(), /Plantillas/);
  assert.equal(app.done, false);
});

test("las confirmaciones aceptan s/S/y/Y/Enter y rechazan n/N/Esc", () => {
  for (const char of ["s", "S", "y", "Y"]) {
    const db = openDatabase(":memory:");
    const backend = createTuiBackend(db);
    backend.saveTemplate("x", "", VALID_BODY);
    const app = new TuiApp(backend);

    openTemplates(app);
    pressChar(app, "d");
    assert.match(app.render(), /¿Eliminar la plantilla 'x'/);
    pressChar(app, char);
    assert.equal(
      new TemplateRepository(db).get("x"),
      undefined,
      `debería aceptar ${char}`,
    );
  }

  for (const char of ["n", "N"]) {
    const db = openDatabase(":memory:");
    const backend = createTuiBackend(db);
    backend.saveTemplate("x", "", VALID_BODY);
    const app = new TuiApp(backend);

    openTemplates(app);
    pressChar(app, "d");
    pressChar(app, char);
    assert.ok(
      new TemplateRepository(db).get("x") !== undefined,
      `debería rechazar ${char}`,
    );
    assert.match(app.render(), /Plantillas/);
  }

  const db = openDatabase(":memory:");
  const backend = createTuiBackend(db);
  backend.saveTemplate("x", "", VALID_BODY);
  const app = new TuiApp(backend);
  openTemplates(app);
  pressChar(app, "d");
  pressKey(app, "esc");
  assert.ok(new TemplateRepository(db).get("x") !== undefined);
  assert.match(app.render(), /Plantillas/);
});

test("q en Plantillas vuelve al menú", () => {
  const app = new TuiApp(createTuiBackend(openDatabase(":memory:")));

  openTemplates(app);
  assert.match(app.render(), /Plantillas/);
  pressChar(app, "q");
  assert.match(app.render(), /Jev — modo interactivo/);
  assert.equal(app.done, false);
});

test("Ctrl-A, Ctrl-E, Delete y Backspace siguen funcionando al editar", () => {
  const app = new TuiApp(createTuiBackend(openDatabase(":memory:")));

  pressKey(app, "enter"); // provider
  pressKey(app, "enter"); // api_url
  clearAndType(app, "abc");

  pressKey(app, "ctrlA");
  typeText(app, "X");
  assert.match(app.render(), /URL > X█abc/);

  pressKey(app, "ctrlE");
  typeText(app, "Y");
  assert.match(app.render(), /URL > XabcY/);

  pressKey(app, "left");
  pressKey(app, "delete");
  assert.match(app.render(), /URL > Xabc█/);

  pressKey(app, "backspace");
  assert.match(app.render(), /URL > Xab█/);
});

test("salir con cambios sin guardar pide confirmación", () => {
  const db = openDatabase(":memory:");
  const app = new TuiApp(createTuiBackend(db));

  openTemplates(app);
  pressChar(app, "n");
  typeText(app, "x"); // cambios sin guardar

  pressKey(app, "ctrlC"); // intenta salir
  assert.match(app.render(), /Hay cambios sin guardar/);
  pressChar(app, "n"); // no -> vuelve al editor
  assert.match(app.render(), /Nueva plantilla/);

  pressKey(app, "ctrlC");
  pressKey(app, "enter"); // sí -> sale
  assert.equal(app.done, true);
  assert.equal(app.exitCode, 0);
});

test("q desde el menú principal sale (sin distinguir mayúsculas)", () => {
  const app = new TuiApp(createTuiBackend(openDatabase(":memory:")));
  assert.equal(app.done, false);
  pressChar(app, "q");
  assert.equal(app.done, true);
  assert.equal(app.exitCode, 0);

  const upper = new TuiApp(createTuiBackend(openDatabase(":memory:")));
  pressChar(upper, "Q");
  assert.equal(upper.done, true);
  assert.equal(upper.exitCode, 0);
});

test("descartar cambios vuelve a plantillas sin guardar", () => {
  const db = openDatabase(":memory:");
  const app = new TuiApp(createTuiBackend(db));

  openTemplates(app);
  pressChar(app, "n");
  typeText(app, "y");
  pressKey(app, "esc"); // descartar
  assert.match(app.render(), /Descartar los cambios/);
  pressKey(app, "enter"); // sí
  assert.match(app.render(), /Plantillas/);
  assert.equal(new TemplateRepository(db).get("y"), undefined);
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
