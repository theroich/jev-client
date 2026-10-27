# Configuration

Configuration is resolved with this precedence:

**flag > environment variable > SQLite database > default value**

Empty strings count as undefined.

| What | Flag | Variable | SQLite key | Default |
| --- | --- | --- | --- | --- |
| API key | `--key` | `OPENCODE_API_KEY` or `JEV_API_KEY` | `api_key` | — (required) |
| Endpoint | `--url` | `JEV_URL` | `api_url` | `https://opencode.ai/inference/systemone/v1/systemone` |
| Model | `--model` | `JEV_MODEL` | `model` | `jev-1.13` |
| Timeout (seconds) | `--timeout` | — | `timeout` | `30` |
| Retries | `--retries` | — | `retries` | `2` |
| SQLite database | `--db` | `JEV_DB` | — | see [persistence](persistence.md) |

`--url` expects the **full endpoint**, not the base. If a complete request
includes `model`, that explicit model keeps priority over the one stored in
SQLite.

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
with `--key` or through `OPENCODE_API_KEY`/`JEV_API_KEY`; those two paths never
store it automatically.

The web console never writes the key into the initial HTML, listings, logs, URLs
or `localStorage`; only `POST /api/config/api_key/reveal` returns it, with CSRF
and `Cache-Control: no-store`.
