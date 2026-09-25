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
 */
export interface Raster2DTarget {
  kind: "raster2d";
  raster: Raster;
  style: "portrait" | "object" | "glyph" | "logo";
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
 * Reserved extension point for true 3D (point clouds, mesh surface samples, volumes). It cannot be
 * constructed today (`reserved: never`), so nothing produces it and the sampler rejects it; adding a
 * real 3D kind means one new member here, one sampler branch and one provider.
 */
export interface Future3DTargetPlaceholder {
  kind: "future-3d";
  reserved: never;
}

export type VisualTarget = Raster2DTarget | HeightFieldTarget | Future3DTargetPlaceholder;

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
  /** The raster sampling style (portrait, object, glyph, logo). */
  targetStyle?: Raster2DTarget["style"];
  raster?: { width: number; height: number };
  field?: { width: number; height: number; min: number; max: number; elevation?: { min: number; max: number } };
  fetchMs: number;
  resolveMs?: number;
}

/** A failure with a stable, model-safe code (e.g. "image-not-found"). */
export class ResolveError extends Error {
  constructor(code: string) { super(code); this.name = "ResolveError"; }
}
