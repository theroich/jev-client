import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= "0";
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "..");

export default defineConfig({
  testDir: directory,
  testMatch: "**/*.spec.ts",
  outputDir: path.join(directory, "test-results"),
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["line"], ["html", { outputFolder: path.join(directory, "playwright-report"), open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:17411",
    storageState: path.join(directory, ".e2e", "storageState.json"),
    viewport: { width: 1440, height: 900 },
    headless: true,
    actionTimeout: 10_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node web/e2e/server.mjs",
    cwd: root,
    url: "http://127.0.0.1:17413/ready",
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
