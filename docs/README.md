# Technical documentation

The [README](../README.md) explains **how to use** `jev-client`. This folder
holds the technical detail: how it is built, how it persists data and which
internal contracts it honors.

| Document | Content |
| --- | --- |
| [Architecture](architecture.md) | Layers, design decisions, packaging and publishing. |
| [Configuration](configuration.md) | Full precedence, flags, variables and secret handling. |
| [Persistence](persistence.md) | SQLite schema, migrations, permissions and what is stored. |
| [Question types](questions.md) | Contract of `noul`, `choice` and `score`, and what the model sees. |
| [Web console](web-console.md) | Flags, screens, security model and documentation endpoints. |
| [MCP server](mcp.md) | Catalog of tools, resources, prompt and configuration in agents. |
| [Images](images.md) | `assets` format, mandatory header, limits and pitfalls. |
| [Use as a library](library.md) | TypeScript API, client options and template utilities. |
| [Development](development.md) | Builds, tests, CI, E2E and manual TUI checklist. |
| [Troubleshooting](troubleshooting.md) | Startup errors, database, ports and quota. |

Per-command usage documentation is also available in
[`skills/jev-cli/`](../skills/jev-cli/SKILL.md).
