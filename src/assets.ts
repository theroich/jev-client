import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ImageAsset, ImageFormat, JevRequest } from "./types.js";

/** Limits imposed by the System One images API. */
export const IMAGE_LIMITS = {
  /** Maximum size per file, in bytes. */
  maxFileBytes: 16 * 1024 * 1024,
  /** Minimum and maximum side, in pixels. */
  minSide: 280,
  maxSide: 1568,
  /** Minimum and maximum total pixels. */
  minPixels: 78_400,
  maxPixels: 2_458_624,
} as const;

/** Formats accepted by the API (APNG is rejected). */
export const IMAGE_FORMATS: readonly ImageFormat[] = ["png", "jpg", "jpeg"];

/** Required header when a request carries `assets`. */
export const IMAGES_HEADER = "TypeSafe-Danger-Zone-Images";

export interface ImageAssetError extends Error {
  code:
    | "unsupported_image_format"
    | "image_size_parsing_failed"
    | "image_too_small"
    | "image_too_large"
    | "image_pixels_out_of_range"
    | "image_file_too_large"
    | "image_unreadable";
}

function assetError(code: ImageAssetError["code"], message: string): ImageAssetError {
  const error = new Error(message) as ImageAssetError;
  error.name = "ImageAssetError";
  error.code = code;
  return error;
}

/** Format detected from the magic bytes (not the extension). */
export function detectImageFormat(buffer: Buffer): ImageFormat | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg";
  }
  return undefined;
}

/** Converts `jpg`/`jpeg`/`png` to the API's canonical `format` key. */
export function canonicalFormat(format: ImageFormat): "png" | "jpg" {
  return format === "png" ? "png" : "jpg";
}

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * Reads the dimensions of a PNG (IHDR) or JPEG (SOF marker) without decoding
 * the image. Returns `undefined` when the format is not PNG/JPEG or the
 * container is unreadable.
 */
export function readImageSize(buffer: Buffer): ImageSize | undefined {
  const format = detectImageFormat(buffer);
  if (format === "png") {
    if (buffer.length < 24) {
      return undefined;
    }
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  if (format === "jpg") {
    return readJpegSize(buffer);
  }
  return undefined;
}

function readJpegSize(buffer: Buffer): ImageSize | undefined {
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1] as number;
    // SOF markers that carry dimensions (excludes DHT C4, JPG C8 and DAC CC).
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (offset + 9 > buffer.length) {
        return undefined;
      }
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) {
      return undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

export interface ImageLimitsReport {
  ok: boolean;
  width?: number;
  height?: number;
  reason?: string;
}

/** Validates the API limits and returns the rejection reason, if any. */
export function assertImageLimits(buffer: Buffer): ImageLimitsReport {
  if (buffer.length > IMAGE_LIMITS.maxFileBytes) {
    return {
      ok: false,
      reason: `the file exceeds ${IMAGE_LIMITS.maxFileBytes / (1024 * 1024)} MiB`,
    };
  }
  const size = readImageSize(buffer);
  if (size === undefined) {
    return { ok: false, reason: "could not read the image dimensions" };
  }
  const pixels = size.width * size.height;
  if (
    size.width < IMAGE_LIMITS.minSide ||
    size.height < IMAGE_LIMITS.minSide
  ) {
    return {
      ok: false,
      width: size.width,
      height: size.height,
      reason: `the image is ${size.width}×${size.height}; the minimum per side is ${IMAGE_LIMITS.minSide} px`,
    };
  }
  if (
    size.width > IMAGE_LIMITS.maxSide ||
    size.height > IMAGE_LIMITS.maxSide
  ) {
    return {
      ok: false,
      width: size.width,
      height: size.height,
      reason: `the image is ${size.width}×${size.height}; the maximum per side is ${IMAGE_LIMITS.maxSide} px`,
    };
  }
  if (pixels < IMAGE_LIMITS.minPixels || pixels > IMAGE_LIMITS.maxPixels) {
    return {
      ok: false,
      width: size.width,
      height: size.height,
      reason: `the image totals ${pixels} px; it must be between ${IMAGE_LIMITS.minPixels} and ${IMAGE_LIMITS.maxPixels}`,
    };
  }
  return { ok: true, width: size.width, height: size.height };
}

/** UUID v4 recommended by the API so the reference does not collide with text. */
export function newImageRef(): string {
  return randomUUID();
}

/** Reads a file, detects its format from the magic bytes and validates its limits. */
export async function loadImageAsset(
  path: string,
  ref?: string,
): Promise<{ ref: string; asset: ImageAsset; size: ImageSize }> {
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (error) {
    throw assetError(
      "image_unreadable",
      `could not read image ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const format = detectImageFormat(buffer);
  if (format === undefined) {
    throw assetError(
      "unsupported_image_format",
      `unsupported image format in ${path} (only PNG or JPEG)`,
    );
  }

  const report = assertImageLimits(buffer);
  if (!report.ok) {
    throw assetError("image_too_large", `${path}: ${report.reason ?? "image limits violated"}`);
  }
  if (report.width === undefined || report.height === undefined) {
    throw assetError("image_size_parsing_failed", `${path}: could not read the dimensions`);
  }

  return {
    ref: ref ?? newImageRef(),
    asset: {
      type: "image",
      format: canonicalFormat(format),
      data_base64: buffer.toString("base64"),
    },
    size: { width: report.width, height: report.height },
  };
}

/**
 * Converts a `data_base64` into a validated asset. Checks that it has no
 * `data:` prefix and no line-break/space characters, and that the format
 * is `png|jpg|jpeg`.
 */
export function validateImageAsset(ref: string, asset: ImageAsset): ImageAsset {
  if (asset.data_base64 !== undefined) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(asset.data_base64)) {
      throw new Error(
        `asset ${JSON.stringify(ref)} has an invalid data_base64: ` +
          "remove the 'data:' prefix and the line breaks/spaces",
      );
    }
    if (asset.format === undefined || !IMAGE_FORMATS.includes(asset.format)) {
      throw new Error(
        `asset ${JSON.stringify(ref)} needs a png|jpg|jpeg format alongside data_base64`,
      );
    }
  }
  return { type: "image", ...asset };
}

/** Validates a full assets map before spending a call. */
export function validateAssets(assets: Record<string, ImageAsset>): void {
  for (const [ref, asset] of Object.entries(assets)) {
    validateImageAsset(ref, asset);
  }
}

/** `assets` references that do not appear in `state`/`instructions`/`criteria`. */
export function orphanAssetRefs(
  request: Pick<JevRequest, "state" | "questions" | "assets">,
): string[] {
  const assets = request.assets;
  if (assets === undefined) {
    return [];
  }
  const haystack = `${JSON.stringify(request.state ?? "")}${JSON.stringify(request.questions ?? "")}`;
  return Object.keys(assets).filter((ref) => !haystack.includes(ref));
}

export interface RedactedAsset {
  format?: ImageFormat;
  bytes: number;
  sha256: string;
}

/** Asset metadata for the history; never includes `data_base64`. */
export function redactAssets(
  assets: Record<string, ImageAsset> | undefined,
): Record<string, RedactedAsset> | undefined {
  if (assets === undefined || Object.keys(assets).length === 0) {
    return undefined;
  }
  const redacted: Record<string, RedactedAsset> = {};
  for (const [ref, asset] of Object.entries(assets)) {
    const data = asset.data_base64 ?? "";
    const buffer = Buffer.from(data, "base64");
    redacted[ref] = {
      format: asset.format,
      bytes: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
    };
  }
  return redacted;
}

/** Replaces `data_base64` with metadata in a body before persisting it. */
export function redactRequestAssets(requestBody: unknown): unknown {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
    return requestBody;
  }
  const record = requestBody as Record<string, unknown>;
  if (!record.assets || typeof record.assets !== "object" || Array.isArray(record.assets)) {
    return requestBody;
  }
  const redacted = redactAssets(record.assets as Record<string, ImageAsset>);
  if (redacted === undefined) {
    return requestBody;
  }
  return { ...record, assets: redacted };
}

/** Informative token cost estimate (the docs do not publish the formula yet). */
export function estimateImageTokens(bytes: number): number | undefined {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return undefined;
  }
  return Math.max(1, Math.round(bytes / 512));
}
