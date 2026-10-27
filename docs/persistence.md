# SQLite persistence

The database is created and migrated automatically on the first use of `ask`,
`demo` or `config`. It lives by default in `<OS-home>/.jev-client/db/jev.db`:
the home directory is obtained with `os.homedir()`, so it works on Linux, macOS
and Windows (`~/.jev-client/db/jev.db` on Unix,
`%USERPROFILE%\.jev-client\db\jev.db` on Windows).

It can be changed in `ask`, `demo` and `config` with `--db /path/jev.db` or
`JEV_DB=/path/jev.db`. When the directory and the file are created, restrictive
permissions are used (`0700` and `0600` on POSIX systems).

## Engine and migrations

**`better-sqlite3` 12.x** is used because it keeps the **Node.js 20 or higher**
requirement. Version 13 of the driver already requires Node 22, just like the
`node:sqlite` alternative, so the Node minimum is not raised.

Migrations are versioned with `PRAGMA user_version` (current version: **6**).
Each version is applied in a transaction, migrations are additive and idempotent
(`CREATE TABLE IF NOT EXISTS` and column checks in `ALTER TABLE`) and can be
reapplied without duplicating data. If a database is newer than this version
supports, `openDatabase` throws an error before touching anything.

## Schema

The database uses four tables.

### `config`

Key/value pairs of the persistent configuration.

| Column | Type | Notes |
| --- | --- | --- |
| `key` | `TEXT PRIMARY KEY` | `api_url`, `api_key`, `model`, `timeout`, `retries` |
| `value` | `TEXT NOT NULL` | always text; `timeout`/`retries` are validated as numbers |

### `templates`

JSON templates with macros.

| Column | Type | Notes |
| --- | --- | --- |
| `name` | `TEXT PRIMARY KEY` | template name |
| `description` | `TEXT NOT NULL DEFAULT ''` | optional description |
| `body_json` | `TEXT NOT NULL` | template body (with `{{key}}` macros) |
| `created_at` | `TEXT NOT NULL` | ISO 8601 |
| `updated_at` | `TEXT NOT NULL` | ISO 8601 |

### `template_macros`

Optional metadata (description and JSON Schema) for the macros of each template.
The body is still the single source of truth for **which** macros exist; this
table only contributes their meaning and their shape for humans and agents.

| Column | Type | Notes |
| --- | --- | --- |
| `template_name` | `TEXT NOT NULL` | FK to `templates.name` with `ON DELETE/UPDATE CASCADE` |
| `macro` | `TEXT NOT NULL` | full key, e.g. `customer.name` |
| `description` | `TEXT NOT NULL DEFAULT ''` | free text (max. 500), `''` if it was not described |
| `schema_json` | `TEXT` | compact JSON Schema (max. 8 KB) or `NULL` if there is none |
| `created_at` | `TEXT NOT NULL` | ISO 8601 |
| `updated_at` | `TEXT NOT NULL` | ISO 8601 |

The primary key is `(template_name, macro)`. On read, the repository merges
`detectMacros(body_json)` with the stored rows: every macro in the body appears
even if it has no row, and orphan rows are never returned. On save, the rows of
macros that are no longer in the body are deleted and existing descriptions and
schemas are kept unless they are passed explicitly.

The schema is informative: it can be a JSON Schema object or a boolean
(`true`/`false`), it is stored compactly and the API returns it parsed. It is
validated structurally (valid JSON, known `type`, non-empty `enum`, correct
`format` and `pattern`, numeric limits, `$ref` local only and a maximum of
8 KB), but it is not resolved or composed with that of parent/child paths.
Neither the description nor the schema **is sent to Jev** or alters rendering.

### `requests`

Request history: one row per run of `ask`, `demo` or per each request of a
`batch`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | request id |
| `created_at` | `TEXT NOT NULL` | ISO 8601 |
| `started_at` / `finished_at` | `TEXT` | start and end marks |
| `duration_ms` | `INTEGER` | duration in milliseconds |
| `endpoint` | `TEXT` | URL used |
| `model` | `TEXT` | model used |
| `status_code` | `INTEGER` | HTTP code (or `NULL`) |
| `ok` | `INTEGER NOT NULL` | `1` success, `0` failure |
| `request_json` | `TEXT` | payload sent (`model`, `state`, `questions`) |
| `response_json` | `TEXT` | raw body received |
| `input_tokens` / `output_tokens` | `INTEGER` | tokens, `NULL` if not reported |
| `cost` | `REAL` | cost, `NULL` if not reported |
| `error_code` / `error_message` | `TEXT` | error if the request failed |
| `template_name` / `batch_id` | `TEXT` | template and batch stamps |
| `source` | `TEXT NOT NULL DEFAULT 'cli'` | origin: `cli`, `tui`, `web` or `mcp` |

Indexes on `requests`: `idx_requests_created_at`, `idx_requests_model` and
`idx_requests_template_name`.

## What is NOT stored

The history does not persist headers (nor the `Authorization` header with the API
key): only the payload sent and the body returned by the API. To avoid keeping a
particular run, use `--no-save`.

With images, the history **never** stores `data_base64`: it is redacted to
`{ format, bytes, sha256 }`.

## Manual inspection

```sh
sqlite3 ~/.jev-client/db/jev.db '.schema'
sqlite3 ~/.jev-client/db/jev.db 'PRAGMA user_version;'
```
