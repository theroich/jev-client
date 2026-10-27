# Template manual (`jev template`)

A **template** is a Jev payload (a request: `model`, `state`, `questions`) with
**placeholders** `{{key}}` that are resolved from a context map. It lets you
reuse the same classification without rewriting the JSON every time, and lets
an agent know which context data it needs.

## Anatomy of a template

```json
{
  "model": "jev-1.13",
  "state": {
    "order": "{{order_state}}",
    "customer": "{{customer.name}}",
    "plan": "{{customer.plan}}"
  },
  "questions": {
    "urgent": { "type": "noul", "instructions": "Is it urgent?" }
  }
}
```

Macro rules (see `src/template.ts`):

- **`{{key}}`** looks the key up in the context; **nested paths** are supported
  (`{{customer.name}}`). If a literal key containing dots exists, it takes
  precedence over the nested path.
- **Native insertion**: if the string is **exactly** one macro, the value is
  inserted with its type (object, array, number, boolean). If it is embedded in
  text, it is interpolated as a string. E.g.: `"plan": "{{customer.plan}}"`
  with `{ "customer": { "plan": "pro" } }` → `"plan": "pro"`.
- **Escaping**: `\{{...}}` produces the literal text `{{...}}` without
  resolving it.
- **If a key is missing**, the command fails **before calling the API** and
  lists all the missing keys:

  ```text
  error: missing macros in context: customer.plan
  ```

- The result is validated as a request (model, state, questions and question
  types).

## Full lifecycle

### `create` (and its alias `add`)

Save a template from a file (overwrites if the name already exists):

```sh
jev template create order --description "Order with customer" \
  --file examples/template.json \
  --macro-desc 'order_state=What the customer is asking for, in free text' \
  --macro-desc 'customer.name=Customer name' \
  --macro-schema 'customer.plan={"type":"string","enum":["free","pro","enterprise"]}' \
  --macro-type 'customer.name=string'
```

```text
template saved: order
```

Also inline or from stdin:

```sh
jev template create order --body '{"model":"jev-1.13", ...}'
cat body.json | jev template create order --body -
```

`template add` is a synonym for `create`; `--body-file <path>` is a synonym for
`--file`.

### `list` and `show`

```sh
jev template list                       # order - Order with customer
jev template list --json                # array with description, dates and macros
jev template show order                 # body + macros with description/schema
jev template show order --json          # { name, description, body, macros, ... }
```

`show` in text mode prints the description and schema under each macro:

```text
  {{customer.plan}}
    Plan purchased by the customer
    schema: {"type":"string","enum":["free","pro"]}
```

### `edit`

```sh
# Opens $EDITOR (or VISUAL); fails if neither is defined
jev template edit order

# Or replace the body from a file, without opening an editor
jev template edit order --file new.json

# Adjust macro metadata without touching the body
jev template edit order --file new.json \
  --macro-desc 'ticket=Order identifier (TCK-1042)' \
  --clear-macro-desc 'customer.name' \
  --macro-type 'ticket=string' \
  --clear-macro-schema 'customer.plan'
```

Without macro flags, `edit` preserves existing descriptions and schemas.

### `validate`

Validates a saved template or a file **without sending anything** to the API:

```sh
jev template validate order
jev template validate --file examples/template.json
```

```text
valid template: order
```

Useful in CI to check that the bodies committed in the repo are valid requests.

### `render`

Previews the resolved request **without calling Jev** (spends no tokens):

```sh
jev template render order --context-file examples/context.json
```

```json
{
  "model": "jev-1.13",
  "state": {
    "order": "I was charged twice and I want a refund.",
    "customer": "Ana",
    "plan": "pro"
  },
  "questions": {
    "urgent": { "type": "noul", "instructions": "Is it urgent?" }
  }
}
```

Also with the context inline: `jev template render order --context '{"order_state":"pending","customer":{"name":"Ana","plan":"pro"}}'`.

### `delete` (and its alias `remove`)

```sh
jev template delete order       # asks for confirmation
jev template delete order --yes # no confirmation
jev template remove order       # alias of delete without confirmation
```

## Macro metadata

Each macro can carry a **description** and a **JSON Schema** (informational).
They are not sent to Jev and do not alter rendering: they only help humans and
agents.

| Flag | Effect |
| --- | --- |
| `--macro-desc <key>=<text>` | describes the macro (repeatable; max. 500 chars) |
| `--clear-macro-desc <key>` | clears the description |
| `--macro-schema <key>=<json>` | stores a complete JSON Schema (object or boolean) |
| `--macro-type <key>=<type>` | shortcut for `{"type":"<type>"}` |
| `--clear-macro-schema <key>` | removes the schema while keeping the description |

Types accepted by `--macro-type`: `string`, `number`, `integer`, `boolean`,
`object`, `array`, `null`.

## Minimal template for each question type

The starters in `src/template-starters.ts` share the same `state` with macros
(`{{order_state}}`, `{{customer.name}}`, `{{customer.plan}}`) that
`examples/context.json` resolves, so they can be rendered right after being
created.

### `noul`

```json
{
  "model": "jev-1.13",
  "state": {
    "ticket": "{{order_state}}",
    "customer": "{{customer.name}}",
    "plan": "{{customer.plan}}"
  },
  "questions": {
    "urgent": { "type": "noul", "instructions": "Is it urgent?" }
  }
}
```

### `choice`

```json
{
  "model": "jev-1.13",
  "state": {
    "ticket": "{{order_state}}",
    "customer": "{{customer.name}}",
    "plan": "{{customer.plan}}"
  },
  "questions": {
    "team": {
      "type": "choice",
      "instructions": "Which team should handle the issue?",
      "criteria": {
        "billing": "Charges, invoices or payments",
        "infra": "Outages, 500 errors or platform problems",
        "sales": "Pricing or sales questions"
      }
    }
  }
}
```

### `score`

```json
{
  "model": "jev-1.13",
  "state": {
    "ticket": "{{order_state}}",
    "customer": "{{customer.name}}",
    "plan": "{{customer.plan}}"
  },
  "questions": {
    "urgency": {
      "type": "score",
      "instructions": "How urgent is the issue?",
      "criteria": ["It can wait", "This week", "Today"]
    }
  }
}
```

## Real end-to-end cases

### Case 1: support ticket classification

Create the template, validate it, render it as a dry run and run it:

```sh
# 1. Save the template
jev template create support --description "Classify a support ticket" \
  --file examples/template.json \
  --macro-desc 'order_state=Ticket description in free text' \
  --macro-desc 'customer.name=Customer name' \
  --macro-desc 'customer.plan=Customer plan'

# 2. Dry-run validation (no tokens spent)
jev template validate support

# 3. Dry-run render to review the resolved request
jev template render support --context-file examples/context.json

# 4. Actually run it
jev template render support --context-file examples/context.json > /tmp/req.json
jev ask --request-file /tmp/req.json --json 2>/dev/null | jq '.answers'
```

### Case 2: batch issue triage (`batch`)

With `examples/contexts.json` (an array of three contexts) run the template
once per context:

```sh
jev batch support --contexts examples/contexts.json
```

```text
batch: support — 3 requests (batch 4f3c…)
  1: ok    jev-1.13  12 in / 3 out  cost=1.5e-6
  2: ok    jev-1.13  12 in / 3 out  cost=1.5e-6
  3: ok    jev-1.13  12 in / 3 out  cost=1.5e-6
summary: 3 ok, 0 error
tokens: 36 in / 9 out
cost: 4.5e-6
```

With concurrency, `--fail-fast` and `--json`:

```sh
jev batch support --contexts examples/contexts.json \
  --concurrency 3 --fail-fast --json 2>/dev/null | jq '.ok, .errors'
```

The `batch` `--json` prints a single object with `batch_id`, `template`,
`total`, `processed`, `skipped`, `ok`, `errors`, `input_tokens`,
`output_tokens`, `cost`, `cost_unknown` and `items` (one per context, in order,
with `index`, `ok`, `model`, tokens, `cost`, `error` and the raw `response`).

`batch` rules:

- `--contexts <file.json>` expects an array of context maps; `-` reads from
  stdin.
- `--concurrency <n>` simultaneous requests (default `1`, max. `10`).
- `--continue-on-error` (default) keeps going with the rest; `--fail-fast`
  stops on the first error. With errors, the process exits with code `1`.
- Each request writes a row to the history with the same `batch_id` and its
  `template_name`.

### Case 3: lead prioritization

```json
{
  "model": "jev-1.13",
  "state": {
    "company": "{{company}}",
    "sector": "{{sector}}",
    "message": "{{message}}"
  },
  "questions": {
    "priority": {
      "type": "score",
      "instructions": "How high a priority is this lead?",
      "criteria": ["Low", "Medium", "High"]
    },
    "interest": {
      "type": "noul",
      "instructions": "Do they show purchase intent?"
    }
  }
}
```

### Case 4: content moderation

```json
{
  "model": "jev-1.13",
  "state": {
    "text": "{{text}}"
  },
  "questions": {
    "decision": {
      "type": "choice",
      "instructions": "Is the content publishable?",
      "criteria": {
        "ok": "Publishable as is",
        "review": "Needs human review",
        "block": "Violates the rules"
      }
    }
  }
}
```

## `render` as a dry run and `validate` in CI

- **`render`** resolves the macros and previews the request **without spending
  tokens**. It is the recommended step before any real execution.
- **`validate`** checks the structure of the body (or of a file) without sending
  anything; it fits in CI so that the bodies versioned in the repo do not break:

  ```sh
  jev template validate --file templates/support.json
  ```

## Templates + bash scripts

Create/update the template from a file, render, run and filter with `jq`, all
non-interactively:

```bash
#!/usr/bin/env bash
set -uo pipefail

DB="$(mktemp -d)/jev.db"
trap 'rm -rf "$(dirname "$DB")"' EXIT

TICKET="${1:-The checkout has been down for 30 minutes and we are losing sales.}"

# 1. Create the template from an inline body with a {{ticket}} macro.
jev template create moderation --description "Moderate a text" --db "$DB" \
  --body '{
    "model": "jev-1.13",
    "state": { "text": "{{ticket}}" },
    "questions": {
      "decision": {
        "type": "choice",
        "instructions": "Is the content publishable?",
        "criteria": { "ok": "Publishable", "review": "Review", "block": "Block" }
      }
    }
  }' \
  --macro-desc 'ticket=Text to moderate'

# 2. Dry-run render and check that it resolves (no tokens spent).
if ! jev template render moderation --db "$DB" \
     --context "$(jq -nc --arg t "$TICKET" '{ticket:$t}')" > /tmp/req.json; then
  echo "error: render failed (missing macros or invalid body)" >&2
  exit 1
fi

# 3. Run and keep only the decision.
jev ask --db "$DB" --no-save --json --request-file /tmp/req.json 2>/dev/null \
  | jq -r '.answers.decision.choice'
```

## Best practices

- **Version the bodies in the repo** (e.g. `templates/*.json`) and create them
  in CI with `jev template create --file`; that way the template is
  reproducible and auditable.
- **One macro per context variable**: `{{order_state}}` and
  `{{customer.name}}` separately, instead of a single concatenated `{{all}}`.
  It makes it easier to document and type each macro with
  `--macro-desc`/`--macro-type`.
- **Structured `state` instead of concatenating text**: an object with separate
  fields is evaluated better than a flat paragraph, and it enables nested
  paths.
- **Describe the macros** (`--macro-desc`) and, if there is a finite domain,
  **type them with `--macro-type` or `--macro-schema`**: it helps agents
  generate valid contexts (and the per-template MCP tool).
- **`render` before spending tokens**: it resolves and validates without
  calling the API; it is the cheap dry run.
- **`--no-save` and a temporary `--db` in scripts** to avoid polluting the
  history or the user's database.
- Remember that a macro's description and schema **are not sent to Jev**: they
  are local metadata and do not change the result.
