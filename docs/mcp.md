# Servidor MCP

`jev-client` expone la misma lógica como **servidor MCP** (Model Context
Protocol) por stdio. Un agente (OpenCode, Claude Desktop…) puede descubrir
plantillas, leer sus macros, generar contextos, renderizar y ejecutar sin que un
humano traduzca la CLI.

```sh
jev mcp                          # arranca el servidor por stdio
jev-mcp                          # alias (binario)
jev mcp --read-only              # sin crear/editar/borrar plantillas
jev mcp --no-execute             # sin jev_ask/jev_batch ni tools de plantilla
jev mcp --allow-destructive      # habilita jev_template_delete
```

El servidor hereda la configuración de la CLI (`--db`, `--key`, `--url`,
`--model`, `--timeout`, `--retries` y las variables de entorno). Si falta la API
key arranca igualmente: las tools de lectura funcionan y las de ejecución
devuelven un error estructurado. Nada se escribe en stdout salvo JSON-RPC; los
logs van a stderr.

## Tools

Hay un catálogo fijo (prefijo `jev_`) y, además, **una tool MCP por cada
plantilla guardada**: el nombre de la tool es el nombre de la plantilla, su
descripción es la descripción de la plantilla y cada macro es un parámetro de
entrada con su descripción y su JSON Schema (`string` por defecto). Una
plantilla llamada `pedido-soporte` se invoca directamente como tool
`pedido-soporte` con sus macros como argumentos.

| Tool | Tipo | Descripción |
| --- | --- | --- |
| `jev_overview` | lectura | versión, esquema, ruta de BD, contadores, API key (booleano) y tools |
| `jev_docs` | lectura | documentación de la app (`overview`, `tools`, `mcp`, `examples`) o de una tool |
| `jev_template_list` / `jev_template_get` | lectura | descubrir plantillas, body, macros, schemas y `toolName` |
| `jev_template_starters` / `jev_template_validate` | lectura | starters (`noul`, `choice`, `score`) y validación sin llamar a Jev |
| `jev_template_render` | lectura | dry-run: resuelve macros sin llamar a Jev |
| `jev_template_create` / `jev_template_update` | mutación | crear/editar plantillas |
| `jev_template_delete` | destructiva | borrar (exige `confirm: true`; solo con `--allow-destructive`) |
| `jev_ask` / `jev_batch` | ejecución | ejecutar contra Jev; **siempre** se guarda en el historial |
| `jev_history_list` / `jev_history_get` | lectura | historial con filtros y detalle |
| `jev_config_get` | lectura | configuración efectiva con la API key enmascarada |

`jev_ask`/`jev_batch` aceptan `assets` y `jev_image_check` valida una imagen
(formato, dimensiones, límites) sin gastar llamada. Ver [imágenes](imagenes.md).

**Toda ejecución hecha por MCP se persiste en SQLite** con `source = 'mcp'`
(y `template_name`/`batch_id` cuando aplica). No se guardan las lecturas.

## Resources y prompt

- `jev://docs/overview`, `jev://docs/tools`, `jev://docs/examples`,
  `jev://docs/mcp` — documentación machine-readable.
- `jev://templates` y `jev://templates/{name}` — plantillas como resources.
- Prompt `generar-contextos` — guía para producir un array de contextos JSON.

## Configuración en OpenCode

En el `opencode.json` del proyecto (o la config global):

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

Con el paquete publicado en npm se puede arrancar con `npx` sin instalarlo:

```jsonc
{
  "mcp": {
    "servers": {
      "jev": { "type": "local", "command": ["npx", "-y", "jev-client", "mcp"] }
    }
  }
}
```

Si el paquete **no está en npm** pero sí en GitHub, `npx` lo instala desde el repo
(ejecuta `prepare`, que compila `dist/`). Fíjate en el `-p` para elegir el
binario:

```sh
npx -y -p github:USUARIO/jev-client jev-mcp          # servidor MCP directo
npx -y -p github:USUARIO/jev-client jev mcp          # vía la CLI
```

```jsonc
{
  "mcp": {
    "servers": {
      "jev": { "type": "local", "command": ["npx", "-y", "-p", "github:USUARIO/jev-client", "jev-mcp"] }
    }
  }
}
```
