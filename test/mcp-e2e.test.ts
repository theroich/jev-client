import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { openDatabase } from "../src/database.js";

const TEMPLATE_BODY = JSON.stringify({
  model: "jev-1.13",
  state: { ticket: "{{ticket}}", cliente: "{{cliente.nombre}}" },
  questions: { urgent: { type: "noul", instructions: "¿Es urgente?" } },
});

async function fakeJevServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body) as {
        model: string;
        questions: Record<string, { type: string }>;
      };
      const answers = Object.fromEntries(
        Object.entries(parsed.questions).map(([name, question]) => {
          if (question.type === "choice") {
            return [name, { type: "choice", choice: "infra", confidence: 0.7 }];
          }
          if (question.type === "score") {
            return [name, { type: "score", score: 1.2 }];
          }
          return [name, { type: "noul", noul: 0.55 }];
        }),
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: parsed.model,
          answers,
          usage: { input_tokens: 11, output_tokens: 5, cost: 0.000002 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}/v1/systemone` };
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

test("E2E stdio: handshake, tools por plantilla, ejecución y persistencia", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "jev-mcp-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "jev.db");

  const { server, url } = await fakeJevServer();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/src/mcp-bin.js", "--db", dbPath, "--url", url, "--key", "test-key"],
    stderr: "inherit",
  });
  const client = new Client({ name: "e2e", version: "1" }, { capabilities: {} });
  await client.connect(transport);
  t.after(() => client.close());

  // Crear plantilla → tool dinámica.
  const create = await callText(client, "jev_template_create", {
    name: "pedido",
    description: "Pedido de soporte",
    body: TEMPLATE_BODY,
  });
  assert.equal(create.isError, undefined);

  const list = await client.listTools();
  assert.ok(list.tools.some((tool) => tool.name === "pedido"));

  // Invocar la tool dinámica → llama a Jev y guarda con template_name.
  const dynamic = await callText(client, "pedido", {
    ticket: "TCK-1",
    "cliente.nombre": "Ana",
  });
  assert.equal(dynamic.isError, undefined);
  const dynamicPayload = dynamic.json as { requestId: number; answers: Record<string, unknown> };
  assert.equal(typeof dynamicPayload.requestId, "number");
  assert.equal(
    (dynamicPayload.answers as { urgent: { noul: number } }).urgent.noul,
    0.55,
  );

  // jev_ask y jev_batch.
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
  assert.equal(batchJson.items.length, 2);

  // Historial expone source=mcp y template_name.
  const history = await callText(client, "jev_history_list");
  const rows = history.json as Array<{ source: string; template_name: string | null; batch_id: string | null }>;
  assert.ok(rows.length >= 4);
  assert.ok(rows.every((row) => row.source === "mcp"));
  assert.ok(rows.some((row) => row.template_name === "pedido"));

  // La persistencia es real en SQLite.
  await client.close();
  const db = openDatabase(dbPath);
  const persisted = db.prepare("SELECT source, template_name, batch_id FROM requests ORDER BY id").all() as Array<{
    source: string;
    template_name: string | null;
    batch_id: string | null;
  }>;
  db.close();
  assert.ok(persisted.length >= 4);
  assert.ok(persisted.every((row) => row.source === "mcp"));
  assert.ok(persisted.some((row) => row.template_name === "pedido"));
  assert.ok(persisted.some((row) => row.batch_id === batchJson.batchId));
});
