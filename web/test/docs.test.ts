import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { NextRequest } from "next/server";

import { TemplateRepository } from "../../dist/src/template-repository.js";
import { GET as docs } from "../app/api/docs/route";
import { GET as docsExamples } from "../app/api/docs/examples/route";
import { GET as docsMcp } from "../app/api/docs/mcp/route";
import { GET as docsTool } from "../app/api/docs/tools/[name]/route";
import { GET as docsTools } from "../app/api/docs/tools/route";
import { POST as sessionPost } from "../app/api/session/route";
import {
  closeConsoleRuntime,
  createConsoleRuntime,
  installConsoleRuntime,
  type ConsoleRuntime,
} from "../lib/server/runtime";
import { resetSessionForTests } from "../lib/server/security";

const ORIGIN = "http://127.0.0.1:7411";
const TOKEN = "test-bootstrap-token";

const TEMPLATE_BODY = JSON.stringify({
  model: "jev-1.13",
  state: "{{state}}",
  questions: { urgent: { type: "noul", instructions: "Is it urgent?" } },
});

let root: string;
let runtime: ConsoleRuntime;
let cookie = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "jev-web-docs-"));
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
  runtime = createConsoleRuntime({
    env,
    fetch: async () => {
      throw new Error("docs must not call Jev");
    },
  });
  installConsoleRuntime(runtime);
  resetSessionForTests();
  const exchanged = await sessionPost(request("/api/session", "POST", { token: TOKEN, session: false }));
  assert.equal(exchanged.status, 200);
  cookie = exchanged.headers.get("set-cookie")?.split(";")[0] ?? "";
});

afterEach(async () => {
  closeConsoleRuntime();
  resetSessionForTests();
  await rm(root, { recursive: true, force: true });
});

function request(
  pathname: string,
  method = "GET",
  options: { token?: string; session?: boolean } = {},
): NextRequest {
  const headers = new Headers({ host: "127.0.0.1:7411" });
  if (options.session !== false) {
    headers.set("cookie", cookie);
  }
  if (options.token) headers.set("x-jev-console-token", options.token);
  if (method !== "GET") headers.set("origin", ORIGIN);
  return new NextRequest(`${ORIGIN}${pathname}`, { method, headers });
}

test("docs endpoints require a console session", async () => {
  assert.equal((await docs(request("/api/docs", "GET", { session: false }))).status, 401);
  assert.equal((await docsTools(request("/api/docs/tools", "GET", { session: false }))).status, 401);
});

test("/api/docs responds with the app document as JSON", async () => {
  const response = await docs(request("/api/docs"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const body = (await response.json()) as { version: string; content: string; endpoints: string[] };
  assert.equal(typeof body.version, "string");
  assert.ok(body.content.includes("jev-client"));
  assert.ok(body.endpoints.includes("/api/docs/tools"));
});

test("/api/docs/tools matches the MCP registry and includes per-template tools", async () => {
  new TemplateRepository(runtime.service.db).save("order", "Support order", TEMPLATE_BODY);
  const response = await docsTools(request("/api/docs/tools"));
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    version: string;
    tools: Array<{ name: string; source: string; templateName?: string }>;
  };
  const names = body.tools.map((tool) => tool.name);
  assert.ok(names.includes("jev_overview"));
  assert.ok(names.includes("order"));
  const dynamic = body.tools.find((tool) => tool.name === "order");
  assert.equal(dynamic?.source, "template");
  assert.equal(dynamic?.templateName, "order");
});

test("/api/docs/tools/[name] returns the detail and 404 for an unknown tool", async () => {
  const ok = await docsTool(request("/api/docs/tools/jev_overview"), { params: Promise.resolve({ name: "jev_overview" }) });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { name: string }).name, "jev_overview");

  const missing = await docsTool(request("/api/docs/tools/unknown"), { params: Promise.resolve({ name: "unknown" }) });
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { error: { code: string } }).error.code, "tool_not_found");
});

test("/api/docs/mcp and /api/docs/examples respond with JSON", async () => {
  const mcp = await docsMcp(request("/api/docs/mcp"));
  assert.equal(mcp.status, 200);
  assert.ok(((await mcp.json()) as { content: string }).content.includes("jev mcp"));

  const examples = await docsExamples(request("/api/docs/examples"));
  assert.equal(examples.status, 200);
  assert.ok(((await examples.json()) as { content: string }).content.includes("jev_template_list"));
});
