#!/usr/bin/env node
/**
 * Fails when the version in `src/version.ts` differs from `package.json`.
 *
 * `src/version.ts` keeps a static string on purpose: the console is bundled by
 * Next into the standalone tree, so reading `package.json` at runtime would
 * resolve differently from the npm package. This script is the guard that keeps
 * both values in sync.
 *
 * Usage:
 *   node scripts/check-version.mjs                 # package.json vs src/version.ts
 *   node scripts/check-version.mjs --tag v1.2.3    # also require the release tag
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const versionSource = await readFile(path.join(root, "src", "version.ts"), "utf8");
const declared = versionSource.match(/export const VERSION = "([^"]+)";/);

if (!declared) {
  console.error('src/version.ts must declare: export const VERSION = "<version>";');
  process.exit(1);
}

if (declared[1] !== packageJson.version) {
  console.error(
    `Version mismatch: package.json has "${packageJson.version}" but src/version.ts has "${declared[1]}".`,
  );
  process.exit(1);
}

const tagIndex = process.argv.indexOf("--tag");
if (tagIndex !== -1) {
  const tag = process.argv[tagIndex + 1];
  const expected = `v${packageJson.version}`;
  if (tag !== expected) {
    console.error(`Tag mismatch: expected "${expected}" but got "${tag ?? ""}".`);
    process.exit(1);
  }
}

console.log(`Version ${packageJson.version} is consistent.`);
