"use client";

import { Modal } from "./modal";

const COMMANDS: Array<[string, string]> = [
  ["jev ask", "--state/--state-file, --questions/--questions-file, --request/--request-file, --model, --key, --url, --db, --timeout, --retries, --no-save, --json"],
  ["jev demo", "--model, --key, --url, --db, --timeout, --retries, --no-save, --json"],
  ["jev config list", "--json, --db"],
  ["jev config get <key>", "--json, --reveal, --db"],
  ["jev config set <key> <value>", "api_url, api_key, model, timeout, retries; --db"],
  ["jev config unset <key>", "Deletes the SQLite value; --db"],
  ["jev config path", "Shows the active database; --db"],
  ["jev history list", "--since, --status, --model, --template, --batch, --limit, --db"],
  ["jev history show <id>", "Request detail; --db"],
  ["jev history export", "JSONL with the same filters as history list"],
  ["jev template list", "--json, --db; alias: templates"],
  ["jev template show <name>", "--json, --db"],
  ["jev template create <name>", "--description, --file/--body, --db"],
  ["jev template edit <name>", "--file, --description, --db"],
  ["jev template validate <name>", "Also --file to validate without saving"],
  ["jev template render <name>", "--context/--context-file, --db"],
  ["jev template delete <name>", "--yes to skip confirmation, --db"],
  ["jev batch <template>", "--contexts, --concurrency 1–10, --fail-fast/--continue-on-error, --no-save, --json and provider flags"],
  ["jev tui", "Terminal interface; --db"],
  ["jev web-console", "--port, --host, --allow-remote, --open/--no-open, --dev, --db and provider flags"],
  ["jev --web-console", "Alias of web-console with the same flags"],
  ["jev version / jev help", "Version and general help"],
];

export function CliReference({ onClose }: { onClose(): void }) {
  return (
    <Modal title="CLI reference" onClose={onClose}>
      <p className="hint">The console does not replace the CLI or the TUI: every action uses the same domain and the same SQLite database.</p>
      <div className="table-wrap">
        <table className="cli-table">
          <thead><tr><th>Command</th><th>Description and flags</th></tr></thead>
          <tbody>{COMMANDS.map(([command, description]) => <tr key={command}><td>{command}</td><td>{description}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="hint">Precedence: <code>flag &gt; environment &gt; SQLite &gt; default</code>. Exit codes: 0 success, 1 run error, 2 misuse.</p>
    </Modal>
  );
}
