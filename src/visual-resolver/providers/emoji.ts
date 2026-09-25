import { trimTransparent } from "../transforms/crop";
import { canvas, readCanvas } from "../transforms/raster";
import { ResolveError, type Raster } from "../types";

/**
 * Constructed emoji: one emoji drawn with the operating system's own colour emoji font onto a
 * transparent canvas (browser only), then sampled into particle positions. No network, no image search,
 * no bundled font or emoji images: Apple Color Emoji on macOS/iOS, Segoe UI Emoji on Windows, Noto
 * Color Emoji on Android, ChromeOS and most Linux desktops. The canvas is never inserted in the page.
 */
export const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
export const emojiLimits = {
  /** Side of the square source canvas. */
  side: 256,
  /** Font size; leaves room for glyphs that overhang their em box. */
  size: 180,
  /** Emoji rasters kept in memory, most recently used last. */
  cache: 48,
};

/**
 * Draws one emoji centred on a transparent square canvas, measured by its actual ink bounds so tall,
 * wide or ZWJ glyphs are neither clipped nor off-centre, and shrunk to fit if they would overflow.
 */
export function renderEmoji(emoji: string): Raster {
  const { side } = emojiLimits;
  const context = canvas(side, side);
  let size = emojiLimits.size;
  const measure = () => {
    context.font = `${size}px ${EMOJI_FONT}`;
    const m = context.measureText(emoji);
    const left = m.actualBoundingBoxLeft || m.width / 2, right = m.actualBoundingBoxRight || m.width / 2;
    const ascent = m.actualBoundingBoxAscent || size * 0.8, descent = m.actualBoundingBoxDescent || size * 0.2;
    return { left, right, ascent, descent };
  };
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  let box = measure();
  const extent = Math.max(box.left + box.right, box.ascent + box.descent);
  if (extent > side * 0.9) { size = Math.floor(size * side * 0.9 / extent); box = measure(); }
  // A monochrome fallback font draws in the fill colour; colour emoji fonts ignore it.
  context.fillStyle = "#fff";
  context.fillText(emoji, side / 2 + (box.left - box.right) / 2, side / 2 + (box.ascent - box.descent) / 2);
  return readCanvas(context);
}

/**
 * Crops a rendered emoji to its visible pixels with a small even margin. An emoji that drew nothing
 * (no font on this system has it) fails as "emoji-unavailable" rather than showing an empty target.
 */
export function trimEmoji(raster: Raster): Raster {
  const trimmed = trimTransparent(raster, 8, 0.05);
  if (!trimmed) throw new ResolveError("emoji-unavailable");
  return trimmed;
}

/**
 * A bounded in-memory cache in front of a renderer, keyed by the emoji grapheme (least recently used is
 * dropped first). Cached rasters are shared and must be treated as read-only. Nothing is persisted.
 */
export function createEmojiRasterizer(render: (emoji: string) => Raster = renderEmoji, capacity = emojiLimits.cache) {
  const cache = new Map<string, Raster>();
  const rasterize = (emoji: string): Raster => {
    const hit = cache.get(emoji);
    if (hit) { cache.delete(emoji); cache.set(emoji, hit); return hit; }
    const raster = trimEmoji(render(emoji));
    cache.set(emoji, raster);
    const oldest = cache.keys().next().value;
    if (cache.size > capacity && oldest !== undefined) cache.delete(oldest);
    return raster;
  };
  return Object.assign(rasterize, { cache });
}

/** The browser's emoji rasterizer: system emoji font, cached. */
export const rasterizeEmoji = createEmojiRasterizer();
