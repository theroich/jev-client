import "server-only";

import { createMcpContext } from "../../../dist/src/mcp/context.js";
import {
  appOverviewDoc,
  examplesDoc,
  mcpConfigDoc,
  toolDoc,
  toolsCatalogDoc,
} from "../../../dist/src/mcp/docs.js";
import { VERSION } from "../../../dist/src/version.js";
import { ConsoleError } from "./api";
import { getConsoleRuntime } from "./runtime";

/**
 * Contexto MCP construido sobre el runtime de la consola, para que los
 * endpoints de documentación compartan el mismo registry que el servidor MCP.
 */
function mcpContext() {
  const runtime = getConsoleRuntime();
  return createMcpContext(runtime.service, runtime.flags, {}, runtime.env);
}

export function docsApp() {
  return {
    version: VERSION,
    content: appOverviewDoc(),
    endpoints: [
      "/api/docs/tools",
      "/api/docs/mcp",
      "/api/docs/examples",
    ],
  };
}

export function docsTools() {
  return {
    version: VERSION,
    tools: toolsCatalogDoc(mcpContext()),
  };
}

export function docsTool(name: string) {
  const tool = toolDoc(mcpContext(), name);
  if (tool === undefined) {
    throw new ConsoleError(404, "tool_not_found", `tool no encontrada: ${name}`);
  }
  return tool;
}

export function docsMcp() {
  return {
    version: VERSION,
    content: mcpConfigDoc(),
  };
}

export function docsExamples() {
  return {
    version: VERSION,
    content: examplesDoc(),
  };
}
