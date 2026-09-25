import { rasterizeEmoji } from "./providers/emoji";
import { rasterizeSymbol, rasterizeText } from "./providers/glyphs";
import { reliefImageProvider } from "./providers/terrain";
import { VisualResolver } from "./resolve";
import { localAssetProvider } from "./sources/localAssets";
import { openverseProvider } from "./sources/openverse";
import { elevationTilesProvider } from "./sources/terrain";
import { webSearchProvider } from "./sources/webSearch";
import { commonsProvider, wikipediaProvider } from "./sources/wikimedia";
import { decodeImage } from "./transforms/raster";
import { rasterizeSvg } from "./transforms/svg";

export { VisualResolver, resolverDefaults, type ResolverDeps } from "./resolve";
export { createTargetPoints, type TargetPoints } from "./points";
export { LOCAL_ASSETS, matchLocalAsset, type LocalAsset } from "./sources/localAssets";
export type * from "./types";

/**
 * The resolver as the browser uses it. Construction is side-effect free (safe during server rendering):
 * providers only touch the network, canvas or `location` when an action is resolved.
 */
export function createBrowserResolver(): VisualResolver {
  const decode = (blob: Blob) => decodeImage(blob, 512);
  const origin = () => typeof location === "undefined" ? undefined : location.origin;
  const imageProviders = [
    wikipediaProvider(), commonsProvider(), openverseProvider(),
    webSearchProvider(origin),
  ];
  return new VisualResolver({
    // Curated first-party assets (e.g. the Spirit Connect logo) come before every external source.
    localAssets: localAssetProvider({ origin, rasterizeSvg, decodeImage: decode }),
    imageProviders,
    terrainProviders: [
      elevationTilesProvider(blob => decodeImage(blob, 256, true)),
      reliefImageProvider({ providers: imageProviders, decode }),
    ],
    decodeImage: decode,
    glyphs: { text: rasterizeText, symbol: rasterizeSymbol, emoji: rasterizeEmoji },
  });
}
