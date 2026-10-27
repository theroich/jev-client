import test from "node:test";
import assert from "node:assert/strict";

import { assertSupportedNode } from "../src/runtime.js";

test("the runtime guard accepts supported Node versions", () => {
  for (const version of ["22.13.0", "22.14.0", "24.0.0", "26.7.0", "v22.13.0"]) {
    assert.equal(assertSupportedNode(version), null, version);
  }
});

test("the runtime guard rejects unsupported Node versions", () => {
  for (const version of ["20.19.0", "18.0.0", "22.0.0", "22.12.0", "v22.12.0"]) {
    const message = assertSupportedNode(version);
    assert.ok(message !== null, version);
    assert.match(message, /Node\.js >= 22\.13/, version);
    assert.ok(message.includes(version), version);
  }
});

test("the runtime guard rejects malformed versions", () => {
  const message = assertSupportedNode("not-a-version");
  assert.ok(message !== null);
  assert.match(message, /Node\.js >= 22\.13/);
});
