# Anatomía de una pregunta: qué ve el modelo

Esta referencia explica **qué información llega realmente al modelo** en cada
pregunta. Es la causa de una clase entera de resultados degenerados: preguntas
que devuelven todas el mismo valor porque el modelo no sabe de qué elemento le
estás hablando. Aplica por igual a `noul`, `choice` y `score`.

## 1. El payload que viaja a la API

Un request de Jev tiene exactamente esta forma (ver `src/types.ts`):

```json
{
  "model": "jev-1.13",
  "state": "…",
  "questions": {
    "<clave>": {
      "type": "noul | choice | score",
      "instructions": "…",
      "criteria": "…"
    }
  }
}
```

- **`state`**: `string | object | array`. Es el material que el modelo evalúa.
- **`questions`**: un **objeto** `clave -> pregunta`. La clave es el
  identificador de la respuesta, no parte de la pregunta.
- **`type`**: `noul`, `choice` o `score` (ver las otras referencias).
- **`instructions`**: qué se pregunta.
- **`criteria`**: string opcional en `noul`, objeto en `choice`, array ordenado
  en `score`.

## 2. Las tres reglas que se derivan

1. **`state` es único y compartido** por todas las preguntas del request. No hay
   un `state` por pregunta: si evalúas siete elementos, los siete reciben el
   mismo `state`.
2. **La clave de `questions` no se envía al modelo.** `"gato"` en
   `{"gato": {…}}` sirve para encontrar `answers.gato` en la respuesta, pero no
   aparece en el prompt.
3. **Lo único que ve el modelo por pregunta es
   `state` + `instructions` + `criteria`.**

Consecuencia práctica: el sujeto de la pregunta tiene que estar **dentro de
`instructions`** (o dentro de `state`, y entonces hay que referenciarlo por
nombre en `instructions`). Nunca solo en la clave.

```text
pregunta enviada:  { "instructions": "¿Qué tamaño tiene este animal?" }
clave:             "gato"     ← no viaja al modelo
state:             "gato, mosca, elefante, …"   ← compartido con las 7 preguntas

modelo ve:         "gato, mosca, elefante, … ¿Qué tamaño tiene este animal?"
```

«Este animal» no tiene referente único: el modelo responde lo mismo (o algo
intermedio) para todas las claves.

## 3. El caso real: evaluar N elementos en un solo request

Escenario: puntuar el tamaño de siete animales con `score`.

Escala:

```json
["Diminuto", "Pequeño", "Mediano", "Grande", "Enorme"]
```

### Mal: el animal solo en la clave

```sh
jev ask --state "gato, mosca, elefante, narval, perro, ratón, lenguado" \
  --questions '{
    "gato":     {"type":"score","instructions":"¿Qué tamaño tiene este animal?","criteria":["Diminuto","Pequeño","Mediano","Grande","Enorme"]},
    "mosca":    {"type":"score","instructions":"¿Qué tamaño tiene este animal?","criteria":["Diminuto","Pequeño","Mediano","Grande","Enorme"]},
    "elefante": {"type":"score","instructions":"¿Qué tamaño tiene este animal?","criteria":["Diminuto","Pequeño","Mediano","Grande","Enorme"]},
    "narval":   {"type":"score","instructions":"¿Qué tamaño tiene este animal?","criteria":["Diminuto","Pequeño","Mediano","Grande","Enorme"]},
    "perro":    {"type":"score","instructions":"¿Qué tamaño tiene este animal?","criteria":["Diminuto","Pequeño","Mediano","Grande","Enorme"]},
    "ratón":    {"type":"score","instructions":"¿Qué tamaño tiene este animal?","criteria":["Diminuto","Pequeño","Mediano","Grande","Enorme"]},
    "lenguado": {"type":"score","instructions":"¿Qué tamaño tiene este animal?","criteria":["Diminuto","Pequeño","Mediano","Grande","Enorme"]}
  }'
```

Salida observada (degenerada): las siete preguntas caen en el mismo punto,
~`1.75` ≈ «Mediano». La mosca y el elefante son indistinguibles.

### Bien: cada animal nombrado en sus `instructions`

```sh
jev ask --state "Compara el tamaño típico de cada animal." \
  --questions '{
    "gato":     {"type":"score","instructions":"¿Qué tamaño tiene un gato?","criteria":["Diminuto","Pequeño","Mediano","Grande","Enorme"]},
    "mosca":    {"type":"score","instructions":"¿Qué tamaño tiene una mosca?","criteria":["Diminuto","Pequeño","Mediano","Grande","Enorme"]},
    "elefante": {"type":"score","instructions":"¿Qué tamaño tiene un elefante?","criteria":["Diminuto","Pequeño","Mediano","Grande","Enorme"]},
    "narval":   {"type":"score","instructions":"¿Qué tamaño tiene un narval?","criteria":["Diminuto","Pequeño","Mediano","Grande","Enorme"]},
    "perro":    {"type":"score","instructions":"¿Qué tamaño tiene un perro?","criteria":["Diminuto","Pequeño","Mediano","Grande","Enorme"]},
    "ratón":    {"type":"score","instructions":"¿Qué tamaño tiene un ratón?","criteria":["Diminuto","Pequeño","Mediano","Grande","Enorme"]},
    "lenguado": {"type":"score","instructions":"¿Qué tamaño tiene un lenguado?","criteria":["Diminuto","Pequeño","Mediano","Grande","Enorme"]}
  }'
```

Salida (ilustrativa del orden de magnitud):

```text
  mosca:    score=0.03 ≈ "Diminuto" (confidence=0.99)
  ratón:    score=0.46 ≈ "Pequeño"  (confidence=0.93)
  lenguado: score=1.10 ≈ "Mediano"  (confidence=0.51)
  gato:     score=1.62 ≈ "Mediano"  (confidence=0.62)
  perro:    score=2.04 ≈ "Grande"   (confidence=0.57)
  narval:   score=3.12 ≈ "Grande"   (confidence=0.88)
  elefante: score=3.93 ≈ "Enorme"   (confidence=0.97)
```

La misma regla arregla los otros tipos:

| Tipo | Mal | Bien |
| --- | --- | --- |
| `noul` | `"¿Está aprobado?"` con el ticket solo en la clave | `"¿Está aprobado el ticket 4812?"` |
| `choice` | `"¿A qué equipo asignarlo?"` sin decir qué incidencia | `"¿A qué equipo asignar la incidencia «checkout caído»?"` |
| `score` | `"¿Qué tamaño tiene este animal?"` | `"¿Qué tamaño tiene un elefante?"` |

## 4. Dos patrones válidos

### A. Nombrar el elemento en cada `instructions`

Es el más simple y el más robusto: autocontenido, sin depender del orden de
`state`. Úsalo cuando los elementos son pocos o heterogéneos.

```json
{
  "state": "Compara el tamaño típico de cada animal.",
  "questions": {
    "gato": { "type": "score", "instructions": "¿Qué tamaño tiene un gato?", "criteria": ["Diminuto", "Pequeño", "Mediano", "Grande", "Enorme"] },
    "mosca": { "type": "score", "instructions": "¿Qué tamaño tiene una mosca?", "criteria": ["Diminuto", "Pequeño", "Mediano", "Grande", "Enorme"] }
  }
}
```

### B. Poner los elementos en `state` y referenciarlos por nombre

Útil con muchos elementos o con datos estructurados. **La referencia por nombre
sigue siendo obligatoria** en `instructions`.

```sh
jev ask \
  --state '{
    "gato": {"peso_kg": 4.5, "largo_cm": 46},
    "mosca": {"peso_kg": 0.00002, "largo_cm": 0.7},
    "elefante": {"peso_kg": 5400, "largo_cm": 650}
  }' \
  --questions '{
    "gato":     {"type":"score","instructions":"¿Qué tamaño tiene el gato del state?","criteria":["Diminuto","Pequeño","Mediano","Grande","Enorme"]},
    "mosca":    {"type":"score","instructions":"¿Qué tamaño tiene la mosca del state?","criteria":["Diminuto","Pequeño","Mediano","Grande","Enorme"]},
    "elefante": {"type":"score","instructions":"¿Qué tamaño tiene el elefante del state?","criteria":["Diminuto","Pequeño","Mediano","Grande","Enorme"]}
  }'
```

La clave sigue sirviendo para dos cosas: **recoger** la respuesta
(`.answers.gato`) y **etiquetar** el resultado en el informe de la CLI.

## 5. Cuándo separar en varios requests

Un request con N preguntas comparte un solo `state`, así que todos los
elementos viajan juntos y el modelo debe aislar el suyo. Si los elementos son
muchos o el `state` es largo, es más fiable lanzar **un request por elemento**
(o usar `jev batch` con una plantilla):

```sh
for animal in gato mosca elefante; do
  jev ask --no-save --json \
    --state "Animal: $animal." \
    --questions "{\"tamano\":{\"type\":\"score\",\"instructions\":\"¿Qué tamaño tiene un $animal?\",\"criteria\":[\"Diminuto\",\"Pequeño\",\"Mediano\",\"Grande\",\"Enorme\"]}}" \
    2>/dev/null | jq -r --arg a "$animal" '[$a, .answers.tamano.score] | @tsv'
done
```

Ventajas: cada petición tiene un `state` mínimo y un único referente. Coste:
más llamadas HTTP (y más tokens de sistema por request).

## 6. Checklist antes de enviar

- [ ] Cada `instructions` se entiende **sin mirar la clave**.
- [ ] Si hay varios elementos, cada pregunta nombra el suyo.
- [ ] Si el elemento vive en `state`, `instructions` lo referencia por nombre.
- [ ] `state` no contiene elementos que la pregunta no necesite (ruido).
- [ ] La clave es descriptiva porque es la que leerás en `answers` y en el
      historial.
