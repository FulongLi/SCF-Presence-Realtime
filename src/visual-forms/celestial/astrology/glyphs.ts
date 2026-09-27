import { Path } from "../../geometry/path";

/**
 * Zodiac and planetary glyphs as pen paths (x right, y up, roughly within [-1, 1]), drawn from their
 * traditional letterforms rather than from an installed symbol font, so they look the same on every
 * device. The star-glyph renderer normalizes their size.
 */
export type GlyphDrawing = () => Path;

export const ZODIAC_SIGNS = [
  "aries", "taurus", "gemini", "cancer", "leo", "virgo", "libra", "scorpio", "sagittarius", "capricorn", "aquarius", "pisces",
] as const;
export type ZodiacSign = typeof ZODIAC_SIGNS[number];

export const PLANETS = ["sun", "moon", "mercury", "venus", "mars", "jupiter", "saturn"] as const;
export type Planet = typeof PLANETS[number];

/** An arrowhead at (x, y) pointing along `angle` degrees, as a single open stroke. */
function arrowhead(path: Path, x: number, y: number, angle: number, size = 0.32, spread = 42) {
  const a = (angle + 180 - spread) * Math.PI / 180, b = (angle + 180 + spread) * Math.PI / 180;
  return path.moveTo(x + Math.cos(a) * size, y + Math.sin(a) * size).lineTo(x, y).lineTo(x + Math.cos(b) * size, y + Math.sin(b) * size);
}

/**
 * The shared "m" of Virgo and Scorpio: a first stem and two arches. The path is left at the top of the
 * third stem, so the caller continues it downward; returns that stem's x.
 */
function mStrokes(path: Path, left: number, width: number, top: number, bottom: number) {
  const r = width / 4;
  path.moveTo(left, top + r * 0.2).lineTo(left, bottom);
  path.moveTo(left, top - r).arc(left + r, top - r, r, 180, 0).lineTo(left + 2 * r, bottom);
  path.moveTo(left + 2 * r, top - r).arc(left + 3 * r, top - r, r, 180, 0);
  return left + 4 * r;
}

export const ZODIAC_GLYPHS: Readonly<Record<ZodiacSign, GlyphDrawing>> = {
  // ♈ The ram's horns: two curls rising from one stem.
  aries: () => new Path()
    .moveTo(0, -0.9).lineTo(0, 0.3)
    .arc(-0.36, 0.3, 0.36, 0, 205)
    .moveTo(0, 0.3).arc(0.36, 0.3, 0.36, 180, -25),
  // ♉ The bull: a circle with a crescent of horns above it.
  taurus: () => new Path()
    .circle(0, -0.32, 0.46)
    .arc(0, 0.64, 0.5, 192, 348),
  // ♊ The twins: two pillars joined by curved lintels.
  gemini: () => new Path()
    .moveTo(-0.72, 0.84).quadTo(0, 0.52, 0.72, 0.84)
    .moveTo(-0.72, -0.84).quadTo(0, -0.52, 0.72, -0.84)
    .moveTo(-0.3, 0.67).lineTo(-0.3, -0.67)
    .moveTo(0.3, 0.67).lineTo(0.3, -0.67),
  // ♋ The crab: two curls, one turned against the other.
  cancer: () => new Path()
    .circle(-0.42, 0.26, 0.22)
    .moveTo(-0.42, 0.48).cubicTo(0.0, 0.8, 0.55, 0.7, 0.86, 0.36)
    .circle(0.42, -0.26, 0.22)
    .moveTo(0.42, -0.48).cubicTo(0.0, -0.8, -0.55, -0.7, -0.86, -0.36),
  // ♌ The lion: a small loop, the sweep of the mane, and a tail curling out.
  leo: () => new Path()
    .circle(-0.46, -0.34, 0.26)
    .moveTo(-0.24, -0.2)
    .cubicTo(-0.38, 0.35, -0.12, 0.84, 0.25, 0.8)
    .cubicTo(0.66, 0.76, 0.66, 0.28, 0.4, -0.1)
    .cubicTo(0.2, -0.42, 0.26, -0.86, 0.58, -0.84)
    .cubicTo(0.74, -0.83, 0.82, -0.72, 0.84, -0.62),
  // ♍ The maiden: an "m" whose last stem loops back across itself.
  virgo: () => {
    const path = new Path();
    const right = mStrokes(path, -0.8, 1.16, 0.6, -0.72);
    return path.lineTo(right, -0.3)
      .cubicTo(right, -0.72, right + 0.52, -0.62, right + 0.44, -0.2)
      .cubicTo(right + 0.36, 0.18, right - 0.1, -0.1, right - 0.2, -0.9);
  },
  // ♎ The scales: a base line and a line lifted by the rising sun.
  libra: () => new Path()
    .moveTo(-0.84, -0.46).lineTo(0.84, -0.46)
    .moveTo(-0.84, -0.06).lineTo(-0.28, -0.06)
    .arc(0, 0.17, 0.36, 220, -40)
    .lineTo(0.84, -0.06),
  // ♏ The scorpion: an "m" whose last stem ends in a raised sting.
  scorpio: () => {
    const path = new Path();
    const right = mStrokes(path, -0.86, 1.16, 0.6, -0.62);
    path.lineTo(right, -0.46).cubicTo(right, -0.78, right + 0.3, -0.82, right + 0.56, -0.5);
    return arrowhead(path, right + 0.56, -0.5, 52, 0.26);
  },
  // ♐ The archer: an arrow with a crossbar.
  sagittarius: () => {
    const path = new Path().moveTo(-0.78, -0.78).lineTo(0.76, 0.76)
      .moveTo(-0.56, 0.06).lineTo(0.06, -0.56);
    return arrowhead(path, 0.78, 0.78, 45, 0.52, 45);
  },
  // ♑ The sea-goat: a V, then a stroke that rises and falls into a loop with a trailing tail.
  capricorn: () => new Path()
    .moveTo(-0.9, 0.5).quadTo(-0.72, 0.62, -0.62, 0.36)
    .lineTo(-0.36, -0.56).lineTo(-0.1, 0.44)
    .cubicTo(0.0, 0.8, 0.38, 0.78, 0.36, 0.2)
    .lineTo(0.3, -0.2)
    .cubicTo(0.26, -0.62, 0.86, -0.7, 0.84, -0.34)
    .cubicTo(0.82, -0.02, 0.36, -0.02, 0.3, -0.48)
    .cubicTo(0.26, -0.78, 0.0, -0.92, -0.26, -0.86),
  // ♒ The water-bearer: two parallel waves.
  aquarius: () => {
    const path = new Path();
    for (const y of [0.24, -0.3]) {
      path.moveTo(-0.84, y);
      for (let i = 1; i <= 6; i++) path.lineTo(-0.84 + i * 0.28, y + (i % 2 ? 0.24 : 0));
    }
    return path;
  },
  // ♓ The fishes: two arcs back to back, bound by a cord.
  pisces: () => new Path()
    .arc(-1.16, 0, 0.9, -54, 54)
    .moveTo(0.63, 0.73).arc(1.16, 0, 0.9, 126, 234)
    .moveTo(-0.62, 0).lineTo(0.62, 0),
};

export const PLANET_GLYPHS: Readonly<Record<Planet, GlyphDrawing>> = {
  // ☉ A circle with a point at its centre (the centre is drawn as a star by the renderer).
  sun: () => new Path().circle(0, 0, 0.72),
  // ☽ A crescent: the outer rim of one circle and the inner rim of another, meeting at the horns.
  moon: () => new Path().arc(0, 0, 0.78, -118.8, 118.8).arc(-0.31, 0, 0.69, 95.3, -95.3).close(),
  // ☿ Venus's circle and cross, crowned with horns.
  mercury: () => new Path()
    .circle(0, 0.06, 0.34)
    .moveTo(0, -0.28).lineTo(0, -0.96).moveTo(-0.26, -0.64).lineTo(0.26, -0.64)
    .end().arc(0, 0.72, 0.32, 200, 340),
  // ♀ A circle over a cross.
  venus: () => new Path()
    .circle(0, 0.3, 0.44)
    .moveTo(0, -0.14).lineTo(0, -0.96).moveTo(-0.32, -0.58).lineTo(0.32, -0.58),
  // ♂ A circle with an arrow rising to the upper right.
  mars: () => arrowhead(new Path()
    .circle(-0.2, -0.2, 0.46)
    .moveTo(0.13, 0.13).lineTo(0.76, 0.76), 0.76, 0.76, 45, 0.4, 45),
  // ♃ A crescent swept into a bar, crossed by a stem.
  jupiter: () => new Path()
    .moveTo(-0.52, 0.66).cubicTo(-0.1, 0.9, 0.12, 0.38, -0.56, -0.26)
    .lineTo(0.6, -0.26)
    .moveTo(0.3, 0.72).lineTo(0.3, -0.86),
  // ♄ A cross whose stem sweeps down into a hooked curve.
  saturn: () => new Path()
    .moveTo(-0.58, 0.56).lineTo(0.06, 0.56)
    .moveTo(-0.26, 0.9).lineTo(-0.26, -0.6)
    .moveTo(-0.26, 0.04).cubicTo(0.06, 0.4, 0.62, 0.26, 0.42, -0.14)
    .cubicTo(0.22, -0.5, 0.26, -0.9, 0.6, -0.78),
};
