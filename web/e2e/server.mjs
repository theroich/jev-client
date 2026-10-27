import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifacts = path.join(root, "web", ".e2e");
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });
const dbPath = path.join(artifacts, "jev.db");
const consolePort = 17411;
const providerPort = 17412;
const readyPort = 17413;

const provider = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    try {
      const request = JSON.parse(body);
      const answers = {};
      for (const [name, question] of Object.entries(request.questions ?? {})) {
        if (question.type === "choice") {
          const keys = Object.keys(question.criteria ?? { yes: "Yes", no: "No" });
          const selected = keys.includes("infra") ? "infra" : keys[0];
          const probabilities = Object.fromEntries(keys.map((key, index) => [key, key === selected ? 0.78 : 0.22 / Math.max(1, keys.length - 1)]));
          answers[name] = { type: "choice", choice: selected, confidence: 0.78, probabilities };
        } else if (question.type === "score") {
          const levels = question.criteria ?? ["Low", "Medium", "High"];
          const legend = Object.fromEntries(levels.map((level, index) => [String(index), level]));
          const probabilities = Object.fromEntries(levels.map((_, index) => [String(index), index === 2 ? 0.6 : index === 1 ? 0.3 : 0.1]));
          answers[name] = { type: "score", score: 1.4, legend, confidence: 0.82, probabilities };
        } else {
          answers[name] = { type: "noul", noul: 0.93 };
        }
      }
      const response = { model: request.model, answers, usage: { input_tokens: 42, output_tokens: 17, cost: 0.0000014 } };
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
      }, 20);
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "invalid_request", message: String(error) } }));
    }
  });
});
await new Promise((resolve, reject) => {
  provider.once("error", reject);
  provider.listen(providerPort, "127.0.0.1", resolve);
});

const { openDatabase } = await import(path.join(root, "dist", "src", "database.js"));
const { ConfigRepository } = await import(path.join(root, "dist", "src", "config-repository.js"));
const { TemplateRepository } = await import(path.join(root, "dist", "src", "template-repository.js"));
const db = openDatabase(dbPath);
new ConfigRepository(db).set("api_url", `http://127.0.0.1:${providerPort}/systemone`);
new ConfigRepository(db).set("api_key", "e2e-secret-key");
new ConfigRepository(db).set("model", "e2e-configured-model");
new ConfigRepository(db).set("timeout", "2");
new ConfigRepository(db).set("retries", "0");
new TemplateRepository(db).save("order", "E2E order", JSON.stringify({
  model: "jev-1.13",
  state: { ticket: "{{order_state}}", customer: "{{customer.name}}" },
  questions: { urgent: { type: "noul", instructions: "Is it urgent?" } },
}));
db.close();

let stdout = "";
let stderr = "";
const childEnv = { ...process.env, CI: "1" };
for (const key of ["JEV_API_KEY", "JEV_URL", "JEV_MODEL"]) delete childEnv[key];
const child = spawn(process.execPath, [path.join(root, "dist", "src", "bin.js"), "web-console", "--port", String(consolePort), "--no-open", "--db", dbPath], {
  cwd: root,
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

let readyServer;
let closing = false;
async function cleanup() {
  if (closing) return;
  closing = true;
  if (readyServer) await new Promise((resolve) => readyServer.close(resolve));
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await new Promise((resolve) => provider.close(resolve));
  if (child.exitCode && child.exitCode !== 0) console.error(stderr || stdout);
}
process.on("SIGTERM", () => { void cleanup().then(() => process.exit(0)); });
process.on("SIGINT", () => { void cleanup().then(() => process.exit(0)); });
child.once("exit", (code) => {
  if (!closing && code !== 0) {
    console.error(`E2E console exited ${code}\n${stdout}\n${stderr}`);
    void cleanup().then(() => process.exit(1));
  }
});

const deadline = Date.now() + 60000;
while (!stdout.includes("Press Ctrl-C")) {
  if (Date.now() > deadline || child.exitCode !== null) {
    console.error(`The E2E console did not start\n${stdout}\n${stderr}`);
    await cleanup();
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const printedUrl = new URL(stdout.match(/URL:\s+(\S+)/)[1]);
const token = decodeURIComponent(printedUrl.hash.slice("#token=".length));
const exchange = await fetch(`${printedUrl.origin}/api/session`, {
  method: "POST",
  headers: { "X-Jev-Console-Token": token, Origin: printedUrl.origin, "Content-Type": "application/json" },
  body: "{}",
});
if (!exchange.ok) throw new Error(`E2E session: ${exchange.status} ${await exchange.text()}`);
const setCookie = exchange.headers.get("set-cookie");
const cookieValue = setCookie.match(/jev_console_session=([^;]+)/)[1];
const storageState = {
  cookies: [{ name: "jev_console_session", value: cookieValue, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Strict" }],
  origins: [],
};
await writeFile(path.join(artifacts, "storageState.json"), JSON.stringify(storageState));
await writeFile(path.join(artifacts, "state.json"), JSON.stringify({ origin: printedUrl.origin, dbPath, providerPort }));
readyServer = createServer((_req, res) => { res.writeHead(200).end("ready"); });
await new Promise((resolve) => readyServer.listen(readyPort, "127.0.0.1", resolve));
console.log(`E2E_READY ${printedUrl.origin}`);
await new Promise(() => {});
