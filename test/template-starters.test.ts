import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createTemplateStarterBody,
  DEFAULT_TEMPLATE_STARTER,
  getTemplateStarter,
  TEMPLATE_STARTERS,
} from "../src/template-starters.js";
import {
  detectMacros,
  resolveTemplateBody,
  validateTemplateBody,
} from "../src/template.js";
import type { JevRequest } from "../src/types.js";

const context = JSON.parse(
  await readFile(fileURLToPath(new URL("../../examples/context.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

test("hay un starter por cada tipo y noul es el preseleccionado", () => {
  assert.deepEqual(
    TEMPLATE_STARTERS.map((starter) => starter.id),
    ["noul", "choice", "score"],
  );
  assert.equal(DEFAULT_TEMPLATE_STARTER, "noul");
  for (const starter of TEMPLATE_STARTERS) {
    assert.equal(getTemplateStarter(starter.id), starter);
    assert.ok(starter.label.length > 0);
    assert.ok(starter.description.length > 0);
    assert.ok(starter.answerType.length > 0);
    assert.ok(starter.criteriaShape.length > 0);
  }
});

test("cada starter usa el tipo de pregunta correcto y la forma de criteria esperada", () => {
  const bodyFor = (id: "noul" | "choice" | "score"): JevRequest => {
    const starter = getTemplateStarter(id);
    assert.ok(starter);
    return starter.body;
  };

  const noul = bodyFor("noul").questions.urgent;
  assert.ok(noul);
  assert.equal(noul.type, "noul");
  assert.equal(noul.criteria, undefined);

  const choice = bodyFor("choice").questions.team;
  assert.ok(choice);
  assert.equal(choice.type, "choice");
  assert.ok(choice.criteria && !Array.isArray(choice.criteria));
  assert.deepEqual(Object.keys(choice.criteria), ["billing", "infra", "sales"]);

  const score = bodyFor("score").questions.urgency;
  assert.ok(score);
  assert.equal(score.type, "score");
  assert.ok(Array.isArray(score.criteria));
  assert.deepEqual(score.criteria, ["Puede esperar", "Esta semana", "Hoy mismo"]);
});

test("los tres starters validan sin ediciones y renderizan con examples/context.json", () => {
  for (const starter of TEMPLATE_STARTERS) {
    const bodyJson = JSON.stringify(starter.body, null, 2);
    assert.doesNotThrow(() => validateTemplateBody(bodyJson), starter.id);

    const request = resolveTemplateBody(bodyJson, context);
    assert.equal(request.model, "jev-1.13");
    assert.deepEqual(request.state, {
      ticket: context.estado_de_pedido,
      cliente: (context.cliente as Record<string, unknown>).nombre,
      plan: (context.cliente as Record<string, unknown>).plan,
    });
    assert.ok(Object.keys(request.questions).length > 0);

    for (const macro of detectMacros(bodyJson)) {
      assert.ok(Object.hasOwn(context, macro.split(".")[0] as string), `${starter.id}: ${macro}`);
    }
  }
});

test("createTemplateStarterBody clona el starter y permite cambiar el modelo", () => {
  const original = getTemplateStarter("choice");
  assert.ok(original);

  const copy = createTemplateStarterBody("choice", "modelo-efectivo");
  assert.equal(copy.model, "modelo-efectivo");
  assert.equal(original.body.model, "jev-1.13");

  copy.state = "otro";
  copy.questions.team = { type: "noul" };
  assert.deepEqual(original.body.state, {
    ticket: "{{estado_de_pedido}}",
    cliente: "{{cliente.nombre}}",
    plan: "{{cliente.plan}}",
  });
  assert.equal(original.body.questions.team?.type, "choice");

  assert.equal(createTemplateStarterBody("score").model, "jev-1.13");
  assert.equal(createTemplateStarterBody("noul", "  ").model, "jev-1.13");
  assert.throws(() => createTemplateStarterBody("otro" as never), /starter desconocido/);
});
