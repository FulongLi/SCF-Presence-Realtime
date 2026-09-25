import type { TerrainStyle } from "../../visual-actions/types";
import { ResolveError, type HeightField, type Raster, type TerrainSource } from "../types";

/**
 * Terrain sources → HeightField. Real elevations are preferred; brightness is the fallback for
 * grayscale relief or depth-like images. Pure functions, no canvas.
 */

/** Mapzen/AWS "terrarium" encoding: metres = R·256 + G + B/256 − 32768. Transparent pixels are no-data. */
export function decodeTerrarium(image: Raster): Float32Array {
  const out = new Float32Array(image.width * image.height);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = image.data[o + 3] < 128 ? NaN : image.data[o] * 256 + image.data[o + 1] + image.data[o + 2] / 256 - 32768;
  }
  return out;
}

/** Luminance (0..1) as height, for grayscale heightmaps and relief imagery. Transparent = no data. */
export function brightnessSource(image: Raster, label: string, provider = "image"): TerrainSource {
  const values = new Float32Array(image.width * image.height);
  for (let i = 0; i < values.length; i++) {
    const o = i * 4;
    values[i] = image.data[o + 3] < 128 ? NaN : (image.data[o] * 0.2126 + image.data[o + 1] * 0.7152 + image.data[o + 2] * 0.0722) / 255;
  }
  return { provider, kind: "brightness", width: image.width, height: image.height, values, aspect: image.width / image.height, label };
}

/**
 * Even-odd scanline fill of polygon rings (in grid coordinates, x right, y down) sampled at cell
 * centres. O(rows × edges), so detailed coastlines stay cheap.
 */
export function rasterizePolygon(rings: readonly (readonly [number, number])[][], width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const crossings: number[] = [];
  for (let row = 0; row < height; row++) {
    const y = row + 0.5;
    crossings.length = 0;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[j];
        if ((y1 > y) !== (y2 > y)) crossings.push(x1 + (y - y1) / (y2 - y1) * (x2 - x1));
      }
    }
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(0, Math.ceil(crossings[k] - 0.5)), to = Math.min(width - 1, Math.floor(crossings[k + 1] - 0.5));
      for (let x = from; x <= to; x++) mask[row * width + x] = 1;
    }
  }
  return mask;
}

/** Area average that ignores NaN cells, down to at most `maxSide` cells on the longest side. */
export function downsampleGrid(values: Float32Array, width: number, height: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(2, Math.round(width * scale)), h = Math.max(2, Math.round(height * scale));
  if (w === width && h === height) return { values, width, height };
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * height / h), y1 = Math.max(y0 + 1, Math.floor((y + 1) * height / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * width / w), x1 = Math.max(x0 + 1, Math.floor((x + 1) * width / w));
      let sum = 0, count = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const v = values[yy * width + xx];
        if (Number.isFinite(v)) { sum += v; count++; }
      }
      out[y * w + x] = count ? sum / count : NaN;
    }
  }
  return { values: out, width: w, height: h };
}

/** One pass of 3×3 smoothing over valid cells only (coastlines do not bleed into the sea). */
function smooth(values: Float32Array, valid: Uint8Array, width: number, height: number) {
  const out = new Float32Array(values);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (!valid[i]) continue;
    let sum = 0, weight = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height || !valid[yy * width + xx]) continue;
      const w = dx === 0 && dy === 0 ? 2 : 1;
      sum += values[yy * width + xx] * w; weight += w;
    }
    out[i] = sum / weight;
  }
  return out;
}

const quantile = (sorted: Float32Array, q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];

export const heightFieldLimits = { minCells: 24, maxSide: 160 };

/**
 * Normalizes a terrain source into a HeightField:
 * - surface = valid cells inside the region mask; with real elevations, land only (sea is not
 *   drawn) unless the region is almost all water, then the sea floor is the surface;
 * - mild 3×3 smoothing, then crop to the surface with a one-cell margin;
 * - heights normalized between the 1st and 99.5th percentile, so one spike cannot flatten the rest,
 *   with a minimum range so flat countries stay flat instead of amplifying noise;
 * - relief grows with the real elevation range (a mountain range stands taller than a plain).
 */
export function buildHeightField(source: TerrainSource, style: TerrainStyle = "terrain"): HeightField {
  const { width, height, values } = source;
  if (width < 2 || height < 2 || values.length !== width * height || (source.mask && source.mask.length !== values.length)) {
    throw new ResolveError("heightfield-invalid");
  }
  const n = width * height;
  const valid = new Uint8Array(n);
  let validCount = 0, land = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(values[i]) && (!source.mask || source.mask[i])) { valid[i] = 1; validCount++; if (values[i] > 0) land++; }
  }
  const elevation = source.kind === "elevation";
  if (elevation && land >= Math.max(heightFieldLimits.minCells, validCount * 0.04)) {
    for (let i = 0; i < n; i++) if (valid[i] && !(values[i] > 0)) { valid[i] = 0; validCount--; }
  }
  if (validCount < heightFieldLimits.minCells) throw new ResolveError("heightfield-empty");
  const smoothed = smooth(values, valid, width, height);

  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!valid[y * width + x]) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  left = Math.max(0, left - 1); top = Math.max(0, top - 1);
  right = Math.min(width - 1, right + 1); bottom = Math.min(height - 1, bottom + 1);
  const w = right - left + 1, h = bottom - top + 1;
  if (w < 2 || h < 2) throw new ResolveError("heightfield-empty");

  const kept = new Float32Array(validCount);
  let k = 0, rawMin = Infinity, rawMax = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    kept[k++] = smoothed[i];
    rawMin = Math.min(rawMin, values[i]); rawMax = Math.max(rawMax, values[i]);
  }
  kept.sort();
  const lo = quantile(kept, 0.01), hi = quantile(kept, 0.995);
  const span = hi - lo;
  const range = Math.max(span, elevation ? 250 : 0.15);
  const out = new Float32Array(w * h), mask = new Uint8Array(w * h);
  let min = 1, max = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y + top) * width + x + left, o = y * w + x;
    if (!valid[i]) continue;
    const v = Math.max(0, Math.min(1, (smoothed[i] - lo) / range));
    out[o] = v; mask[o] = 1;
    min = Math.min(min, v); max = Math.max(max, v);
  }
  if (!(max >= min)) throw new ResolveError("heightfield-invalid");
  let relief = elevation ? 0.5 + 0.5 * Math.min(1, span / 3000) : 0.75;
  if (style === "relief") relief = Math.min(1, relief * 1.3);
  return {
    width: w, height: h, values: out, mask, relief,
    aspect: source.aspect * (w / width) / (h / height),
    elevation: elevation ? { min: Math.round(rawMin), max: Math.round(rawMax) } : undefined,
  };
}

/** Min and max normalized height over the surface, for diagnostics and tests. */
export function heightRange(field: HeightField) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < field.values.length; i++) {
    if (field.mask && !field.mask[i]) continue;
    min = Math.min(min, field.values[i]); max = Math.max(max, field.values[i]);
  }
  return { min, max };
}
