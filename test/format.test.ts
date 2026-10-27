import test from "node:test";
import assert from "node:assert/strict";

import {
  answerSummary,
  formatCost,
  formatProbabilities,
  formatReport,
  legendLevel,
} from "../src/format.js";
import type { JevResponse } from "../src/types.js";

test("summarizes each answer type", () => {
  assert.equal(answerSummary({ type: "noul", noul: 0.99 }), "noul=0.99");
  assert.equal(
    answerSummary({ type: "choice", choice: "infra", confidence: 0.64 }),
    "choice=infra (confidence=0.64)",
  );
  assert.equal(
    answerSummary({ type: "score", score: 1.99, confidence: 0.98, legend: { "2": "Very upset" } }),
    'score=1.99 ≈ "Very upset" (confidence=0.98)',
  );
  assert.equal(
    answerSummary({ type: "score", score: 2, legend: { "2": "Very upset" } }),
    'score=2 "Very upset"',
  );
});

test("sorts the probabilities from highest to lowest", () => {
  assert.equal(
    formatProbabilities({ infra: 0.76, billing: 0.24, sales: 0 }),
    "infra=0.76, billing=0.24, sales=0",
  );
  assert.equal(
    formatProbabilities({ b: 0.5, a: 0.5 }),
    "a=0.5, b=0.5",
  );
});

test("the report is stable and sorted", () => {
  const response: JevResponse = {
    model: "jev-1.13",
    answers: {
      is_urgent: { type: "noul", noul: 0.99 },
      team: {
        type: "choice",
        choice: "infra",
        confidence: 0.64,
        probabilities: { infra: 0.76, billing: 0.24, sales: 0 },
      },
      frustration: {
        type: "score",
        score: 1.99,
        confidence: 0.98,
        legend: { "0": "Calm", "1": "Annoyed but polite", "2": "Very upset" },
      },
    },
    usage: { input_tokens: 449, output_tokens: 72, cost: 1.886e-5 },
    raw: {},
  };

  const expected = `model: jev-1.13
  frustration: score=1.99 ≈ "Very upset" (confidence=0.98)
  is_urgent: noul=0.99
  team: choice=infra (confidence=0.64)
    infra=0.76, billing=0.24, sales=0
`;

  assert.equal(formatReport(response), expected);
});

test("legendLevel marks intermediate values", () => {
  assert.deepEqual(legendLevel({ "1": "Medium" }, 1), { label: "Medium", exact: true });
  assert.deepEqual(legendLevel({ "1": "Medium" }, 1.4), { label: "Medium", exact: false });
  assert.equal(legendLevel(undefined, 1), undefined);
  assert.equal(legendLevel({}, 1), undefined);
});

test("formatCost uses scientific notation only for small amounts", () => {
  assert.equal(formatCost(1.886e-5), "1.886e-5");
  assert.equal(formatCost(0.25), "0.25");
  assert.equal(formatCost(0), "0");
});
