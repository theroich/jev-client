# jev-client

`jev` es una herramienta de consola que hace **preguntas a la API de Jev**
(System One de TypeSafe, a través de OpenCode) sobre un texto o un JSON.

Jev no redacta respuestas: **clasifica**. Le pasas un material (`state`) y una o
varias preguntas, y devuelve una respuesta por pregunta con probabilidades. Por
ejemplo, puedes preguntarle si un ticket es urgente, qué equipo debe atenderlo o
cuánto enfado transmite.

```sh
jev ask --state "Me han cobrado dos veces este mes." \
  --noul 'billing=¿Es de facturación?'
```

```
modelo: jev-1.13
  billing: noul=0.9
tokens: 283 in / 20 out, cost=1.189e-5
```

Además de la consola, incluye una **TUI**, una **consola web local** y un
**servidor MCP** para que lo use un agente. Todo comparte la misma configuración
y el mismo historial.

- [Instalación](#instalación)
- [Primer paso: la API key](#primer-paso-la-api-key)
- [Probar que todo funciona: `jev demo`](#probar-que-todo-funciona-jev-demo)
- [Preguntar: `jev ask`](#preguntar-jev-ask)
- [Repetir preguntas con plantillas](#repetir-preguntas-con-plantillas)
- [Preguntar en lote: `jev batch`](#preguntar-en-lote-jev-batch)
- [Consultar el historial](#consultar-el-historial)
- [Modo interactivo: `jev tui`](#modo-interactivo-jev-tui)
- [Consola web local](#consola-web-local)
- [Usar Jev desde un agente (MCP)](#usar-jev-desde-un-agente-mcp)
- [Analizar imágenes](#analizar-imágenes)
- [Problemas frecuentes](#problemas-frecuentes)

## Instalación

Necesitas **Node.js 20.9+** (o 22+) y una API key de
[OpenCode Console](https://opencode.ai/console).

```sh
cd jev-client
npm install
npm run build
```

Para tener el comando `jev` disponible en cualquier carpeta:

```sh
npm link          # opcional
jev demo
```

También puedes ejecutarlo sin enlazarlo:

```sh
node dist/src/bin.js demo
npm start -- demo
npm run dev -- demo   # compila y ejecuta
```

Si instalas el paquete publicado:

```sh
npm install -g jev-client
jev --help
```

## Primer paso: la API key

La forma más rápida es pasarla por variable de entorno:

```sh
export OPENCODE_API_KEY="sk-..."
```

o guardarla para no repetirla:

```sh
jev config set api_key "sk-..."
```

> La key guardada con `jev config set` queda en claro en tu base local. Si no
> quieres persistirla, usa `OPENCODE_API_KEY`, `JEV_API_KEY` o `--key`.

Comprueba lo que hay configurado:

```sh
jev config list
jev config get model
jev config get api_key          # la muestra enmascarada
jev config get api_key --reveal # la muestra completa
```

Cambiar el modelo o el timeout de forma permanente:

```sh
jev config set model jev-1.13
jev config set timeout 30
jev config set retries 2
jev config unset model          # vuelve al valor por defecto
jev config path                 # ruta de la base de datos en uso
```

La precedencia es **flag > variable de entorno > valor guardado > valor por
defecto**. Detalle completo en
[`docs/configuracion.md`](docs/configuracion.md).

## Probar que todo funciona: `jev demo`

```sh
jev demo
```

```
modelo: jev-1.13
  frustration: score=1.99 ≈ "Muy enfadado" (confidence=0.98)
    2=0.99, 1=0.01, 0=0
  is_urgent: noul=0.99
  team: choice=infra (confidence=0.52)
    infra=0.68, billing=0.32, sales=0
tokens: 449 in / 73 out, cost=1.886e-5
```

La probabilidad exacta varía ligeramente en cada llamada: lo relevante es la
opción elegida y su confianza.

Es un ejemplo integrado con urgencia, equipo y frustración. Si ves respuestas y
tokens, la key y la conexión funcionan.

`--json` imprime la respuesta cruda de la API, útil para procesarla con otra
herramienta:

```sh
jev demo --json | jq '.answers'
```

## Preguntar: `jev ask`

### Tres formas de preguntar

Jev admite tres tipos de pregunta. Todos se pueden escribir directamente en la
consola.

**Sí/no (`noul`)** — devuelve una probabilidad entre 0 y 1:

```sh
jev ask --state "Me han cobrado dos veces este mes." \
  --noul 'billing=¿Es de facturación?'
```

```
modelo: jev-1.13
  billing: noul=0.9
tokens: 283 in / 20 out, cost=1.189e-5
```

**Elegir una opción (`choice`)** — describes las opciones con `--option`:

```sh
jev ask --state "El checkout lleva caído 30 minutos." \
  --choice 'team=¿Qué equipo debería gestionar la incidencia?' \
  --option 'team.billing=Cobros, facturas o pagos' \
  --option 'team.infra=Caídas, errores 500 o problemas de plataforma' \
  --option 'team.sales=Precios o dudas comerciales'
```

```
modelo: jev-1.13
  team: choice=infra (confidence=0.61)
    infra=0.74, billing=0.26, sales=0
tokens: 354 in / 38 out, cost=1.487e-5
```

**Puntuar (`score`)** — los niveles se añaden en orden, del más bajo al más alto:

```sh
jev ask --state "Llevamos dos días sin respuesta." \
  --score 'urgency=¿Cómo de urgente es la incidencia?' \
  --level 'urgency=Puede esperar' --level 'urgency=Esta semana' \
  --level 'urgency=Hoy mismo'
```

```
modelo: jev-1.13
  urgency: score=1.29 ≈ "Esta semana" (confidence=0.47)
    1=0.65, 2=0.32, 0=0.03
tokens: 312 in / 18 out, cost=1.310e-5
```

`score` devuelve una media ponderada y puede salir decimal; cuando cae entre dos
niveles se muestra con `≈`.

Puedes combinar varias preguntas en una sola llamada: se evalúan contra el mismo
`state` y reciben una respuesta cada una.

```sh
jev ask --state "Me han cobrado dos veces y quiero el reembolso." \
  --noul 'refund=¿Pide un reembolso?' \
  --choice 'team=¿Qué equipo debe atenderlo?' \
  --option 'team.billing=Cobros' --option 'team.legal=Reclamaciones' \
  --score 'urgency=¿Cómo de urgente es?' \
  --level 'urgency=Puede esperar' --level 'urgency=Hoy'
```

### Qué se envía como `state`

Puede ser texto plano, un objeto JSON o un array:

```sh
jev ask --state "El cliente está enfadado." --noul 'angry=¿Está enfadado?'

jev ask --state '{"ticket":"Me han cobrado dos veces","plan":"pro"}' \
  --noul 'refund=¿Pide un reembolso?'

jev ask --state '["error 500","checkout caído"]' \
  --noul 'infra=¿Es un problema de plataforma?'
```

Si el texto empieza por `{` o `[`, se envía como JSON; si no, como string.

### Leer el material de stdin o de ficheros

```sh
echo "El checkout está caído" | jev ask --state - \
  --noul 'urgent=¿Es urgente?'
```

```sh
jev ask --state-file examples/state.json \
        --questions-file examples/questions.json
```

`examples/state.json` es el material y `examples/questions.json` las preguntas.
Útil cuando el JSON es largo o lo genera otro programa.

### Payload completo

Si ya tienes el request de Jev tal cual (`model`, `state` y `questions`):

```sh
jev ask --request-file examples/request.json
```

También admite JSON inline con `--request '{"..."}'`.

### Elegir modelo, endpoint y timeout

```sh
jev ask --model jev-1.13-free \
  --url https://opencode.ai/inference/systemone/v1/systemone \
  --timeout 60 --retries 3 \
  --state "hola" --noul 'q=¿Saludo?'
```

Flags útiles en `ask`, `demo` y `batch`:

| Flag | Para qué |
| --- | --- |
| `--json` | imprime la respuesta cruda de la API |
| `--no-save` | no guarda esta ejecución en el historial |
| `--db <ruta>` | usa otra base de datos |
| `--key <clave>` | API key solo para esta ejecución |
| `--model <modelo>` | modelo solo para esta ejecución |
| `--url <endpoint>` | endpoint completo solo para esta ejecución |
| `--timeout <s>` / `--retries <n>` | timeout y reintentos |

## Repetir preguntas con plantillas

Una **plantilla** es un request de Jev con huecos (`{{clave}}`) que se rellenan
con un contexto. Sirve para no repetir el mismo JSON cada vez.

### Crear una plantilla

El fichero [`examples/template.json`](examples/template.json) contiene:

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

Guárdala con un nombre:

```sh
jev template create pedido \
  --description "Pedido de cliente con macros" \
  --file examples/template.json \
  --macro-desc 'estado_de_pedido=Qué pide el cliente, en texto libre' \
  --macro-desc 'cliente.nombre=Nombre del cliente' \
  --macro-type 'cliente.plan=string'
```

```
plantilla guardada: pedido
```

Las macros se detectan solas del body. `--macro-desc` y `--macro-type` son
opcionales: añaden una descripción y un tipo para que la plantilla se entienda
mejor en la TUI, la consola web y los agentes.

También puedes pasar el body inline o por stdin:

```sh
jev template create saludo --body '{"model":"jev-1.13","state":"{{texto}}","questions":{"q":{"type":"noul","instructions":"¿Es un saludo?"}}}'
cat body.json | jev template create saludo --body -
```

`jev templates` es un alias de `jev template`.

### Ver y validar

```sh
jev template list
# pedido - Pedido de cliente con macros

jev template show pedido
```

`show` imprime el body y la lista de macros con su descripción y esquema.

```sh
jev template validate pedido
# plantilla válida: pedido
```

`validate` comprueba la plantilla sin llamar a Jev. También acepta un fichero:

```sh
jev template validate --file examples/template.json
```

### Rellenar y previsualizar

El contexto es un JSON con una clave por macro. Por ejemplo,
[`examples/context.json`](examples/context.json):

```json
{
  "estado_de_pedido": "Me han cobrado dos veces y quiero el reembolso.",
  "cliente": { "nombre": "Ana", "plan": "pro" }
}
```

```sh
jev template render pedido --context-file examples/context.json
```

```
{
  "model": "jev-1.13",
  "state": {
    "pedido": "Me han cobrado dos veces y quiero el reembolso.",
    "cliente": "Ana",
    "plan": "pro"
  },
  "questions": {
    "urgent": {
      "type": "noul",
      "instructions": "¿Es urgente?"
    }
  }
}
```

`render` no llama a Jev. Para ejecutar el resultado:

```sh
jev template render pedido --context-file examples/context.json > /tmp/request.json
jev ask --request-file /tmp/request.json
```

Reglas de las macros:

- `{{clave}}` busca la clave en el contexto. Admite rutas anidadas
  (`{{cliente.nombre}}`); si existe una clave literal con puntos, tiene
  prioridad.
- Si el texto es **exactamente** una macro, se inserta el valor con su tipo
  nativo (objeto, array, número, booleano). Si va embebida en una frase, se
  interpola como texto.
- `\{{...}}` deja la macro escrita sin resolver.
- Si falta alguna macro, el comando falla **antes** de llamar a la API y enumera
  todas las claves que faltan.

### Editar, describir y borrar

```sh
# Abrir el body en $EDITOR
jev template edit pedido

# Reemplazar el body desde un fichero
jev template edit pedido --file nuevo-body.json

# Añadir, cambiar o vaciar metadatos sin tocar el body
jev template edit pedido --macro-desc 'cliente.plan=Plan contratado'
jev template edit pedido --clear-macro-desc 'cliente.nombre'
jev template edit pedido --clear-macro-schema 'cliente.plan'

# Borrar (pide confirmación)
jev template delete pedido
jev template delete pedido --yes
```

`jev template add` y `jev template remove` son sinónimos rápidos de `create` y
`delete` sin confirmación.

## Preguntar en lote: `jev batch`

Ejecuta una plantilla una vez por cada contexto de un array JSON. Cada petición
queda en el historial bajo el mismo `batch_id`.

[`examples/contexts.json`](examples/contexts.json):

```json
[
  {
    "estado_de_pedido": "Me han cobrado dos veces y quiero el reembolso.",
    "cliente": { "nombre": "Ana", "plan": "pro" }
  },
  {
    "estado_de_pedido": "El checkout se queda colgado al pagar.",
    "cliente": { "nombre": "Luis", "plan": "free" }
  },
  {
    "estado_de_pedido": "No me llega la factura de este mes.",
    "cliente": { "nombre": "Marta", "plan": "pro" }
  }
]
```

```sh
jev batch pedido --contexts examples/contexts.json
```

```
batch: pedido — 3 peticiones (batch 4f3c…)
  1: ok    jev-1.13  306 in / 20 out  cost=1.3e-5
  2: ok    jev-1.13  302 in / 20 out  cost=1.3e-5
  3: ok    jev-1.13  302 in / 20 out  cost=1.3e-5
resumen: 3 ok, 0 error
tokens: 910 in / 60 out
coste: 3.8e-5
```

Si un contexto no encaja con la plantilla, esa fila muestra el error y el resto
continúa:

```
  2: error faltan macros en el contexto: cliente.plan
```

Opciones:

```sh
# Hasta 3 peticiones a la vez (máximo 10)
jev batch pedido --contexts examples/contexts.json --concurrency 3

# Parar en el primer error (por defecto sigue con el resto)
jev batch pedido --contexts examples/contexts.json --fail-fast

# Leer los contextos de stdin
cat contexts.json | jev batch pedido --contexts -
```

Con `--continue-on-error` (por defecto), un contexto inválido no cancela el
resto; el proceso sale con código `1` si hubo errores. Los resultados se
imprimen en el orden del fichero, aunque se ejecuten en paralelo.

## Consultar el historial

Todas las ejecuciones de `ask`, `demo` y `batch` se guardan en una base local
SQLite, también las que fallan.

```sh
jev history list                # una línea por petición, la más reciente primero
jev history show 12             # petición y respuesta completas
jev history export > hist.jsonl # una petición por línea (JSONL)
```

Filtrar:

```sh
jev history list --limit 20
jev history list --status 429
jev history list --model jev-1.13
jev history list --template pedido
jev history list --batch 4f3c…
jev history list --since 2026-10-01T00:00:00Z
```

Para no guardar una ejecución concreta, añade `--no-save` a `ask`, `demo` o
`batch`. La base vive en `~/.jev-client/db/jev.db` y se puede cambiar con
`--db` o `JEV_DB`. Detalle técnico en
[`docs/persistencia.md`](docs/persistencia.md).

## Modo interactivo: `jev tui`

Para configurar el provider y gestionar plantillas sin memorizar comandos:

```sh
jev tui
jev tui --db /ruta/jev.db
```

Tiene dos zonas:

- **Configuración**: `api_url`, `api_key`, `model`, `timeout` y `retries`, con
  validación mientras escribes. La key se muestra enmascarada.
- **Plantillas**: buscar, ver, crear, editar y borrar. Al editar, el JSON se
  valida en vivo y se muestran las macros detectadas.

| Tecla | Acción |
| --- | --- |
| `↑` / `↓` | mover la selección |
| `Enter` | elegir / confirmar |
| `Esc` | cancelar / volver |
| `q` | volver al menú (o salir) |
| `Ctrl-C` | salir (pide confirmación si hay cambios) |
| `n` / `e` / `d` / `/` | en plantillas: nueva, editar, borrar, buscar |

Los cambios se guardan en la misma base que usan `jev config` y
`jev template`, así que se ven desde fuera de la TUI. Sin terminal interactiva
`jev tui` sale con un error y propone los comandos equivalentes.

## Consola web local

Una interfaz gráfica con las mismas funciones, sin cuenta ni telemetría:

```sh
jev web-console
jev --web-console              # alias
jev web-console --port 0 --no-open
```

Abre en el navegador la URL que imprime. Pantallas:

| Pantalla | Para qué |
| --- | --- |
| **Resumen** | estado, métricas y prueba de conexión |
| **Evaluar** | lanzar preguntas `noul`, `choice` y `score` y ver probabilidades |
| **Plantillas** | crear, editar, validar y renderizar, con descripción y tipo por macro |
| **Lotes** | pegar un array de contextos, ejecutar y seguir el progreso |
| **Historial** | filtrar, ver el detalle y exportar |
| **Configuración** | editar la configuración y revelar la key solo si lo pides |

Cada pantalla muestra la orden de CLI equivalente. `--port`, `--host`,
`--allow-remote`, `--open`/`--no-open`, `--dev` y los flags de sesión se explican
en [`docs/web-console.md`](docs/web-console.md), junto con el modelo de
seguridad. `--allow-remote` expone una consola de administración: úsalo solo en
redes de confianza.

## Usar Jev desde un agente (MCP)

El servidor MCP permite que un agente descubra plantillas, rellene contextos y
ejecute peticiones sin que tú traduzcas la CLI.

```sh
jev mcp                          # servidor por stdio
jev-mcp                          # alias
jev mcp --read-only              # solo lectura
jev mcp --no-execute             # sin ejecutar contra Jev
jev mcp --allow-destructive      # permite borrar plantillas
```

Configuración en `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "jev": {
        "type": "local",
        "command": ["node", "dist/src/mcp-bin.js"],
        "environment": { "JEV_DB": "/Users/me/.jev-client/db/jev.db" }
      }
    }
  }
}
```

Con el paquete de npm:

```jsonc
{
  "mcp": {
    "servers": {
      "jev": { "type": "local", "command": ["npx", "-y", "jev-client", "mcp"] }
    }
  }
}
```

Además del catálogo fijo (`jev_ask`, `jev_batch`, `jev_template_*`,
`jev_history_*`, etc.), **cada plantilla guardada se expone como una tool** con
sus macros como parámetros. Catálogo completo, resources y permisos en
[`docs/mcp.md`](docs/mcp.md).

## Analizar imágenes

La API acepta imágenes en un campo `assets`, referenciadas desde el `state`.
Desde la CLI:

```sh
jev ask --state '{"foto":"gato"}' \
  --asset gato=foto.jpg \
  --choice 'animal=¿Qué animal aparece en `foto`?' \
  --option 'animal.GATO=Felino doméstico' \
  --option 'animal.PERRO=Canino doméstico'
```

- `--asset [<ref>=]<ruta>` se puede repetir; sin `<ref>` se genera un UUID.
- `--assets-file <ruta>` lee un mapa `assets` completo en JSON.
- Formatos: PNG/JPEG estático, hasta 16 MiB, lados de 280–1568 px.

La imagen debe estar referenciada en `state`, `instructions` o `criteria`, y la
API no redimensiona ni aplica la orientación EXIF. Límites, trampas y el detalle
del protocolo en [`docs/imagenes.md`](docs/imagenes.md).

## Problemas frecuentes

**`NODE_MODULE_VERSION` al arrancar.** El binario nativo de `better-sqlite3` se
instaló con otra versión de Node. Recompílalo:

```sh
npm rebuild better-sqlite3
```

**La base usa un esquema más nuevo.** Otra versión de `jev` escribió en la misma
base. Usa una base temporal:

```sh
jev ask --db "$(mktemp -d)/jev.db" --state "hola" --noul 'q=¿Saludo?'
```

**`429 FreeUsageLimitError`.** `jev-1.13-free` está limitado fuera de OpenCode o
al agotar la cuota. Para pruebas usa `jev-1.13`.

**`401` / `api_key_expired`.** Revisa la key con
`jev config get api_key --reveal` o vuelve a exportar `OPENCODE_API_KEY`.

**`422`.** La pregunta está mal formada: `choice` usa un objeto en `criteria` y
`score` usa un array ordenado.

**La consola web no arranca.** Comprueba el puerto (`--port 0` elige uno libre) y
que exista el build (`npm run build:web`). Más casos en
[`docs/solucion-problemas.md`](docs/solucion-problemas.md).

### Códigos de salida

| Código | Significado |
| --- | --- |
| `0` | Correcto |
| `1` | Error de API, red o configuración (falta la key, JSON inválido…) |
| `2` | Uso incorrecto (comando o flags inválidos) |

Los errores de autenticación (`401` / `api_key_expired`), cuota
(`FreeUsageLimitError`) y preguntas mal formadas (`422`) añaden una línea
`pista:` con la acción recomendada.

## Documentación técnica

El README es una guía de uso. El detalle de implementación vive en
[`docs/`](docs/README.md): arquitectura, persistencia, configuración, tipos de
pregunta, consola web, MCP, imágenes, uso como librería y desarrollo.

Para scripting por casos de uso, consulta también la skill
[`skills/jev-cli/`](skills/jev-cli/SKILL.md).
