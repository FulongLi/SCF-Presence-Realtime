import type { ImageIntent } from "../../visual-actions/types";
import { fetchImage, HOSTS, type Fetcher } from "../net";
import { normalizeImage } from "../transforms/crop";
import { ResolveError, type ImageCandidate, type ImageProvider, type Raster, type Raster2DTarget, type ResolveTrace } from "../types";
import { rankCandidates } from "./rank";

/**
 * Open image retrieval. Any query goes to an ordered chain of providers suited to its intent; the first
 * provider that yields a usable, downloadable, decodable image wins. Nothing here knows a list of
 * supported things: a Model Y, a wind turbine, a concept car or a public figure all take the same path.
 *
 * | intent                       | order                                   |
 * | ---------------------------- | --------------------------------------- |
 * | portrait, celebrity          | wikipedia → web → openverse → commons   |
 * | vehicle, product, object     | wikipedia → commons → web → openverse   |
 * | map                          | commons → wikipedia → openverse         |
 * | reference, general           | openverse → commons → web → wikipedia   |
 *
 * "web" is optional (server-side key) and skipped when not configured.
 */
export const PROVIDER_ORDER: Record<ImageIntent, readonly string[]> = {
  portrait: ["wikipedia", "web", "openverse", "commons"],
  celebrity: ["wikipedia", "web", "openverse", "commons"],
  vehicle: ["wikipedia", "commons", "web", "openverse"],
  product: ["wikipedia", "commons", "web", "openverse"],
  object: ["wikipedia", "commons", "web", "openverse"],
  map: ["commons", "wikipedia", "openverse"],
  reference: ["openverse", "commons", "web", "wikipedia"],
  general: ["openverse", "commons", "web", "wikipedia"],
};

/** Hosts images may be downloaded from (the web provider hands over bytes itself). */
export const IMAGE_HOSTS = [...HOSTS.wikimediaImages, HOSTS.openverse];
/** At most this many candidates are downloaded per provider before moving on. */
export const DOWNLOADS_PER_PROVIDER = 2;

export interface ImagePipeline {
  providers: readonly ImageProvider[];
  decode: (blob: Blob) => Promise<Raster>;
  request?: Fetcher;
}

export interface ResolvedImage { target: Raster2DTarget; candidate: ImageCandidate }

const code = (error: unknown) => error instanceof Error && /^[a-z0-9][a-z0-9-]{0,39}$/.test(error.message) ? error.message : "error";

/**
 * Walks the provider chain for `intent`, recording every step in `trace.chain`. Fails with
 * `${kind}-not-found` when no provider had a usable candidate, or `${kind}-unavailable` when
 * candidates existed or providers failed but nothing could be downloaded and decoded.
 */
export async function resolveImage(query: string, intent: ImageIntent, pipeline: ImagePipeline, signal: AbortSignal,
  trace: ResolveTrace, kind: "image" | "portrait" = "image"): Promise<ResolvedImage> {
  let trouble = false;
  for (const name of PROVIDER_ORDER[intent]) {
    const provider = pipeline.providers.find(p => p.name === name);
    if (!provider) continue;
    const started = Date.now();
    let candidates: ImageCandidate[];
    try {
      candidates = await provider.search(query, intent, signal);
    } catch (error) {
      signal.throwIfAborted();
      const outcome = code(error);
      if (outcome !== "not-configured") trouble = true;
      trace.chain.push({ provider: name, outcome, ms: Date.now() - started });
      continue;
    }
    trace.fetchMs += Date.now() - started;
    const ranked = rankCandidates(candidates, query, intent);
    if (!ranked.length) {
      trace.chain.push({ provider: name, outcome: candidates.length ? `${candidates.length} found, none usable` : "no results", ms: Date.now() - started });
      continue;
    }
    for (const candidate of ranked.slice(0, DOWNLOADS_PER_PROVIDER)) {
      const fetchStarted = Date.now();
      try {
        const blob = candidate.load ? await candidate.load(signal)
          : (await fetchImage(candidate.url, { hosts: IMAGE_HOSTS, signal, request: pipeline.request })).blob;
        trace.fetchMs += Date.now() - fetchStarted;
        const target = normalizeImage(await pipeline.decode(blob), intent);
        trace.chain.push({ provider: name, outcome: `selected (${ranked.length} usable)`, ms: Date.now() - started });
        return { target, candidate };
      } catch (error) {
        signal.throwIfAborted();
        trouble = true;
        trace.chain.push({ provider: name, outcome: `download ${code(error)}`, ms: Date.now() - fetchStarted });
      }
    }
  }
  throw new ResolveError(`${kind}-${trouble ? "unavailable" : "not-found"}`);
}
