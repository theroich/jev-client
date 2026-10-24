import type { Answer, JevResponse } from "./types.js";

/** Resume una respuesta en una línea. */
export function answerSummary(answer: Answer): string {
  switch (answer.type) {
    case "noul":
      return answer.noul === undefined
        ? "noul=?"
        : `noul=${formatNumber(answer.noul)}`;

    case "choice": {
      let text = `choice=${answer.choice ?? ""}`;
      if (answer.confidence !== undefined) {
        text += ` (confidence=${formatNumber(answer.confidence)})`;
      }
      return text;
    }

    case "score": {
      if (answer.score === undefined) {
        return "score=?";
      }
      let text = `score=${formatNumber(answer.score)}`;
      const level = legendLevel(answer.legend, answer.score);
      if (level) {
        text += level.exact
          ? ` ${quote(level.label)}`
          : ` ≈ ${quote(level.label)}`;
      }
      if (answer.confidence !== undefined) {
        text += ` (confidence=${formatNumber(answer.confidence)})`;
      }
      return text;
    }

    default:
      return answer.type;
  }
}

/**
 * Informe legible. Los nombres de respuesta se ordenan para que la salida sea
 * estable entre ejecuciones.
 */
export function formatReport(response: JevResponse): string {
  const lines = [`modelo: ${response.model}`];

  for (const name of Object.keys(response.answers).sort()) {
    const answer = response.answers[name];
    if (!answer) {
      continue;
    }
    lines.push(`  ${name}: ${answerSummary(answer)}`);
    if (
      answer.probabilities &&
      Object.keys(answer.probabilities).length > 0
    ) {
      lines.push(`    ${formatProbabilities(answer.probabilities)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Probabilidades ordenadas de mayor a menor. */
export function formatProbabilities(
  probabilities: Record<string, number>,
): string {
  return Object.entries(probabilities)
    .sort(([nameA, valueA], [nameB, valueB]) =>
      valueA === valueB ? nameA.localeCompare(nameB) : valueB - valueA,
    )
    .map(([name, value]) => `${name}=${formatNumber(value)}`)
    .join(", ");
}

interface LegendLevel {
  label: string;
  exact: boolean;
}

/**
 * Devuelve el nivel de la rúbrica más cercano. `exact` es false cuando el score
 * cae entre dos niveles, para poder marcarlo como aproximado.
 */
export function legendLevel(
  legend: Record<string, unknown> | undefined,
  score: number,
): LegendLevel | undefined {
  if (!legend || !Number.isFinite(score)) {
    return undefined;
  }
  const rounded = Math.round(score);
  const value = legend[String(rounded)];
  if (value === undefined) {
    return undefined;
  }
  return {
    label: describeLevel(value),
    exact: Math.abs(score - rounded) < 1e-9,
  };
}

function describeLevel(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const json = JSON.stringify(value);
  return json ?? String(value);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export function formatNumber(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}

/** Coste con notación científica solo cuando es muy pequeño. */
export function formatCost(value: number): string {
  if (value !== 0 && Math.abs(value) < 1e-4) {
    return value.toExponential(3);
  }
  return String(value);
}
