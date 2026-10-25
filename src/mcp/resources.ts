import type { McpContext } from "./context.js";
import { appOverviewDoc, examplesDoc, mcpConfigDoc, toolsCatalogDoc } from "./docs.js";
import { getTemplatePayload, listTemplatesPayload } from "./tools.js";

const MARKDOWN = "text/markdown";
const JSON_MIME = "application/json";

export interface ResourceDescriptor {
  name: string;
  uri: string;
  description: string;
  mimeType: string;
}

export interface PromptDescriptor {
  name: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
}

/** Resources estáticas más el listado de plantillas. */
export function listResources(): ResourceDescriptor[] {
  return [
    {
      name: "overview",
      uri: "jev://docs/overview",
      description: "Qué es jev-client, conceptos, almacenamiento y seguridad.",
      mimeType: MARKDOWN,
    },
    {
      name: "tools",
      uri: "jev://docs/tools",
      description: "Catálogo completo de tools (fijas y por plantilla) en JSON.",
      mimeType: JSON_MIME,
    },
    {
      name: "examples",
      uri: "jev://docs/examples",
      description: "Casos de uso end-to-end con JSON real.",
      mimeType: MARKDOWN,
    },
    {
      name: "mcp",
      uri: "jev://docs/mcp",
      description: "Cómo configurar el servidor en OpenCode/Claude Desktop.",
      mimeType: MARKDOWN,
    },
    {
      name: "templates",
      uri: "jev://templates",
      description: "Listado de plantillas (mismo payload que jev_template_list).",
      mimeType: JSON_MIME,
    },
  ];
}

/** Plantilla de resource `jev://templates/{name}`. */
export function listResourceTemplates(): Array<Omit<ResourceDescriptor, "uri"> & { uriTemplate: string }> {
  return [
    {
      name: "template",
      uriTemplate: "jev://templates/{name}",
      description: "Detalle de una plantilla (mismo payload que jev_template_get).",
      mimeType: JSON_MIME,
    },
  ];
}

/** Nombres de plantilla para el callback de listado del resource template. */
export function templateNames(ctx: McpContext): string[] {
  return ctx.templates.list().map((template) => template.name);
}

/** Lee un resource por URI; `undefined` si no existe. */
export function readResource(
  uri: string,
  ctx: McpContext,
): { text: string; mimeType: string } | undefined {
  switch (uri) {
    case "jev://docs/overview":
      return { text: appOverviewDoc(), mimeType: MARKDOWN };
    case "jev://docs/tools":
      return { text: JSON.stringify(toolsCatalogDoc(ctx), null, 2), mimeType: JSON_MIME };
    case "jev://docs/examples":
      return { text: examplesDoc(), mimeType: MARKDOWN };
    case "jev://docs/mcp":
      return { text: mcpConfigDoc(), mimeType: MARKDOWN };
    case "jev://templates":
      return { text: JSON.stringify(listTemplatesPayload(ctx), null, 2), mimeType: JSON_MIME };
  }
  if (uri.startsWith("jev://templates/")) {
    const raw = uri.slice("jev://templates/".length);
    const name = decodeURIComponent(raw);
    if (ctx.templates.get(name) === undefined) {
      return undefined;
    }
    return { text: JSON.stringify(getTemplatePayload(ctx, name), null, 2), mimeType: JSON_MIME };
  }
  return undefined;
}

export function listPrompts(): PromptDescriptor[] {
  return [
    {
      name: "generar-contextos",
      description:
        "Guía para generar un array de contextos JSON para una plantilla respetando sus macros y " +
        "schemas, renderizando antes de ejecutar.",
      arguments: [
        { name: "template", description: "Nombre de la plantilla.", required: true },
        {
          name: "escenarios",
          description: "Descripción libre de los escenarios a cubrir.",
          required: true,
        },
      ],
    },
  ];
}

export function getPrompt(name: string): string | undefined {
  if (name !== "generar-contextos") {
    return undefined;
  }
  return [
    "Tu objetivo es producir un array JSON de contextos para la plantilla indicada.",
    "",
    "Pasos:",
    "1. Llama a `jev_template_get` (o `jev_docs` con topic=template) para leer body, macros, ",
    "   descripciones y JSON Schemas.",
    "2. Respeta cada macro y su schema (enum, format, pattern, límites, default) sin inventar ",
    "   claves que no existan.",
    "3. Genera un array JSON de objetos, uno por escenario, con una clave por macro (las rutas con ",
    "   puntos son claves planas exactas, p. ej. \"cliente.nombre\").",
    "4. Antes de ejecutar, valida con `jev_template_render` para detectar macros ausentes.",
    "5. Ejecuta con `jev_batch` pasando `template` y `contexts`.",
    "",
    "Devuelve solo el array JSON de contextos.",
  ].join("\n");
}
