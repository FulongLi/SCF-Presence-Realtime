import type { ImageIntent } from "../../visual-actions/types";
import { fetchImage, limits, safeFetch, type Fetcher } from "../net";
import { normalizeImage } from "../transforms/crop";
import { checkSvgText, normalizeLogoRaster, SVG_MIME, svgLimits, svgRasterSize } from "../transforms/svg";
import { ResolveError, type Raster, type Raster2DTarget } from "../types";

/**
 * Curated local visual assets: first-party material (the company logo, later product marks or internal
 * illustrations) that must come from the repository, never from a public image search. Files live under
 * `public/assets/` and are served from the app's own origin.
 *
 * To add one: put the file under public/assets/…, add an entry here with its explicit aliases.
 */
export interface LocalAsset {
  id: string;
  /** The brand or subject, also the label the body shows. */
  brand: string;
  /** "logo" assets are rendered as crisp marks; "image" assets like photos. */
  type: "logo" | "image";
  /** Same-origin path under /assets/ (SVG, PNG, WebP or JPEG). */
  path: string;
  /** Exact phrases (matched after normalization) that mean this asset. */
  aliases: readonly string[];
}

export const LOCAL_ASSETS: readonly LocalAsset[] = [
  {
    id: "spirit-connect-logo",
    brand: "Spirit Connect",
    type: "logo",
    path: "/assets/brand/spirit-connect-logo.svg",
    aliases: [
      "spirit connect", "spiritconnect", "spirit connect logo",
      // A first-party build: "our company" is Spirit Connect. Only these explicit phrases map to it.
      "our company logo", "my company logo", "company logo",
    ],
  },
];

/** Lower case, accents folded, possessives dropped, punctuation to spaces: "Spirit-Connect's Logo!" → "spirit connect logo". */
export function normalizeAssetQuery(query: string): string {
  return query.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/['’]s\b/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/**
 * Words that may accompany a brand's name when asking for its logo ("the Spirit Connect brand mark",
 * "our official Spirit Connect logo"). Anything else ("Spirit Connect headquarters") is not the logo.
 */
const LOGO_WORDS = new Set([
  "logo", "logos", "brand", "mark", "logomark", "wordmark", "icon", "emblem", "symbol", "insignia",
  "company", "corporate", "official", "the", "a", "our", "my",
]);

export interface LocalAssetMatch {
  asset: LocalAsset;
  /** How it matched, for the resolver trace: an exact alias, or the brand name plus logo words. */
  rule: "alias" | "brand";
}

/**
 * Deterministic, auditable matching — no fuzzy scoring:
 * 1. the normalized query equals a normalized alias; or
 * 2. (logos) the query contains the brand name (as words, or as one compact word) and every other word
 *    is a logo word.
 * A generic word alone ("company", "logo") never matches.
 */
export function matchLocalAsset(query: string, assets: readonly LocalAsset[] = LOCAL_ASSETS): LocalAssetMatch | null {
  const normalized = normalizeAssetQuery(query).replace(/^the /, "");
  if (!normalized) return null;
  for (const asset of assets) {
    if (asset.aliases.some(alias => normalizeAssetQuery(alias) === normalized)) return { asset, rule: "alias" };
  }
  const words = normalized.split(" ");
  for (const asset of assets) {
    if (asset.type !== "logo") continue;
    const brand = normalizeAssetQuery(asset.brand).split(" ");
    const compact = brand.join("");
    let rest: string[] | null = null;
    const compactAt = words.indexOf(compact);
    if (compactAt >= 0) rest = words.filter((_, i) => i !== compactAt);
    else {
      for (let i = 0; i + brand.length <= words.length; i++) {
        if (brand.every((word, j) => words[i + j] === word)) { rest = [...words.slice(0, i), ...words.slice(i + brand.length)]; break; }
      }
    }
    if (rest && rest.every(word => LOGO_WORDS.has(word))) return { asset, rule: "brand" };
  }
  return null;
}

/** Only same-origin paths under /assets/ with an image extension; no traversal, no other origin. */
export function isTrustedAssetPath(path: string): boolean {
  return /^\/assets\/[a-z0-9][a-z0-9_\-]*(?:\/[a-z0-9][a-z0-9_\-]*)*\.(?:svg|png|webp|jpe?g)$/i.test(path);
}

export interface LoadedAsset { target: Raster2DTarget; mime: string }

export interface LocalAssetProvider {
  readonly name: "local-assets";
  match(query: string): LocalAssetMatch | null;
  load(asset: LocalAsset, intent: ImageIntent, signal: AbortSignal): Promise<LoadedAsset>;
}

export interface LocalAssetOptions {
  assets?: readonly LocalAsset[];
  /** The page origin (browser: location.origin); assets are only ever read from it. */
  origin: () => string | undefined;
  /** Renders checked SVG text to a raster (browser: canvas). */
  rasterizeSvg: (text: string, size: { width: number; height: number }) => Promise<Raster>;
  /** Decodes PNG/WebP/JPEG assets (browser: canvas). */
  decodeImage: (blob: Blob) => Promise<Raster>;
  request?: Fetcher;
}

/**
 * The local-asset provider. It runs before every external image provider: a query that matches the
 * manifest is answered from the repository file or not at all.
 */
export function localAssetProvider(options: LocalAssetOptions): LocalAssetProvider {
  const assets = options.assets ?? LOCAL_ASSETS;
  return {
    name: "local-assets",
    match: query => matchLocalAsset(query, assets),
    async load(asset, intent, signal) {
      if (!isTrustedAssetPath(asset.path)) throw new ResolveError("asset-path-rejected");
      const base = options.origin();
      if (!base) throw new ResolveError("asset-unavailable");
      if (/\.svg$/i.test(asset.path)) {
        // hosts: [] — only the page's own origin is allowed, so no remote SVG can ever be read here.
        const fetched = await safeFetch(asset.path, { hosts: [], mimes: SVG_MIME, maxBytes: svgLimits.bytes, signal, base, request: options.request });
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(fetched.bytes); } catch { throw new ResolveError("svg-invalid"); }
        checkSvgText(text);
        const raster = await options.rasterizeSvg(text, svgRasterSize(text));
        return { target: asset.type === "logo" ? normalizeLogoRaster(raster) : normalizeImage(raster, intent), mime: "image/svg+xml" };
      }
      const { blob } = await fetchImage(asset.path, { hosts: [], maxBytes: limits.imageBytes, signal, base, request: options.request });
      const raster = await options.decodeImage(blob);
      return { target: asset.type === "logo" ? normalizeLogoRaster(raster) : normalizeImage(raster, intent), mime: blob.type };
    },
  };
}
