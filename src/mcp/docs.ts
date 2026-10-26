import type { McpContext } from "./context.js";
import type { ToolAnnotations } from "./schema.js";
import { buildToolCatalog, type ToolDefinition } from "./tools.js";

/** Entrada machine-readable del catálogo de tools (compartida por MCP y web). */
export interface ToolDocEntry {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: ToolAnnotations;
  examples?: unknown[];
  source: "builtin" | "template";
  templateName?: string;
}

export function toolsCatalogDoc(ctx: McpContext): ToolDocEntry[] {
  return buildToolCatalog(ctx).map(toDocEntry);
}

export function toolDoc(ctx: McpContext, name: string): ToolDocEntry | undefined {
  const tool = buildToolCatalog(ctx).find((entry) => entry.name === name);
  return tool === undefined ? undefined : toDocEntry(tool);
}

function toDocEntry(tool: ToolDefinition): ToolDocEntry {
  const entry: ToolDocEntry = {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    source: tool.source,
    templateName: tool.templateName,
  };
  if (tool.outputSchema !== undefined) {
    entry.outputSchema = tool.outputSchema;
  }
  return entry;
}

export function appOverviewDoc(): string {
  return [
    "# jev-client",
    "",
    "jev-client es una CLI, librería y servidor MCP en Node.js + TypeScript para consumir la API de",
    "**Jev** (System One de TypeSafe) a través de OpenCode.",
    "",
    "Jev no genera texto: recibe un `state` (contenido a evaluar) y una o más preguntas tipadas, y",
    "devuelve una respuesta por pregunta con probabilidades.",
    "",
    "## Conceptos",
    "",
    "- **template** — request de Jev con macros `{{clave}}` que se resuelven con un contexto.",
    "  Cada plantilla se publica además como una **tool MCP propia**.",
    "- **macro** — hueco `{{clave}}` en el body de una plantilla. Admite rutas con puntos",
    "  (`{{cliente.nombre}}`) y metadatos opcionales: descripción y JSON Schema.",
    "- **request** — ejecución real contra Jev: `{ model, state, questions }`. Se guarda en SQLite.",
    "- **batch** — ejecución de una plantilla sobre un array de contextos; todas las peticiones",
    "  comparten `batch_id`.",
    "- **config** — `api_url`, `api_key`, `model`, `timeout` y `retries`; precedencia",
    "  flag > entorno > SQLite > defecto.",
    "",
    "## Almacenamiento",
    "",
    "La base SQLite vive por defecto en `~/.jev-client/db/jev.db` (permisos 0600/0700). Guarda",
    "`config`, `templates`, `template_macros` y `requests`. Cada ejecución hecha por MCP queda",
    "registrada con `source='mcp'`.",
    "",
    "## Seguridad",
    "",
    "La API key nunca aparece en una respuesta MCP (`jev_config_get` y `jev_overview` la enmascaran).",
    "El transporte es stdio local (sin puertos). Las lecturas no se guardan; solo las ejecuciones",
    "reales y las mutaciones de plantillas.",
    "",
    "## Imágenes (experimental)",
    "",
    "Jev acepta imágenes vía el campo `assets` (`{ ref: { data_base64, format } }`) más el header",
    "`TypeSafe-Danger-Zone-Images: true`. La referencia se escribe donde iría texto (`state`, ",
    "`instructions` o `criteria`) y la API la sustituye por la imagen. `jev_ask`, `jev_batch` y",
    "`jev_template_render` aceptan un parámetro `assets`; `jev_image_check` valida una imagen (formato,",
    "dimensiones, límites) sin gastar llamada. Las imágenes son experimentales y sus límites pueden",
    "cambiar: PNG/JPEG estático, 280–1568 px por lado y 16 MiB por fichero.",
  ].join("\n");
}

export function mcpConfigDoc(): string {
  return [
    "# Configurar el servidor MCP",
    "",
    "El servidor se lanza por stdio con `jev mcp` (alias `jev-mcp`). Nada se escribe en stdout salvo",
    "JSON-RPC; los logs van a stderr.",
    "",
    "## Flags",
    "",
    "```",
    "jev mcp [--db <ruta>] [--key <clave>] [--url <endpoint>] [--model <modelo>]",
    "        [--timeout <seg>] [--retries <n>]",
    "        [--read-only] [--no-execute] [--allow-destructive]",
    "```",
    "",
    "- `--db` / `JEV_DB` — ruta de la base SQLite (compartida con la CLI y la consola).",
    "- `--key` / `OPENCODE_API_KEY` / `JEV_API_KEY` — API key.",
    "- `--read-only` — deshabilita crear/editar/borrar plantillas.",
    "- `--no-execute` — deshabilita `jev_ask`/`jev_batch` y oculta las tools de plantilla.",
    "- `--allow-destructive` — habilita `jev_template_delete`.",
    "",
    "Si falta la API key, el servidor arranca igualmente: las tools de lectura funcionan y las de",
    "ejecución devuelven un error estructurado.",
    "",
    "## OpenCode",
    "",
    "En `opencode.json` (o la config global):",
    "",
    "```jsonc",
    '{\n  "mcp": {\n    "servers": {\n      "jev": {\n        "type": "local",\n        "command": ["jev", "mcp"],\n        "environment": { "JEV_DB": "/Users/me/.jev-client/db/jev.db" }\n      }\n    }\n  }',
    "",
    "Con el paquete publicado en npm, sin instalarlo, con npx:",
    "",
    "```jsonc",
    '{\n  "mcp": {\n    "servers": {\n      "jev": {\n        "type": "local",\n        "command": ["npx", "-y", "jev-client", "mcp"]\n      }\n    }\n  }',
    "",
    "Si el paquete no está en npm pero sí en GitHub, npx también lo instala desde el repo:",
    "",
    "```jsonc",
    '{\n  "mcp": {\n    "servers": {\n      "jev": {\n        "type": "local",\n        "command": ["npx", "-y", "-p", "github:USUARIO/jev-client", "jev-mcp"]\n      }\n    }\n  }',
    "",
    "## Claude Desktop",
    "",
    "```json",
    '{\n  "mcpServers": {\n    "jev": {\n      "command": "jev",\n      "args": ["mcp"],\n      "env": { "JEV_DB": "/Users/me/.jev-client/db/jev.db" }\n    }\n  }\n}',
    "",
    "## Transportes",
    "",
    "v1 usa stdio local. El transporte HTTP remoto, OAuth y el multiusuario quedan fuera de alcance.",
  ].join("\n");
}

export function examplesDoc(): string {
  return [
    "# Ejemplos de uso",
    "",
    "Flujo recomendado: listar → obtener → generar contextos → render (dry-run) → ejecutar → historial.",
    "",
    "1. Listar plantillas:",
    "```json",
    '{"tool":"jev_template_list"}',
    "```",
    "",
    "2. Leer una plantilla y sus macros:",
    "```json",
    '{"tool":"jev_template_get","name":"pedido-soporte"}',
    "```",
    "",
    "3. Renderizar (dry-run) con un contexto:",
    "```json",
    '{"tool":"jev_template_render","name":"pedido-soporte","context":{"cliente.nombre":"Ana","cliente.plan":"pro","ticket":"TCK-1042"}}',
    "```",
    "",
    "4. Ejecutar la tool de la plantilla (misma forma que render):",
    "```json",
    '{"tool":"pedido-soporte","cliente.nombre":"Ana","cliente.plan":"pro","ticket":"TCK-1042"}',
    "```",
    "",
    "5. Ejecutar varios contextos en un batch:",
    "```json",
    '{"tool":"jev_batch","template":"pedido-soporte","contexts":[{"cliente.nombre":"Ana","cliente.plan":"pro","ticket":"TCK-1042"},{"cliente.nombre":"Luis","cliente.plan":"free","ticket":"TCK-1043"}],"concurrency":2}',
    "```",
    "",
    "6. Consultar el historial:",
    "```json",
    '{"tool":"jev_history_list","template":"pedido-soporte","limit":5}',
    "```",
    "",
    "7. Ejecutar un request ad-hoc:",
    "```json",
    '{"tool":"jev_ask","state":"El checkout lleva caído 30 minutos.","questions":{"urgent":{"type":"noul","instructions":"¿Es urgente?"}}}',
    "```",
    "",
    "8. Validar una imagen antes de enviarla:",
    "```json",
    '{"tool":"jev_image_check","path":"/ruta/foto.jpg"}',
    "```",
    "",
    "9. Ejecutar un request con una imagen (experimental):",
    "```json",
    '{"tool":"jev_ask","state":{"foto":"<uuid>"},"assets":{"<uuid>":{"path":"/ruta/foto.jpg"}},"questions":{"animal":{"type":"choice","instructions":"¿Qué animal aparece en `foto`?","criteria":{"GATO":"Felino","PERRO":"Canino"}}}}',
    "```",
  ].join("\n");
}

function docText(content: string): { text: string } {
  return { text: content };
}

/**
 * Proveedor de documentación usado por la tool `jev_docs` y los resources.
 * `contentFor(topic)` resuelve 'overview' | 'tools' | 'mcp' | 'examples' o el
 * nombre de una tool concreta.
 */
export function docsProvider(
  ctx: McpContext,
): { contentFor(topic: string): { text: string } | undefined } {
  return {
    contentFor(topic: string): { text: string } | undefined {
      const normalized = topic.trim();
      if (normalized === "" || normalized === "overview") {
        return docText(appOverviewDoc());
      }
      if (normalized === "tools") {
        return docText(JSON.stringify(toolsCatalogDoc(ctx), null, 2));
      }
      if (normalized === "mcp") {
        return docText(mcpConfigDoc());
      }
      if (normalized === "examples") {
        return docText(examplesDoc());
      }
      const tool = toolDoc(ctx, normalized);
      return tool === undefined ? undefined : docText(JSON.stringify(tool, null, 2));
    },
  };
}
