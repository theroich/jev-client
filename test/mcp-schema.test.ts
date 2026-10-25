import test from "node:test";
import assert from "node:assert/strict";

import type { Template } from "../src/template-repository.js";
import {
  inputSchemaForTemplate,
  isValidToolName,
  macroParamSchema,
  toolNameForTemplate,
  truncate,
} from "../src/mcp/schema.js";

function template(name: string, macros: Template["macros"]): Template {
  return {
    name,
    description: "",
    body_json: "{}",
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
    macros,
  };
}

test("macroParamSchema sin esquema es { type: string }", () => {
  assert.deepEqual(macroParamSchema({ name: "a", description: "" }), {
    type: "string",
  });
});

test("macroParamSchema conserva el esquema completo con type", () => {
  assert.deepEqual(
    macroParamSchema({
      name: "plan",
      description: "",
      schema: { type: "string", enum: ["free", "pro"] },
    }),
    { type: "string", enum: ["free", "pro"] },
  );
});

test("macroParamSchema con enum pero sin type no añade type", () => {
  assert.deepEqual(
    macroParamSchema({ name: "plan", description: "", schema: { enum: ["a", "b"] } }),
    { enum: ["a", "b"] },
  );
});

test("macroParamSchema sin type ni keywords restrictivas añade type string", () => {
  assert.deepEqual(
    macroParamSchema({ name: "email", description: "", schema: { format: "email" } }),
    { format: "email", type: "string" },
  );
});

test("macroParamSchema boolean true -> string, false -> not {}", () => {
  assert.deepEqual(macroParamSchema({ name: "a", description: "", schema: true }), {
    type: "string",
  });
  assert.deepEqual(macroParamSchema({ name: "a", description: "", schema: false }), {
    not: {},
  });
});

test("macroParamSchema usa macro.description y recorta a 500", () => {
  const description = "x".repeat(600);
  const result = macroParamSchema({ name: "a", description, schema: { type: "string" } });
  assert.equal((result.description as string).length, 500);
  assert.ok((result.description as string).endsWith("…"));
});

test("macroParamSchema cae al schema.description cuando macro.description está vacía", () => {
  const result = macroParamSchema({
    name: "a",
    description: "",
    schema: { type: "string", description: "Del esquema" },
  });
  assert.equal(result.description, "Del esquema");
});

test("inputSchemaForTemplate usa claves planas exactas y all required", () => {
  const schema = inputSchemaForTemplate(
    template("pedido", [
      { name: "cliente.nombre", description: "Nombre" },
      { name: "cliente.plan", description: "Plan", schema: { type: "string", enum: ["free", "pro"] } },
    ]),
  );
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["cliente.nombre", "cliente.plan"]);
  assert.deepEqual(Object.keys(schema.properties as object), [
    "cliente.nombre",
    "cliente.plan",
  ]);
});

test("nombres de tool válidos, inválidos y colisiones", () => {
  assert.equal(isValidToolName("pedido-soporte"), true);
  assert.equal(isValidToolName("jev_ask"), false);
  assert.equal(isValidToolName("con espacios"), false);
  assert.equal(isValidToolName("mayúsculas"), false);

  const taken = new Set(["jev_ask", "pedido-soporte"]);
  assert.deepEqual(toolNameForTemplate("nuevo", taken), { toolName: "nuevo", aliased: false });
  assert.equal(toolNameForTemplate("con espacios", taken).toolName, "tpl_con-espacios");
  assert.equal(toolNameForTemplate("jev_ask", taken).toolName, "tpl_jev_ask");
  assert.equal(toolNameForTemplate("pedido-soporte", taken).aliased, true);
});

test("los alias son deterministas y no colisionan", () => {
  const taken = new Set<string>();
  const first = toolNameForTemplate("pedido/soporte", taken);
  taken.add(first.toolName);
  const second = toolNameForTemplate("pedido/soporte", taken);
  assert.notEqual(first.toolName, second.toolName);
  assert.equal(first.toolName, "tpl_pedido-soporte");
});

test("truncate recorta con elipsis", () => {
  assert.equal(truncate("abc", 10), "abc");
  assert.equal(truncate("abcdefghij", 5), "abcd…");
});
