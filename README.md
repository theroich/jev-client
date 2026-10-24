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

- Node.js 20+
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
jev config unset model
```

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

```sh
# Guardar una plantilla (sobrescribe si el nombre ya existe)
jev template add pedido --description "Pedido con cliente" \
  --body-file examples/template.json

jev template list                       # pedido - Pedido con cliente
jev template show pedido                # imprime el body en JSON

# Previsualizar el request resuelto sin enviar la petición
jev template render pedido --context-file examples/context.json

jev template remove pedido
```

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
npm test        # compila y ejecuta node:test
npm run typecheck
```

Los tests no hacen red contra la API: usan un `fetch` inyectado y un servidor
HTTP local para comprobar cabeceras, cuerpo, reintentos, 401 sin reintento, 429
de cuota, parseo de errores, formato y CLI. Las bases SQLite se crean en
directorios temporales para probar migraciones, repositorio, precedencia y
permisos.

## Notas

- `jev-1.13-free` está limitado: devuelve `429 FreeUsageLimitError` fuera de
  OpenCode o al agotar la cuota. Para pruebas usa `jev-1.13`.
- El `Retry-After` del servidor se capa a 10 s para no bloquear el proceso.
- Jev está entrenado principalmente en inglés; acepta español con algo menos de
  precisión.
- Documentación de las preguntas: <https://docs.typesafe.ai/primitives>
