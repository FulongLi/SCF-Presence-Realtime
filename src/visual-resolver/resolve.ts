import type { InformationAction } from "../visual-actions/controller";
import { HOLD_SECONDS, type ImageIntent, type MorphTarget, type SymbolName } from "../visual-actions/types";
import { allowedImageURL } from "../visual-actions/validate";
import { fetchImage, HOSTS, timeoutSignal, type Fetcher } from "./net";
import { createTargetPoints } from "./points";
import { resolveImage, type ImagePipeline } from "./providers/images";
import { clockText } from "./providers/glyphs";
import { resolveTerrain } from "./providers/terrain";
import type { LocalAssetMatch, LocalAssetProvider } from "./sources/localAssets";
import { normalizeImage } from "./transforms/crop";
import { brightnessSource, buildHeightField, downsampleGrid, heightFieldLimits, heightRange } from "./transforms/heightfield";
import {
  ResolveError, type ImageProvider, type Raster, type ResolveTrace, type TerrainProvider, type VisualTarget,
} from "./types";

export interface ResolverDeps {
  /** Curated first-party assets, consulted before any image provider. */
  localAssets?: LocalAssetProvider;
  imageProviders: readonly ImageProvider[];
  terrainProviders: readonly TerrainProvider[];
  /** Decodes a downloaded or local image into a raster (browser: canvas). */
  decodeImage: (blob: Blob) => Promise<Raster>;
  glyphs: { text: (value: string) => Raster; symbol: (name: SymbolName) => Raster };
  request?: Fetcher;
  now?: () => Date;
  /** Upper bound for one resolution, whatever the provider chain does. */
  deadlineMs?: number;
}

export const resolverDefaults = { deadlineMs: 20_000 };

/** The failure family of an action: what the model hears when nothing could be shown. */
const family = (action: InformationAction) =>
  action.type === "portrait" ? "portrait" : action.type === "terrain" ? "terrain" : action.type === "image" ? "image" : "visual";

/**
 * The unified Visual Resolver:
 *
 *   validated VisualAction ─► provider selection ─► retrieve / construct ─► normalize ─► VisualTarget
 *
 * Glyph actions (clock, number, text, symbol) are constructed on a canvas; images first check the
 * curated local assets, then (portraits too) walk the image provider chain; terrain walks the terrain
 * provider chain. Every result is checked by the
 * particle sampler before it is handed on, so an unusable target never reaches the render loop.
 */
export class VisualResolver {
  /** What happened for the most recent action (for ?debug=1). */
  lastTrace: ResolveTrace | null = null;
  private readonly images: ImagePipeline;
  constructor(private readonly deps: ResolverDeps) {
    this.images = { providers: deps.imageProviders, decode: deps.decodeImage, request: deps.request };
  }

  resolve = async (action: InformationAction, signal: AbortSignal): Promise<MorphTarget> => {
    const started = Date.now();
    const trace: ResolveTrace = {
      action: action.type, status: "resolving", chain: [], fetchMs: 0,
      query: action.type === "image" ? action.query : action.type === "terrain" ? action.region : action.type === "portrait" ? action.person ?? action.imageUrl : undefined,
      intent: action.type === "image" ? action.intent ?? "general" : action.type === "terrain" ? action.style ?? "terrain" : undefined,
    };
    this.lastTrace = trace;
    const timeout = timeoutSignal(this.deps.deadlineMs ?? resolverDefaults.deadlineMs);
    const deadline = timeout.signal;
    const bounded = AbortSignal.any([signal, deadline]);
    try {
      const { visual, label } = await this.construct(action, bounded, trace);
      createTargetPoints(visual, 1); // Reject unusable targets before they reach the render loop.
      describe(trace, visual);
      trace.status = "resolved";
      return { visual, label, hold: HOLD_SECONDS[action.type] };
    } catch (error) {
      if (signal.aborted) { trace.status = "cancelled"; throw error; }
      const failure = deadline.aborted ? `${family(action)}-unavailable`
        : error instanceof ResolveError && /^(portrait|image|terrain|region)-(not-found|unavailable)$/.test(error.message) ? error.message
          : `${family(action)}-unavailable`;
      trace.status = "failed";
      trace.error = error instanceof Error && error.message !== failure ? `${failure} (${error.message.slice(0, 40)})` : failure;
      throw new ResolveError(failure);
    } finally {
      timeout.clear();
      trace.resolveMs = Date.now() - started;
    }
  };

  /** A local file (debug panel) as a photo, an object or a grayscale heightmap. Never leaves the device. */
  async local(file: Blob, label: string, as: "portrait" | "object" | "heightmap"): Promise<MorphTarget> {
    const raster = await this.deps.decodeImage(file);
    let visual: VisualTarget;
    if (as === "heightmap") {
      const source = brightnessSource(raster, label, "local file");
      visual = { kind: "heightfield", style: "heightmap", field: buildHeightField({ ...source, ...downsampleGrid(source.values, source.width, source.height, heightFieldLimits.maxSide) }, "heightmap") };
    } else {
      visual = normalizeImage(raster, as === "portrait" ? "portrait" : "object");
    }
    createTargetPoints(visual, 1);
    return { visual, label, hold: as === "heightmap" ? HOLD_SECONDS.terrain : HOLD_SECONDS.image };
  }

  private async construct(action: InformationAction, signal: AbortSignal, trace: ResolveTrace): Promise<{ visual: VisualTarget; label: string }> {
    const glyph = (raster: Raster, label: string) => {
      trace.provider = "canvas"; trace.sourceType = "constructed glyph";
      return { visual: { kind: "raster2d", style: "glyph", raster } as VisualTarget, label };
    };
    switch (action.type) {
      case "clock": { const label = clockText(action, this.deps.now?.()); return glyph(this.deps.glyphs.text(label), label); }
      case "number":
      case "text": return glyph(this.deps.glyphs.text(action.value), action.value);
      case "symbol": return glyph(this.deps.glyphs.symbol(action.value), action.value);
      case "portrait": {
        if (action.imageUrl) {
          const started = Date.now();
          const { blob } = await fetchImage(allowedImageURL(action.imageUrl), { hosts: HOSTS.wikimediaImages, signal, request: this.deps.request });
          trace.fetchMs += Date.now() - started;
          trace.chain.push({ provider: "wikimedia-url", outcome: "selected", ms: Date.now() - started });
          trace.provider = "wikimedia-url"; trace.source = new URL(action.imageUrl).hostname; trace.sourceType = "photo";
          return { visual: normalizeImage(await this.deps.decodeImage(blob), "portrait"), label: action.person ?? "" };
        }
        return this.image(action.person!, "portrait", signal, trace, "portrait");
      }
      case "image": return this.image(action.query, action.intent ?? "general", signal, trace, "image");
      case "terrain": {
        const { target, source } = await resolveTerrain(action.region, action.style ?? "terrain", this.deps.terrainProviders, signal, trace);
        trace.provider = source.provider;
        trace.sourceType = source.kind === "elevation" ? "elevation (metres)" : "brightness (approximate)";
        trace.source = source.label;
        return { visual: target, label: source.label };
      }
    }
  }

  private async image(query: string, intent: ImageIntent, signal: AbortSignal, trace: ResolveTrace, kind: "image" | "portrait") {
    const local = kind === "image" ? this.deps.localAssets?.match(query) : null;
    if (local) return this.localAsset(local, intent, signal, trace);
    const { target, candidate } = await resolveImage(query, intent, this.images, signal, trace, kind);
    trace.provider = candidate.provider;
    trace.source = candidate.pageUrl ?? candidate.url;
    trace.sourceType = `${intent === "portrait" || intent === "celebrity" ? "portrait" : "image"} · ${candidate.mime ?? "image"}${candidate.license ? ` · ${candidate.license}` : ""}`;
    return { visual: target as VisualTarget, label: candidate.title || query };
  }

  /**
   * A query that names a curated asset is answered from the repository file or not at all: if the file
   * is missing or unusable the action fails ("image-unavailable") instead of silently showing a web
   * result. For first-party brand assets, the wrong image is worse than none.
   */
  private async localAsset(match: LocalAssetMatch, intent: ImageIntent, signal: AbortSignal, trace: ResolveTrace) {
    const provider = this.deps.localAssets!;
    const started = Date.now();
    trace.provider = provider.name;
    trace.source = match.asset.path;
    try {
      const { target, mime } = await provider.load(match.asset, intent, signal);
      trace.fetchMs += Date.now() - started;
      trace.chain.push({ provider: provider.name, outcome: `selected (${match.rule} match: ${match.asset.id})`, ms: Date.now() - started });
      trace.sourceType = `local ${match.asset.type} · ${mime}`;
      return { visual: target as VisualTarget, label: match.asset.brand };
    } catch (error) {
      signal.throwIfAborted();
      const reason = error instanceof Error && /^[a-z0-9][a-z0-9-]{0,39}$/.test(error.message) ? error.message : "error";
      trace.chain.push({ provider: provider.name, outcome: `unavailable (${reason}); no external fallback`, ms: Date.now() - started });
      throw new ResolveError("image-unavailable");
    }
  }
}

function describe(trace: ResolveTrace, visual: VisualTarget) {
  trace.targetType = visual.kind;
  if (visual.kind === "raster2d") { trace.targetStyle = visual.style; trace.raster = { width: visual.raster.width, height: visual.raster.height }; }
  if (visual.kind === "heightfield") {
    const { min, max } = heightRange(visual.field);
    trace.field = { width: visual.field.width, height: visual.field.height, min, max, elevation: visual.field.elevation };
  }
}
