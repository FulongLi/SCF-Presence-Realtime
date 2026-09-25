import type { TerrainStyle } from "../../visual-actions/types";
import { brightnessSource, buildHeightField, downsampleGrid, heightFieldLimits } from "../transforms/heightfield";
import { ResolveError, type HeightFieldTarget, type ResolveTrace, type TerrainProvider, type TerrainSource } from "../types";
import { resolveImage, type ImagePipeline } from "./images";

/**
 * Terrain resolution: region → terrain source → HeightField.
 *
 *   1. aws-terrain-tiles: real elevation in metres for the geocoded region (preferred);
 *   2. relief-image: if elevation tiles are unreachable, a relief/elevation map image from the image
 *      providers, with brightness as height. Approximate by nature, and labelled so in the trace.
 *
 * A region no geocoder knows fails fast with "region-not-found".
 */
export function reliefImageProvider(images: ImagePipeline): TerrainProvider {
  return {
    name: "relief-image",
    async resolve(region, _style, signal) {
      const trace: ResolveTrace = { action: "relief", status: "resolving", chain: [], fetchMs: 0 };
      const { target } = await resolveImage(`${region} relief`, "map", images, signal, trace);
      const source = brightnessSource(target.raster, region, "relief-image (brightness)");
      const grid = downsampleGrid(source.values, source.width, source.height, heightFieldLimits.maxSide);
      return { ...source, ...grid };
    },
  };
}

const code = (error: unknown) => error instanceof Error && /^[a-z0-9][a-z0-9-]{0,39}$/.test(error.message) ? error.message : "error";

export async function resolveTerrain(region: string, style: TerrainStyle, providers: readonly TerrainProvider[], signal: AbortSignal,
  trace: ResolveTrace): Promise<{ target: HeightFieldTarget; source: TerrainSource }> {
  for (const provider of providers) {
    const started = Date.now();
    try {
      const source = await provider.resolve(region, style, signal);
      trace.fetchMs += Date.now() - started;
      const field = buildHeightField(source, style);
      trace.chain.push({ provider: provider.name, outcome: "selected", ms: Date.now() - started });
      return { target: { kind: "heightfield", field, style }, source };
    } catch (error) {
      signal.throwIfAborted();
      const outcome = code(error);
      trace.chain.push({ provider: provider.name, outcome, ms: Date.now() - started });
      if (outcome === "region-not-found") throw new ResolveError("region-not-found");
    }
  }
  throw new ResolveError("terrain-unavailable");
}
