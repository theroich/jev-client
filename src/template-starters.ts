import type { JevRequest } from "./types.js";

/** Question types supported by the Jev API. */
export type TemplateStarterId = "noul" | "choice" | "score";

/** Ready-to-use example as a template's initial body. */
export interface TemplateStarter {
  id: TemplateStarterId;
  label: string;
  /** Card text and suggested description for the draft. */
  description: string;
  /** Answer type the question produces. */
  answerType: string;
  /** Summary of the `criteria` shape for the type. */
  criteriaShape: string;
  body: JevRequest;
}

/** Starter preselected to preserve the console's historical flow. */
export const DEFAULT_TEMPLATE_STARTER: TemplateStarterId = "noul";

/**
 * The three examples share a `state` with macros resolved by
 * `examples/context.json`, so they can be rendered as soon as they are created.
 */
const STARTER_STATE = {
  ticket: "{{order_state}}",
  customer: "{{customer.name}}",
  plan: "{{customer.plan}}",
};

/** Canonical examples of the API's three question types. */
export const TEMPLATE_STARTERS: readonly TemplateStarter[] = [
  {
    id: "noul",
    label: "Noul",
    description: "A yes/no question",
    answerType: "answer: probability",
    criteriaShape: "no criteria",
    body: {
      model: "jev-1.13",
      state: STARTER_STATE,
      questions: {
        urgent: {
          type: "noul",
          instructions: "Is it urgent?",
        },
      },
    },
  },
  {
    id: "choice",
    label: "Choice",
    description: "One option among several, with descriptions",
    answerType: "answer: criteria key",
    criteriaShape: '{ "billing": "…", "infra": "…", "sales": "…" }',
    body: {
      model: "jev-1.13",
      state: STARTER_STATE,
      questions: {
        team: {
          type: "choice",
          instructions: "Which team should handle the incident?",
          criteria: {
            billing: "Billing, invoices or payments",
            infra: "Outages, 500 errors or platform issues",
            sales: "Pricing or sales questions",
          },
        },
      },
    },
  },
  {
    id: "score",
    label: "Score",
    description: "A score within an ordered scale",
    answerType: "answer: ordered level",
    criteriaShape: '["It can wait", "This week", "Today"]',
    body: {
      model: "jev-1.13",
      state: STARTER_STATE,
      questions: {
        urgency: {
          type: "score",
          instructions: "How urgent is the incident?",
          criteria: ["It can wait", "This week", "Today"],
        },
      },
    },
  },
] as const;

/** Returns the given starter or `undefined` if the id does not exist. */
export function getTemplateStarter(
  id: TemplateStarterId,
): TemplateStarter | undefined {
  return TEMPLATE_STARTERS.find((starter) => starter.id === id);
}

/**
 * Deep copy of a starter's body. `model` can be replaced with the
 * effective model from the configuration without mutating the shared example.
 */
export function createTemplateStarterBody(
  id: TemplateStarterId,
  model?: string,
): JevRequest {
  const starter = getTemplateStarter(id);
  if (!starter) {
    throw new Error(`unknown starter: ${JSON.stringify(id)}`);
  }
  const body = JSON.parse(JSON.stringify(starter.body)) as JevRequest;
  if (model !== undefined && model.trim() !== "") {
    body.model = model;
  }
  return body;
}
