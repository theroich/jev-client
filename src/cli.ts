import { readFile } from "node:fs/promises";
import { parseArgs, type ParseArgsConfig } from "node:util";

import { JevClient, type FetchLike } from "./client.js";
import { DEFAULT_ENDPOINT, DEFAULT_MODEL, resolveConfig, resolveModel } from "./config.js";
import { JevApiError } from "./errors.js";
import { formatCost, formatReport } from "./format.js";
import type { JevRequest, JevResponse, Question, State } from "./types.js";

export const VERSION = "1.0.0";

export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
  /** fetch inyectable (tests). */
  fetch?: FetchLike;
  /** Entorno (tests). Default: process.env. */
  env?: NodeJS.ProcessEnv;
}

const USAGE = `jev-client — CLI para la API de Jev (System One)

Uso:
  jev-client ask [flags]      evalúa un state contra una o más preguntas
  jev-client demo [flags]     ejecuta un ejemplo integrado
  jev-client version          muestra la versión
  jev-client help             muestra esta ayuda

Variables de entorno:
  OPENCODE_API_KEY (o JEV_API_KEY)  API key
  JEV_URL                           endpoint
  JEV_MODEL                         modelo

Precedencia: flag > variable de entorno > valor por defecto.
Endpoint por defecto: ${DEFAULT_ENDPOINT}
Modelo por defecto:   ${DEFAULT_MODEL}

Ejemplos:
  jev-client demo
  jev-client demo --json
  jev-client ask --state "Me han cobrado dos veces" \\
      --questions '{"billing":{"type":"noul","instructions":"¿Es de facturación?"}}'
  jev-client ask --state-file ticket.txt --questions-file preguntas.json
  jev-client ask --request-file request.json
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
  --timeout <segundos>     timeout de cada intento HTTP (default 30)
  --retries <n>            reintentos ante 429/5xx (default 2)
  --json                   imprime la respuesta cruda en JSON
  -h, --help               muestra esta ayuda
`;

const DEMO_USAGE = `Uso: jev-client demo [flags]

Flags:
  --key <clave>            API key (env: OPENCODE_API_KEY, JEV_API_KEY)
  --url <endpoint>         endpoint completo (env: JEV_URL)
  --model <modelo>         p. ej. jev-1.13 o jev-1.13-free (env: JEV_MODEL)
  --timeout <segundos>     timeout de cada intento HTTP (default 30)
  --retries <n>            reintentos ante 429/5xx (default 2)
  --json                   imprime la respuesta cruda en JSON
  -h, --help               muestra esta ayuda
`;

type ParseArgsOptions = NonNullable<ParseArgsConfig["options"]>;

const COMMON_OPTIONS = {
  key: { type: "string" },
  url: { type: "string" },
  model: { type: "string" },
  timeout: { type: "string" },
  retries: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
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
  key?: string | undefined;
  url?: string | undefined;
  model?: string | undefined;
  timeoutMs: number;
  retries: number;
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

  const options = readCommonOptions(values);
  const client = createClient(options, io);
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

  const options = readCommonOptions(values);
  const client = createClient(options, io);
  const response = await client.run({
    model: resolveModel(options.model, undefined, envOf(io)),
    state: DEMO_STATE,
    questions: demoQuestions(),
  });
  writeResponse(io, response, options.json);
  return 0;
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

function readCommonOptions(values: Values): CommonOptions {
  const timeoutSeconds =
    values.timeout === undefined ? 30 : Number(values.timeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new UsageError("--timeout debe ser un número positivo en segundos");
  }

  const retries = values.retries === undefined ? 2 : Number(values.retries);
  if (!Number.isInteger(retries) || retries < 0) {
    throw new UsageError("--retries debe ser un entero >= 0");
  }

  return {
    key: asString(values.key),
    url: asString(values.url),
    model: asString(values.model),
    timeoutMs: Math.round(timeoutSeconds * 1000),
    retries,
    json: values.json === true,
  };
}

function createClient(options: CommonOptions, io: CliIO): JevClient {
  const config = resolveConfig(
    { key: options.key, url: options.url, model: options.model },
    envOf(io),
  );
  if (!config.apiKey) {
    throw new Error(
      "falta la API key: usa --key o define OPENCODE_API_KEY (o JEV_API_KEY)",
    );
  }

  return new JevClient({
    apiKey: config.apiKey,
    endpoint: config.endpoint,
    model: config.model,
    timeoutMs: options.timeoutMs,
    maxRetries: options.retries,
    fetch: io.fetch,
  });
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
    model: resolveModel(options.model, undefined, envOf(io)),
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
    model: resolveModel(options.model, request.model, envOf(io)),
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("las preguntas deben ser un objeto JSON");
  }

  const questions = parsed as Record<string, Question>;
  if (Object.keys(questions).length === 0) {
    throw new Error("se necesita al menos una pregunta");
  }

  for (const [name, question] of Object.entries(questions)) {
    if (!question || typeof question.type !== "string" || question.type === "") {
      throw new Error(`la pregunta ${JSON.stringify(name)} no tiene type`);
    }
    if (!["noul", "choice", "score"].includes(question.type)) {
      throw new Error(
        `la pregunta ${JSON.stringify(name)} usa un tipo no soportado: ` +
          `${JSON.stringify(question.type)} (usa noul, choice o score)`,
      );
    }
  }

  return questions;
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
