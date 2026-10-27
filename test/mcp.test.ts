import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ToolListChangedNotificationSchema,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

import type { FetchLike } from "../src/client.js";
import { ConfigRepository } from "../src/config-repository.js";
import { createMcpContext, type McpServerOptions } from "../src/mcp/context.js";
import { createMcpServer } from "../src/mcp/server.js";
import { RequestRepository } from "../src/request-repository.js";
import { JevService } from "../src/service.js";
import { TemplateRepository } from "../src/template-repository.js";

const TEMPLATE_BODY = JSON.stringify({
  model: "jev-1.13",
  state: { ticket: "{{ticket}}", customer: "{{customer.name}}" },
  questions: { urgent: { type: "noul", instructions: "Is it urgent?" } },
});

function fakeFetch(): FetchLike {
  return async (_input, init = {}) => {
    const body = JSON.parse(String(init.body)) as {
      model: string;
      questions: Record<string, { type: string }>;
    };
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([name, question]) => {
        if (question.type === "choice") {
          return [name, { type: "choice", choice: "infra", confidence: 0.8 }];
        }
        if (question.type === "score") {
          return [name, { type: "score", score: 1.4 }];
        }
        return [name, { type: "noul", noul: 0.9 }];
      }),
    );
    return new Response(
      JSON.stringify({
        model: body.model,
        answers,
        usage: { input_tokens: 10, output_tokens: 4, cost: 0.000001 },
      }),
      { status: 200 },
    );
  };
}

interface Connected {
  client: Client;
  ctx: ReturnType<typeof createMcpContext>;
  close(): Promise<void>;
}

async function connect(
  options: McpServerOptions = {},
  env: NodeJS.ProcessEnv = { OPENCODE_API_KEY: "test-key" },
): Promise<Connected> {
  const service = new JevService({ dbPath: ":memory:", env, fetch: fakeFetch() });
  const ctx = createMcpContext(service, {}, options, env);
  const server = createMcpServer(ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    ctx,
    close: async () => {
      await client.close();
      await server.close();
      service.close();
    },
  };
}

async function callText(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError?: boolean; json: unknown }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>).map((c) => c.text).join("");
  return { isError: result.isError as boolean | undefined, json: JSON.parse(text) };
}

test("tools/list publishes the built-in tools and one per template", async (t) => {
  const { client, ctx, close } = await connect();
  t.after(close);
  new TemplateRepository(ctx.service.db).save("order", "Order request", TEMPLATE_BODY, [
    { name: "ticket", description: "Order identifier" },
    { name: "customer.name", description: "Customer name" },
  ]);

  const list = (await client.listTools()) as ListToolsResult;
  const names = list.tools.map((tool) => tool.name);
  assert.ok(names.includes("jev_overview"));
  assert.ok(names.includes("order"));

  const dynamic = list.tools.find((tool) => tool.name === "order");
  assert.ok(dynamic);
  assert.equal(dynamic.description, "Order request");
  const schema = dynamic.inputSchema as unknown as {
    additionalProperties: boolean;
    required: string[];
    properties: Record<string, { description?: string }>;
  };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["customer.name", "ticket"]);
  assert.equal(schema.properties["customer.name"]?.description, "Customer name");
});

test("invoking a template tool executes and stores with source=mcp", async (t) => {
  const { client, ctx, close } = await connect();
  t.after(close);
  new TemplateRepository(ctx.service.db).save("order", "", TEMPLATE_BODY);

  const result = await callText(client, "order", {
    ticket: "TCK-1",
    "customer.name": "Ana",
  });
  assert.equal(result.isError, undefined);
  const payload = result.json as { requestId: number; answers: Record<string, unknown> };
  assert.equal(typeof payload.requestId, "number");
  assert.equal((payload.answers as { urgent: { noul: number } }).urgent.noul, 0.9);

  const row = new RequestRepository(ctx.service.db).get(payload.requestId);
  assert.equal(row?.templateName, "order");
  assert.equal(row?.source, "mcp");
});

test("jev_ask and jev_batch persist and return requestId/batch_id", async (t) => {
  const { client, ctx, close } = await connect();
  t.after(close);
  new TemplateRepository(ctx.service.db).save("order", "", TEMPLATE_BODY);

  const ask = await callText(client, "jev_ask", {
    state: "hello",
    questions: { q: { type: "noul", instructions: "?" } },
  });
  assert.equal(ask.isError, undefined);
  assert.equal(typeof (ask.json as { requestId: number }).requestId, "number");

  const batch = await callText(client, "jev_batch", {
    template: "order",
    contexts: [{ ticket: "a", "customer.name": "Ana" }, { ticket: "b", "customer.name": "Luis" }],
  });
  assert.equal(batch.isError, undefined);
  const batchJson = batch.json as { batchId: string; items: Array<{ requestId: number }> };
  assert.equal(typeof batchJson.batchId, "string");
  assert.equal(batchJson.items.length, 2);
  const firstItem = batchJson.items[0] as { requestId: number };
  assert.equal(new RequestRepository(ctx.service.db).get(firstItem.requestId)?.batchId, batchJson.batchId);
});

test("mutations emit tools/list_changed", async (t) => {
  const { client, ctx, close } = await connect();
  t.after(close);
  const changed: string[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changed.push("changed");
  });

  await callText(client, "jev_template_create", {
    name: "draft",
    body: TEMPLATE_BODY,
  });
  assert.equal(changed.length, 1);

  await callText(client, "jev_template_update", { name: "draft", renameTo: "renamed" });
  assert.equal(changed.length, 2);

  const list = (await client.listTools()) as ListToolsResult;
  assert.ok(list.tools.some((tool) => tool.name === "renamed"));
  assert.ok(!ctx.templates.get("draft"));
});

test("jev_template_render does not call Jev and fails listing missing macros", async (t) => {
  const { client, ctx, close } = await connect();
  t.after(close);
  new TemplateRepository(ctx.service.db).save("order", "", TEMPLATE_BODY);

  const ok = await callText(client, "jev_template_render", {
    name: "order",
    context: { ticket: "x", "customer.name": "Ana" },
  });
  assert.equal(ok.isError, undefined);

  const missing = await callText(client, "jev_template_render", {
    name: "order",
    context: { ticket: "x" },
  });
  assert.equal(missing.isError, true);
  assert.equal((missing.json as { code: string }).code, "invalid_render");
});

test("jev_config_get masks the API key", async (t) => {
  const { client, ctx, close } = await connect({}, {});
  t.after(close);
  new ConfigRepository(ctx.service.db).set("api_key", "sk-super-secret-key-123456");

  const result = await callText(client, "jev_config_get");
  const payload = result.json as { hasApiKey: boolean; apiKeyMasked: string };
  assert.equal(payload.hasApiKey, true);
  assert.ok(!payload.apiKeyMasked.includes("super-secret"));
  assert.ok(payload.apiKeyMasked.includes("…"));
});

test("--no-execute hides the execution and dynamic tools", async (t) => {
  const { client, ctx, close } = await connect({ noExecute: true });
  t.after(close);
  new TemplateRepository(ctx.service.db).save("order", "", TEMPLATE_BODY);

  const list = (await client.listTools()) as ListToolsResult;
  const names = list.tools.map((tool) => tool.name);
  assert.ok(!names.includes("jev_ask"));
  assert.ok(!names.includes("jev_batch"));
  assert.ok(!names.includes("order"));
  assert.ok(names.includes("jev_template_list"));
});

test("--read-only disables mutations; --allow-destructive enables delete", async (t) => {
  const readOnly = await connect({ readOnly: true });
  t.after(readOnly.close);
  const readOnlyList = (await readOnly.client.listTools()) as ListToolsResult;
  const readOnlyNames = readOnlyList.tools.map((tool) => tool.name);
  assert.ok(!readOnlyNames.includes("jev_template_create"));
  assert.ok(readOnlyNames.includes("jev_template_list"));

  const destructive = await connect({ allowDestructive: true });
  t.after(destructive.close);
  const destructiveList = (await destructive.client.listTools()) as ListToolsResult;
  assert.ok(destructiveList.tools.some((tool) => tool.name === "jev_template_delete"));
});

test("delete requires confirm and is unavailable without --allow-destructive", async (t) => {
  const { client, ctx, close } = await connect();
  t.after(close);
  new TemplateRepository(ctx.service.db).save("order", "", TEMPLATE_BODY);

  const notFound = await callText(client, "jev_template_delete", { name: "order", confirm: true });
  assert.equal(notFound.isError, true);
  assert.equal((notFound.json as { code: string }).code, "tool_not_found");

  const destructive = await connect({ allowDestructive: true });
  t.after(destructive.close);
  new TemplateRepository(destructive.ctx.service.db).save("order", "", TEMPLATE_BODY);

  const noConfirm = await callText(destructive.client, "jev_template_delete", { name: "order" });
  assert.equal(noConfirm.isError, true);
  assert.equal((noConfirm.json as { code: string }).code, "confirmation_required");

  const confirmed = await callText(destructive.client, "jev_template_delete", { name: "order", confirm: true });
  assert.equal(confirmed.isError, undefined);
});

test("template errors come back as isError with a code", async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const result = await callText(client, "jev_template_get", { name: "missing" });
  assert.equal(result.isError, true);
  assert.equal((result.json as { code: string }).code, "template_not_found");
});

test("jev_history_list and jev_history_get expose source", async (t) => {
  const { client, ctx, close } = await connect();
  t.after(close);

  await callText(client, "jev_ask", { state: "hello", questions: { q: { type: "noul", instructions: "?" } } });
  const list = await callText(client, "jev_history_list");
  const rows = list.json as Array<{ id: number; source: string }>;
  assert.ok(rows.length >= 1);
  const first = rows[0] as { id: number; source: string };
  assert.equal(first.source, "mcp");

  const detail = await callText(client, "jev_history_get", { id: first.id });
  assert.equal((detail.json as { source: string }).source, "mcp");
  assert.equal(ctx.requests.count(), rows.length);
});

function pngBase64(width: number, height: number): string {
  const buffer = Buffer.alloc(24);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer.toString("base64");
}

test("jev_ask accepts assets and redacts them when persisting", async (t) => {
  const { client, ctx, close } = await connect();
  t.after(close);

  const result = await callText(client, "jev_ask", {
    state: { photo: "ref-1" },
    questions: { animal: { type: "noul", instructions: "What is in ref-1?" } },
    assets: { "ref-1": { data_base64: pngBase64(300, 300), format: "png" } },
  });
  assert.equal(result.isError, undefined);
  const requestId = (result.json as { requestId: number }).requestId;
  const row = new RequestRepository(ctx.service.db).get(requestId);
  assert.ok(row);
  assert.equal((row.requestJson ?? "").includes("data_base64"), false);
});

test("jev_image_check returns dimensions and the rejection reason", async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const ok = await callText(client, "jev_image_check", {
    data_base64: pngBase64(300, 300),
    format: "png",
  });
  assert.equal(ok.isError, undefined);
  const okJson = ok.json as { ok: boolean; width: number; height: number; reason: string | null };
  assert.equal(okJson.ok, true);
  assert.equal(okJson.width, 300);
  assert.equal(okJson.height, 300);
  assert.equal(okJson.reason, null);

  const small = await callText(client, "jev_image_check", {
    data_base64: pngBase64(50, 50),
    format: "png",
  });
  const smallJson = small.json as { ok: boolean; reason: string | null };
  assert.equal(smallJson.ok, false);
  assert.match(smallJson.reason ?? "", /minimum per side/);
});

test("jev_image_check validates base64 before decoding", async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const result = await callText(client, "jev_image_check", {
    data_base64: "data:abc",
    format: "png",
  });
  assert.equal(result.isError, true);
  assert.equal((result.json as { code: string }).code, "invalid_arguments");
});
