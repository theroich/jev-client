"use client";

import { Modal } from "./modal";

const COMMANDS: Array<[string, string]> = [
  ["jev ask", "--state/--state-file, --questions/--questions-file, --request/--request-file, --model, --key, --url, --db, --timeout, --retries, --no-save, --json"],
  ["jev demo", "--model, --key, --url, --db, --timeout, --retries, --no-save, --json"],
  ["jev config list", "--json, --db"],
  ["jev config get <clave>", "--json, --reveal, --db"],
  ["jev config set <clave> <valor>", "api_url, api_key, model, timeout, retries; --db"],
  ["jev config unset <clave>", "Elimina el valor SQLite; --db"],
  ["jev config path", "Muestra la base activa; --db"],
  ["jev history list", "--since, --status, --model, --template, --batch, --limit, --db"],
  ["jev history show <id>", "Detalle de petición; --db"],
  ["jev history export", "JSONL con los mismos filtros que history list"],
  ["jev template list", "--json, --db; alias: templates"],
  ["jev template show <nombre>", "--json, --db"],
  ["jev template create <nombre>", "--description, --file/--body, --db"],
  ["jev template edit <nombre>", "--file, --description, --db"],
  ["jev template validate <nombre>", "También --file para validar sin guardar"],
  ["jev template render <nombre>", "--context/--context-file, --db"],
  ["jev template delete <nombre>", "--yes para omitir confirmación, --db"],
  ["jev batch <plantilla>", "--contexts, --concurrency 1–10, --fail-fast/--continue-on-error, --no-save, --json y flags del provider"],
  ["jev tui", "Interfaz de terminal; --db"],
  ["jev web-console", "--port, --host, --allow-remote, --open/--no-open, --dev, --db y flags del provider"],
  ["jev --web-console", "Alias de web-console con los mismos flags"],
  ["jev version / jev help", "Versión y ayuda general"],
];

export function CliReference({ onClose }: { onClose(): void }) {
  return (
    <Modal title="Referencia CLI" onClose={onClose}>
      <p className="hint">La consola no sustituye la CLI ni la TUI: cada acción usa el mismo dominio y la misma base SQLite.</p>
      <div className="table-wrap">
        <table className="cli-table">
          <thead><tr><th>Comando</th><th>Descripción y flags</th></tr></thead>
          <tbody>{COMMANDS.map(([command, description]) => <tr key={command}><td>{command}</td><td>{description}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="hint">Precedencia: <code>flag &gt; entorno &gt; SQLite &gt; defecto</code>. Salidas: 0 correcto, 1 error de ejecución, 2 uso incorrecto.</p>
    </Modal>
  );
}
