import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ImageAsset, ImageFormat, JevRequest } from "./types.js";

/** Límites que impone la API de imágenes de System One. */
export const IMAGE_LIMITS = {
  /** Tamaño máximo por fichero, en bytes. */
  maxFileBytes: 16 * 1024 * 1024,
  /** Lado mínimo y máximo, en píxeles. */
  minSide: 280,
  maxSide: 1568,
  /** Total de píxeles mínimo y máximo. */
  minPixels: 78_400,
  maxPixels: 2_458_624,
} as const;

/** Formatos admitidos por la API (APNG queda rechazado). */
export const IMAGE_FORMATS: readonly ImageFormat[] = ["png", "jpg", "jpeg"];

/** Cabecera obligatoria cuando un request lleva `assets`. */
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

/** Formato detectado a partir de los magic bytes (no de la extensión). */
export function detectImageFormat(buffer: Buffer): ImageFormat | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg";
  }
  return undefined;
}

/** Convierte `jpg`/`jpeg`/`png` a la clave `format` canónica de la API. */
export function canonicalFormat(format: ImageFormat): "png" | "jpg" {
  return format === "png" ? "png" : "jpg";
}

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * Lee las dimensiones de un PNG (IHDR) o JPEG (marcador SOF) sin decodificar
 * la imagen. Devuelve `undefined` cuando el formato no es PNG/JPEG o el
 * contenedor es ilegible.
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
    // Marcadores SOF que llevan dimensiones (excluye DHT C4, JPG C8 y DAC CC).
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

/** Valida los límites de la API y devuelve el motivo del rechazo, si lo hay. */
export function assertImageLimits(buffer: Buffer): ImageLimitsReport {
  if (buffer.length > IMAGE_LIMITS.maxFileBytes) {
    return {
      ok: false,
      reason: `el fichero supera los ${IMAGE_LIMITS.maxFileBytes / (1024 * 1024)} MiB`,
    };
  }
  const size = readImageSize(buffer);
  if (size === undefined) {
    return { ok: false, reason: "no se pudieron leer las dimensiones de la imagen" };
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
      reason: `la imagen mide ${size.width}×${size.height}; el mínimo por lado es ${IMAGE_LIMITS.minSide} px`,
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
      reason: `la imagen mide ${size.width}×${size.height}; el máximo por lado es ${IMAGE_LIMITS.maxSide} px`,
    };
  }
  if (pixels < IMAGE_LIMITS.minPixels || pixels > IMAGE_LIMITS.maxPixels) {
    return {
      ok: false,
      width: size.width,
      height: size.height,
      reason: `la imagen suma ${pixels} px; debe estar entre ${IMAGE_LIMITS.minPixels} y ${IMAGE_LIMITS.maxPixels}`,
    };
  }
  return { ok: true, width: size.width, height: size.height };
}

/** UUID v4 recomendado por la API para que la referencia no colisione con texto. */
export function newImageRef(): string {
  return randomUUID();
}

/** Lee un fichero, detecta su formato por magic bytes y valida sus límites. */
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
      `no se pudo leer la imagen ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const format = detectImageFormat(buffer);
  if (format === undefined) {
    throw assetError(
      "unsupported_image_format",
      `formato de imagen no soportado en ${path} (solo PNG o JPEG)`,
    );
  }

  const report = assertImageLimits(buffer);
  if (!report.ok) {
    throw assetError("image_too_large", `${path}: ${report.reason ?? "límites de imagen incumplidos"}`);
  }
  if (report.width === undefined || report.height === undefined) {
    throw assetError("image_size_parsing_failed", `${path}: no se pudieron leer las dimensiones`);
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
 * Convierte un `data_base64` en un asset validado. Comprueba que no lleve el
 * prefijo `data:` ni caracteres de salto de línea/espacios y que el formato
 * sea `png|jpg|jpeg`.
 */
export function validateImageAsset(ref: string, asset: ImageAsset): ImageAsset {
  if (asset.data_base64 !== undefined) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(asset.data_base64)) {
      throw new Error(
        `el asset ${JSON.stringify(ref)} tiene un data_base64 inválido: ` +
          "quita el prefijo 'data:' y los saltos de línea/espacios",
      );
    }
    if (asset.format === undefined || !IMAGE_FORMATS.includes(asset.format)) {
      throw new Error(
        `el asset ${JSON.stringify(ref)} necesita un format png|jpg|jpeg junto a data_base64`,
      );
    }
  }
  return { type: "image", ...asset };
}

/** Valida un mapa de assets completo antes de gastar una llamada. */
export function validateAssets(assets: Record<string, ImageAsset>): void {
  for (const [ref, asset] of Object.entries(assets)) {
    validateImageAsset(ref, asset);
  }
}

/** Referencias de `assets` que no aparecen en `state`/`instructions`/`criteria`. */
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

/** Metadatos de un asset para el historial; nunca incluye `data_base64`. */
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

/** Reemplaza `data_base64` por metadatos en un body antes de persistirlo. */
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

/** Estimación informativa del coste en tokens (la doc aún no publica la fórmula). */
export function estimateImageTokens(bytes: number): number | undefined {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return undefined;
  }
  return Math.max(1, Math.round(bytes / 512));
}
