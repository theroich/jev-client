import type { McpContext } from "./context.js";
import { appOverviewDoc, examplesDoc, mcpConfigDoc, toolsCatalogDoc } from "./docs.js";
import { getTemplatePayload, listTemplatesPayload } from "./tools.js";

const MARKDOWN = "text/markdown";
const JSON_MIME = "application/json";

export interface ResourceDescriptor {
  name: string;
  uri: string;
  description: string;
  mimeType: string;
}

export interface PromptDescriptor {
  name: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
}

/** Static resources plus the template listing. */
export function listResources(): ResourceDescriptor[] {
  return [
    {
      name: "overview",
      uri: "jev://docs/overview",
      description: "What jev-client is, core concepts, storage and security.",
      mimeType: MARKDOWN,
    },
    {
      name: "tools",
      uri: "jev://docs/tools",
      description: "Full catalog of tools (built-in and per-template) in JSON.",
      mimeType: JSON_MIME,
    },
    {
      name: "examples",
      uri: "jev://docs/examples",
      description: "End-to-end use cases with real JSON.",
      mimeType: MARKDOWN,
    },
    {
      name: "mcp",
      uri: "jev://docs/mcp",
      description: "How to configure the server in OpenCode/Claude Desktop.",
      mimeType: MARKDOWN,
    },
    {
      name: "templates",
      uri: "jev://templates",
      description: "Template listing (same payload as jev_template_list).",
      mimeType: JSON_MIME,
    },
  ];
}

/** `jev://templates/{name}` resource template. */
export function listResourceTemplates(): Array<Omit<ResourceDescriptor, "uri"> & { uriTemplate: string }> {
  return [
    {
      name: "template",
      uriTemplate: "jev://templates/{name}",
      description: "Details of one template (same payload as jev_template_get).",
      mimeType: JSON_MIME,
    },
  ];
}

/** Template names for the resource template listing callback. */
export function templateNames(ctx: McpContext): string[] {
  return ctx.templates.list().map((template) => template.name);
}

/** Reads a resource by URI; `undefined` if it does not exist. */
export function readResource(
  uri: string,
  ctx: McpContext,
): { text: string; mimeType: string } | undefined {
  switch (uri) {
    case "jev://docs/overview":
      return { text: appOverviewDoc(), mimeType: MARKDOWN };
    case "jev://docs/tools":
      return { text: JSON.stringify(toolsCatalogDoc(ctx), null, 2), mimeType: JSON_MIME };
    case "jev://docs/examples":
      return { text: examplesDoc(), mimeType: MARKDOWN };
    case "jev://docs/mcp":
      return { text: mcpConfigDoc(), mimeType: MARKDOWN };
    case "jev://templates":
      return { text: JSON.stringify(listTemplatesPayload(ctx), null, 2), mimeType: JSON_MIME };
  }
  if (uri.startsWith("jev://templates/")) {
    const raw = uri.slice("jev://templates/".length);
    const name = decodeURIComponent(raw);
    if (ctx.templates.get(name) === undefined) {
      return undefined;
    }
    return { text: JSON.stringify(getTemplatePayload(ctx, name), null, 2), mimeType: JSON_MIME };
  }
  return undefined;
}

export function listPrompts(): PromptDescriptor[] {
  return [
    {
      name: "generate-contexts",
      description:
        "Guide to generate a JSON array of contexts for a template while respecting its macros and " +
        "schemas, rendering before executing.",
      arguments: [
        { name: "template", description: "Template name.", required: true },
        {
          name: "scenarios",
          description: "Free-form description of the scenarios to cover.",
          required: true,
        },
      ],
    },
  ];
}

export function getPrompt(name: string): string | undefined {
  if (name !== "generate-contexts") {
    return undefined;
  }
  return [
    "Your goal is to produce a JSON array of contexts for the given template.",
    "",
    "Steps:",
    "1. Call `jev_template_get` (or `jev_docs` with topic=template) to read the body, macros, ",
    "   descriptions and JSON Schemas.",
    "2. Respect every macro and its schema (enum, format, pattern, limits, default) without inventing ",
    "   keys that do not exist.",
    "3. Generate a JSON array of objects, one per scenario, with one key per macro (dotted paths ",
    "   are exact flat keys, e.g. \"customer.name\").",
    "4. Before executing, validate with `jev_template_render` to detect missing macros.",
    "5. Execute with `jev_batch` passing `template` and `contexts`.",
    "",
    "Return only the JSON array of contexts.",
  ].join("\n");
}
