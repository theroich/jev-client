# Tipos de pregunta y contrato del request

Un request de Jev tiene la forma `{ model, state, questions }`. El `state` es el
material que se evalúa (texto, objeto o array) y se comparte entre todas las
preguntas.

## Tipos

| `type` | Campos | Devuelve |
| --- | --- | --- |
| `noul` | `instructions` (y `criteria` opcional) | `noul`: probabilidad de "sí" (0–1) |
| `choice` | `instructions`, `criteria` (objeto) | `choice`, `confidence`, `probabilities` |
| `score` | `instructions`, `criteria` (array ordenado) | `score`, `legend`, `probabilities` |

En `score`, la posición en el array es la nota: `0` el primero, `1` el segundo…
El `score` devuelto es la media ponderada y puede ser decimal; cuando cae entre
dos niveles se muestra con `≈`.

## Qué ve el modelo

La **clave** de `questions` (`"urgency"`) solo identifica la respuesta en
`answers`: **no se envía al modelo**. El modelo solo ve `state` + `instructions`
+ `criteria` de cada pregunta.

Al evaluar varios elementos en un mismo request, nómbralos en cada
`instructions` o referéncialos desde `state`; si el referente vive solo en la
clave, todas las respuestas tienden al mismo valor.

Ejemplo correcto:

```json
{
  "state": { "ticket_a": "…", "ticket_b": "…" },
  "questions": {
    "a_urgente": { "type": "noul", "instructions": "¿Es urgente `ticket_a`?" },
    "b_urgente": { "type": "noul", "instructions": "¿Es urgente `ticket_b`?" }
  }
}
```

## Forma de las respuestas

- `noul` → `answers.<clave>.noul` (número entre 0 y 1). No hay `confidence`.
- `choice` → `answers.<clave>.choice`, `.confidence` y `.probabilities`.
- `score` → `answers.<clave>.score`, `.legend` y `.probabilities`.

Las respuestas mantienen el orden de las preguntas del request.

Más detalle y patrones de uso:
[`skills/jev-cli/references/anatomia-pregunta.md`](../skills/jev-cli/references/anatomia-pregunta.md).

## Notas del modelo

- `jev-1.13-free` está limitado: devuelve `429 FreeUsageLimitError` fuera de
  OpenCode o al agotar la cuota. Para pruebas usa `jev-1.13`.
- El `Retry-After` del servidor se capa a 10 s para no bloquear el proceso.
- Jev está entrenado principalmente en inglés; acepta español con algo menos de
  precisión.
- Documentación de las preguntas: <https://docs.typesafe.ai/primitives>.
