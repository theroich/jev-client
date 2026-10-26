# Operación `choice`

## 1. Qué es y qué devuelve

`choice` clasifica el `state` en **una opción entre varias** fijas. `criteria`
es un **objeto** `{ clave: descripción }`, donde `clave` es el valor que el
modelo puede elegir y `descripción` explica qué significa.

Forma exacta de la respuesta (por pregunta):

```json
{
  "type": "choice",
  "choice": "infra",
  "confidence": 0.59,
  "probabilities": { "infra": 0.73, "billing": 0.27, "sales": 0 }
}
```

- `choice`: la clave de `criteria` elegida.
- `confidence`: confianza (0–1) de la elección.
- `probabilities`: probabilidad por cada clave de `criteria`.

En el informe legible de la CLI:

```text
  team: choice=infra (confidence=0.59)
    infra=0.73, billing=0.27, sales=0
```

Las probabilidades se ordenan de mayor a menor.

## 2. Forma del JSON de la pregunta

```json
{
  "team": {
    "type": "choice",
    "instructions": "¿Qué equipo debería gestionar la incidencia?",
    "criteria": {
      "billing": "Cobros, facturas o pagos",
      "infra": "Caídas, errores 500 o problemas de plataforma",
      "sales": "Precios o dudas comerciales"
    }
  }
}
```

`criteria` es **obligatorio** en `choice` (objeto no vacío). Sin `criteria`, la
petición llega mal formada y suele terminar en un `422`.

## 3. Ejemplos de consola

### Inline con `--state` y `--questions`

```sh
jev ask \
  --state "El checkout lleva caído 30 minutos y perdemos ventas." \
  --questions '{"team":{"type":"choice","instructions":"¿Qué equipo debería gestionar la incidencia?","criteria":{"billing":"Cobros, facturas o pagos","infra":"Caídas, errores 500 o problemas de plataforma","sales":"Precios o dudas comerciales"}}}'
```

```text
modelo: jev-1.13
  team: choice=infra (confidence=0.59)
    infra=0.73, billing=0.27, sales=0
tokens: 22 in / 6 out, cost=3.1e-6      ← a stderr
```

### Desde ficheros (`--state-file`, `--questions-file`)

```sh
jev ask --state-file examples/state.json --questions-file examples/questions.json
```

La pregunta `team` de `examples/questions.json` es un `choice` con
`billing`/`infra`/`sales`.

### Por stdin (`--state -`)

```sh
printf 'La factura de este mes no me ha llegado.' | jev ask --state - \
  --questions '{"team":{"type":"choice","instructions":"¿Qué equipo debe atenderlo?","criteria":{"billing":"Facturas","infra":"Caídas","sales":"Comercial"}}}'
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
    "team": {
      "type": "choice",
      "choice": "billing",
      "confidence": 0.61,
      "probabilities": { "billing": 0.61, "infra": 0.25, "sales": 0.14 }
    }
  },
  "usage": { "input_tokens": 130, "output_tokens": 21, "cost": 4.1e-6 }
}
```

### Mezclando varios tipos en un mismo request

`examples/request.json` combina `refund` (`noul`) y `tone` (`choice`):

```sh
jev ask --request-file examples/request.json
```

```text
modelo: jev-1.13
  refund: noul=0.96
  tone: choice=angry (confidence=0.8)
    angry=0.8, calm=0.2
tokens: 96 in / 14 out, cost=2.2e-6
```

## 4. Ejemplo en script bash

Función reutilizable, lectura del resultado con `jq`, `case` sobre la respuesta
y manejo de códigos de salida:

```bash
#!/usr/bin/env bash

DB="$(mktemp -d)/jev.db"
trap 'rm -rf "$(dirname "$DB")"' EXIT

# Clasifica un texto y devuelve la clave elegida.
classify() {
  local state="$1"
  local questions='{
    "team": {
      "type": "choice",
      "instructions": "¿Qué equipo debería gestionar la incidencia?",
      "criteria": {
        "billing": "Cobros, facturas o pagos",
        "infra": "Caídas, errores 500 o problemas de plataforma",
        "sales": "Precios o dudas comerciales"
      }
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

  # Clave elegida + confianza, separadas por tabulador.
  jq -r '[.answers.team.choice, .answers.team.confidence] | @tsv' <<<"$out"
}

ticket="El checkout lleva caído 30 minutos y perdemos ventas."

read -r team conf <<<"$(classify "$ticket")" || exit $?

echo "equipo: $team (confianza: $conf)"

case "$team" in
  billing) echo "→ asignar a facturación" ;;
  infra)   echo "→ asignar a infraestructura" ;;
  sales)   echo "→ asignar a ventas" ;;
  *)       echo "→ revisión manual" ;;
esac
```

```text
equipo: infra (confianza: 0.59)
→ asignar a infraestructura
```

Notas del script:

- `jq -r '[…] | @tsv'` produce `infra<TAB>0.59`, que `read -r team conf` separa
  por el tabulador (IFS por defecto).
- `--no-save` + `--db` temporal evitan ensuciar el historial del usuario.
- El `case` despacha la decisión; si `classify` falla, se propaga su código de
  salida.

## 5. Errores típicos y pistas

- **`criteria` con la forma equivocada** — en `choice` debe ser un **objeto**
  `{ clave: descripción }`. Pasar un array (`["a","b"]`) o un string produce una
  pregunta mal formada; usa array ordenado para `score`, no para `choice`.
- **`criteria` vacío o ausente** — `choice` exige al menos una clave; sin
  `criteria` la API responde `422` (la CLI añade `pista:`).
- **`401` / `api_key_expired`** — key inválida/caducada; la CLI sugiere renovarla
  en https://opencode.ai/console.
- **`429 FreeUsageLimitError`** — cuota agotada; prueba `--model jev-1.13`.
- **`422`** — pregunta mal formada (tipo inválido, falta `criteria`) o fallo
  upstream; revisa https://docs.typesafe.ai/primitives.
- **Timeouts y reintentos** — `--timeout` (default 30 s) por intento y
  `--retries` (default 2) ante 429/5xx y errores de red.

## 6. Notas de precisión

El modelo está entrenado sobre todo en inglés; acepta español con algo menos de
precisión. Haz las descripciones de `criteria` **mutuamente excluyentes y
explícitas** para que la clasificación sea estable: «Cobros, facturas o pagos»
es más fiable que «billing».
