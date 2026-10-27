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

The distribution channel is the **npm registry**: `npm install -g jev-client`
(or `npx -y jev-client`) installs the CLI, the TUI, the MCP server, the web
console and the library in one step. The runtime floor is **Node.js 22.13**,
because `node:sqlite` is unflagged only from that version.

The package includes the **compiled standalone** in `dist/web-console` (no
checkout), its assets and the CommonJS server. The traced dependencies are
resolved from the normal npm dependencies (`next`, `react` and `react-dom`),
avoiding bundling `node_modules` inside the tarball. This
option was chosen over an optional package to keep the single-command UX.

The agreed threshold is **25 MiB compressed**; `npm run test:package` checks the
size, the installation with `npm pack`, startup, health, HTML, assets and a clean
shutdown, and refuses a tarball that ships local state (databases, `.env`,
`web/`, `node_modules`).

### Releases

`1.0.0` is published once with a short-lived granular `NPM_TOKEN` (a trusted
publisher cannot be configured before the package exists), which is revoked
right after. From then on npm **Trusted Publishing** is configured for
`.github/workflows/release.yml` (GitHub Actions, OIDC) and the workflow
publishes with `--provenance`, so every release carries a sigstore
attestation that links the tarball to a public commit. There is no long-lived
`NPM_TOKEN` in GitHub. Provenance requires the repository to be public and
`repository.url` to point at it.

The tag `v<version>` must match `package.json` and `src/version.ts`
(`scripts/check-version.mjs`); the release job refuses to republish a version
that already exists.

## Visual contract

The original visual contract is versioned in `design/`
(`jev-web-console.html`, handoff and manifest). The tokens were extracted into
`web/styles/tokens.css`; no framework theme or remote assets are used.
