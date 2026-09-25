import { ResolveError, type Raster, type Raster2DTarget } from "../types";
import { borderColor, resizeRaster, trimTransparent } from "./crop";
import { canvas, readCanvas } from "./raster";

/**
 * SVG support for curated local assets only (a first-party logo). Remote SVGs are never fetched: image
 * providers only accept JPEG/PNG/WebP, and the local-asset loader only reads same-origin paths from the
 * manifest. Even so, the SVG text is checked before use, and it is rendered through an <img> (browsers
 * draw SVG images in a secure static mode: no scripts, no external loads) onto a canvas, so the particle
 * sampler only ever sees pixels.
 */
export const SVG_MIME = ["image/svg+xml"] as const;
export const svgLimits = {
  /** Largest SVG file read. */
  bytes: 1024 * 1024,
  /** Longest side of the rasterized logo (vector art scales cleanly, so it is rendered at this size). */
  side: 400,
  /** Shortest side, so a very wide wordmark still has rows to sample. */
  minSide: 24,
};

const ROOT = /<svg\b[^>]*>/i;
/**
 * Everything an SVG image could use to run code or reach outside itself. A logo needs none of it; a file
 * containing any of it is refused rather than sanitized.
 */
const UNSAFE: [RegExp, string][] = [
  [/<script\b/i, "script"],
  [/<foreignObject\b/i, "foreign-object"],
  [/<!ENTITY/i, "entity"],
  [/\son[a-z]+\s*=/i, "event-handler"],
  [/javascript:/i, "javascript-url"],
  [/@import\b/i, "css-import"],
  // Links and references may only point inside the document (#id) or to an embedded raster.
  [/\b(?:xlink:)?href\s*=\s*["'](?!#|data:image\/(?:png|jpeg|webp);base64,)/i, "external-reference"],
  [/url\(\s*["']?(?!#|data:image\/(?:png|jpeg|webp);base64,)/i, "external-reference"],
];

/** Refuses anything that is not a self-contained, script-free SVG document. Throws ResolveError("svg-…"). */
export function checkSvgText(text: string): void {
  if (text.length > svgLimits.bytes) throw new ResolveError("svg-too-large");
  if (!ROOT.test(text)) throw new ResolveError("svg-invalid");
  for (const [pattern, reason] of UNSAFE) if (pattern.test(text)) throw new ResolveError(`svg-unsafe-${reason}`);
}

const attribute = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
const length = (value: string | undefined) => {
  const match = value ? /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/i.exec(value) : null;
  return match ? Number(match[1]) : undefined;
};

/**
 * The raster size for an SVG: its aspect ratio (from viewBox, else width/height, else square) at
 * `side` pixels on the longest side. Vector art is rendered at the target size rather than scaled.
 */
export function svgRasterSize(text: string, side = svgLimits.side): { width: number; height: number } {
  const root = ROOT.exec(text)?.[0];
  if (!root) throw new ResolveError("svg-invalid");
  const box = attribute(root, "viewBox")?.trim().split(/[\s,]+/).map(Number);
  let aspect = box && box.length === 4 && box[2] > 0 && box[3] > 0 ? box[2] / box[3] : undefined;
  if (aspect === undefined) {
    const width = length(attribute(root, "width")), height = length(attribute(root, "height"));
    aspect = width && height ? width / height : 1;
  }
  aspect = Math.min(12, Math.max(1 / 12, aspect));
  const width = aspect >= 1 ? side : Math.round(side * aspect);
  const height = aspect >= 1 ? Math.round(side / aspect) : side;
  return { width: Math.max(svgLimits.minSide, width), height: Math.max(svgLimits.minSide, height) };
}

/** The SVG with explicit pixel width/height on its root, so every browser renders it at exactly `size`. */
export function sizedSvg(text: string, size: { width: number; height: number }): string {
  return text.replace(ROOT, tag => {
    const bare = tag.replace(/\s(?:width|height)\s*=\s*["'][^"']*["']/gi, "");
    // Keep the aspect handling explicit: a viewBox without preserveAspectRatio already centres and fits.
    return bare.replace(/^<svg\b/i, `<svg width="${size.width}" height="${size.height}"`);
  });
}

/** Browser only: renders checked SVG text to an RGBA raster of `size`, keeping transparency. */
export async function rasterizeSvg(text: string, size: { width: number; height: number }): Promise<Raster> {
  checkSvgText(text);
  const url = URL.createObjectURL(new Blob([sizedSvg(text, size)], { type: "image/svg+xml" }));
  try {
    const image = new Image(size.width, size.height);
    image.decoding = "async";
    image.src = url;
    try { await image.decode(); } catch { throw new ResolveError("svg-invalid"); }
    const context = canvas(size.width, size.height);
    context.clearRect(0, 0, size.width, size.height);
    context.drawImage(image, 0, 0, size.width, size.height);
    try { return readCanvas(context); } catch { throw new ResolveError("svg-unreadable"); }
  } finally { URL.revokeObjectURL(url); }
}

const TRANSPARENT = 24;

/**
 * Prepares a logo for the particle body: a crisp mark on nothing.
 * - Transparency is kept as it is (a transparent background is simply ignored by the sampler).
 * - A fully opaque logo on a plain background (e.g. a white rectangle) has that background keyed out.
 * - Empty margins are trimmed, leaving a small even border; the aspect ratio is preserved.
 */
export function normalizeLogoRaster(image: Raster, maxSide = svgLimits.side): Raster2DTarget {
  const { width, height, data } = image;
  let translucent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) translucent++;
  let raster = image;
  if (translucent / (width * height) < 0.02) raster = keyBackground(image);
  const trimmed = trimTransparent(raster, TRANSPARENT, 0.04);
  if (!trimmed) throw new ResolveError("asset-empty");
  return { kind: "raster2d", style: "logo", raster: resizeRaster(trimmed, maxSide) };
}

/**
 * An opaque raster whose border is one plain colour gets alpha from the distance to that colour.
 * Artwork that fills the frame (a busy border) is left opaque rather than guessed at.
 */
function keyBackground(image: Raster): Raster {
  const { width, height, data } = image;
  const background = borderColor(image);
  const distance = (i: number) => Math.hypot(data[i] - background[0], data[i + 1] - background[1], data[i + 2] - background[2]) / 441.7;
  let border = 0, plain = 0;
  const step = Math.max(1, Math.floor(Math.max(width, height) / 64));
  const check = (x: number, y: number) => { border++; if (distance((y * width + x) * 4) < 0.06) plain++; };
  for (let x = 0; x < width; x += step) { check(x, 0); check(x, height - 1); }
  for (let y = 0; y < height; y += step) { check(0, y); check(width - 1, y); }
  if (plain / border < 0.9) return image;
  const out = new Uint8ClampedArray(data);
  for (let i = 0; i < out.length; i += 4) {
    const alpha = Math.max(0, Math.min(1, (distance(i) - 0.05) / 0.12));
    out[i + 3] = Math.round(out[i + 3] * alpha);
  }
  return { width, height, data: out };
}
