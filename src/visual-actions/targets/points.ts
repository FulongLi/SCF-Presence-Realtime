import type { MorphTarget, Raster } from "../types";

function validate(image: Raster) {
  const { width, height, data } = image;
  if (width < 2 || height < 2 || width * height > 512 * 512 || data.length !== width * height * 4) throw new Error("invalid-raster");
}
const luminance = (data: Uint8ClampedArray, i: number) => (data[i * 4] * 0.2126 + data[i * 4 + 1] * 0.7152 + data[i * 4 + 2] * 0.0722) / 255;

/**
 * Samples a raster into particle rest positions with a stable random sequence, so every
 * quality-tier prefix still shows the whole image.
 * - portrait: luminance-weighted density, vignette, shallow luminance relief and photographic tones.
 * - glyph: alpha-weighted density with edge emphasis, a thin volumetric slab and even tones.
 */
export function createTargetPoints(target: Pick<MorphTarget, "raster" | "style">, count: number) {
  const image = target.raster;
  validate(image);
  const { width, height, data } = image;
  const glyph = target.style === "glyph";
  const length = width * height;
  const tone = new Float32Array(length), distribution = new Float64Array(length);
  let total = 0;
  for (let i = 0; i < length; i++) tone[i] = glyph ? data[i * 4 + 3] / 255 : luminance(data, i);
  for (let i = 0; i < length; i++) {
    const edge = Math.abs(tone[i] - tone[Math.max(0, i - 1)]) + Math.abs(tone[i] - tone[Math.max(0, i - width)]);
    if (glyph) {
      total += tone[i] > 0.35 ? Math.pow(tone[i], 1.5) + edge * 0.6 : 0;
    } else {
      const x = ((i % width) / (width - 1) - 0.5) * 2;
      const y = (Math.floor(i / width) / (height - 1) - 0.5) * 2;
      const vignette = Math.max(0, Math.min(1, (1.22 - Math.hypot(x * 0.85, y * 0.85)) / 0.24));
      total += (0.015 + Math.pow(tone[i], 1.6) + edge * 0.4) * vignette * data[i * 4 + 3] / 255;
    }
    distribution[i] = total;
  }
  if (total < 0.01) throw new Error("empty-raster");
  const positions = new Float32Array(count * 3), tones = new Float32Array(count);
  const aspect = width / height;
  // Portraits are sized by height; glyph rows by width so short words stay legible.
  const h = glyph ? Math.min(2, 3.2 / aspect) : 3.6 / Math.max(1, aspect), w = h * aspect;
  let seed = glyph ? 0x61f7 : 0x7e51a;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < count; i++) {
    const pick = random() * total;
    let lo = 0, hi = length - 1;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (distribution[mid] <= pick) lo = mid + 1; else hi = mid; }
    const x = ((lo % width + random()) / width - 0.5) * w;
    const y = (0.5 - (Math.floor(lo / width) + random()) / height) * h;
    const value = tone[lo];
    if (glyph) {
      // A shallow slab gives letters body without blurring their outline from the front.
      positions.set([x, y, (random() - 0.5) * 0.16], i * 3);
      tones[i] = 0.62 + random() * 0.3;
    } else {
      // Shallow relief only: luminance is not reconstructed facial depth.
      positions.set([x, y, (value - 0.5) * 0.17 + (random() - 0.5) * 0.07], i * 3);
      tones[i] = 0.08 + Math.pow(value, 1.15) * 0.82;
    }
  }
  return { positions, tones };
}
