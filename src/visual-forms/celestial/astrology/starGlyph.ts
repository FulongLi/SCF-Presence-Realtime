import type { PointLayout, PointLayoutTarget } from "../../../visual-resolver/types";
import { bounds, polylineLength, type Path, type Point } from "../../geometry/path";

/**
 * The star-glyph renderer: a glyph's pen path → a point layout. Each stroke becomes a fine line of star
 * dust with a little sparkle, every open stroke end is a small star (the glyph is drawn *between* stars, as
 * a constellation is), and a share of the body stays behind as faint dust, so a zodiac sign belongs to the
 * same night sky as the star maps.
 */
export const STAR_GLYPH_STYLE = {
  dust: 0.15,
  width: 0.05,
  tone: 0.84,
  /** Stars at the open ends of strokes. */
  end: { radius: 0.034, tone: 1, weight: 0.09 },
  /** Half-extent of the glyph's longer side in the normalized frame. */
  extent: 0.84,
};

const isClosed = (line: readonly Point[]) => line.length > 2
  && Math.hypot(line[0][0] - line[line.length - 1][0], line[0][1] - line[line.length - 1][1]) < 1e-6;

/**
 * `dots` are extra stars in the glyph's own coordinates, e.g. the point at the centre of the Sun's circle
 * (radius and weight relative to an ordinary end star).
 */
export function renderStarGlyph(path: Path, dots: readonly { x: number; y: number; size: number }[] = []): PointLayoutTarget {
  const s = STAR_GLYPH_STYLE;
  const lines = path.lines.filter(line => line.length > 1 && polylineLength(line) > 1e-6);
  if (!lines.length) throw new Error("glyph-empty");
  const box = bounds(lines);
  const cx = (box.left + box.right) / 2, cy = (box.bottom + box.top) / 2;
  const scale = s.extent / Math.max((box.right - box.left) / 2, (box.top - box.bottom) / 2, 1e-6);
  const place = ([x, y]: Point): Point => [(x - cx) * scale, (y - cy) * scale];
  const strokes: PointLayout["strokes"] = [];
  const points: PointLayout["points"] = [];
  for (const line of lines) {
    const placed = line.map(place);
    strokes.push({ points: placed.flat(), width: s.width, weight: 1, tone: s.tone });
    if (!isClosed(line)) for (const [x, y] of [placed[0], placed[placed.length - 1]]) {
      points.push({ x, y, radius: s.end.radius, weight: s.end.weight, tone: s.end.tone });
    }
  }
  for (const dot of dots) {
    const [x, y] = place([dot.x, dot.y]);
    points.push({ x, y, radius: s.end.radius * dot.size, weight: s.end.weight * dot.size * dot.size, tone: s.end.tone });
  }
  return { kind: "points", style: "celestial", layout: { points, strokes, dust: s.dust } };
}
