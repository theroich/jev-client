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

test("state distingue texto/JSON y bloquea JSON mal formado", () => {
  assert.deepEqual(parseStateInput(" hola ").value, " hola ");
  assert.deepEqual(parseStateInput('{"ticket":1}').value, { ticket: 1 });
  assert.deepEqual(parseStateInput("[1,2]").value, [1, 2]);
  assert.match(parseStateInput("{bad}").error ?? "", /JSON inválido/);
  assert.equal(parseStateInput("").kind, "vacío");
});

test("shellQuote y CLI de historial conservan argumentos y filtros", () => {
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

test("contextos validan array, objetos y límite", () => {
  assert.equal(validateContexts("{}").error, "Los contextos deben ser un array JSON.");
  const result = validateContexts('[{"x":1},null,[],{"x":2}]');
  assert.deepEqual(result.invalid, [1, 2]);
  assert.match(validateContexts(`[${Array.from({ length: 1001 }, () => "{}").join(",")}]`).error ?? "", /1.000/);
});

test("el esqueleto de contextos usa una clave plana por macro", () => {
  assert.equal(buildContextsSkeleton([]), "[]");
  assert.equal(
    buildContextsSkeleton([{ name: "ticket", description: "Identificador" }]),
    '[\n  {\n    "ticket": ""\n  }\n]',
  );
  assert.equal(
    buildContextsSkeleton([
      { name: "cliente.nombre", description: "" },
      { name: "cliente.plan", description: "free | pro" },
      { name: "estado_de_pedido", description: "" },
    ]),
    '[\n  {\n    "cliente.nombre": "",\n    "cliente.plan": "",\n    "estado_de_pedido": ""\n  }\n]',
  );
});

test("el esqueleto conserva rutas con punto y escapa caracteres especiales", () => {
  const macros = [
    { name: 'cliente."nombre"', description: "" },
    { name: "ruta\\anidada", description: "" },
    { name: "emoji.🛒", description: "" },
  ];
  const skeleton = buildContextsSkeleton(macros);
  assert.deepEqual(JSON.parse(skeleton), [
    {
      'cliente."nombre"': "",
      "ruta\\anidada": "",
      "emoji.🛒": "",
    },
  ]);
  assert.deepEqual(Object.keys(JSON.parse(skeleton)[0]), macros.map((macro) => macro.name));
  assert.equal(validateContexts(skeleton).contexts.length, 1);
  assert.equal(validateContexts(skeleton).error, null);
});

test("los valores de marcador cuentan también en contextos anidados", () => {
  assert.equal(countEmptyContextValues([]), 0);
  assert.equal(countEmptyContextValues([{ ticket: "TCK-1" }]), 0);
  assert.equal(countEmptyContextValues([{ ticket: "", "cliente.nombre": "" }]), 2);
  assert.equal(countEmptyContextValues([{ cliente: { nombre: "", plan: "pro" }, notas: ["", "ok"] }]), 2);
  assert.equal(countEmptyContextValues([{ ticket: "  ", nested: { list: ["", " "] } }]), 3);
});

test("preguntas conservan tipos, criteria y orden al editar", () => {
  const drafts = draftsFromQuestions({
    urgent: { type: "noul", instructions: "¿Urgente?", criteria: "sé estricto" },
    team: { type: "choice", criteria: { infra: "Infra", billing: "Facturación" } },
    score: { type: "score", criteria: ["Bajo", "Alto"] },
  });
  const questions = questionsFromDrafts(drafts);
  assert.deepEqual(Object.keys(questions), ["urgent", "team", "score"]);
  assert.equal(questions.urgent?.criteria, "sé estricto");
  assert.deepEqual(questions.team?.criteria, { infra: "Infra", billing: "Facturación" });
  assert.deepEqual(questions.score?.criteria, ["Bajo", "Alto"]);
  assert.deepEqual(questionsFromDrafts(draftsFromQuestions(questions)), questions);
});
