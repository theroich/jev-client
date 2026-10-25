import type { JevRequest } from "./types.js";

/** Tipos de pregunta soportados por la API de Jev. */
export type TemplateStarterId = "noul" | "choice" | "score";

/** Ejemplo listo para usar como body inicial de una plantilla. */
export interface TemplateStarter {
  id: TemplateStarterId;
  label: string;
  /** Texto de la tarjeta y descripción sugerida del borrador. */
  description: string;
  /** Tipo de respuesta que produce la pregunta. */
  answerType: string;
  /** Resumen de la forma de `criteria` para el tipo. */
  criteriaShape: string;
  body: JevRequest;
}

/** Starter preseleccionado para conservar el flujo histórico de la consola. */
export const DEFAULT_TEMPLATE_STARTER: TemplateStarterId = "noul";

/**
 * Los tres ejemplos comparten `state` con macros que resuelve
 * `examples/context.json`, de modo que se pueden renderizar nada más crearlos.
 */
const STARTER_STATE = {
  ticket: "{{estado_de_pedido}}",
  cliente: "{{cliente.nombre}}",
  plan: "{{cliente.plan}}",
};

/** Ejemplos canónicos de los tres tipos de pregunta de la API. */
export const TEMPLATE_STARTERS: readonly TemplateStarter[] = [
  {
    id: "noul",
    label: "Noul",
    description: "Una pregunta de sí/no",
    answerType: "respuesta: probabilidad",
    criteriaShape: "sin criteria",
    body: {
      model: "jev-1.13",
      state: STARTER_STATE,
      questions: {
        urgent: {
          type: "noul",
          instructions: "¿Es urgente?",
        },
      },
    },
  },
  {
    id: "choice",
    label: "Choice",
    description: "Una opción entre varias, con descripciones",
    answerType: "respuesta: clave de criteria",
    criteriaShape: '{ "billing": "…", "infra": "…", "sales": "…" }',
    body: {
      model: "jev-1.13",
      state: STARTER_STATE,
      questions: {
        team: {
          type: "choice",
          instructions: "¿Qué equipo debería gestionar la incidencia?",
          criteria: {
            billing: "Cobros, facturas o pagos",
            infra: "Caídas, errores 500 o problemas de plataforma",
            sales: "Precios o dudas comerciales",
          },
        },
      },
    },
  },
  {
    id: "score",
    label: "Score",
    description: "Una nota dentro de una escala ordenada",
    answerType: "respuesta: nivel ordenado",
    criteriaShape: '["Puede esperar", "Esta semana", "Hoy mismo"]',
    body: {
      model: "jev-1.13",
      state: STARTER_STATE,
      questions: {
        urgency: {
          type: "score",
          instructions: "¿Cómo de urgente es la incidencia?",
          criteria: ["Puede esperar", "Esta semana", "Hoy mismo"],
        },
      },
    },
  },
] as const;

/** Devuelve el starter indicado o `undefined` si el id no existe. */
export function getTemplateStarter(
  id: TemplateStarterId,
): TemplateStarter | undefined {
  return TEMPLATE_STARTERS.find((starter) => starter.id === id);
}

/**
 * Copia profunda del body de un starter. El `model` se puede sustituir por el
 * modelo efectivo de la configuración sin mutar el ejemplo compartido.
 */
export function createTemplateStarterBody(
  id: TemplateStarterId,
  model?: string,
): JevRequest {
  const starter = getTemplateStarter(id);
  if (!starter) {
    throw new Error(`starter desconocido: ${JSON.stringify(id)}`);
  }
  const body = JSON.parse(JSON.stringify(starter.body)) as JevRequest;
  if (model !== undefined && model.trim() !== "") {
    body.model = model;
  }
  return body;
}
