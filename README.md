# jev-client

CLI y librería en **Node.js + TypeScript** para consumir la API de **Jev**
(System One de TypeSafe) a través de **OpenCode**.

Jev no genera texto: recibe un `state` y una o más preguntas tipadas, y devuelve
una respuesta por pregunta con probabilidades.

```
POST https://opencode.ai/inference/systemone/v1/systemone
Authorization: Bearer <API_KEY>
```

## Requisitos

- Node.js 20.9+ (o Node.js 22+)
- Una API key de [OpenCode Console](https://opencode.ai/console)

## Instalación

```sh
cd jev-client
npm install
npm run build
```

Para tener el comando `jev` disponible:

```sh
npm link          # opcional
jev demo
```

O sin enlazar:

```sh
node dist/src/bin.js demo
npm start -- demo
npm run dev -- demo   # compila y ejecuta
```

## Configuración

La configuración se resuelve con esta precedencia: **flag > variable de entorno >
base SQLite > valor por defecto**. Las cadenas vacías cuentan como no definidas.

| Qué | Flag | Variable | Clave SQLite | Default |
| --- | --- | --- | --- | --- |
| API key | `--key` | `OPENCODE_API_KEY` o `JEV_API_KEY` | `api_key` | — (obligatoria) |
| Endpoint | `--url` | `JEV_URL` | `api_url` | `https://opencode.ai/inference/systemone/v1/systemone` |
| Modelo | `--model` | `JEV_MODEL` | `model` | `jev-1.13` |
| Timeout (segundos) | `--timeout` | — | `timeout` | `30` |
| Reintentos | `--retries` | — | `retries` | `2` |
| Base SQLite | `--db` | `JEV_DB` | — | ver abajo |

```sh
export OPENCODE_API_KEY="sk-..."
```

`--url` espera el **endpoint completo**, no la base. Si un request completo
incluye `model`, ese modelo explícito se mantiene por delante del guardado en
SQLite.

Otros flags comunes a `ask` y `demo`:

```
--db ~/.jev-client/db/jev.db     ruta de la base (también en config)
--timeout 30                     timeout de cada intento HTTP, en segundos
--retries 2                      reintentos ante 429/5xx y errores de red
--no-save                        no registrar esta ejecución en el historial
--json                           imprime la respuesta cruda de la API
```

### Persistencia SQLite

Se eligió **`better-sqlite3` 12.x** porque mantiene el requisito actual de
**Node.js 20 o superior**. La versión 13 del driver ya exige Node 22, igual que
la alternativa `node:sqlite`, por lo que no se sube el mínimo de Node.

La base se crea y migra automáticamente en el primer uso de `ask`, `demo` o
`config`. Vive por defecto en `<home-del-SO>/.jev-client/db/jev.db`. El
directorio personal se obtiene mediante `os.homedir()`, por lo que funciona en
Linux, macOS y Windows; por ejemplo, `~/.jev-client/db/jev.db` en Unix y
`%USERPROFILE%\.jev-client\db\jev.db` en Windows.

Se puede cambiar en `ask`, `demo` y `config` con `--db /ruta/jev.db` o
`JEV_DB=/ruta/jev.db`. Al crear el directorio y el fichero se usan permisos
restrictivos (`0700` y `0600` en sistemas POSIX). Las migraciones están
versionadas con `PRAGMA user_version` y se pueden reaplicar sin duplicar datos.

**La API key guardada en SQLite queda en claro.** Los permisos del fichero no la
cifran. Para no persistirla, no uses `config set api_key`: pásala con `--key` o
mediante `OPENCODE_API_KEY`/`JEV_API_KEY`; esas dos vías nunca la guardan
automáticamente.

### Esquema SQLite

La base usa tres tablas. El esquema está versionado con `PRAGMA user_version`
(versión actual: **3**): cada versión se aplica en una transacción, las
migraciones son aditivas e idempotentes (`CREATE TABLE IF NOT EXISTS`) y se
pueden reaplicar sin duplicar datos. Si una base es más reciente de lo que
soporta esta versión, `openDatabase` lanza un error antes de tocar nada.

**`config`** — clave/valor de la configuración persistente.

| Columna | Tipo | Notas |
| --- | --- | --- |
| `key` | `TEXT PRIMARY KEY` | `api_url`, `api_key`, `model`, `timeout`, `retries` |
| `value` | `TEXT NOT NULL` | siempre texto; `timeout`/`retries` se validan como números |

**`templates`** — plantillas JSON con macros.

| Columna | Tipo | Notas |
| --- | --- | --- |
| `name` | `TEXT PRIMARY KEY` | nombre de la plantilla |
| `description` | `TEXT NOT NULL DEFAULT ''` | descripción opcional |
| `body_json` | `TEXT NOT NULL` | body de la plantilla (con macros `{{clave}}`) |
| `created_at` | `TEXT NOT NULL` | ISO 8601 |
| `updated_at` | `TEXT NOT NULL` | ISO 8601 |

**`requests`** — historial de peticiones (una fila por ejecución de `ask`, `demo`
o por cada petición de un `batch`).

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

Índices sobre `requests`: `idx_requests_created_at`, `idx_requests_model` e
`idx_requests_template_name`.

**Qué NO se guarda.** El historial no persiste cabeceras (ni la `Authorization`
con la API key): solo el payload enviado y el cuerpo devuelto por la API. Para
no conservar una ejecución concreta, usa `--no-save`.

Para inspeccionar o migrar la base a mano, `sqlite3` sirve:

```sh
sqlite3 ~/.jev-client/db/jev.db '.schema'
sqlite3 ~/.jev-client/db/jev.db 'PRAGMA user_version;'
```

## Comandos

### `jev config`

Gestiona las claves persistentes `api_url`, `api_key`, `model`, `timeout` y
`retries`:

```sh
jev config set api_url https://opencode.ai/inference/systemone/v1/systemone
jev config set model jev-1.13
jev config set timeout 30
jev config set retries 2

jev config get model
jev config list
jev config list --json          # objeto JSON clave -> valor
jev config unset model
jev config path                 # ruta de la base de datos que se está usando
```

`config get api_key` muestra la key enmascarada (por ejemplo
`sk-a…1234`); usa `--reveal` para verla completa o `--json` para el valor sin
máscara (orientado a scripting).

Para guardar la key (con el aviso explícito de que quedará en claro):

```sh
jev config set api_key "sk-..."
# aviso: la API key se guarda en claro en ...
```

Todos los subcomandos aceptan `--db`. `config get` devuelve un error si la clave
no existe; `config unset` es idempotente. Los valores de `timeout` deben ser
números positivos en segundos y los de `retries`, enteros mayores o iguales a
cero.

### `jev demo`

Ejemplo integrado (urgencia, equipo y frustración):

```sh
jev demo
```

```
modelo: jev-1.13
  frustration: score=1.99 ≈ "Muy enfadado" (confidence=0.98)
    2=0.99, 1=0.01, 0=0
  is_urgent: noul=0.99
  team: choice=infra (confidence=0.59)
    infra=0.73, billing=0.27, sales=0
tokens: 449 in / 73 out, cost=1.886e-5
```

La línea de `tokens` va a `stderr`, así que `--json` se puede redirigir a un
fichero sin contaminarlo.

### `jev ask`

```sh
# State y preguntas inline
jev ask \
  --state "Me han cobrado dos veces este mes." \
  --questions '{"billing":{"type":"noul","instructions":"¿Es de facturación?"}}'

# Desde ficheros
jev ask --state-file examples/state.json --questions-file examples/questions.json

# Payload completo
jev ask --request-file examples/request.json

# Texto por stdin
echo "El checkout está caído" | jev ask --state - \
  --questions '{"urgent":{"type":"noul","instructions":"¿Es urgente?"}}'

# Modelo y endpoint explícitos
jev ask --key sk-... --url https://…/v1/systemone --model jev-1.13-free \
  --state "hola" --questions '{"q":{"type":"noul","instructions":"¿Saludo?"}}'
```

El `state` puede ser texto plano, un objeto JSON (`{...}`) o un array (`[...]`).
Si empieza por `{` o `[` se envía como JSON; si no, como string.

### `jev history`

Todas las ejecuciones de `ask` y `demo` (correctas y fallidas) quedan registradas
en la tabla `requests` de la base SQLite. Se guarda el payload enviado, el cuerpo
recibido, el código de estado, la duración, los tokens y el coste cuando la API
los informa (`NULL` cuando no), y el código/mensaje de error si lo hubo.

```sh
jev history list               # una línea por petición, la más reciente primero
jev history show 12            # petición y respuesta completas
jev history export > hist.jsonl  # volcado JSONL (una petición por línea)
```

Filtros de `list` y `export`:

| Flag | Filtro |
| --- | --- |
| `--since <ISO>` | solo peticiones con `created_at` mayor o igual |
| `--status <código>` | código HTTP (p. ej. `200`, `429`) |
| `--model <modelo>` | modelo exacto |
| `--template <nombre>` | nombre de plantilla |
| `--batch <id>` | peticiones de un `batch_id` concreto |
| `--limit <n>` | número máximo de resultados |

Todos los subcomandos aceptan `--db`. Si no quieres registrar una ejecución
concreta, añade `--no-save` a `ask` o `demo`.

### `jev template`

Plantillas de request en JSON con macros. Una plantilla es un payload de Jev
con huecos `{{clave}}` que se resuelven con un mapa de contexto:

```json
{
  "model": "jev-1.13",
  "state": {
    "pedido": "{{estado_de_pedido}}",
    "cliente": "{{cliente.nombre}}"
  },
  "questions": {
    "urgent": { "type": "noul", "instructions": "¿Es urgente?" }
  }
}
```

`templates` es un alias de `template`. Subcomandos:

```sh
# Guardar una plantilla (sobrescribe si el nombre ya existe)
jev template create pedido --description "Pedido con cliente" \
  --file examples/template.json
# ... o con el body inline / desde stdin
jev template create pedido --body '{"model":"jev-1.13", ...}'
cat body.json | jev template create pedido --body -

jev template list                       # pedido - Pedido con cliente
jev template list --json                # array JSON con nombre, descripción y fechas
jev template show pedido                # imprime el body en JSON
jev template show pedido --json         # { name, description, body, ... }

# Editar con $EDITOR (o VISUAL); falla si no está definido
jev template edit pedido
# ... o reemplazar el body desde un fichero sin abrir el editor
jev template edit pedido --file nuevo.json

# Validar una plantilla guardada o un fichero, sin enviar nada
jev template validate pedido
jev template validate --file examples/template.json

# Previsualizar el request resuelto sin enviar la petición
jev template render pedido --context-file examples/context.json

# Borrar (con confirmación) o forzar con --yes
jev template delete pedido
jev template delete pedido --yes
```

`template add` y `template remove` se mantienen como sinónimos de `create` y
`delete` sin confirmación, respectivamente.

Reglas de las macros:

- `{{clave}}` busca la clave en el contexto; admite rutas anidadas
  (`{{cliente.nombre}}`). Si existe una clave literal con puntos, se prefiere a
  la ruta anidada.
- Si el string es **exactamente** una macro, se inserta el valor con su tipo
  nativo (objeto, array, número, booleano). Si va embebida en texto, se
  interpola como string.
- `\{{...}}` escapa una macro literal (`{{...}}` sin resolver).
- Si falta alguna macro, el comando falla antes de llamar a la API y lista todas
  las claves ausentes.
- El resultado se valida como request (model, state, questions y tipos de
  pregunta).

### `jev batch`

Ejecuta una plantilla una vez por cada mapa de contexto de un fichero JSON (un
array de objetos). Cada mapa produce una petición y una fila en el historial,
todas con el mismo `batch_id` y su `template_name`:

```sh
# Fichero con un array de mapas de contexto
jev batch pedido --contexts examples/contexts.json

# Hasta 3 peticiones concurrentes
jev batch pedido --contexts examples/contexts.json --concurrency 3

# Detenerse ante el primer error (por defecto sigue con el resto)
jev batch pedido --contexts examples/contexts.json --fail-fast
```

```text
batch: pedido — 3 peticiones (batch 4f3c…)
  1: ok    jev-1.13  12 in / 3 out  cost=1.5e-6
  2: error faltan macros en el contexto: cliente.plan
  3: ok    jev-1.13  12 in / 3 out  cost=1.5e-6
resumen: 2 ok, 1 error
tokens: 24 in / 6 out
coste: 3.0e-6 (1 sin coste informado)
```

- `--contexts <fichero.json>` espera un array de mapas de contexto; `-` lee de
  stdin.
- `--concurrency <n>` controla cuántas peticiones van a la vez; por defecto `1`
  para no saturar la API. El máximo es `10`.
- Con `--continue-on-error` (por defecto) un contexto inválido o una petición
  fallida no cancelan el resto; el proceso sale con código `1` si hubo errores.
  Con `--fail-fast` se detiene ante el primer error.
- El resumen de coste suma solo los costes informados y cuenta aparte los que
  la API no devolvió (`sin coste informado`).
- Los resultados se imprimen en el orden del fichero de contextos, con
  independencia de la concurrencia.
- `--json` imprime un único objeto JSON con el `batch_id`, la plantilla, el
  resumen (`ok`, `errors`, `input_tokens`, `output_tokens`, `cost`,
  `cost_unknown`) y el array `items` (uno por contexto, en orden, con su
  `index`, `ok`, `model`, tokens, `cost`, `error` y `response` cruda).

### `jev tui`

Modo interactivo a pantalla completa para configurar el provider y gestionar
plantillas sin memorizar comandos:

```sh
jev tui
jev tui --db /ruta/jev.db
```

Con dos pantallas principales:

- **Configuración del provider**: edita `api_url`, `api_key`, `model`, `timeout`
  y `retries` con validación en vivo. La `api_key` se muestra enmascarada (y
  nunca se muestra completa) y cada cambio confirmado se guarda en SQLite.
- **Plantillas**: listado con búsqueda incremental, detalle, creación y edición
  con editor de JSON y validación en vivo. Muestra las macros detectadas
  (`{{clave}}`) para avisar de las claves de contexto necesarias.

| Tecla | Acción |
| --- | --- |
| `↑` / `↓` | mover la selección |
| `Enter` | elegir / confirmar |
| `Esc` | cancelar / volver |
| `q` | volver al menú (o salir) |
| `Ctrl-C` | salir (pide confirmación si hay cambios) |
| En plantillas: `n` nueva, `e` editar, `d` borrar, `/` buscar, `Enter` ver, `q` menú |
| En la búsqueda: escribir filtra, `Backspace` borra, `Esc`/`Enter` salen |
| En el detalle: `e` editar, `d` borrar, `b`/`q` volver |

Los atajos de comando no distinguen mayúsculas (`n`/`N`, `q`/`Q`), pero el
texto que se escribe en nombre, descripción, body o búsqueda conserva su caso.
En las confirmaciones, `s`/`S`/`y`/`Y`/`Enter` aceptan y `n`/`N`/`Esc` rechazan.

Los cambios se guardan en las mismas tablas SQLite (`config` y `templates`) que
usan los comandos no interactivos, así que se ven con `jev config get` o
`jev template show`. Al salir con cambios sin guardar en el editor de plantillas
se pide confirmación.

**Sin TTY.** Si no hay terminal interactiva, `jev tui` sale con código `1` y un
mensaje claro listando los comandos equivalentes, sin bloquear ni dejar la
terminal en mal estado:

```sh
echo "" | jev tui   # error: requiere una terminal (TTY)
```

**Decisión de librería.** Se eligió una TUI propia basada en `readline` y modos
raw de Node, en lugar de `ink` o `blessed`:

- **Sin dependencias nuevas** (solo `better-sqlite3`, que ya estaba): `ink`
  arrastra React y `blessed` dejó de mantenerse y usa bindings nativos.
- **Soporta Node 20** sin problemas; `blessed` y el ecosistema de `ink` han ido
  subiendo el mínimo de Node.
- **Testeable en CI**: la máquina de estados (`TuiApp`) no toca la terminal, por
  lo que se prueba sin TTY; el driver raw queda aislado en `runTui`.

### Checklist de pruebas manuales

Lo siguiente no se puede automatizar del todo (depende de un TTY real) y conviene
revisarlo a mano antes de publicar:

- [ ] `jev tui` abre el menú y `↑`/`↓` mueven la selección.
- [ ] En Plantillas, `n`/`e`/`d`/`/` responden y `q` vuelve al menú; en el
      detalle `e`/`d`/`b`/`q` y en provider `q` también responden.
- [ ] Cambiar `model` y `api_url` desde la TUI y comprobar que persisten con
      `jev config get model` y `jev config get api_url` en otra ejecución.
- [ ] La `api_key` se muestra enmascarada al consultarla y al editarla; nunca se
      ve el valor completo.
- [ ] Crear una plantilla desde la TUI y verla después con `jev template show`.
- [ ] Editar una plantilla con un JSON inválido muestra el error y bloquea el
      guardado; con JSON válido muestra las macros detectadas.
- [ ] Salir con `Ctrl-C` en mitad de una edición pide confirmación si hay cambios.
- [ ] `echo "" | jev tui` imprime el error de "requiere una terminal" y sale con
      código `1`; la terminal queda usable.
- [ ] Redimensionar la ventana no corrompe la pantalla (cada tecla redibuja).

## Consola web local (`jev web-console`)

La consola web es una tercera interfaz sobre el mismo dominio, además de la CLI y
la TUI. Usa **Next.js 16.4.3 + React 19.3.1**, App Router y route handlers como
BFF local; no sustituye `jev tui` ni requiere una cuenta ni telemetría.

```sh
jev web-console
jev --web-console                 # alias con los mismos flags
jev web-console --port 0 --no-open
```

Al arrancar migra la misma SQLite, espera `GET /api/health`, imprime URL, base,
versión, esquema, PID y modo, y queda en primer plano. `Ctrl-C`/`SIGTERM` cierra
el hijo y libera el puerto con salida `0`. Un puerto ocupado o un build ausente
produce un error explícito; nunca elige otro puerto fijo en silencio.

| Flag | Default | Descripción |
| --- | --- | --- |
| `--port <n>` | `7411` | Puerto de escucha; `0` elige uno libre. |
| `--host <addr>` | `127.0.0.1` | Loopback salvo decisión explícita. |
| `--allow-remote` | off | Necesario para LAN/`0.0.0.0`; mantiene token y aviso de seguridad. |
| `--open` / `--no-open` | abrir con TTY | No abre con CI/SSH; `--no-open` es apto para headless. |
| `--dev` | off | Usa `next dev` desde el checkout, no desde un paquete instalado. |
| `--db <ruta>` | `JEV_DB` / ruta habitual | Base compartida con el resto de comandos. |
| `--key`, `--url`, `--model` | — | Flags de sesión; tienen prioridad máxima y no se persisten. |
| `--timeout`, `--retries` | — | Segundos y reintentos de esta sesión. |
| `-h`, `--help` | — | Ayuda específica de la consola. |

### Pantallas y paridad

- **Resumen**: métricas reales de `requests`, últimas peticiones, precedencia del
  provider y prueba de conexión real mínima (`state: "ping"`, `--no-save`).
- **Evaluar**: `noul`, `choice` y `score`, state texto/JSON estricto, demo real,
  `--no-save`, cancelación, informe de probabilidades y JSON crudo seguro. Las
  respuestas siguen el orden de las preguntas del request. El selector admite el
  modelo efectivo, los dos modelos conocidos y un valor libre.
- **Plantillas**: búsqueda, crear/editar/validar/renderizar/renombrar/borrar,
  macros anidadas y escapadas, cambios sin guardar y renombrado transaccional.
  **Nueva plantilla** abre el modal **Empezar plantilla** con ejemplos válidos de
  `noul`, `choice` y `score` (`src/template-starters.ts`); `noul` llega
  preseleccionado, `choice` usa `criteria` como objeto de descripciones y `score`
  como array ordenado. El editor queda libre después. Renderizar nunca llama a
  Jev.
- **Lotes**: pool real de 1–10 workers, progreso NDJSON por item, `fail-fast`,
  `--no-save` y `batch_id` de servidor. Cancelar detiene el scheduling **y aborta
  las peticiones en vuelo**, conservando las filas ya escritas y marcando el resto
  como omitido.
- **Historial**: filtros `since/status/model/template/batch/limit`, detalle por
  pestañas y export `application/x-ndjson` con exactamente
  `historyRecordToJson`. Los filtros viven en la URL. Se usa límite 1–200, sin
  cursor adicional en esta versión.
- **Configuración**: guarda solo claves modificadas, enmascara/revela la key bajo
  acción explícita y muestra `flag > entorno > SQLite > defecto`. Los campos
  fijados por flag son de solo lectura. **Restablecer hace `unset`**, no escribe
  defaults. Una cadena vacía también equivale a `unset`.

Cada pantalla genera su tira **CLI equivalente** con comillas POSIX. La paleta
`⌘K`/`Ctrl+K`, referencia CLI, toasts, modales con foco atrapado, estados
loading/empty/error/success y los breakpoints del prototipo están incluidos. No
se guardan secretos ni borradores en `localStorage`; solo se usan URLs para
filtros/acciones. Las rutas permanecen en español por paridad con la UI.

### Seguridad local

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

### Arquitectura y empaquetado

`src/service.ts` concentra `ask`, `demo` y `batch`; CLI y web comparten cliente,
configuración, validadores, migraciones y repositorios. Next mantiene una única
conexión SQLite perezosa por proceso y sus Server Components cargan DTOs sin
secretos; los Client Components no importan `node:*` ni `better-sqlite3`.

El paquete npm incluye el **standalone compilado** en `dist/web-console` (sin
checkout), sus assets y el servidor CommonJS. Las dependencias trazadas se
resuelven desde las dependencias npm normales (`next`, `react`, `react-dom` y
`better-sqlite3`), evitando incluir `node_modules` dentro del tarball. Se eligió
esta opción en lugar de un paquete opcional para conservar la UX de un único
comando. El umbral acordado es **25 MiB comprimidos**; `npm run test:package`
comprueba tamaño, instalación con `npm pack`, arranque, health, HTML, assets y
cierre limpio.

Para desarrollo:

```sh
npm install
npm run build:web                 # tsc + next build + standalone
node dist/src/bin.js web-console --dev --no-open
# JEV_CONSOLE_DIR puede sustituir la ubicación del build/directorio web
```

El contrato visual original está versionado en `design/` (`jev-web-console.html`,
handoff y manifest). Los tokens se extrajeron en `web/styles/tokens.css`; no se
usa un tema de framework ni recursos remotos.

## Tipos de pregunta

| `type` | Campos | Devuelve |
| --- | --- | --- |
| `noul` | `instructions` (y `criteria` opcional) | `noul`: probabilidad de "sí" (0–1) |
| `choice` | `instructions`, `criteria` (objeto) | `choice`, `confidence`, `probabilities` |
| `score` | `instructions`, `criteria` (array ordenado) | `score`, `legend`, `probabilities` |

En `score`, la posición en el array es la nota: `0` el primero, `1` el segundo…
El `score` devuelto es la media ponderada y puede ser decimal; cuando cae entre
dos niveles se muestra con `≈`.

## Códigos de salida

| Código | Significado |
| --- | --- |
| `0` | Correcto |
| `1` | Error de API, red o configuración (falta la key, JSON inválido…) |
| `2` | Uso incorrecto (comando o flags inválidos) |

Los errores de autenticación (`401` / `api_key_expired`), cuota
(`FreeUsageLimitError`) y preguntas mal formadas (`422`) añaden una línea
`pista:` con la acción recomendada.

## Uso como librería

```ts
import { JevClient, type Question } from "./dist/src/index.js";

const client = new JevClient({ apiKey: process.env.OPENCODE_API_KEY! });

const questions: Record<string, Question> = {
  refund: { type: "noul", instructions: "¿El cliente pide un reembolso?" },
  team: {
    type: "choice",
    instructions: "¿Qué equipo debe atenderlo?",
    criteria: {
      billing: "Cobros y facturas",
      legal: "Reclamaciones legales",
    },
  },
  urgency: {
    type: "score",
    instructions: "¿Cómo de urgente es?",
    criteria: ["Puede esperar", "Esta semana", "Hoy"],
  },
};

const response = await client.systemOne(
  { ticket: "Me han cobrado dos veces", plan: "pro" },
  questions,
);

console.log(response.answers.refund?.noul);      // number | undefined
console.log(response.answers.team?.choice);      // string | undefined
console.log(response.answers.team?.probabilities); // Record<string, number>
console.log(response.usage.cost);                 // number | undefined
```

Opciones del cliente:

```ts
new JevClient({
  apiKey,
  endpoint,        // default: OpenCode
  model,           // default: jev-1.13
  timeoutMs,       // default: 30000
  maxRetries,      // default: 2
  backoffMs,       // default: 500
  maxRetryDelayMs, // default: 10000 (tope del Retry-After)
});
```

`run()` acepta un request completo (`{ model, state, questions }`) y `raw`
contiene el cuerpo original de la API.

Para plantillas, `resolveTemplateBody` resuelve un body con macros y lo valida:

```ts
import { resolveTemplateBody } from "./dist/src/index.js";

const request = resolveTemplateBody(
  '{"model":"jev-1.13","state":"{{estado}}","questions":{"q":{"type":"noul"}}}',
  { estado: { pedido: 42 } },
);
```

## Tests

```sh
npm test                 # unidad/contrato de CLI, dominio y route handlers
npm run typecheck        # TypeScript estricto de src, test y web
npm run build:web        # build de producción Next + standalone
npm run test:e2e         # Playwright: flujos, axe y matriz responsive
npm run test:package     # npm pack + instalación + smoke del paquete
```

Los tests no hacen red contra la API: usan un `fetch` inyectado y servidores HTTP
locales para comprobar cabeceras, cuerpo, reintentos, errores, formato, CLI, API
web y streaming de lotes. Las bases SQLite se crean en directorios temporales.
Playwright recorre las seis rutas, inferencia con provider mockeado, CRUD,
render, lote, historial/export, configuración, paleta, modales y axe; la matriz
360–1920 px verifica overflow, tokens, breakpoints, activos locales y una
regresión de geometría/tipografía calculada directamente contra el HTML exportado.
Para instalar Chromium en el checkout sin tocar la caché global:

```sh
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
```

### CI

Hay un workflow de GitHub Actions (`.github/workflows/ci.yml`) que, en cada push
a `main` y en cada pull request, ejecuta sobre Node 20 y 22 el typecheck, tests
unitarios/de rutas, build de Next, E2E con axe y smoke del paquete instalado. La
suite no necesita una API key real ni secretos de CI.

## Notas

- `jev-1.13-free` está limitado: devuelve `429 FreeUsageLimitError` fuera de
  OpenCode o al agotar la cuota. Para pruebas usa `jev-1.13`.
- El `Retry-After` del servidor se capa a 10 s para no bloquear el proceso.
- Jev está entrenado principalmente en inglés; acepta español con algo menos de
  precisión.
- Documentación de las preguntas: <https://docs.typesafe.ai/primitives>
