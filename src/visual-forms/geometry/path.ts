/**
 * A small path builder for procedural forms, in normalized units (x right, y up). Curves are flattened
 * into polylines as they are added, so everything downstream (the ink painter, point layouts, tests)
 * only ever sees straight segments. Pure: no canvas, no DOM.
 */
export type Point = readonly [number, number];
export type Polyline = Point[];

const DEG = Math.PI / 180;
/** Flattening density: segments per unit of curve length (normalized units span about 2 across a form). */
const SEGMENTS_PER_UNIT = 48;
const steps = (length: number) => Math.max(6, Math.ceil(length * SEGMENTS_PER_UNIT));

export class Path {
  /** Every subpath as a polyline; closed subpaths repeat their first point at the end. */
  readonly lines: Polyline[] = [];
  private current: Polyline | null = null;

  private get last(): Point {
    if (!this.current?.length) throw new Error("path-empty");
    return this.current[this.current.length - 1];
  }

  moveTo(x: number, y: number) {
    this.current = [[x, y]];
    this.lines.push(this.current);
    return this;
  }

  lineTo(x: number, y: number) {
    if (!this.current) return this.moveTo(x, y);
    this.current.push([x, y]);
    return this;
  }

  /**
   * A circular arc from angle `from` to `to` (degrees, anticlockwise when `to` > `from`). Without a current
   * subpath it starts one at the arc's start; otherwise the arc is joined to the current point.
   */
  arc(cx: number, cy: number, r: number, from: number, to: number) {
    const n = steps(Math.abs(to - from) * DEG * r);
    for (let i = 0; i <= n; i++) {
      const a = (from + (to - from) * i / n) * DEG;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (i === 0 && !this.current) this.moveTo(x, y); else this.lineTo(x, y);
    }
    return this;
  }

  quadTo(cx: number, cy: number, x: number, y: number) {
    const [x0, y0] = this.last;
    const n = steps(Math.hypot(cx - x0, cy - y0) + Math.hypot(x - cx, y - cy));
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      this.lineTo(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y);
    }
    return this;
  }

  cubicTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) {
    const [x0, y0] = this.last;
    const n = steps(Math.hypot(c1x - x0, c1y - y0) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(x - c2x, y - c2y));
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      this.lineTo(a * x0 + b * c1x + c * c2x + d * x, a * y0 + b * c1y + c * c2y + d * y);
    }
    return this;
  }

  /** A full circle as its own closed subpath. */
  circle(cx: number, cy: number, r: number) {
    this.current = null;
    this.arc(cx, cy, r, 0, 360);
    this.current = null;
    return this;
  }

  /** Ends the current subpath without closing it, so the next arc starts a stroke of its own. */
  end() {
    this.current = null;
    return this;
  }

  /** Closes the current subpath back to its first point. */
  close() {
    if (this.current && this.current.length > 1) this.current.push(this.current[0]);
    this.current = null;
    return this;
  }
}

/** Rotates (degrees, anticlockwise), scales and translates points: rotation first, then scale, then offset. */
export function transform(points: readonly Point[], { rotate = 0, scale = 1, x = 0, y = 0 }: { rotate?: number; scale?: number; x?: number; y?: number }): Polyline {
  const c = Math.cos(rotate * DEG), s = Math.sin(rotate * DEG);
  return points.map(([px, py]) => [x + (px * c - py * s) * scale, y + (px * s + py * c) * scale] as const);
}

/** A rectangle with rounded corners, centred on the origin, as a closed polyline. */
export function roundedRect(width: number, height: number, radius: number): Polyline {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const w = width / 2 - r, h = height / 2 - r;
  const path = new Path();
  path.arc(w, -h, r, -90, 0).arc(w, h, r, 0, 90).arc(-w, h, r, 90, 180).arc(-w, -h, r, 180, 270).close();
  return path.lines[0];
}

/** Total length of a polyline. */
export const polylineLength = (line: readonly Point[]) => {
  let length = 0;
  for (let i = 1; i < line.length; i++) length += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return length;
};

/** Axis-aligned bounds of a set of polylines. */
export function bounds(lines: readonly (readonly Point[])[]) {
  let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
  for (const line of lines) for (const [x, y] of line) {
    left = Math.min(left, x); right = Math.max(right, x); bottom = Math.min(bottom, y); top = Math.max(top, y);
  }
  return { left, right, bottom, top };
}
