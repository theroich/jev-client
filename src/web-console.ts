import { spawn, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";

import type { CliIO } from "./cli.js";
import { ConfigRepository } from "./config-repository.js";
import { resolveConfig, type StoredConfig } from "./config.js";
import { openDatabase, resolveDatabasePath } from "./database.js";

export const WEB_CONSOLE_USAGE = `Usage: jev web-console [flags]

Flags:
  --port <n>          listen port; 0 picks a free one (default 7411)
  --host <addr>       listen address (default 127.0.0.1)
  --allow-remote      allow listening outside loopback (requires token)
  --open / --no-open  open the browser or not (default: TTY without CI/SSH)
  --dev               runs next dev from the web checkout
  --db <path>         SQLite database (env: JEV_DB)
  --key <key>         API key for this session only
  --url <endpoint>    full endpoint for this session only
  --model <model>     model for this session only
  --timeout <secs>    HTTP timeout in seconds for this session only
  --retries <n>       HTTP retries for this session only
  -h, --help          shows this help

JEV_CONSOLE_DIR sets the standalone directory or, with --dev,
the web checkout. The command stays in the foreground until Ctrl-C.
`;

type ParseArgsOptions = NonNullable<ParseArgsConfig["options"]>;
type Values = Record<string, string | boolean | undefined>;

const WEB_CONSOLE_OPTIONS = {
  port: { type: "string" },
  host: { type: "string" },
  "allow-remote": { type: "boolean" },
  open: { type: "boolean" },
  "no-open": { type: "boolean" },
  dev: { type: "boolean" },
  db: { type: "string" },
  key: { type: "string" },
  url: { type: "string" },
  model: { type: "string" },
  timeout: { type: "string" },
  retries: { type: "string" },
  help: { type: "boolean", short: "h" },
} satisfies ParseArgsOptions;

export interface WebConsoleChild {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export type WebConsoleSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => WebConsoleChild;

export interface WebConsoleSignalTarget {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
}

/** Optional dependencies to test processes, network, browser and signals. */
export interface WebConsoleDependencies {
  spawn?: WebConsoleSpawn;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  openBrowser?: (url: string) => void | Promise<void>;
  fileExists?: (path: string) => Promise<boolean>;
  /** Checks/reserves the port and returns the concrete port the child will use. */
  allocatePort?: (host: string, requestedPort: number) => Promise<number>;
  signals?: WebConsoleSignalTarget;
  platform?: NodeJS.Platform;
  nodePath?: string;
  version?: string;
  startupTimeoutMs?: number;
  healthPollIntervalMs?: number;
  shutdownTimeoutMs?: number;
}

interface ParsedOptions {
  port: number;
  host: string;
  allowRemote: boolean;
  open?: boolean | undefined;
  dev: boolean;
  db?: string | undefined;
  key?: string | undefined;
  url?: string | undefined;
  model?: string | undefined;
  timeoutSeconds?: number | undefined;
  retries?: number | undefined;
}

interface DatabaseSession {
  path: string;
  schemaVersion: number;
}

interface ConsoleTarget {
  mode: "dev" | "standalone";
  directory: string;
  entry: string;
}

interface HealthResponse {
  version?: string | undefined;
}

type ChildResult =
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { type: "error"; error: Error };

class UsageError extends Error {}

export async function runWebConsoleCommand(
  args: string[],
  io: CliIO,
  dependencies: WebConsoleDependencies = {},
): Promise<number> {
  let options: ParsedOptions | "help";
  try {
    options = parseWebConsoleOptions(args);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`error: ${error.message}\n\n${WEB_CONSOLE_USAGE}`);
      return 2;
    }
    throw error;
  }

  if (options === "help") {
    io.stdout(WEB_CONSOLE_USAGE);
    return 0;
  }

  try {
    return await launchWebConsole(options, io, dependencies);
  } catch (error) {
    io.stderr(`error: ${messageOf(error)}\n`);
    return 1;
  }
}

async function launchWebConsole(
  options: ParsedOptions,
  io: CliIO,
  dependencies: WebConsoleDependencies,
): Promise<number> {
  const env = io.env ?? process.env;
  const database = prepareDatabase(options, env);
  const fileExists = dependencies.fileExists ?? defaultFileExists;
  const target = await locateTarget(options, env, fileExists);
  const allocatePort = dependencies.allocatePort ?? allocateAvailablePort;

  let port: number;
  try {
    port = await allocatePort(options.host, options.port);
  } catch (error) {
    if (errorCode(error) === "EADDRINUSE") {
      throw new Error(
        `port ${options.port} is not available on ${options.host}; ` +
          "try --port <n> or --port 0",
      );
    }
    throw new Error(
      `cannot listen on ${options.host}:${options.port}: ${messageOf(error)}`,
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`the selected free port is not valid: ${port}`);
  }

  const version = dependencies.version ?? (await readPackageVersion());
  const token = randomBytes(32).toString("hex");
  const childEnv = createChildEnvironment(
    env,
    options,
    database,
    target.mode,
    port,
    token,
    version,
  );
  const nodePath = dependencies.nodePath ?? process.execPath;
  const spawnChild = dependencies.spawn ?? defaultSpawn;
  const args =
    target.mode === "dev"
      ? [
          target.entry,
          "dev",
          "--hostname",
          options.host,
          "--port",
          String(port),
        ]
      : [target.entry];
  const child = spawnChild(nodePath, args, {
    cwd: target.directory,
    env: childEnv,
    stdio: "inherit",
  });

  return superviseChild({
    child,
    options,
    database,
    target,
    port,
    token,
    version,
    io,
    dependencies,
  });
}

function prepareDatabase(
  options: ParsedOptions,
  env: NodeJS.ProcessEnv,
): DatabaseSession {
  const path = resolveDatabasePath(options.db, env);
  const db = openDatabase(path);
  try {
    const stored: StoredConfig = {};
    for (const { key, value } of new ConfigRepository(db).list()) {
      stored[key] = value;
    }
    // Validates the effective configuration without turning the flags into
    // persisted values or clearing their source for the Settings UI.
    resolveConfig(
      {
        key: options.key,
        url: options.url,
        model: options.model,
        timeoutMs:
          options.timeoutSeconds === undefined
            ? undefined
            : Math.round(options.timeoutSeconds * 1000),
        retries: options.retries,
      },
      env,
      stored,
    );
    return {
      path,
      schemaVersion: db.pragma("user_version", { simple: true }) as number,
    };
  } finally {
    db.close();
  }
}

async function locateTarget(
  options: ParsedOptions,
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => Promise<boolean>,
): Promise<ConsoleTarget> {
  if (options.dev) {
    const directory = resolve(
      env.JEV_CONSOLE_DIR ??
        fileURLToPath(new URL("../../web/", import.meta.url)),
    );
    const candidates = [
      join(directory, "node_modules", "next", "dist", "bin", "next"),
      join(directory, "..", "node_modules", "next", "dist", "bin", "next"),
    ];
    let entry: string | undefined;
    for (const candidate of candidates) {
      if (await fileExists(candidate)) {
        entry = candidate;
        break;
      }
    }
    if (entry === undefined) {
      throw new Error(
        `next dev was not found next to ${directory}; install the checkout dependencies ` +
          "or run the standalone mode",
      );
    }
    return { mode: "dev", directory, entry };
  }

  const directory = resolve(
    env.JEV_CONSOLE_DIR ??
      fileURLToPath(new URL("../web-console/", import.meta.url)),
  );
  const entry = join(directory, "server.js");
  if (!(await fileExists(entry))) {
    throw new Error(
      `the console standalone build was not found at ${entry}; ` +
        "build web with standalone output or set JEV_CONSOLE_DIR",
    );
  }
  return { mode: "standalone", directory, entry };
}

function createChildEnvironment(
  parent: NodeJS.ProcessEnv,
  options: ParsedOptions,
  database: DatabaseSession,
  mode: ConsoleTarget["mode"],
  port: number,
  token: string,
  version: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };
  const sessionKeys = [
    "JEV_CONSOLE_TOKEN",
    "JEV_CONSOLE_DB_PATH",
    "JEV_CONSOLE_HOST",
    "JEV_CONSOLE_PORT",
    "JEV_CONSOLE_VERSION",
    "JEV_CONSOLE_SCHEMA_VERSION",
    "JEV_CONSOLE_MODE",
    "JEV_CONSOLE_ALLOW_REMOTE",
    "JEV_CONSOLE_API_KEY",
    "JEV_CONSOLE_API_URL",
    "JEV_CONSOLE_MODEL",
    "JEV_CONSOLE_TIMEOUT",
    "JEV_CONSOLE_RETRIES",
  ];
  for (const key of sessionKeys) {
    delete env[key];
  }

  Object.assign(env, {
    PORT: String(port),
    HOSTNAME: options.host,
    JEV_DB: database.path,
    JEV_CONSOLE_TOKEN: token,
    JEV_CONSOLE_DB_PATH: database.path,
    JEV_CONSOLE_HOST: options.host,
    JEV_CONSOLE_PORT: String(port),
    JEV_CONSOLE_VERSION: version,
    JEV_CONSOLE_SCHEMA_VERSION: String(database.schemaVersion),
    JEV_CONSOLE_MODE: mode,
    JEV_CONSOLE_ALLOW_REMOTE: options.allowRemote ? "1" : "0",
  });
  if (options.key !== undefined) {
    env.JEV_CONSOLE_API_KEY = options.key;
  }
  if (options.url !== undefined) {
    env.JEV_CONSOLE_API_URL = options.url;
  }
  if (options.model !== undefined) {
    env.JEV_CONSOLE_MODEL = options.model;
  }
  if (options.timeoutSeconds !== undefined) {
    env.JEV_CONSOLE_TIMEOUT = String(options.timeoutSeconds);
  }
  if (options.retries !== undefined) {
    env.JEV_CONSOLE_RETRIES = String(options.retries);
  }
  return env;
}

interface SuperviseOptions {
  child: WebConsoleChild;
  options: ParsedOptions;
  database: DatabaseSession;
  target: ConsoleTarget;
  port: number;
  token: string;
  version: string;
  io: CliIO;
  dependencies: WebConsoleDependencies;
}

async function superviseChild(context: SuperviseOptions): Promise<number> {
  const {
    child,
    options,
    database,
    target,
    port,
    token,
    version,
    io,
    dependencies,
  } = context;
  const signals = dependencies.signals ?? processSignalTarget;
  const shutdownTimeoutMs = dependencies.shutdownTimeoutMs ?? 5_000;
  const healthController = new AbortController();
  let childResult: ChildResult | undefined;
  let requestedShutdown: "SIGINT" | "SIGTERM" | undefined;
  let resolveSignal: ((signal: "SIGINT" | "SIGTERM") => void) | undefined;
  const signalPromise = new Promise<"SIGINT" | "SIGTERM">((resolvePromise) => {
    resolveSignal = resolvePromise;
  });
  const childPromise = new Promise<ChildResult>((resolvePromise) => {
    const settle = (result: ChildResult): void => {
      if (childResult !== undefined) {
        return;
      }
      childResult = result;
      resolvePromise(result);
    };
    child.once("error", (error) => {
      settle({ type: "error", error });
    });
    child.once("exit", (code, signal) => {
      settle({ type: "exit", code, signal });
    });
  });
  const onSigint = (): void => {
    requestedShutdown ??= "SIGINT";
    resolveSignal?.("SIGINT");
    tryForwardSignal(child, "SIGINT");
  };
  const onSigterm = (): void => {
    requestedShutdown ??= "SIGTERM";
    resolveSignal?.("SIGTERM");
    tryForwardSignal(child, "SIGTERM");
  };
  signals.on("SIGINT", onSigint);
  signals.on("SIGTERM", onSigterm);

  const baseUrl = consoleBaseUrl(options.host, port);
  const healthPromise = waitForHealth(
    `${baseUrl}/api/health`,
    dependencies.fetch ?? defaultFetch,
    dependencies.startupTimeoutMs ?? (options.dev ? 120_000 : 30_000),
    dependencies.healthPollIntervalMs ?? 100,
    healthController.signal,
  );

  try {
    const initial = await Promise.race([
      healthPromise.then((health) => ({ type: "health" as const, health })),
      childPromise.then((result) => ({ type: "child" as const, result })),
      signalPromise.then((signal) => ({ type: "signal" as const, signal })),
    ]);

    if (initial.type === "signal") {
      healthController.abort();
      await settleHealth(healthPromise);
      await stopChild(
        child,
        childPromise,
        () => childResult !== undefined,
        initial.signal,
        shutdownTimeoutMs,
        true,
      );
      return 0;
    }
    if (initial.type === "child") {
      if (requestedShutdown !== undefined) {
        return 0;
      }
      throw new Error(earlyExitMessage(initial.result, baseUrl));
    }

    const health = initial.health;
    const bannerUrl = `${baseUrl}/#token=${encodeURIComponent(token)}`;
    if (!isLoopbackHost(options.host)) {
      io.stderr(
        `warning: the console listens outside loopback on ${options.host}; ` +
          "share the URL only with trusted clients and do not expose it publicly\n",
      );
    }
    io.stdout(
      "jev web-console\n" +
        `  URL:         ${bannerUrl}\n` +
        `  SQLite database: ${database.path}\n` +
        `  Version:     ${health.version ?? version}\n` +
        `  Schema:      ${database.schemaVersion}\n` +
        `  PID:         ${child.pid ?? "unknown"}\n` +
        `  Mode:        ${target.mode}\n` +
        "  Press Ctrl-C to stop the server.\n",
    );

    if (shouldOpenBrowser(options, io)) {
      const openBrowser =
        dependencies.openBrowser ??
        ((url: string) =>
          openBrowserWithPlatform(url, dependencies.platform ?? process.platform));
      try {
        await openBrowser(bannerUrl);
      } catch (error) {
        io.stderr(`warning: could not open the browser: ${messageOf(error)}\n`);
      }
    }

    const final = await Promise.race([
      childPromise.then((result) => ({ type: "child" as const, result })),
      signalPromise.then((signal) => ({ type: "signal" as const, signal })),
    ]);
    if (final.type === "signal") {
      await stopChild(
        child,
        childPromise,
        () => childResult !== undefined,
        final.signal,
        shutdownTimeoutMs,
        true,
      );
      return 0;
    }

    if (requestedShutdown !== undefined) {
      return 0;
    }
    if (final.result.type === "error") {
      io.stderr(
        `error: console process failure: ${final.result.error.message}\n`,
      );
      return 1;
    }
    if (final.result.code === 0) {
      return 0;
    }
    const reason =
      final.result.signal === null
        ? `code ${final.result.code ?? "unknown"}`
        : `signal ${final.result.signal}`;
    io.stderr(`error: the console server exited with ${reason}\n`);
    return 1;
  } catch (error) {
    healthController.abort();
    await settleHealth(healthPromise);
    await stopChild(
      child,
      childPromise,
      () => childResult !== undefined,
      "SIGTERM",
      shutdownTimeoutMs,
    );
    throw error;
  } finally {
    healthController.abort();
    signals.off("SIGINT", onSigint);
    signals.off("SIGTERM", onSigterm);
  }
}

async function waitForHealth(
  url: string,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  timeoutMs: number,
  intervalMs: number,
  signal: AbortSignal,
): Promise<HealthResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (!signal.aborted && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      return await requestHealth(
        url,
        fetchImpl,
        Math.max(1, Math.min(1_000, remaining)),
        signal,
      );
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      lastError = error;
    }
    const delayMs = Math.max(0, Math.min(intervalMs, deadline - Date.now()));
    if (delayMs > 0) {
      await sleep(delayMs, signal);
    }
  }
  if (signal.aborted) {
    throw new Error("/api/health wait cancelled");
  }
  const detail = lastError === undefined ? "timed out" : messageOf(lastError);
  throw new Error(`the console did not respond at ${url}: ${detail}`);
}

async function requestHealth(
  url: string,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  timeoutMs: number,
  parentSignal: AbortSignal,
): Promise<HealthResponse> {
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort();
  };
  if (parentSignal.aborted) {
    controller.abort();
  }
  parentSignal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(onAbort, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`/api/health returned HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    if (!isRecord(body) || body.ok !== true) {
      throw new Error("/api/health returned an invalid response");
    }
    return {
      version: typeof body.version === "string" ? body.version : undefined,
    };
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", onAbort);
  }
}

async function stopChild(
  child: WebConsoleChild,
  childPromise: Promise<ChildResult>,
  isSettled: () => boolean,
  signal: "SIGINT" | "SIGTERM",
  timeoutMs: number,
  alreadyForwarded = false,
): Promise<void> {
  if (isSettled()) {
    return;
  }
  if (!alreadyForwarded) {
    tryForwardSignal(child, signal);
  }
  await waitForChildOrTimeout(childPromise, timeoutMs);
  if (isSettled()) {
    return;
  }
  tryForwardSignal(child, "SIGKILL");
  await waitForChildOrTimeout(childPromise, 100);
}

async function waitForChildOrTimeout(
  childPromise: Promise<ChildResult>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      childPromise,
      new Promise<void>((resolvePromise) => {
        timer = setTimeout(resolvePromise, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function tryForwardSignal(child: WebConsoleChild, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // The exit/error result or the fallback SIGKILL settles the shutdown.
  }
}

function earlyExitMessage(result: ChildResult, baseUrl: string): string {
  if (result.type === "error") {
    if (errorCode(result.error) === "EADDRINUSE") {
      return `the port of ${baseUrl} is busy; try --port <n> or --port 0`;
    }
    return `the console server could not start: ${result.error.message}`;
  }
  const reason =
    result.signal === null
      ? `code ${result.code ?? "unknown"}`
      : `signal ${result.signal}`;
  return (
    `the console server exited before responding at ${baseUrl}/api/health ` +
    `(${reason}); check that the port is free or use --port 0`
  );
}

function parseWebConsoleOptions(args: string[]): ParsedOptions | "help" {
  let values: Values;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      options: WEB_CONSOLE_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as Values;
    positionals = parsed.positionals;
  } catch (error) {
    throw new UsageError(messageOf(error));
  }

  if (values.help === true) {
    return "help";
  }
  if (positionals.length > 0) {
    throw new UsageError(`unexpected argument: ${JSON.stringify(positionals[0])}`);
  }
  if (values.open === true && values["no-open"] === true) {
    throw new UsageError("--open and --no-open are mutually exclusive");
  }

  const host = asString(values.host) ?? "127.0.0.1";
  if (host === "" || host.trim() !== host || /[/?#@]/.test(host)) {
    throw new UsageError("--host must be a valid address or host name");
  }
  const allowRemote = values["allow-remote"] === true;
  if (!isLoopbackHost(host) && !allowRemote) {
    throw new UsageError(
      `--host ${host} is outside loopback; add --allow-remote explicitly`,
    );
  }

  return {
    port: parsePort(asString(values.port)),
    host,
    allowRemote,
    open:
      values.open === true ? true : values["no-open"] === true ? false : undefined,
    dev: values.dev === true,
    db: asString(values.db),
    key: asString(values.key),
    url: asString(values.url),
    model: asString(values.model),
    timeoutSeconds: parseTimeout(asString(values.timeout)),
    retries: parseRetries(asString(values.retries)),
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return 7411;
  }
  if (!/^\d+$/.test(value)) {
    throw new UsageError("--port must be an integer between 0 and 65535");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new UsageError("--port must be an integer between 0 and 65535");
  }
  return port;
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const timeout = Number(value);
  if (value.trim() === "" || !Number.isFinite(timeout) || timeout <= 0) {
    throw new UsageError("--timeout must be a positive number of seconds");
  }
  return timeout;
}

function parseRetries(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new UsageError("--retries must be an integer >= 0");
  }
  const retries = Number(value);
  if (!Number.isSafeInteger(retries) || retries < 0) {
    throw new UsageError("--retries must be an integer >= 0");
  }
  return retries;
}

function shouldOpenBrowser(options: ParsedOptions, io: CliIO): boolean {
  if (options.open !== undefined) {
    return options.open;
  }
  const env = io.env ?? process.env;
  const inCi = Boolean(env.CI && env.CI !== "0" && env.CI.toLowerCase() !== "false");
  const inSsh = Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
  return (io.isTty ?? true) && !inCi && !inSsh;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  if (isIpv4Loopback(normalized)) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isIpv4Loopback(normalized.slice("::ffff:".length));
  }
  return false;
}

function isIpv4Loopback(host: string): boolean {
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

function consoleBaseUrl(host: string, port: number): string {
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

function allocateAvailablePort(host: string, requestedPort: number): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen({ host, port: requestedPort }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPromise(new Error("could not determine a free port"));
        return;
      }
      const selectedPort = address.port;
      server.close((error) => {
        if (error) {
          rejectPromise(error);
        } else {
          resolvePromise(selectedPort);
        }
      });
    });
  });
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const defaultSpawn: WebConsoleSpawn = (command, args, options) =>
  spawn(command, [...args], options);

const defaultFetch = (input: string, init?: RequestInit): Promise<Response> =>
  fetch(input, init);

const processSignalTarget: WebConsoleSignalTarget = {
  on(signal, listener) {
    process.on(signal, listener);
  },
  off(signal, listener) {
    process.off(signal, listener);
  },
};

async function readPackageVersion(): Promise<string> {
  const candidates = [
    new URL("../../package.json", import.meta.url),
    new URL("../package.json", import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(await readFile(candidate, "utf8"));
      if (isRecord(parsed) && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // Tries the next location (dist/src and src, respectively).
    }
  }
  return "unknown";
}

function openBrowserWithPlatform(url: string, platform: NodeJS.Platform): Promise<void> {
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args =
    platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new Error("espera cancelada"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectPromise(new Error("espera cancelada"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function settleHealth(promise: Promise<HealthResponse>): Promise<void> {
  try {
    await promise;
  } catch {
    // La carrera principal ya conserva el error relevante.
  }
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
