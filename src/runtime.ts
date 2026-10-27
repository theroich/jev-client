const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 13;

const MIN_NODE_LABEL = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`;

/**
 * Returns an error message when `version` is below the minimum supported Node,
 * or `null` when the runtime is supported.
 */
export function assertSupportedNode(version: string): string | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) {
    return `jev requires Node.js >= ${MIN_NODE_LABEL}; found ${version}.`;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)) {
    return null;
  }
  return `jev requires Node.js >= ${MIN_NODE_LABEL}; found ${version}.`;
}

/**
 * Silences the `ExperimentalWarning` that `node:sqlite` prints on Node 22/24.
 * Must run before `node:sqlite` is imported (the entry points import the CLI
 * lazily after calling this).
 */
export function silenceSqliteExperimentalWarning(): void {
  const original = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...args: unknown[]) {
    const message = typeof warning === "string" ? warning : warning.message;
    if (message.includes("SQLite is an experimental feature")) {
      return;
    }
    return original.apply(process, [warning, ...args] as never);
  };
}
