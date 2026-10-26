# Arquitectura y empaquetado

## Capas compartidas

`src/service.ts` concentra `ask`, `demo` y `batch`. CLI, TUI, consola web y
servidor MCP comparten:

- el cliente HTTP (`src/client.ts`),
- la resolución de configuración (`src/config.ts`, `config-repository.ts`),
- los validadores y tipos (`src/types.ts`, `src/template.ts`),
- las migraciones y repositorios SQLite (`src/database.ts`,
  `request-repository.ts`, `template-repository.ts`).

Next mantiene una única conexión SQLite perezosa por proceso. Sus Server
Components cargan DTOs sin secretos; los Client Components no importan `node:*`
ni `better-sqlite3`.

## TUI sin dependencias nuevas

La TUI se implementa sobre `readline` y modos raw de Node, en lugar de `ink` o
`blessed`:

- **Sin dependencias nuevas** (solo `better-sqlite3`, que ya estaba): `ink`
  arrastra React y `blessed` dejó de mantenerse y usa bindings nativos.
- **Soporta Node 20** sin problemas; `blessed` y el ecosistema de `ink` han ido
  subiendo el mínimo de Node.
- **Testeable en CI**: la máquina de estados (`TuiApp`) no toca la terminal, por
  lo que se prueba sin TTY; el driver raw queda aislado en `runTui`.

## Empaquetado npm

El paquete incluye el **standalone compilado** en `dist/web-console` (sin
checkout), sus assets y el servidor CommonJS. Las dependencias trazadas se
resuelven desde las dependencias npm normales (`next`, `react`, `react-dom` y
`better-sqlite3`), evitando incluir `node_modules` dentro del tarball. Se eligió
esta opción en lugar de un paquete opcional para conservar la UX de un único
comando.

El umbral acordado es **25 MiB comprimidos**; `npm run test:package` comprueba
tamaño, instalación con `npm pack`, arranque, health, HTML, assets y cierre
limpio.

## Contrato visual

El contrato visual original está versionado en `design/`
(`jev-web-console.html`, handoff y manifest). Los tokens se extrajeron en
`web/styles/tokens.css`; no se usa un tema de framework ni recursos remotos.
