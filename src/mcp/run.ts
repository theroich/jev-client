import { parseArgs } from "node:util";

import { JevService } from "../service.js";
import { type ConfigFlags } from "../config.js";
import { createMcpContext, type McpServerOptions } from "./context.js";
import { runMcpServer } from "./server.js";

export const MCP_USAGE = `Uso: jev mcp [flags]

Arranca el servidor MCP por stdio (JSON-RPC en stdout, logs en stderr).

Flags:
  --db <ruta>              base SQLite (env: JEV_DB)
  --key <clave>            API key (env: OPENCODE_API_KEY, JEV_API_KEY)
  --url <endpoint>         endpoint completo (env: JEV_URL)
  --model <modelo>         modelo (env: JEV_MODEL)
  --timeout <segundos>     timeout de cada intento HTTP (default 30)
  --retries <n>            reintentos ante 429/5xx (default 2)
  --read-only              deshabilita crear/editar/borrar plantillas
  --no-execute             deshabilita jev_ask/jev_batch y las tools de plantilla
  --allow-destructive      habilita jev_template_delete
  -h, --help               muestra esta ayuda

Si falta la API key el servidor arranca igualmente: las tools de lectura
funcionan y las de ejecución devuelven un error estructurado.
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
    throw new Error("--timeout debe ser un número positivo en segundos");
  }

  const retriesRaw = typeof values.retries === "string" ? values.retries : undefined;
  const retries = retriesRaw === undefined ? undefined : Number(retriesRaw);
  if (retries !== undefined && (!Number.isInteger(retries) || retries < 0)) {
    throw new Error("--retries debe ser un entero >= 0");
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

/** Comando `jev mcp` (y binario `jev-mcp`): arranca el servidor stdio. */
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
