export {
  JevClient,
  parseApiError,
  type ClientOptions,
  type FetchLike,
  type RunOptions,
} from "./client.js";
export { JevApiError, jevErrorHint } from "./errors.js";
export {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  firstNonEmpty,
  resolveConfig,
  resolveModel,
  type ConfigFlags,
  type ResolvedConfig,
  type StoredConfig,
} from "./config.js";
export {
  CONFIG_KEYS,
  ConfigRepository,
  isConfigKey,
  validateConfigValue,
  type ConfigEntry,
  type ConfigKey,
  type ConfigValues,
} from "./config-repository.js";
export {
  SCHEMA_VERSION,
  defaultDatabasePath,
  migrateDatabase,
  openDatabase,
  resolveDatabasePath,
  type SqliteDatabase,
} from "./database.js";
export {
  resolveJsonMacros,
  resolveStringMacros,
  resolveTemplateBody,
  detectMacros,
  validateQuestions,
  validateTemplateBody,
  validateTemplateRequest,
  type MacroResolution,
  type TemplateContext,
} from "./template.js";
export {
  MACRO_SCHEMA_TYPES,
  MAX_MACRO_DESCRIPTION_LENGTH,
  MAX_MACRO_SCHEMA_BYTES,
  MacroSchemaError,
  TemplateRepository,
  serializeMacroSchema,
  validateMacroSchema,
  type MacroSchema,
  type MacroSchemaErrorCode,
  type MacroSchemaType,
  type Template,
  type TemplateMacro,
} from "./template-repository.js";
export {
  createTemplateStarterBody,
  DEFAULT_TEMPLATE_STARTER,
  getTemplateStarter,
  TEMPLATE_STARTERS,
  type TemplateStarter,
  type TemplateStarterId,
} from "./template-starters.js";
export {
  answerSummary,
  formatCost,
  formatHistoryDetail,
  formatHistoryRecord,
  formatNumber,
  formatProbabilities,
  formatReport,
  historyRecordToJson,
  legendLevel,
  maskSecret,
} from "./format.js";
export {
  RequestRepository,
  type HistoryFacets,
  type HistoryFilters,
  type RequestRecord,
} from "./request-repository.js";
export {
  DEMO_STATE,
  JevService,
  MAX_CONCURRENCY,
  demoQuestions,
  type BatchEvent,
  type BatchExecutionOptions,
  type BatchItemResult,
  type BatchItemStatus,
  type BatchResult,
  type BatchSkipReason,
  type BatchSummary,
  type BatchUsage,
  type ExecutionOptions,
  type ExecutionResult,
  type JevServiceOptions,
} from "./service.js";
export type {
  Answer,
  JevRequest,
  JevResponse,
  Question,
  RequestLog,
  RequestSource,
  State,
  Usage,
} from "./types.js";
export { runCli, VERSION, type CliIO } from "./cli.js";
export {
  runWebConsoleCommand,
  WEB_CONSOLE_USAGE,
  type WebConsoleChild,
  type WebConsoleDependencies,
  type WebConsoleSignalTarget,
  type WebConsoleSpawn,
} from "./web-console.js";
export {
  TuiApp,
  createTuiBackend,
  keyToAction,
  runTui,
  type KeypressKey,
  type TuiAction,
  type TuiBackend,
} from "./tui.js";
