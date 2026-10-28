import test from "node:test";
import assert from "node:assert/strict";

import {
  detectMacros,
  resolveStringMacros,
  resolveTemplateBody,
  validateTemplateBody,
} from "../src/template.js";
import { TemplateRepository } from "../src/template-repository.js";
import { openDatabase } from "../src/database.js";

test("an exact macro preserves the native type", () => {
  assert.deepEqual(resolveStringMacros("{{a}}", { a: { x: 1 } }), {
    value: { x: 1 },
    missing: [],
  });
  assert.deepEqual(resolveStringMacros("{{a}}", { a: [1, 2] }), {
    value: [1, 2],
    missing: [],
  });
  assert.deepEqual(resolveStringMacros("{{a}}", { a: 42 }), {
    value: 42,
    missing: [],
  });
  assert.deepEqual(resolveStringMacros("{{a}}", { a: true }), {
    value: true,
    missing: [],
  });
  assert.deepEqual(resolveStringMacros("{{a}}", { a: null }), {
    value: null,
    missing: [],
  });
});

test("macros embedded in text interpolate as a string", () => {
  assert.deepEqual(
    resolveStringMacros("Hello {{name}}, age {{age}}", {
      name: "Ana",
      age: 30,
    }),
    { value: "Hello Ana, age 30", missing: [] },
  );
});

test("resolves nested paths", () => {
  assert.deepEqual(
    resolveStringMacros("{{customer.name}}", { customer: { name: "Ana" } }),
    { value: "Ana", missing: [] },
  );
  assert.deepEqual(
    resolveStringMacros("{{a.b.c}}", { a: { b: { c: 1 } } }),
    { value: 1, missing: [] },
  );
});

test("prefers the literal key with a dot over the nested path", () => {
  assert.deepEqual(
    resolveStringMacros("{{a.b}}", { "a.b": "literal", a: { b: "nested" } }),
    { value: "literal", missing: [] },
  );
});

test("the literal macro escape leaves the text unresolved", () => {
  assert.deepEqual(resolveStringMacros("\\{{foo}}", {}), {
    value: "{{foo}}",
    missing: [],
  });
  assert.deepEqual(resolveStringMacros("before \\{{foo}} after", {}), {
    value: "before {{foo}} after",
    missing: [],
  });
});

test("lists the missing macros", () => {
  assert.deepEqual(resolveStringMacros("{{a}} {{b}} {{c}}", { a: 1 }), {
    value: "1  ",
    missing: ["b", "c"],
  });
});

test("resolves a template with two macros and produces the expected JSON", () => {
  const body = JSON.stringify({
    model: "jev-1.13",
    state: {
      order: "{{order_state}}",
      customer: "{{customer.name}}",
    },
    questions: { urgent: { type: "noul", instructions: "Is it urgent?" } },
  });

  const request = resolveTemplateBody(body, {
    order_state: "pending",
    customer: { name: "Ana" },
  });

  assert.deepEqual(request, {
    model: "jev-1.13",
    state: { order: "pending", customer: "Ana" },
    questions: { urgent: { type: "noul", instructions: "Is it urgent?" } },
  });
});

test("nested macros and non-string values preserve the type", () => {
  const body = JSON.stringify({
    model: "jev-1.13",
    state: "{{state}}",
    questions: "{{questions}}",
  });

  const request = resolveTemplateBody(body, {
    state: { order: 42, active: true },
    questions: { q: { type: "score", criteria: ["low", "high"] } },
  });

  assert.deepEqual(request.state, { order: 42, active: true });
  assert.deepEqual(request.questions, {
    q: { type: "score", criteria: ["low", "high"] },
  });
});

test("bare macros as values are parsed and resolve to their native type", () => {
  const body = `{
    "model": "jev-1.13",
    "state": { "prenda": "{{imagen}}" },
    "questions": {
      "tipo_prenda": { "type": "choice", "instructions": "x", "criteria": {{criterias}} },
      "nivel": { "type": "score", "criteria": {{levels}} }
    }
  }`;

  assert.deepEqual(detectMacros(body), ["criterias", "imagen", "levels"]);
  assert.doesNotThrow(() => validateTemplateBody(body));

  const request = resolveTemplateBody(body, {
    imagen: "foto1",
    criterias: { CAMISA: "camisa", CAMISETA: "camiseta" },
    levels: ["bajo", "alto"],
  });

  assert.deepEqual(request.state, { prenda: "foto1" });
  assert.deepEqual(request.questions.tipo_prenda?.criteria, {
    CAMISA: "camisa",
    CAMISETA: "camiseta",
  });
  assert.deepEqual(request.questions.nivel?.criteria, ["bajo", "alto"]);
});

test("macros inside JSON strings are not rewritten as bare macros", () => {
  const body = `{ "model": "m", "state": "text {{x}}", "questions": { "q": { "type": "noul" } } }`;
  assert.deepEqual(detectMacros(body), ["x"]);
  assert.deepEqual(resolveTemplateBody(body, { x: "ok" }).state, "text ok");
});

test("an incomplete context fails listing the missing keys", () => {
  const body = JSON.stringify({
    model: "jev-1.13",
    state: { a: "{{x}}", b: "{{y}}", c: "{{x}}" },
    questions: { q: { type: "noul" } },
  });

  assert.throws(
    () => resolveTemplateBody(body, { y: 1 }),
    /missing macros in context: x/,
  );
});

test("validates the template as a request", () => {
  const good = { model: "m", state: "s", questions: { q: { type: "noul" } } };
  assert.doesNotThrow(() => resolveTemplateBody(JSON.stringify(good), {}));

  assert.throws(
    () =>
      resolveTemplateBody(
        JSON.stringify({ state: "s", questions: { q: { type: "noul" } } }),
        {},
      ),
    /has no model/,
  );

  assert.throws(
    () =>
      resolveTemplateBody(
        JSON.stringify({ model: "m", questions: { q: { type: "noul" } } }),
        {},
      ),
    /has no state/,
  );

  assert.throws(
    () =>
      resolveTemplateBody(
        JSON.stringify({
          model: "m",
          state: "s",
          questions: { q: { type: "invented" } },
        }),
        {},
      ),
    /unsupported type/,
  );
});

test("TemplateRepository manages templates with timestamps", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);

  assert.equal(repository.get("order"), undefined);

  repository.save("order", "Order template", '{"model":"m"}');
  const saved = repository.get("order");
  assert.ok(saved);
  assert.equal(saved.description, "Order template");
  assert.equal(saved.body_json, '{"model":"m"}');
  assert.ok(saved.created_at);
  assert.equal(saved.updated_at, saved.created_at);

  repository.save("urgent", "", "{}");
  assert.deepEqual(
    repository.list().map((template) => template.name),
    ["order", "urgent"],
  );

  repository.save("order", "New description", '{"model":"m2"}');
  const updated = repository.get("order");
  assert.ok(updated);
  assert.equal(updated.description, "New description");
  assert.equal(updated.body_json, '{"model":"m2"}');
  assert.equal(updated.created_at, saved.created_at);

  assert.equal(repository.remove("order"), true);
  assert.equal(repository.remove("order"), false);
  assert.equal(repository.get("order"), undefined);

  db.close();
});

test("TemplateRepository.rename preserves the content and created_at", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);
  repository.save("source", "description", '{"model":"m"}');
  const original = repository.get("source");
  assert.ok(original);

  repository.rename("source", "target");

  assert.equal(repository.get("source"), undefined);
  const renamed = repository.get("target");
  assert.ok(renamed);
  assert.equal(renamed.description, original.description);
  assert.equal(renamed.body_json, original.body_json);
  assert.equal(renamed.created_at, original.created_at);
  db.close();
});

test("TemplateRepository.rename does not overwrite the target or lose the source", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);
  repository.save("source", "original", '{"model":"source"}');
  repository.save("target", "target", '{"model":"target"}');

  assert.throws(() => repository.rename("source", "target"), /already exists/);

  assert.equal(repository.get("source")?.body_json, '{"model":"source"}');
  assert.equal(repository.get("target")?.body_json, '{"model":"target"}');
  db.close();
});

test("TemplateRepository.rename rolls back the change if SQLite fails", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);
  repository.save("source", "original", '{"model":"m"}');
  db.exec(`
    CREATE TRIGGER reject_template_rename
    BEFORE UPDATE OF name ON templates
    WHEN NEW.name = 'target'
    BEGIN
      SELECT RAISE(FAIL, 'rename rejected');
    END
  `);

  assert.throws(() => repository.rename("source", "target"), /rename rejected/);

  assert.equal(repository.get("source")?.body_json, '{"model":"m"}');
  assert.equal(repository.get("target"), undefined);
  db.close();
});

const MACRO_BODY = JSON.stringify({
  model: "m",
  state: { ticket: "{{ticket}}", plan: "{{customer.plan}}" },
  questions: { q: { type: "noul" } },
});

test("TemplateRepository stores one row per macro with an empty description", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);

  repository.save("order", "", MACRO_BODY);

  assert.deepEqual(repository.get("order")?.macros, [
    { name: "customer.plan", description: "", schema: null },
    { name: "ticket", description: "", schema: null },
  ]);
  assert.deepEqual(
    db
      .prepare(
        "SELECT template_name, macro, description FROM template_macros ORDER BY macro",
      )
      .all(),
    [
      { template_name: "order", macro: "customer.plan", description: "" },
      { template_name: "order", macro: "ticket", description: "" },
    ],
  );
  db.close();
});

test("TemplateRepository persists and trims macro descriptions", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);

  repository.save("order", "", MACRO_BODY, [
    { name: "ticket", description: "  Order identifier (TCK-1042)  ", schema: null },
    { name: "customer.plan", description: "free | pro | enterprise", schema: null },
  ]);

  assert.deepEqual(repository.get("order")?.macros, [
    { name: "customer.plan", description: "free | pro | enterprise", schema: null },
    { name: "ticket", description: "Order identifier (TCK-1042)", schema: null },
  ]);
  assert.deepEqual(repository.list()[0]?.macros, repository.get("order")?.macros);
  db.close();
});

test("TemplateRepository preserves descriptions when editing and deletes orphans", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);
  repository.save("order", "", MACRO_BODY, [
    { name: "ticket", description: "Identifier", schema: null },
    { name: "customer.plan", description: "Plan", schema: null },
  ]);

  // Editing without passing macros preserves the existing descriptions.
  repository.save("order", "", MACRO_BODY);
  assert.deepEqual(repository.get("order")?.macros, [
    { name: "customer.plan", description: "Plan", schema: null },
    { name: "ticket", description: "Identifier", schema: null },
  ]);

  const withoutTicket = JSON.stringify({
    model: "m",
    state: { plan: "{{customer.plan}}", new: "{{new}}" },
    questions: { q: { type: "noul" } },
  });
  repository.save("order", "", withoutTicket);

  assert.deepEqual(repository.get("order")?.macros, [
    { name: "customer.plan", description: "Plan", schema: null },
    { name: "new", description: "", schema: null },
  ]);
  assert.deepEqual(
    db
      .prepare("SELECT macro FROM template_macros ORDER BY macro")
      .all(),
    [{ macro: "customer.plan" }, { macro: "new" }],
  );
  db.close();
});

test("TemplateRepository validates unknown macros and long descriptions", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);

  assert.throws(
    () =>
      repository.save("order", "", MACRO_BODY, [
        { name: "nonexistent", description: "x", schema: null },
      ]),
    /is not in the template body/,
  );
  assert.throws(
    () =>
      repository.save("order", "", MACRO_BODY, [
        { name: "ticket", description: "x".repeat(501) },
      ]),
    /exceeds 500/,
  );
  assert.equal(repository.get("order"), undefined);
  db.close();
});

test("TemplateRepository merges the body with the rows and drops orphans on read", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);
  repository.save("order", "", MACRO_BODY, [
    { name: "ticket", description: "Identifier", schema: null },
  ]);
  // Simulates a hand-edited body or a v3 database: a new macro appears.
  db.prepare("UPDATE templates SET body_json = ? WHERE name = ?").run(
    JSON.stringify({ model: "m", state: "{{extra}} {{ticket}}" }),
    "order",
  );
  // And an orphan row that is no longer in the body.
  db.prepare(
    "INSERT INTO template_macros (template_name, macro, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("order", "orphan", "must not show up", "2024-01-01", "2024-01-01");

  assert.deepEqual(repository.get("order")?.macros, [
    { name: "extra", description: "", schema: null },
    { name: "ticket", description: "Identifier", schema: null },
  ]);
  db.close();
});

test("TemplateRepository rename and delete carry template_macros (CASCADE)", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);
  repository.save("order", "", MACRO_BODY, [
    { name: "ticket", description: "Identifier", schema: null },
  ]);

  repository.rename("order", "renamed");
  assert.deepEqual(repository.get("renamed")?.macros, [
    { name: "customer.plan", description: "", schema: null },
    { name: "ticket", description: "Identifier", schema: null },
  ]);
  assert.deepEqual(
    db
      .prepare("SELECT COUNT(*) AS total FROM template_macros WHERE template_name = 'order'")
      .get() as { total: number },
    { total: 0 },
  );

  assert.equal(repository.remove("renamed"), true);
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS total FROM template_macros").get(), {
    total: 0,
  });
  db.close();
});
