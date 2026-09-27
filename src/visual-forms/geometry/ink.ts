import type { Raster } from "../../visual-resolver/types";
import type { Point } from "./path";

/**
 * A pure software painter for procedural forms (no canvas, no DOM, so forms render identically in the
 * browser and in tests). Every sample holds two values:
 * - density: how much of the particle body belongs here (0 = empty space, 1 = a full stroke);
 * - tone: how bright those particles are.
 * Painting replaces what is underneath (like ink over paper, layer by layer), on a supersampled grid that
 * is area-averaged on output, so edges are smooth. The result is an ordinary RGBA raster: alpha carries
 * density, RGB carries tone. The `ink` sampling style reads it back that way.
 */
export interface Ink {
  density: number;
  tone: number;
  /** 0..1: dry-brush texture, a smooth deterministic noise that thins the density in places. */
  grain?: number;
}
/** An ink, or an ink that varies over the form (e.g. a wash that deepens toward an edge). */
export type InkSource = Ink | ((x: number, y: number) => Ink);

/** The region of normalized space the canvas shows (x right, y up). */
export interface Frame { left: number; right: number; bottom: number; top: number }

export const inkLimits = { side: 260, supersample: 3 };

const fract = (x: number) => x - Math.floor(x);
const hash = (x: number, y: number) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
const smooth = (t: number) => t * t * (3 - 2 * t);
function valueNoise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y), tx = smooth(x - xi), ty = smooth(y - yi);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}
/** Two octaves of smooth value noise in 0..1: fibres of a brush rather than pixel speckle. */
export const brushNoise = (x: number, y: number) => valueNoise(x * 7, y * 7) * 0.65 + valueNoise(x * 19 + 3.1, y * 19 - 1.7) * 0.35;

export class InkCanvas {
  readonly width: number;
  readonly height: number;
  private readonly ss: number;
  private readonly W: number;
  private readonly H: number;
  private readonly sx: number;
  private readonly sy: number;
  private readonly density: Float32Array;
  private readonly tone: Float32Array;

  constructor(private readonly frame: Frame, side = inkLimits.side, supersample = inkLimits.supersample) {
    const spanX = frame.right - frame.left, spanY = frame.top - frame.bottom;
    if (!(spanX > 0 && spanY > 0)) throw new Error("ink-frame-invalid");
    const aspect = spanX / spanY;
    this.width = Math.max(2, aspect >= 1 ? side : Math.round(side * aspect));
    this.height = Math.max(2, aspect >= 1 ? Math.round(side / aspect) : side);
    this.ss = supersample;
    this.W = this.width * supersample; this.H = this.height * supersample;
    this.sx = this.W / spanX; this.sy = this.H / spanY;
    this.density = new Float32Array(this.W * this.H);
    this.tone = new Float32Array(this.W * this.H);
  }

  /** Normalized coordinates of a supersample's centre. */
  private point(px: number, py: number): Point {
    return [this.frame.left + (px + 0.5) / this.sx, this.frame.top - (py + 0.5) / this.sy];
  }

  private put(px: number, py: number, ink: InkSource) {
    const [x, y] = this.point(px, py);
    const value = typeof ink === "function" ? ink(x, y) : ink;
    const grain = value.grain ? 1 - value.grain * brushNoise(x, y) : 1;
    const i = py * this.W + px;
    this.density[i] = Math.max(0, Math.min(1, value.density * grain));
    this.tone[i] = Math.max(0, Math.min(1, value.tone));
  }

  /** Supersample index range covering [a, b] in normalized x (or y, top-down), clamped to the canvas. */
  private columns(a: number, b: number): [number, number] {
    return [Math.max(0, Math.floor((a - this.frame.left) * this.sx)), Math.min(this.W - 1, Math.ceil((b - this.frame.left) * this.sx))];
  }
  private rows(bottom: number, top: number): [number, number] {
    return [Math.max(0, Math.floor((this.frame.top - top) * this.sy)), Math.min(this.H - 1, Math.ceil((this.frame.top - bottom) * this.sy))];
  }

  disc(cx: number, cy: number, r: number, ink: InkSource) {
    const [x0, x1] = this.columns(cx - r, cx + r), [y0, y1] = this.rows(cy - r, cy + r);
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
      const [x, y] = this.point(px, py);
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) this.put(px, py, ink);
    }
    return this;
  }

  /** Even-odd fill of closed polylines (holes are simply inner rings), sampled at supersample centres. */
  polygon(rings: readonly (readonly Point[])[], ink: InkSource) {
    const crossings: number[] = [];
    for (let py = 0; py < this.H; py++) {
      const y = this.point(0, py)[1];
      crossings.length = 0;
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [x1, y1] = ring[i], [x2, y2] = ring[j];
          if ((y1 > y) !== (y2 > y)) crossings.push(x1 + (y - y1) / (y2 - y1) * (x2 - x1));
        }
      }
      crossings.sort((a, b) => a - b);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const from = Math.max(0, Math.ceil((crossings[k] - this.frame.left) * this.sx - 0.5));
        const to = Math.min(this.W - 1, Math.floor((crossings[k + 1] - this.frame.left) * this.sx - 0.5));
        for (let px = from; px <= to; px++) this.put(px, py, ink);
      }
    }
    return this;
  }

  /**
   * A stroke of `width` along a polyline. Joins are round; `cap` sets the two open ends ("round" or
   * "butt"). A closed polyline (first point repeated at the end) has no ends.
   */
  stroke(line: readonly Point[], width: number, ink: InkSource, cap: "round" | "butt" = "round") {
    const half = width / 2;
    for (let s = 1; s < line.length; s++) {
      const [ax, ay] = line[s - 1], [bx, by] = line[s];
      const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
      const butt0 = cap === "butt" && s === 1, butt1 = cap === "butt" && s === line.length - 1;
      const [x0, x1] = this.columns(Math.min(ax, bx) - half, Math.max(ax, bx) + half);
      const [y0, y1] = this.rows(Math.min(ay, by) - half, Math.max(ay, by) + half);
      for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
        const [x, y] = this.point(px, py);
        const raw = length2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / length2 : 0;
        if ((butt0 && raw < 0) || (butt1 && raw > 1)) continue;
        const t = Math.max(0, Math.min(1, raw));
        if ((x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= half * half) this.put(px, py, ink);
      }
    }
    return this;
  }

  /** Area-averages the supersamples into an RGBA raster: alpha = density, RGB = density-weighted tone. */
  toRaster(): Raster {
    const { width, height, ss, W } = this;
    const data = new Uint8ClampedArray(width * height * 4);
    const n = ss * ss;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let density = 0, tone = 0;
      for (let yy = 0; yy < ss; yy++) for (let xx = 0; xx < ss; xx++) {
        const i = (y * ss + yy) * W + x * ss + xx;
        density += this.density[i]; tone += this.tone[i] * this.density[i];
      }
      const light = density > 0 ? tone / density : 0;
      const o = (y * width + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = Math.round(light * 255);
      data[o + 3] = Math.round(density / n * 255);
    }
    return { width, height, data };
  }
}
