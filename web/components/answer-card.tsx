"use client";

import type { Answer, Question } from "@/lib/types";

function probability(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(1, value));
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

function Bar({ value, label, large = false }: { value: number; label: string; large?: boolean }) {
  return <div className={`bar${large ? " lg" : ""}`} role="img" aria-label={label}><span style={{ width: `${probability(value) * 100}%` }} /></div>;
}

export function AnswerCard({ name, answer, question }: { name: string; answer: Answer; question?: Question }) {
  const head = <><span className="answer-name">{name}</span><span className="answer-type">{answer.type}</span></>;
  const instructions = typeof question?.instructions === "string" ? <p className="answer-q">{question.instructions}</p> : null;

  if (answer.type === "noul") {
    const yes = probability(answer.noul);
    return <article className="answer">
      <div className="answer-head">{head}<span className="answer-big">{answer.noul === undefined ? "?" : yes.toFixed(2)}</span></div>
      {instructions}
      <Bar value={yes} large label={`Probabilidad de sí: ${yes.toFixed(2)}`} />
      <div className="prob-row"><span className="p-label">sí</span><span /><span className="p-val">{yes.toFixed(2)}</span></div>
      <div className="prob-row"><span className="p-label cell-muted">no</span><span /><span className="p-val">{(1 - yes).toFixed(2)}</span></div>
    </article>;
  }

  if (answer.type === "choice") {
    const probabilities = Object.entries(answer.probabilities ?? {}).sort(([keyA, valueA], [keyB, valueB]) => valueA === valueB ? keyA.localeCompare(keyB) : valueB - valueA);
    const criteria = question?.criteria && !Array.isArray(question.criteria) && typeof question.criteria === "object" ? question.criteria : {};
    return <article className="answer">
      <div className="answer-head">{head}<span className="answer-big" style={{ fontSize: 13 }}>{answer.choice ?? "—"}</span></div>
      {instructions}
      <div className="legend-line">confianza <strong>{answer.confidence === undefined ? "—" : answer.confidence.toFixed(2)}</strong></div>
      {probabilities.map(([key, value]) => {
        const label = Object.prototype.hasOwnProperty.call(criteria, key) ? text(criteria[key]) : key;
        return <div className={`prob-row${key === answer.choice ? " is-lead" : ""}`} key={key}><span className="p-label" title={`${key}: ${label}`}>{label}</span><Bar value={value ?? 0} label={`${key}: ${value.toFixed(2)}`} /><span className="p-val">{value.toFixed(2)}</span></div>;
      })}
    </article>;
  }

  const criteriaLevels = Array.isArray(question?.criteria) ? question.criteria : [];
  const legend = answer.legend ?? Object.fromEntries(criteriaLevels.map((level, index) => [String(index), level]));
  const levels = Object.keys(legend).sort((a, b) => Number(a) - Number(b));
  const score = answer.score;
  const nearest = score === undefined ? undefined : legend[String(Math.round(score))];
  const exact = score !== undefined && Number.isInteger(score);
  return <article className="answer">
    <div className="answer-head">{head}<span className="answer-big">{score === undefined ? "?" : score.toFixed(2)}</span></div>
    {instructions}
    <div className="legend-line">nivel <strong>{nearest === undefined ? "—" : `${exact ? "" : "≈ "}${text(nearest)}`}</strong>{answer.confidence !== undefined ? ` · confianza ${answer.confidence.toFixed(2)}` : ""}</div>
    {levels.map((key) => {
      const value = answer.probabilities?.[key];
      return <div className="prob-row" key={key}><span className="p-label" title={text(legend[key])}>{text(legend[key])}</span><Bar value={value ?? 0} label={`${text(legend[key])}: ${value?.toFixed(2) ?? "sin probabilidad"}`} /><span className="p-val">{value === undefined ? "—" : value.toFixed(2)}</span></div>;
    })}
  </article>;
}
