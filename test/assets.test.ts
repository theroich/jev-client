import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertImageLimits,
  detectImageFormat,
  estimateImageTokens,
  loadImageAsset,
  newImageRef,
  orphanAssetRefs,
  readImageSize,
  redactAssets,
  validateImageAsset,
} from "../src/assets.js";
import type { ImageAsset } from "../src/types.js";

function pngBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpegBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(12);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xc0;
  buffer.writeUInt16BE(17, 4);
  buffer[6] = 8;
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

test("detectImageFormat recognizes PNG, JPEG and rejects others", () => {
  assert.equal(detectImageFormat(pngBuffer(300, 300)), "png");
  assert.equal(detectImageFormat(jpegBuffer(300, 300)), "jpg");
  assert.equal(detectImageFormat(Buffer.from("not an image")), undefined);
});

test("readImageSize reads PNG IHDR and JPEG SOF", () => {
  assert.deepEqual(readImageSize(pngBuffer(300, 400)), { width: 300, height: 400 });
  assert.deepEqual(readImageSize(jpegBuffer(550, 550)), { width: 550, height: 550 });
  assert.equal(readImageSize(Buffer.from("x")), undefined);
});

test("assertImageLimits validates sides, pixels and size", () => {
  assert.equal(assertImageLimits(pngBuffer(300, 300)).ok, true);
  assert.deepEqual(assertImageLimits(pngBuffer(300, 300)), {
    ok: true,
    width: 300,
    height: 300,
  });

  const small = assertImageLimits(pngBuffer(100, 100));
  assert.equal(small.ok, false);
  assert.match(small.reason ?? "", /minimum per side/);

  const tooWide = assertImageLimits(jpegBuffer(2000, 300));
  assert.equal(tooWide.ok, false);
  assert.match(tooWide.reason ?? "", /maximum per side/);
});

test("loadImageAsset detects format from magic bytes and validates limits", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-assets-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const png = join(dir, "photo.png");
  await writeFile(png, pngBuffer(300, 300));
  const loaded = await loadImageAsset(png, "ref-1");
  assert.equal(loaded.ref, "ref-1");
  assert.equal(loaded.asset.format, "png");
  assert.equal(loaded.asset.type, "image");
  assert.ok(loaded.asset.data_base64);
  assert.deepEqual(loaded.size, { width: 300, height: 300 });

  const auto = await loadImageAsset(png);
  assert.ok(auto.ref.length > 0);
  assert.equal(auto.asset.format, "png");

  const small = join(dir, "small.png");
  await writeFile(small, pngBuffer(50, 50));
  await assert.rejects(loadImageAsset(small), /minimum per side/);
});

test("validateImageAsset rejects the data: prefix, line breaks and an invalid format", () => {
  assert.throws(
    () => validateImageAsset("a", { data_base64: "data:abc", format: "jpg" }),
    /invalid data_base64/,
  );
  assert.throws(
    () => validateImageAsset("a", { data_base64: "YWJj\nZGVm", format: "jpg" }),
    /invalid data_base64/,
  );
  assert.throws(
    () => validateImageAsset("a", { data_base64: "YWJj" }),
    /needs a png\|jpg\|jpeg format/,
  );
  assert.throws(
    () => validateImageAsset("a", { data_base64: "YWJj", format: "gif" as "png" }),
    /needs a png\|jpg\|jpeg format/,
  );
  assert.deepEqual(validateImageAsset("a", { data_base64: "YWJj", format: "jpg" }), {
    type: "image",
    data_base64: "YWJj",
    format: "jpg",
  });
});

test("orphanAssetRefs detects references the API would reject", () => {
  const request = {
    state: { photo: "uuid-1" },
    questions: { q: { type: "noul", instructions: "What do you see in `uuid-1`?" } },
    assets: { "uuid-1": { data_base64: "YWJj", format: "jpg" } as ImageAsset },
  };
  assert.deepEqual(orphanAssetRefs(request), []);

  const orphan = {
    ...request,
    assets: {
      "uuid-1": { data_base64: "YWJj", format: "jpg" } as ImageAsset,
      "uuid-2": { data_base64: "YWJj", format: "jpg" } as ImageAsset,
    },
  };
  assert.deepEqual(orphanAssetRefs(orphan), ["uuid-2"]);
});

test("redactAssets never exposes data_base64", () => {
  const assets: Record<string, ImageAsset> = {
    photo: { type: "image", format: "jpg", data_base64: Buffer.from("hello").toString("base64") },
  };
  const redacted = redactAssets(assets);
  assert.ok(redacted);
  assert.equal(redacted?.photo?.format, "jpg");
  assert.equal(redacted?.photo?.bytes, 5);
  assert.equal(redacted?.photo?.sha256, createHash("sha256").update("hello").digest("hex"));
  assert.equal("data_base64" in (redacted?.photo ?? {}), false);
  assert.equal(redactAssets(undefined), undefined);
  assert.equal(redactAssets({}), undefined);
});

test("newImageRef returns a UUID and estimateImageTokens is informative", () => {
  const ref = newImageRef();
  assert.match(ref, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(estimateImageTokens(0), undefined);
  assert.ok((estimateImageTokens(19000) ?? 0) > 0);
});
