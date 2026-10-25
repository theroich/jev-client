#!/usr/bin/env node
import { runMcpCommand } from "./mcp/run.js";

const io = {
  stdout: (text: string): void => {
    process.stdout.write(text);
  },
  stderr: (text: string): void => {
    process.stderr.write(text);
  },
};

process.exitCode = await runMcpCommand(process.argv.slice(2), io);
