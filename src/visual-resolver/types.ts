import type { ImageIntent, TerrainStyle } from "../visual-actions/types";

/**
 * The Visual Resolver's vocabulary. The particle body only ever sees a VisualTarget; where it came
 * from (a curated local asset, Wikimedia, Openverse, a web search, elevation tiles, a canvas glyph)
 * stays in the resolver.
 */

/** An RGBA image, row-major, 4 bytes per pixel. */
export interface Raster { width: number; height: number; data: Uint8ClampedArray }

/**
 * A flat picture sampled into particle rest positions.
 * - portrait: luminance-weighted density with a vignette and shallow relief (faces, people).
 * - object: density follows what differs from the image's background (vehicles, products, maps).
 * - glyph: alpha-weighted crisp shapes with even light (text, numbers, clocks, symbols).
 * - logo: a brand mark on transparency: alpha-shaped silhouette, strong edges (including colour
 *   boundaries inside the mark), even density and no photographic vignette.
 * - emoji: one system-font emoji on transparency, only a source shape: density follows alpha, with
 *   extra weight on the silhouette and on colour/luminance boundaries inside it (eyes, mouth), a thin
 *   slab and tones from the emoji's own luminance range. Still SCF particles, never a flat sticker.
 * - ink: a procedural monochrome form (a visual form such as the yin-yang): alpha is density, read as a
 *   continuous amount rather than a mask, so a pale wash becomes sparse particles and a full stroke
 *   dense ones; RGB is tone. Edges are weighted, the slab is thin and calm.
 */
export interface Raster2DTarget {
  kind: "raster2d";
  raster: Raster;
  style: "portrait" | "object" | "glyph" | "logo" | "emoji" | "ink";
}

/** A grid of normalized heights (0 = lowest shown, 1 = highest), row 0 is the far (north) edge. */
export interface HeightField {
  width: number;
  height: number;
  values: Float32Array;
  /** 1 where the surface exists (e.g. land inside the region), 0 elsewhere. Omitted: everywhere. */
  mask?: Uint8Array;
  /** Ground width / ground height of the grid (the map's aspect, not the grid's). */
  aspect: number;
  /** Visual relief, 0..1: how tall the tallest point stands relative to the layout. */
  relief: number;
  /** Real elevation range in metres when the source had it, for diagnostics. */
  elevation?: { min: number; max: number };
}

/** 2.5D: X/Y keep the source layout, Z rises with height. */
export interface HeightFieldTarget {
  kind: "heightfield";
  field: HeightField;
  style: TerrainStyle;
}

/**
 * A procedural arrangement of weighted points and strokes, sampled into particles directly with no raster
 * in between: star maps and star-drawn glyphs today; graphs, molecules, lattices or plots later.
 * Coordinates are normalized (x right, y up) and lie within [-1, 1] on both axes.
 */
export interface PointLayout {
  /** Particles gather around each point in proportion to `weight`, spread over `radius`, lit by `tone` (0..1). */
  points: { x: number; y: number; weight: number; radius: number; tone: number }[];
  /** Particles are strewn along each polyline (flat [x0, y0, x1, y1, …]) in proportion to `weight` × length. */
  strokes: { points: number[]; width: number; weight: number; tone: number }[];
  /** Fraction (0..0.8) of the body spread thinly and dimly over the frame, as a quiet background. */
  dust: number;
}

/**
 * - celestial: sparse and deep. Points are luminous cores that fade outward, each at its own depth; strokes
 *   are fine lines; the dust is a field of faint, distant grains.
 */
export interface PointLayoutTarget {
  kind: "points";
  layout: PointLayout;
  style: "celestial";
}

/**
 * Reserved extension point for true 3D (point clouds, mesh surface samples, volumes). It cannot be
 * constructed today (`reserved: never`), so nothing produces it and the sampler rejects it; adding a
 * real 3D kind means one new member here, one sampler branch and one provider.
 */
export interface Future3DTargetPlaceholder {
  kind: "future-3d";
  reserved: never;
}

export type VisualTarget = Raster2DTarget | HeightFieldTarget | PointLayoutTarget | Future3DTargetPlaceholder;

/** One image a provider found. `load` lets a provider hand over bytes directly (e.g. a server route). */
export interface ImageCandidate {
  provider: string;
  url: string;
  title: string;
  width?: number;
  height?: number;
  mime?: string;
  /** Provider-side relevance 0..1 (title/tag overlap with the query, search rank). */
  relevance: number;
  pageUrl?: string;
  license?: string;
  load?: (signal: AbortSignal) => Promise<Blob>;
}

export interface ImageProvider {
  readonly name: string;
  search(query: string, intent: ImageIntent, signal: AbortSignal): Promise<ImageCandidate[]>;
}

/** Terrain as real elevations (metres) on a grid, plus an optional region mask. */
export interface TerrainSource {
  provider: string;
  kind: "elevation" | "brightness";
  width: number;
  height: number;
  /** Metres for "elevation"; 0..1 for "brightness". NaN = no data. */
  values: Float32Array;
  mask?: Uint8Array;
  aspect: number;
  label: string;
}

export interface TerrainProvider {
  readonly name: string;
  resolve(region: string, style: TerrainStyle, signal: AbortSignal): Promise<TerrainSource>;
}

/** What the resolver did for the last action. Shown in ?debug=1; never contains credentials. */
export interface ResolveTrace {
  action: string;
  query?: string;
  intent?: string;
  status: "resolving" | "resolved" | "failed" | "cancelled";
  error?: string;
  /** Every provider consulted, in order, with what it returned. */
  chain: { provider: string; outcome: string; ms: number }[];
  provider?: string;
  source?: string;
  sourceType?: string;
  targetType?: VisualTarget["kind"];
  /** The sampling style (raster: portrait, object, glyph, logo, emoji, ink; point layout: celestial). */
  targetStyle?: Raster2DTarget["style"] | PointLayoutTarget["style"];
  raster?: { width: number; height: number };
  layout?: { points: number; strokes: number };
  field?: { width: number; height: number; min: number; max: number; elevation?: { min: number; max: number } };
  fetchMs: number;
  resolveMs?: number;
}

/** A failure with a stable, model-safe code (e.g. "image-not-found"). */
export class ResolveError extends Error {
  constructor(code: string) { super(code); this.name = "ResolveError"; }
}
