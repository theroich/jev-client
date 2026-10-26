---
name: jev-cli
description: >
  Documentación de la CLI `jev` (jev-client) organizada por casos de uso.
  Activa esta skill cuando quieras resolver una tarea concreta con `jev` por
  consola: clasificar un ticket con `choice`, puntuar urgencia con `score`,
  decidir un sí/no con `noul`, invocar `jev` de forma no interactiva desde un
  script bash (parseando el resultado con `jq` y manejando los códigos de
  salida), o crear y reutilizar plantillas con macros. Úsala también cuando
  necesites saber qué comando ejecutar para «quiero X».
---

# Skill de la CLI de `jev` por casos de uso

`jev` (el binario de **jev-client**) consume la API de Jev (System One de
TypeSafe) vía OpenCode. No genera texto: recibe un `state` y una o más
preguntas tipadas y devuelve **una respuesta por pregunta con probabilidades**.

Esta skill documenta **cómo invocar la CLI por consola y desde scripts**, por
tipo de operación. Es un índice y un contrato de scripting: el detalle de cada
operación vive en `references/*.md`. No duplica el [`README.md`](../../README.md),
lo resume y enlaza.

## Requisitos y arranque rápido

- Node.js 20.9+ (o 22+).
- Una API key de [OpenCode Console](https://opencode.ai/console).

```sh
cd jev-client
npm install
npm run build
export OPENCODE_API_KEY="sk-..."   # o JEV_API_KEY

npm link        # opcional: deja `jev` disponible en el PATH
jev demo        # ejemplo integrado end-to-end
```

Sin enlazar:

```sh
node dist/src/bin.js demo
npm start -- demo
npm run dev -- demo   # compila y ejecuta
```

## Configuración mínima

Precedencia: **flag > variable de entorno > base SQLite > valor por defecto**.
Las cadenas vacías cuentan como no definidas.

| Qué | Flag | Variable | Clave SQLite | Default |
| --- | --- | --- | --- | --- |
| API key | `--key` | `OPENCODE_API_KEY` o `JEV_API_KEY` | `api_key` | — (obligatoria) |
| Endpoint | `--url` | `JEV_URL` | `api_url` | `https://opencode.ai/inference/systemone/v1/systemone` |
| Modelo | `--model` | `JEV_MODEL` | `model` | `jev-1.13` |
| Timeout (s) | `--timeout` | — | `timeout` | `30` |
| Reintentos | `--retries` | — | `retries` | `2` |
| Base SQLite | `--db` | `JEV_DB` | — | `~/.jev-client/db/jev.db` |

`--url` espera el **endpoint completo**. La API key guardada con
`jev config set api_key` queda en claro en SQLite; para no persistirla usa
`--key` o las variables de entorno.

## Tabla resumen de los tres tipos de pregunta

| `type` | Campos obligatorios | Forma de `criteria` | Qué devuelve |
| --- | --- | --- | --- |
| `noul` | `instructions` | opcional (string) | `noul`: probabilidad de «sí» (0–1) |
| `choice` | `instructions`, `criteria` | **objeto** `{ clave: descripción }` | `choice`, `confidence`, `probabilities` |
| `score` | `instructions`, `criteria` | **array ordenado** `[nivel0, nivel1, …]` | `score`, `legend`, `probabilities` |

En `score`, la posición del array es la nota: `0` el primer nivel, `1` el
segundo… El `score` es una media ponderada y puede ser decimal; cuando cae
entre dos niveles se muestra con `≈`.

## Tabla de decisión

| Quiero… | Comando | Referencia |
| --- | --- | --- |
| Decidir sí/no (¿es facturación?, ¿es urgente?) | `jev ask --questions '{"q":{"type":"noul",…}}'` | [`references/noul.md`](references/noul.md) |
| Clasificar entre opciones fijas (equipo, tono, categoría) | `jev ask --questions '{"q":{"type":"choice",…}}'` | [`references/choice.md`](references/choice.md) |
| Puntuar en una escala ordenada (urgencia, frustración) | `jev ask --questions '{"q":{"type":"score",…}}'` | [`references/score.md`](references/score.md) |
| Ejecutar cualquiera de lo anterior en un script bash | `jev ask … --json` + `jq` | el fichero de la operación |
| Guardar un request con huecos y reutilizarlo | `jev template create` | [`references/templates.md`](references/templates.md) |
| Ejecutar una plantilla para muchos contextos | `jev batch <plantilla> --contexts …` | [`references/templates.md`](references/templates.md) |
| Previsualizar un request sin gastar tokens | `jev template render` | [`references/templates.md`](references/templates.md) |

## Contrato de scripting

Esto es lo que necesitas para invocar `jev` de forma no interactiva:

- **Códigos de salida**: `0` correcto; `1` error de API/red/configuración
  (falta la key, JSON inválido…); `2` uso incorrecto (comando o flag inválido).
- **`--json`** imprime la respuesta cruda de la API a **stdout**. En `ask`/`demo`
  el resumen de tokens (`tokens: … in / … out, cost=…`) va a **stderr**, así que
  `--json` se puede redirigir a un fichero sin contaminarlo.
- **`--no-save`** no registra la ejecución en el historial SQLite.
- **`--db <ruta>`** (o `JEV_DB`) aísla ejecuciones en una base propia —útil en
  scripts y tests— y evita tocar la base del usuario.

```sh
jev ask --state "…" --questions '…' --json 2>/dev/null | jq '.answers.q.noul'
```

## Punteros

- [`references/noul.md`](references/noul.md) — operación `noul`: casos de uso, CLI y bash.
- [`references/choice.md`](references/choice.md) — operación `choice`: casos de uso, CLI y bash.
- [`references/score.md`](references/score.md) — operación `score`: casos de uso, CLI y bash.
- [`references/templates.md`](references/templates.md) — manual de plantillas con casos reales.

Fuera del alcance de esta skill (ver [`README.md`](../../README.md) para más):
la TUI (`jev tui`), la consola web (`jev web-console`) y el servidor MCP
(`jev mcp`). Para usos como librería TypeScript, consulta la sección
«Uso como librería» del README.
