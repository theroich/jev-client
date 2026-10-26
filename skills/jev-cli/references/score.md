# Operación `score`

## 1. Qué es y qué devuelve

`score` asigna una **nota dentro de una escala ordenada**. `criteria` es un
**array ordenado** `[nivel0, nivel1, …]`; la posición en el array es la nota
(`0` el primero, `1` el segundo…). Sirve para urgencia, frustración,
prioridad, gravedad…

Forma exacta de la respuesta (por pregunta):

```json
{
  "type": "score",
  "score": 1.99,
  "confidence": 0.98,
  "legend": { "0": "Puede esperar", "1": "Esta semana", "2": "Hoy mismo" },
  "probabilities": { "2": 0.99, "1": 0.01, "0": 0 }
}
```

- `score`: media ponderada de la nota; puede ser decimal.
- `legend`: mapa `"posición" -> etiqueta` de tu `criteria`.
- `probabilities`: probabilidad por cada posición.

En el informe legible de la CLI, cuando el `score` cae entre dos niveles se
marca con `≈`:

```text
  urgency: score=1.99 ≈ "Hoy mismo" (confidence=0.98)
    2=0.99, 1=0.01, 0=0
```

Cuando cae exacto en un nivel, no lleva `≈`.

## 2. Forma del JSON de la pregunta

```json
{
  "urgency": {
    "type": "score",
    "instructions": "¿Cómo de urgente es la incidencia?",
    "criteria": ["Puede esperar", "Esta semana", "Hoy mismo"]
  }
}
```

`criteria` es **obligatorio** en `score`: un array ordenado, de menor a mayor.

## 3. Ejemplos de consola

### Inline con `--state` y `--questions`

```sh
jev ask \
  --state "Llevamos dos días sin respuesta y el checkout está caído." \
  --questions '{"urgency":{"type":"score","instructions":"¿Cómo de urgente es la incidencia?","criteria":["Puede esperar","Esta semana","Hoy mismo"]}}'
```

```text
modelo: jev-1.13
  urgency: score=1.99 ≈ "Hoy mismo" (confidence=0.98)
    2=0.99, 1=0.01, 0=0
tokens: 20 in / 5 out, cost=2.9e-6      ← a stderr
```

### Desde ficheros (`--state-file`, `--questions-file`)

```sh
jev ask --state-file examples/state.json --questions-file examples/questions.json
```

La pregunta `urgency` de `examples/questions.json` es un `score` con
`["Puede esperar", "Esta semana", "Hoy mismo"]`.

### Por stdin (`--state -`)

```sh
echo "El cliente amenaza con darse de baja." | jev ask --state - \
  --questions '{"frustracion":{"type":"score","instructions":"¿Cómo de frustrado está el cliente?","criteria":["Tranquilo","Molesto","Muy enfadado"]}}'
```

### Con `--json` para consumo por máquina

```sh
jev ask --state-file examples/state.json --questions-file examples/questions.json \
  --json 2>/dev/null
```

```json
{
  "model": "jev-1.13",
  "answers": {
    "urgency": {
      "type": "score",
      "score": 0.42,
      "confidence": 0.79,
      "legend": { "0": "Puede esperar", "1": "Esta semana", "2": "Hoy mismo" },
      "probabilities": { "0": 0.61, "1": 0.36, "2": 0.03 }
    }
  },
  "usage": { "input_tokens": 130, "output_tokens": 19, "cost": 3.7e-6 }
}
```

### Mezclando varios tipos en un mismo request

`jev demo` ejecuta los tres tipos a la vez (`is_urgent` noul, `team` choice,
`frustration` score):

```sh
jev demo
```

```text
modelo: jev-1.13
  frustration: score=1.99 ≈ "Muy enfadado" (confidence=0.98)
    2=0.99, 1=0.01, 0=0
  is_urgent: noul=0.99
  team: choice=infra (confidence=0.59)
    infra=0.73, billing=0.27, sales=0
tokens: 449 in / 73 out, cost=1.886e-5
```

## 4. Ejemplo en script bash

Función reutilizable, lectura del resultado con `jq`, umbral sobre el score y
manejo de códigos de salida:

```bash
#!/usr/bin/env bash

DB="$(mktemp -d)/jev.db"
trap 'rm -rf "$(dirname "$DB")"' EXIT

# Puntúa urgencia y devuelve "score<TAB>nivel" (etiqueta más cercana).
score_urgencia() {
  local state="$1"
  local questions='{
    "urgency": {
      "type": "score",
      "instructions": "¿Cómo de urgente es la incidencia?",
      "criteria": ["Puede esperar", "Esta semana", "Hoy mismo"]
    }
  }'

  local out code
  out=$(jev ask --db "$DB" --no-save --json \
          --state "$state" --questions "$questions" 2>/dev/null)
  code=$?

  if [ "$code" -ne 0 ]; then
    echo "error: jev ask salió con código $code" >&2
    return "$code"
  fi

  # score + etiqueta del nivel redondeado (clave "0"/"1"/"2" del legend).
  jq -r '
    .answers.urgency as $u
    | ($u.score | round | tostring) as $k
    | [($u.score | tostring), ($u.legend[$k] // "?")]
    | @tsv
  ' <<<"$out"
}

ticket="El checkout está caído desde hace una hora."

read -r score nivel <<<"$(score_urgencia "$ticket")" || exit $?

echo "urgencia: $score → $nivel"

# Umbral sobre el score (>= 1 se considera urgente).
if awk "BEGIN{exit !($score >= 1)}"; then
  echo "→ escalar hoy"
else
  echo "→ planificar"
fi
```

```text
urgencia: 1.99 → Hoy mismo
→ escalar hoy
```

Notas del script:

- `round` sobre el score localiza el nivel del `legend` (la CLI usa el mismo
  criterio para imprimir la etiqueta, con `≈` cuando no es exacto).
- `--no-save` + `--db` temporal aíslan la ejecución.
- El código de salida de `jev ask` se captura y propaga (`0`/`1`/`2`).

## 5. Errores típicos y pistas

- **`criteria` con la forma equivocada** — en `score` debe ser un **array
  ordenado** (`["a","b","c"]`). Pasar un objeto `{ "0": "a", … }` o un string
  produce una pregunta mal formada; usa objeto para `choice`.
- **`criteria` vacío o ausente** — `score` exige al menos dos niveles; sin
  `criteria` la API responde `422` (la CLI añade `pista:`).
- **Orden del array** — la posición define la nota; asegúrate de ordenar de
  menor a mayor intensidad, o el resultado será contraintuitivo.
- **`401` / `api_key_expired`** — key inválida/caducada; renueva en
  https://opencode.ai/console.
- **`429 FreeUsageLimitError`** — cuota agotada; prueba `--model jev-1.13`.
- **`422`** — pregunta mal formada o fallo upstream; revisa
  https://docs.typesafe.ai/primitives.
- **Timeouts y reintentos** — `--timeout` (default 30 s) por intento y
  `--retries` (default 2) ante 429/5xx y errores de red.

## 6. Notas de precisión

El modelo está entrenado sobre todo en inglés; acepta español con algo menos de
precisión. Con escalas subjetivas, haz los niveles **mutuamente excluyentes y
anclados a señales observables** («Puede esperar», «Esta semana», «Hoy mismo»
son más estables que «poco», «algo», «mucho») y pon el criterio dentro de la
`instructions` («¿cómo de urgente es la incidencia en términos de plazo?»).
