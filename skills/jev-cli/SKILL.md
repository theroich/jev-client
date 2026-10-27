---
name: jev-cli
description: >
  Documentation for the `jev` CLI (jev-client) organized by use case.
  Enable this skill when you want to solve a concrete task with `jev` from the
  console: classify a ticket with `choice`, rate urgency with `score`, decide
  yes/no with `noul`, invoke `jev` non-interactively from a bash script (parsing
  the result with `jq` and handling exit codes), or create and reuse templates
  with macros. Use it also when you need to know which command to run for
  "I want X".
---

# `jev` CLI skill by use case

`jev` (the **jev-client** binary) consumes the Jev API (TypeSafe's System One)
via OpenCode. It does not generate text: it takes a `state` and one or more
typed questions and returns **one answer per question with probabilities**.

This skill documents **how to invoke the CLI from the console and from
scripts**, by type of operation. It is an index and a scripting contract: the
details of each operation live in `references/*.md`. It does not duplicate the
[`README.md`](../../README.md); it summarizes and links to it.

## Requirements and quick start

- Node.js 22.13+ (22 LTS, 24 LTS or 26 LTS).
- An API key from [OpenCode Console](https://opencode.ai/console).

```sh
cd jev-client
npm install
npm run build
export JEV_API_KEY="sk-..."

npm link        # optional: makes `jev` available on the PATH
jev demo        # built-in end-to-end example
```

Without linking:

```sh
node dist/src/bin.js demo
npm start -- demo
npm run dev -- demo   # builds and runs
```

## Minimal configuration

Precedence: **flag > environment variable > SQLite database > default value**.
Empty strings count as undefined.

| What | Flag | Variable | SQLite key | Default |
| --- | --- | --- | --- | --- |
| API key | `--key` | `JEV_API_KEY` | `api_key` | — (required) |
| Endpoint | `--url` | `JEV_URL` | `api_url` | `https://opencode.ai/inference/systemone/v1/systemone` |
| Model | `--model` | `JEV_MODEL` | `model` | `jev-1.13` |
| Timeout (s) | `--timeout` | — | `timeout` | `30` |
| Retries | `--retries` | — | `retries` | `2` |
| SQLite database | `--db` | `JEV_DB` | — | `~/.jev-client/db/jev.db` |

`--url` expects the **full endpoint**. The API key stored with
`jev config set api_key` stays in plain text in SQLite; to avoid persisting it,
use `--key` or the `JEV_API_KEY` environment variable.

## Summary table of the three question types

| `type` | Required fields | Shape of `criteria` | What it returns |
| --- | --- | --- | --- |
| `noul` | `instructions` | optional (string) | `noul`: probability of "yes" (0–1) |
| `choice` | `instructions`, `criteria` | **object** `{ key: description }` | `choice`, `confidence`, `probabilities` |
| `score` | `instructions`, `criteria` | **ordered array** `[level0, level1, …]` | `score`, `legend`, `probabilities` |

In `score`, the position in the array is the score: `0` for the first level,
`1` for the second… The `score` is a weighted mean and can be a decimal; when
it falls between two levels it is shown with `≈`.

## Question anatomy: what the model sees

A request is `{ model, state, questions: { key: question } }` and each question
is `{ type, instructions, criteria }`. Three rules follow, valid for `noul`,
`choice` and `score`:

1. **`state` is single and shared** by all the questions in the request.
2. **The `questions` key is not sent to the model**: `"cat"` in
   `{"cat": {…}}` only identifies the answer in `answers`; it is not context.
3. The model only sees, per question, **`state` + `instructions` + `criteria`**.

That is why, when evaluating several items in a single request (several
animals, several tickets, several URLs…), you must **name the item inside each
`instructions`** — or put it in `state` and reference it by name. If the
referent lives only in the key, every question sees the same text and the
answers collapse to the same value.

| | `instructions` | Result |
| --- | --- | --- |
| Wrong | `"What size is this animal?"` (the animal, only in the key) | all 7 questions ≈ 1.75 ("Medium") |
| Right | `"What size is a cat?"`, `"…a fly?"`, … | fly 0.03 ("Tiny") … elephant 3.93 ("Huge") |

Details and the full case in
[`references/question-anatomy.md`](references/question-anatomy.md).

## Decision table

| I want to… | Command | Reference |
| --- | --- | --- |
| Decide yes/no (is it billing?, is it urgent?) | `jev ask --noul 'q=Is it…?'` | [`references/noul.md`](references/noul.md) |
| Classify among fixed options (team, tone, category) | `jev ask --choice 'q=Which…?' --option 'q.a=…'` | [`references/choice.md`](references/choice.md) |
| Rate on an ordered scale (urgency, frustration) | `jev ask --score 'q=How…?' --level 'q=…'` | [`references/score.md`](references/score.md) |
| Run any of the above from a bash script | `jev ask … --json` + `jq` | the file for the operation |
| Save a request with placeholders and reuse it | `jev template create` | [`references/templates.md`](references/templates.md) |
| Run a template for many contexts | `jev batch <template> --contexts …` | [`references/templates.md`](references/templates.md) |
| Preview a request without spending tokens | `jev template render` | [`references/templates.md`](references/templates.md) |
| Evaluate an image (experimental) | `jev ask --asset <ref>=photo.jpg …` | [`references/templates.md`](references/templates.md) |

## Typed flags for `jev ask`

For the common case you do not need to write JSON inline. These flags translate
console input into the request the client already understands:

| Flag | Shape | Produces (`questions.<key>`) |
| --- | --- | --- |
| `--noul` | `--noul <key>=<instruction>` | `{ type: "noul", instructions }` |
| `--choice` | `--choice <key>=<instruction>` | `{ type: "choice", instructions, criteria: {…} }` |
| `--score` | `--score <key>=<instruction>` | `{ type: "score", instructions, criteria: […] }` |
| `--option` | `--option <question>.<option>=<description>` | adds `{ option: description }` to the `--choice` `criteria` |
| `--level` | `--level <question>=<level>` | adds `level` (in order) to the `--score` `criteria` |

All of them are repeatable. `--option` is for the options of a `--choice` and
`--level` for the (ordered) scale of a `--score`; the position where `--level`
appears is the score. They do not combine with `--questions`,
`--questions-file`, `--request` or `--request-file` (those remain the
JSON/file route).

## Images (experimental)

`jev ask` accepts images with `--asset [<ref>=]<path>` (repeatable) or
`--assets-file <path>` (JSON map). The reference is written in `state` where
text would go; the client adds the `TypeSafe-Danger-Zone-Images: true` header
automatically (`--no-images-header` omits it to debug the `400`).

```sh
jev ask --state '{"photo":"<ref>"}' --asset <ref>=photo.jpg \
    --choice 'animal=What animal appears in `photo`?' \
    --option 'animal.CAT=Feline' --option 'animal.DOG=Canine'
```

- Static PNG/JPEG only, 280–1568 px per side, ≤16 MiB per file.
- `data:` in `state` does **not** work: use `assets` + reference.
- `box` (localize objects) is not available through the OpenCode proxy.

Images are experimental: format and limits may change.

## Scripting contract

This is what you need to invoke `jev` non-interactively:

- **Exit codes**: `0` success; `1` API/network/configuration error
  (missing key, invalid JSON…); `2` incorrect usage (invalid command or flag).
- **`--json`** prints the raw API response to **stdout**. In `ask`/`demo` the
  token summary (`tokens: … in / … out, cost=…`) goes to **stderr**, so `--json`
  can be redirected to a file without polluting it.
- **`--no-save`** does not record the run in the SQLite history.
- **`--db <path>`** (or `JEV_DB`) isolates runs in a dedicated database — handy
  in scripts and tests — and avoids touching the user's database.

```sh
jev ask --state "…" --noul 'q=Is it…?' --json 2>/dev/null | jq '.answers.q.noul'
```

## Pointers

- [`references/noul.md`](references/noul.md) — `noul` operation: use cases, CLI and bash.
- [`references/choice.md`](references/choice.md) — `choice` operation: use cases, CLI and bash.
- [`references/score.md`](references/score.md) — `score` operation: use cases, CLI and bash.
- [`references/templates.md`](references/templates.md) — template manual with real cases.
- [`references/question-anatomy.md`](references/question-anatomy.md) — what the
  model sees in each question and how to evaluate several items in one request.

Out of scope for this skill (see [`README.md`](../../README.md) for usage):
the TUI (`jev tui`), the web console (`jev web-console`) and the MCP server
(`jev mcp`). For TypeScript library usage, see
[`docs/library.md`](../../docs/library.md).
