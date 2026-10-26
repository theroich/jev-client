# Uso como librería

```ts
import { JevClient, type Question } from "jev-client";

const client = new JevClient({ apiKey: process.env.OPENCODE_API_KEY! });

const questions: Record<string, Question> = {
  refund: { type: "noul", instructions: "¿El cliente pide un reembolso?" },
  team: {
    type: "choice",
    instructions: "¿Qué equipo debe atenderlo?",
    criteria: {
      billing: "Cobros y facturas",
      legal: "Reclamaciones legales",
    },
  },
  urgency: {
    type: "score",
    instructions: "¿Cómo de urgente es?",
    criteria: ["Puede esperar", "Esta semana", "Hoy"],
  },
};

const response = await client.systemOne(
  { ticket: "Me han cobrado dos veces", plan: "pro" },
  questions,
);

console.log(response.answers.refund?.noul);        // number | undefined
console.log(response.answers.team?.choice);        // string | undefined
console.log(response.answers.team?.probabilities); // Record<string, number>
console.log(response.usage.cost);                  // number | undefined
```

Desde este repositorio sin publicar, importa desde `./dist/src/index.js`.

## Opciones del cliente

```ts
new JevClient({
  apiKey,
  endpoint,        // default: OpenCode
  model,           // default: jev-1.13
  timeoutMs,       // default: 30000
  maxRetries,      // default: 2
  backoffMs,       // default: 500
  maxRetryDelayMs, // default: 10000 (tope del Retry-After)
});
```

`run()` acepta un request completo (`{ model, state, questions }`) y `raw`
contiene el cuerpo original de la API.

## Plantillas

`resolveTemplateBody` resuelve un body con macros y lo valida:

```ts
import { resolveTemplateBody } from "jev-client";

const request = resolveTemplateBody(
  '{"model":"jev-1.13","state":"{{estado}}","questions":{"q":{"type":"noul"}}}',
  { estado: { pedido: 42 } },
);
```
