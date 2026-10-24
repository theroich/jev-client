import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ConfigRepository } from "../src/config-repository.js";
import {
  SCHEMA_VERSION,
  defaultDatabasePath,
  migrateDatabase,
  openDatabase,
  resolveDatabasePath,
} from "../src/database.js";

test("la ruta usa el home del SO y la precedencia --db > JEV_DB", () => {
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

test("crea .jev-client/db y la base con permisos restrictivos", async (t) => {
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

test("las migraciones son idempotentes y conservan los datos", async (t) => {
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

test("el repositorio implementa get, set, unset y list", () => {
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

test("no se abre una base con un esquema más reciente", () => {
  const db = openDatabase(":memory:");
  db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
  assert.throws(() => migrateDatabase(db), /esquema/);
  db.close();
});
