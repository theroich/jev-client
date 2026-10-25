import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveStringMacros,
  resolveTemplateBody,
} from "../src/template.js";
import { TemplateRepository } from "../src/template-repository.js";
import { openDatabase } from "../src/database.js";

test("una macro exacta conserva el tipo nativo", () => {
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

test("las macros embebidas en texto interpolan como string", () => {
  assert.deepEqual(
    resolveStringMacros("Hola {{nombre}}, edad {{edad}}", {
      nombre: "Ana",
      edad: 30,
    }),
    { value: "Hola Ana, edad 30", missing: [] },
  );
});

test("resuelve rutas anidadas", () => {
  assert.deepEqual(
    resolveStringMacros("{{cliente.nombre}}", { cliente: { nombre: "Ana" } }),
    { value: "Ana", missing: [] },
  );
  assert.deepEqual(
    resolveStringMacros("{{a.b.c}}", { a: { b: { c: 1 } } }),
    { value: 1, missing: [] },
  );
});

test("prefiere la clave literal con punto antes que la ruta anidada", () => {
  assert.deepEqual(
    resolveStringMacros("{{a.b}}", { "a.b": "literal", a: { b: "anidada" } }),
    { value: "literal", missing: [] },
  );
});

test("el escape de macro literal deja el texto sin resolver", () => {
  assert.deepEqual(resolveStringMacros("\\{{foo}}", {}), {
    value: "{{foo}}",
    missing: [],
  });
  assert.deepEqual(resolveStringMacros("antes \\{{foo}} después", {}), {
    value: "antes {{foo}} después",
    missing: [],
  });
});

test("lista las macros que faltan", () => {
  assert.deepEqual(resolveStringMacros("{{a}} {{b}} {{c}}", { a: 1 }), {
    value: "1  ",
    missing: ["b", "c"],
  });
});

test("resuelve una plantilla con dos macros y produce el JSON esperado", () => {
  const body = JSON.stringify({
    model: "jev-1.13",
    state: {
      pedido: "{{estado_de_pedido}}",
      cliente: "{{cliente.nombre}}",
    },
    questions: { urgent: { type: "noul", instructions: "¿Es urgente?" } },
  });

  const request = resolveTemplateBody(body, {
    estado_de_pedido: "pendiente",
    cliente: { nombre: "Ana" },
  });

  assert.deepEqual(request, {
    model: "jev-1.13",
    state: { pedido: "pendiente", cliente: "Ana" },
    questions: { urgent: { type: "noul", instructions: "¿Es urgente?" } },
  });
});

test("las macros anidadas y los valores no-string conservan el tipo", () => {
  const body = JSON.stringify({
    model: "jev-1.13",
    state: "{{estado}}",
    questions: "{{preguntas}}",
  });

  const request = resolveTemplateBody(body, {
    estado: { pedido: 42, activo: true },
    preguntas: { q: { type: "score", criteria: ["bajo", "alto"] } },
  });

  assert.deepEqual(request.state, { pedido: 42, activo: true });
  assert.deepEqual(request.questions, {
    q: { type: "score", criteria: ["bajo", "alto"] },
  });
});

test("un contexto incompleto falla listando las claves que faltan", () => {
  const body = JSON.stringify({
    model: "jev-1.13",
    state: { a: "{{x}}", b: "{{y}}", c: "{{x}}" },
    questions: { q: { type: "noul" } },
  });

  assert.throws(
    () => resolveTemplateBody(body, { y: 1 }),
    /faltan macros en el contexto: x/,
  );
});

test("valida la plantilla como request", () => {
  const good = { model: "m", state: "s", questions: { q: { type: "noul" } } };
  assert.doesNotThrow(() => resolveTemplateBody(JSON.stringify(good), {}));

  assert.throws(
    () =>
      resolveTemplateBody(
        JSON.stringify({ state: "s", questions: { q: { type: "noul" } } }),
        {},
      ),
    /no tiene model/,
  );

  assert.throws(
    () =>
      resolveTemplateBody(
        JSON.stringify({ model: "m", questions: { q: { type: "noul" } } }),
        {},
      ),
    /no tiene state/,
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
    /tipo no soportado/,
  );
});

test("TemplateRepository gestiona plantillas con timestamps", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);

  assert.equal(repository.get("pedido"), undefined);

  repository.save("pedido", "Plantilla de pedido", '{"model":"m"}');
  const saved = repository.get("pedido");
  assert.ok(saved);
  assert.equal(saved.description, "Plantilla de pedido");
  assert.equal(saved.body_json, '{"model":"m"}');
  assert.ok(saved.created_at);
  assert.equal(saved.updated_at, saved.created_at);

  repository.save("urgente", "", "{}");
  assert.deepEqual(
    repository.list().map((template) => template.name),
    ["pedido", "urgente"],
  );

  repository.save("pedido", "Nueva descripción", '{"model":"m2"}');
  const updated = repository.get("pedido");
  assert.ok(updated);
  assert.equal(updated.description, "Nueva descripción");
  assert.equal(updated.body_json, '{"model":"m2"}');
  assert.equal(updated.created_at, saved.created_at);

  assert.equal(repository.remove("pedido"), true);
  assert.equal(repository.remove("pedido"), false);
  assert.equal(repository.get("pedido"), undefined);

  db.close();
});

test("TemplateRepository.rename conserva el contenido y created_at", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);
  repository.save("origen", "descripción", '{"model":"m"}');
  const original = repository.get("origen");
  assert.ok(original);

  repository.rename("origen", "destino");

  assert.equal(repository.get("origen"), undefined);
  const renamed = repository.get("destino");
  assert.ok(renamed);
  assert.equal(renamed.description, original.description);
  assert.equal(renamed.body_json, original.body_json);
  assert.equal(renamed.created_at, original.created_at);
  db.close();
});

test("TemplateRepository.rename no sobrescribe el destino ni pierde el origen", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);
  repository.save("origen", "original", '{"model":"origen"}');
  repository.save("destino", "destino", '{"model":"destino"}');

  assert.throws(() => repository.rename("origen", "destino"), /ya existe/);

  assert.equal(repository.get("origen")?.body_json, '{"model":"origen"}');
  assert.equal(repository.get("destino")?.body_json, '{"model":"destino"}');
  db.close();
});

test("TemplateRepository.rename revierte el cambio si SQLite falla", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);
  repository.save("origen", "original", '{"model":"m"}');
  db.exec(`
    CREATE TRIGGER reject_template_rename
    BEFORE UPDATE OF name ON templates
    WHEN NEW.name = 'destino'
    BEGIN
      SELECT RAISE(FAIL, 'rename rechazado');
    END
  `);

  assert.throws(() => repository.rename("origen", "destino"), /rename rechazado/);

  assert.equal(repository.get("origen")?.body_json, '{"model":"m"}');
  assert.equal(repository.get("destino"), undefined);
  db.close();
});

const MACRO_BODY = JSON.stringify({
  model: "m",
  state: { ticket: "{{ticket}}", plan: "{{cliente.plan}}" },
  questions: { q: { type: "noul" } },
});

test("TemplateRepository guarda una fila por macro con descripción vacía", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);

  repository.save("pedido", "", MACRO_BODY);

  assert.deepEqual(repository.get("pedido")?.macros, [
    { name: "cliente.plan", description: "" },
    { name: "ticket", description: "" },
  ]);
  assert.deepEqual(
    db
      .prepare(
        "SELECT template_name, macro, description FROM template_macros ORDER BY macro",
      )
      .all(),
    [
      { template_name: "pedido", macro: "cliente.plan", description: "" },
      { template_name: "pedido", macro: "ticket", description: "" },
    ],
  );
  db.close();
});

test("TemplateRepository persiste y recorta descripciones de macros", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);

  repository.save("pedido", "", MACRO_BODY, [
    { name: "ticket", description: "  Identificador del pedido (TCK-1042)  " },
    { name: "cliente.plan", description: "free | pro | enterprise" },
  ]);

  assert.deepEqual(repository.get("pedido")?.macros, [
    { name: "cliente.plan", description: "free | pro | enterprise" },
    { name: "ticket", description: "Identificador del pedido (TCK-1042)" },
  ]);
  assert.deepEqual(repository.list()[0]?.macros, repository.get("pedido")?.macros);
  db.close();
});

test("TemplateRepository conserva descripciones al editar y borra huérfanas", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);
  repository.save("pedido", "", MACRO_BODY, [
    { name: "ticket", description: "Identificador" },
    { name: "cliente.plan", description: "Plan" },
  ]);

  // Editar sin pasar macros conserva las descripciones existentes.
  repository.save("pedido", "", MACRO_BODY);
  assert.deepEqual(repository.get("pedido")?.macros, [
    { name: "cliente.plan", description: "Plan" },
    { name: "ticket", description: "Identificador" },
  ]);

  const withoutTicket = JSON.stringify({
    model: "m",
    state: { plan: "{{cliente.plan}}", nuevo: "{{nuevo}}" },
    questions: { q: { type: "noul" } },
  });
  repository.save("pedido", "", withoutTicket);

  assert.deepEqual(repository.get("pedido")?.macros, [
    { name: "cliente.plan", description: "Plan" },
    { name: "nuevo", description: "" },
  ]);
  assert.deepEqual(
    db
      .prepare("SELECT macro FROM template_macros ORDER BY macro")
      .all(),
    [{ macro: "cliente.plan" }, { macro: "nuevo" }],
  );
  db.close();
});

test("TemplateRepository valida macros desconocidas y descripciones largas", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);

  assert.throws(
    () =>
      repository.save("pedido", "", MACRO_BODY, [
        { name: "inexistente", description: "x" },
      ]),
    /no está en el body/,
  );
  assert.throws(
    () =>
      repository.save("pedido", "", MACRO_BODY, [
        { name: "ticket", description: "x".repeat(501) },
      ]),
    /supera los 500/,
  );
  assert.equal(repository.get("pedido"), undefined);
  db.close();
});

test("TemplateRepository fusiona el body con las filas y descarta huérfanas al leer", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);
  repository.save("pedido", "", MACRO_BODY, [
    { name: "ticket", description: "Identificador" },
  ]);
  // Simula un body editado a mano o una base v3: aparece una macro nueva.
  db.prepare("UPDATE templates SET body_json = ? WHERE name = ?").run(
    JSON.stringify({ model: "m", state: "{{extra}} {{ticket}}" }),
    "pedido",
  );
  // Y una fila huérfana que ya no está en el body.
  db.prepare(
    "INSERT INTO template_macros (template_name, macro, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("pedido", "huerfana", "no debe salir", "2024-01-01", "2024-01-01");

  assert.deepEqual(repository.get("pedido")?.macros, [
    { name: "extra", description: "" },
    { name: "ticket", description: "Identificador" },
  ]);
  db.close();
});

test("TemplateRepository rename y delete arrastran template_macros (CASCADE)", () => {
  const db = openDatabase(":memory:");
  const repository = new TemplateRepository(db);
  repository.save("pedido", "", MACRO_BODY, [
    { name: "ticket", description: "Identificador" },
  ]);

  repository.rename("pedido", "renombrada");
  assert.deepEqual(repository.get("renombrada")?.macros, [
    { name: "cliente.plan", description: "" },
    { name: "ticket", description: "Identificador" },
  ]);
  assert.deepEqual(
    db
      .prepare("SELECT COUNT(*) AS total FROM template_macros WHERE template_name = 'pedido'")
      .get() as { total: number },
    { total: 0 },
  );

  assert.equal(repository.remove("renombrada"), true);
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS total FROM template_macros").get(), {
    total: 0,
  });
  db.close();
});
