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

test("macroParamSchema without a schema is { type: string }", () => {
  assert.deepEqual(macroParamSchema({ name: "a", description: "" }), {
    type: "string",
  });
});

test("macroParamSchema keeps the full schema when it has type", () => {
  assert.deepEqual(
    macroParamSchema({
      name: "plan",
      description: "",
      schema: { type: "string", enum: ["free", "pro"] },
    }),
    { type: "string", enum: ["free", "pro"] },
  );
});

test("macroParamSchema with enum but no type does not add type", () => {
  assert.deepEqual(
    macroParamSchema({ name: "plan", description: "", schema: { enum: ["a", "b"] } }),
    { enum: ["a", "b"] },
  );
});

test("macroParamSchema without type or restrictive keywords adds type string", () => {
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

test("macroParamSchema uses macro.description and truncates to 500", () => {
  const description = "x".repeat(600);
  const result = macroParamSchema({ name: "a", description, schema: { type: "string" } });
  assert.equal((result.description as string).length, 500);
  assert.ok((result.description as string).endsWith("…"));
});

test("macroParamSchema falls back to schema.description when macro.description is empty", () => {
  const result = macroParamSchema({
    name: "a",
    description: "",
    schema: { type: "string", description: "From the schema" },
  });
  assert.equal(result.description, "From the schema");
});

test("inputSchemaForTemplate uses exact flat keys and all required", () => {
  const schema = inputSchemaForTemplate(
    template("order", [
      { name: "customer.name", description: "Name" },
      { name: "customer.plan", description: "Plan", schema: { type: "string", enum: ["free", "pro"] } },
    ]),
  );
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["customer.name", "customer.plan"]);
  assert.deepEqual(Object.keys(schema.properties as object), [
    "customer.name",
    "customer.plan",
  ]);
});

test("valid, invalid and colliding tool names", () => {
  assert.equal(isValidToolName("order-support"), true);
  assert.equal(isValidToolName("jev_ask"), false);
  assert.equal(isValidToolName("with spaces"), false);
  assert.equal(isValidToolName("tool/name"), false);

  const taken = new Set(["jev_ask", "order-support"]);
  assert.deepEqual(toolNameForTemplate("new", taken), { toolName: "new", aliased: false });
  assert.equal(toolNameForTemplate("with spaces", taken).toolName, "tpl_with-spaces");
  assert.equal(toolNameForTemplate("jev_ask", taken).toolName, "tpl_jev_ask");
  assert.equal(toolNameForTemplate("order-support", taken).aliased, true);
});

test("aliases are deterministic and do not collide", () => {
  const taken = new Set<string>();
  const first = toolNameForTemplate("order/support", taken);
  taken.add(first.toolName);
  const second = toolNameForTemplate("order/support", taken);
  assert.notEqual(first.toolName, second.toolName);
  assert.equal(first.toolName, "tpl_order-support");
});

test("truncate cuts with an ellipsis", () => {
  assert.equal(truncate("abc", 10), "abc");
  assert.equal(truncate("abcdefghij", 5), "abcd…");
});
