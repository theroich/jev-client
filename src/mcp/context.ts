import { ConfigRepository } from "../config-repository.js";
import { resolveConfig, type ConfigFlags, type ResolvedConfig } from "../config.js";
import { RequestRepository } from "../request-repository.js";
import { JevService } from "../service.js";
import { TemplateRepository } from "../template-repository.js";

export interface McpServerOptions {
  /** Disables template create/update/delete. */
  readOnly?: boolean;
  /** Disables ask/batch and hides the execution tools. */
  noExecute?: boolean;
  /** Enables `jev_template_delete` (not registered by default). */
  allowDestructive?: boolean;
}

/** State shared by tools, resources, docs and the MCP transport. */
export interface McpContext {
  service: JevService;
  templates: TemplateRepository;
  requests: RequestRepository;
  config: ConfigRepository;
  flags: ConfigFlags;
  options: McpServerOptions;
  env: NodeJS.ProcessEnv;
  /** Log to stderr; never to stdout (reserved for JSON-RPC). */
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

/** Effective MCP process config (flag > env > SQLite > default). */
export function resolvedConfig(ctx: McpContext): ResolvedConfig {
  const stored = {};
  for (const { key, value } of ctx.config.list()) {
    (stored as Record<string, string>)[key] = value;
  }
  return resolveConfig(ctx.flags, ctx.env, stored);
}

/** SQLite schema version in use. */
export function schemaVersion(ctx: McpContext): number {
  return ctx.service.db.pragma("user_version", { simple: true }) as number;
}
