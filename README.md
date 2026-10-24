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

La key, la URL y el modelo se pueden pasar por flag **o** por variable de
entorno. Precedencia: **flag > entorno > valor por defecto**.

| Qué | Flag | Variable | Default |
| --- | --- | --- | --- |
| API key | `--key` | `OPENCODE_API_KEY` o `JEV_API_KEY` | — (obligatoria) |
| Endpoint | `--url` | `JEV_URL` | `https://opencode.ai/inference/systemone/v1/systemone` |
| Modelo | `--model` | `JEV_MODEL` | `jev-1.13` |

```sh
export OPENCODE_API_KEY="sk-..."
```

`--url` espera el **endpoint completo**, no la base.

Otros flags comunes a `ask` y `demo`:

```
--timeout 30     timeout de cada intento HTTP, en segundos
--retries 2      reintentos ante 429/5xx y errores de red
--json           imprime la respuesta cruda de la API
```

## Comandos

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

## Tests

```sh
npm test        # compila y ejecuta node:test
npm run typecheck
```

Los tests no hacen red contra la API: usan un `fetch` inyectado y un servidor
HTTP local para comprobar cabeceras, cuerpo, reintentos, 401 sin reintento, 429
de cuota, parseo de errores, formato y CLI.

## Notas

- `jev-1.13-free` está limitado: devuelve `429 FreeUsageLimitError` fuera de
  OpenCode o al agotar la cuota. Para pruebas usa `jev-1.13`.
- El `Retry-After` del servidor se capa a 10 s para no bloquear el proceso.
- Jev está entrenado principalmente en inglés; acepta español con algo menos de
  precisión.
- Documentación de las preguntas: <https://docs.typesafe.ai/primitives>
