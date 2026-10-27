import type { Question } from "./types";

export interface QuestionDraft {
  id: number;
  name: string;
  type: "noul" | "choice" | "score";
  instructions: string;
  noulCriteria: string;
  criteria: Array<{ key: string; value: string }>;
  levels: string[];
}

export function newDraft(id: number): QuestionDraft {
  return {
    id,
    name: `question_${id}`,
    type: "noul",
    instructions: "",
    noulCriteria: "",
    criteria: [],
    levels: [],
  };
}

export function draftsFromQuestions(questions: Record<string, Question>): QuestionDraft[] {
  return Object.entries(questions).map(([name, question], index) => {
    const type = ["noul", "choice", "score"].includes(question.type)
      ? question.type as QuestionDraft["type"]
      : "noul";
    const criteria = question.criteria;
    return {
      id: index + 1,
      name,
      type,
      instructions: typeof question.instructions === "string" ? question.instructions : "",
      noulCriteria: typeof criteria === "string" ? criteria : "",
      criteria: criteria && !Array.isArray(criteria) && typeof criteria === "object"
        ? Object.entries(criteria).map(([key, value]) => ({ key, value: typeof value === "string" ? value : JSON.stringify(value) }))
        : [],
      levels: Array.isArray(criteria) ? criteria.map((level) => typeof level === "string" ? level : JSON.stringify(level)) : [],
    };
  });
}

export function questionsFromDrafts(drafts: QuestionDraft[]): Record<string, Question> {
  const questions: Record<string, Question> = {};
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!name) continue;
    const question: Question = { type: draft.type };
    if (draft.instructions) question.instructions = draft.instructions;
    if (draft.type === "noul" && draft.noulCriteria) question.criteria = draft.noulCriteria;
    if (draft.type === "choice") {
      const criteria: Record<string, unknown> = {};
      for (const row of draft.criteria) if (row.key.trim()) criteria[row.key.trim()] = row.value;
      if (Object.keys(criteria).length > 0) question.criteria = criteria;
    }
    if (draft.type === "score") {
      const levels = draft.levels.filter((level) => level.trim() !== "");
      if (levels.length > 0) question.criteria = levels;
    }
    questions[name] = question;
  }
  return questions;
}
