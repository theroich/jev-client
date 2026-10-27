# `choice` operation

## 1. What it is and what it returns

`choice` classifies the `state` into **one option among several** fixed ones.
`criteria` is an **object** `{ key: description }`, where `key` is the value the
model can choose and `description` explains what it means.

Exact shape of the response (per question):

```json
{
  "type": "choice",
  "choice": "infra",
  "confidence": 0.59,
  "probabilities": { "infra": 0.73, "billing": 0.27, "sales": 0 }
}
```

- `choice`: the chosen `criteria` key.
- `confidence`: confidence (0–1) in the choice.
- `probabilities`: probability for each `criteria` key.

In the CLI's readable report:

```text
  team: choice=infra (confidence=0.59)
    infra=0.73, billing=0.27, sales=0
```

Probabilities are sorted from highest to lowest.

## 2. Shape of the question JSON

```json
{
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
```

`criteria` is **required** in `choice` (a non-empty object). Without `criteria`,
the request arrives malformed and usually ends in a `422`.

## 3. Console examples

### Inline with `--state` and `--choice`

```sh
jev ask \
  --state "The checkout has been down for 30 minutes and we are losing sales." \
  --choice 'team=Which team should handle the issue?' \
  --option 'team.billing=Charges, invoices or payments' \
  --option 'team.infra=Outages, 500 errors or platform problems' \
  --option 'team.sales=Pricing or sales questions'
```

```text
model: jev-1.13
  team: choice=infra (confidence=0.59)
    infra=0.73, billing=0.27, sales=0
tokens: 22 in / 6 out, cost=3.1e-6      ← to stderr
```

### From files (`--state-file`, `--questions-file`)

```sh
jev ask --state-file examples/state.json --questions-file examples/questions.json
```

The `team` question in `examples/questions.json` is a `choice` with
`billing`/`infra`/`sales`.

### From stdin (`--state -`)

```sh
printf 'This month’s invoice never arrived.' | jev ask --state - \
  --choice 'team=Which team should handle it?' \
  --option 'team.billing=Invoices' \
  --option 'team.infra=Outages' \
  --option 'team.sales=Sales'
```

### With `--json` for machine consumption

```sh
jev ask --state-file examples/state.json --questions-file examples/questions.json \
  --json 2>/dev/null
```

```json
{
  "model": "jev-1.13",
  "answers": {
    "team": {
      "type": "choice",
      "choice": "billing",
      "confidence": 0.61,
      "probabilities": { "billing": 0.61, "infra": 0.25, "sales": 0.14 }
    }
  },
  "usage": { "input_tokens": 130, "output_tokens": 21, "cost": 4.1e-6 }
}
```

### Mixing several types in the same request

`examples/request.json` combines `refund` (`noul`) and `tone` (`choice`):

```sh
jev ask --request-file examples/request.json
```

```text
model: jev-1.13
  refund: noul=0.96
  tone: choice=angry (confidence=0.8)
    angry=0.8, calm=0.2
tokens: 96 in / 14 out, cost=2.2e-6
```

## 4. Bash script example

Reusable function, reading the result with `jq`, a `case` on the answer and
exit-code handling:

```bash
#!/usr/bin/env bash

DB="$(mktemp -d)/jev.db"
trap 'rm -rf "$(dirname "$DB")"' EXIT

# Classify a text and return the chosen key.
classify() {
  local state="$1"

  local out code
  out=$(jev ask --db "$DB" --no-save --json \
          --state "$state" \
          --choice 'team=Which team should handle the issue?' \
          --option 'team.billing=Charges, invoices or payments' \
          --option 'team.infra=Outages, 500 errors or platform problems' \
          --option 'team.sales=Pricing or sales questions' \
          2>/dev/null)
  code=$?

  if [ "$code" -ne 0 ]; then
    echo "error: jev ask exited with code $code" >&2
    return "$code"
  fi

  # Chosen key + confidence, separated by a tab.
  jq -r '[.answers.team.choice, .answers.team.confidence] | @tsv' <<<"$out"
}

ticket="The checkout has been down for 30 minutes and we are losing sales."

read -r team conf <<<"$(classify "$ticket")" || exit $?

echo "team: $team (confidence: $conf)"

case "$team" in
  billing) echo "→ assign to billing" ;;
  infra)   echo "→ assign to infrastructure" ;;
  sales)   echo "→ assign to sales" ;;
  *)       echo "→ manual review" ;;
esac
```

```text
team: infra (confidence: 0.59)
→ assign to infrastructure
```

Script notes:

- `jq -r '[…] | @tsv'` produces `infra<TAB>0.59`, which `read -r team conf`
  splits on the tab (default IFS).
- `--no-save` + a temporary `--db` avoid polluting the user's history.
- The `case` dispatches the decision; if `classify` fails, its exit code is
  propagated.

## 5. Typical errors and hints

- **`criteria` with the wrong shape** — in `choice` it must be an **object**
  `{ key: description }`. Passing an array (`["a","b"]`) or a string produces a
  malformed question; use an ordered array for `score`, not for `choice`.
- **Empty or missing `criteria`** — `choice` requires at least one key; without
  `criteria` the API responds `422` (the CLI adds a `hint:`).
- **All questions choose the same option** — if you evaluate several items in a
  single request, name them in each `instructions`: the key is not sent to the
  model and `state` is shared (see
  [`question-anatomy.md`](question-anatomy.md)).
- **`401` / `api_key_expired`** — invalid/expired key; the CLI suggests renewing
  it at https://opencode.ai/console.
- **`429 FreeUsageLimitError`** — quota exhausted; try `--model jev-1.13`.
- **`422`** — malformed question (invalid type, missing `criteria`) or upstream
  failure; check https://docs.typesafe.ai/primitives.
- **Timeouts and retries** — `--timeout` (default 30 s) per attempt and
  `--retries` (default 2) on 429/5xx and network errors.

## 6. Precision notes

The model is trained mostly in English; it accepts other languages with
somewhat less precision. Make the `criteria` descriptions **mutually exclusive
and explicit** so that classification is stable: "Charges, invoices or
payments" is more reliable than "billing".
