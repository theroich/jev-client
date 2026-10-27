import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContextsSkeleton,
  buildHistoryCommand,
  countEmptyContextValues,
  filtersFromSearchParams,
  filtersToSearchParams,
  parseStateInput,
  shellQuote,
  validateContexts,
} from "../lib/utils";
import { draftsFromQuestions, questionsFromDrafts } from "../lib/questions";

test("state distinguishes text/JSON and blocks malformed JSON", () => {
  assert.deepEqual(parseStateInput(" hello ").value, " hello ");
  assert.deepEqual(parseStateInput('{"ticket":1}').value, { ticket: 1 });
  assert.deepEqual(parseStateInput("[1,2]").value, [1, 2]);
  assert.match(parseStateInput("{bad}").error ?? "", /Invalid JSON/);
  assert.equal(parseStateInput("").kind, "empty");
});

test("shellQuote and history CLI keep arguments and filters", () => {
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
  const filters = filtersFromSearchParams(new URLSearchParams("status=429&model=jev-x&batch=b-1&limit=500"));
  assert.equal(filters.limit, 200);
  const command = buildHistoryCommand(filters);
  assert.match(command, /--status '429'/);
  assert.match(command, /--model 'jev-x'/);
  assert.match(command, /--batch 'b-1'/);
  assert.match(command, /--limit 200/);
  const api = filtersToSearchParams({ ...filters, since: "2026-10-25" }, true);
  assert.ok(api.get("since")?.endsWith("Z"));
});

test("contexts validate array, objects and limit", () => {
  assert.equal(validateContexts("{}").error, "Contexts must be a JSON array.");
  const result = validateContexts('[{"x":1},null,[],{"x":2}]');
  assert.deepEqual(result.invalid, [1, 2]);
  assert.match(validateContexts(`[${Array.from({ length: 1001 }, () => "{}").join(",")}]`).error ?? "", /1,000/);
});

test("the context skeleton uses one flat key per macro", () => {
  assert.equal(buildContextsSkeleton([]), "[]");
  assert.equal(
    buildContextsSkeleton([{ name: "ticket", description: "Identifier" }]),
    '[\n  {\n    "ticket": ""\n  }\n]',
  );
  assert.equal(
    buildContextsSkeleton([
      { name: "customer.name", description: "" },
      { name: "customer.plan", description: "free | pro" },
      { name: "order_state", description: "" },
    ]),
    '[\n  {\n    "customer.name": "",\n    "customer.plan": "",\n    "order_state": ""\n  }\n]',
  );
});

test("the skeleton keeps dotted paths and escapes special characters", () => {
  const macros = [
    { name: 'customer."name"', description: "" },
    { name: "nested\\path", description: "" },
    { name: "emoji.🛒", description: "" },
  ];
  const skeleton = buildContextsSkeleton(macros);
  assert.deepEqual(JSON.parse(skeleton), [
    {
      'customer."name"': "",
      "nested\\path": "",
      "emoji.🛒": "",
    },
  ]);
  assert.deepEqual(Object.keys(JSON.parse(skeleton)[0]), macros.map((macro) => macro.name));
  assert.equal(validateContexts(skeleton).contexts.length, 1);
  assert.equal(validateContexts(skeleton).error, null);
});

test("placeholder values are also counted in nested contexts", () => {
  assert.equal(countEmptyContextValues([]), 0);
  assert.equal(countEmptyContextValues([{ ticket: "TCK-1" }]), 0);
  assert.equal(countEmptyContextValues([{ ticket: "", "customer.name": "" }]), 2);
  assert.equal(countEmptyContextValues([{ customer: { name: "", plan: "pro" }, notes: ["", "ok"] }]), 2);
  assert.equal(countEmptyContextValues([{ ticket: "  ", nested: { list: ["", " "] } }]), 3);
});

test("questions keep types, criteria and order while editing", () => {
  const drafts = draftsFromQuestions({
    urgent: { type: "noul", instructions: "Urgent?", criteria: "be strict" },
    team: { type: "choice", criteria: { infra: "Infra", billing: "Billing" } },
    score: { type: "score", criteria: ["Low", "High"] },
  });
  const questions = questionsFromDrafts(drafts);
  assert.deepEqual(Object.keys(questions), ["urgent", "team", "score"]);
  assert.equal(questions.urgent?.criteria, "be strict");
  assert.deepEqual(questions.team?.criteria, { infra: "Infra", billing: "Billing" });
  assert.deepEqual(questions.score?.criteria, ["Low", "High"]);
  assert.deepEqual(questionsFromDrafts(draftsFromQuestions(questions)), questions);
});
