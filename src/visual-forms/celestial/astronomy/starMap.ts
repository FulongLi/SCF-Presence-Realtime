import type { PointLayout, PointLayoutTarget } from "../../../visual-resolver/types";
import type { ConstellationData } from "./catalog";
import { chart } from "./projection";

/**
 * The star-map renderer: constellation data → chart coordinates → a point layout the body forms directly.
 *
 *   catalogue (RA/Dec, magnitude) ─► gnomonic chart ─► stars, lines, haze ─► PointLayoutTarget ─► particles
 *
 * Brighter stars are larger, denser and brighter cores; fainter stars are small points; the stick figure
 * is a set of fine, dim lines that stop short of each star, as on a printed star chart; nebulae are soft,
 * dim glows; and a share of the body stays behind as a faint, deep field of dust.
 */
export const STAR_MAP_STYLE = {
  /** Share of the body left as background dust. */
  dust: 0.2,
  /** Share of the non-dust body spent on the figure's lines (when shown). */
  lineShare: 0.16,
  lineWidth: 0.009,
  lineTone: 0.16,
  /** Gap between a line's end and its star: this much plus the star's radius. */
  lineGap: 0.03,
  /** Star core radius from faintest to brightest (normalized units). */
  radius: [0.012, 0.05] as const,
  tone: [0.5, 1] as const,
  hazeTone: 0.14,
};

/**
 * 0..1 prominence of each star within its own constellation, from magnitude (so a faint cluster like the
 * Pleiades still has a brightest star). Brightness ratios on the real magnitude scale are far too extreme
 * for particles, so the scale is linear in magnitude.
 */
export function prominence(magnitudes: readonly number[]): number[] {
  const bright = Math.min(...magnitudes), faint = Math.max(...magnitudes) + 0.6;
  return magnitudes.map(mag => Math.max(0.05, Math.min(1, (faint - mag) / Math.max(0.6, faint - bright))));
}

export function renderStarMap(data: ConstellationData, options: { lines?: boolean } = {}): PointLayoutTarget {
  const s = STAR_MAP_STYLE;
  const { points: placed, extra, scale } = chart(data.stars, data.haze ?? []);
  const level = prominence(data.stars.map(item => item.mag));
  const points: PointLayout["points"] = data.stars.map((_, i) => ({
    x: placed[i].x, y: placed[i].y,
    weight: 0.12 + Math.pow(level[i], 1.8),
    radius: s.radius[0] + (s.radius[1] - s.radius[0]) * level[i],
    tone: s.tone[0] + (s.tone[1] - s.tone[0]) * level[i],
  }));
  const starWeight = points.reduce((sum, p) => sum + p.weight, 0);
  (data.haze ?? []).forEach((haze, i) => points.push({
    x: extra[i].x, y: extra[i].y,
    weight: haze.strength * starWeight * 0.18,
    radius: Math.min(0.45, Math.max(0.04, haze.radius * scale)),
    tone: s.hazeTone,
  }));

  const strokes: PointLayout["strokes"] = [];
  if (options.lines !== false && data.lines.length) {
    const index = new Map(data.stars.map((item, i) => [item.id, i]));
    const segments: number[][] = [];
    for (const [from, to] of data.lines) {
      const a = points[index.get(from)!], b = points[index.get(to)!];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const gapA = a.radius + s.lineGap, gapB = b.radius + s.lineGap;
      if (length <= gapA + gapB) continue;
      const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length;
      segments.push([a.x + ux * gapA, a.y + uy * gapA, b.x - ux * gapB, b.y - uy * gapB]);
    }
    const total = segments.reduce((sum, [ax, ay, bx, by]) => sum + Math.hypot(bx - ax, by - ay), 0);
    // Lines get a fixed share of the figure whatever their total length, so every chart balances alike.
    const weight = total > 0 ? starWeight * s.lineShare / (1 - s.lineShare) / total : 0;
    for (const segment of segments) strokes.push({ points: segment, width: s.lineWidth, weight, tone: s.lineTone });
  }
  return { kind: "points", style: "celestial", layout: { points, strokes, dust: s.dust } };
}
