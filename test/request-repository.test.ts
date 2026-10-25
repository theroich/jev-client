import test from "node:test";
import assert from "node:assert/strict";

import { openDatabase } from "../src/database.js";
import { RequestRepository } from "../src/request-repository.js";
import type { RequestLog } from "../src/types.js";

function log(overrides: Partial<RequestLog> = {}): RequestLog {
  return {
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    finishedAt: new Date("2026-01-01T00:00:00.123Z"),
    durationMs: 123,
    endpoint: "https://example.test/systemone",
    model: "jev-1.13",
    statusCode: 200,
    ok: true,
    requestBody: {
      model: "jev-1.13",
      state: "hola",
      questions: { q: { type: "noul" } },
    },
    responseBody: JSON.stringify({
      answers: { q: { type: "noul", noul: 0.99 } },
      usage: { input_tokens: 10, output_tokens: 5, cost: 1.5e-6 },
    }),
    inputTokens: 10,
    outputTokens: 5,
    cost: 1.5e-6,
    ...overrides,
  };
}

test("inserta y lee una petición correcta", () => {
  const db = openDatabase(":memory:");
  const repository = new RequestRepository(db);

  const id = repository.insert(log());
  const record = repository.get(id);

  assert.ok(record);
  assert.equal(record.id, id);
  assert.equal(record.ok, true);
  assert.equal(record.statusCode, 200);
  assert.equal(record.model, "jev-1.13");
  assert.equal(record.endpoint, "https://example.test/systemone");
  assert.equal(record.durationMs, 123);
  assert.equal(record.inputTokens, 10);
  assert.equal(record.outputTokens, 5);
  assert.equal(record.cost, 1.5e-6);
  assert.equal(record.startedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(record.finishedAt, "2026-01-01T00:00:00.123Z");
  assert.deepEqual(JSON.parse(record.requestJson ?? "null"), {
    model: "jev-1.13",
    state: "hola",
    questions: { q: { type: "noul" } },
  });

  db.close();
});

test("el coste y los tokens son NULL cuando la API no los informa", () => {
  const db = openDatabase(":memory:");
  const repository = new RequestRepository(db);

  const id = repository.insert(
    log({ inputTokens: undefined, outputTokens: undefined, cost: undefined }),
  );
  const record = repository.get(id);

  assert.ok(record);
  assert.equal(record.inputTokens, null);
  assert.equal(record.outputTokens, null);
  assert.equal(record.cost, null);

  db.close();
});

test("registra una petición fallida con su error", () => {
  const db = openDatabase(":memory:");
  const repository = new RequestRepository(db);

  const id = repository.insert(
    log({
      ok: false,
      statusCode: 422,
      inputTokens: undefined,
      outputTokens: undefined,
      cost: undefined,
      responseBody: JSON.stringify({
        detail: [{ loc: ["body", "questions"], msg: "Field required" }],
      }),
      errorCode: "validation_error",
      errorMessage: "body.questions: Field required",
    }),
  );
  const record = repository.get(id);

  assert.ok(record);
  assert.equal(record.ok, false);
  assert.equal(record.statusCode, 422);
  assert.equal(record.errorCode, "validation_error");
  assert.equal(record.errorMessage, "body.questions: Field required");
  assert.equal(
    record.responseJson,
    JSON.stringify({
      detail: [{ loc: ["body", "questions"], msg: "Field required" }],
    }),
  );

  db.close();
});

test("lista por id descendente y aplica filtros", () => {
  const db = openDatabase(":memory:");
  const repository = new RequestRepository(db);

  repository.insert(log({ model: "a" }));
  repository.insert(log({ model: "b", statusCode: 500, ok: false }));
  repository.insert(log({ model: "a", templateName: "t1" }));

  assert.deepEqual(
    repository.list().map((record) => record.id),
    [3, 2, 1],
  );
  assert.deepEqual(
    repository.list({ model: "a" }).map((record) => record.id),
    [3, 1],
  );
  assert.deepEqual(
    repository.list({ status: 500 }).map((record) => record.id),
    [2],
  );
  assert.deepEqual(
    repository.list({ template: "t1" }).map((record) => record.id),
    [3],
  );
  assert.deepEqual(
    repository.list({ limit: 2 }).map((record) => record.id),
    [3, 2],
  );

  db.close();
});

test("el filtro --since es inclusivo sobre created_at", () => {
  const db = openDatabase(":memory:");
  const repository = new RequestRepository(db);

  repository.insert(log());
  repository.insert(log());

  const all = repository.list();
  const created = all[all.length - 1]?.createdAt;
  assert.ok(created);

  assert.equal(repository.list({ since: created }).length, all.length);
  assert.equal(
    repository.list({ since: "2099-01-01T00:00:00.000Z" }).length,
    0,
  );

  db.close();
});

test("devuelve undefined para un id inexistente", () => {
  const db = openDatabase(":memory:");
  const repository = new RequestRepository(db);
  assert.equal(repository.get(999), undefined);
  db.close();
});

test("filtra por batch de forma parametrizada y expone count y facets", () => {
  const db = openDatabase(":memory:");
  const repository = new RequestRepository(db);

  repository.insert(log({ model: "a", templateName: "t1", batchId: "b1" }));
  repository.insert(
    log({ model: "b", statusCode: 500, ok: false, batchId: "b2" }),
  );
  repository.insert(log({ model: "a", templateName: "t2", batchId: "b1" }));

  assert.deepEqual(
    repository.list({ batch: "b1" }).map((record) => record.id),
    [3, 1],
  );
  assert.deepEqual(
    repository.list({ batch: "b1", model: "a", limit: 1 }).map(
      (record) => record.id,
    ),
    [3],
  );
  assert.equal(repository.list({ batch: "b1' OR 1=1 --" }).length, 0);
  assert.equal(repository.count(), 3);
  assert.equal(repository.count({ batch: "b1" }), 2);
  assert.equal(repository.count({ batch: "b1", limit: 1 }), 2);
  assert.deepEqual(repository.facets(), {
    models: ["a", "b"],
    templates: ["t1", "t2"],
    statuses: [200, 500],
    batches: ["b1", "b2"],
  });

  db.close();
});

test("crea los índices sobre created_at, model y template_name", () => {
  const db = openDatabase(":memory:");
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'requests'",
    )
    .all() as Array<{ name: string }>;
  const names = rows.map((row) => row.name).sort();

  assert.deepEqual(names, [
    "idx_requests_created_at",
    "idx_requests_model",
    "idx_requests_template_name",
  ]);

  db.close();
});
