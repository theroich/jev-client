# Configuración

La configuración se resuelve con esta precedencia:

**flag > variable de entorno > base SQLite > valor por defecto**

Las cadenas vacías cuentan como no definidas.

| Qué | Flag | Variable | Clave SQLite | Default |
| --- | --- | --- | --- | --- |
| API key | `--key` | `OPENCODE_API_KEY` o `JEV_API_KEY` | `api_key` | — (obligatoria) |
| Endpoint | `--url` | `JEV_URL` | `api_url` | `https://opencode.ai/inference/systemone/v1/systemone` |
| Modelo | `--model` | `JEV_MODEL` | `model` | `jev-1.13` |
| Timeout (segundos) | `--timeout` | — | `timeout` | `30` |
| Reintentos | `--retries` | — | `retries` | `2` |
| Base SQLite | `--db` | `JEV_DB` | — | ver [persistencia](persistencia.md) |

`--url` espera el **endpoint completo**, no la base. Si un request completo
incluye `model`, ese modelo explícito se mantiene por delante del guardado en
SQLite.

## Flags comunes

`ask`, `demo` y `batch` aceptan:

```
--db ~/.jev-client/db/jev.db     ruta de la base (también en config)
--timeout 30                     timeout de cada intento HTTP, en segundos
--retries 2                      reintentos ante 429/5xx y errores de red
--no-save                        no registrar esta ejecución en el historial
--json                           imprime la respuesta cruda de la API
```

`web-console` acepta además `--key`, `--url`, `--model`, `--timeout` y
`--retries` como **flags de sesión**: tienen prioridad máxima y no se persisten.
Ver [consola web](web-console.md).

## Secretos

La API key guardada con `jev config set api_key` queda **en claro** en SQLite:
los permisos del fichero no la cifran. Para no persistirla, pásala con `--key` o
mediante `OPENCODE_API_KEY`/`JEV_API_KEY`; esas dos vías nunca la guardan
automáticamente.

La consola web nunca escribe la key en HTML inicial, listados, logs, URLs ni
`localStorage`; solo la devuelve `POST /api/config/api_key/reveal`, con CSRF y
`Cache-Control: no-store`.
