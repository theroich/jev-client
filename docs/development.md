# Development and tests

## Checkout and build

Installing the published package does not need any of this. To work on the code:

```sh
git clone https://github.com/theroich/jev-client.git
cd jev-client
npm install          # runs `prepare`, which builds the console
npm run build        # tsc for src and test
npm run build:web    # tsc + next build + standalone
npm link             # optional: makes `jev` available on the PATH
jev demo
```

Without linking:

```sh
node dist/src/bin.js demo
npm start -- demo
npm run dev -- demo   # builds and runs
```

`npm ci` runs `prepare` too, so it builds the whole console and needs the dev
dependencies. Registry installs do not. `npx github:...` behaves the same way,
which is why it is not a supported install channel.

## Commands

```sh
npm test                 # unit/contract tests for CLI, domain and route handlers
npm run typecheck        # strict TypeScript for src, test and web
npm run build:web        # Next production build + standalone
npm run test:e2e         # Playwright: flows, axe and responsive matrix
npm run test:package     # npm pack + install + package smoke test
npm run check-version    # package.json vs src/version.ts
npm run check-node       # fails below the engines.node floor
```

The tests do not hit the API over the network: they use an injected `fetch` and
local HTTP servers to check headers, body, retries, errors, formatting, CLI, web
API and batch streaming. SQLite databases are created in temporary directories.
Playwright walks the six routes, inference with a mocked provider, CRUD, render,
batch, history/export, settings, palette, modals and axe; the 360–1920 px matrix
verifies overflow, tokens, breakpoints, local assets and a geometry/typography
regression computed directly against the exported HTML.

To install Chromium in the checkout without touching the global cache:

```sh
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
```

## CI

There is a GitHub Actions workflow (`.github/workflows/ci.yml`) that, on every
push to `main` and on every pull request, runs on Node 22, 24 and 26 the
typecheck, the unit/route tests, the Next build and the E2E with axe. A second
job runs `npm run test:package` on Ubuntu, macOS and Windows: the standalone
build and path handling differ per OS. The suite does not need a real API key or
CI secrets.

## Version and release

`package.json` and `src/version.ts` both hold the version; `npm run check-version`
fails when they diverge. It runs in `prepack`, in CI and in the release
workflow, which also requires the tag to be `v<version>`.

Releases are published from `.github/workflows/release.yml` when a `v*` tag is
pushed. The workflow tests, packs the exact tarball that will be published,
computes its SHA-256, publishes with npm provenance (OIDC, no long-lived
`NPM_TOKEN`) and creates the GitHub Release with the tarball and the checksum.
`1.0.0` is the exception: it is published once from the workflow with a
short-lived granular `NPM_TOKEN` secret (a trusted publisher cannot exist before
the package does). The token is revoked immediately after, then Trusted
Publishing is configured in npm for `release.yml`. From then on the workflow
needs no secret at all.

```sh
# Bump both files to the same version, then tag and push.
npm version patch --no-git-tag-version
$EDITOR src/version.ts          # VERSION = "1.0.1"
npm run check-version
git commit -am "chore(release): v1.0.1"
git tag v1.0.1 && git push origin v1.0.1
```

## Manual TUI checklist

The following cannot be fully automated (it depends on a real TTY) and is worth
reviewing by hand before publishing:

- [ ] `jev tui` opens the menu and `↑`/`↓` move the selection.
- [ ] In Templates, `n`/`e`/`d`/`/` respond and `q` returns to the menu; in the
      detail view `e`/`d`/`b`/`q` and in the provider view `q` also respond.
- [ ] Change `model` and `api_url` from the TUI and check that they persist with
      `jev config get model` and `jev config get api_url` in another run.
- [ ] The `api_key` is shown masked when queried and when edited; the full value
      is never visible.
- [ ] Create a template from the TUI and then see it with `jev template show`.
- [ ] Editing a template with invalid JSON shows the error and blocks saving;
      with valid JSON it shows the detected macros.
- [ ] Exiting with `Ctrl-C` in the middle of an edit asks for confirmation if
      there are changes.
- [ ] `echo "" | jev tui` prints the "requires a terminal" error and exits with
      code `1`; the terminal remains usable.
- [ ] Resizing the window does not corrupt the screen (every keystroke redraws).
