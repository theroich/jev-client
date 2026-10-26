# Imágenes (experimental)

La API System One soporta imágenes, pero **no** en formato multimodal tipo
OpenAI: un `image_url` o un data-URI dentro de `state` se tokeniza como texto
(≈18.5k tokens por un JPEG de 19 KB) y el modelo no ve nada. El formato correcto
es un campo `assets` (imágenes por referencia) más el header obligatorio
`TypeSafe-Danger-Zone-Images: true`.

```jsonc
{
  "model": "jev-1.13",
  "state": { "foto": "<uuid>" },                 // la referencia va donde iría texto
  "assets": {
    "<uuid>": { "type": "image", "format": "jpg", "data_base64": "<sin prefijo data:, sin saltos>" }
  },
  "questions": {
    "animal": {
      "type": "choice",
      "instructions": "¿Qué animal aparece en `foto`?",
      "criteria": { "GATO": "Felino doméstico", "PERRO": "Canino doméstico", "VACA": "Bovino" }
    }
  }
}
```

El header lo añade automáticamente el cliente cuando hay `assets`
(`--no-images-header` lo omite para comprobar el `400`).

## CLI

```sh
jev ask --state '{"foto":"<ref>"}' --asset <ref>=canva-MAHA8XxHPJk.jpg \
    --choice 'animal=¿Qué animal aparece en `foto`?' \
    --option 'animal.GATO=Felino doméstico' --option 'animal.PERRO=Canino doméstico'
```

- `--asset [<ref>=]<ruta>` (repetible): carga la imagen, detecta el formato por
  *magic bytes* y valida límites. Sin `<ref>` se genera un UUID.
- `--assets-file <ruta>`: mapa `assets` completo en JSON
  (`{ "<ref>": { "path": "…" } }` o
  `{ "<ref>": { "data_base64": "…", "format": "jpg" } }`).
- `--no-images-header`: omite el header (solo para depurar el `400`).

## Límites

La API rechaza, no redimensiona:

| Límite | Valor |
| --- | --- |
| Formato | PNG/JPEG estático (APNG rechazado) |
| Tamaño por fichero | 16 MiB |
| Lados | 280–1568 px |
| Total de píxeles | 78.400–2.458.624 |

## Trampas

- `data:` en el `state` **no** funciona: usa `assets` + referencia.
- Toda entrada de `assets` debe estar referenciada en `state`/`instructions`/
  `criteria` (si no, la API devuelve `400`); el cliente lo valida en local.
- El base64 debe ser el alfabeto estándar **sin** prefijo `data:` ni saltos.
- Rota los píxeles antes de enviar: la API descarta EXIF y no aplica orientación.
- El historial **nunca** guarda `data_base64`: se redacta a
  `{ format, bytes, sha256 }`.

En MCP, `jev_ask`/`jev_batch` aceptan `assets` y `jev_image_check` valida una
imagen sin gastar llamada. En la consola web, *Evaluar* admite adjuntar una
imagen (miniatura + tamaño) y el historial muestra solo el resumen.

Ver [`skills/jev-cli/references/templates.md`](../skills/jev-cli/references/templates.md)
para el patrón "comparar contra una imagen conocida".
