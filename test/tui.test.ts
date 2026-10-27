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

/** Presses a key using the same driver as the real TUI. */
function press(app: TuiApp, key: KeypressKey): void {
  const action = keyToAction(key);
  assert.ok(action !== null, `key without action: ${JSON.stringify(key)}`);
  app.handleAction(action);
}

function pressKey(app: TuiApp, key: keyof typeof SPECIAL_KEYS): void {
  press(app, SPECIAL_KEYS[key]);
}

/** Presses a printable character (preserves case). */
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
  pressKey(app, "down"); // Templates
  pressKey(app, "enter");
}

test("keyToAction translates common keys into canonical actions", () => {
  assert.equal(keyToAction({ name: "up" }), "up");
  assert.equal(keyToAction({ name: "return" }), "enter");
  assert.equal(keyToAction({ name: "escape" }), "esc");
  // readline marks a lone ESC with meta: true.
  assert.equal(
    keyToAction({ name: "escape", sequence: "\u001b", meta: true }),
    "esc",
  );
  // Alt+key is still ignored.
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

test("the editor preserves text case", () => {
  const app = new TuiApp(createTuiBackend(openDatabase(":memory:")));

  openTemplates(app);
  pressChar(app, "n"); // new
  typeText(app, "OrderCustomer");

  assert.match(app.render(), /Name: OrderCustomer/);
});

test("tui changes model and URL and persists to SQLite", () => {
  const db = openDatabase(":memory:");
  const backend = createTuiBackend(db);
  const app = new TuiApp(backend);

  pressKey(app, "enter"); // menu -> provider
  pressKey(app, "down"); // api_key
  pressKey(app, "down"); // model
  pressKey(app, "enter"); // edit model
  clearAndType(app, "jev-2.0");
  pressKey(app, "enter"); // save

  assert.equal(new ConfigRepository(db).get("model"), "jev-2.0");
  assert.match(app.render(), /settings saved: model/);

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

test("the API key is never shown in full on screen", () => {
  const db = openDatabase(":memory:");
  const backend = createTuiBackend(db);
  backend.setConfig("api_key", "sk-super-secret-123456");
  const app = new TuiApp(backend);

  pressKey(app, "enter"); // provider
  const frame = app.render();
  assert.ok(frame.includes(maskSecret("sk-super-secret-123456")));
  assert.ok(!frame.includes("sk-super-secret-123456"));

  pressKey(app, "down"); // api_key
  pressKey(app, "enter"); // edit api_key (empty input)
  typeText(app, "sk-new-key");
  const editing = app.render();
  assert.ok(!editing.includes("sk-new-key"));
  assert.ok(editing.includes("••••••••••"));
  pressKey(app, "enter");
  assert.equal(new ConfigRepository(db).get("api_key"), "sk-new-key");
});

test("the provider validates timeout and retries", () => {
  const db = openDatabase(":memory:");
  const app = new TuiApp(createTuiBackend(db));

  pressKey(app, "enter"); // provider
  pressKey(app, "down"); // api_key
  pressKey(app, "down"); // model
  pressKey(app, "down"); // timeout
  pressKey(app, "enter");
  clearAndType(app, "not-a-number");
  assert.match(app.render(), /timeout must be a positive number/);
  pressKey(app, "enter"); // does not save
  assert.equal(new ConfigRepository(db).get("timeout"), undefined);
});

test("q in provider returns to the menu", () => {
  const app = new TuiApp(createTuiBackend(openDatabase(":memory:")));

  pressKey(app, "enter"); // provider
  assert.match(app.render(), /Provider settings/);
  pressChar(app, "q");
  assert.match(app.render(), /Jev — interactive mode/);
  assert.equal(app.done, false);
});

test("tui creates, lists and edits a template with the real driver", () => {
  const db = openDatabase(":memory:");
  const backend = createTuiBackend(db);
  const app = new TuiApp(backend);

  openTemplates(app);
  pressChar(app, "N"); // new (commands ignore case)

  typeText(app, "order");
  pressKey(app, "enter"); // -> description
  typeText(app, "Order with customer");
  pressKey(app, "enter"); // -> body

  const body =
    '{"model":"jev-1.13","state":"{{state}}","questions":{"urgent":{"type":"noul"}}}';
  typeText(app, body);
  assert.match(app.render(), /macros: state/);

  pressKey(app, "enter"); // confirmation
  pressKey(app, "enter"); // yes -> save

  const saved = new TemplateRepository(db).get("order");
  assert.ok(saved !== undefined);
  assert.equal(saved.description, "Order with customer");
  assert.match(app.render(), /order - Order with customer/);

  pressChar(app, "e"); // edit (starts at description)
  clearAndType(app, "New description");
  pressKey(app, "enter"); // -> body
  clearAndType(
    app,
    '{"model":"jev-1.13","state":"{{state}}","questions":{"q":{"type":"noul"}}}',
  );
  pressKey(app, "enter"); // confirmation
  pressKey(app, "enter"); // yes -> save

  const edited = new TemplateRepository(db).get("order");
  assert.equal(edited?.description, "New description");
});

test("a body with invalid JSON is not saved and shows the error", () => {
  const db = openDatabase(":memory:");
  const app = new TuiApp(createTuiBackend(db));

  openTemplates(app);
  pressChar(app, "n");
  typeText(app, "t");
  pressKey(app, "enter");
  pressKey(app, "enter"); // -> body

  typeText(app, '{"model":"x"}'); // missing state
  assert.match(app.render(), /error: the template has no state/);
  pressKey(app, "enter"); // blocked
  assert.match(app.render(), /New template/);
  assert.ok(!app.render().includes("Save template"));
  assert.equal(new TemplateRepository(db).get("t"), undefined);
});

test("deleting a template asks for confirmation", () => {
  const db = openDatabase(":memory:");
  const backend = createTuiBackend(db);
  backend.saveTemplate("x", "", VALID_BODY);
  const app = new TuiApp(backend);

  openTemplates(app);
  pressChar(app, "d"); // delete
  assert.match(app.render(), /Delete template 'x'/);
  pressKey(app, "enter"); // yes
  assert.equal(new TemplateRepository(db).get("x"), undefined);
  assert.match(app.render(), /template deleted: x/);
});

test("/ enables search; typing filters, Backspace deletes and Esc/Enter exit", () => {
  const backend = createTuiBackend(openDatabase(":memory:"));
  backend.saveTemplate("alpha", "first", VALID_BODY);
  backend.saveTemplate("beta", "second", VALID_BODY);
  const app = new TuiApp(backend);

  openTemplates(app);
  pressChar(app, "/");
  assert.match(app.render(), /Search: █/);

  typeText(app, "be");
  assert.match(app.render(), /Search: be█/);
  assert.match(app.render(), /beta/);
  assert.ok(!app.render().includes("alpha"));

  pressKey(app, "backspace");
  assert.match(app.render(), /Search: b█/);

  pressKey(app, "esc");
  assert.doesNotMatch(app.render(), /Search: .*█/);
  assert.match(app.render(), /Search: b/);
  assert.match(app.render(), /beta/);
  assert.ok(!app.render().includes("alpha"));

  // Enter also exits the filter without opening the detail (the query is kept).
  pressChar(app, "/");
  clearLine(app); // clears the previous query
  typeText(app, "ph");
  pressKey(app, "enter");
  assert.doesNotMatch(app.render(), /Search: .*█/);
  assert.match(app.render(), /Search: ph/);
  assert.match(app.render(), /alpha/);
  assert.ok(!app.render().includes("beta"));

  // With an empty search all of them show up again.
  pressChar(app, "/");
  clearLine(app);
  pressKey(app, "esc");
  assert.match(app.render(), /alpha/);
  assert.match(app.render(), /beta/);
});

test("Enter opens the detail and e/d/b/q respond", () => {
  const backend = createTuiBackend(openDatabase(":memory:"));
  backend.saveTemplate("one", "first", VALID_BODY);
  const app = new TuiApp(backend);

  openTemplates(app);
  pressKey(app, "enter"); // detail
  assert.match(app.render(), /Template: one/);

  pressChar(app, "e"); // edit
  assert.match(app.render(), /Edit template: one/);
  pressKey(app, "esc"); // no changes -> list
  assert.match(app.render(), /Templates/);

  pressKey(app, "enter"); // detail
  pressChar(app, "b"); // back
  assert.match(app.render(), /Templates/);

  pressKey(app, "enter"); // detail
  pressChar(app, "d"); // delete -> confirmation
  assert.match(app.render(), /Delete template 'one'/);
  pressChar(app, "N"); // reject
  assert.match(app.render(), /Template: one/);

  pressChar(app, "q"); // back from the detail
  assert.match(app.render(), /Templates/);
  assert.equal(app.done, false);
});

test("confirmations accept s/S/y/Y/Enter and reject n/N/Esc", () => {
  for (const char of ["s", "S", "y", "Y"]) {
    const db = openDatabase(":memory:");
    const backend = createTuiBackend(db);
    backend.saveTemplate("x", "", VALID_BODY);
    const app = new TuiApp(backend);

    openTemplates(app);
    pressChar(app, "d");
    assert.match(app.render(), /Delete template 'x'/);
    pressChar(app, char);
    assert.equal(
      new TemplateRepository(db).get("x"),
      undefined,
      `should accept ${char}`,
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
      `should reject ${char}`,
    );
    assert.match(app.render(), /Templates/);
  }

  const db = openDatabase(":memory:");
  const backend = createTuiBackend(db);
  backend.saveTemplate("x", "", VALID_BODY);
  const app = new TuiApp(backend);
  openTemplates(app);
  pressChar(app, "d");
  pressKey(app, "esc");
  assert.ok(new TemplateRepository(db).get("x") !== undefined);
  assert.match(app.render(), /Templates/);
});

test("q in Templates returns to the menu", () => {
  const app = new TuiApp(createTuiBackend(openDatabase(":memory:")));

  openTemplates(app);
  assert.match(app.render(), /Templates/);
  pressChar(app, "q");
  assert.match(app.render(), /Jev — interactive mode/);
  assert.equal(app.done, false);
});

test("Ctrl-A, Ctrl-E, Delete and Backspace still work while editing", () => {
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

test("quitting with unsaved changes asks for confirmation", () => {
  const db = openDatabase(":memory:");
  const app = new TuiApp(createTuiBackend(db));

  openTemplates(app);
  pressChar(app, "n");
  typeText(app, "x"); // unsaved changes

  pressKey(app, "ctrlC"); // tries to quit
  assert.match(app.render(), /There are unsaved changes/);
  pressChar(app, "n"); // no -> returns to the editor
  assert.match(app.render(), /New template/);

  pressKey(app, "ctrlC");
  pressKey(app, "enter"); // yes -> quits
  assert.equal(app.done, true);
  assert.equal(app.exitCode, 0);
});

test("q from the main menu quits (ignoring case)", () => {
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

test("discarding changes returns to templates without saving", () => {
  const db = openDatabase(":memory:");
  const app = new TuiApp(createTuiBackend(db));

  openTemplates(app);
  pressChar(app, "n");
  typeText(app, "y");
  pressKey(app, "esc"); // discard
  assert.match(app.render(), /Discard unsaved changes/);
  pressKey(app, "enter"); // yes
  assert.match(app.render(), /Templates/);
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

test("tui without a TTY returns a clear error with the equivalent commands", async () => {
  const result = await runTuiCli(["tui"], { isTty: false });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /requires a terminal/);
  assert.match(result.stderr, /jev config set/);
  assert.match(result.stderr, /jev template/);
});

test("tui --help shows usage", async () => {
  const result = await runTuiCli(["tui", "--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /interactive mode/);
});

test("tui with a TTY delegates to the injected runner", async () => {
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
