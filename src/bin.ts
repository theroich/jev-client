#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { runCli, type CliIO } from "./cli.js";

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
        "$EDITOR no está definido. Define EDITOR/VISUAL o usa --file <ruta>.",
      );
    }
    const result = spawnSync(editor, [filePath], { stdio: "inherit" });
    if (result.error) {
      throw new Error(`no se pudo abrir $EDITOR (${editor}): ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`el editor (${editor}) salió con código ${result.status}`);
    }
    return readFile(filePath, "utf8");
  },
};

process.exitCode = await runCli(process.argv.slice(2), io);
