# MCP server

`jev-client` exposes the same logic as an **MCP server** (Model Context
Protocol) over stdio. An agent (OpenCode, Claude Desktop…) can discover
templates, read their macros, generate contexts, render and execute without a
human translating the CLI.

```sh
jev mcp                          # starts the server over stdio
jev-mcp                          # alias (binary)
jev mcp --read-only              # without creating/editing/deleting templates
jev mcp --no-execute             # without jev_ask/jev_batch or template tools
jev mcp --allow-destructive      # enables jev_template_delete
```

The server inherits the CLI configuration (`--db`, `--key`, `--url`, `--model`,
`--timeout`, `--retries` and the environment variables). If the API key is
missing it still starts: read tools work and execution tools return a structured
error. Nothing is written to stdout except JSON-RPC; logs go to stderr.

## Tools

There is a fixed catalog (prefix `jev_`) and, in addition, **one MCP tool per
saved template**: the tool name is the template name, its description is the
template description and each macro is an input parameter with its description
and its JSON Schema (`string` by default). A template named
`support-order` is invoked directly as the `support-order` tool with its macros
as arguments.

| Tool | Type | Description |
| --- | --- | --- |
| `jev_overview` | read | version, schema, database path, counters, API key (boolean) and tools |
| `jev_docs` | read | app documentation (`overview`, `tools`, `mcp`, `examples`) or documentation of a single tool |
| `jev_template_list` / `jev_template_get` | read | discover templates, body, macros, schemas and `toolName` |
| `jev_template_starters` / `jev_template_validate` | read | starters (`noul`, `choice`, `score`) and validation without calling Jev |
| `jev_template_render` | read | dry run: resolves macros without calling Jev |
| `jev_template_create` / `jev_template_update` | mutation | create/edit templates |
| `jev_template_delete` | destructive | delete (requires `confirm: true`; only with `--allow-destructive`) |
| `jev_ask` / `jev_batch` | execution | run against Jev; **always** saved in the history |
| `jev_history_list` / `jev_history_get` | read | history with filters and detail |
| `jev_config_get` | read | effective configuration with the API key masked |

`jev_ask`/`jev_batch` accept `assets` and `jev_image_check` validates an image
(format, dimensions, limits) without spending a call. See
[images](images.md).

**Every execution made through MCP is persisted in SQLite** with
`source = 'mcp'` (and `template_name`/`batch_id` when applicable). Reads are not
stored.

## Resources and prompt

- `jev://docs/overview`, `jev://docs/tools`, `jev://docs/examples`,
  `jev://docs/mcp` — machine-readable documentation.
- `jev://templates` and `jev://templates/{name}` — templates as resources.
- Prompt `generate-contexts` — guidance for producing an array of JSON contexts.

## Configuration in OpenCode

With the npm package installed globally:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "jev": { "type": "local", "command": ["jev", "mcp"] }
    }
  }
}
```

Without installing it globally, `npx` fetches it on demand:

```jsonc
{
  "mcp": {
    "servers": {
      "jev": { "type": "local", "command": ["npx", "-y", "jev-client", "mcp"] }
    }
  }
}
```

From a checkout, point at the built binary and, if you want to pin the database,
at `JEV_DB`:

```jsonc
{
  "mcp": {
    "servers": {
      "jev": {
        "type": "local",
        "command": ["node", "dist/src/mcp-bin.js"],
        "environment": { "JEV_DB": "/Users/me/.jev-client/db/jev.db" }
      }
    }
  }
}
```

Installing from GitHub (`npx -y -p github:theroich/jev-client jev-mcp`) is not a
supported channel: it runs `prepare`, so it builds the whole console and needs
the dev dependencies. Use the registry.
