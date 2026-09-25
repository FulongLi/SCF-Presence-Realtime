import { rasterizeSymbol, rasterizeText } from "./providers/glyphs";
import { reliefImageProvider } from "./providers/terrain";
import { VisualResolver } from "./resolve";
import { openverseProvider } from "./sources/openverse";
import { elevationTilesProvider } from "./sources/terrain";
import { webSearchProvider } from "./sources/webSearch";
import { commonsProvider, wikipediaProvider } from "./sources/wikimedia";
import { decodeImage } from "./transforms/raster";

export { VisualResolver, resolverDefaults, type ResolverDeps } from "./resolve";
export { createTargetPoints, type TargetPoints } from "./points";
export type * from "./types";

/**
 * The resolver as the browser uses it. Construction is side-effect free (safe during server rendering):
 * providers only touch the network, canvas or `location` when an action is resolved.
 */
export function createBrowserResolver(): VisualResolver {
  const decode = (blob: Blob) => decodeImage(blob, 512);
  const imageProviders = [
    wikipediaProvider(), commonsProvider(), openverseProvider(),
    webSearchProvider(() => typeof location === "undefined" ? undefined : location.origin),
  ];
  return new VisualResolver({
    imageProviders,
    terrainProviders: [
      elevationTilesProvider(blob => decodeImage(blob, 256, true)),
      reliefImageProvider({ providers: imageProviders, decode }),
    ],
    decodeImage: decode,
    glyphs: { text: rasterizeText, symbol: rasterizeSymbol },
  });
}
