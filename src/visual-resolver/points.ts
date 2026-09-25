import { subjectMap } from "./transforms/crop";
import type { HeightFieldTarget, Raster, Raster2DTarget, VisualTarget } from "./types";

/**
 * VisualTarget → particle rest positions and tones. This is the only place the body learns a shape,
 * and it does not care where the target came from. Every sampler draws from a stable random sequence,
 * so every quality-tier prefix still shows the whole visual.
 */
export interface TargetPoints { positions: Float32Array; tones: Float32Array }

export function createTargetPoints(target: VisualTarget, count: number): TargetPoints {
  switch (target.kind) {
    case "raster2d": return rasterPoints(target, count);
    case "heightfield": return heightFieldPoints(target, count);
    default: throw new Error("invalid-target");
  }
}

function validateRaster(image: Raster) {
  const { width, height, data } = image;
  if (!(width >= 2 && height >= 2) || width * height > 512 * 512 || !(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) {
    throw new Error("invalid-raster");
  }
}
const luminance = (data: Uint8ClampedArray, i: number) => (data[i * 4] * 0.2126 + data[i * 4 + 1] * 0.7152 + data[i * 4 + 2] * 0.0722) / 255;
const random = (initial: number) => { let seed = initial; return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; };
/** Index of the first cumulative weight above `pick` (binary search). */
function pickCell(distribution: Float64Array, pick: number) {
  let lo = 0, hi = distribution.length - 1;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (distribution[mid] <= pick) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * - portrait: luminance-weighted density, vignette, shallow luminance relief and photographic tones.
 * - object: density follows what differs from the background (with a little luminance and edge), so a
 *   dark car on a white floor is drawn as the car, not as the floor; photographic tones.
 * - glyph: alpha-weighted density with edge emphasis, a thin volumetric slab and even tones.
 * - logo: like glyph (alpha silhouette, no vignette, thin slab), with even density, strong outline and
 *   colour-boundary edges so inner details of a mark survive, and tones from the mark's own contrast.
 */
function rasterPoints(target: Raster2DTarget, count: number): TargetPoints {
  const image = target.raster;
  validateRaster(image);
  const { width, height, data } = image;
  const { style } = target;
  const glyph = style === "glyph", logo = style === "logo";
  const length = width * height;
  const tone = new Float32Array(length), distribution = new Float64Array(length);
  const subject = style === "object" ? subjectMap(image) : null;
  let total = 0;
  for (let i = 0; i < length; i++) tone[i] = glyph || logo ? data[i * 4 + 3] / 255 : luminance(data, i);
  // Logo tones come from the mark's own luminance range; a one-colour mark gets even light like a glyph.
  let lumLow = 1, lumHigh = 0;
  if (logo) for (let i = 0; i < length; i++) if (tone[i] > 0.35) { const l = luminance(data, i); lumLow = Math.min(lumLow, l); lumHigh = Math.max(lumHigh, l); }
  const lumSpread = lumHigh - lumLow;
  for (let i = 0; i < length; i++) {
    const edge = Math.abs(tone[i] - tone[Math.max(0, i - 1)]) + Math.abs(tone[i] - tone[Math.max(0, i - width)]);
    if (logo) {
      const l = luminance(data, i);
      const inner = Math.abs(l - luminance(data, Math.max(0, i - 1))) + Math.abs(l - luminance(data, Math.max(0, i - width)));
      total += tone[i] > 0.35 ? 1 + edge * 1.5 + inner * 1.2 : 0;
    } else if (glyph) {
      total += tone[i] > 0.35 ? Math.pow(tone[i], 1.5) + edge * 0.6 : 0;
    } else {
      const x = ((i % width) / (width - 1) - 0.5) * 2;
      const y = (Math.floor(i / width) / (height - 1) - 0.5) * 2;
      const alpha = data[i * 4 + 3] / 255;
      if (subject) {
        // A soft superelliptic edge: busy photo backgrounds dissolve into the body instead of ending in a box.
        const r = Math.pow(Math.pow(Math.abs(x), 4) + Math.pow(Math.abs(y), 4), 0.25);
        const vignette = Math.max(0, Math.min(1, (1.08 - r) / 0.4));
        total += (0.01 + Math.pow(subject[i], 1.3) * 0.9 + Math.pow(tone[i], 1.6) * 0.25 + edge * 0.5) * vignette * alpha;
      } else {
        const vignette = Math.max(0, Math.min(1, (1.22 - Math.hypot(x * 0.85, y * 0.85)) / 0.24));
        total += (0.015 + Math.pow(tone[i], 1.6) + edge * 0.4) * vignette * alpha;
      }
    }
    distribution[i] = total;
  }
  if (total < 0.01) throw new Error("empty-raster");
  const positions = new Float32Array(count * 3), tones = new Float32Array(count);
  const aspect = width / height;
  // Portraits are sized by height; glyph rows and objects by width so wide things stay large.
  const h = glyph ? Math.min(2, 3.2 / aspect) : logo ? Math.min(2.6, 3.4 / aspect) : style === "object" ? Math.min(3.3, 3.5 / aspect) : 3.6 / Math.max(1, aspect);
  const w = h * aspect;
  const next = random(glyph ? 0x61f7 : logo ? 0x10a0 : 0x7e51a);
  for (let i = 0; i < count; i++) {
    const cell = pickCell(distribution, next() * total);
    const x = ((cell % width + next()) / width - 0.5) * w;
    const y = (0.5 - (Math.floor(cell / width) + next()) / height) * h;
    const value = tone[cell];
    if (glyph) {
      // A shallow slab gives letters body without blurring their outline from the front.
      positions.set([x, y, (next() - 0.5) * 0.16], i * 3);
      tones[i] = 0.62 + next() * 0.3;
    } else if (logo) {
      positions.set([x, y, (next() - 0.5) * 0.12], i * 3);
      tones[i] = lumSpread < 0.15 ? 0.66 + next() * 0.26 : 0.34 + 0.6 * (luminance(data, cell) - lumLow) / lumSpread;
    } else {
      // Shallow relief only: luminance is not reconstructed depth.
      positions.set([x, y, (value - 0.5) * 0.17 + (next() - 0.5) * 0.07], i * 3);
      tones[i] = subject ? 0.14 + Math.pow(value, 1.1) * 0.78 : 0.08 + Math.pow(value, 1.15) * 0.82;
    }
  }
  return { positions, tones };
}

/** Terrain is laid on a ground plane tilted back from the viewer, so height reads as upward relief. */
export const terrainLayout = { width: 3.6, depth: 4, tilt: 0.9, height: 0.8 };

function validateField(target: HeightFieldTarget) {
  const f = target.field;
  if (!f || !(f.width >= 2 && f.height >= 2) || f.width * f.height > 256 * 256 || !(f.values instanceof Float32Array)
    || f.values.length !== f.width * f.height || (f.mask && f.mask.length !== f.values.length)
    || !(f.aspect > 0.05 && f.aspect < 20) || !(f.relief >= 0 && f.relief <= 1)) throw new Error("invalid-heightfield");
  for (let i = 0; i < f.values.length; i++) if (!(f.values[i] >= 0 && f.values[i] <= 1)) throw new Error("invalid-heightfield");
}

/**
 * 2.5D sampling. X/Y keep the grid's geographic layout on a ground plane; Z is the normalized height
 * times the relief. Particles are spread evenly over the surface (a little denser on steep ground so
 * ridges read) with bilinear height between cells, so there is no terracing. Tones are hillshading
 * lit from the north-west, varied by style: terrain, relief (stronger shading), topography (contour
 * bands) or heightmap (plain height).
 */
function heightFieldPoints(target: HeightFieldTarget, count: number): TargetPoints {
  validateField(target);
  const { width: W, height: H, values, mask, aspect, relief } = target.field;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && (!mask || mask[y * W + x] === 1);
  const at = (x: number, y: number, fallback: number) => inside(x, y) ? values[y * W + x] : fallback;
  const ground = Math.min(terrainLayout.width, terrainLayout.depth * aspect);
  const groundW = ground, groundD = ground / aspect;
  const lift = terrainLayout.height * relief;
  const slope = new Float32Array(W * H);
  const distribution = new Float64Array(W * H);
  let total = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (inside(x, y)) {
      const v = values[i];
      const dx = (at(x + 1, y, v) - at(x - 1, y, v)) * lift / (2 * groundW / W);
      const dy = (at(x, y + 1, v) - at(x, y - 1, v)) * lift / (2 * groundD / H);
      slope[i] = Math.min(1, Math.hypot(dx, dy));
      total += 1 + slope[i] * 1.2;
    }
    distribution[i] = total;
  }
  if (total < 1) throw new Error("empty-heightfield");
  const positions = new Float32Array(count * 3), tones = new Float32Array(count);
  const next = random(0x3e1f);
  const cos = Math.cos(terrainLayout.tilt), sin = Math.sin(terrainLayout.tilt);
  // Light from the north-west, above: the classic cartographic hillshade direction.
  const light = [-0.55, 0.55, 0.63];
  const style = target.style;
  for (let i = 0; i < count; i++) {
    const cell = pickCell(distribution, next() * total);
    const cx = cell % W, cy = Math.floor(cell / W);
    const fx = next(), fy = next();
    const v = values[cell];
    // Bilinear height towards the neighbours in the jitter direction (outside cells hold this one's height).
    const nx = fx < 0.5 ? cx - 1 : cx + 1, ny = fy < 0.5 ? cy - 1 : cy + 1;
    const tx = Math.abs(fx - 0.5), ty = Math.abs(fy - 0.5);
    const top = v + (at(nx, cy, v) - v) * tx, bottom = at(cx, ny, v) + (at(nx, ny, v) - at(cx, ny, v)) * tx;
    const h = top + (bottom - top) * ty;
    const px = ((cx + fx) / W - 0.5) * groundW;
    const pv = (0.5 - (cy + fy) / H) * groundD;
    const pz = h * lift;
    positions.set([px, pv * cos + pz * sin - lift * sin * 0.3, -pv * sin + pz * cos], i * 3);
    // Surface normal from the height gradient in ground units (x east, y north, z up).
    const gx = (at(cx + 1, cy, v) - at(cx - 1, cy, v)) * lift / (2 * groundW / W);
    const gy = -(at(cx, cy + 1, v) - at(cx, cy - 1, v)) * lift / (2 * groundD / H);
    const norm = Math.hypot(gx, gy, 1);
    const shade = Math.max(0, (-gx * light[0] - gy * light[1] + light[2]) / norm);
    let tone: number;
    switch (style) {
      case "relief": tone = 0.1 + shade * 0.8 + h * 0.1; break;
      case "heightmap": tone = 0.12 + h * 0.85; break;
      case "topography": {
        const band = Math.abs((h * 10) % 1 - 0.5) > 0.42 ? 0.22 : 0;
        tone = 0.14 + shade * 0.42 + h * 0.24 + band;
        break;
      }
      default: tone = 0.16 + shade * 0.5 + h * 0.3;
    }
    tones[i] = Math.max(0, Math.min(1, tone));
  }
  return { positions, tones };
}
