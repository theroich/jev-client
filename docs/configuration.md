# Configuration

Configuration is resolved with this precedence:

**flag > environment variable > SQLite database > request/template model > default value**

Empty strings count as undefined.

| What | Flag | Variable | SQLite key | Default |
| --- | --- | --- | --- | --- |
| API key | `--key` | `JEV_API_KEY` | `api_key` | — (required) |
| Endpoint | `--url` | `JEV_URL` | `api_url` | `https://opencode.ai/inference/systemone/v1/systemone` |
| Model | `--model` | `JEV_MODEL` | `model` | `jev-1.13` |
| Timeout (seconds) | `--timeout` | — | `timeout` | `30` |
| Retries | `--retries` | — | `retries` | `2` |
| SQLite database | `--db` | `JEV_DB` | — | see [persistence](persistence.md) |

`--url` expects the **full endpoint**, not the base. The model saved in SQLite
(`jev config set model`, or the TUI) is the effective one: a `model` embedded in
a complete request or a template only applies when no `--model`, `JEV_MODEL`
or saved model exists. Use `--model` or `JEV_MODEL` to override it for a single
run.

## Common flags

`ask`, `demo` and `batch` accept:

```
--db ~/.jev-client/db/jev.db     database path (also in config)
--timeout 30                     timeout of each HTTP attempt, in seconds
--retries 2                      retries on 429/5xx and network errors
--no-save                        do not record this run in the history
--json                           prints the raw API response
```

`web-console` also accepts `--key`, `--url`, `--model`, `--timeout` and
`--retries` as **session flags**: they have the highest priority and are not
persisted. See [web console](web-console.md).

## Secrets

The API key stored with `jev config set api_key` stays **in clear text** in
SQLite: the file permissions do not encrypt it. To avoid persisting it, pass it
with `--key` or through `JEV_API_KEY`; neither path stores it automatically.

The web console never writes the key into the initial HTML, listings, logs, URLs
or `localStorage`; only `POST /api/config/api_key/reveal` returns it, with CSRF
and `Cache-Control: no-store`.
