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
