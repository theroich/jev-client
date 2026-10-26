# Operación `noul`

## 1. Qué es y qué devuelve

`noul` es la pregunta de **sí/no**: dada una instrucción («¿trata de
facturación?», «¿es urgente?», «¿pide reembolso?»), el modelo devuelve la
probabilidad de que la respuesta sea «sí».

Forma exacta de la respuesta (por pregunta):

```json
{ "type": "noul", "noul": 0.99 }
```

- `noul`: número en `[0, 1]` — probabilidad de «sí».
- No lleva `confidence` ni `probabilities` (eso es de `choice`/`score`).

En el informe legible de la CLI se imprime una línea:

```text
  billing: noul=0.99
```

## 2. Forma del JSON de la pregunta

Mínima (solo `instructions`):

```json
{
  "billing": { "type": "noul", "instructions": "¿El mensaje trata de facturación o pagos?" }
}
```

Con `criteria` opcional (un string que ayuda al modelo a definir el criterio):

```json
{
  "urgent": {
    "type": "noul",
    "instructions": "¿El mensaje transmite urgencia?",
    "criteria": "Se considera urgente si menciona caídas, pérdidas o plazos."
  }
}
```

## 3. Ejemplos de consola

### Inline con `--state` y `--noul`

```sh
jev ask \
  --state "Me han cobrado dos veces este mes." \
  --noul 'billing=¿Es de facturación?'
```

```text
modelo: jev-1.13
  billing: noul=0.99
tokens: 12 in / 3 out, cost=1.5e-6      ← va a stderr
```

> Los valores numéricos son ilustrativos; el **formato** es el que imprime la
> CLI. La línea `tokens:` va a stderr, no a stdout.

### Desde ficheros (`--state-file`, `--questions-file`)

```sh
jev ask --state-file examples/state.json --questions-file examples/questions.json
```

`examples/questions.json` mezcla los tres tipos; la parte `noul` es `billing`.

### Por stdin (`--state -`)

```sh
echo "El checkout está caído" | jev ask --state - \
  --noul 'urgent=¿Es urgente?'
```

### Con `--json` para consumo por máquina

```sh
jev ask --state "Me han cobrado dos veces este mes." \
  --noul 'billing=¿Es de facturación?' \
  --json 2>/dev/null
```

```json
{
  "model": "jev-1.13",
  "answers": {
    "billing": { "type": "noul", "noul": 0.99 }
  },
  "usage": { "input_tokens": 12, "output_tokens": 3, "cost": 1.5e-6 }
}
```

`--json` imprime la respuesta cruda de la API a stdout; el resumen de tokens va
a stderr, por eso `2>/dev/null` lo descarta al redirigir a un fichero.

### Mezclando varios tipos en un mismo request

```sh
jev ask --request-file examples/request.json --json 2>/dev/null
```

`examples/request.json` combina `refund` (`noul`) y `tone` (`choice`) en un solo
request. La respuesta devuelve una entrada por pregunta:

```json
{
  "model": "jev-1.13",
  "answers": {
    "refund": { "type": "noul", "noul": 0.99 },
    "tone": { "type": "choice", "choice": "angry", "confidence": 0.8, "probabilities": { "angry": 0.8, "calm": 0.2 } }
  },
  "usage": { "input_tokens": 96, "output_tokens": 14, "cost": 2.2e-6 }
}
```

## 4. Ejemplo en script bash

Función reutilizable, lectura con `jq`, umbral sobre la respuesta y manejo de
códigos de salida:

```bash
#!/usr/bin/env bash

# Base aislada: no toca la del usuario y se borra al salir.
DB="$(mktemp -d)/jev.db"
trap 'rm -rf "$(dirname "$DB")"' EXIT

# Evalúa una pregunta noul y devuelve la probabilidad de "sí" (0-1).
ask_noul() {
  local state="$1" instructions="$2"

  local out code
  out=$(jev ask --db "$DB" --no-save --json \
          --state "$state" --noul "q=$instructions" 2>/dev/null)
  code=$?

  if [ "$code" -ne 0 ]; then
    echo "error: jev ask salió con código $code" >&2
    return "$code"
  fi

  jq -r '.answers.q.noul' <<<"$out"
}

ticket="Me han cobrado dos veces este mes."

result=$(ask_noul "$ticket" "¿Trata de facturación o pagos?") || exit $?

echo "probabilidad de facturación: $result"

# Umbral: >= 0.5 se trata como "sí".
if awk "BEGIN{exit !($result >= 0.5)}"; then
  echo "→ derivar a facturación"
else
  echo "→ no es facturación"
fi
```

```text
probabilidad de facturación: 0.99
→ derivar a facturación
```

Notas del script:

- `--no-save` evita registrar la ejecución en el historial; `--db "$DB"` aísla
  la base en un directorio temporal.
- `--json` + `2>/dev/null` deja solo el JSON en stdout para `jq`.
- El código de salida de `jev ask` se captura y se propaga: `0` ok, `1` error de
  API/configuración, `2` uso incorrecto.

## 5. Errores típicos y pistas

- **`401` / `api_key_expired`** — key inválida o caducada. La CLI añade
  `pista:` con la acción recomendada (crear una nueva en
  https://opencode.ai/console y exportarla como `OPENCODE_API_KEY`).
- **`429 FreeUsageLimitError`** — cuota del modelo gratuito agotada o uso fuera
  de OpenCode. Prueba con `--model jev-1.13`.
- **`422`** — pregunta mal formada o fallo del upstream; revisa
  https://docs.typesafe.ai/primitives.
- **`criteria` con la forma equivocada** — en `noul`, `criteria` es un string
  opcional, no un objeto ni un array. Un objeto/array aquí es para
  `choice`/`score`.
- **Todas las preguntas dan la misma probabilidad** — si evalúas varios
  elementos en un solo request, nómbralos en cada `instructions`: la clave no
  se envía al modelo y `state` es compartido (ver
  [`anatomia-pregunta.md`](anatomia-pregunta.md)).
- **Falta la API key** — `error: falta la API key` (código `1`). Usa `--key`,
  `OPENCODE_API_KEY`/`JEV_API_KEY`, o `jev config set api_key`.
- **Timeouts y reintentos** — cada intento tiene `--timeout` (default 30 s) y
  `--retries` (default 2) ante 429/5xx y errores de red; el `Retry-After` se
  capa a 10 s.

## 6. Notas de precisión

El modelo está entrenado sobre todo en inglés; acepta español con algo menos de
precisión. Para mitigarlo, formula `instructions` de forma explícita y pon el
criterio dentro de la instrucción (o usa `criteria` como string): «¿El mensaje
trata de facturación o pagos?» es más fiable que «¿facturación?».
