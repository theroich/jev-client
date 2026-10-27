import { parseArgs } from "node:util";

import { JevService } from "../service.js";
import { type ConfigFlags } from "../config.js";
import { createMcpContext, type McpServerOptions } from "./context.js";
import { runMcpServer } from "./server.js";

export const MCP_USAGE = `Usage: jev mcp [flags]

Starts the MCP server over stdio (JSON-RPC on stdout, logs on stderr).

Flags:
  --db <path>              SQLite database (env: JEV_DB)
  --key <key>              API key (env: JEV_API_KEY)
  --url <endpoint>         full endpoint (env: JEV_URL)
  --model <model>          model (env: JEV_MODEL)
  --timeout <seconds>      timeout per HTTP attempt (default 30)
  --retries <n>            retries on 429/5xx (default 2)
  --read-only              disables creating/editing/deleting templates
  --no-execute             disables jev_ask/jev_batch and the template tools
  --allow-destructive      enables jev_template_delete
  -h, --help               shows this help

If the API key is missing the server still starts: read tools work and
execution tools return a structured error.
`;

interface McpOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

interface ParsedMcpArgs {
  db?: string;
  key?: string;
  url?: string;
  model?: string;
  timeoutMs?: number;
  retries?: number;
  readOnly: boolean;
  noExecute: boolean;
  allowDestructive: boolean;
}

function parseMcpArgs(argv: string[]): ParsedMcpArgs | "help" {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: "string" },
      key: { type: "string" },
      url: { type: "string" },
      model: { type: "string" },
      timeout: { type: "string" },
      retries: { type: "string" },
      "read-only": { type: "boolean" },
      "no-execute": { type: "boolean" },
      "allow-destructive": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help === true) {
    return "help";
  }

  const timeoutRaw = typeof values.timeout === "string" ? values.timeout : undefined;
  const timeoutSeconds = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
  if (
    timeoutSeconds !== undefined &&
    (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
  ) {
    throw new Error("--timeout must be a positive number of seconds");
  }

  const retriesRaw = typeof values.retries === "string" ? values.retries : undefined;
  const retries = retriesRaw === undefined ? undefined : Number(retriesRaw);
  if (retries !== undefined && (!Number.isInteger(retries) || retries < 0)) {
    throw new Error("--retries must be an integer >= 0");
  }

  return {
    db: typeof values.db === "string" ? values.db : undefined,
    key: typeof values.key === "string" ? values.key : undefined,
    url: typeof values.url === "string" ? values.url : undefined,
    model: typeof values.model === "string" ? values.model : undefined,
    timeoutMs:
      timeoutSeconds === undefined ? undefined : Math.round(timeoutSeconds * 1000),
    retries,
    readOnly: values["read-only"] === true,
    noExecute: values["no-execute"] === true,
    allowDestructive: values["allow-destructive"] === true,
  };
}

/** `jev mcp` command (and `jev-mcp` binary): starts the stdio server. */
export async function runMcpCommand(argv: string[], io: McpOutput): Promise<number> {
  let parsed: ParsedMcpArgs | "help";
  try {
    parsed = parseMcpArgs(argv);
  } catch (error) {
    io.stderr(`error: ${messageOf(error)}\n\n${MCP_USAGE}`);
    return 2;
  }

  if (parsed === "help") {
    io.stdout(MCP_USAGE);
    return 0;
  }

  const flags: ConfigFlags = {
    key: parsed.key,
    url: parsed.url,
    model: parsed.model,
    timeoutMs: parsed.timeoutMs,
    retries: parsed.retries,
  };
  const options: McpServerOptions = {
    readOnly: parsed.readOnly,
    noExecute: parsed.noExecute,
    allowDestructive: parsed.allowDestructive,
  };

  const log = (message: string): void => {
    io.stderr(`${message}\n`);
  };

  const service = new JevService({
    flags,
    env: process.env,
    dbPath: parsed.db,
  });
  const ctx = createMcpContext(service, flags, options, process.env, log);

  try {
    await runMcpServer(ctx);
    return 0;
  } catch (error) {
    io.stderr(`error: ${messageOf(error)}\n`);
    return 1;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
