# Development and tests

```sh
npm test                 # unit/contract tests for CLI, domain and route handlers
npm run typecheck        # strict TypeScript for src, test and web
npm run build:web        # Next production build + standalone
npm run test:e2e         # Playwright: flows, axe and responsive matrix
npm run test:package     # npm pack + install + package smoke test
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
push to `main` and on every pull request, runs on Node 20 and 22 the typecheck,
the unit/route tests, the Next build, the E2E with axe and a smoke test of the
installed package. The suite does not need a real API key or CI secrets.

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
