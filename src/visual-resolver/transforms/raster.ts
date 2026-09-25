import { IMAGE_MIME, limits } from "../net";
import { ResolveError, type Raster } from "../types";

/**
 * Browser-only decoding. Images are decoded locally into small rasters that are sampled into particle
 * positions; nothing is drawn on screen and no remote content is ever executed or inserted in the page.
 */
export function canvas(width: number, height: number) {
  const element = document.createElement("canvas");
  element.width = width; element.height = height;
  const context = element.getContext("2d", { willReadFrequently: true });
  if (!context) throw new ResolveError("canvas-unavailable");
  return context;
}

export const readCanvas = (context: CanvasRenderingContext2D): Raster => {
  const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height);
  return { width: pixels.width, height: pixels.height, data: pixels.data };
};

/** Checks what can be checked before decoding: size and declared type. */
export function checkImageBlob(blob: Blob) {
  if (blob.size > limits.imageBytes) throw new ResolveError("image-too-large");
  if (blob.size < 64) throw new ResolveError("image-invalid");
  if (blob.type && !(IMAGE_MIME as readonly string[]).includes(blob.type)) throw new ResolveError("image-type");
}

/**
 * Decodes JPEG/PNG/WebP into a raster whose longest side is at most `maxSide`.
 * `exact` keeps the stored pixel values (no colour management or premultiplication): elevation tiles
 * encode metres in RGB and must not be altered.
 */
export async function decodeImage(blob: Blob, maxSide = 512, exact = false): Promise<Raster> {
  checkImageBlob(blob);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, exact ? { colorSpaceConversion: "none", premultiplyAlpha: "none" } : undefined);
  } catch { throw new ResolveError("image-invalid"); }
  try {
    if (bitmap.width * bitmap.height > 40_000_000) throw new ResolveError("image-too-large");
    if (bitmap.width < 16 || bitmap.height < 16) throw new ResolveError("image-invalid");
    const scale = exact ? 1 : Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const context = canvas(Math.max(2, Math.round(bitmap.width * scale)), Math.max(2, Math.round(bitmap.height * scale)));
    if (exact) context.imageSmoothingEnabled = false;
    context.drawImage(bitmap, 0, 0, context.canvas.width, context.canvas.height);
    return readCanvas(context);
  } finally { bitmap.close(); }
}
