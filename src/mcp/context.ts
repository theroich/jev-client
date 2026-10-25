import { ConfigRepository } from "../config-repository.js";
import { resolveConfig, type ConfigFlags, type ResolvedConfig } from "../config.js";
import { RequestRepository } from "../request-repository.js";
import { JevService } from "../service.js";
import { TemplateRepository } from "../template-repository.js";

export interface McpServerOptions {
  /** Deshabilita create/update/delete de plantillas. */
  readOnly?: boolean;
  /** Deshabilita ask/batch y oculta las tools de ejecución. */
  noExecute?: boolean;
  /** Habilita `jev_template_delete` (por defecto no se registra). */
  allowDestructive?: boolean;
}

/** Estado compartido por tools, resources, docs y el transporte MCP. */
export interface McpContext {
  service: JevService;
  templates: TemplateRepository;
  requests: RequestRepository;
  config: ConfigRepository;
  flags: ConfigFlags;
  options: McpServerOptions;
  env: NodeJS.ProcessEnv;
  /** Log hacia stderr; nunca hacia stdout (reservado a JSON-RPC). */
  log: (message: string) => void;
}

export function createMcpContext(
  service: JevService,
  flags: ConfigFlags = {},
  options: McpServerOptions = {},
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = () => {},
): McpContext {
  return {
    service,
    templates: new TemplateRepository(service.db),
    requests: new RequestRepository(service.db),
    config: new ConfigRepository(service.db),
    flags,
    options,
    env,
    log,
  };
}

/** Configuración efectiva del proceso MCP (flag > env > SQLite > defecto). */
export function resolvedConfig(ctx: McpContext): ResolvedConfig {
  const stored = {};
  for (const { key, value } of ctx.config.list()) {
    (stored as Record<string, string>)[key] = value;
  }
  return resolveConfig(ctx.flags, ctx.env, stored);
}

/** Versión del esquema SQLite en uso. */
export function schemaVersion(ctx: McpContext): number {
  return ctx.service.db.pragma("user_version", { simple: true }) as number;
}
