# Question anatomy: what the model sees

This reference explains **what information actually reaches the model** for each
question. It is the cause of an entire class of degenerate results: questions
that all return the same value because the model does not know which item you
are talking about. It applies equally to `noul`, `choice` and `score`.

## 1. The payload sent to the API

A Jev request has exactly this shape (see `src/types.ts`):

```json
{
  "model": "jev-1.13",
  "state": "…",
  "questions": {
    "<key>": {
      "type": "noul | choice | score",
      "instructions": "…",
      "criteria": "…"
    }
  }
}
```

- **`state`**: `string | object | array`. It is the material the model evaluates.
- **`questions`**: an **object** `key -> question`. The key is the answer
  identifier, not part of the question.
- **`type`**: `noul`, `choice` or `score` (see the other references).
- **`instructions`**: what is being asked.
- **`criteria`**: optional string in `noul`, object in `choice`, ordered array
  in `score`.

## 2. The three rules that follow

1. **`state` is single and shared** by all the questions in the request. There
   is no per-question `state`: if you evaluate seven items, all seven receive
   the same `state`.
2. **The `questions` key is not sent to the model.** `"cat"` in
   `{"cat": {…}}` is used to find `answers.cat` in the response, but it does not
   appear in the prompt.
3. **The only thing the model sees per question is
   `state` + `instructions` + `criteria`.**

Practical consequence: the subject of the question must be **inside
`instructions`** (or inside `state`, and then you must reference it by name in
`instructions`). Never only in the key.

```text
question sent:  { "instructions": "What size is this animal?" }
key:            "cat"     ← does not travel to the model
state:          "cat, fly, elephant, …"   ← shared with all 7 questions

model sees:     "cat, fly, elephant, … What size is this animal?"
```

"This animal" has no unique referent: the model answers the same (or something
in between) for every key.

## 3. The real case: evaluating N items in a single request

Scenario: rate the size of seven animals with `score`.

Scale:

```json
["Tiny", "Small", "Medium", "Large", "Huge"]
```

### Wrong: the animal only in the key

```sh
jev ask --state "cat, fly, elephant, narwhal, dog, mouse, sole" \
  --questions '{
    "cat":      {"type":"score","instructions":"What size is this animal?","criteria":["Tiny","Small","Medium","Large","Huge"]},
    "fly":      {"type":"score","instructions":"What size is this animal?","criteria":["Tiny","Small","Medium","Large","Huge"]},
    "elephant": {"type":"score","instructions":"What size is this animal?","criteria":["Tiny","Small","Medium","Large","Huge"]},
    "narwhal":  {"type":"score","instructions":"What size is this animal?","criteria":["Tiny","Small","Medium","Large","Huge"]},
    "dog":      {"type":"score","instructions":"What size is this animal?","criteria":["Tiny","Small","Medium","Large","Huge"]},
    "mouse":    {"type":"score","instructions":"What size is this animal?","criteria":["Tiny","Small","Medium","Large","Huge"]},
    "sole":     {"type":"score","instructions":"What size is this animal?","criteria":["Tiny","Small","Medium","Large","Huge"]}
  }'
```

Observed output (degenerate): all seven questions land on the same point,
~`1.75` ≈ "Medium". The fly and the elephant are indistinguishable.

### Right: each animal named in its `instructions`

```sh
jev ask --state "Compare the typical size of each animal." \
  --questions '{
    "cat":      {"type":"score","instructions":"What size is a cat?","criteria":["Tiny","Small","Medium","Large","Huge"]},
    "fly":      {"type":"score","instructions":"What size is a fly?","criteria":["Tiny","Small","Medium","Large","Huge"]},
    "elephant": {"type":"score","instructions":"What size is an elephant?","criteria":["Tiny","Small","Medium","Large","Huge"]},
    "narwhal":  {"type":"score","instructions":"What size is a narwhal?","criteria":["Tiny","Small","Medium","Large","Huge"]},
    "dog":      {"type":"score","instructions":"What size is a dog?","criteria":["Tiny","Small","Medium","Large","Huge"]},
    "mouse":    {"type":"score","instructions":"What size is a mouse?","criteria":["Tiny","Small","Medium","Large","Huge"]},
    "sole":     {"type":"score","instructions":"What size is a sole?","criteria":["Tiny","Small","Medium","Large","Huge"]}
  }'
```

Output (illustrative of the order of magnitude):

```text
  fly:      score=0.03 ≈ "Tiny"    (confidence=0.99)
  mouse:    score=0.46 ≈ "Small"   (confidence=0.93)
  sole:     score=1.10 ≈ "Medium"  (confidence=0.51)
  cat:      score=1.62 ≈ "Medium"  (confidence=0.62)
  dog:      score=2.04 ≈ "Large"   (confidence=0.57)
  narwhal:  score=3.12 ≈ "Large"   (confidence=0.88)
  elephant: score=3.93 ≈ "Huge"    (confidence=0.97)
```

The same rule fixes the other types:

| Type | Wrong | Right |
| --- | --- | --- |
| `noul` | `"Is it approved?"` with the ticket only in the key | `"Is ticket 4812 approved?"` |
| `choice` | `"Which team should handle it?"` without saying which issue | `"Which team should handle the 'checkout down' issue?"` |
| `score` | `"What size is this animal?"` | `"What size is an elephant?"` |

## 4. Two valid patterns

### A. Name the item in each `instructions`

It is the simplest and the most robust: self-contained, without relying on the
order of `state`. Use it when the items are few or heterogeneous.

```json
{
  "state": "Compare the typical size of each animal.",
  "questions": {
    "cat": { "type": "score", "instructions": "What size is a cat?", "criteria": ["Tiny", "Small", "Medium", "Large", "Huge"] },
    "fly": { "type": "score", "instructions": "What size is a fly?", "criteria": ["Tiny", "Small", "Medium", "Large", "Huge"] }
  }
}
```

### B. Put the items in `state` and reference them by name

Useful with many items or with structured data. **Referencing by name is still
mandatory** in `instructions`.

```sh
jev ask \
  --state '{
    "cat": {"weight_kg": 4.5, "length_cm": 46},
    "fly": {"weight_kg": 0.00002, "length_cm": 0.7},
    "elephant": {"weight_kg": 5400, "length_cm": 650}
  }' \
  --questions '{
    "cat":      {"type":"score","instructions":"What size is the cat in the state?","criteria":["Tiny","Small","Medium","Large","Huge"]},
    "fly":      {"type":"score","instructions":"What size is the fly in the state?","criteria":["Tiny","Small","Medium","Large","Huge"]},
    "elephant": {"type":"score","instructions":"What size is the elephant in the state?","criteria":["Tiny","Small","Medium","Large","Huge"]}
  }'
```

The key is still useful for two things: **collecting** the answer
(`.answers.cat`) and **labeling** the result in the CLI report.

## 5. When to split into several requests

A request with N questions shares a single `state`, so all the items travel
together and the model must isolate its own. If the items are many or the
`state` is long, it is more reliable to issue **one request per item**
(or use `jev batch` with a template):

```sh
for animal in cat fly elephant; do
  jev ask --no-save --json \
    --state "Animal: $animal." \
    --questions "{\"size\":{\"type\":\"score\",\"instructions\":\"What size is a $animal?\",\"criteria\":[\"Tiny\",\"Small\",\"Medium\",\"Large\",\"Huge\"]}}" \
    2>/dev/null | jq -r --arg a "$animal" '[$a, .answers.size.score] | @tsv'
done
```

Advantages: each request has a minimal `state` and a single referent. Cost:
more HTTP calls (and more system tokens per request).

## 6. Checklist before sending

- [ ] Each `instructions` is understandable **without looking at the key**.
- [ ] If there are several items, each question names its own.
- [ ] If the item lives in `state`, `instructions` references it by name.
- [ ] `state` does not contain items the question does not need (noise).
- [ ] The key is descriptive because it is what you will read in `answers` and
      in the history.
