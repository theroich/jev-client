/** Attached image, already read from a local file as base64 (client-side). */
export interface AttachedImage {
  ref: string;
  name: string;
  format: "png" | "jpg";
  dataBase64: string;
  bytes: number;
  width: number;
  height: number;
  dataUrl: string;
}

/** API limit per file (see `IMAGE_LIMITS.maxFileBytes`). */
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

export function isAcceptedImage(file: File): boolean {
  return (
    file.type.startsWith("image/png") || file.type.startsWith("image/jpeg")
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () =>
      reject(reader.error ?? new Error("the file could not be read"));
    reader.readAsDataURL(file);
  });
}

function measureImage(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
}

export async function fileToImage(file: File): Promise<AttachedImage> {
  const format = file.type === "image/png" ? "png" : "jpg";
  const ref = crypto.randomUUID();
  const dataUrl = await readAsDataUrl(file);
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const size = await measureImage(dataUrl);
  return {
    ref,
    name: file.name,
    format,
    dataBase64: base64,
    bytes: file.size,
    width: size.width,
    height: size.height,
    dataUrl,
  };
}
