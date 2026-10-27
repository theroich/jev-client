import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  resolveConfig,
  resolveModel,
} from "../src/config.js";
import { validateConfigValue } from "../src/config-repository.js";

test("flags win over environment variables", () => {
  const config = resolveConfig(
    { key: "flag-key", url: "https://flag.test", model: "flag-model" },
    { JEV_API_KEY: "env-key", JEV_URL: "https://env.test", JEV_MODEL: "env-model" },
  );

  assert.deepEqual(config, {
    apiKey: "flag-key",
    endpoint: "https://flag.test",
    model: "flag-model",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retries: DEFAULT_RETRIES,
  });
});

test("uses environment variables", () => {
  const config = resolveConfig({}, {
    JEV_API_KEY: "env-key",
    JEV_URL: "https://env.test",
    JEV_MODEL: "env-model",
  });

  assert.deepEqual(config, {
    apiKey: "env-key",
    endpoint: "https://env.test",
    model: "env-model",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retries: DEFAULT_RETRIES,
  });
});

test("OPENCODE_API_KEY is ignored", () => {
  const config = resolveConfig({}, {
    OPENCODE_API_KEY: "primary",
    JEV_API_KEY: "alt",
  });
  assert.equal(config.apiKey, "alt");

  const opencodeOnly = resolveConfig({}, { OPENCODE_API_KEY: "primary" });
  assert.equal(opencodeOnly.apiKey, "");
});

test("default values", () => {
  const config = resolveConfig({}, {});
  assert.deepEqual(config, {
    apiKey: "",
    endpoint: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retries: DEFAULT_RETRIES,
  });
});

test("empty strings count as undefined", () => {
  const config = resolveConfig({ key: "" }, { JEV_API_KEY: "env-key" });
  assert.equal(config.apiKey, "env-key");
});

test("resolveModel: flag > environment > database > request > default", () => {
  assert.equal(resolveModel("flag", "request", { JEV_MODEL: "env" }, "stored"), "flag");
  assert.equal(resolveModel(undefined, "request", { JEV_MODEL: "env" }, "stored"), "env");
  assert.equal(resolveModel(undefined, "request", {}, "stored"), "stored");
  assert.equal(resolveModel(undefined, "request", {}), "request");
  assert.equal(resolveModel(undefined, undefined, {}, "stored"), "stored");
  assert.equal(resolveModel(undefined, undefined, {}), DEFAULT_MODEL);
});

test("the database is used when there are no flags or environment values", () => {
  const config = resolveConfig({}, {}, {
    api_key: "stored-key",
    api_url: "https://stored.test",
    model: "stored-model",
    timeout: "12.5",
    retries: "4",
  });

  assert.deepEqual(config, {
    apiKey: "stored-key",
    endpoint: "https://stored.test",
    model: "stored-model",
    timeoutMs: 12_500,
    retries: 4,
  });
});

test("flags and environment win over the saved configuration", () => {
  const stored = {
    api_key: "stored-key",
    api_url: "https://stored.test",
    model: "stored-model",
    timeout: "10",
    retries: "5",
  };
  const fromEnv = resolveConfig({}, {
    JEV_API_KEY: "env-key",
    JEV_URL: "https://env.test",
    JEV_MODEL: "env-model",
  }, stored);
  assert.equal(fromEnv.apiKey, "env-key");
  assert.equal(fromEnv.endpoint, "https://env.test");
  assert.equal(fromEnv.model, "env-model");

  const fromFlags = resolveConfig({
    key: "flag-key",
    url: "https://flag.test",
    model: "flag-model",
    timeoutMs: 2_000,
    retries: 0,
  }, {
    JEV_API_KEY: "env-key",
    JEV_URL: "https://env.test",
    JEV_MODEL: "env-model",
  }, stored);
  assert.equal(fromFlags.apiKey, "flag-key");
  assert.equal(fromFlags.endpoint, "https://flag.test");
  assert.equal(fromFlags.model, "flag-model");
  assert.equal(fromFlags.timeoutMs, 2_000);
  assert.equal(fromFlags.retries, 0);
});

test("the saved numeric configuration is validated", () => {
  assert.throws(() => resolveConfig({}, {}, { timeout: "0" }), /timeout/);
  assert.throws(() => resolveConfig({}, {}, { retries: "1.5" }), /retries/);
});

test("validateConfigValue requires a complete http(s) api_url", () => {
  assert.doesNotThrow(() =>
    validateConfigValue("api_url", "https://example.test/systemone"),
  );
  assert.doesNotThrow(() =>
    validateConfigValue("api_url", "http://127.0.0.1:7411/systemone"),
  );

  for (const value of [
    "example.test/systemone",
    "/systemone",
    "ftp://example.test/systemone",
    "https://",
  ]) {
    assert.throws(() => validateConfigValue("api_url", value), /api_url/);
  }
});

test("validateConfigValue rejects an empty model", () => {
  assert.throws(() => validateConfigValue("model", ""), /model/);
  assert.throws(() => validateConfigValue("model", "   "), /model/);
  assert.doesNotThrow(() => validateConfigValue("model", "jev-1.13"));
});
