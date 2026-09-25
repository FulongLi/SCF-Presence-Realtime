import type { ImageIntent } from "../../visual-actions/types";
import { PORTRAIT_INTENTS } from "../providers/rank";
import type { Raster, Raster2DTarget } from "../types";

/** Pure raster geometry: crops, background trimming and resizing. No canvas, so it runs anywhere. */

export function cropRaster(image: Raster, x: number, y: number, width: number, height: number): Raster {
  const left = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const top = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const w = Math.max(1, Math.min(image.width - left, Math.round(width)));
  const h = Math.max(1, Math.min(image.height - top, Math.round(height)));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((top + row) * image.width + left) * 4;
    data.set(image.data.subarray(from, from + w * 4), row * w * 4);
  }
  return { width: w, height: h, data };
}

/**
 * Crops to an aspect ratio within [min, max]. Too wide: keep the horizontal centre. Too tall: keep the
 * band at `anchorY` (0 = top, 0.5 = centre), which is where heads usually are in a portrait.
 */
export function cropToAspect(image: Raster, min: number, max: number, anchorY = 0.5): Raster {
  const aspect = image.width / image.height;
  if (aspect > max) {
    const width = image.height * max;
    return cropRaster(image, (image.width - width) / 2, 0, width, image.height);
  }
  if (aspect < min) {
    const height = image.width / min;
    return cropRaster(image, 0, (image.height - height) * anchorY, image.width, height);
  }
  return image;
}

/** Median colour of the outermost pixels: the image's likely background. */
export function borderColor(image: Raster): [number, number, number] {
  const { width, height, data } = image;
  const r: number[] = [], g: number[] = [], b: number[] = [];
  const push = (x: number, y: number) => { const i = (y * width + x) * 4; r.push(data[i]); g.push(data[i + 1]); b.push(data[i + 2]); };
  const step = Math.max(1, Math.floor(Math.max(width, height) / 64));
  for (let x = 0; x < width; x += step) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y += step) { push(0, y); push(width - 1, y); }
  const median = (values: number[]) => values.sort((a, c) => a - c)[values.length >> 1];
  return [median(r), median(g), median(b)];
}

/** 0..1 colour distance of each pixel from the background colour. */
export function subjectMap(image: Raster, background = borderColor(image)): Float32Array {
  const { width, height, data } = image;
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const dr = data[i * 4] - background[0], dg = data[i * 4 + 1] - background[1], db = data[i * 4 + 2] - background[2];
    out[i] = Math.min(1, Math.sqrt(dr * dr + dg * dg + db * db) / 255 / 0.6) * data[i * 4 + 3] / 255;
  }
  return out;
}

/**
 * Trims a plain background around an object (a car on a white studio floor, a product shot), keeping a
 * margin. Busy photos, where the "subject" fills the frame anyway, are left untouched.
 */
export function trimBackground(image: Raster, threshold = 0.16, margin = 0.06): Raster {
  const { width, height } = image;
  const subject = subjectMap(image);
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (subject[y * width + x] > threshold) {
      if (x < left) left = x; if (x > right) right = x;
      if (y < top) top = y; if (y > bottom) bottom = y;
    }
  }
  if (right < left) return image;
  const padX = (right - left + 1) * margin, padY = (bottom - top + 1) * margin;
  const x0 = Math.max(0, left - padX), y0 = Math.max(0, top - padY);
  const x1 = Math.min(width, right + 1 + padX), y1 = Math.min(height, bottom + 1 + padY);
  const kept = (x1 - x0) * (y1 - y0) / (width * height);
  return kept < 0.12 || kept > 0.92 ? image : cropRaster(image, x0, y0, x1 - x0, y1 - y0);
}

/**
 * Crops a raster on transparency to the bounding box of its visible pixels (alpha above `threshold`),
 * keeping an even margin of `margin` × the longest visible side. Null when nothing is visible.
 */
export function trimTransparent(image: Raster, threshold = 24, margin = 0.04): Raster | null {
  const { width, height, data } = image;
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > threshold) {
      if (x < left) left = x; if (x > right) right = x;
      if (y < top) top = y; if (y > bottom) bottom = y;
    }
  }
  if (right < left) return null;
  const pad = Math.round(Math.max(right - left + 1, bottom - top + 1) * margin);
  const x0 = Math.max(0, left - pad), y0 = Math.max(0, top - pad);
  const x1 = Math.min(width, right + 1 + pad), y1 = Math.min(height, bottom + 1 + pad);
  return cropRaster(image, x0, y0, Math.max(2, x1 - x0), Math.max(2, y1 - y0));
}

/** Area-averaging downscale so the longest side is at most `maxSide` (never upscales). */
export function resizeRaster(image: Raster, maxSide: number): Raster {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  if (scale >= 1) return image;
  const width = Math.max(2, Math.round(image.width * scale)), height = Math.max(2, Math.round(image.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  const sx = image.width / width, sy = image.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const sum = [0, 0, 0, 0];
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * image.width + xx) * 4;
        sum[0] += image.data[i]; sum[1] += image.data[i + 1]; sum[2] += image.data[i + 2]; sum[3] += image.data[i + 3];
      }
      const n = (y1 - y0) * (x1 - x0), o = (y * width + x) * 4;
      data[o] = sum[0] / n; data[o + 1] = sum[1] / n; data[o + 2] = sum[2] / n; data[o + 3] = sum[3] / n;
    }
  }
  return { width, height, data };
}

/** The largest raster a target may carry (the sampler rejects bigger ones). */
export const TARGET_SIDE = 300;

/**
 * Normalizes a decoded photo for the particle body by intent:
 * - portraits: head-and-shoulders crop (4:5 band from near the top), portrait sampling;
 * - everything else: trim a plain background, keep most of the object, object sampling.
 */
export function normalizeImage(image: Raster, intent: ImageIntent): Raster2DTarget {
  if (PORTRAIT_INTENTS.includes(intent)) {
    return { kind: "raster2d", style: "portrait", raster: resizeRaster(cropToAspect(image, 0.72, 1.05, 0.18), TARGET_SIDE) };
  }
  const trimmed = intent === "map" ? image : trimBackground(image);
  return { kind: "raster2d", style: "object", raster: resizeRaster(cropToAspect(trimmed, 0.6, 2.2), TARGET_SIDE) };
}
