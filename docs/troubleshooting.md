# Troubleshooting

## `better-sqlite3` compiled against another Node version

The typical error is `NODE_MODULE_VERSION 137` versus `115`: the native binary
was installed with a Node version different from the one running `jev`. Use the
binary that matches your Node (for example `ivm-node 24.11.1`) or rebuild the
module:

```sh
npm rebuild better-sqlite3
```

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
- **Missing build**: run `npm run build:web` or use `--dev` from the checkout.
- **It does not open the browser**: this is the expected behavior with CI/SSH;
  use `--open` or open the printed URL by hand.

## API errors

- `429 FreeUsageLimitError`: `jev-1.13-free` is limited outside OpenCode or once
  the quota runs out. Use `jev-1.13` for tests.
- `401` / `api_key_expired`: check the key (`jev config get api_key --reveal`,
  `OPENCODE_API_KEY` or `--key`).
- `422`: the question is malformed; check `criteria` (`choice` uses an object,
  `score` uses an ordered array).
- The server `Retry-After` is capped at 10 s so the process is not blocked.
