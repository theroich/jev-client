import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";

import { loadImageAsset, validateImageAsset } from "./assets.js";
import type { FetchLike } from "./client.js";
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  resolveConfig,
  resolveModel,
  type StoredConfig,
} from "./config.js";
import {
  CONFIG_KEYS,
  ConfigRepository,
  isConfigKey,
  validateConfigValue,
  type ConfigKey,
} from "./config-repository.js";
import { openDatabase, resolveDatabasePath } from "./database.js";
import { JevApiError, jevErrorHint } from "./errors.js";
import {
  formatCost,
  formatHistoryDetail,
  formatHistoryRecord,
  formatReport,
  historyRecordToJson,
  maskSecret,
} from "./format.js";
import {
  RequestRepository,
  type HistoryFilters,
} from "./request-repository.js";
import { JevService, MAX_CONCURRENCY } from "./service.js";
import {
  MACRO_SCHEMA_TYPES,
  MacroSchemaError,
  TemplateRepository,
  validateMacroSchema,
  type MacroSchema,
  type MacroSchemaType,
  type TemplateMacro,
} from "./template-repository.js";
import {
  detectMacros,
  resolveTemplateBody,
  validateQuestions,
  validateTemplateBody,
  type TemplateContext,
} from "./template.js";
import { createTuiBackend, runTui, type TuiBackend } from "./tui.js";
import type { ImageAsset, JevRequest, JevResponse, Question, State } from "./types.js";
import { VERSION } from "./version.js";
import { runWebConsoleCommand } from "./web-console.js";

export { VERSION };

export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
  /** Injectable fetch (tests). */
  fetch?: FetchLike;
  /** Environment (tests). Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Interactive confirmation (tests). If not set, operations that require
   * confirmation treat the answer as negative.
   */
  confirm?(prompt: string): Promise<boolean>;
  /**
   * Opens a file with $EDITOR and returns its edited content. If not set,
   * `templates edit` only accepts --file.
   */
  openInEditor?(filePath: string, initial: string): Promise<string>;
  /** Whether there is an interactive terminal (TTY). Default: assumed yes. */
  isTty?: boolean;
  /** Runs the interactive mode (injectable in tests). Default: real driver. */
  runTui?: (backend: TuiBackend) => Promise<number>;
}

const USAGE = `jev-client — CLI for the Jev API (System One)

Usage:
  jev-client ask [flags]      evaluates a state against one or more questions
  jev-client demo [flags]     runs a built-in example
  jev-client config <command> manages persistent settings
  jev-client history <command> queries the request history
  jev-client template <command> manages JSON templates with macros
  jev-client templates <command> alias of template
  jev-client batch <template> --contexts <file.json>  runs a template for many contexts
  jev-client tui [--db <path>]  interactive mode (settings and templates)
  jev-client web-console [flags]  local Next.js web console
  jev-client --web-console [flags] alias of web-console
  jev-client mcp [flags]        MCP stdio server (template and run tools)
  jev-client version          shows the version
  jev-client help             shows this help

Environment variables:
  OPENCODE_API_KEY (or JEV_API_KEY)  API key
  JEV_URL                           endpoint
  JEV_MODEL                         model
  JEV_DB                            SQLite database path

Precedence: flag > environment variable > database > default value.
Default endpoint: ${DEFAULT_ENDPOINT}
Default model:    ${DEFAULT_MODEL}
Default database: <OS-home>/.jev-client/db/jev.db

Examples:
  jev-client demo
  jev-client demo --json
  jev-client ask --state "I was charged twice" \\
      --noul 'billing=Is this about billing?'
  jev-client ask --state-file ticket.txt --questions-file questions.json
  jev-client ask --request-file request.json
  jev-client config set model jev-1.13-free
  jev-client template render order --context '{"state":"pending"}'
  jev-client batch order --contexts examples/contexts.json
`;

const ASK_USAGE = `Usage: jev-client ask [flags]

Flags:
  --state <text|json>      content to evaluate ('-' for stdin)
  --state-file <path>      file with the state ('-' for stdin)
  --questions <json>       questions as JSON ('-' for stdin)
  --questions-file <path>  file with the questions as JSON
  --request <json>         full payload as JSON ('-' for stdin)
  --request-file <path>    file with the full payload
  --noul <key>=<instruction>            yes/no question (repeatable)
  --choice <key>=<instruction>          classification question (repeatable)
  --score <key>=<instruction>           ordered scale question (repeatable)
  --option <question>.<option>=<desc.>  option of a --choice (repeatable)
  --level <question>=<level>            level of a --score, in order (repeatable)
  --asset [<ref>=]<path>                  image (PNG/JPEG); without <ref> a UUID is generated (repeatable)
  --assets-file <path>                    full assets map as JSON
  --no-images-header                      omits the images header (to test the 400)
  --key <key>              API key (env: OPENCODE_API_KEY, JEV_API_KEY)
  --url <endpoint>         full endpoint (env: JEV_URL)
  --model <model>          e.g. jev-1.13 or jev-1.13-free (env: JEV_MODEL)
  --db <path>              SQLite database (env: JEV_DB)
  --timeout <seconds>      timeout of each HTTP attempt (default 30)
  --retries <n>            retries on 429/5xx (default 2)
  --no-save                do not record this run in the history
  --json                   prints the raw response as JSON
  -h, --help               shows this help

The --noul/--choice/--score flags replace the inline --questions: they build
the JSON the client already understands without writing it by hand. --option
provides the options of a --choice and --level the levels (in order) of a
--score. They do not combine with --questions, --questions-file, --request or
--request-file.

Examples:
  jev ask --state "I was charged twice." --noul 'billing=Is this about billing?'
  jev ask --state "The checkout has been down for 30 minutes." \\
      --choice 'team=Which team should own the incident?' \\
      --option 'team.billing=Billing, invoices or payments' \\
      --option 'team.infra=Outages, 500 errors or platform problems' \\
      --option 'team.sales=Pricing or sales questions'
  jev ask --state "We have gone two days without an answer." \\
      --score 'urgency=How urgent is the incident?' \\
      --level 'urgency=It can wait' --level 'urgency=This week' \\
      --level 'urgency=Today'
`;

const DEMO_USAGE = `Usage: jev-client demo [flags]

Flags:
  --key <key>              API key (env: OPENCODE_API_KEY, JEV_API_KEY)
  --url <endpoint>         full endpoint (env: JEV_URL)
  --model <model>          e.g. jev-1.13 or jev-1.13-free (env: JEV_MODEL)
  --db <path>              SQLite database (env: JEV_DB)
  --timeout <seconds>      timeout of each HTTP attempt (default 30)
  --retries <n>            retries on 429/5xx (default 2)
  --no-save                do not record this run in the history
  --json                   prints the raw response as JSON
  -h, --help               shows this help
`;

const CONFIG_USAGE = `Usage:
  jev-client config list [--json] [--db <path>]
  jev-client config get <key> [--json] [--reveal] [--db <path>]
  jev-client config set <key> <value> [--db <path>]
  jev-client config unset <key> [--db <path>]
  jev-client config path [--db <path>]

Keys: api_url, api_key, model, timeout (seconds), retries.

'config get api_key' shows the key masked; use --reveal to see it.
'config path' prints the database path in use.

The API key is stored in plain text. To avoid persisting it, use --key or
OPENCODE_API_KEY/JEV_API_KEY on every run.
`;

const HISTORY_USAGE = `Usage:
  jev-client history list [filters] [--db <path>]
  jev-client history show <id> [--db <path>]
  jev-client history export [filters] [--db <path>]

Filters (list and export):
  --since <ISO>            only requests since this date (created_at)
  --status <code>          HTTP status code (e.g. 200, 429)
  --model <model>          exact model
  --template <name>        template name
  --batch <id>             batch identifier
  --limit <n>              maximum number of results

Common flags:
  --db <path>              SQLite database (env: JEV_DB)
  -h, --help               shows this help
`;

const TEMPLATE_USAGE = `Usage:
  jev-client template add <name> [--description <text>] (--body <json> | --body-file <path>) [--macro-desc <key>=<text>]... [--macro-schema <key>=<json>]... [--macro-type <key>=<type>]...
  jev-client template create <name> [--description <text>] (--body <json> | --file <path>) [--macro-desc <key>=<text>]... [--macro-schema <key>=<json>]... [--macro-type <key>=<type>]...
  jev-client template list [--json] [--db <path>]
  jev-client template show <name> [--json] [--db <path>]
  jev-client template edit <name> (--file <path> | uses $EDITOR) [--description <text>] [--macro-desc <key>=<text>]... [--clear-macro-desc <key>]... [--macro-schema <key>=<json>]... [--macro-type <key>=<type>]... [--clear-macro-schema <key>]... [--db <path>]
  jev-client template delete <name> [--yes] [--db <path>]
  jev-client template remove <name> [--db <path>]
  jev-client template validate <name> [--db <path>]
  jev-client template validate --file <path>
  jev-client template render <name> (--context <json> | --context-file <path>) [--db <path>]

The body of a template is a Jev request with {{key}} macros, which support
nested paths ({{customer.name}}). 'render' resolves the macros with a JSON
context and previews the request without sending it.

Macro descriptions are optional metadata for humans and agents:
'--macro-desc ticket=Order identifier' is repeatable and
'--clear-macro-desc ticket' clears the description. Without flags, 'edit' keeps
the existing descriptions.

Each macro also accepts an optional, informative JSON Schema:
'--macro-schema plan={"type":"string","enum":["free","pro"]}' stores the full
schema, '--macro-type plan=string' is the shorthand {"type":"string"} and
'--clear-macro-schema plan' removes it while keeping the description. Schemas
are not sent to Jev and are not resolved when rendering.
`;

const BATCH_USAGE = `Usage: jev-client batch <template> --contexts <file.json> [flags]

Runs a template with macros once per context map in the file.
Each map produces one request and one row in the history (same batch_id).

Flags:
  --contexts <file.json>     array of context maps ('-' for stdin)
  --concurrency <n>          concurrent requests (default 1, max 10)
  --continue-on-error        continues with the rest on errors (default)
  --fail-fast                stops the run at the first error
  --key <key>                API key (env: OPENCODE_API_KEY, JEV_API_KEY)
  --url <endpoint>           full endpoint (env: JEV_URL)
  --model <model>            e.g. jev-1.13 or jev-1.13-free (env: JEV_MODEL)
  --db <path>                SQLite database (env: JEV_DB)
  --timeout <seconds>        timeout of each HTTP attempt (default 30)
  --retries <n>              retries on 429/5xx (default 2)
  --no-save                  do not record the run in the history
  --json                     prints the summary as JSON
  -h, --help                 shows this help
`;

const TUI_USAGE = `Usage: jev-client tui [--db <path>]

Opens the interactive mode to configure the provider and manage templates.
Requires a terminal (TTY). In environments without a TTY use the equivalent
commands:
  jev config set <key> <value>
  jev config get <key>
  jev template list | show <name> | create | edit | validate | render
`;

const TUI_NO_TTY = `error: the interactive mode (tui) requires a terminal (TTY).
Use the equivalent commands:
  jev config set <key> <value>            configures the provider
  jev config get <key>                    reads a value
  jev template list                       lists templates
  jev template show <name>                details of a template
  jev template create <name> --body ... creates a template
  jev template edit <name>                edits a template (\$EDITOR)
  jev template validate <name>            validates a template
  jev template render <name> --context ... previews
`;

type ParseArgsOptions = NonNullable<ParseArgsConfig["options"]>;

const COMMON_OPTIONS = {
  key: { type: "string" },
  url: { type: "string" },
  model: { type: "string" },
  timeout: { type: "string" },
  retries: { type: "string" },
  db: { type: "string" },
  "no-save": { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} satisfies ParseArgsOptions;

const CONFIG_OPTIONS = {
  db: { type: "string" },
  json: { type: "boolean" },
  reveal: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} satisfies ParseArgsOptions;

const HISTORY_OPTIONS = {
  db: { type: "string" },
  since: { type: "string" },
  status: { type: "string" },
  model: { type: "string" },
  template: { type: "string" },
  batch: { type: "string" },
  limit: { type: "string" },
  help: { type: "boolean", short: "h" },
} satisfies ParseArgsOptions;

const TEMPLATE_OPTIONS = {
  db: { type: "string" },
  json: { type: "boolean" },
  yes: { type: "boolean" },
  file: { type: "string" },
  help: { type: "boolean", short: "h" },
  description: { type: "string" },
  body: { type: "string" },
  "body-file": { type: "string" },
  context: { type: "string" },
  "context-file": { type: "string" },
  "macro-desc": { type: "string", multiple: true },
  "clear-macro-desc": { type: "string", multiple: true },
  "macro-schema": { type: "string", multiple: true },
  "macro-type": { type: "string", multiple: true },
  "clear-macro-schema": { type: "string", multiple: true },
} satisfies ParseArgsOptions;

const ASK_OPTIONS = {
  ...COMMON_OPTIONS,
  state: { type: "string" },
  "state-file": { type: "string" },
  questions: { type: "string" },
  "questions-file": { type: "string" },
  request: { type: "string" },
  "request-file": { type: "string" },
  noul: { type: "string", multiple: true },
  choice: { type: "string", multiple: true },
  score: { type: "string", multiple: true },
  option: { type: "string", multiple: true },
  level: { type: "string", multiple: true },
  asset: { type: "string", multiple: true },
  "assets-file": { type: "string" },
  "no-images-header": { type: "boolean" },
} satisfies ParseArgsOptions;

const BATCH_OPTIONS = {
  ...COMMON_OPTIONS,
  contexts: { type: "string" },
  concurrency: { type: "string" },
  "continue-on-error": { type: "boolean" },
  "fail-fast": { type: "boolean" },
} satisfies ParseArgsOptions;

const TUI_OPTIONS = {
  db: { type: "string" },
  help: { type: "boolean", short: "h" },
} satisfies ParseArgsOptions;

interface CommonOptions {
  config: ReturnType<typeof resolveConfig>;
  model?: string | undefined;
  storedModel?: string | undefined;
  json: boolean;
}

type Values = Record<string, string | string[] | boolean | undefined>;

class UsageError extends Error {}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const command = argv[0] === "--web-console" ? "web-console" : argv[0];
  if (command === undefined) {
    io.stderr(`${USAGE}\n`);
    return 2;
  }

  try {
    switch (command) {
      case "ask":
        return await runAsk(argv.slice(1), io);
      case "demo":
        return await runDemo(argv.slice(1), io);
      case "config":
        return runConfig(argv.slice(1), io);
      case "history":
        return runHistory(argv.slice(1), io);
      case "template":
      case "templates":
        return await runTemplate(argv.slice(1), io);
      case "batch":
        return await runBatch(argv.slice(1), io);
      case "tui":
        return await runTuiCommand(argv.slice(1), io);
      case "web-console":
        return await runWebConsoleCommand(argv.slice(1), io);
      case "mcp": {
        const { runMcpCommand } = await import("./mcp/run.js");
        return await runMcpCommand(argv.slice(1), io);
      }
      case "version":
      case "--version":
        io.stdout(`jev-client ${VERSION}\n`);
        return 0;
      case "help":
      case "--help":
      case "-h":
        io.stdout(USAGE);
        return 0;
      default:
        throw new UsageError(`unknown command: ${JSON.stringify(command)}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`error: ${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    printError(io.stderr, error);
    return 1;
  }
}

async function runAsk(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseOptions(args, ASK_OPTIONS);

  if (values.help === true) {
    io.stdout(ASK_USAGE);
    return 0;
  }
  if (positionals.length > 0) {
    throw new UsageError(`unexpected argument: ${JSON.stringify(positionals[0])}`);
  }
  if (
    values.state === undefined &&
    values["state-file"] === undefined &&
    values.request === undefined &&
    values["request-file"] === undefined
  ) {
    throw new UsageError("missing --state, --state-file or --request-file");
  }

  const options = readCommonOptions(values, io);
  const request = await buildRequest(values, options, io);
  const service = createService(values, io);
  try {
    const { response } = await service.ask(request, {
      model: options.model,
      save: values["no-save"] !== true,
      imagesHeader: values["no-images-header"] !== true,
    });
    writeResponse(io, response, options.json);
    return 0;
  } finally {
    service.close();
  }
}

async function runDemo(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseOptions(args, COMMON_OPTIONS);

  if (values.help === true) {
    io.stdout(DEMO_USAGE);
    return 0;
  }
  if (positionals.length > 0) {
    throw new UsageError(`unexpected argument: ${JSON.stringify(positionals[0])}`);
  }

  const options = readCommonOptions(values, io);
  const service = createService(values, io);
  try {
    const { response } = await service.demo({
      model: options.model,
      save: values["no-save"] !== true,
    });
    writeResponse(io, response, options.json);
    return 0;
  } finally {
    service.close();
  }
}

interface BatchItemResult {
  index: number;
  ok: boolean;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  error?: string;
  raw?: unknown;
}

async function runBatch(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseOptions(args, BATCH_OPTIONS);

  if (values.help === true) {
    io.stdout(BATCH_USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    throw new UsageError(
      "usage: jev batch <template> --contexts <file.json> [flags]",
    );
  }
  const templateName = positionals[0] as string;
  if (templateName.trim() === "") {
    throw new UsageError("the template name cannot be empty");
  }

  const concurrency = parseConcurrency(asString(values.concurrency));
  const failFast = values["fail-fast"] === true;

  const contextsFlag = asString(values.contexts);
  if (contextsFlag === undefined) {
    throw new UsageError("missing --contexts <file.json>");
  }

  const raw = await readInput(undefined, contextsFlag, io);
  if (raw === undefined || raw.trim() === "") {
    throw new Error("--contexts is empty");
  }
  const contexts = parseContextsArray(raw);

  const options = readCommonOptions(values, io);
  const service = createService(values, io);
  try {
    const batch = await service.batch(templateName, contexts, {
      concurrency,
      failFast,
      model: options.model,
      save: values["no-save"] !== true,
    });
    const results = batch.items.filter((item) => item.status !== "skipped");
    const skipped = batch.summary.skipped;

    if (options.json) {
      io.stdout(
        `${JSON.stringify(batchToJson(batch.batchId, templateName, results, contexts.length, skipped), null, 2)}\n`,
      );
    } else {
      io.stdout(formatBatchReport(templateName, batch.batchId, results, skipped));
    }

    return results.some((result) => !result.ok) || skipped > 0 ? 1 : 0;
  } finally {
    service.close();
  }
}

function parseConcurrency(value: string | undefined): number {
  if (value === undefined) {
    return 1;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CONCURRENCY) {
    throw new UsageError(
      `--concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`,
    );
  }
  return parsed;
}

function parseContextsArray(raw: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in --contexts: ${messageOf(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("--contexts must be an array of context maps");
  }
  return parsed;
}

function batchToJson(
  batchId: string,
  templateName: string,
  results: BatchItemResult[],
  total: number,
  skipped: number,
): Record<string, unknown> {
  const ok = results.filter((result) => result.ok).length;
  const costUnknown = results.filter(
    (result) => result.ok && result.cost === undefined,
  ).length;
  return {
    batch_id: batchId,
    template: templateName,
    total,
    processed: results.length,
    skipped,
    ok,
    errors: results.length - ok,
    input_tokens: sumDefined(results.map((result) => result.inputTokens)),
    output_tokens: sumDefined(results.map((result) => result.outputTokens)),
    cost: sumDefined(results.map((result) => result.cost)),
    cost_unknown: costUnknown,
    items: results.map((result) => ({
      index: result.index,
      ok: result.ok,
      model: result.model ?? null,
      input_tokens: result.inputTokens ?? null,
      output_tokens: result.outputTokens ?? null,
      cost: result.cost ?? null,
      error: result.error ?? null,
      response: result.raw ?? null,
    })),
  };
}

function formatBatchReport(
  templateName: string,
  batchId: string,
  results: BatchItemResult[],
  skipped: number,
): string {
  const ok = results.filter((result) => result.ok).length;
  const errors = results.length - ok;
  const inputTokens = sumDefined(results.map((result) => result.inputTokens));
  const outputTokens = sumDefined(results.map((result) => result.outputTokens));
  const costTotal = sumDefined(results.map((result) => result.cost));
  const costUnknown = results.filter(
    (result) => result.ok && result.cost === undefined,
  ).length;

  const lines = [
    `batch: ${templateName} — ${results.length} requests (batch ${batchId})`,
  ];
  for (const result of results) {
    if (result.ok) {
      const cost =
        result.cost === undefined ? "-" : formatCost(result.cost);
      lines.push(
        `  ${result.index + 1}: ok    ${result.model ?? "-"}  ` +
          `${result.inputTokens ?? 0} in / ${result.outputTokens ?? 0} out  ` +
          `cost=${cost}`,
      );
    } else {
      lines.push(`  ${result.index + 1}: error ${result.error ?? "unknown"}`);
    }
  }
  if (skipped > 0) {
    lines.push(`  (${skipped} skipped by --fail-fast)`);
  }
  lines.push(`summary: ${ok} ok, ${errors} error`);
  lines.push(`tokens: ${inputTokens} in / ${outputTokens} out`);
  lines.push(
    `cost: ${formatCost(costTotal)}` +
      (costUnknown > 0 ? ` (${costUnknown} without reported cost)` : ""),
  );
  return `${lines.join("\n")}\n`;
}

function sumDefined(values: Array<number | undefined>): number {
  let total = 0;
  for (const value of values) {
    if (value !== undefined) {
      total += value;
    }
  }
  return total;
}

async function runTuiCommand(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseOptions(args, TUI_OPTIONS);
  if (values.help === true) {
    io.stdout(TUI_USAGE);
    return 0;
  }
  if (positionals.length > 0) {
    throw new UsageError(`unexpected argument: ${JSON.stringify(positionals[0])}`);
  }
  if (io.isTty === false) {
    io.stderr(TUI_NO_TTY);
    return 1;
  }

  const path = resolveDatabasePath(asString(values.db), envOf(io));
  const db = openDatabase(path);
  try {
    const backend = createTuiBackend(db);
    const runner = io.runTui ?? runTui;
    return await runner(backend);
  } finally {
    db.close();
  }
}

function runConfig(args: string[], io: CliIO): number {
  const { values, positionals } = parseOptions(args, CONFIG_OPTIONS);
  if (values.help === true) {
    io.stdout(CONFIG_USAGE);
    return 0;
  }

  const action = positionals[0];
  if (action === undefined) {
    throw new UsageError("missing a config command (list, get, set or unset)");
  }

  switch (action) {
    case "list": {
      expectConfigArity(positionals, 1, "jev config list [--json] [--db <path>]");
      return withDatabase(values, io, (repository) => {
        const entries = repository.list();
        if (values.json === true) {
          const object: Record<string, string> = {};
          for (const { key, value } of entries) {
            object[key] = value;
          }
          io.stdout(`${JSON.stringify(object, null, 2)}\n`);
        } else {
          for (const { key, value } of entries) {
            io.stdout(`${key}=${key === "api_key" ? maskSecret(value) : value}\n`);
          }
        }
        return 0;
      });
    }
    case "get": {
      expectConfigArity(positionals, 2, "jev config get <key> [--db <path>]");
      const key = parseConfigKey(positionals[1]);
      return withDatabase(values, io, (repository) => {
        const value = repository.get(key);
        if (value === undefined) {
          throw new Error(`setting not defined: ${key}`);
        }
        const reveal = values.reveal === true;
        if (values.json === true) {
          io.stdout(`${JSON.stringify(value)}\n`);
        } else if (key === "api_key" && !reveal) {
          io.stdout(`${maskSecret(value)}\n`);
        } else {
          io.stdout(`${value}\n`);
        }
        return 0;
      });
    }
    case "set": {
      expectConfigArity(
        positionals,
        3,
        "jev config set <key> <value> [--db <path>]",
      );
      const key = parseConfigKey(positionals[1]);
      const value = positionals[2] as string;
      try {
        validateConfigValue(key, value);
      } catch (error) {
        throw new UsageError(messageOf(error));
      }
      return withDatabase(values, io, (repository, path) => {
        repository.set(key, value);
        io.stdout(`setting saved: ${key}\n`);
        if (key === "api_key") {
          io.stderr(
            `warning: the API key is stored in plain text in ${path}. ` +
              "To avoid persisting it, use --key or OPENCODE_API_KEY/JEV_API_KEY.\n",
          );
        }
        return 0;
      });
    }
    case "unset": {
      expectConfigArity(
        positionals,
        2,
        "jev config unset <key> [--db <path>]",
      );
      const key = parseConfigKey(positionals[1]);
      return withDatabase(values, io, (repository) => {
        repository.unset(key);
        io.stdout(`setting deleted: ${key}\n`);
        return 0;
      });
    }
    case "path": {
      expectConfigArity(positionals, 1, "jev config path [--db <path>]");
      const path = resolveDatabasePath(asString(values.db), envOf(io));
      io.stdout(`${path}\n`);
      return 0;
    }
    default:
      throw new UsageError(
        `unknown config command: ${JSON.stringify(action)}`,
      );
  }
}

function runHistory(args: string[], io: CliIO): number {
  const { values, positionals } = parseOptions(args, HISTORY_OPTIONS);
  if (values.help === true) {
    io.stdout(HISTORY_USAGE);
    return 0;
  }

  const action = positionals[0];
  if (action === undefined) {
    throw new UsageError("missing a history command (list, show or export)");
  }

  switch (action) {
    case "list": {
      expectConfigArity(positionals, 1, "jev history list [filters]");
      const filters = parseHistoryFilters(values);
      return withRequestDatabase(values, io, (repository) => {
        for (const record of repository.list(filters)) {
          io.stdout(`${formatHistoryRecord(record)}\n`);
        }
        return 0;
      });
    }
    case "show": {
      expectConfigArity(positionals, 2, "jev history show <id> [--db <path>]");
      const id = parseHistoryId(positionals[1]);
      return withRequestDatabase(values, io, (repository) => {
        const record = repository.get(id);
        if (record === undefined) {
          throw new Error(`request ${id} does not exist`);
        }
        io.stdout(formatHistoryDetail(record));
        return 0;
      });
    }
    case "export": {
      expectConfigArity(positionals, 1, "jev history export [filters]");
      const filters = parseHistoryFilters(values);
      return withRequestDatabase(values, io, (repository) => {
        for (const record of repository.list(filters)) {
          io.stdout(`${JSON.stringify(historyRecordToJson(record))}\n`);
        }
        return 0;
      });
    }
    default:
      throw new UsageError(
        `unknown history command: ${JSON.stringify(action)}`,
      );
  }
}

function parseHistoryFilters(values: Values): HistoryFilters {
  const filters: HistoryFilters = {};

  const since = asString(values.since);
  if (since !== undefined) {
    filters.since = since;
  }

  const status = asString(values.status);
  if (status !== undefined) {
    const code = Number(status);
    if (!Number.isInteger(code) || code < 100 || code > 599) {
      throw new UsageError("--status must be an HTTP status code (100-599)");
    }
    filters.status = code;
  }

  const model = asString(values.model);
  if (model !== undefined) {
    filters.model = model;
  }

  const template = asString(values.template);
  if (template !== undefined) {
    filters.template = template;
  }

  const batch = asString(values.batch);
  if (batch !== undefined) {
    filters.batch = batch;
  }

  const limit = asString(values.limit);
  if (limit !== undefined) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new UsageError("--limit must be an integer >= 0");
    }
    filters.limit = parsed;
  }

  return filters;
}

function parseHistoryId(value: string | undefined): number {
  const id = value === undefined ? NaN : Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new UsageError("the id must be a positive integer");
  }
  return id;
}

function withRequestDatabase<T>(
  values: Values,
  io: CliIO,
  action: (repository: RequestRepository) => T,
): T {
  const path = resolveDatabasePath(asString(values.db), envOf(io));
  const db = openDatabase(path);
  try {
    return action(new RequestRepository(db));
  } finally {
    db.close();
  }
}

function expectConfigArity(
  positionals: string[],
  expected: number,
  usage: string,
): void {
  if (positionals.length !== expected) {
    throw new UsageError(`usage: ${usage}`);
  }
}

function parseConfigKey(value: string | undefined): ConfigKey {
  if (value === undefined || !isConfigKey(value)) {
    throw new UsageError(
      `invalid key: ${JSON.stringify(value)} (use ${CONFIG_KEYS.join(", ")})`,
    );
  }
  return value;
}

async function runTemplate(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseOptions(args, TEMPLATE_OPTIONS);

  if (values.help === true) {
    io.stdout(TEMPLATE_USAGE);
    return 0;
  }

  const action = positionals[0];
  if (action === undefined) {
    throw new UsageError(
      "missing a template command (add, create, list, show, edit, delete, remove, validate or render)",
    );
  }

  switch (action) {
    case "add":
    case "create":
      return await templateAdd(values, positionals, io);
    case "list":
      return templateList(values, positionals, io);
    case "show":
      return templateShow(values, positionals, io);
    case "edit":
      return await templateEdit(values, positionals, io);
    case "delete":
      return await templateDelete(values, positionals, io);
    case "remove":
      return templateRemove(values, positionals, io);
    case "validate":
      return await templateValidate(values, positionals, io);
    case "render":
      return await templateRender(values, positionals, io);
    default:
      throw new UsageError(
        `unknown template command: ${JSON.stringify(action)}`,
      );
  }
}

function expectTemplateArity(
  positionals: string[],
  expected: number,
  usage: string,
): void {
  if (positionals.length !== expected) {
    throw new UsageError(`usage: ${usage}`);
  }
}

function templateName(positionals: string[]): string {
  const name = positionals[1] as string;
  if (name.trim() === "") {
    throw new UsageError("the template name cannot be empty");
  }
  return name;
}

/** Splits `<key>=<value>` keeping any `=` inside the value. */
function splitMacroFlag(
  raw: string,
  flag: string,
  valueLabel = "value",
): { name: string; value: string } {
  const separator = raw.indexOf("=");
  if (separator <= 0) {
    throw new UsageError(`${flag} expects <key>=<${valueLabel}>: ${JSON.stringify(raw)}`);
  }
  return {
    name: raw.slice(0, separator).trim(),
    value: raw.slice(separator + 1),
  };
}

/** Reads the repeatable `--macro-desc <key>=<text>`. */
function macroDescriptionsFlag(values: Values): TemplateMacro[] {
  return asStrings(values["macro-desc"]).map((raw) => {
    const { name, value } = splitMacroFlag(raw, "--macro-desc", "text");
    return { name, description: value };
  });
}

function clearedMacrosFlag(values: Values): string[] {
  return clearedMacroNames(values, "clear-macro-desc", "--clear-macro-desc");
}

function clearedMacroNames(values: Values, key: string, flag: string): string[] {
  return asStrings(values[key])
    .map((name) => name.trim())
    .filter((name) => {
      if (name === "") {
        throw new UsageError(`${flag} expects <key>`);
      }
      return true;
    });
}

/** Reads `--macro-schema <key>=<json>` and validates each schema. */
function macroSchemasFlag(values: Values): Array<{ name: string; schema: MacroSchema }> {
  return asStrings(values["macro-schema"]).map((raw) => {
    const { name, value } = splitMacroFlag(raw, "--macro-schema");
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new UsageError(
        `--macro-schema ${JSON.stringify(name)} is not valid JSON: ${messageOf(error)}`,
      );
    }
    try {
      return { name, schema: validateMacroSchema(parsed) };
    } catch (error) {
      if (error instanceof MacroSchemaError) {
        throw new UsageError(
          `--macro-schema ${JSON.stringify(name)}: ${error.message}`,
        );
      }
      throw error;
    }
  });
}

/** Reads `--macro-type <key>=<type>` as shorthand for `{"type":"<type>"}`. */
function macroTypesFlag(values: Values): Array<{ name: string; schema: MacroSchema }> {
  return asStrings(values["macro-type"]).map((raw) => {
    const { name, value } = splitMacroFlag(raw, "--macro-type");
    const type = value.trim();
    if (!(MACRO_SCHEMA_TYPES as readonly string[]).includes(type)) {
      throw new UsageError(
        `--macro-type ${JSON.stringify(name)} expects one of: ${MACRO_SCHEMA_TYPES.join(" | ")}`,
      );
    }
    return { name, schema: { type: type as MacroSchemaType } };
  });
}

/**
 * Merges the existing metadata with the macro flags. Returns `undefined` when
 * there are no flags so the repository keeps the current values.
 */
function mergeMacroFlags(
  values: Values,
  bodyJson: string,
  existing: TemplateMacro[] = [],
): TemplateMacro[] | undefined {
  const described = macroDescriptionsFlag(values);
  const clearedDescriptions = clearedMacrosFlag(values);
  const typed = macroTypesFlag(values);
  const schemas = macroSchemasFlag(values);
  const clearedSchemas = clearedMacroNames(values, "clear-macro-schema", "--clear-macro-schema");
  if (
    described.length === 0 &&
    clearedDescriptions.length === 0 &&
    typed.length === 0 &&
    schemas.length === 0 &&
    clearedSchemas.length === 0
  ) {
    return undefined;
  }

  const detected = new Set(detectMacros(bodyJson));
  const touched = [
    ...described.map((entry) => entry.name),
    ...clearedDescriptions,
    ...typed.map((entry) => entry.name),
    ...schemas.map((entry) => entry.name),
    ...clearedSchemas,
  ];
  for (const name of touched) {
    if (!detected.has(name)) {
      throw new UsageError(
        `macro ${JSON.stringify(name)} is not in the template body`,
      );
    }
  }

  const descriptions = new Map(
    existing.map((macro) => [macro.name, macro.description] as const),
  );
  const macroSchemas = new Map<string, MacroSchema | null>(
    existing.map((macro) => [macro.name, macro.schema ?? null] as const),
  );
  for (const entry of described) {
    descriptions.set(entry.name, entry.description);
  }
  for (const name of clearedDescriptions) {
    descriptions.set(name, "");
  }
  for (const entry of typed) {
    macroSchemas.set(entry.name, entry.schema);
  }
  for (const entry of schemas) {
    macroSchemas.set(entry.name, entry.schema);
  }
  for (const name of clearedSchemas) {
    macroSchemas.set(name, null);
  }
  return detectMacros(bodyJson).map((name) => ({
    name,
    description: descriptions.get(name) ?? "",
    schema: macroSchemas.get(name) ?? null,
  }));
}

async function templateAdd(
  values: Values,
  positionals: string[],
  io: CliIO,
): Promise<number> {
  expectTemplateArity(
    positionals,
    2,
    "jev template add <name> [--description <text>] (--body <json> | --body-file <path>) [--macro-desc <key>=<text>]... [--macro-schema <key>=<json>]... [--macro-type <key>=<type>]...",
  );
  const name = templateName(positionals);
  const raw = await readTemplateBodyInput(values, io);
  validateTemplateBody(raw);
  const description = asString(values.description) ?? "";
  const macros = mergeMacroFlags(values, raw);
  return withTemplates(values, io, (repository) => {
    repository.save(name, description, raw, macros);
    io.stdout(`template saved: ${name}\n`);
    return 0;
  });
}

function templateList(
  values: Values,
  positionals: string[],
  io: CliIO,
): number {
  expectTemplateArity(positionals, 1, "jev template list [--json]");
  return withTemplates(values, io, (repository) => {
    const templates = repository.list();
    if (values.json === true) {
      io.stdout(
        `${JSON.stringify(
          templates.map(({ name, description, created_at, updated_at, macros }) => ({
            name,
            description,
            created_at,
            updated_at,
            macros,
          })),
          null,
          2,
        )}\n`,
      );
    } else {
      for (const template of templates) {
        const suffix = template.description
          ? ` - ${template.description}`
          : "";
        io.stdout(`${template.name}${suffix}\n`);
      }
    }
    return 0;
  });
}

function templateShow(
  values: Values,
  positionals: string[],
  io: CliIO,
): number {
  expectTemplateArity(positionals, 2, "jev template show <name> [--json]");
  const name = templateName(positionals);
  return withTemplates(values, io, (repository) => {
    const template = repository.get(name);
    if (template === undefined) {
      throw new Error(`template not found: ${name}`);
    }
    if (values.json === true) {
      const body = safeParseJson(template.body_json);
      io.stdout(
        `${JSON.stringify(
          {
            name: template.name,
            description: template.description,
            body,
            macros: template.macros,
            created_at: template.created_at,
            updated_at: template.updated_at,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      io.stdout(`${prettyJson(template.body_json)}\n`);
      if (template.macros.length > 0) {
        io.stdout("\nMacros:\n");
        for (const macro of template.macros) {
          io.stdout(`  {{${macro.name}}}\n`);
          io.stdout(`    ${macro.description || "(no description)"}\n`);
          if (macro.schema !== undefined && macro.schema !== null) {
            io.stdout(`    schema: ${JSON.stringify(macro.schema)}\n`);
          }
        }
      }
    }
    return 0;
  });
}

async function templateDelete(
  values: Values,
  positionals: string[],
  io: CliIO,
): Promise<number> {
  expectTemplateArity(positionals, 2, "jev template delete <name> [--yes]");
  const name = templateName(positionals);
  if (values.yes !== true && !(await confirm(io, `Delete template ${name}? [y/N] `))) {
    io.stdout("cancelled\n");
    return 0;
  }
  return withTemplates(values, io, (repository) => {
    if (!repository.remove(name)) {
      throw new Error(`template not found: ${name}`);
    }
    io.stdout(`template deleted: ${name}\n`);
    return 0;
  });
}

function templateRemove(
  values: Values,
  positionals: string[],
  io: CliIO,
): number {
  expectTemplateArity(positionals, 2, "jev template remove <name>");
  const name = templateName(positionals);
  return withTemplates(values, io, (repository) => {
    if (!repository.remove(name)) {
      throw new Error(`template not found: ${name}`);
    }
    io.stdout(`template deleted: ${name}\n`);
    return 0;
  });
}

async function templateEdit(
  values: Values,
  positionals: string[],
  io: CliIO,
): Promise<number> {
  expectTemplateArity(
    positionals,
    2,
    "jev template edit <name> (--file <path> | uses $EDITOR) [--description <text>] [--macro-desc <key>=<text>]... [--clear-macro-desc <key>]... [--macro-schema <key>=<json>]... [--macro-type <key>=<type>]... [--clear-macro-schema <key>]...",
  );
  const name = templateName(positionals);
  const file = asString(values.file);
  const description = asString(values.description);

  const existing = withTemplates(values, io, (repository) =>
    repository.get(name),
  );
  if (existing === undefined) {
    throw new Error(`template not found: ${name}`);
  }

  const raw = await (async () => {
    if (file !== undefined) {
      const content = await readTemplateBodyInput(values, io);
      return content;
    }
    if (io.openInEditor === undefined) {
      throw new Error(
        "$EDITOR is not set. Set EDITOR/VISUAL or use --file <path>.",
      );
    }
    const path = join(
      tmpdir(),
      `jev-template-${name}-${process.pid}-${Date.now()}.json`,
    );
    await writeFile(path, existing.body_json, "utf8");
    try {
      return await io.openInEditor(path, existing.body_json);
    } finally {
      await rmTemplateFile(path);
    }
  })();

  validateTemplateBody(raw);
  const finalDescription = description ?? existing.description;
  const macros = mergeMacroFlags(values, raw, existing.macros);
  withTemplates(values, io, (repository) => {
    repository.save(name, finalDescription, raw, macros);
  });
  io.stdout(`template saved: ${name}\n`);
  return 0;
}

async function templateValidate(
  values: Values,
  positionals: string[],
  io: CliIO,
): Promise<number> {
  const file = asString(values.file);
  let name: string | undefined;
  if (file === undefined) {
    expectTemplateArity(
      positionals,
      2,
      "jev template validate <name> [--db <path>]",
    );
    name = templateName(positionals);
  } else {
    expectTemplateArity(positionals, 1, "jev template validate --file <path>");
  }

  const raw =
    name === undefined
      ? await readTemplateBodyInput(values, io)
      : withTemplates(values, io, (repository) => repository.get(name)?.body_json);
  if (raw === undefined) {
    throw new Error(`template not found: ${name}`);
  }

  validateTemplateBody(raw);
  const label = name ?? file;
  io.stdout(`template valid: ${label}\n`);
  return 0;
}

async function readTemplateBodyInput(
  values: Values,
  io: CliIO,
): Promise<string> {
  const raw = await readInput(
    asString(values.body),
    asString(values.file) ?? asString(values["body-file"]),
    io,
  );
  if (raw === undefined || raw.trim() === "") {
    throw new Error("missing the template body (--body or --file)");
  }
  return raw;
}

async function rmTemplateFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

async function templateRender(
  values: Values,
  positionals: string[],
  io: CliIO,
): Promise<number> {
  expectTemplateArity(
    positionals,
    2,
    "jev template render <name> (--context <json> | --context-file <path>)",
  );
  const name = templateName(positionals);
  const context = parseContext(
    await readInput(
      asString(values.context),
      asString(values["context-file"]),
      io,
    ),
  );
  return withTemplates(values, io, (repository) => {
    const template = repository.get(name);
    if (template === undefined) {
      throw new Error(`template not found: ${name}`);
    }
    const request = resolveTemplateBody(template.body_json, context);
    io.stdout(`${JSON.stringify(request, null, 2)}\n`);
    return 0;
  });
}

function parseContext(raw: string | undefined): TemplateContext {
  if (raw === undefined || raw.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in the context: ${messageOf(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the context must be a JSON object");
  }
  return parsed as TemplateContext;
}

function withTemplates<T>(
  values: Values,
  io: CliIO,
  action: (repository: TemplateRepository) => T,
): T {
  const path = resolveDatabasePath(asString(values.db), envOf(io));
  const db = openDatabase(path);
  try {
    return action(new TemplateRepository(db));
  } finally {
    db.close();
  }
}

function prettyJson(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function safeParseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

async function confirm(io: CliIO, prompt: string): Promise<boolean> {
  if (io.confirm === undefined) {
    return false;
  }
  return io.confirm(prompt);
}

function parseOptions(
  args: string[],
  options: ParseArgsOptions,
): { values: Values; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({
      args,
      options,
      allowPositionals: true,
      strict: true,
    });
    return { values: values as Values, positionals };
  } catch (error) {
    throw new UsageError(messageOf(error));
  }
}

function readCommonOptions(values: Values, io: CliIO): CommonOptions {
  const timeout = asString(values.timeout);
  const timeoutSeconds = timeout === undefined ? undefined : Number(timeout);
  if (
    timeoutSeconds !== undefined &&
    (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
  ) {
    throw new UsageError("--timeout must be a positive number of seconds");
  }

  const retriesValue = asString(values.retries);
  const retries = retriesValue === undefined ? undefined : Number(retriesValue);
  if (retries !== undefined && (!Number.isInteger(retries) || retries < 0)) {
    throw new UsageError("--retries must be an integer >= 0");
  }

  const stored = withDatabase(values, io, (repository) => {
    const entries = repository.list();
    const config: StoredConfig = {};
    for (const { key, value } of entries) {
      config[key] = value;
    }
    return config;
  });
  const model = asString(values.model);

  return {
    config: resolveConfig(
      {
        key: asString(values.key),
        url: asString(values.url),
        model,
        timeoutMs:
          timeoutSeconds === undefined
            ? undefined
            : Math.round(timeoutSeconds * 1000),
        retries,
      },
      envOf(io),
      stored,
    ),
    model,
    storedModel: stored.model,
    json: values.json === true,
  };
}

function withDatabase<T>(
  values: Values,
  io: CliIO,
  action: (repository: ConfigRepository, path: string) => T,
): T {
  const path = resolveDatabasePath(asString(values.db), envOf(io));
  const db = openDatabase(path);
  try {
    return action(new ConfigRepository(db), path);
  } finally {
    db.close();
  }
}

function createService(values: Values, io: CliIO): JevService {
  const timeout = asString(values.timeout);
  const retries = asString(values.retries);
  return new JevService({
    flags: {
      key: asString(values.key),
      url: asString(values.url),
      model: asString(values.model),
      timeoutMs: timeout === undefined ? undefined : Math.round(Number(timeout) * 1000),
      retries: retries === undefined ? undefined : Number(retries),
    },
    env: envOf(io),
    dbPath: resolveDatabasePath(asString(values.db), envOf(io)),
    fetch: io.fetch,
  });
}

/** Was any typed flag (--noul/--choice/--score/--option/--level) used? */
function hasTypedQuestionFlags(values: Values): boolean {
  return (
    asStrings(values.noul).length > 0 ||
    asStrings(values.choice).length > 0 ||
    asStrings(values.score).length > 0 ||
    asStrings(values.option).length > 0 ||
    asStrings(values.level).length > 0
  );
}

/** Splits `<question>.<option>=<description>` from an `--option`. */
function splitOptionFlag(
  raw: string,
): { question: string; option: string; value: string } {
  const { name, value } = splitMacroFlag(raw, "--option", "description");
  const dot = name.indexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    throw new UsageError(
      `--option expects <question>.<option>=<description>: ${JSON.stringify(raw)}`,
    );
  }
  const question = name.slice(0, dot);
  const option = name.slice(dot + 1);
  if (option.includes(".")) {
    throw new UsageError(
      `--option: the option cannot contain '.': ${JSON.stringify(raw)}`,
    );
  }
  return { question, option, value };
}

/**
 * Builds the `questions` from the typed flags `--noul`, `--choice`, `--score`,
 * `--option` and `--level`. Translates the console input into the JSON request
 * the client already understands, validating shape errors locally.
 */
export function buildQuestionsFromFlags(
  values: Values,
): Record<string, Question> {
  const questions: Record<string, Question> = {};

  const register = (
    kind: "noul" | "choice" | "score",
    raw: string,
    flag: string,
  ): void => {
    const { name, value } = splitMacroFlag(raw, flag, "instruction");
    if (Object.prototype.hasOwnProperty.call(questions, name)) {
      throw new UsageError(
        `duplicate key: ${JSON.stringify(name)} (--noul/--choice/--score)`,
      );
    }
    if (kind === "noul") {
      questions[name] = { type: "noul", instructions: value };
    } else if (kind === "choice") {
      questions[name] = { type: "choice", instructions: value, criteria: {} };
    } else {
      questions[name] = { type: "score", instructions: value, criteria: [] };
    }
  };

  for (const raw of asStrings(values.noul)) {
    register("noul", raw, "--noul");
  }
  for (const raw of asStrings(values.choice)) {
    register("choice", raw, "--choice");
  }
  for (const raw of asStrings(values.score)) {
    register("score", raw, "--score");
  }

  for (const raw of asStrings(values.option)) {
    const { question, option, value } = splitOptionFlag(raw);
    const target = questions[question];
    if (target === undefined || target.type !== "choice") {
      throw new UsageError(
        `--option ${JSON.stringify(question + "." + option)}: ` +
          `question ${JSON.stringify(question)} is not a --choice`,
      );
    }
    const criteria = target.criteria as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(criteria, option)) {
      throw new UsageError(`duplicate option: ${JSON.stringify(question + "." + option)}`);
    }
    criteria[option] = value;
  }

  for (const raw of asStrings(values.level)) {
    const { name, value } = splitMacroFlag(raw, "--level", "level");
    const target = questions[name];
    if (target === undefined || target.type !== "score") {
      throw new UsageError(
        `--level ${JSON.stringify(name)}: question ${JSON.stringify(name)} is not a --score`,
      );
    }
    (target.criteria as unknown[]).push(value);
  }

  for (const [name, question] of Object.entries(questions)) {
    if (question.type === "choice") {
      if (Object.keys(question.criteria as Record<string, unknown>).length === 0) {
        throw new UsageError(
          `--choice ${JSON.stringify(name)} needs at least one --option ` +
            `${JSON.stringify(name)}.<option>=<description>`,
        );
      }
    } else if (question.type === "score") {
      if ((question.criteria as unknown[]).length === 0) {
        throw new UsageError(
          `--score ${JSON.stringify(name)} needs at least one --level ` +
            `${JSON.stringify(name)}=<level>`,
        );
      }
    }
  }

  return questions;
}

async function buildRequest(
  values: Values,
  options: CommonOptions,
  io: CliIO,
): Promise<JevRequest> {
  const requestInline = asString(values.request);
  const requestFile = asString(values["request-file"]);
  const flagAssets = await buildAssets(values, io);

  if (hasTypedQuestionFlags(values)) {
    if (
      requestInline !== undefined ||
      requestFile !== undefined ||
      asString(values.questions) !== undefined ||
      asString(values["questions-file"]) !== undefined
    ) {
      throw new UsageError(
        "--noul/--choice/--score do not combine with --questions, --questions-file, --request or --request-file",
      );
    }
    const stateRaw = await readInput(
      asString(values.state),
      asString(values["state-file"]),
      io,
    );
    if (stateRaw === undefined || stateRaw.trim() === "") {
      throw new Error("the state is empty");
    }
    return mergeAssets(
      {
        model: resolveModel(options.model, undefined, envOf(io), options.storedModel),
        state: decodeState(stateRaw),
        questions: buildQuestionsFromFlags(values),
      },
      flagAssets,
    );
  }

  if (requestInline !== undefined || requestFile !== undefined) {
    const raw = await readInput(requestInline, requestFile, io);
    if (raw === undefined) {
      throw new Error("the request is empty");
    }
    return mergeAssets(buildRequestFromPayload(raw, options, io), flagAssets);
  }

  const stateRaw = await readInput(
    asString(values.state),
    asString(values["state-file"]),
    io,
  );
  if (stateRaw === undefined || stateRaw.trim() === "") {
    throw new Error("the state is empty");
  }

  const questionsRaw = await readInput(
    asString(values.questions),
    asString(values["questions-file"]),
    io,
  );
  if (questionsRaw === undefined || questionsRaw.trim() === "") {
    throw new Error("missing --questions or --questions-file");
  }

  return mergeAssets(
    {
      model: resolveModel(options.model, undefined, envOf(io), options.storedModel),
      state: decodeState(stateRaw),
      questions: decodeQuestions(questionsRaw),
    },
    flagAssets,
  );
}

function mergeAssets(
  request: JevRequest,
  assets: Record<string, ImageAsset> | undefined,
): JevRequest {
  if (assets === undefined || Object.keys(assets).length === 0) {
    return request;
  }
  return { ...request, assets: { ...(request.assets ?? {}), ...assets } };
}

/** Splits `--asset [<ref>=]<path>` keeping `=` inside the path. */
function splitAssetFlag(raw: string): { ref: string | undefined; path: string } {
  const separator = raw.indexOf("=");
  if (separator <= 0) {
    return { ref: undefined, path: raw };
  }
  return { ref: raw.slice(0, separator).trim(), path: raw.slice(separator + 1) };
}

/** Loads the images from `--asset` and `--assets-file`; validates limits. */
async function buildAssets(
  values: Values,
  io: CliIO,
): Promise<Record<string, ImageAsset> | undefined> {
  const assets: Record<string, ImageAsset> = {};

  for (const raw of asStrings(values.asset)) {
    const { ref, path } = splitAssetFlag(raw);
    const loaded = await loadImageAsset(path, ref);
    assets[loaded.ref] = loaded.asset;
  }

  const assetsFile = asString(values["assets-file"]);
  if (assetsFile !== undefined) {
    const raw = await readInput(undefined, assetsFile, io);
    if (raw === undefined || raw.trim() === "") {
      throw new Error("--assets-file is empty");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`invalid JSON in --assets-file: ${messageOf(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--assets-file must be a JSON object { ref: asset }");
    }
    for (const [ref, value] of Object.entries(parsed as Record<string, unknown>)) {
      assets[ref] = await resolveAssetEntry(ref, value);
    }
  }

  return Object.keys(assets).length === 0 ? undefined : assets;
}

/** Resolves an entry of the `assets` map (path, data_base64 or full asset). */
async function resolveAssetEntry(ref: string, value: unknown): Promise<ImageAsset> {
  if (typeof value === "string") {
    return (await loadImageAsset(value, ref)).asset;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`asset ${JSON.stringify(ref)} must be a path or an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.path === "string") {
    const loaded = await loadImageAsset(record.path, ref);
    return loaded.asset;
  }
  return validateImageAsset(ref, record as unknown as ImageAsset);
}

function buildRequestFromPayload(
  raw: string,
  options: CommonOptions,
  io: CliIO,
): JevRequest {
  if (raw.trim() === "") {
    throw new Error("the request is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in the request: ${messageOf(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the request must be a JSON object");
  }

  const request = parsed as Partial<JevRequest>;
  if (
    !request.questions ||
    typeof request.questions !== "object" ||
    Object.keys(request.questions).length === 0
  ) {
    throw new Error("the request has no questions");
  }
  if (request.state === undefined) {
    throw new Error("the request has no state");
  }

  return {
    model: resolveModel(
      options.model,
      request.model,
      envOf(io),
      options.storedModel,
    ),
    state: request.state,
    questions: request.questions,
  };
}

async function readInput(
  inline: string | undefined,
  file: string | undefined,
  io: CliIO,
): Promise<string | undefined> {
  if (inline !== undefined && file !== undefined) {
    throw new UsageError("use the inline flag or the -file flag, not both");
  }
  if (inline === "-" || file === "-") {
    return io.readStdin();
  }
  if (file !== undefined) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      throw new Error(`could not read ${file}: ${messageOf(error)}`);
    }
  }
  return inline;
}

/** The state can be plain text or JSON (object/array). */
export function decodeState(raw: string): State {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as State;
    } catch (error) {
      throw new Error(`invalid JSON in the state: ${messageOf(error)}`);
    }
  }
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

export function decodeQuestions(raw: string): Record<string, Question> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in the questions: ${messageOf(error)}`);
  }
  return validateQuestions(parsed);
}

function writeResponse(
  io: CliIO,
  response: JevResponse,
  asJson: boolean,
): void {
  if (asJson) {
    io.stdout(`${JSON.stringify(response.raw, null, 2)}\n`);
  } else {
    io.stdout(formatReport(response));
  }

  const cost =
    response.usage.cost === undefined
      ? ""
      : `, cost=${formatCost(response.usage.cost)}`;
  io.stderr(
    `tokens: ${response.usage.input_tokens} in / ` +
      `${response.usage.output_tokens} out${cost}\n`,
  );
}

function printError(stderr: (text: string) => void, error: unknown): void {
  stderr(`error: ${messageOf(error)}\n`);

  if (!(error instanceof JevApiError)) {
    return;
  }

  const hint = jevErrorHint(error);
  if (hint !== undefined) {
    stderr(`hint: ${hint}\n`);
  }
}

function envOf(io: CliIO): NodeJS.ProcessEnv {
  return io.env ?? process.env;
}

function asString(value: string | string[] | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStrings(value: string | string[] | boolean | undefined): string[] {
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
