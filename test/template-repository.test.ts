import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MACRO_SCHEMA_BYTES,
  MacroSchemaError,
  validateMacroSchema,
} from "../src/template-repository.js";

function schemaCode(value: unknown): string {
  try {
    validateMacroSchema(value);
  } catch (error) {
    if (error instanceof MacroSchemaError) return error.code;
    throw error;
  }
  return "ok";
}

test("acepta booleanos, tipos y keywords del editor básico", () => {
  assert.equal(validateMacroSchema(true), true);
  assert.equal(validateMacroSchema(false), false);
  assert.deepEqual(validateMacroSchema({ type: "string" }), { type: "string" });
  assert.deepEqual(validateMacroSchema({ type: ["string", "null"] }), {
    type: ["string", "null"],
  });
  assert.deepEqual(
    validateMacroSchema({
      type: "string",
      enum: ["free", "pro"],
      format: "email",
      pattern: "^[a-z]+$",
      minLength: 1,
      maxLength: 20,
      default: "free",
      examples: ["free", "pro"],
    }),
    {
      type: "string",
      enum: ["free", "pro"],
      format: "email",
      pattern: "^[a-z]+$",
      minLength: 1,
      maxLength: 20,
      default: "free",
      examples: ["free", "pro"],
    },
  );
  assert.deepEqual(validateMacroSchema({ minimum: 1, maximum: 10 }), {
    minimum: 1,
    maximum: 10,
  });
  // Los $ref locales están permitidos y los remotos no.
  assert.deepEqual(validateMacroSchema({ $ref: "#/$defs/plan" }), {
    $ref: "#/$defs/plan",
  });
  assert.deepEqual(
    validateMacroSchema({ properties: { plan: { $ref: "#/$defs/plan" } } }),
    { properties: { plan: { $ref: "#/$defs/plan" } } },
  );
});

test("rechaza formas y types inválidos con códigos estables", () => {
  assert.equal(schemaCode(null), "invalid_macro_schema");
  assert.equal(schemaCode(["string"]), "invalid_macro_schema");
  assert.equal(schemaCode("string"), "invalid_macro_schema");
  assert.equal(schemaCode(3), "invalid_macro_schema");
  assert.equal(schemaCode({ type: "text" }), "invalid_macro_schema_type");
  assert.equal(schemaCode({ type: [] }), "invalid_macro_schema_type");
  assert.equal(schemaCode({ type: ["string", "text"] }), "invalid_macro_schema_type");
  assert.equal(schemaCode({ type: 3 }), "invalid_macro_schema_type");
});

test("rechaza keywords mal formados, $ref remotos y esquemas gigantes", () => {
  assert.equal(schemaCode({ enum: [] }), "invalid_macro_schema");
  assert.equal(schemaCode({ enum: "free" }), "invalid_macro_schema");
  assert.equal(schemaCode({ format: 1 }), "invalid_macro_schema");
  assert.equal(schemaCode({ pattern: "(" }), "invalid_macro_schema");
  assert.equal(schemaCode({ pattern: 1 }), "invalid_macro_schema");
  assert.equal(schemaCode({ minLength: "1" }), "invalid_macro_schema");
  assert.equal(schemaCode({ maximum: null }), "invalid_macro_schema");
  assert.equal(
    schemaCode({ $ref: "https://example.com/schema.json" }),
    "invalid_macro_schema",
  );
  assert.equal(
    schemaCode({ properties: { plan: { $ref: "./plan.json" } } }),
    "invalid_macro_schema",
  );
  assert.equal(
    schemaCode({ description: "x".repeat(MAX_MACRO_SCHEMA_BYTES) }),
    "invalid_macro_schema",
  );
});
