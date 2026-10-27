# Use as a library

```ts
import { JevClient, type Question } from "jev-client";

const client = new JevClient({ apiKey: process.env.OPENCODE_API_KEY! });

const questions: Record<string, Question> = {
  refund: { type: "noul", instructions: "Is the customer asking for a refund?" },
  team: {
    type: "choice",
    instructions: "Which team should handle it?",
    criteria: {
      billing: "Charges and invoices",
      legal: "Legal claims",
    },
  },
  urgency: {
    type: "score",
    instructions: "How urgent is it?",
    criteria: ["It can wait", "This week", "Today"],
  },
};

const response = await client.systemOne(
  { ticket: "I was charged twice", plan: "pro" },
  questions,
);

console.log(response.answers.refund?.noul);        // number | undefined
console.log(response.answers.team?.choice);        // string | undefined
console.log(response.answers.team?.probabilities); // Record<string, number>
console.log(response.usage.cost);                  // number | undefined
```

From this repository without publishing, import from `./dist/src/index.js`.

## Client options

```ts
new JevClient({
  apiKey,
  endpoint,        // default: OpenCode
  model,           // default: jev-1.13
  timeoutMs,       // default: 30000
  maxRetries,      // default: 2
  backoffMs,       // default: 500
  maxRetryDelayMs, // default: 10000 (cap for Retry-After)
});
```

`run()` accepts a complete request (`{ model, state, questions }`) and `raw`
contains the original API body.

## Templates

`resolveTemplateBody` resolves a body with macros and validates it:

```ts
import { resolveTemplateBody } from "jev-client";

const request = resolveTemplateBody(
  '{"model":"jev-1.13","state":"{{state}}","questions":{"q":{"type":"noul"}}}',
  { state: { order: 42 } },
);
```
