#!/usr/bin/env node
/**
 * Fails fast when the current Node.js is below `engines.node`.
 *
 * Without this, `npm test`, `npm pack` and `npm publish` fail deep inside a
 * test run with `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` on Node 20, which
 * hides the real cause. The binary has the same guard at runtime.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

const required = /^>=\s*(\d+)\.(\d+)/.exec(packageJson.engines?.node ?? "");
if (!required) {
  console.error(`Cannot read a ">=major.minor" range from engines.node: ${packageJson.engines?.node}`);
  process.exit(1);
}

const [, requiredMajor, requiredMinor] = required.map(Number);
const [major, minor] = process.versions.node.split(".").map(Number);

if (major < requiredMajor || (major === requiredMajor && minor < requiredMinor)) {
  console.error(
    `jev requires Node.js >= ${requiredMajor}.${requiredMinor}; found ${process.versions.node}.`,
  );
  process.exit(1);
}
