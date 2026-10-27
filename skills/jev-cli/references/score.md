# `score` operation

## 1. What it is and what it returns

`score` assigns a **rating within an ordered scale**. `criteria` is an
**ordered array** `[level0, level1, …]`; the position in the array is the score
(`0` for the first, `1` for the second…). It is used for urgency, frustration,
priority, severity…

Exact shape of the response (per question):

```json
{
  "type": "score",
  "score": 1.99,
  "confidence": 0.98,
  "legend": { "0": "It can wait", "1": "This week", "2": "Today" },
  "probabilities": { "2": 0.99, "1": 0.01, "0": 0 }
}
```

- `score`: weighted mean of the rating; it can be a decimal.
- `legend`: map `"position" -> label` from your `criteria`.
- `probabilities`: probability for each position.

In the CLI's readable report, when the `score` falls between two levels it is
marked with `≈`:

```text
  urgency: score=1.99 ≈ "Today" (confidence=0.98)
    2=0.99, 1=0.01, 0=0
```

When it falls exactly on a level, there is no `≈`.

## 2. Shape of the question JSON

```json
{
  "urgency": {
    "type": "score",
    "instructions": "How urgent is the issue?",
    "criteria": ["It can wait", "This week", "Today"]
  }
}
```

`criteria` is **required** in `score`: an ordered array, from lowest to highest.

## 3. Console examples

### Inline with `--state` and `--score`

```sh
jev ask \
  --state "We have gone two days without a reply and the checkout is down." \
  --score 'urgency=How urgent is the issue?' \
  --level 'urgency=It can wait' \
  --level 'urgency=This week' \
  --level 'urgency=Today'
```

```text
model: jev-1.13
  urgency: score=1.99 ≈ "Today" (confidence=0.98)
    2=0.99, 1=0.01, 0=0
tokens: 20 in / 5 out, cost=2.9e-6      ← to stderr
```

### From files (`--state-file`, `--questions-file`)

```sh
jev ask --state-file examples/state.json --questions-file examples/questions.json
```

The `urgency` question in `examples/questions.json` is a `score` with
`["It can wait", "This week", "Today"]`.

### From stdin (`--state -`)

```sh
echo "The customer is threatening to cancel." | jev ask --state - \
  --score 'frustration=How frustrated is the customer?' \
  --level 'frustration=Calm' \
  --level 'frustration=Upset' \
  --level 'frustration=Very angry'
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
    "urgency": {
      "type": "score",
      "score": 0.42,
      "confidence": 0.79,
      "legend": { "0": "It can wait", "1": "This week", "2": "Today" },
      "probabilities": { "0": 0.61, "1": 0.36, "2": 0.03 }
    }
  },
  "usage": { "input_tokens": 130, "output_tokens": 19, "cost": 3.7e-6 }
}
```

### Mixing several types in the same request

`jev demo` runs the three types at once (`is_urgent` noul, `team` choice,
`frustration` score):

```sh
jev demo
```

```text
model: jev-1.13
  frustration: score=1.99 ≈ "Very angry" (confidence=0.98)
    2=0.99, 1=0.01, 0=0
  is_urgent: noul=0.99
  team: choice=infra (confidence=0.59)
    infra=0.73, billing=0.27, sales=0
tokens: 449 in / 73 out, cost=1.886e-5
```

## 4. Bash script example

Reusable function, reading the result with `jq`, a threshold on the score and
exit-code handling:

```bash
#!/usr/bin/env bash

DB="$(mktemp -d)/jev.db"
trap 'rm -rf "$(dirname "$DB")"' EXIT

# Rate urgency and return "score<TAB>level" (nearest label).
score_urgency() {
  local state="$1"

  local out code
  out=$(jev ask --db "$DB" --no-save --json \
          --state "$state" \
          --score 'urgency=How urgent is the issue?' \
          --level 'urgency=It can wait' \
          --level 'urgency=This week' \
          --level 'urgency=Today' \
          2>/dev/null)
  code=$?

  if [ "$code" -ne 0 ]; then
    echo "error: jev ask exited with code $code" >&2
    return "$code"
  fi

  # score + label of the rounded level ("0"/"1"/"2" key of the legend).
  jq -r '
    .answers.urgency as $u
    | ($u.score | round | tostring) as $k
    | [($u.score | tostring), ($u.legend[$k] // "?")]
    | @tsv
  ' <<<"$out"
}

ticket="The checkout has been down for an hour."

read -r score level <<<"$(score_urgency "$ticket")" || exit $?

echo "urgency: $score → $level"

# Threshold on the score (>= 1 is considered urgent).
if awk "BEGIN{exit !($score >= 1)}"; then
  echo "→ escalate today"
else
  echo "→ schedule"
fi
```

```text
urgency: 1.99 → Today
→ escalate today
```

Script notes:

- `round` on the score locates the `legend` level (the CLI uses the same
  criterion to print the label, with `≈` when it is not exact).
- `--no-save` + a temporary `--db` isolate the run.
- The exit code of `jev ask` is captured and propagated (`0`/`1`/`2`).

## 5. Typical errors and hints

- **`criteria` with the wrong shape** — in `score` it must be an **ordered
  array** (`["a","b","c"]`). Passing an object `{ "0": "a", … }` or a string
  produces a malformed question; use an object for `choice`.
- **Empty or missing `criteria`** — `score` requires at least two levels;
  without `criteria` the API responds `422` (the CLI adds a `hint:`).
- **Array order** — the position defines the rating; make sure to order from
  lowest to highest intensity, or the result will be counterintuitive.
- **All scores come out nearly the same** — if you evaluate several items in a
  single request, name them in each `instructions`: the key is not sent to the
  model and `state` is shared (see
  [`question-anatomy.md`](question-anatomy.md)).
- **`401` / `api_key_expired`** — invalid/expired key; renew it at
  https://opencode.ai/console.
- **`429 FreeUsageLimitError`** — quota exhausted; try `--model jev-1.13`.
- **`422`** — malformed question or upstream failure; check
  https://docs.typesafe.ai/primitives.
- **Timeouts and retries** — `--timeout` (default 30 s) per attempt and
  `--retries` (default 2) on 429/5xx and network errors.

## 6. Precision notes

The model is trained mostly in English; it accepts other languages with
somewhat less precision. With subjective scales, make the levels **mutually
exclusive and anchored to observable signals** ("It can wait", "This week",
"Today" are more stable than "a little", "somewhat", "a lot") and put the
criterion inside the `instructions` ("how urgent is the issue in terms of
deadline?").
