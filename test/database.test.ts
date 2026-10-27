import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ConfigRepository } from "../src/config-repository.js";
import { openSqlite } from "../src/sqlite.js";
import { TemplateRepository } from "../src/template-repository.js";
import {
  SCHEMA_VERSION,
  defaultDatabasePath,
  migrateDatabase,
  openDatabase,
  resolveDatabasePath,
} from "../src/database.js";

test("the path uses the OS home and the --db > JEV_DB precedence", () => {
  const defaultPath = join(homedir(), ".jev-client", "db", "jev.db");
  assert.equal(defaultDatabasePath(), defaultPath);
  assert.equal(resolveDatabasePath(undefined, {}), defaultPath);
  assert.equal(
    resolveDatabasePath(undefined, { JEV_DB: "env.db" }),
    resolve("env.db"),
  );
  assert.equal(
    resolveDatabasePath("flag.db", { JEV_DB: "env.db" }),
    resolve("flag.db"),
  );
  assert.equal(resolveDatabasePath(":memory:"), ":memory:");
});

test("creates .jev-client/db and the database with restrictive permissions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, ".jev-client", "db");
  const path = join(directory, "jev.db");

  const db = openDatabase(path);
  db.close();

  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test("migrations are idempotent and preserve the data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "jev.db");

  let db = openDatabase(path);
  let repository = new ConfigRepository(db);
  repository.set("model", "jev-1.13-free");
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  migrateDatabase(db);
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  db.close();

  db = openDatabase(path);
  repository = new ConfigRepository(db);
  assert.equal(repository.get("model"), "jev-1.13-free");
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'config'").get(),
    { name: "config" },
  );
  db.close();
});

test("the repository implements get, set, unset and list", () => {
  const db = openDatabase(":memory:");
  const repository = new ConfigRepository(db);

  assert.equal(repository.get("model"), undefined);
  repository.set("model", "jev-1.13-free");
  repository.set("timeout", "15");
  repository.set("model", "jev-1.13");
  assert.equal(repository.get("model"), "jev-1.13");
  assert.deepEqual(repository.list(), [
    { key: "model", value: "jev-1.13" },
    { key: "timeout", value: "15" },
  ]);
  assert.equal(repository.unset("model"), true);
  assert.equal(repository.unset("model"), false);
  assert.equal(repository.get("model"), undefined);

  db.close();
});

test("a database with a newer schema is not opened", () => {
  const db = openDatabase(":memory:");
  db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
  assert.throws(() => migrateDatabase(db), /schema/);
  db.close();
});

test("updates from v1 to v2 preserving config and creating templates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "jev.db");

  const legacy = openSqlite(path);
  legacy.exec(
    "CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  legacy
    .prepare("INSERT INTO config (key, value) VALUES (?, ?)")
    .run("model", "legacy-model");
  legacy.pragma("user_version = 1");
  legacy.close();

  const db = openDatabase(path);
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.equal(new ConfigRepository(db).get("model"), "legacy-model");
  assert.deepEqual(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'templates'",
      )
      .get(),
    { name: "templates" },
  );
  db.close();
});

test("updates from v3 to v4 creating template_macros without backfill", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "jev.db");

  const legacy = openSqlite(path);
  legacy.exec(`
    CREATE TABLE templates (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      body_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  legacy
    .prepare(
      "INSERT INTO templates (name, description, body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("legacy", "", '{"model":"m","state":"{{state}}"}', "2024-01-01", "2024-01-01");
  legacy.pragma("user_version = 3");
  legacy.close();

  const db = openDatabase(path);
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.equal(
    db.prepare("SELECT description FROM templates WHERE name = 'legacy'").get() !== undefined,
    true,
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'template_macros'",
      )
      .get(),
    { name: "template_macros" },
  );
  // A v3 database without backfill works: the repository merges the body macros.
  assert.deepEqual(new TemplateRepository(db).get("legacy")?.macros, [
    { name: "state", description: "", schema: null },
  ]);
  db.close();
});

test("updates from v4 to v5 adding schema_json without backfill", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "jev.db");

  const legacy = openSqlite(path);
  legacy.exec(`
    CREATE TABLE templates (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      body_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE template_macros (
      template_name TEXT NOT NULL,
      macro TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (template_name, macro),
      FOREIGN KEY (template_name) REFERENCES templates (name)
        ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  legacy
    .prepare(
      "INSERT INTO templates (name, description, body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("legacy", "", '{"model":"m","state":"{{state}}"}', "2024-01-01", "2024-01-01");
  legacy
    .prepare(
      "INSERT INTO template_macros (template_name, macro, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("legacy", "state", "Previous state", "2024-01-01", "2024-01-01");
  legacy.pragma("user_version = 4");
  legacy.close();

  const db = openDatabase(path);
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  const columns = db
    .prepare<[], { name: string }>("PRAGMA table_info(template_macros)")
    .all()
    .map((column) => column.name);
  assert.ok(columns.includes("schema_json"));
  assert.deepEqual(new TemplateRepository(db).get("legacy")?.macros, [
    { name: "state", description: "Previous state", schema: null },
  ]);
  // Reapplying the migration does not duplicate the column or lose rows.
  migrateDatabase(db);
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.deepEqual(
    db.prepare("SELECT macro, description, schema_json FROM template_macros").all(),
    [{ macro: "state", description: "Previous state", schema_json: null }],
  );
  db.close();
});

test("the repository saves, preserves and clears macro schemas", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);
  const body = JSON.stringify({
    model: "m",
    state: { plan: "{{plan}}", ticket: "{{ticket}}" },
    questions: { q: { type: "noul" } },
  });

  repository.save("order", "", body, [
    { name: "plan", description: "Contracted plan", schema: { type: "string", enum: ["free", "pro"] } },
    { name: "ticket", description: "Ticket", schema: true },
  ]);
  assert.deepEqual(repository.get("order")?.macros, [
    { name: "plan", description: "Contracted plan", schema: { type: "string", enum: ["free", "pro"] } },
    { name: "ticket", description: "Ticket", schema: true },
  ]);
  assert.deepEqual(
    db
      .prepare("SELECT macro, description, schema_json FROM template_macros ORDER BY macro")
      .all(),
    [
      { macro: "plan", description: "Contracted plan", schema_json: '{"type":"string","enum":["free","pro"]}' },
      { macro: "ticket", description: "Ticket", schema_json: "true" },
    ],
  );

  // Without explicit metadata, description and schema are preserved.
  repository.save("order", "", body);
  assert.deepEqual(repository.get("order")?.macros, [
    { name: "plan", description: "Contracted plan", schema: { type: "string", enum: ["free", "pro"] } },
    { name: "ticket", description: "Ticket", schema: true },
  ]);

  // `schema: null` clears the schema and preserves the description.
  repository.save("order", "", body, [
    { name: "plan", description: "Contracted plan", schema: null },
    { name: "ticket", description: "Ticket", schema: false },
  ]);
  assert.deepEqual(repository.get("order")?.macros, [
    { name: "plan", description: "Contracted plan", schema: null },
    { name: "ticket", description: "Ticket", schema: false },
  ]);

  repository.rename("order", "order-2");
  assert.deepEqual(repository.get("order-2")?.macros, [
    { name: "plan", description: "Contracted plan", schema: null },
    { name: "ticket", description: "Ticket", schema: false },
  ]);

  assert.equal(repository.remove("order-2"), true);
  assert.deepEqual(
    db.prepare("SELECT COUNT(*) AS total FROM template_macros").get(),
    { total: 0 },
  );
  db.close();
});

test("updates from v5 to v6 adding source to requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "jev.db");

  const legacy = openSqlite(path);
  legacy.exec(`
    CREATE TABLE requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      ok INTEGER NOT NULL
    )
  `);
  legacy.pragma("user_version = 5");
  legacy.close();

  const db = openDatabase(path);
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  const columns = db
    .prepare<[], { name: string }>("PRAGMA table_info(requests)")
    .all()
    .map((column) => column.name);
  assert.ok(columns.includes("source"));
  // The default is 'cli' and reapplying does not duplicate the column.
  migrateDatabase(db);
  const source = db
    .prepare<[], { dflt_value: string | null }>(
      "SELECT dflt_value FROM pragma_table_info('requests') WHERE name = 'source'",
    )
    .get();
  assert.equal(source?.dflt_value, "'cli'");
  db.close();
});
