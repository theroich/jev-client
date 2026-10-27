# Architecture and packaging

## Shared layers

`src/service.ts` concentrates `ask`, `demo` and `batch`. The CLI, the TUI, the
web console and the MCP server share:

- the HTTP client (`src/client.ts`),
- configuration resolution (`src/config.ts`, `config-repository.ts`),
- the validators and types (`src/types.ts`, `src/template.ts`),
- the SQLite migrations and repositories (`src/database.ts`,
  `src/sqlite.ts`, `request-repository.ts`, `template-repository.ts`).

SQLite comes from Node's built-in `node:sqlite` (unflagged since 22.13.0)
behind the `src/sqlite.ts` adapter; the package ships no native code.

Next keeps a single lazy SQLite connection per process. Its Server Components
load DTOs without secrets; the Client Components do not import `node:*` or
`node:sqlite`.

## TUI without new dependencies

The TUI is implemented on top of `readline` and Node raw modes, instead of `ink`
or `blessed`:

- **No new dependencies**: `ink`
  drags React in and `blessed` is no longer maintained and uses native bindings.
- **Supports Node 22.13+** without problems; `blessed` and the `ink` ecosystem have
  been raising the minimum Node version.
- **Testable in CI**: the state machine (`TuiApp`) does not touch the terminal,
  so it is tested without a TTY; the raw driver stays isolated in `runTui`.

## npm packaging

The package includes the **compiled standalone** in `dist/web-console` (no
checkout), its assets and the CommonJS server. The traced dependencies are
resolved from the normal npm dependencies (`next`, `react` and `react-dom`),
avoiding bundling `node_modules` inside the tarball. This
option was chosen over an optional package to keep the single-command UX.

The agreed threshold is **25 MiB compressed**; `npm run test:package` checks the
size, the installation with `npm pack`, startup, health, HTML, assets and a clean
shutdown.

## Visual contract

The original visual contract is versioned in `design/`
(`jev-web-console.html`, handoff and manifest). The tokens were extracted into
`web/styles/tokens.css`; no framework theme or remote assets are used.
