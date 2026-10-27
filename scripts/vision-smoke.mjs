// Vision smoke test against the real API (not run in `npm test`).
//
// Reproduces the issue evidence: sends an image with `assets` + the header
// `TypeSafe-Danger-Zone-Images` and checks that the `choice` is CAT with
// probability ~1.00 (real vision, not base64 tokenized as text).
//
// Requires network and an API key. It does not generate a sample image: it uses the one you pass.
//
//   node scripts/vision-smoke.mjs <path/to/kitten.jpg>
//
//   OPENCODE_API_KEY=sk-... node scripts/vision-smoke.mjs photo.jpg
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { JevClient } from "../dist/src/index.js";

const imagePath = process.argv[2];
if (!imagePath) {
  console.error("usage: node scripts/vision-smoke.mjs <path/to/kitten.jpg>");
  process.exit(2);
}
const apiKey = process.env.OPENCODE_API_KEY ?? process.env.JEV_API_KEY ?? "";
if (!apiKey) {
  console.error("missing OPENCODE_API_KEY (or JEV_API_KEY)");
  process.exit(2);
}

const buffer = await readFile(imagePath);
const ref = createHash("sha1").update(buffer).digest("hex").slice(0, 16);

const client = new JevClient({ apiKey });
const response = await client.run({
  model: "jev-1.13",
  state: { photo: ref },
  assets: { [ref]: { type: "image", format: "jpg", data_base64: buffer.toString("base64") } },
  questions: {
    animal: {
      type: "choice",
      instructions: "Which animal appears in `photo`?",
      criteria: { CAT: "Domestic feline", DOG: "Domestic canine", COW: "Bovine" },
    },
  },
});

const answer = response.answers.animal;
console.log(JSON.stringify({ choice: answer.choice, probabilities: answer.probabilities, input_tokens: response.usage.input_tokens }, null, 2));
if (answer.choice !== "CAT") {
  console.error(`expected CAT, got ${answer.choice}`);
  process.exit(1);
}
