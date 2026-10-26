# Solución de problemas

## `better-sqlite3` compilado contra otra versión de Node

El error típico es `NODE_MODULE_VERSION 137` frente a `115`: el binario nativo se
instaló con una versión de Node distinta de la que ejecuta `jev`. Usa el binario
que corresponda a tu Node (por ejemplo `ivm-node 24.11.1`) o recompila el
módulo:

```sh
npm rebuild better-sqlite3
```

## Desajuste de esquema SQLite

`la base usa el esquema N, pero esta versión solo admite hasta M` significa que
otra versión (más reciente) de `jev` escribió en `~/.jev-client/db/jev.db`.
Aísla la ejecución en una base temporal:

```sh
jev ask --db "$(mktemp -d)/jev.db" …
# o: JEV_DB=/tmp/jev-prueba.db jev ask …
```

Si no necesitas el historial, también puedes renombrar o borrar la base para
que se recree con el esquema de esta versión.

## La TUI pide una terminal

Si no hay terminal interactiva, `jev tui` sale con código `1` y un mensaje claro
listando los comandos equivalentes, sin bloquear ni dejar la terminal en mal
estado:

```sh
echo "" | jev tui   # error: requiere una terminal (TTY)
```

## La consola web no arranca

- **Puerto ocupado**: elige otro con `--port <n>` o `--port 0`.
- **Build ausente**: ejecuta `npm run build:web` o usa `--dev` desde el checkout.
- **No abre el navegador**: es el comportamiento esperado con CI/SSH; usa
  `--open` o abre la URL impresa a mano.

## Errores de API

- `429 FreeUsageLimitError`: `jev-1.13-free` está limitado fuera de OpenCode o
  al agotar la cuota. Para pruebas usa `jev-1.13`.
- `401` / `api_key_expired`: revisa la key (`jev config get api_key --reveal`,
  `OPENCODE_API_KEY` o `--key`).
- `422`: la pregunta está mal formada; revisa `criteria` (`choice` usa objeto,
  `score` usa array ordenado).
- El `Retry-After` del servidor se capa a 10 s para no bloquear el proceso.
