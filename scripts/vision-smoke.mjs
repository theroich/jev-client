// Smoke de visión con la API real (no se ejecuta en `npm test`).
//
// Reproduce la evidencia de la issue: envía una imagen con `assets` + el header
// `TypeSafe-Danger-Zone-Images` y comprueba que el `choice` es GATO con
// probabilidad ~1.00 (visión real, no base64 tokenizado como texto).
//
// Requiere red y API key. No genera una imagen de ejemplo: usa la que le pases.
//
//   node scripts/vision-smoke.mjs <ruta/a/gatito.jpg>
//
//   OPENCODE_API_KEY=sk-... node scripts/vision-smoke.mjs foto.jpg
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { JevClient } from "../dist/src/index.js";

const imagePath = process.argv[2];
if (!imagePath) {
  console.error("uso: node scripts/vision-smoke.mjs <ruta/a/gatito.jpg>");
  process.exit(2);
}
const apiKey = process.env.OPENCODE_API_KEY ?? process.env.JEV_API_KEY ?? "";
if (!apiKey) {
  console.error("falta OPENCODE_API_KEY (o JEV_API_KEY)");
  process.exit(2);
}

const buffer = await readFile(imagePath);
const ref = createHash("sha1").update(buffer).digest("hex").slice(0, 16);

const client = new JevClient({ apiKey });
const response = await client.run({
  model: "jev-1.13",
  state: { foto: ref },
  assets: { [ref]: { type: "image", format: "jpg", data_base64: buffer.toString("base64") } },
  questions: {
    animal: {
      type: "choice",
      instructions: "¿Qué animal aparece en `foto`?",
      criteria: { GATO: "Felino doméstico", PERRO: "Canino doméstico", VACA: "Bovino" },
    },
  },
});

const answer = response.answers.animal;
console.log(JSON.stringify({ choice: answer.choice, probabilities: answer.probabilities, input_tokens: response.usage.input_tokens }, null, 2));
if (answer.choice !== "GATO") {
  console.error(`esperaba GATO, recibió ${answer.choice}`);
  process.exit(1);
}
