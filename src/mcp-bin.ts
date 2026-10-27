#!/usr/bin/env node
import { assertSupportedNode, silenceSqliteExperimentalWarning } from "./runtime.js";

const io = {
  stdout: (text: string): void => {
    process.stdout.write(text);
  },
  stderr: (text: string): void => {
    process.stderr.write(text);
  },
};

silenceSqliteExperimentalWarning();

const versionError = assertSupportedNode(process.version);
if (versionError !== null) {
  process.stderr.write(`${versionError}\n`);
  process.exitCode = 1;
} else {
  const { runMcpCommand } = await import("./mcp/run.js");
  process.exitCode = await runMcpCommand(process.argv.slice(2), io);
}
