# Persistencia SQLite

La base se crea y migra automáticamente en el primer uso de `ask`, `demo` o
`config`. Vive por defecto en `<home-del-SO>/.jev-client/db/jev.db`: el
directorio personal se obtiene con `os.homedir()`, así que funciona en Linux,
macOS y Windows (`~/.jev-client/db/jev.db` en Unix,
`%USERPROFILE%\.jev-client\db\jev.db` en Windows).

Se puede cambiar en `ask`, `demo` y `config` con `--db /ruta/jev.db` o
`JEV_DB=/ruta/jev.db`. Al crear el directorio y el fichero se usan permisos
restrictivos (`0700` y `0600` en sistemas POSIX).

## Motor y migraciones

Se usa **`better-sqlite3` 12.x** porque mantiene el requisito de **Node.js 20 o
superior**. La versión 13 del driver ya exige Node 22, igual que la alternativa
`node:sqlite`, por lo que no se sube el mínimo de Node.

Las migraciones están versionadas con `PRAGMA user_version` (versión actual:
**6**). Cada versión se aplica en una transacción, las migraciones son aditivas
e idempotentes (`CREATE TABLE IF NOT EXISTS` y comprobación de columnas en
`ALTER TABLE`) y se pueden reaplicar sin duplicar datos. Si una base es más
reciente de lo que soporta esta versión, `openDatabase` lanza un error antes de
tocar nada.

## Esquema

La base usa cuatro tablas.

### `config`

Clave/valor de la configuración persistente.

| Columna | Tipo | Notas |
| --- | --- | --- |
| `key` | `TEXT PRIMARY KEY` | `api_url`, `api_key`, `model`, `timeout`, `retries` |
| `value` | `TEXT NOT NULL` | siempre texto; `timeout`/`retries` se validan como números |

### `templates`

Plantillas JSON con macros.

| Columna | Tipo | Notas |
| --- | --- | --- |
| `name` | `TEXT PRIMARY KEY` | nombre de la plantilla |
| `description` | `TEXT NOT NULL DEFAULT ''` | descripción opcional |
| `body_json` | `TEXT NOT NULL` | body de la plantilla (con macros `{{clave}}`) |
| `created_at` | `TEXT NOT NULL` | ISO 8601 |
| `updated_at` | `TEXT NOT NULL` | ISO 8601 |

### `template_macros`

Metadatos opcionales (descripción y JSON Schema) de las macros de cada
plantilla. El body sigue siendo la única fuente de verdad de **qué** macros
existen; esta tabla solo aporta su significado y su forma para humanos y
agentes.

| Columna | Tipo | Notas |
| --- | --- | --- |
| `template_name` | `TEXT NOT NULL` | FK a `templates.name` con `ON DELETE/UPDATE CASCADE` |
| `macro` | `TEXT NOT NULL` | clave completa, p. ej. `cliente.nombre` |
| `description` | `TEXT NOT NULL DEFAULT ''` | texto libre (máx. 500), `''` si no se describió |
| `schema_json` | `TEXT` | JSON Schema compacto (máx. 8 KB) o `NULL` si no tiene |
| `created_at` | `TEXT NOT NULL` | ISO 8601 |
| `updated_at` | `TEXT NOT NULL` | ISO 8601 |

La clave primaria es `(template_name, macro)`. Al leer, el repositorio fusiona
`detectMacros(body_json)` con las filas guardadas: toda macro del body aparece
aunque no tenga fila, y nunca se devuelven filas huérfanas. Al guardar se
eliminan las filas de macros que ya no están en el body y se conservan
descripciones y esquemas existentes si no se pasan explícitamente.

El esquema es informativo: puede ser un objeto JSON Schema o un booleano
(`true`/`false`), se guarda compacto y la API lo devuelve parseado. Se valida de
forma estructural (JSON válido, `type` conocido, `enum` no vacío, `format` y
`pattern` correctos, límites numéricos, `$ref` solo locales y máximo 8 KB), pero
no se resuelve ni se compone con el de rutas padre/hijas. Ni la descripción ni el
esquema **se envían a Jev** ni alteran el renderizado.

### `requests`

Historial de peticiones: una fila por ejecución de `ask`, `demo` o por cada
petición de un `batch`.

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | id de la petición |
| `created_at` | `TEXT NOT NULL` | ISO 8601 |
| `started_at` / `finished_at` | `TEXT` | marcas de inicio y fin |
| `duration_ms` | `INTEGER` | duración en milisegundos |
| `endpoint` | `TEXT` | URL usada |
| `model` | `TEXT` | modelo usado |
| `status_code` | `INTEGER` | código HTTP (o `NULL`) |
| `ok` | `INTEGER NOT NULL` | `1` éxito, `0` fallo |
| `request_json` | `TEXT` | payload enviado (`model`, `state`, `questions`) |
| `response_json` | `TEXT` | cuerpo crudo recibido |
| `input_tokens` / `output_tokens` | `INTEGER` | tokens, `NULL` si no se informan |
| `cost` | `REAL` | coste, `NULL` si no se informa |
| `error_code` / `error_message` | `TEXT` | error si la petición falló |
| `template_name` / `batch_id` | `TEXT` | sellos de plantilla y batch |
| `source` | `TEXT NOT NULL DEFAULT 'cli'` | origen: `cli`, `tui`, `web` o `mcp` |

Índices sobre `requests`: `idx_requests_created_at`, `idx_requests_model` e
`idx_requests_template_name`.

## Qué NO se guarda

El historial no persiste cabeceras (ni la `Authorization` con la API key): solo
el payload enviado y el cuerpo devuelto por la API. Para no conservar una
ejecución concreta, usa `--no-save`.

Con imágenes, el historial **nunca** guarda `data_base64`: se redacta a
`{ format, bytes, sha256 }`.

## Inspección manual

```sh
sqlite3 ~/.jev-client/db/jev.db '.schema'
sqlite3 ~/.jev-client/db/jev.db 'PRAGMA user_version;'
```
