import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(root, ".tmp"), { recursive: true });
const temp = await mkdtemp(path.join(root, ".tmp", "package-smoke-"));
const MAX_TARBALL_BYTES = 25 * 1024 * 1024;
let child;

try {
  await execute("npm", ["pack", "--pack-destination", temp], { cwd: root, env: { ...process.env, CI: "1" }, maxBuffer: 20 * 1024 * 1024 });
  const tarballName = (await readdir(temp)).find((name) => /^jev-client-.*\.tgz$/.test(name));
  if (!tarballName) throw new Error("npm pack did not produce the expected tarball");
  const tarball = path.join(temp, tarballName);
  const size = (await stat(tarball)).size;
  if (size > MAX_TARBALL_BYTES) throw new Error(`The tarball exceeds 25 MiB: ${size} bytes`);
  console.log(`Tarball: ${(size / 1024 / 1024).toFixed(2)} MiB (25 MiB threshold)`);

  const install = path.join(temp, "install");
  await mkdir(install, { recursive: true });
  await writeFile(path.join(install, "package.json"), '{"private":true}\n');
  await execute("npm", ["install", "--no-audit", "--no-fund", tarball], { cwd: install, env: { ...process.env, CI: "1" }, maxBuffer: 20 * 1024 * 1024, timeout: 180_000 });
  const packageRoot = path.join(install, "node_modules", "jev-client");
  await stat(path.join(packageRoot, "dist", "web-console", "server.js"));

  child = spawn(process.execPath, [path.join(packageRoot, "dist", "src", "bin.js"), "web-console", "--port", "0", "--no-open", "--db", path.join(temp, "installed.db")], {
    cwd: temp,
    env: { ...process.env, CI: "1", JEV_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 45_000;
  while (!stdout.includes("Press Ctrl-C")) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`The package did not start\n${stdout}\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const url = new URL(stdout.match(/URL:\s+(\S+)/)[1]);
  const healthResponse = await fetch(`${url.origin}/api/health`);
  if (!healthResponse.ok) throw new Error(`Package health: ${healthResponse.status}`);
  const health = await healthResponse.json();
  if (!health.ok || health.schemaVersion !== 6) throw new Error(`Invalid health: ${JSON.stringify(health)}`);
  const page = await fetch(`${url.origin}/`);
  const html = await page.text();
  if (!page.ok || !html.includes("Overview")) throw new Error("The installed page does not render Overview");
  const script = html.match(/src="(\/_next\/static\/[^"]+\.js)"/)?.[1];
  if (!script) throw new Error("No Next asset was found in the installed HTML");
  const asset = await fetch(`${url.origin}${script}`);
  if (!asset.ok || (await asset.text()).length === 0) throw new Error(`Missing standalone asset: ${script}`);
  console.log(JSON.stringify({ ok: true, tarballMiB: Number((size / 1024 / 1024).toFixed(2)), health: health.ok, page: page.status, asset: asset.status }));
  child.kill("SIGINT");
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  if (exitCode !== 0) throw new Error(`Package shutdown with code ${exitCode}\n${stderr}`);
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(temp, { recursive: true, force: true });
}
