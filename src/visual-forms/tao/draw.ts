import type { Raster2DTarget } from "../../visual-resolver/types";
import { InkCanvas, type Ink, type InkSource } from "../geometry/ink";
import { Path, roundedRect, transform } from "../geometry/path";
import { BAGUA_ARRANGEMENTS, DIRECTION_ANGLE, TRIGRAMS, type Direction, type Line, type TrigramName } from "./trigrams";

/**
 * The Tao pack's drawings, painted with ink (density + tone) and sampled in the `ink` style. The language is
 * that of an ink painting translated into light: yang is a full, bright stroke (dense particles), yin is a
 * pale wash (a sparse, dim veil with a dry-brush texture), and the empty space around a form is part of it.
 */
export const TAO_INK = {
  yang: { density: 1, tone: 0.96, grain: 0.08 },
  yin: { density: 0.17, tone: 0.3, grain: 0.55 },
  /** The fine outer rim that keeps a yin-yang's silhouette whole where the yin side is sparse. */
  rim: { density: 0.9, tone: 0.72, grain: 0.12 },
  /** Trigram lines: brush strokes, with a little dry-brush texture. */
  line: { density: 1, tone: 0.94, grain: 0.2 },
} satisfies Record<string, Ink>;

/** Proportions of the yin-yang, relative to its radius. */
export const YIN_YANG = { dot: 0.15, rim: 0.045 };

/**
 * A yin-yang of radius r centred at (cx, cy). The classical construction: the yang (bright) half is the left
 * half-disc, plus the upper small disc of radius r/2, minus the lower one, which draws the S-shaped division;
 * each head carries a dot of the other. The bright fish rises on the left with its head at the top.
 */
export function paintYinYang(canvas: InkCanvas, cx: number, cy: number, r: number, ink: { yin: InkSource; yang: InkSource; rim: InkSource } = TAO_INK) {
  const half = r / 2, dot = r * YIN_YANG.dot, rim = r * YIN_YANG.rim;
  canvas.disc(cx, cy, r, ink.yin);
  canvas.polygon(new Path().arc(cx, cy, r, 90, 270).close().lines, ink.yang);
  canvas.disc(cx, cy + half, half, ink.yang);
  canvas.disc(cx, cy - half, half, ink.yin);
  canvas.disc(cx, cy + half, dot, ink.yin);
  canvas.disc(cx, cy - half, dot, ink.yang);
  canvas.stroke(new Path().circle(cx, cy, r - rim / 2).lines[0], rim, ink.rim);
}

export interface LineGeometry {
  /** Length of a line (a yin line's two halves and gap together). */
  length: number;
  thickness: number;
  /** Gap in the middle of a yin line. */
  gap: number;
}

/**
 * One line of a trigram centred at (cx, cy) and turned by `angle` degrees: yang is one unbroken bar, yin is
 * two bars with a gap between them. Bars are brush strokes with softly rounded corners.
 */
export function paintLine(canvas: InkCanvas, line: Line, cx: number, cy: number, geometry: LineGeometry, angle = 0, ink: InkSource = TAO_INK.line) {
  const { length, thickness, gap } = geometry;
  const corner = thickness * 0.22, half = (length - gap) / 2, rad = angle * Math.PI / 180;
  const bars = line === 1 ? [{ shift: 0, length }] : [{ shift: -(gap + half) / 2, length: half }, { shift: (gap + half) / 2, length: half }];
  for (const bar of bars) {
    const x = cx + Math.cos(rad) * bar.shift, y = cy + Math.sin(rad) * bar.shift;
    canvas.polygon([transform(roundedRect(bar.length, thickness, corner), { rotate: angle, x, y })], ink);
  }
}

/** A trigram's lines from the bottom up, `spacing` apart (centre to centre), stacked along `angle` + 90°. */
export function paintTrigram(canvas: InkCanvas, name: TrigramName, cx: number, cy: number, geometry: LineGeometry & { spacing: number }, angle = 0) {
  const up = (angle + 90) * Math.PI / 180;
  TRIGRAMS[name].lines.forEach((line, index) => {
    const along = (index - 1) * geometry.spacing;
    paintLine(canvas, line, cx + Math.cos(up) * along, cy + Math.sin(up) * along, geometry, angle);
  });
}

const target = (canvas: InkCanvas): Raster2DTarget => ({ kind: "raster2d", style: "ink", raster: canvas.toRaster() });

export const TRIGRAM_GEOMETRY = { length: 1.6, thickness: 0.22, gap: 0.26, spacing: 0.4 };

export function renderYinYang(): Raster2DTarget {
  const canvas = new InkCanvas({ left: -1, right: 1, bottom: -1, top: 1 });
  paintYinYang(canvas, 0, 0, 0.92);
  return target(canvas);
}

/** A single yin or yang line, the atom of every trigram and hexagram. */
export function renderLine(line: Line): Raster2DTarget {
  const { length, thickness } = TRIGRAM_GEOMETRY;
  const margin = 0.1;
  const canvas = new InkCanvas({ left: -length / 2 - margin, right: length / 2 + margin, bottom: -thickness / 2 - margin, top: thickness / 2 + margin });
  paintLine(canvas, line, 0, 0, TRIGRAM_GEOMETRY);
  return target(canvas);
}

export function renderTrigram(name: TrigramName): Raster2DTarget {
  const { length, thickness, spacing } = TRIGRAM_GEOMETRY;
  const margin = 0.12, halfHeight = spacing + thickness / 2 + margin;
  const canvas = new InkCanvas({ left: -length / 2 - margin, right: length / 2 + margin, bottom: -halfHeight, top: halfHeight });
  paintTrigram(canvas, name, 0, 0, TRIGRAM_GEOMETRY);
  return target(canvas);
}

/** Proportions of the bagua in the unit frame: a small yin-yang, open space, then the ring of trigrams. */
export const BAGUA_GEOMETRY = { center: 0.3, inner: 0.56, spacing: 0.13, thickness: 0.078, gap: 0.07, fill: 0.8 };

/**
 * The eight trigrams around a yin-yang. Each trigram faces the centre with its bottom line innermost;
 * its lines lengthen outward so every trigram fills its eighth of the circle evenly.
 */
export function renderBagua(arrangement: keyof typeof BAGUA_ARRANGEMENTS = "earlier-heaven"): Raster2DTarget {
  const g = BAGUA_GEOMETRY;
  const canvas = new InkCanvas({ left: -1, right: 1, bottom: -1, top: 1 });
  paintYinYang(canvas, 0, 0, g.center);
  for (const [direction, name] of Object.entries(BAGUA_ARRANGEMENTS[arrangement]) as [Direction, TrigramName][]) {
    const angle = DIRECTION_ANGLE[direction], rad = angle * Math.PI / 180;
    TRIGRAMS[name].lines.forEach((line, index) => {
      const r = g.inner + index * g.spacing;
      const length = 2 * r * Math.tan(Math.PI / 8) * g.fill;
      paintLine(canvas, line, Math.cos(rad) * r, Math.sin(rad) * r, { length, thickness: g.thickness, gap: g.gap }, angle - 90);
    });
  }
  return target(canvas);
}
