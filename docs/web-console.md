# Local web console

The web console is an interface over the same domain as the CLI and the TUI: it
uses **Next.js 16.4.3 + React 19.3.1**, the App Router and route handlers as a
local BFF. It does not replace `jev tui` and requires no account and no
telemetry.

```sh
jev web-console
jev --web-console                 # alias with the same flags
jev web-console --port 0 --no-open
```

On startup it migrates the same SQLite database, waits for `GET /api/health`,
prints URL, database, version, schema, PID and mode, and stays in the foreground.
`Ctrl-C`/`SIGTERM` closes the child and frees the port with exit code `0`. A busy
port or a missing build produces an explicit error; it never silently picks
another fixed port.

## Flags

| Flag | Default | Description |
| --- | --- | --- |
| `--port <n>` | `7411` | Listening port; `0` picks a free one. |
| `--host <addr>` | `127.0.0.1` | Loopback unless explicitly decided otherwise. |
| `--allow-remote` | off | Required for LAN/`0.0.0.0`; keeps the token and the security warning. |
| `--open` / `--no-open` | open with a TTY | Does not open with CI/SSH; `--no-open` is headless-friendly. |
| `--dev` | off | Uses `next dev` from the checkout, not from an installed package. |
| `--db <path>` | `JEV_DB` / usual path | Database shared with the other commands. |
| `--key`, `--url`, `--model` | — | Session flags; highest priority and not persisted. |
| `--timeout`, `--retries` | — | Seconds and retries for this session. |
| `-h`, `--help` | — | Console-specific help. |

`JEV_CONSOLE_DIR` lets you point to the standalone directory or, with `--dev`,
to the web checkout.

## Screens

- **Overview**: real metrics from `requests`, latest requests, provider
  precedence and a minimal real connection test (`state: "ping"`, `--no-save`).
- **Evaluate**: `noul`, `choice` and `score`, strict text/JSON state, real demo,
  `--no-save`, cancellation, probability report and safe raw JSON. Responses
  follow the order of the questions in the request. The selector accepts the
  effective model, the two known models and a free value. Loading the ticket
  example keeps the configured model: the `model` in the example is only a
  fallback.
- **Templates**: search, create/edit/validate/render/rename/delete, nested and
  escaped macros, unsaved changes, transactional rename and a **Macros** tab with
  an optional description and JSON Schema per macro. Each row offers a basic type
  selector (including the Jev-only `image` type) and an advanced JSON editor
  (format, live validation and blocked saving if invalid), with the summary
  `N of M described · K typed`, atomic saving together with the body and a warning
  when removing a described macro or one with a schema. The metadata is persisted
  in `template_macros` (`description`, `schema_json`) and never sent to Jev.
  **New template** opens the **Start template** modal with valid examples of
  `noul`, `choice` and `score` (`src/template-starters.ts`); `noul` is
  preselected, `choice` uses `criteria` as an object of descriptions and `score`
  as an ordered array. The editor is free afterwards. The **Render** tab accepts
  optional assets (PNG/JPEG, like *Evaluate*) and resolves the macros into a
  request with the `{ ref: { data_base64, format } }` map attached — it never
  calls Jev.
- **Batches**: the context editor starts from a 2-space JSON skeleton containing
  one flat key per macro of the active template (order of `detectMacros`), ready
  to fill in. A **Table**/**JSON** toggle switches between a per-context table
  (one column per macro, with a per-row file picker for `image`-typed macros) and
  the raw JSON editor. When switching templates the skeleton is regenerated only
  if there were no edits; if there were, the text is kept and the action **Fill
  with the macros of <template>** appears (with confirmation). A **Template
  macros** dropdown shows `{{key}}` and its description when it exists, and values
  that are still empty ask for confirmation before running. **Shared assets**
  (optional) are attached to every request, while each context may carry its own
  `assets` map (merged over the shared one, item wins). Then: real pool of 1–10
  workers, NDJSON progress per item, `fail-fast`, `--no-save` and a server-side
  `batch_id`. Cancelling stops the scheduling **and aborts in-flight requests**,
  keeping the rows already written and marking the rest as skipped.
- **History**: `since/status/model/template/batch/limit` filters, detail by tabs
  and `application/x-ndjson` export using exactly `historyRecordToJson`. Filters
  live in the URL. Limit 1–200, with no additional cursor in this version.
- **Settings**: saves only modified keys, masks/reveals the key under an explicit
  action and shows `flag > environment > SQLite > default`. Fields fixed by a flag
  are read-only. **Reset performs `unset`**, it does not write defaults. An empty
  string is also equivalent to `unset`.

Each screen generates its **equivalent CLI** strip with POSIX quoting. The
`⌘K`/`Ctrl+K` palette, CLI reference, toasts, modals with trapped focus,
loading/empty/error/success states and the prototype breakpoints are included.
No secrets or drafts are stored in `localStorage`; URLs are only used for
filters/actions. Routes are in English: `/evaluate`, `/templates`, `/batches`,
`/history` and `/settings`.

## Local security

The printed URL contains a random bootstrap in the **fragment**, which does not
travel in HTTP requests. The browser exchanges it once for an
`HttpOnly; SameSite=Strict` cookie and an in-memory CSRF token. Mutations require
the cookie, `X-Jev-Console-Token` and `Origin`/`Host` validation; the API
requires the session again in every handler. `/api/health` is the only public
read and does not include secrets.

The key never appears in the initial HTML, listings, logs, URLs or
`localStorage`. Only `POST /api/config/api_key/reveal`, with CSRF and
`Cache-Control: no-store`, returns it. CSP with nonce/`strict-dynamic`,
`frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`,
body/context limits and parameterized SQLite queries are applied. Fonts, icons,
CSS and examples are served locally, without a CDN or external calls other than
Jev.

`--allow-remote` does not add accounts or multi-user authorization: it exposes a
local administration console to clients that have the initial URL. Use it only
on trusted networks.

## Documentation endpoints

The console publishes the same catalog used by MCP (they require a console
session):

- `GET /api/docs` — app document.
- `GET /api/docs/tools` and `GET /api/docs/tools/[name]` — catalog of tools.
- `GET /api/docs/mcp` — server configuration.
- `GET /api/docs/examples` — end-to-end examples.

## Console development

```sh
npm install
npm run build:web                 # tsc + next build + standalone
node dist/src/bin.js web-console --dev --no-open
```
