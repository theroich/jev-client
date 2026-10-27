import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli, type CliIO } from "../src/cli.js";
import { SCHEMA_VERSION, openDatabase } from "../src/database.js";
import { VERSION } from "../src/version.js";
import {
  WEB_CONSOLE_USAGE,
  runWebConsoleCommand,
  type WebConsoleSignalTarget,
} from "../src/web-console.js";

interface Capture {
  io: CliIO;
  stdout: string;
  stderr: string;
}

function capture(env: NodeJS.ProcessEnv = {}): Capture {
  const result: Capture = {
    stdout: "",
    stderr: "",
    io: {
      stdout: (text) => {
        result.stdout += text;
      },
      stderr: (text) => {
        result.stderr += text;
      },
      readStdin: async () => "",
      env,
      isTty: false,
    },
  };
  return result;
}

class FakeSignals implements WebConsoleSignalTarget {
  private readonly listeners = new Map<
    "SIGINT" | "SIGTERM",
    Set<() => void>
  >();

  on(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  off(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: "SIGINT" | "SIGTERM"): void {
    for (const listener of this.listeners.get(signal) ?? []) {
      listener();
    }
  }

  count(): number {
    return [...this.listeners.values()].reduce(
      (total, listeners) => total + listeners.size,
      0,
    );
  }
}

test("web-console --help does not open the database or processes", async () => {
  const output = capture();
  const code = await runWebConsoleCommand(["--help"], output.io, {
    spawn: () => {
      throw new Error("must not run spawn");
    },
  });

  assert.equal(code, 0);
  assert.equal(output.stdout, WEB_CONSOLE_USAGE);
  assert.equal(output.stderr, "");
  assert.match(output.stdout, /--port <n>/);
  assert.match(output.stdout, /--allow-remote/);
});

test("web-console and --web-console are integrated before the general parser", async () => {
  for (const command of ["web-console", "--web-console"]) {
    const output = capture();
    const code = await runCli([command, "--help"], output.io);
    assert.equal(code, 0);
    assert.equal(output.stdout, WEB_CONSOLE_USAGE);
  }
  const help = capture();
  assert.equal(await runCli(["help"], help.io), 0);
  assert.match(help.stdout, /web-console/);
});

test("web-console validates flags and positionals as usage errors", async () => {
  const invalid = [
    ["extra"],
    ["--port", "-1"],
    ["--port", "65536"],
    ["--port", "not-a-port"],
    ["--timeout", "0"],
    ["--retries", "-1"],
    ["--open", "--no-open"],
    ["--flag-inexistente"],
  ];

  for (const args of invalid) {
    const output = capture();
    const code = await runWebConsoleCommand(args, output.io);
    assert.equal(code, 2, args.join(" "));
    assert.match(output.stderr, /error:/, args.join(" "));
    assert.match(output.stderr, /Usage: jev web-console/, args.join(" "));
  }
});

test("web-console requires --allow-remote outside loopback", async () => {
  const output = capture();
  const code = await runWebConsoleCommand(
    ["--host", "0.0.0.0", "--no-open"],
    output.io,
  );

  assert.equal(code, 2);
  assert.match(output.stderr, /outside loopback/);
  assert.match(output.stderr, /--allow-remote/);
});

test("web-console reports a missing standalone build after migrating the database", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-console-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "jev.db");
  const output = capture({
    JEV_CONSOLE_DIR: join(root, "standalone-without-build"),
    JEV_DB: dbPath,
  });
  let spawned = false;

  const code = await runWebConsoleCommand(["--no-open"], output.io, {
    spawn: () => {
      spawned = true;
      throw new Error("must not run spawn");
    },
  });

  assert.equal(code, 1);
  assert.equal(spawned, false);
  assert.match(output.stderr, /standalone build/);
  assert.match(output.stderr, /server\.js/);
  const db = openDatabase(dbPath);
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  db.close();
});

test("web-console clearly reports when the port is taken", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-console-port-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "server.js"), "", "utf8");
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  t.after(() => new Promise<void>((resolve) => listener.close(() => resolve())));
  const address = listener.address();
  assert.ok(address !== null && typeof address !== "string");

  const output = capture({
    JEV_CONSOLE_DIR: root,
    JEV_DB: join(root, "jev.db"),
  });
  let spawned = false;
  const code = await runWebConsoleCommand(
    ["--port", String(address.port), "--no-open"],
    output.io,
    {
      spawn: () => {
        spawned = true;
        throw new Error("must not run spawn");
      },
    },
  );

  assert.equal(code, 1);
  assert.equal(spawned, false);
  assert.match(output.stderr, new RegExp(`port ${address.port} is not available`));
  assert.match(output.stderr, /--port 0/);
});

test("web-console e2e starts the fake standalone, waits for health and closes with SIGINT", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "jev-console-e2e-"));
  const serverPath = join(root, "server.js");
  const envPath = join(root, "child-env.json");
  const dbPath = join(root, "jev.db");
  await writeFile(serverPath, FAKE_STANDALONE_SERVER, "utf8");

  const signals = new FakeSignals();
  const output = capture({
    ...process.env,
    CI: "1",
    JEV_CONSOLE_DIR: root,
    JEV_CONSOLE_TEST_ENV_FILE: envPath,
  });
  let openCalls = 0;
  let finished = false;
  const running = runWebConsoleCommand(
    [
      "--port",
      "0",
      "--no-open",
      "--db",
      dbPath,
      "--key",
      "session-key",
      "--url",
      "https://flag.test/systemone",
      "--model",
      "session-model",
      "--timeout",
      "12.5",
      "--retries",
      "4",
    ],
    output.io,
    {
      signals,
      openBrowser: () => {
        openCalls += 1;
      },
      startupTimeoutMs: 10_000,
      healthPollIntervalMs: 20,
      shutdownTimeoutMs: 2_000,
    },
  );
  void running.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  t.after(async () => {
    if (!finished) {
      signals.emit("SIGTERM");
    }
    await running;
    await rm(root, { recursive: true, force: true });
  });

  await waitFor(
    () => output.stdout.includes("Press Ctrl-C"),
    10_000,
    () => `banner not received. stderr: ${output.stderr}`,
  );
  const match = output.stdout.match(/^\s*URL:\s+(\S+)$/m);
  assert.ok(match?.[1]);
  const consoleUrl = new URL(match[1]);
  const healthUrl = `${consoleUrl.origin}/api/health`;
  const response = await fetch(healthUrl);
  assert.equal(response.status, 200);
  const health = (await response.json()) as {
    ok: boolean;
    schemaVersion: number;
    dbPath: string;
  };
  assert.equal(health.ok, true);
  assert.equal(health.schemaVersion, SCHEMA_VERSION);
  assert.equal(health.dbPath, dbPath);

  const childEnv = JSON.parse(await readFile(envPath, "utf8")) as {
    token: string;
    dbPath: string;
    host: string;
    port: string;
    version: string;
    schemaVersion: string;
    mode: string;
    allowRemote: string;
    apiKey: string;
    apiUrl: string;
    model: string;
    timeout: string;
    retries: string;
    pid: number;
    argv: string[];
  };
  assert.equal(consoleUrl.hash, `#token=${childEnv.token}`);
  assert.match(childEnv.token, /^[a-f0-9]{64}$/);
  assert.equal(childEnv.dbPath, dbPath);
  assert.equal(childEnv.host, "127.0.0.1");
  assert.equal(childEnv.port, consoleUrl.port);
  assert.equal(childEnv.version, VERSION);
  assert.equal(childEnv.schemaVersion, String(SCHEMA_VERSION));
  assert.equal(childEnv.mode, "standalone");
  assert.equal(childEnv.allowRemote, "0");
  assert.equal(childEnv.apiKey, "session-key");
  assert.equal(childEnv.apiUrl, "https://flag.test/systemone");
  assert.equal(childEnv.model, "session-model");
  assert.equal(childEnv.timeout, "12.5");
  assert.equal(childEnv.retries, "4");
  assert.deepEqual(childEnv.argv, []);
  assert.ok(output.stdout.includes(`PID:         ${childEnv.pid}`));
  assert.ok(output.stdout.includes(dbPath));
  assert.ok(!output.stderr.includes(childEnv.token));
  assert.ok(!output.stdout.includes("session-key"));
  assert.equal(output.stdout.split(childEnv.token).length - 1, 1);
  assert.equal(openCalls, 0);

  signals.emit("SIGINT");
  assert.equal(await running, 0);
  assert.equal(signals.count(), 0);
  await assert.rejects(
    fetch(healthUrl, { signal: AbortSignal.timeout(2_000) }),
    "the port must be closed after SIGINT",
  );
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  message: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(message());
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const FAKE_STANDALONE_SERVER = `
const http = require("node:http");
const fs = require("node:fs");

const server = http.createServer((request, response) => {
  if (request.url !== "/api/health") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    ok: true,
    version: process.env.JEV_CONSOLE_VERSION,
    schemaVersion: Number(process.env.JEV_CONSOLE_SCHEMA_VERSION),
    dbPath: process.env.JEV_CONSOLE_DB_PATH,
    uptime: process.uptime()
  }));
});

let closing = false;
function close() {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
server.on("error", (error) => {
  console.error(error.code || error.message);
  process.exit(1);
});
server.listen(Number(process.env.PORT), process.env.HOSTNAME, () => {
  fs.writeFileSync(process.env.JEV_CONSOLE_TEST_ENV_FILE, JSON.stringify({
    token: process.env.JEV_CONSOLE_TOKEN,
    dbPath: process.env.JEV_CONSOLE_DB_PATH,
    host: process.env.JEV_CONSOLE_HOST,
    port: process.env.JEV_CONSOLE_PORT,
    version: process.env.JEV_CONSOLE_VERSION,
    schemaVersion: process.env.JEV_CONSOLE_SCHEMA_VERSION,
    mode: process.env.JEV_CONSOLE_MODE,
    allowRemote: process.env.JEV_CONSOLE_ALLOW_REMOTE,
    apiKey: process.env.JEV_CONSOLE_API_KEY,
    apiUrl: process.env.JEV_CONSOLE_API_URL,
    model: process.env.JEV_CONSOLE_MODEL,
    timeout: process.env.JEV_CONSOLE_TIMEOUT,
    retries: process.env.JEV_CONSOLE_RETRIES,
    pid: process.pid,
    argv: process.argv.slice(2)
  }));
});
`;
