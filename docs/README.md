# Documentación técnica

El [README](../README.md) explica **cómo se usa** `jev-client`. Esta carpeta
guarda el detalle técnico: cómo está construido, cómo persiste los datos y qué
contratos internos respeta.

| Documento | Contenido |
| --- | --- |
| [Arquitectura](arquitectura.md) | Capas, decisiones de diseño, empaquetado y publicación. |
| [Configuración](configuracion.md) | Precedencia completa, flags, variables y gestión de secretos. |
| [Persistencia](persistencia.md) | Esquema SQLite, migraciones, permisos y qué se guarda. |
| [Tipos de pregunta](preguntas.md) | Contrato de `noul`, `choice` y `score`, y qué ve el modelo. |
| [Consola web](web-console.md) | Flags, pantallas, modelo de seguridad y endpoints de documentación. |
| [Servidor MCP](mcp.md) | Catálogo de tools, resources, prompt y configuración en agentes. |
| [Imágenes](imagenes.md) | Formato `assets`, header obligatorio, límites y trampas. |
| [Uso como librería](libreria.md) | API TypeScript, opciones del cliente y utilidades de plantillas. |
| [Desarrollo](desarrollo.md) | Builds, tests, CI, E2E y checklist manual de la TUI. |
| [Solución de problemas](solucion-problemas.md) | Errores de arranque, base de datos, puertos y cuota. |

La documentación de uso por comando también está disponible en
[`skills/jev-cli/`](../skills/jev-cli/SKILL.md).
