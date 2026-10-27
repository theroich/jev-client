# Images (experimental)

The System One API supports images, but **not** in an OpenAI-style multimodal
format: an `image_url` or a data URI inside `state` is tokenized as text
(≈18.5k tokens for a 19 KB JPEG) and the model sees nothing. The correct format
is an `assets` field (images by reference) plus the mandatory
`TypeSafe-Danger-Zone-Images: true` header.

```jsonc
{
  "model": "jev-1.13",
  "state": { "photo": "<uuid>" },                // the reference goes where text would go
  "assets": {
    "<uuid>": { "type": "image", "format": "jpg", "data_base64": "<no data: prefix, no line breaks>" }
  },
  "questions": {
    "animal": {
      "type": "choice",
      "instructions": "Which animal appears in `photo`?",
      "criteria": { "CAT": "Domestic feline", "DOG": "Domestic canine", "COW": "Bovine" }
    }
  }
}
```

The client adds the header automatically when there are `assets`
(`--no-images-header` omits it to check the `400`).

## CLI

```sh
jev ask --state '{"photo":"<ref>"}' --asset <ref>=canvas-MAHA8XxHPJk.jpg \
    --choice 'animal=Which animal appears in `photo`?' \
    --option 'animal.CAT=Domestic feline' --option 'animal.DOG=Domestic canine'
```

- `--asset [<ref>=]<path>` (repeatable): loads the image, detects the format from
  the *magic bytes* and validates the limits. Without `<ref>` a UUID is
  generated.
- `--assets-file <path>`: complete `assets` map in JSON
  (`{ "<ref>": { "path": "…" } }` or
  `{ "<ref>": { "data_base64": "…", "format": "jpg" } }`).
- `--no-images-header`: omits the header (only to debug the `400`).

## Limits

The API rejects, it does not resize:

| Limit | Value |
| --- | --- |
| Format | Static PNG/JPEG (APNG rejected) |
| Size per file | 16 MiB |
| Sides | 280–1568 px |
| Total pixels | 78,400–2,458,624 |

## Pitfalls

- `data:` in `state` does **not** work: use `assets` + a reference.
- Every `assets` entry must be referenced in `state`/`instructions`/`criteria`
  (otherwise the API returns `400`); the client validates it locally.
- The base64 must use the standard alphabet **without** a `data:` prefix or line
  breaks.
- Rotate the pixels before sending: the API discards EXIF and does not apply
  orientation.
- The history **never** stores `data_base64`: it is redacted to
  `{ format, bytes, sha256 }`.

In MCP, `jev_ask`/`jev_batch` accept `assets` and `jev_image_check` validates an
image without spending a call. In the web console, *Evaluate* accepts attaching
an image (thumbnail + size) and the history shows only the summary.

See [`skills/jev-cli/references/templates.md`](../skills/jev-cli/references/templates.md)
for the "compare against a known image" pattern.
