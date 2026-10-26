# Consola web local

La consola web es una interfaz sobre el mismo dominio que la CLI y la TUI: usa
**Next.js 16.4.3 + React 19.3.1**, App Router y route handlers como BFF local.
No sustituye `jev tui` ni requiere cuenta ni telemetría.

```sh
jev web-console
jev --web-console                 # alias con los mismos flags
jev web-console --port 0 --no-open
```

Al arrancar migra la misma SQLite, espera `GET /api/health`, imprime URL, base,
versión, esquema, PID y modo, y queda en primer plano. `Ctrl-C`/`SIGTERM` cierra
el hijo y libera el puerto con salida `0`. Un puerto ocupado o un build ausente
produce un error explícito; nunca elige otro puerto fijo en silencio.

## Flags

| Flag | Default | Descripción |
| --- | --- | --- |
| `--port <n>` | `7411` | Puerto de escucha; `0` elige uno libre. |
| `--host <addr>` | `127.0.0.1` | Loopback salvo decisión explícita. |
| `--allow-remote` | off | Necesario para LAN/`0.0.0.0`; mantiene token y aviso de seguridad. |
| `--open` / `--no-open` | abrir con TTY | No abre con CI/SSH; `--no-open` es apto para headless. |
| `--dev` | off | Usa `next dev` desde el checkout, no desde un paquete instalado. |
| `--db <ruta>` | `JEV_DB` / ruta habitual | Base compartida con el resto de comandos. |
| `--key`, `--url`, `--model` | — | Flags de sesión; prioridad máxima y no se persisten. |
| `--timeout`, `--retries` | — | Segundos y reintentos de esta sesión. |
| `-h`, `--help` | — | Ayuda específica de la consola. |

`JEV_CONSOLE_DIR` permite indicar el directorio del standalone o, con `--dev`,
el checkout web.

## Pantallas

- **Resumen**: métricas reales de `requests`, últimas peticiones, precedencia del
  provider y prueba de conexión real mínima (`state: "ping"`, `--no-save`).
- **Evaluar**: `noul`, `choice` y `score`, state texto/JSON estricto, demo real,
  `--no-save`, cancelación, informe de probabilidades y JSON crudo seguro. Las
  respuestas siguen el orden de las preguntas del request. El selector admite el
  modelo efectivo, los dos modelos conocidos y un valor libre.
- **Plantillas**: búsqueda, crear/editar/validar/renderizar/renombrar/borrar,
  macros anidadas y escapadas, cambios sin guardar, renombrado transaccional y
  pestaña **Macros** con una descripción y un JSON Schema opcionales por macro.
  Cada fila ofrece un selector de tipo básico y un editor avanzado de JSON
  (formatear, validación en vivo y bloqueo del guardado si es inválido), con
  resumen `N de M descritas · K con tipo`, guardado atómico con el body y aviso
  al quitar una macro descrita o con esquema. Los metadatos se persisten en
  `template_macros` (`description`, `schema_json`) y nunca se envían a Jev.
  **Nueva plantilla** abre el modal **Empezar plantilla** con ejemplos válidos de
  `noul`, `choice` y `score` (`src/template-starters.ts`); `noul` llega
  preseleccionado, `choice` usa `criteria` como objeto de descripciones y `score`
  como array ordenado. El editor queda libre después. Renderizar nunca llama a
  Jev.
- **Lotes**: el editor de contextos arranca con un esqueleto JSON a 2 espacios que
  contiene una clave plana por macro de la plantilla activa (orden de
  `detectMacros`), listo para rellenar. Al cambiar de plantilla se regenera solo
  si no había ediciones; si las hay se conserva el texto y aparece la acción
  **Rellenar con las macros de <plantilla>** (con confirmación). Un desplegable
  **Macros de la plantilla** muestra `{{clave}}` y su descripción cuando existe,
  y los valores todavía vacíos piden confirmación antes de ejecutar. Después,
  pool real de 1–10 workers, progreso NDJSON por item, `fail-fast`, `--no-save`
  y `batch_id` de servidor. Cancelar detiene el scheduling **y aborta las
  peticiones en vuelo**, conservando las filas ya escritas y marcando el resto
  como omitido.
- **Historial**: filtros `since/status/model/template/batch/limit`, detalle por
  pestañas y export `application/x-ndjson` con exactamente
  `historyRecordToJson`. Los filtros viven en la URL. Límite 1–200, sin cursor
  adicional en esta versión.
- **Configuración**: guarda solo claves modificadas, enmascara/revela la key bajo
  acción explícita y muestra `flag > entorno > SQLite > defecto`. Los campos
  fijados por flag son de solo lectura. **Restablecer hace `unset`**, no escribe
  defaults. Una cadena vacía también equivale a `unset`.

Cada pantalla genera su tira **CLI equivalente** con comillas POSIX. La paleta
`⌘K`/`Ctrl+K`, referencia CLI, toasts, modales con foco atrapado, estados
loading/empty/error/success y los breakpoints del prototipo están incluidos. No
se guardan secretos ni borradores en `localStorage`; solo se usan URLs para
filtros/acciones. Las rutas permanecen en español por paridad con la UI.

## Seguridad local

La URL impresa contiene un bootstrap aleatorio en el **fragmento**, que no viaja
en peticiones HTTP. El navegador lo intercambia una sola vez por una cookie
`HttpOnly; SameSite=Strict` y un token CSRF en memoria. Las mutaciones exigen
cookie, `X-Jev-Console-Token` y validación de `Origin`/`Host`; la API vuelve a
exigir sesión en cada handler. `/api/health` es la única lectura pública y no
incluye secretos.

La key nunca aparece en HTML inicial, listados, logs, URLs ni `localStorage`.
Solo `POST /api/config/api_key/reveal`, con CSRF y `Cache-Control: no-store`, la
devuelve. Se aplican CSP con nonce/`strict-dynamic`, `frame-ancestors 'none'`,
`nosniff`, `Referrer-Policy: no-referrer`, límites de body/contextos y consultas
SQLite parametrizadas. Fuentes, iconos, CSS y ejemplos se sirven localmente, sin
CDN ni llamadas externas salvo Jev.

`--allow-remote` no añade cuentas ni autorización multiusuario: expone una consola
de administración local a clientes que tengan la URL inicial. Úsalo solo en redes
de confianza.

## Endpoints de documentación

La consola publica el mismo catálogo que usa MCP (requieren sesión de consola):

- `GET /api/docs` — documento de la app.
- `GET /api/docs/tools` y `GET /api/docs/tools/[name]` — catálogo de tools.
- `GET /api/docs/mcp` — configuración del servidor.
- `GET /api/docs/examples` — ejemplos end-to-end.

## Desarrollo de la consola

```sh
npm install
npm run build:web                 # tsc + next build + standalone
node dist/src/bin.js web-console --dev --no-open
```
