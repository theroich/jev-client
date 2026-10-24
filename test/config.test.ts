import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  resolveConfig,
  resolveModel,
} from "../src/config.js";

test("los flags ganan a las variables de entorno", () => {
  const config = resolveConfig(
    { key: "flag-key", url: "https://flag.test", model: "flag-model" },
    { OPENCODE_API_KEY: "env-key", JEV_URL: "https://env.test", JEV_MODEL: "env-model" },
  );

  assert.deepEqual(config, {
    apiKey: "flag-key",
    endpoint: "https://flag.test",
    model: "flag-model",
  });
});

test("usa las variables de entorno", () => {
  const config = resolveConfig({}, {
    OPENCODE_API_KEY: "env-key",
    JEV_URL: "https://env.test",
    JEV_MODEL: "env-model",
  });

  assert.deepEqual(config, {
    apiKey: "env-key",
    endpoint: "https://env.test",
    model: "env-model",
  });
});

test("JEV_API_KEY funciona como alternativa", () => {
  const config = resolveConfig({}, { JEV_API_KEY: "alt-key" });
  assert.equal(config.apiKey, "alt-key");
});

test("OPENCODE_API_KEY tiene prioridad sobre JEV_API_KEY", () => {
  const config = resolveConfig({}, {
    OPENCODE_API_KEY: "primary",
    JEV_API_KEY: "alt",
  });
  assert.equal(config.apiKey, "primary");
});

test("valores por defecto", () => {
  const config = resolveConfig({}, {});
  assert.deepEqual(config, {
    apiKey: "",
    endpoint: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL,
  });
});

test("las cadenas vacías cuentan como no definidas", () => {
  const config = resolveConfig({ key: "" }, { OPENCODE_API_KEY: "env-key" });
  assert.equal(config.apiKey, "env-key");
});

test("resolveModel: flag > entorno > request > default", () => {
  assert.equal(resolveModel("flag", "request", { JEV_MODEL: "env" }), "flag");
  assert.equal(resolveModel(undefined, "request", { JEV_MODEL: "env" }), "env");
  assert.equal(resolveModel(undefined, "request", {}), "request");
  assert.equal(resolveModel(undefined, undefined, {}), DEFAULT_MODEL);
});
