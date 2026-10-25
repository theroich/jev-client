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
  state: { ticket: "{{ticket}}", cliente: "{{cliente.nombre}}" },
  questions: { urgent: { type: "noul", instructions: "¿Es urgente?" } },
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

test("tools/list publica las tools fijas y una por plantilla", async (t) => {
  const { client, ctx, close } = await connect();
  t.after(close);
  new TemplateRepository(ctx.service.db).save("pedido", "Pedido de soporte", TEMPLATE_BODY, [
    { name: "ticket", description: "Identificador del pedido" },
    { name: "cliente.nombre", description: "Nombre del cliente" },
  ]);

  const list = (await client.listTools()) as ListToolsResult;
  const names = list.tools.map((tool) => tool.name);
  assert.ok(names.includes("jev_overview"));
  assert.ok(names.includes("pedido"));

  const dynamic = list.tools.find((tool) => tool.name === "pedido");
  assert.ok(dynamic);
  assert.equal(dynamic.description, "Pedido de soporte");
  const schema = dynamic.inputSchema as unknown as {
    additionalProperties: boolean;
    required: string[];
    properties: Record<string, { description?: string }>;
  };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["cliente.nombre", "ticket"]);
  assert.equal(schema.properties["cliente.nombre"]?.description, "Nombre del cliente");
});

test("invocar la tool de una plantilla ejecuta y guarda con source=mcp", async (t) => {
  const { client, ctx, close } = await connect();
  t.after(close);
  new TemplateRepository(ctx.service.db).save("pedido", "", TEMPLATE_BODY);

  const result = await callText(client, "pedido", {
    ticket: "TCK-1",
    "cliente.nombre": "Ana",
  });
  assert.equal(result.isError, undefined);
  const payload = result.json as { requestId: number; answers: Record<string, unknown> };
  assert.equal(typeof payload.requestId, "number");
  assert.equal((payload.answers as { urgent: { noul: number } }).urgent.noul, 0.9);

  const row = new RequestRepository(ctx.service.db).get(payload.requestId);
  assert.equal(row?.templateName, "pedido");
  assert.equal(row?.source, "mcp");
});

test("jev_ask y jev_batch persisten y devuelven requestId/batch_id", async (t) => {
  const { client, ctx, close } = await connect();
  t.after(close);
  new TemplateRepository(ctx.service.db).save("pedido", "", TEMPLATE_BODY);

  const ask = await callText(client, "jev_ask", {
    state: "hola",
    questions: { q: { type: "noul", instructions: "¿?" } },
  });
  assert.equal(ask.isError, undefined);
  assert.equal(typeof (ask.json as { requestId: number }).requestId, "number");

  const batch = await callText(client, "jev_batch", {
    template: "pedido",
    contexts: [{ ticket: "a", "cliente.nombre": "Ana" }, { ticket: "b", "cliente.nombre": "Luis" }],
  });
  assert.equal(batch.isError, undefined);
  const batchJson = batch.json as { batchId: string; items: Array<{ requestId: number }> };
  assert.equal(typeof batchJson.batchId, "string");
  assert.equal(batchJson.items.length, 2);
  const firstItem = batchJson.items[0] as { requestId: number };
  assert.equal(new RequestRepository(ctx.service.db).get(firstItem.requestId)?.batchId, batchJson.batchId);
});

test("las mutaciones emiten tools/list_changed", async (t) => {
  const { client, ctx, close } = await connect();
  t.after(close);
  const changed: string[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changed.push("changed");
  });

  await callText(client, "jev_template_create", {
    name: "nueva",
    body: TEMPLATE_BODY,
  });
  assert.equal(changed.length, 1);

  await callText(client, "jev_template_update", { name: "nueva", renameTo: "renombrada" });
  assert.equal(changed.length, 2);

  const list = (await client.listTools()) as ListToolsResult;
  assert.ok(list.tools.some((tool) => tool.name === "renombrada"));
  assert.ok(!ctx.templates.get("nueva"));
});

test("jev_template_render no llama a Jev y falla listando ausentes", async (t) => {
  const { client, ctx, close } = await connect();
  t.after(close);
  new TemplateRepository(ctx.service.db).save("pedido", "", TEMPLATE_BODY);

  const ok = await callText(client, "jev_template_render", {
    name: "pedido",
    context: { ticket: "x", "cliente.nombre": "Ana" },
  });
  assert.equal(ok.isError, undefined);

  const missing = await callText(client, "jev_template_render", {
    name: "pedido",
    context: { ticket: "x" },
  });
  assert.equal(missing.isError, true);
  assert.equal((missing.json as { code: string }).code, "invalid_render");
});

test("jev_config_get enmascara la API key", async (t) => {
  const { client, ctx, close } = await connect({}, {});
  t.after(close);
  new ConfigRepository(ctx.service.db).set("api_key", "sk-super-secret-key-123456");

  const result = await callText(client, "jev_config_get");
  const payload = result.json as { hasApiKey: boolean; apiKeyMasked: string };
  assert.equal(payload.hasApiKey, true);
  assert.ok(!payload.apiKeyMasked.includes("super-secret"));
  assert.ok(payload.apiKeyMasked.includes("…"));
});

test("--no-execute oculta las tools de ejecución y las dinámicas", async (t) => {
  const { client, ctx, close } = await connect({ noExecute: true });
  t.after(close);
  new TemplateRepository(ctx.service.db).save("pedido", "", TEMPLATE_BODY);

  const list = (await client.listTools()) as ListToolsResult;
  const names = list.tools.map((tool) => tool.name);
  assert.ok(!names.includes("jev_ask"));
  assert.ok(!names.includes("jev_batch"));
  assert.ok(!names.includes("pedido"));
  assert.ok(names.includes("jev_template_list"));
});

test("--read-only deshabilita mutaciones; --allow-destructive habilita delete", async (t) => {
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

test("borrar exige confirm y no está disponible sin --allow-destructive", async (t) => {
  const { client, ctx, close } = await connect();
  t.after(close);
  new TemplateRepository(ctx.service.db).save("pedido", "", TEMPLATE_BODY);

  const notFound = await callText(client, "jev_template_delete", { name: "pedido", confirm: true });
  assert.equal(notFound.isError, true);
  assert.equal((notFound.json as { code: string }).code, "tool_not_found");

  const destructive = await connect({ allowDestructive: true });
  t.after(destructive.close);
  new TemplateRepository(destructive.ctx.service.db).save("pedido", "", TEMPLATE_BODY);

  const noConfirm = await callText(destructive.client, "jev_template_delete", { name: "pedido" });
  assert.equal(noConfirm.isError, true);
  assert.equal((noConfirm.json as { code: string }).code, "confirmation_required");

  const confirmed = await callText(destructive.client, "jev_template_delete", { name: "pedido", confirm: true });
  assert.equal(confirmed.isError, undefined);
});

test("errores de plantilla llegan como isError con código", async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const result = await callText(client, "jev_template_get", { name: "inexistente" });
  assert.equal(result.isError, true);
  assert.equal((result.json as { code: string }).code, "template_not_found");
});

test("jev_history_list y jev_history_get exponen source", async (t) => {
  const { client, ctx, close } = await connect();
  t.after(close);

  await callText(client, "jev_ask", { state: "hola", questions: { q: { type: "noul", instructions: "¿?" } } });
  const list = await callText(client, "jev_history_list");
  const rows = list.json as Array<{ id: number; source: string }>;
  assert.ok(rows.length >= 1);
  const first = rows[0] as { id: number; source: string };
  assert.equal(first.source, "mcp");

  const detail = await callText(client, "jev_history_get", { id: first.id });
  assert.equal((detail.json as { source: string }).source, "mcp");
  assert.equal(ctx.requests.count(), rows.length);
});
