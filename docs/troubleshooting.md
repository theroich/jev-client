# Troubleshooting

## Unsupported Node version

`jev` uses the built-in `node:sqlite` module (unflagged since Node 22.13.0), so
it needs **Node.js 22.13 or higher**. On an older runtime the CLI exits with
code `1` and:

```text
jev requires Node.js >= 22.13; found <version>.
```

Upgrade to Node 22 LTS, 24 LTS or 26 LTS. There is no native binary to rebuild,
so the previous `NODE_MODULE_VERSION` / `node-gyp` / Python failure modes no
longer apply.

npm may reject the install before the binary even runs:

```text
npm WARN EBADENGINE Unsupported engine { package: 'jev-client@1.0.0', required: { node: '>=22.13' }, current: { node: 'v20.x' } }
npm ERR! code EBADENGINE
```

`npm install -g` refuses by default; `npx` and `npm install --force` only warn
and then fail at runtime with the message above. Fix the Node version instead of
forcing the install. The build and publish scripts (`prepare`, `prepack`,
`prepublishOnly`) run the same check first, so `npm publish` on Node 20 stops
with this message instead of a wall of `node:sqlite` errors.

## `EACCES` on a global install

A Node installed by the system package manager usually writes to
`/usr/local/lib/node_modules`, which your user cannot write to:

```text
npm ERR! code EACCES
npm ERR! syscall mkdir
npm ERR! path /usr/local/lib/node_modules/jev-client
```

Pick one of these instead of using `sudo`:

- Use a version manager (nvm, fnm, asdf, volta) and install Node 22.13+ with it.
- Point npm at a user-owned prefix:

```sh
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"
npm install -g jev-client
```

- Or skip the global install entirely: `npx -y jev-client <command>`.

## SQLite schema mismatch

`the database uses schema N, but this version only supports up to M` means that
another (newer) version of `jev` wrote into `~/.jev-client/db/jev.db`. Isolate
the run in a temporary database:

```sh
jev ask --db "$(mktemp -d)/jev.db" …
# or: JEV_DB=/tmp/jev-test.db jev ask …
```

If you don't need the history, you can also rename or delete the database so
that it is recreated with this version's schema.

## The TUI asks for a terminal

If there is no interactive terminal, `jev tui` exits with code `1` and a clear
message listing the equivalent commands, without blocking or leaving the
terminal in a bad state:

```sh
echo "" | jev tui   # error: the interactive mode (tui) requires a terminal (TTY)
```

## The web console does not start

- **Port in use**: choose another one with `--port <n>` or `--port 0`.
- **Incomplete installation**: reinstall with
  `npm install -g jev-client@latest`. The console ships prebuilt inside the
  package, so no local build step is needed.
- **From the checkout**: run `npm run build:web` or use `--dev`.
- **It does not open the browser**: this is the expected behavior with CI/SSH;
  use `--open` or open the printed URL by hand.

## API errors

- `429 FreeUsageLimitError`: `jev-1.13-free` is limited outside OpenCode or once
  the quota runs out. Use `jev-1.13` for tests.
- `401` / `api_key_expired`: check the key (`jev config get api_key --reveal`,
  `JEV_API_KEY` or `--key`).
- `422`: the question is malformed; check `criteria` (`choice` uses an object,
  `score` uses an ordered array).
- The server `Retry-After` is capped at 10 s so the process is not blocked.
