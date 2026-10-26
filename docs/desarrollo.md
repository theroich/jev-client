# Desarrollo y pruebas

```sh
npm test                 # unidad/contrato de CLI, dominio y route handlers
npm run typecheck        # TypeScript estricto de src, test y web
npm run build:web        # build de producción Next + standalone
npm run test:e2e         # Playwright: flujos, axe y matriz responsive
npm run test:package     # npm pack + instalación + smoke del paquete
```

Los tests no hacen red contra la API: usan un `fetch` inyectado y servidores HTTP
locales para comprobar cabeceras, cuerpo, reintentos, errores, formato, CLI, API
web y streaming de lotes. Las bases SQLite se crean en directorios temporales.
Playwright recorre las seis rutas, inferencia con provider mockeado, CRUD,
render, lote, historial/export, configuración, paleta, modales y axe; la matriz
360–1920 px verifica overflow, tokens, breakpoints, activos locales y una
regresión de geometría/tipografía calculada directamente contra el HTML
exportado.

Para instalar Chromium en el checkout sin tocar la caché global:

```sh
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
```

## CI

Hay un workflow de GitHub Actions (`.github/workflows/ci.yml`) que, en cada push
a `main` y en cada pull request, ejecuta sobre Node 20 y 22 el typecheck, tests
unitarios/de rutas, build de Next, E2E con axe y smoke del paquete instalado. La
suite no necesita una API key real ni secretos de CI.

## Checklist manual de la TUI

Lo siguiente no se puede automatizar del todo (depende de un TTY real) y conviene
revisarlo a mano antes de publicar:

- [ ] `jev tui` abre el menú y `↑`/`↓` mueven la selección.
- [ ] En Plantillas, `n`/`e`/`d`/`/` responden y `q` vuelve al menú; en el
      detalle `e`/`d`/`b`/`q` y en provider `q` también responden.
- [ ] Cambiar `model` y `api_url` desde la TUI y comprobar que persisten con
      `jev config get model` y `jev config get api_url` en otra ejecución.
- [ ] La `api_key` se muestra enmascarada al consultarla y al editarla; nunca se
      ve el valor completo.
- [ ] Crear una plantilla desde la TUI y verla después con `jev template show`.
- [ ] Editar una plantilla con un JSON inválido muestra el error y bloquea el
      guardado; con JSON válido muestra las macros detectadas.
- [ ] Salir con `Ctrl-C` en mitad de una edición pide confirmación si hay cambios.
- [ ] `echo "" | jev tui` imprime el error de "requiere una terminal" y sale con
      código `1`; la terminal queda usable.
- [ ] Redimensionar la ventana no corrompe la pantalla (cada tecla redibuja).
