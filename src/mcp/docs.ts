import type { McpContext } from "./context.js";
import type { ToolAnnotations } from "./schema.js";
import { buildToolCatalog, type ToolDefinition } from "./tools.js";

/** Machine-readable entry of the tool catalog (shared by MCP and web). */
export interface ToolDocEntry {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: ToolAnnotations;
  examples?: unknown[];
  source: "builtin" | "template";
  templateName?: string;
}

export function toolsCatalogDoc(ctx: McpContext): ToolDocEntry[] {
  return buildToolCatalog(ctx).map(toDocEntry);
}

export function toolDoc(ctx: McpContext, name: string): ToolDocEntry | undefined {
  const tool = buildToolCatalog(ctx).find((entry) => entry.name === name);
  return tool === undefined ? undefined : toDocEntry(tool);
}

function toDocEntry(tool: ToolDefinition): ToolDocEntry {
  const entry: ToolDocEntry = {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    source: tool.source,
    templateName: tool.templateName,
  };
  if (tool.outputSchema !== undefined) {
    entry.outputSchema = tool.outputSchema;
  }
  return entry;
}

export function appOverviewDoc(): string {
  return [
    "# jev-client",
    "",
    "jev-client is a CLI, library and MCP server in Node.js + TypeScript for consuming the",
    "**Jev** API (TypeSafe's System One) through OpenCode.",
    "",
    "Jev does not generate text: it receives a `state` (content to evaluate) and one or more typed",
    "questions, and returns one answer per question with probabilities.",
    "",
    "## Concepts",
    "",
    "- **template** — Jev request with `{{key}}` macros that are resolved from a context.",
    "  Every template is also published as its own **MCP tool**.",
    "- **macro** — `{{key}}` placeholder in a template body. It supports dotted paths",
    "  (`{{customer.name}}`) and optional metadata: description and JSON Schema.",
    "- **request** — real execution against Jev: `{ model, state, questions }`. Stored in SQLite.",
    "- **batch** — execution of a template over an array of contexts; all requests",
    "  share a `batch_id`.",
    "- **config** — `api_url`, `api_key`, `model`, `timeout` and `retries`; precedence",
    "  flag > environment > SQLite > default.",
    "",
    "## Storage",
    "",
    "The SQLite database lives by default at `~/.jev-client/db/jev.db` (permissions 0600/0700). It stores",
    "`config`, `templates`, `template_macros` and `requests`. Every execution made through MCP is",
    "recorded with `source='mcp'`.",
    "",
    "## Security",
    "",
    "The API key never appears in an MCP response (`jev_config_get` and `jev_overview` mask it).",
    "The transport is local stdio (no ports). Reads are not stored; only real executions",
    "and template mutations are.",
    "",
    "## Images (experimental)",
    "",
    "Jev accepts images through the `assets` field (`{ ref: { data_base64, format } }`) plus the header",
    "`TypeSafe-Danger-Zone-Images: true`. The reference is written where text would go (`state`, ",
    "`instructions` or `criteria`) and the API replaces it with the image. `jev_ask`, `jev_batch` and",
    "`jev_template_render` accept an `assets` parameter; `jev_image_check` validates an image (format,",
    "dimensions, limits) without spending a call. Images are experimental and their limits may",
    "change: static PNG/JPEG, 280–1568 px per side and 16 MiB per file.",
  ].join("\n");
}

export function mcpConfigDoc(): string {
  return [
    "# Configuring the MCP server",
    "",
    "The server is launched over stdio with `jev mcp` (alias `jev-mcp`). Nothing is written to stdout",
    "except JSON-RPC; logs go to stderr.",
    "",
    "## Flags",
    "",
    "```",
    "jev mcp [--db <path>] [--key <key>] [--url <endpoint>] [--model <model>]",
    "        [--timeout <seconds>] [--retries <n>]",
    "        [--read-only] [--no-execute] [--allow-destructive]",
    "```",
    "",
    "- `--db` / `JEV_DB` — SQLite database path (shared with the CLI and the console).",
    "- `--key` / `JEV_API_KEY` — API key.",
    "- `--read-only` — disables creating/editing/deleting templates.",
    "- `--no-execute` — disables `jev_ask`/`jev_batch` and hides the template tools.",
    "- `--allow-destructive` — enables `jev_template_delete`.",
    "",
    "If the API key is missing, the server starts anyway: read tools work and execution tools",
    "return a structured error.",
    "",
    "## OpenCode",
    "",
    "In `opencode.json` (or the global config):",
    "",
    "```jsonc",
    '{\n  "mcp": {\n    "servers": {\n      "jev": {\n        "type": "local",\n        "command": ["jev", "mcp"],\n        "environment": { "JEV_DB": "/Users/me/.jev-client/db/jev.db" }\n      }\n    }\n  }',
    "",
    "With the package published on npm, without installing it, using npx:",
    "",
    "```jsonc",
    '{\n  "mcp": {\n    "servers": {\n      "jev": {\n        "type": "local",\n        "command": ["npx", "-y", "jev-client", "mcp"]\n      }\n    }\n  }',
    "",
    "If the package is not on npm but is on GitHub, npx installs it from the repo too:",
    "",
    "```jsonc",
    '{\n  "mcp": {\n    "servers": {\n      "jev": {\n        "type": "local",\n        "command": ["npx", "-y", "-p", "github:USER/jev-client", "jev-mcp"]\n      }\n    }\n  }',
    "",
    "## Claude Desktop",
    "",
    "```json",
    '{\n  "mcpServers": {\n    "jev": {\n      "command": "jev",\n      "args": ["mcp"],\n      "env": { "JEV_DB": "/Users/me/.jev-client/db/jev.db" }\n    }\n  }\n}',
    "",
    "## Transports",
    "",
    "v1 uses local stdio. The remote HTTP transport, OAuth and multi-user support are out of scope.",
  ].join("\n");
}

export function examplesDoc(): string {
  return [
    "# Usage examples",
    "",
    "Recommended flow: list → get → generate contexts → render (dry-run) → execute → history.",
    "",
    "1. List templates:",
    "```json",
    '{"tool":"jev_template_list"}',
    "```",
    "",
    "2. Read a template and its macros:",
    "```json",
    '{"tool":"jev_template_get","name":"order"}',
    "```",
    "",
    "3. Render (dry-run) with a context:",
    "```json",
    '{"tool":"jev_template_render","name":"order","context":{"order_state":"paid","customer.name":"Ana","customer.plan":"pro"}}',
    "```",
    "",
    "4. Run the template tool (same shape as render):",
    "```json",
    '{"tool":"order","order_state":"paid","customer.name":"Ana","customer.plan":"pro"}',
    "```",
    "",
    "5. Run several contexts in a batch:",
    "```json",
    '{"tool":"jev_batch","template":"order","contexts":[{"order_state":"paid","customer.name":"Ana","customer.plan":"pro"},{"order_state":"refunded","customer.name":"Luis","customer.plan":"free"}],"concurrency":2}',
    "```",
    "",
    "6. Query the history:",
    "```json",
    '{"tool":"jev_history_list","template":"order","limit":5}',
    "```",
    "",
    "7. Run an ad-hoc request:",
    "```json",
    '{"tool":"jev_ask","state":"The checkout has been down for 30 minutes.","questions":{"urgent":{"type":"noul","instructions":"Is it urgent?"}}}',
    "```",
    "",
    "8. Validate an image before sending it:",
    "```json",
    '{"tool":"jev_image_check","path":"/path/photo.jpg"}',
    "```",
    "",
    "9. Run a request with an image (experimental):",
    "```json",
    '{"tool":"jev_ask","state":{"photo":"<uuid>"},"assets":{"<uuid>":{"path":"/path/photo.jpg"}},"questions":{"animal":{"type":"choice","instructions":"Which animal appears in `photo`?","criteria":{"CAT":"Feline","DOG":"Canine"}}}}',
    "```",
  ].join("\n");
}

function docText(content: string): { text: string } {
  return { text: content };
}

/**
 * Documentation provider used by the `jev_docs` tool and the resources.
 * `contentFor(topic)` resolves 'overview' | 'tools' | 'mcp' | 'examples' or the
 * name of a specific tool.
 */
export function docsProvider(
  ctx: McpContext,
): { contentFor(topic: string): { text: string } | undefined } {
  return {
    contentFor(topic: string): { text: string } | undefined {
      const normalized = topic.trim();
      if (normalized === "" || normalized === "overview") {
        return docText(appOverviewDoc());
      }
      if (normalized === "tools") {
        return docText(JSON.stringify(toolsCatalogDoc(ctx), null, 2));
      }
      if (normalized === "mcp") {
        return docText(mcpConfigDoc());
      }
      if (normalized === "examples") {
        return docText(examplesDoc());
      }
      const tool = toolDoc(ctx, normalized);
      return tool === undefined ? undefined : docText(JSON.stringify(tool, null, 2));
    },
  };
}
