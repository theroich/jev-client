import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { NextRequest } from "next/server";

import type { FetchLike } from "../../dist/src/client.js";
import { runCli, type CliIO } from "../../dist/src/cli.js";
import { resolveTemplateBody } from "../../dist/src/template.js";
import { TEMPLATE_STARTERS } from "../../dist/src/template-starters.js";
import { POST as ask } from "../app/api/ask/route";
import { POST as batch } from "../app/api/batch/route";
import { GET as configGet, PUT as configPut } from "../app/api/config/route";
import { POST as configReset } from "../app/api/config/reset/route";
import { POST as reveal } from "../app/api/config/[key]/reveal/route";
import { POST as demo } from "../app/api/demo/route";
import { GET as health } from "../app/api/health/route";
import { GET as history } from "../app/api/history/route";
import { GET as historyDetail } from "../app/api/history/[id]/route";
import { GET as historyExport } from "../app/api/history/export/route";
import { GET as overview } from "../app/api/overview/route";
import { POST as providerCheck } from "../app/api/provider/check/route";
import { GET as sessionGet, POST as sessionPost } from "../app/api/session/route";
import { GET as templatesGet, POST as templatesPost } from "../app/api/templates/route";
import {
  DELETE as templateDelete,
  GET as templateGet,
  PATCH as templatePatch,
  PUT as templatePut,
} from "../app/api/templates/[name]/route";
import { POST as templateRender } from "../app/api/templates/render/route";
import {
  closeConsoleRuntime,
  createConsoleRuntime,
  installConsoleRuntime,
  type ConsoleRuntime,
} from "../lib/server/runtime";
import { resetSessionForTests } from "../lib/server/security";

const ORIGIN = "http://127.0.0.1:7411";
const TOKEN = "test-bootstrap-token";
let root: string;
let runtime: ConsoleRuntime;
let cookie = "";
let csrf = "";
let active = 0;
let maxActive = 0;
let providerStatus = 200;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "jev-web-routes-"));
  active = 0;
  maxActive = 0;
  providerStatus = 200;
  const fetchImpl: FetchLike = async (_input, init) => {
    if (providerStatus !== 200) {
      return new Response(JSON.stringify({ error: { code: "api_key_expired", message: "expired" } }), { status: providerStatus });
    }
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 4));
    active -= 1;
    const request = JSON.parse(String(init?.body)) as { model: string; questions: Record<string, { type: string }> };
    const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
      if (question.type === "choice") return [name, { type: "choice", choice: "infra", confidence: 0.8, probabilities: { infra: 0.8, billing: 0.2 } }];
      if (question.type === "score") return [name, { type: "score", score: 1.4, legend: { "0": "Low", "1": "Medium", "2": "High" }, probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 } }];
      return [name, { type: "noul", noul: 0.9 }];
    }));
    return new Response(JSON.stringify({ model: request.model, answers, usage: { input_tokens: 10, output_tokens: 4, cost: 0.000001 } }), { status: 200 });
  };
  const env = {
    NODE_ENV: "test" as const,
    JEV_CONSOLE_DB_PATH: path.join(root, "jev.db"),
    JEV_CONSOLE_HOST: "127.0.0.1",
    JEV_CONSOLE_PORT: "7411",
    JEV_CONSOLE_TOKEN: TOKEN,
    JEV_CONSOLE_ALLOW_REMOTE: "0",
    JEV_API_KEY: "env-test-key",
  };
  Object.assign(process.env, env);
  runtime = createConsoleRuntime({ env, fetch: fetchImpl });
  installConsoleRuntime(runtime);
  resetSessionForTests();
  const exchanged = await sessionPost(request("/api/session", "POST", { token: TOKEN, session: false }));
  assert.equal(exchanged.status, 200);
  cookie = exchanged.headers.get("set-cookie")?.split(";")[0] ?? "";
  const session = await sessionGet(request("/api/session"));
  const body = await session.json() as { csrfToken: string };
  csrf = body.csrfToken;
});

afterEach(async () => {
  closeConsoleRuntime();
  resetSessionForTests();
  await rm(root, { recursive: true, force: true });
});

function request(pathname: string, method = "GET", options: { body?: unknown; token?: string; session?: boolean; origin?: string | null } = {}): NextRequest {
  const headers = new Headers({ host: "127.0.0.1:7411" });
  if (options.session !== false) {
    headers.set("cookie", cookie);
    if (method !== "GET") headers.set("x-jev-console-token", csrf);
  }
  if (options.token) headers.set("x-jev-console-token", options.token);
  if (method !== "GET" || options.origin) headers.set("origin", options.origin === null ? "" : options.origin ?? ORIGIN);
  if (options.origin === null) headers.delete("origin");
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(`${ORIGIN}${pathname}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}

test("health is public and the session requires cookie, CSRF and Origin", async () => {
  const live = await health();
  assert.equal(live.status, 200);
  assert.equal((await live.json() as { ok: boolean }).ok, true);
  assert.equal((await overview(request("/api/overview", "GET", { session: false }))).status, 401);
  assert.equal((await configPut(request("/api/config", "PUT", { body: { model: "x" }, token: "bad" }))).status, 403);
  assert.equal((await configPut(request("/api/config", "PUT", { body: { model: "x" }, origin: "https://evil.test" }))).status, 403);
  assert.equal((await configPut(request("/api/config", "PUT", { body: { model: "x" }, origin: null }))).status, 403);
  assert.equal((await sessionPost(request("/api/session", "POST", { token: TOKEN, session: false }))).status, 401);
});

test("config masks, reveals explicitly and saves only changes", async () => {
  runtime.config.set("api_key", "sqlite-secret-key");
  runtime.config.set("api_url", "https://stored.test/systemone");
  const listed = await configGet(request("/api/config"));
  const body = await listed.json() as { entries: Array<{ key: string; value: unknown; source: string }> };
  assert.ok(!JSON.stringify(body).includes("sqlite-secret-key"));
  assert.equal(body.entries.find((entry) => entry.key === "api_key")?.source, "env");
  const revealed = await reveal(request("/api/config/api_key/reveal", "POST", { body: {} }), { params: Promise.resolve({ key: "api_key" }) });
  // The effective environment key has priority over SQLite.
  assert.equal((await revealed.json() as { value: string }).value, "env-test-key");
  const saved = await configPut(request("/api/config", "PUT", { body: { model: "web-model", timeout: 12, api_key: "new-secret" } }));
  assert.equal(saved.status, 200);
  assert.equal(runtime.config.get("model"), "web-model");
  assert.equal(runtime.config.get("timeout"), "12");
  assert.equal(runtime.config.get("api_url"), "https://stored.test/systemone");
  assert.ok(!JSON.stringify(await (await configGet(request("/api/config"))).json()).includes("new-secret"));
});

test("config validates on the server, unsets and blocks session flags", async () => {
  runtime.config.set("model", "stored-model");
  runtime.config.set("api_url", "https://stored.test/systemone");
  const invalid = await configPut(request("/api/config", "PUT", { body: { model: "must-not-be-saved", api_url: "bad" } }));
  assert.equal(invalid.status, 400);
  assert.equal(runtime.config.get("model"), "stored-model");
  assert.equal(runtime.config.get("api_url"), "https://stored.test/systemone");

  runtime.flags.model = "flag-model";
  const readonly = await configPut(request("/api/config", "PUT", { body: { model: "web-model" } }));
  assert.equal(readonly.status, 409);
  const snapshot = await configGet(request("/api/config"));
  const model = (await snapshot.json() as { entries: Array<{ key: string; editable: boolean; source: string }> }).entries.find((entry) => entry.key === "model");
  assert.equal(model?.editable, false);
  assert.equal(model?.source, "flag");
  const reset = await configReset(request("/api/config/reset", "POST", { body: {} }));
  assert.equal(reset.status, 200);
  assert.equal(runtime.config.get("model"), "stored-model", "reset does not touch the key fixed by flag");
  assert.equal(runtime.config.get("api_url"), undefined);
  delete runtime.flags.model;
  await configPut(request("/api/config", "PUT", { body: { model: "" } }));
  assert.equal(runtime.config.get("model"), undefined);
});

test("ask/demo/provider share history and export is identical to the CLI", async () => {
  const response = await ask(request("/api/ask", "POST", { body: { state: { ticket: "hello" }, questions: { q: { type: "noul" } }, save: true } }));
  assert.equal(response.status, 200, await response.clone().text());
  const execution = await response.json() as { requestId: number; request: { model: string }; usage: { inputTokens: number } };
  assert.equal(execution.requestId, 1);
  assert.equal(execution.usage.inputTokens, 10);
  assert.equal((await demo(request("/api/demo", "POST", { body: { save: false } }))).status, 200);
  assert.equal((await providerCheck(request("/api/provider/check", "POST", { body: {} }))).status, 200);
  assert.equal(runtime.requests.count(), 1);
  const list = await history(request("/api/history?limit=50"));
  assert.equal((await list.json() as { items: unknown[] }).items.length, 1);
  const detail = await historyDetail(request("/api/history/1"), { params: Promise.resolve({ id: "1" }) });
  assert.equal((await detail.json() as { id: number }).id, 1);
  const exported = await historyExport(request("/api/history/export?limit=50"));
  assert.equal(exported.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
  const webJsonl = await exported.text();
  let cliJsonl = "";
  const io: CliIO = {
    stdout: (text) => { cliJsonl += text; },
    stderr: () => {},
    readStdin: async () => "",
    env: { NODE_ENV: "test", JEV_DB: runtime.service.databasePath },
  };
  assert.equal(await runCli(["history", "export"], io), 0);
  assert.equal(webJsonl, cliJsonl);
  const keys = Object.keys(JSON.parse(webJsonl.trim()) as Record<string, unknown>);
  assert.deepEqual(keys, ["id", "created_at", "started_at", "finished_at", "duration_ms", "endpoint", "model", "status_code", "ok", "request", "response", "input_tokens", "output_tokens", "cost", "error_code", "error_message", "template_name", "batch_id", "source"]);
});

test("templates validate macros, render and rename without duplicating", async () => {
  const bodyJson = JSON.stringify({ model: "jev-1.13", state: { text: "{{ticket}}", client: "{{client.name}}" }, questions: { q: { type: "noul" } } });
  const created = await templatesPost(request("/api/templates", "POST", { body: { name: "ticket", description: "Ticket", bodyJson } }));
  assert.equal(created.status, 201);
  assert.equal((await templatesPost(request("/api/templates", "POST", { body: { name: "ticket", bodyJson } }))).status, 409);
  const missing = await templateRender(request("/api/templates/render", "POST", { body: { bodyJson, context: {} } }));
  assert.equal(missing.status, 400);
  const missingBody = await missing.json() as { error: { message: string } };
  assert.match(missingBody.error.message, /client.name/);
  assert.match(missingBody.error.message, /ticket/);
  const rendered = await templateRender(request("/api/templates/render", "POST", { body: { bodyJson, context: { ticket: "hello", client: { name: "Ana" } } } }));
  assert.equal((await rendered.json() as { request: { state: { client: string } } }).request.state.client, "Ana");
  const renamed = await templatePatch(request("/api/templates/ticket", "PATCH", { body: { name: "ticket-web" } }), { params: Promise.resolve({ name: "ticket" }) });
  assert.equal(renamed.status, 200);
  assert.equal(runtime.templates.get("ticket"), undefined);
  assert.ok(runtime.templates.get("ticket-web"));
  assert.equal((await templatesGet(request("/api/templates"))).status, 200);
});

test("macros with description are saved, merged, renamed and deleted in cascade", async () => {
  const bodyJson = JSON.stringify({
    model: "jev-1.13",
    state: { ticket: "{{ticket}}", client: "{{client.name}}" },
    questions: { q: { type: "noul" } },
  });
  const created = await templatesPost(request("/api/templates", "POST", {
    body: {
      name: "ticket",
      description: "Ticket",
      bodyJson,
      macros: [
        { name: "ticket", description: "  Order identifier (TCK-1042)  " },
        { name: "client.name", description: "Customer name", schema: null },
      ],
    },
  }));
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json() as { macros: unknown }).macros, [
    { name: "client.name", description: "Customer name", schema: null },
    { name: "ticket", description: "Order identifier (TCK-1042)", schema: null },
  ]);

  const listed = await templatesGet(request("/api/templates"));
  const items = (await listed.json() as { items: Array<{ macros: unknown }> }).items;
  assert.deepEqual(items[0]?.macros, [
    { name: "client.name", description: "Customer name", schema: null },
    { name: "ticket", description: "Order identifier (TCK-1042)", schema: null },
  ]);

  const invalid = await templatesPost(request("/api/templates", "POST", {
    body: { name: "invalid", bodyJson, macros: [{ name: "unknown", description: "x" }] },
  }));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as { error: { code: string } }).error.code, "invalid_macro");
  assert.equal(runtime.templates.get("invalid"), undefined);

  const tooLong = await templatesPost(request("/api/templates", "POST", {
    body: { name: "long", bodyJson, macros: [{ name: "ticket", description: "x".repeat(501) }] },
  }));
  assert.equal(tooLong.status, 400);
  assert.equal((await tooLong.json() as { error: { code: string } }).error.code, "invalid_macro_description");

  const withoutClient = JSON.stringify({
    model: "jev-1.13",
    state: { ticket: "{{ticket}}" },
    questions: { q: { type: "noul" } },
  });
  const updated = await templatePut(
    request("/api/templates/ticket", "PUT", {
      body: { name: "ticket", description: "Ticket", bodyJson: withoutClient, macros: [{ name: "ticket", description: "New description" }] },
    }),
    { params: Promise.resolve({ name: "ticket" }) },
  );
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json() as { macros: unknown }).macros, [
    { name: "ticket", description: "New description", schema: null },
  ]);
  assert.deepEqual(
    runtime.service.db.prepare("SELECT macro FROM template_macros ORDER BY macro").all(),
    [{ macro: "ticket" }],
  );

  const renamed = await templatePatch(
    request("/api/templates/ticket", "PATCH", { body: { name: "ticket-2" } }),
    { params: Promise.resolve({ name: "ticket" }) },
  );
  assert.equal(renamed.status, 200);
  const detail = await templateGet(
    request("/api/templates/ticket-2"),
    { params: Promise.resolve({ name: "ticket-2" }) },
  );
  assert.deepEqual((await detail.json() as { macros: unknown }).macros, [
    { name: "ticket", description: "New description", schema: null },
  ]);

  const deleted = await templateDelete(
    request("/api/templates/ticket-2", "DELETE"),
    { params: Promise.resolve({ name: "ticket-2" }) },
  );
  assert.equal(deleted.status, 200);
  assert.deepEqual(
    runtime.service.db.prepare("SELECT COUNT(*) AS total FROM template_macros").get(),
    { total: 0 },
  );
});

test("macro schemas are saved, validated, kept and cleared through the API", async () => {
  const bodyJson = JSON.stringify({
    model: "jev-1.13",
    state: { ticket: "{{ticket}}", client: "{{client.plan}}" },
    questions: { q: { type: "noul" } },
  });
  const created = await templatesPost(request("/api/templates", "POST", {
    body: {
      name: "schemas",
      description: "Schemas",
      bodyJson,
      macros: [
        { name: "ticket", description: "Ticket", schema: { type: "string", format: "uuid" } },
        { name: "client.plan", description: "Plan", schema: false },
      ],
    },
  }));
  assert.equal(created.status, 201);
  const expected = [
    { name: "client.plan", description: "Plan", schema: false },
    { name: "ticket", description: "Ticket", schema: { type: "string", format: "uuid" } },
  ];
  assert.deepEqual((await created.json() as { macros: unknown }).macros, expected);

  const listed = await templatesGet(request("/api/templates"));
  assert.deepEqual(
    (await listed.json() as { items: Array<{ macros: unknown }> }).items[0]?.macros,
    expected,
  );

  const detail = await templateGet(
    request("/api/templates/schemas"),
    { params: Promise.resolve({ name: "schemas" }) },
  );
  assert.deepEqual((await detail.json() as { macros: unknown }).macros, expected);

  const byCode = async (name: string, macros: unknown) => {
    const response = await templatesPost(request("/api/templates", "POST", {
      body: { name, bodyJson, macros },
    }));
    assert.equal(response.status, 400);
    return (await response.json() as { error: { code: string } }).error.code;
  };
  assert.equal(
    await byCode("schema-array", [{ name: "ticket", schema: ["string"] }]),
    "invalid_macro_schema",
  );
  assert.equal(
    await byCode("schema-string", [{ name: "ticket", schema: "string" }]),
    "invalid_macro_schema",
  );
  assert.equal(
    await byCode("schema-type", [{ name: "ticket", schema: { type: "text" } }]),
    "invalid_macro_schema_type",
  );
  assert.equal(
    await byCode("schema-pattern", [{ name: "ticket", schema: { pattern: "(" } }]),
    "invalid_macro_schema",
  );
  assert.equal(
    await byCode("schema-ref", [{ name: "ticket", schema: { $ref: "https://example.com/s.json" } }]),
    "invalid_macro_schema",
  );
  assert.equal(
    await byCode("schema-big", [{ name: "ticket", schema: { description: "x".repeat(9000) } }]),
    "invalid_macro_schema",
  );
  for (const name of ["schema-array", "schema-type", "schema-pattern", "schema-ref", "schema-big"]) {
    assert.equal(runtime.templates.get(name), undefined);
  }

  // `schema: null` clears the schema and keeps the description.
  const updated = await templatePut(
    request("/api/templates/schemas", "PUT", {
      body: {
        name: "schemas",
        description: "Schemas",
        bodyJson,
        macros: [
          { name: "ticket", description: "Ticket", schema: null },
          { name: "client.plan", description: "Plan", schema: { type: "string", enum: ["free", "pro"] } },
        ],
      },
    }),
    { params: Promise.resolve({ name: "schemas" }) },
  );
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json() as { macros: unknown }).macros, [
    { name: "client.plan", description: "Plan", schema: { type: "string", enum: ["free", "pro"] } },
    { name: "ticket", description: "Ticket", schema: null },
  ]);

  // Renaming keeps the schemas and deleting removes them in cascade.
  const renamed = await templatePatch(
    request("/api/templates/schemas", "PATCH", { body: { name: "schemas-2" } }),
    { params: Promise.resolve({ name: "schemas" }) },
  );
  assert.equal(renamed.status, 200);
  assert.deepEqual((await renamed.json() as { macros: unknown }).macros, [
    { name: "client.plan", description: "Plan", schema: { type: "string", enum: ["free", "pro"] } },
    { name: "ticket", description: "Ticket", schema: null },
  ]);
  const removed = await templateDelete(
    request("/api/templates/schemas-2", "DELETE"),
    { params: Promise.resolve({ name: "schemas-2" }) },
  );
  assert.equal(removed.status, 200);
  assert.deepEqual(
    runtime.service.db.prepare("SELECT COUNT(*) AS total FROM template_macros").get(),
    { total: 0 },
  );
});

test("template starters are saved through the API and match the CLI show and render", async () => {
  const context = {
    order_state: "I was charged twice and I want a refund.",
    customer: { name: "Ana", plan: "pro" },
  };
  const io = (): { cli: CliIO; output: () => string } => {
    let output = "";
    return {
      cli: {
        stdout: (text) => { output += text; },
        stderr: () => {},
        readStdin: async () => "",
        env: { NODE_ENV: "test", JEV_DB: runtime.service.databasePath },
      },
      output: () => output,
    };
  };

  for (const starter of TEMPLATE_STARTERS) {
    const name = `starter-${starter.id}`;
    const bodyJson = JSON.stringify(starter.body, null, 2);
    const created = await templatesPost(request("/api/templates", "POST", { body: { name, description: starter.description, bodyJson } }));
    assert.equal(created.status, 201, starter.id);

    const show = io();
    assert.equal(await runCli(["template", "show", name, "--json"], show.cli), 0);
    const shown = JSON.parse(show.output()) as { name: string; description: string; body: unknown };
    assert.equal(shown.name, name);
    assert.equal(shown.description, starter.description);
    assert.deepEqual(shown.body, starter.body);

    const rendered = await templateRender(request("/api/templates/render", "POST", { body: { bodyJson, context } }));
    assert.equal(rendered.status, 200, starter.id);
    const webRequest = (await rendered.json() as { request: unknown }).request;

    const render = io();
    assert.equal(await runCli(["template", "render", name, "--context", JSON.stringify(context)], render.cli), 0);
    const cliRequest = JSON.parse(render.output()) as unknown;

    assert.deepEqual(cliRequest, webRequest);
    assert.deepEqual(cliRequest, resolveTemplateBody(bodyJson, context));
  }
});

test("batch stream uses a pool, a shared batch_id and summarizes in NDJSON", async () => {
  runtime.templates.save("batch", "Batch", JSON.stringify({ model: "jev-1.13", state: "{{message}}", questions: { q: { type: "noul" } } }));
  const response = await batch(request("/api/batch", "POST", { body: { templateName: "batch", contexts: [{ message: "one" }, { message: "two" }, { message: "three" }], concurrency: 3, save: true } }));
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as { type: string; batchId?: string; requestId?: number | null; summary?: { ok: number; inputTokens: number } });
  const start = events.find((event) => event.type === "batch.start");
  assert.ok(start?.batchId);
  assert.equal(events.filter((event) => event.type === "item.start").length, 3);
  assert.equal(events.filter((event) => event.type === "item.finish").length, 3);
  assert.equal(events.find((event) => event.type === "batch.finish")?.summary?.ok, 3);
  assert.equal(events.find((event) => event.type === "batch.finish")?.summary?.inputTokens, 30);
  assert.equal(maxActive, 3);
  const rows = runtime.requests.list();
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.batchId === start.batchId && row.templateName === "batch"));

  const noSave = await batch(request("/api/batch", "POST", { body: { templateName: "batch", contexts: [{ message: "no history" }], save: false } }));
  const noSaveEvents = (await noSave.text()).trim().split("\n").map((line) => JSON.parse(line) as { type: string; requestId?: number | null });
  assert.ok(noSaveEvents.filter((event) => event.type === "item.finish").every((event) => event.requestId === null));
  assert.equal(runtime.requests.count(), 3);
});

test("ask validates state and questions without calling the provider", async () => {
  const empty = await ask(request("/api/ask", "POST", { body: { state: "", questions: { q: { type: "noul" } } } }));
  assert.equal(empty.status, 400);
  const invalid = await ask(request("/api/ask", "POST", { body: { state: "hello", questions: { q: { type: "invented" } } } }));
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json() as { error: { message: string } }).error.message, /unsupported type/);
  assert.equal(runtime.requests.count(), 0);
});

test("ask accepts assets and redacts them when persisting", async () => {
  const png = Buffer.alloc(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(300, 16);
  png.writeUInt32BE(300, 20);

  const response = await ask(request("/api/ask", "POST", {
    body: {
      state: { photo: "ref-1" },
      questions: { animal: { type: "noul", instructions: "What is in ref-1?" } },
      save: true,
      assets: { "ref-1": { data_base64: png.toString("base64"), format: "png" } },
    },
  }));
  assert.equal(response.status, 200);
  const execution = await response.json() as { requestId: number };
  const row = runtime.requests.get(execution.requestId);
  assert.ok(row);
  assert.equal((row.requestJson ?? "").includes("data_base64"), false);

  const invalid = await ask(request("/api/ask", "POST", {
    body: { state: "hello", questions: { q: { type: "noul" } }, assets: { "ref-x": { format: "png" } } },
  }));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as { error: { code: string } }).error.code, "invalid_assets");
});

test("a provider 401 is distinguished from an invalid session", async () => {
  providerStatus = 401;
  const response = await ask(request("/api/ask", "POST", { body: { state: "hello", questions: { q: { type: "noul" } }, save: false } }));
  assert.equal(response.status, 502);
  const body = await response.json() as { error: { code: string; hint: string; details: { providerStatus: number } } };
  assert.equal(body.error.code, "api_key_expired");
  assert.equal(body.error.details.providerStatus, 401);
  assert.match(body.error.hint, /expired/);
  const check = await providerCheck(request("/api/provider/check", "POST", { body: {} }));
  assert.equal(check.status, 502);
  const checkBody = await check.json() as { error: { details: { providerStatus: number; latencyMs: number } } };
  assert.equal(checkBody.error.details.providerStatus, 401);
  assert.equal(typeof checkBody.error.details.latencyMs, "number");
});
