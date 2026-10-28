import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FetchLike } from "../src/client.js";
import { ConfigRepository } from "../src/config-repository.js";
import { openDatabase } from "../src/database.js";
import { RequestRepository } from "../src/request-repository.js";
import {
  DEMO_STATE,
  JevService,
  demoQuestions,
  type BatchEvent,
} from "../src/service.js";
import { TemplateRepository } from "../src/template-repository.js";

const TEMPLATE_BODY = JSON.stringify({
  model: "template-model",
  state: "{{message}}",
  questions: { q: { type: "noul", instructions: "?" } },
});

async function databasePath(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jev-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "jev.db");
}

function addTemplate(path: string): void {
  const db = openDatabase(path);
  new TemplateRepository(db).save("order", "", TEMPLATE_BODY);
  db.close();
}

function serviceFor(
  t: test.TestContext,
  dbPath: string,
  fetch: FetchLike,
  env: NodeJS.ProcessEnv = { JEV_API_KEY: "test-key" },
): JevService {
  const service = new JevService({ dbPath, env, fetch });
  t.after(() => service.close());
  return service;
}

function responseBody(model = "jev-1.13"): string {
  return JSON.stringify({
    model,
    answers: { q: { type: "noul", noul: 0.5 } },
    usage: { input_tokens: 10, output_tokens: 5, cost: 1.5e-6 },
  });
}

function sentBody(init: RequestInit): {
  model: string;
  state: unknown;
  questions: Record<string, unknown>;
} {
  return JSON.parse(String(init.body)) as {
    model: string;
    state: unknown;
    questions: Record<string, unknown>;
  };
}

test("ask/demo use the SQLite configuration and return requestId", async (t) => {
  const dbPath = await databasePath(t);
  const db = openDatabase(dbPath);
  const config = new ConfigRepository(db);
  config.set("api_key", "stored-key");
  config.set("api_url", "https://stored.test/systemone");
  config.set("model", "stored-model");
  config.set("timeout", "1");
  config.set("retries", "0");
  db.close();

  const calls: RequestInit[] = [];
  const fetch: FetchLike = async (_input, init = {}) => {
    calls.push(init);
    return new Response(responseBody(), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const service = serviceFor(t, dbPath, fetch, { JEV_MODEL: "env-model" });

  const ask = await service.ask({
    model: "request-model",
    state: "hello",
    questions: { q: { type: "noul" } },
  });
  assert.equal(ask.requestId, 1);
  assert.equal(ask.statusCode, 200);
  assert.ok(ask.durationMs >= 0);
  assert.equal(new Headers(calls[0]?.headers).get("authorization"), "Bearer stored-key");
  assert.equal(sentBody(calls[0] ?? {}).model, "env-model");

  const notSaved = await service.ask(
    {
      model: "request-model",
      state: "hello",
      questions: { q: { type: "noul" } },
    },
    { save: false, model: "call-model" },
  );
  assert.equal(notSaved.requestId, null);
  assert.equal(sentBody(calls[1] ?? {}).model, "call-model");

  const demo = await service.demo({ save: false });
  assert.equal(demo.requestId, null);
  assert.equal(sentBody(calls[2] ?? {}).state, DEMO_STATE);
  assert.deepEqual(
    Object.keys(sentBody(calls[2] ?? {}).questions),
    Object.keys(demoQuestions()),
  );

  const inspect = openDatabase(dbPath);
  const requests = new RequestRepository(inspect);
  assert.equal(requests.count(), 1);
  assert.equal(requests.get(1)?.model, "env-model");
  inspect.close();
});

test("the saved model wins over the model embedded in the request", async (t) => {
  const dbPath = await databasePath(t);
  const db = openDatabase(dbPath);
  const config = new ConfigRepository(db);
  config.set("api_key", "stored-key");
  config.set("model", "stored-model");
  db.close();

  const calls: RequestInit[] = [];
  const fetch: FetchLike = async (_input, init = {}) => {
    calls.push(init);
    return new Response(responseBody("stored-model"), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const service = serviceFor(t, dbPath, fetch, {});

  const result = await service.ask({
    model: "request-model",
    state: "hello",
    questions: { q: { type: "noul" } },
  });

  assert.equal(sentBody(calls[0] ?? {}).model, "stored-model");
  assert.equal(result.request.model, "stored-model");
});

test("demoQuestions returns a modifiable copy", () => {
  const first = demoQuestions();
  const second = demoQuestions();
  assert.notEqual(first, second);
  assert.notEqual(first.is_urgent, second.is_urgent);
  assert.ok(DEMO_STATE.includes("checkout"));
});

test("batch uses a real pool, preserves order and stamps the history", async (t) => {
  const dbPath = await databasePath(t);
  addTemplate(dbPath);
  let active = 0;
  let maxActive = 0;
  const events: BatchEvent[] = [];
  const fetch: FetchLike = async (_input, init = {}) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return new Response(responseBody(), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const service = serviceFor(t, dbPath, fetch);
  const contexts = Array.from({ length: 6 }, (_, index) => ({
    message: `state-${index}`,
  }));

  const result = await service.batch("order", contexts, {
    concurrency: 3,
    onEvent: (event) => events.push(event),
  });

  assert.equal(maxActive, 3);
  assert.deepEqual(result.items.map((item) => item.index), [0, 1, 2, 3, 4, 5]);
  assert.equal(result.summary.total, 6);
  assert.equal(result.summary.processed, 6);
  assert.equal(result.summary.ok, 6);
  assert.equal(result.summary.errors, 0);
  assert.equal(result.summary.inputTokens, 60);
  assert.equal(result.summary.outputTokens, 30);
  assert.equal(result.summary.cost, 9e-6);
  assert.equal(result.summary.costUnknown, 0);
  assert.equal(result.cancelled, false);
  assert.equal(new Set(result.items.map((item) => item.requestId)).size, 6);
  assert.ok(result.items.every((item) => item.requestId !== null));
  assert.equal(events[0]?.type, "batch.start");
  assert.equal(events.at(-1)?.type, "batch.finish");
  assert.equal(events.filter((event) => event.type === "item.start").length, 6);
  assert.equal(events.filter((event) => event.type === "item.finish").length, 6);

  const inspect = openDatabase(dbPath);
  const requests = new RequestRepository(inspect);
  const rows = requests.list({ batch: result.batchId });
  assert.equal(rows.length, 6);
  assert.ok(rows.every((row) => row.templateName === "order"));
  assert.ok(rows.every((row) => row.batchId === result.batchId));
  inspect.close();
});

test("batch fail-fast does not schedule the following items", async (t) => {
  const dbPath = await databasePath(t);
  addTemplate(dbPath);
  let calls = 0;
  const events: BatchEvent[] = [];
  const fetch: FetchLike = async () => {
    calls += 1;
    return new Response(responseBody(), { status: 200 });
  };
  const service = serviceFor(t, dbPath, fetch);

  const result = await service.batch(
    "order",
    [{}, { message: "one" }, { message: "two" }],
    { failFast: true, onEvent: (event) => events.push(event) },
  );

  assert.equal(calls, 0);
  assert.deepEqual(result.items.map((item) => item.status), [
    "error",
    "skipped",
    "skipped",
  ]);
  assert.deepEqual(result.items.slice(1).map((item) => item.skipReason), [
    "fail-fast",
    "fail-fast",
  ]);
  assert.equal(result.summary.processed, 1);
  assert.equal(result.summary.errors, 1);
  assert.equal(result.summary.skipped, 2);
  assert.equal(events.filter((event) => event.type === "item.skip").length, 2);
});

test("batch cancels in flight, does not retry and marks the rest as skipped", async (t) => {
  const dbPath = await databasePath(t);
  addTemplate(dbPath);
  const controller = new AbortController();
  let calls = 0;
  const events: BatchEvent[] = [];
  const fetch: FetchLike = async (_input, init = {}) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
  const service = serviceFor(t, dbPath, fetch);

  const pending = service.batch(
    "order",
    [{ message: "one" }, { message: "two" }, { message: "three" }, { message: "four" }],
    {
      concurrency: 2,
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    },
  );
  assert.equal(calls, 2);
  controller.abort();
  const result = await pending;

  assert.equal(calls, 2);
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.items.map((item) => item.status), [
    "error",
    "error",
    "skipped",
    "skipped",
  ]);
  assert.deepEqual(result.items.slice(0, 2).map((item) => item.errorCode), [
    "aborted",
    "aborted",
  ]);
  assert.ok(result.items.slice(0, 2).every((item) => item.requestId !== null));
  assert.ok(result.items.slice(2).every((item) => item.skipReason === "cancelled"));
  assert.equal(result.summary.processed, 2);
  assert.equal(result.summary.errors, 2);
  assert.equal(result.summary.skipped, 2);
  assert.equal(events.filter((event) => event.type === "item.skip").length, 2);

  const inspect = openDatabase(dbPath);
  const requests = new RequestRepository(inspect);
  assert.equal(requests.count({ batch: result.batchId }), 2);
  inspect.close();
});

test("batch honors save false and validates concurrency", async (t) => {
  const dbPath = await databasePath(t);
  addTemplate(dbPath);
  const fetch: FetchLike = async () =>
    new Response(responseBody(), { status: 200 });
  const service = serviceFor(t, dbPath, fetch);

  const result = await service.batch("order", [{ message: "one" }], {
    save: false,
  });
  assert.equal(result.items[0]?.requestId, null);
  await assert.rejects(
    service.batch("order", [], { concurrency: 0 }),
    /concurrency/,
  );
  await assert.rejects(
    service.batch("order", [], { concurrency: 11 }),
    /concurrency/,
  );

  const inspect = openDatabase(dbPath);
  assert.equal(new RequestRepository(inspect).count(), 0);
  inspect.close();
});

test("batch merges shared and per-context assets with item precedence", async (t) => {
  const dbPath = await databasePath(t);
  const db = openDatabase(dbPath);
  new TemplateRepository(db).save("photo", "", JSON.stringify({
    model: "jev-1.13",
    state: "{{photo}}",
    questions: { q: { type: "noul", instructions: "Compare `{{photo}}` against `shared`." } },
  }));
  db.close();

  const bodies: Array<Record<string, unknown>> = [];
  const fetch: FetchLike = async (_input, init = {}) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(responseBody(), { status: 200 });
  };
  const service = serviceFor(t, dbPath, fetch);

  const result = await service.batch("photo", [
    { photo: "ref-a", assets: { "ref-a": { type: "image", format: "jpg", data_base64: "YQ==" } } },
    { photo: "ref-b", assets: { "ref-b": { type: "image", format: "png", data_base64: "Yg==" } } },
  ], {
    assets: { shared: { type: "image", format: "jpg", data_base64: "YWJj" } },
  });

  assert.equal(result.summary.ok, 2);
  assert.deepEqual(bodies[0]?.assets, {
    shared: { type: "image", format: "jpg", data_base64: "YWJj" },
    "ref-a": { type: "image", format: "jpg", data_base64: "YQ==" },
  });
  assert.deepEqual(bodies[1]?.assets, {
    shared: { type: "image", format: "jpg", data_base64: "YWJj" },
    "ref-b": { type: "image", format: "png", data_base64: "Yg==" },
  });
  assert.equal(bodies[0]?.state, "ref-a");
  assert.equal(bodies[1]?.state, "ref-b");
});

test("batch rejects the reserved assets key when the template defines an assets macro", async (t) => {
  const dbPath = await databasePath(t);
  const db = openDatabase(dbPath);
  new TemplateRepository(db).save("collision", "", JSON.stringify({
    model: "jev-1.13",
    state: "{{assets}}",
    questions: { q: { type: "noul" } },
  }));
  db.close();

  const service = serviceFor(t, dbPath, async () => new Response(responseBody(), { status: 200 }));
  const result = await service.batch("collision", [
    { assets: { "ref-a": { type: "image", format: "jpg", data_base64: "YQ==" } } },
  ]);

  assert.equal(result.summary.ok, 0);
  assert.equal(result.summary.errors, 1);
  assert.match(result.items[0]?.error ?? "", /reserved/);
});

test("batch rejects a per-context asset that is not referenced", async (t) => {
  const dbPath = await databasePath(t);
  const db = openDatabase(dbPath);
  new TemplateRepository(db).save("photo", "", JSON.stringify({
    model: "jev-1.13",
    state: "{{photo}}",
    questions: { q: { type: "noul" } },
  }));
  db.close();

  const service = serviceFor(t, dbPath, async () => new Response(responseBody(), { status: 200 }));
  const result = await service.batch("photo", [
    { photo: "ref-a", assets: { orphan: { type: "image", format: "jpg", data_base64: "YQ==" } } },
  ]);

  assert.equal(result.summary.ok, 0);
  assert.match(result.items[0]?.error ?? "", /not used in state/);
});
