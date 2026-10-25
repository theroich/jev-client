import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { VERSION } from "../version.js";
import type { McpContext } from "./context.js";
import {
  errorCodeOf,
  errorHintOf,
  errorRequestIdOf,
  messageOf,
} from "./errors.js";
import {
  getPrompt,
  listPrompts,
  listResources,
  listResourceTemplates,
  readResource,
} from "./resources.js";
import {
  enabledTools,
  TEMPLATE_MUTATION_TOOLS,
  type ToolDefinition,
} from "./tools.js";

const SERVER_INSTRUCTIONS =
  "Servidor MCP de jev-client. Las plantillas guardadas se publican como tools propias; " +
  "usa jev_docs o jev_overview para orientarte. Los logs van a stderr; stdout es JSON-RPC.";

function toMcpTool(tool: ToolDefinition): Tool {
  const entry: Tool = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    annotations: tool.annotations as Tool["annotations"],
  };
  if (tool.title !== undefined) {
    entry.title = tool.title;
  }
  if (tool.outputSchema !== undefined) {
    entry.outputSchema = tool.outputSchema as Tool["outputSchema"];
  }
  return entry;
}

function toolErrorResult(
  code: string,
  message: string,
  hint?: string,
  requestId?: number | null,
): { isError: true; content: Array<{ type: "text"; text: string }> } {
  const payload: Record<string, unknown> = { code, message };
  if (hint !== undefined) {
    payload.hint = hint;
  }
  if (requestId !== undefined && requestId !== null) {
    payload.requestId = requestId;
  }
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Crea el server MCP (bajo nivel, para controlar los JSON Schema crudos) con
 * todos los handlers de tools, resources y prompts ya registrados.
 */
export function createMcpServer(ctx: McpContext): Server {
  const server = new Server(
    { name: "jev-client", version: VERSION },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: false },
        logging: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: enabledTools(ctx).map(toMcpTool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = enabledTools(ctx).find((entry) => entry.name === name);
    if (tool === undefined) {
      return toolErrorResult("tool_not_found", `tool no disponible: ${name}`);
    }
    try {
      const result = await tool.run((args ?? {}) as Record<string, unknown>, ctx);
      if (TEMPLATE_MUTATION_TOOLS.has(name)) {
        await server.sendToolListChanged().catch(() => {});
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return toolErrorResult(
        errorCodeOf(error),
        messageOf(error),
        errorHintOf(error),
        errorRequestIdOf(error),
      );
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: listResources().map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    })),
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: listResourceTemplates().map((template) => ({
      uriTemplate: template.uriTemplate,
      name: template.name,
      description: template.description,
      mimeType: template.mimeType,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const content = readResource(uri, ctx);
    if (content === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `resource no encontrada: ${uri}`);
    }
    return {
      contents: [{ uri, mimeType: content.mimeType, text: content.text }],
    };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: listPrompts().map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const text = getPrompt(request.params.name);
    if (text === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `prompt no encontrado: ${request.params.name}`);
    }
    return {
      description: listPrompts().find((prompt) => prompt.name === request.params.name)?.description,
      messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
    };
  });

  return server;
}

/** Ejecuta el servidor sobre stdio y cierra el servicio ante señales. */
export async function runMcpServer(ctx: McpContext): Promise<void> {
  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();

  const shutdown = async (): Promise<void> => {
    ctx.log("cerrando el servidor MCP…");
    try {
      await server.close();
    } finally {
      ctx.service.close();
    }
  };

  const onSignal = (): void => {
    void shutdown().then(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await server.connect(transport);
    ctx.log(`servidor MCP jev-client ${VERSION} conectado por stdio`);
  } catch (error) {
    ctx.service.close();
    throw error;
  }
}
