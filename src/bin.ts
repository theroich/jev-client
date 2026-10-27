#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

import type { CliIO } from "./cli.js";
import { assertSupportedNode, silenceSqliteExperimentalWarning } from "./runtime.js";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk as Uint8Array));
    });
    process.stdin.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", () => {
      resolve("");
    });
  });
}

const io: CliIO = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  readStdin,
  isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  confirm: async (prompt) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      const answer = await rl.question(prompt);
      const normalized = answer.trim().toLowerCase();
      return normalized === "s" || normalized === "sí" || normalized === "si" ||
        normalized === "y" || normalized === "yes";
    } finally {
      rl.close();
    }
  },
  openInEditor: async (filePath) => {
    const editor = process.env.EDITOR || process.env.VISUAL;
    if (!editor) {
      throw new Error(
        "$EDITOR is not set. Set EDITOR/VISUAL or use --file <path>.",
      );
    }
    const result = spawnSync(editor, [filePath], { stdio: "inherit" });
    if (result.error) {
      throw new Error(`could not open $EDITOR (${editor}): ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`the editor (${editor}) exited with code ${result.status}`);
    }
    return readFile(filePath, "utf8");
  },
};

silenceSqliteExperimentalWarning();

const versionError = assertSupportedNode(process.version);
if (versionError !== null) {
  process.stderr.write(`${versionError}\n`);
  process.exitCode = 1;
} else {
  const { runCli } = await import("./cli.js");
  process.exitCode = await runCli(process.argv.slice(2), io);
}
