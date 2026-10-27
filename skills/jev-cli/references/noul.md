# `noul` operation

## 1. What it is and what it returns

`noul` is the **yes/no** question: given an instruction ("does it deal with
billing?", "is it urgent?", "does it ask for a refund?"), the model returns the
probability that the answer is "yes".

Exact shape of the response (per question):

```json
{ "type": "noul", "noul": 0.99 }
```

- `noul`: number in `[0, 1]` — probability of "yes".
- It carries no `confidence` or `probabilities` (those belong to
  `choice`/`score`).

In the CLI's readable report one line is printed:

```text
  billing: noul=0.99
```

## 2. Shape of the question JSON

Minimal (only `instructions`):

```json
{
  "billing": { "type": "noul", "instructions": "Does the message deal with billing or payments?" }
}
```

With optional `criteria` (a string that helps the model define the criterion):

```json
{
  "urgent": {
    "type": "noul",
    "instructions": "Does the message convey urgency?",
    "criteria": "It counts as urgent if it mentions outages, losses or deadlines."
  }
}
```

## 3. Console examples

### Inline with `--state` and `--noul`

```sh
jev ask \
  --state "I was charged twice this month." \
  --noul 'billing=Is it about billing?'
```

```text
model: jev-1.13
  billing: noul=0.99
tokens: 12 in / 3 out, cost=1.5e-6      ← goes to stderr
```

> The numeric values are illustrative; the **format** is what the CLI prints.
> The `tokens:` line goes to stderr, not stdout.

### From files (`--state-file`, `--questions-file`)

```sh
jev ask --state-file examples/state.json --questions-file examples/questions.json
```

`examples/questions.json` mixes the three types; the `noul` part is `billing`.

### From stdin (`--state -`)

```sh
echo "The checkout is down" | jev ask --state - \
  --noul 'urgent=Is it urgent?'
```

### With `--json` for machine consumption

```sh
jev ask --state "I was charged twice this month." \
  --noul 'billing=Is it about billing?' \
  --json 2>/dev/null
```

```json
{
  "model": "jev-1.13",
  "answers": {
    "billing": { "type": "noul", "noul": 0.99 }
  },
  "usage": { "input_tokens": 12, "output_tokens": 3, "cost": 1.5e-6 }
}
```

`--json` prints the raw API response to stdout; the token summary goes to
stderr, which is why `2>/dev/null` discards it when redirecting to a file.

### Mixing several types in the same request

```sh
jev ask --request-file examples/request.json --json 2>/dev/null
```

`examples/request.json` combines `refund` (`noul`) and `tone` (`choice`) in a
single request. The response returns one entry per question:

```json
{
  "model": "jev-1.13",
  "answers": {
    "refund": { "type": "noul", "noul": 0.99 },
    "tone": { "type": "choice", "choice": "angry", "confidence": 0.8, "probabilities": { "angry": 0.8, "calm": 0.2 } }
  },
  "usage": { "input_tokens": 96, "output_tokens": 14, "cost": 2.2e-6 }
}
```

## 4. Bash script example

Reusable function, reading with `jq`, a threshold on the answer and exit-code
handling:

```bash
#!/usr/bin/env bash

# Isolated database: does not touch the user's and is removed on exit.
DB="$(mktemp -d)/jev.db"
trap 'rm -rf "$(dirname "$DB")"' EXIT

# Evaluate a noul question and return the probability of "yes" (0-1).
ask_noul() {
  local state="$1" instructions="$2"

  local out code
  out=$(jev ask --db "$DB" --no-save --json \
          --state "$state" --noul "q=$instructions" 2>/dev/null)
  code=$?

  if [ "$code" -ne 0 ]; then
    echo "error: jev ask exited with code $code" >&2
    return "$code"
  fi

  jq -r '.answers.q.noul' <<<"$out"
}

ticket="I was charged twice this month."

result=$(ask_noul "$ticket" "Does it deal with billing or payments?") || exit $?

echo "billing probability: $result"

# Threshold: >= 0.5 is treated as "yes".
if awk "BEGIN{exit !($result >= 0.5)}"; then
  echo "→ route to billing"
else
  echo "→ not billing"
fi
```

```text
billing probability: 0.99
→ route to billing
```

Script notes:

- `--no-save` prevents recording the run in the history; `--db "$DB"` isolates
  the database in a temporary directory.
- `--json` + `2>/dev/null` leaves only the JSON on stdout for `jq`.
- The exit code of `jev ask` is captured and propagated: `0` ok, `1` API or
  configuration error, `2` incorrect usage.

## 5. Typical errors and hints

- **`401` / `api_key_expired`** — invalid or expired key. The CLI adds a
  `hint:` with the recommended action (create a new one at
  https://opencode.ai/console and export it as `OPENCODE_API_KEY`).
- **`429 FreeUsageLimitError`** — free model quota exhausted or usage outside
  OpenCode. Try `--model jev-1.13`.
- **`422`** — malformed question or upstream failure; check
  https://docs.typesafe.ai/primitives.
- **`criteria` with the wrong shape** — in `noul`, `criteria` is an optional
  string, not an object or an array. An object/array here is for
  `choice`/`score`.
- **All questions return the same probability** — if you evaluate several items
  in a single request, name them in each `instructions`: the key is not sent to
  the model and `state` is shared (see
  [`question-anatomy.md`](question-anatomy.md)).
- **Missing API key** — `error: missing API key` (code `1`). Use `--key`,
  `OPENCODE_API_KEY`/`JEV_API_KEY`, or `jev config set api_key`.
- **Timeouts and retries** — each attempt has `--timeout` (default 30 s) and
  `--retries` (default 2) on 429/5xx and network errors; `Retry-After` is
  capped at 10 s.

## 6. Precision notes

The model is trained mostly in English; it accepts other languages with
somewhat less precision. To mitigate that, phrase `instructions` explicitly and
put the criterion inside the instruction (or use `criteria` as a string):
"Is the message about billing or payments?" is more reliable than "billing?".
