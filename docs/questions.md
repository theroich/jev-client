# Question types and request contract

A Jev request has the shape `{ model, state, questions }`. The `state` is the
material being evaluated (text, object or array) and it is shared by all the
questions.

## Types

| `type` | Fields | Returns |
| --- | --- | --- |
| `noul` | `instructions` (and optional `criteria`) | `noul`: probability of "yes" (0–1) |
| `choice` | `instructions`, `criteria` (object) | `choice`, `confidence`, `probabilities` |
| `score` | `instructions`, `criteria` (ordered array) | `score`, `legend`, `probabilities` |

In `score`, the position in the array is the grade: `0` the first one, `1` the
second one… The returned `score` is the weighted average and can be a decimal;
when it falls between two levels it is shown with `≈`.

## What the model sees

The **key** of `questions` (`"urgency"`) only identifies the answer in `answers`:
**it is not sent to the model**. The model only sees `state` + `instructions` +
`criteria` of each question.

When evaluating several items in the same request, name them in each
`instructions` or reference them from `state`; if the referent lives only in the
key, all the answers tend to the same value.

Correct example:

```json
{
  "state": { "ticket_a": "…", "ticket_b": "…" },
  "questions": {
    "a_urgent": { "type": "noul", "instructions": "Is `ticket_a` urgent?" },
    "b_urgent": { "type": "noul", "instructions": "Is `ticket_b` urgent?" }
  }
}
```

## Shape of the responses

- `noul` → `answers.<key>.noul` (number between 0 and 1). There is no
  `confidence`.
- `choice` → `answers.<key>.choice`, `.confidence` and `.probabilities`.
- `score` → `answers.<key>.score`, `.legend` and `.probabilities`.

The responses keep the order of the questions in the request.

More detail and usage patterns:
[`skills/jev-cli/references/question-anatomy.md`](../skills/jev-cli/references/question-anatomy.md).

## Model notes

- `jev-1.13-free` is rate limited: it returns `429 FreeUsageLimitError` outside
  OpenCode or once the quota runs out. Use `jev-1.13` for tests.
- The server `Retry-After` is capped at 10 s so the process is not blocked.
- Jev is mainly trained in English; it accepts Spanish with slightly less
  accuracy.
- Question documentation: <https://docs.typesafe.ai/primitives>.
