# Manual de plantillas (`jev template`)

Una **plantilla** es un payload de Jev (un request: `model`, `state`,
`questions`) con **huecos** `{{clave}}` que se resuelven con un mapa de
contexto. Sirve para reutilizar una misma clasificación sin reescribir el JSON
cada vez, y para que un agente sepa qué datos de contexto necesita.

## Anatomía de una plantilla

```json
{
  "model": "jev-1.13",
  "state": {
    "pedido": "{{estado_de_pedido}}",
    "cliente": "{{cliente.nombre}}",
    "plan": "{{cliente.plan}}"
  },
  "questions": {
    "urgent": { "type": "noul", "instructions": "¿Es urgente?" }
  }
}
```

Reglas de las macros (ver `src/template.ts`):

- **`{{clave}}`** busca la clave en el contexto; admite **rutas anidadas**
  (`{{cliente.nombre}}`). Si existe una clave literal con puntos, se prefiere a
  la ruta anidada.
- **Inserción nativa**: si el string es **exactamente** una macro, se inserta el
  valor con su tipo (objeto, array, número, booleano). Si va embebida en texto,
  se interpola como string. Ej.: `"plan": "{{cliente.plan}}"` con
  `{ "cliente": { "plan": "pro" } }` → `"plan": "pro"`.
- **Escapado**: `\{{...}}` produce el texto literal `{{...}}` sin resolver.
- **Si falta una clave**, el comando falla **antes de llamar a la API** y lista
  todas las claves ausentes:

  ```text
  error: faltan macros en el contexto: cliente.plan
  ```

- El resultado se valida como request (model, state, questions y tipos de
  pregunta).

## Ciclo de vida completo

### `create` (y su alias `add`)

Guardar una plantilla desde un fichero (sobrescribe si el nombre ya existe):

```sh
jev template create pedido --description "Pedido con cliente" \
  --file examples/template.json \
  --macro-desc 'estado_de_pedido=Qué pide el cliente, en texto libre' \
  --macro-desc 'cliente.nombre=Nombre del cliente' \
  --macro-schema 'cliente.plan={"type":"string","enum":["free","pro","enterprise"]}' \
  --macro-type 'cliente.nombre=string'
```

```text
plantilla guardada: pedido
```

También inline o desde stdin:

```sh
jev template create pedido --body '{"model":"jev-1.13", ...}'
cat body.json | jev template create pedido --body -
```

`template add` es sinónimo de `create`; `--body-file <ruta>` es sinónimo de
`--file`.

### `list` y `show`

```sh
jev template list                       # pedido - Pedido con cliente
jev template list --json                # array con descripción, fechas y macros
jev template show pedido                # body + macros con descripción/esquema
jev template show pedido --json         # { name, description, body, macros, ... }
```

`show` en texto imprime descripción y esquema bajo cada macro:

```text
  {{cliente.plan}}
    Plan contratado por el cliente
    schema: {"type":"string","enum":["free","pro"]}
```

### `edit`

```sh
# Abre $EDITOR (o VISUAL); falla si no está definido
jev template edit pedido

# O reemplaza el body desde un fichero, sin abrir editor
jev template edit pedido --file nuevo.json

# Ajusta metadatos de macros sin tocar el body
jev template edit pedido --file nuevo.json \
  --macro-desc 'ticket=Identificador del pedido (TCK-1042)' \
  --clear-macro-desc 'cliente.nombre' \
  --macro-type 'ticket=string' \
  --clear-macro-schema 'cliente.plan'
```

Sin flags de macros, `edit` conserva descripciones y esquemas existentes.

### `validate`

Valida una plantilla guardada o un fichero **sin enviar nada** a la API:

```sh
jev template validate pedido
jev template validate --file examples/template.json
```

```text
plantilla válida: pedido
```

Útil en CI para comprobar que los bodies del repo son requests válidos.

### `render`

Previsualiza el request resuelto **sin llamar a Jev** (no gasta tokens):

```sh
jev template render pedido --context-file examples/context.json
```

```json
{
  "model": "jev-1.13",
  "state": {
    "pedido": "Me han cobrado dos veces y quiero el reembolso.",
    "cliente": "Ana",
    "plan": "pro"
  },
  "questions": {
    "urgent": { "type": "noul", "instructions": "¿Es urgente?" }
  }
}
```

También con el contexto inline: `jev template render pedido --context '{"estado_de_pedido":"pendiente","cliente":{"nombre":"Ana","plan":"pro"}}'`.

### `delete` (y su alias `remove`)

```sh
jev template delete pedido       # pide confirmación
jev template delete pedido --yes # sin confirmación
jev template remove pedido       # alias de delete sin confirmación
```

## Metadatos de macros

Cada macro puede llevar **descripción** y **JSON Schema** (informativo). No se
envían a Jev ni alteran el renderizado: solo ayudan a humanos y agentes.

| Flag | Efecto |
| --- | --- |
| `--macro-desc <clave>=<texto>` | describe la macro (repetible; máx. 500 chars) |
| `--clear-macro-desc <clave>` | vacía la descripción |
| `--macro-schema <clave>=<json>` | guarda un JSON Schema completo (objeto o booleano) |
| `--macro-type <clave>=<tipo>` | atajo de `{"type":"<tipo>"}` |
| `--clear-macro-schema <clave>` | elimina el esquema conservando la descripción |

Tipos admitidos por `--macro-type`: `string`, `number`, `integer`, `boolean`,
`object`, `array`, `null`.

## Plantilla mínima por cada tipo de pregunta

Los starters de `src/template-starters.ts` comparten el mismo `state` con macros
(`{{estado_de_pedido}}`, `{{cliente.nombre}}`, `{{cliente.plan}}`) que resuelve
`examples/context.json`, de modo que se pueden renderizar nada más crearlos.

### `noul`

```json
{
  "model": "jev-1.13",
  "state": {
    "ticket": "{{estado_de_pedido}}",
    "cliente": "{{cliente.nombre}}",
    "plan": "{{cliente.plan}}"
  },
  "questions": {
    "urgent": { "type": "noul", "instructions": "¿Es urgente?" }
  }
}
```

### `choice`

```json
{
  "model": "jev-1.13",
  "state": {
    "ticket": "{{estado_de_pedido}}",
    "cliente": "{{cliente.nombre}}",
    "plan": "{{cliente.plan}}"
  },
  "questions": {
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
}
```

### `score`

```json
{
  "model": "jev-1.13",
  "state": {
    "ticket": "{{estado_de_pedido}}",
    "cliente": "{{cliente.nombre}}",
    "plan": "{{cliente.plan}}"
  },
  "questions": {
    "urgency": {
      "type": "score",
      "instructions": "¿Cómo de urgente es la incidencia?",
      "criteria": ["Puede esperar", "Esta semana", "Hoy mismo"]
    }
  }
}
```

## Casos reales end-to-end

### Caso 1: clasificación de tickets de soporte

Crea la plantilla, valida, renderiza en seco y ejecuta:

```sh
# 1. Guardar la plantilla
jev template create soporte --description "Clasifica un ticket de soporte" \
  --file examples/template.json \
  --macro-desc 'estado_de_pedido=Descripción del ticket en texto libre' \
  --macro-desc 'cliente.nombre=Nombre del cliente' \
  --macro-desc 'cliente.plan=Plan del cliente'

# 2. Validar en seco (sin gastar tokens)
jev template validate soporte

# 3. Renderizar en seco para revisar el request resuelto
jev template render soporte --context-file examples/context.json

# 4. Ejecutar de verdad
jev template render soporte --context-file examples/context.json > /tmp/req.json
jev ask --request-file /tmp/req.json --json 2>/dev/null | jq '.answers'
```

### Caso 2: triaje de incidencias en lote (`batch`)

Con `examples/contexts.json` (array de tres contextos) ejecuta la plantilla una
vez por contexto:

```sh
jev batch soporte --contexts examples/contexts.json
```

```text
batch: soporte — 3 peticiones (batch 4f3c…)
  1: ok    jev-1.13  12 in / 3 out  cost=1.5e-6
  2: ok    jev-1.13  12 in / 3 out  cost=1.5e-6
  3: ok    jev-1.13  12 in / 3 out  cost=1.5e-6
resumen: 3 ok, 0 error
tokens: 36 in / 9 out
coste: 4.5e-6
```

Con concurrencia, `--fail-fast` y `--json`:

```sh
jev batch soporte --contexts examples/contexts.json \
  --concurrency 3 --fail-fast --json 2>/dev/null | jq '.ok, .errors'
```

El `--json` de `batch` imprime un único objeto con `batch_id`, `template`,
`total`, `processed`, `skipped`, `ok`, `errors`, `input_tokens`,
`output_tokens`, `cost`, `cost_unknown` y `items` (uno por contexto, en orden,
con `index`, `ok`, `model`, tokens, `cost`, `error` y `response` cruda).

Reglas de `batch`:

- `--contexts <fichero.json>` espera un array de mapas de contexto; `-` lee de
  stdin.
- `--concurrency <n>` peticiones simultáneas (default `1`, máx. `10`).
- `--continue-on-error` (default) sigue con el resto; `--fail-fast` se detiene
  ante el primer error. Con errores, el proceso sale con código `1`.
- Cada petición genera una fila en el historial con el mismo `batch_id` y su
  `template_name`.

### Caso 3: priorización de leads

```json
{
  "model": "jev-1.13",
  "state": {
    "empresa": "{{empresa}}",
    "sector": "{{sector}}",
    "mensaje": "{{mensaje}}"
  },
  "questions": {
    "prioridad": {
      "type": "score",
      "instructions": "¿Cómo de prioritario es este lead?",
      "criteria": ["Baja", "Media", "Alta"]
    },
    "interes": {
      "type": "noul",
      "instructions": "¿Muestra intención de compra?"
    }
  }
}
```

### Caso 4: moderación de contenido

```json
{
  "model": "jev-1.13",
  "state": {
    "texto": "{{texto}}"
  },
  "questions": {
    "decision": {
      "type": "choice",
      "instructions": "¿El contenido es publicable?",
      "criteria": {
        "ok": "Publicable tal cual",
        "revisar": "Necesita revisión humana",
        "bloquear": "Infringe las normas"
      }
    }
  }
}
```

## `render` como dry-run y `validate` en CI

- **`render`** resuelve las macros y previsualiza el request **sin gastar
  tokens**. Es el paso previo recomendado antes de cualquier ejecución real.
- **`validate`** comprueba la estructura del body (o de un fichero) sin enviar
  nada; encaja en CI para que los bodies versionados en el repo no se rompan:

  ```sh
  jev template validate --file templates/soporte.json
  ```

## Plantillas + scripts bash

Crear/actualizar la plantilla desde un fichero, renderizar, ejecutar y filtrar
con `jq`, todo no interactivo:

```bash
#!/usr/bin/env bash
set -uo pipefail

DB="$(mktemp -d)/jev.db"
trap 'rm -rf "$(dirname "$DB")"' EXIT

TICKET="${1:-El checkout lleva caído 30 minutos y perdemos ventas.}"

# 1. Crear la plantilla desde un body inline con una macro {{ticket}}.
jev template create moderacion --description "Modera un texto" --db "$DB" \
  --body '{
    "model": "jev-1.13",
    "state": { "texto": "{{ticket}}" },
    "questions": {
      "decision": {
        "type": "choice",
        "instructions": "¿El contenido es publicable?",
        "criteria": { "ok": "Publicable", "revisar": "Revisar", "bloquear": "Bloquear" }
      }
    }
  }' \
  --macro-desc 'ticket=Texto a moderar'

# 2. Renderizar en seco y comprobar que resuelve (sin gastar tokens).
if ! jev template render moderacion --db "$DB" \
     --context "$(jq -nc --arg t "$TICKET" '{ticket:$t}')" > /tmp/req.json; then
  echo "error: el render falló (faltan macros o body inválido)" >&2
  exit 1
fi

# 3. Ejecutar y quedarnos solo con la decisión.
jev ask --db "$DB" --no-save --json --request-file /tmp/req.json 2>/dev/null \
  | jq -r '.answers.decision.choice'
```

## Buenas prácticas

- **Versiona los bodies en el repo** (p. ej. `templates/*.json`) y créalos en
  CI con `jev template create --file`; así la plantilla es reproducible y
  auditable.
- **Una macro por variable de contexto**: `{{estado_de_pedido}}` y
  `{{cliente.nombre}}` por separado, en lugar de un único `{{todo}}` concatenado.
  Facilita documentar y tipar cada macro con `--macro-desc`/`--macro-type`.
- **`state` estructurado en lugar de concatenar texto**: un objeto con campos
  separados se evalúa mejor que un párrafo plano, y permite rutas anidadas.
- **Describe las macros** (`--macro-desc`) y, si hay un dominio finito,
  **tipa con `--macro-type` o `--macro-schema`**: ayuda a los agentes a generar
  contextos válidos (y a la tool MCP por plantilla).
- **`render` antes de gastar tokens**: resuelve y valida sin llamar a la API;
  es el dry-run barato.
- **`--no-save` y `--db` temporal en scripts** para no contaminar el historial
  ni la base del usuario.
- Recuerda que descripción y esquema de macro **no se envían a Jev**: son
  metadatos locales, no cambian el resultado.
