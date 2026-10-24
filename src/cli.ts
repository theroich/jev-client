import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";

import { JevClient, type FetchLike } from "./client.js";
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
import { JevApiError } from "./errors.js";
import {
  formatCost,
  formatHistoryDetail,
  formatHistoryRecord,
  formatReport,
  historyRecordToJson,
} from "./format.js";
import {
  RequestRepository,
  type HistoryFilters,
} from "./request-repository.js";
import { TemplateRepository } from "./template-repository.js";
import {
  resolveTemplateBody,
  validateQuestions,
  validateTemplateBody,
  type TemplateContext,
} from "./template.js";
import type { JevRequest, JevResponse, Question, RequestLog, State } from "./types.js";

export const VERSION = "1.0.0";

export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
  /** fetch inyectable (tests). */
  fetch?: FetchLike;
  /** Entorno (tests). Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Confirmación interactiva (tests). Si no se define, las operaciones que
   * requieren confirmación tratan la respuesta como negativa.
   */
  confirm?(prompt: string): Promise<boolean>;
  /**
   * Abre un fichero con $EDITOR y devuelve su contenido editado. Si no se
   * define, `templates edit` solo acepta --file.
   */
  openInEditor?(filePath: string, initial: string): Promise<string>;
}

const USAGE = `jev-client — CLI para la API de Jev (System One)

Uso:
  jev-client ask [flags]      evalúa un state contra una o más preguntas
  jev-client demo [flags]     ejecuta un ejemplo integrado
  jev-client config <comando> gestiona la configuración persistente
  jev-client history <comando> consulta el historial de peticiones
  jev-client template <comando> gestiona plantillas JSON con macros
  jev-client templates <comando> alias de template
  jev-client version          muestra la versión
  jev-client help             muestra esta ayuda

Variables de entorno:
  OPENCODE_API_KEY (o JEV_API_KEY)  API key
  JEV_URL                           endpoint
  JEV_MODEL                         modelo
  JEV_DB                            ruta de la base SQLite

Precedencia: flag > variable de entorno > base de datos > valor por defecto.
Endpoint por defecto: ${DEFAULT_ENDPOINT}
Modelo por defecto:   ${DEFAULT_MODEL}
Base por defecto:     <home-del-SO>/.jev-client/db/jev.db

Ejemplos:
  jev-client demo
  jev-client demo --json
  jev-client ask --state "Me han cobrado dos veces" \\
      --questions '{"billing":{"type":"noul","instructions":"¿Es de facturación?"}}'
  jev-client ask --state-file ticket.txt --questions-file preguntas.json
  jev-client ask --request-file request.json
  jev-client config set model jev-1.13-free
  jev-client template render pedido --context '{"estado":"pendiente"}'
`;

const ASK_USAGE = `Uso: jev-client ask [flags]

Flags:
  --state <texto|json>     contenido a evaluar ('-' para stdin)
  --state-file <ruta>      fichero con el state ('-' para stdin)
  --questions <json>       preguntas en JSON ('-' para stdin)
  --questions-file <ruta>  fichero con las preguntas en JSON
  --request <json>         payload completo en JSON ('-' para stdin)
  --request-file <ruta>    fichero con el payload completo
  --key <clave>            API key (env: OPENCODE_API_KEY, JEV_API_KEY)
  --url <endpoint>         endpoint completo (env: JEV_URL)
  --model <modelo>         p. ej. jev-1.13 o jev-1.13-free (env: JEV_MODEL)
  --db <ruta>              base SQLite (env: JEV_DB)
  --timeout <segundos>     timeout de cada intento HTTP (default 30)
  --retries <n>            reintentos ante 429/5xx (default 2)
  --no-save                no registrar esta ejecución en el historial
  --json                   imprime la respuesta cruda en JSON
  -h, --help               muestra esta ayuda
`;

const DEMO_USAGE = `Uso: jev-client demo [flags]

Flags:
  --key <clave>            API key (env: OPENCODE_API_KEY, JEV_API_KEY)
  --url <endpoint>         endpoint completo (env: JEV_URL)
  --model <modelo>         p. ej. jev-1.13 o jev-1.13-free (env: JEV_MODEL)
  --db <ruta>              base SQLite (env: JEV_DB)
  --timeout <segundos>     timeout de cada intento HTTP (default 30)
  --retries <n>            reintentos ante 429/5xx (default 2)
  --no-save                no registrar esta ejecución en el historial
  --json                   imprime la respuesta cruda en JSON
  -h, --help               muestra esta ayuda
`;

const CONFIG_USAGE = `Uso:
  jev-client config list [--json] [--db <ruta>]
  jev-client config get <clave> [--json] [--reveal] [--db <ruta>]
  jev-client config set <clave> <valor> [--db <ruta>]
  jev-client config unset <clave> [--db <ruta>]
  jev-client config path [--db <ruta>]

Claves: api_url, api_key, model, timeout (segundos), retries.

'config get api_key' muestra la key enmascarada; usa --reveal para verla.
'config path' imprime la ruta de la base de datos que se está usando.

La API key se guarda en claro. Para no persistirla, usa --key o
OPENCODE_API_KEY/JEV_API_KEY en cada ejecución.
`;

const HISTORY_USAGE = `Uso:
  jev-client history list [filtros] [--db <ruta>]
  jev-client history show <id> [--db <ruta>]
  jev-client history export [filtros] [--db <ruta>]

Filtros (list y export):
  --since <ISO>            solo peticiones desde esta fecha (created_at)
  --status <código>        código HTTP (p. ej. 200, 429)
  --model <modelo>         modelo exacto
  --template <nombre>      nombre de plantilla
  --limit <n>              número máximo de resultados

Flags comunes:
  --db <ruta>              base SQLite (env: JEV_DB)
  -h, --help               muestra esta ayuda
`;

const TEMPLATE_USAGE = `Uso:
  jev-client template add <name> [--description <texto>] (--body <json> | --body-file <ruta>)
  jev-client template create <name> [--description <texto>] (--body <json> | --file <ruta>)
  jev-client template list [--json] [--db <ruta>]
  jev-client template show <name> [--json] [--db <ruta>]
  jev-client template edit <name> (--file <ruta> | usa $EDITOR) [--description <texto>] [--db <ruta>]
  jev-client template delete <name> [--yes] [--db <ruta>]
  jev-client template remove <name> [--db <ruta>]
  jev-client template validate <name> [--db <ruta>]
  jev-client template validate --file <ruta>
  jev-client template render <name> (--context <json> | --context-file <ruta>) [--db <ruta>]

El body de una plantilla es un request de Jev con macros {{clave}}, que
admiten rutas anidadas ({{cliente.nombre}}). 'render' resuelve las macros con
un contexto JSON y previsualiza el request sin enviarlo.
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
} satisfies ParseArgsOptions;

const ASK_OPTIONS = {
  ...COMMON_OPTIONS,
  state: { type: "string" },
  "state-file": { type: "string" },
  questions: { type: "string" },
  "questions-file": { type: "string" },
  request: { type: "string" },
  "request-file": { type: "string" },
} satisfies ParseArgsOptions;

interface CommonOptions {
  config: ReturnType<typeof resolveConfig>;
  model?: string | undefined;
  storedModel?: string | undefined;
  json: boolean;
}

type Values = Record<string, string | boolean | undefined>;

class UsageError extends Error {}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const command = argv[0];
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
        throw new UsageError(`comando desconocido: ${JSON.stringify(command)}`);
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
    throw new UsageError(`argumento inesperado: ${JSON.stringify(positionals[0])}`);
  }
  if (
    values.state === undefined &&
    values["state-file"] === undefined &&
    values.request === undefined &&
    values["request-file"] === undefined
  ) {
    throw new UsageError("falta --state, --state-file o --request-file");
  }

  const options = readCommonOptions(values, io);
  const client = createClient(options, io, createRecorder(values, io));
  const request = await buildRequest(values, options, io);
  const response = await client.run(request);
  writeResponse(io, response, options.json);
  return 0;
}

async function runDemo(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseOptions(args, COMMON_OPTIONS);

  if (values.help === true) {
    io.stdout(DEMO_USAGE);
    return 0;
  }
  if (positionals.length > 0) {
    throw new UsageError(`argumento inesperado: ${JSON.stringify(positionals[0])}`);
  }

  const options = readCommonOptions(values, io);
  const client = createClient(options, io, createRecorder(values, io));
  const response = await client.run({
    model: resolveModel(options.model, undefined, envOf(io), options.storedModel),
    state: DEMO_STATE,
    questions: demoQuestions(),
  });
  writeResponse(io, response, options.json);
  return 0;
}

function runConfig(args: string[], io: CliIO): number {
  const { values, positionals } = parseOptions(args, CONFIG_OPTIONS);
  if (values.help === true) {
    io.stdout(CONFIG_USAGE);
    return 0;
  }

  const action = positionals[0];
  if (action === undefined) {
    throw new UsageError("falta un comando de config (list, get, set o unset)");
  }

  switch (action) {
    case "list": {
      expectConfigArity(positionals, 1, "jev config list [--json] [--db <ruta>]");
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
      expectConfigArity(positionals, 2, "jev config get <clave> [--db <ruta>]");
      const key = parseConfigKey(positionals[1]);
      return withDatabase(values, io, (repository) => {
        const value = repository.get(key);
        if (value === undefined) {
          throw new Error(`configuración no definida: ${key}`);
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
        "jev config set <clave> <valor> [--db <ruta>]",
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
        io.stdout(`configuración guardada: ${key}\n`);
        if (key === "api_key") {
          io.stderr(
            `aviso: la API key se guarda en claro en ${path}. ` +
              "Para no persistirla, usa --key o OPENCODE_API_KEY/JEV_API_KEY.\n",
          );
        }
        return 0;
      });
    }
    case "unset": {
      expectConfigArity(
        positionals,
        2,
        "jev config unset <clave> [--db <ruta>]",
      );
      const key = parseConfigKey(positionals[1]);
      return withDatabase(values, io, (repository) => {
        repository.unset(key);
        io.stdout(`configuración eliminada: ${key}\n`);
        return 0;
      });
    }
    case "path": {
      expectConfigArity(positionals, 1, "jev config path [--db <ruta>]");
      const path = resolveDatabasePath(asString(values.db), envOf(io));
      io.stdout(`${path}\n`);
      return 0;
    }
    default:
      throw new UsageError(
        `comando de config desconocido: ${JSON.stringify(action)}`,
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
    throw new UsageError("falta un comando de history (list, show o export)");
  }

  switch (action) {
    case "list": {
      expectConfigArity(positionals, 1, "jev history list [filtros]");
      const filters = parseHistoryFilters(values);
      return withRequestDatabase(values, io, (repository) => {
        for (const record of repository.list(filters)) {
          io.stdout(`${formatHistoryRecord(record)}\n`);
        }
        return 0;
      });
    }
    case "show": {
      expectConfigArity(positionals, 2, "jev history show <id> [--db <ruta>]");
      const id = parseHistoryId(positionals[1]);
      return withRequestDatabase(values, io, (repository) => {
        const record = repository.get(id);
        if (record === undefined) {
          throw new Error(`no existe la petición ${id}`);
        }
        io.stdout(formatHistoryDetail(record));
        return 0;
      });
    }
    case "export": {
      expectConfigArity(positionals, 1, "jev history export [filtros]");
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
        `comando de history desconocido: ${JSON.stringify(action)}`,
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
      throw new UsageError("--status debe ser un código HTTP (100-599)");
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

  const limit = asString(values.limit);
  if (limit !== undefined) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new UsageError("--limit debe ser un entero >= 0");
    }
    filters.limit = parsed;
  }

  return filters;
}

function parseHistoryId(value: string | undefined): number {
  const id = value === undefined ? NaN : Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new UsageError("el id debe ser un entero positivo");
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
    throw new UsageError(`uso: ${usage}`);
  }
}

function parseConfigKey(value: string | undefined): ConfigKey {
  if (value === undefined || !isConfigKey(value)) {
    throw new UsageError(
      `clave inválida: ${JSON.stringify(value)} (usa ${CONFIG_KEYS.join(", ")})`,
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
      "falta un comando de template (add, create, list, show, edit, delete, remove, validate o render)",
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
        `comando de template desconocido: ${JSON.stringify(action)}`,
      );
  }
}

function expectTemplateArity(
  positionals: string[],
  expected: number,
  usage: string,
): void {
  if (positionals.length !== expected) {
    throw new UsageError(`uso: ${usage}`);
  }
}

function templateName(positionals: string[]): string {
  const name = positionals[1] as string;
  if (name.trim() === "") {
    throw new UsageError("el nombre de la plantilla no puede estar vacío");
  }
  return name;
}

async function templateAdd(
  values: Values,
  positionals: string[],
  io: CliIO,
): Promise<number> {
  expectTemplateArity(
    positionals,
    2,
    "jev template add <name> [--description <texto>] (--body <json> | --body-file <ruta>)",
  );
  const name = templateName(positionals);
  const raw = await readTemplateBodyInput(values, io);
  validateTemplateBody(raw);
  const description = asString(values.description) ?? "";
  return withTemplates(values, io, (repository) => {
    repository.save(name, description, raw);
    io.stdout(`plantilla guardada: ${name}\n`);
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
          templates.map(({ name, description, created_at, updated_at }) => ({
            name,
            description,
            created_at,
            updated_at,
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
      throw new Error(`plantilla no encontrada: ${name}`);
    }
    if (values.json === true) {
      const body = safeParseJson(template.body_json);
      io.stdout(
        `${JSON.stringify(
          {
            name: template.name,
            description: template.description,
            body,
            created_at: template.created_at,
            updated_at: template.updated_at,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      io.stdout(`${prettyJson(template.body_json)}\n`);
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
  if (values.yes !== true && !(await confirm(io, `¿Eliminar la plantilla ${name}? [s/N] `))) {
    io.stdout("cancelado\n");
    return 0;
  }
  return withTemplates(values, io, (repository) => {
    if (!repository.remove(name)) {
      throw new Error(`plantilla no encontrada: ${name}`);
    }
    io.stdout(`plantilla eliminada: ${name}\n`);
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
      throw new Error(`plantilla no encontrada: ${name}`);
    }
    io.stdout(`plantilla eliminada: ${name}\n`);
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
    "jev template edit <name> (--file <ruta> | usa $EDITOR)",
  );
  const name = templateName(positionals);
  const file = asString(values.file);
  const description = asString(values.description);

  const existing = withTemplates(values, io, (repository) =>
    repository.get(name),
  );
  if (existing === undefined) {
    throw new Error(`plantilla no encontrada: ${name}`);
  }

  const raw = await (async () => {
    if (file !== undefined) {
      const content = await readTemplateBodyInput(values, io);
      return content;
    }
    if (io.openInEditor === undefined) {
      throw new Error(
        "$EDITOR no está definido. Define EDITOR/VISUAL o usa --file <ruta>.",
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
  withTemplates(values, io, (repository) => {
    repository.save(name, finalDescription, raw);
  });
  io.stdout(`plantilla guardada: ${name}\n`);
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
      "jev template validate <name> [--db <ruta>]",
    );
    name = templateName(positionals);
  } else {
    expectTemplateArity(positionals, 1, "jev template validate --file <ruta>");
  }

  const raw =
    name === undefined
      ? await readTemplateBodyInput(values, io)
      : withTemplates(values, io, (repository) => repository.get(name)?.body_json);
  if (raw === undefined) {
    throw new Error(`plantilla no encontrada: ${name}`);
  }

  validateTemplateBody(raw);
  const label = name ?? file;
  io.stdout(`plantilla válida: ${label}\n`);
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
    throw new Error("falta el body de la plantilla (--body o --file)");
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
    "jev template render <name> (--context <json> | --context-file <ruta>)",
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
      throw new Error(`plantilla no encontrada: ${name}`);
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
    throw new Error(`JSON inválido en el contexto: ${messageOf(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("el contexto debe ser un objeto JSON");
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

/** Enmascara un secreto dejando visibles los primeros y últimos 4 caracteres. */
function maskSecret(value: string): string {
  if (value.length <= 8) {
    return "********";
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
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
    throw new UsageError("--timeout debe ser un número positivo en segundos");
  }

  const retriesValue = asString(values.retries);
  const retries = retriesValue === undefined ? undefined : Number(retriesValue);
  if (retries !== undefined && (!Number.isInteger(retries) || retries < 0)) {
    throw new UsageError("--retries debe ser un entero >= 0");
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

function createClient(
  options: CommonOptions,
  io: CliIO,
  onRequest?: (log: RequestLog) => void,
): JevClient {
  const { config } = options;
  if (!config.apiKey) {
    throw new Error(
      "falta la API key: usa --key, define OPENCODE_API_KEY (o JEV_API_KEY) " +
        "o guarda api_key con 'jev config set'",
    );
  }

  return new JevClient({
    apiKey: config.apiKey,
    endpoint: config.endpoint,
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxRetries: config.retries,
    fetch: io.fetch,
    onRequest,
  });
}

/**
 * Devuelve un hook que guarda cada ejecución en la base, salvo con --no-save.
 * Abre y cierra la base por petición para no mantener conexiones abiertas.
 */
function createRecorder(
  values: Values,
  io: CliIO,
): ((log: RequestLog) => void) | undefined {
  if (values["no-save"] === true) {
    return undefined;
  }
  const path = resolveDatabasePath(asString(values.db), envOf(io));
  return (log) => {
    const db = openDatabase(path);
    try {
      new RequestRepository(db).insert(log);
    } finally {
      db.close();
    }
  };
}

async function buildRequest(
  values: Values,
  options: CommonOptions,
  io: CliIO,
): Promise<JevRequest> {
  const requestInline = asString(values.request);
  const requestFile = asString(values["request-file"]);

  if (requestInline !== undefined || requestFile !== undefined) {
    const raw = await readInput(requestInline, requestFile, io);
    if (raw === undefined) {
      throw new Error("el request está vacío");
    }
    return buildRequestFromPayload(raw, options, io);
  }

  const stateRaw = await readInput(
    asString(values.state),
    asString(values["state-file"]),
    io,
  );
  if (stateRaw === undefined || stateRaw.trim() === "") {
    throw new Error("el state está vacío");
  }

  const questionsRaw = await readInput(
    asString(values.questions),
    asString(values["questions-file"]),
    io,
  );
  if (questionsRaw === undefined || questionsRaw.trim() === "") {
    throw new Error("faltan --questions o --questions-file");
  }

  return {
    model: resolveModel(options.model, undefined, envOf(io), options.storedModel),
    state: decodeState(stateRaw),
    questions: decodeQuestions(questionsRaw),
  };
}

function buildRequestFromPayload(
  raw: string,
  options: CommonOptions,
  io: CliIO,
): JevRequest {
  if (raw.trim() === "") {
    throw new Error("el request está vacío");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`JSON inválido en el request: ${messageOf(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("el request debe ser un objeto JSON");
  }

  const request = parsed as Partial<JevRequest>;
  if (
    !request.questions ||
    typeof request.questions !== "object" ||
    Object.keys(request.questions).length === 0
  ) {
    throw new Error("el request no tiene preguntas");
  }
  if (request.state === undefined) {
    throw new Error("el request no tiene state");
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
    throw new UsageError("usa el flag inline o el -file, no ambos");
  }
  if (inline === "-" || file === "-") {
    return io.readStdin();
  }
  if (file !== undefined) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      throw new Error(`no se pudo leer ${file}: ${messageOf(error)}`);
    }
  }
  return inline;
}

/** El state puede ser texto plano o JSON (objeto/array). */
export function decodeState(raw: string): State {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as State;
    } catch (error) {
      throw new Error(`JSON inválido en el state: ${messageOf(error)}`);
    }
  }
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

export function decodeQuestions(raw: string): Record<string, Question> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`JSON inválido en las preguntas: ${messageOf(error)}`);
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

  if (error.statusCode === 401 || error.code === "api_key_expired") {
    stderr(
      "pista: la API key no es válida o ha caducado. Crea una nueva en " +
        "https://opencode.ai/console y expórtala como OPENCODE_API_KEY.\n",
    );
  } else if (
    error.code === "FreeUsageLimitError" ||
    error.statusCode === 429
  ) {
    stderr(
      "pista: jev-1.13-free tiene límite de uso. Prueba con 'jev-1.13' " +
        "o revisa https://opencode.ai/go.\n",
    );
  } else if (
    error.code === "api_usage_error" ||
    error.code === "validation_error" ||
    error.statusCode === 422
  ) {
    stderr(
      "pista: un 422 suele ser una pregunta mal formada (falta criteria, " +
        "tipo inválido) o un fallo del upstream. Revisa " +
        "https://docs.typesafe.ai/primitives\n",
    );
  }
}

const DEMO_STATE =
  "Nuestro checkout lleva caído 30 minutos y cada minuto perdemos ventas. " +
  "Llevamos dos días sin respuesta de soporte. Necesitamos una solución ya.";

function demoQuestions(): Record<string, Question> {
  return {
    is_urgent: {
      type: "noul",
      instructions: "¿El mensaje transmite urgencia o presión de tiempo?",
    },
    team: {
      type: "choice",
      instructions: "¿Qué equipo debería gestionar la incidencia?",
      criteria: {
        billing: "Cobros, facturas o pagos",
        infra: "Caídas, errores 500 o problemas de plataforma",
        sales: "Precios o dudas comerciales",
      },
    },
    frustration: {
      type: "score",
      instructions: "¿Cómo de frustrado está el cliente?",
      criteria: ["Tranquilo", "Molesto pero correcto", "Muy enfadado"],
    },
  };
}

function envOf(io: CliIO): NodeJS.ProcessEnv {
  return io.env ?? process.env;
}

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
