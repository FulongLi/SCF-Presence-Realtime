import type { InformationAction, TargetResolver } from "../visual-actions/controller";
import type { MorphTarget, VisualAction } from "../visual-actions/types";
import { toolCallToVisualAction } from "../voice/tools/executor";
import { isVisualToolName } from "../voice/tools/definitions";
import type { ResolveTrace } from "../visual-resolver/types";
import { ResolveError } from "../visual-resolver/types";
import { ASSISTANT_AUDIO_SENSITIVITY } from "../audio/assistant";
import { PromoError } from "./director";
import { frameTarget } from "./framing";
import { DIALOGUE, LINE_IDS, VISUAL_SOURCES, type LineId, type VisualId } from "./script";
import type { Timeline, VisualCue } from "./timeline";
import { analyzeVoice, type VoiceEnvelope } from "./voiceAnalysis";

/**
 * Promo preload: before the film may start, every scene's visual is resolved by the product's real Visual
 * Resolver (Wikipedia for Tesla, geocoding and elevation tiles for the United Kingdom, the system emoji
 * font, the clock glyphs, the curated local Spirit Connect SVG) and kept in memory. Playback then goes
 * through the real ToolExecutor and VisualActionController, whose resolver is this cache: the film can
 * never wait on the network, and can never show a substitute.
 */
export type SceneTargets = ReadonlyMap<string, MorphTarget>;

/** The cache key of a validated action (validation normalizes it, so equal requests share a key). */
export const actionKey = (action: VisualAction) => JSON.stringify(action);

/** The Visual Action a scene's tool call becomes, through the product's own mapping and validation. */
export function sceneAction(visual: Pick<VisualCue, "id" | "tool" | "args">): InformationAction {
  const action = isVisualToolName(visual.tool) ? toolCallToVisualAction(visual.tool, { ...visual.args }) : null;
  if (!action || action.type === "sphere") throw new PromoError("script-invalid", `${visual.id}: ${visual.tool} ${JSON.stringify(visual.args)}`);
  return action;
}

/** The controller's resolver during the film: prepared targets only. */
export function cachedResolver(targets: SceneTargets): TargetResolver {
  return action => {
    const target = targets.get(actionKey(action));
    return target ? Promise.resolve(target) : Promise.reject(new ResolveError("promo-target-missing"));
  };
}

export interface ResolverInstance { resolve: TargetResolver; readonly lastTrace: ResolveTrace | null }
export interface ResolvedVisual { id: VisualId; label: string; provider: string; source: string; kind: string; ms: number; attempts: number }

export const preloadDefaults = { attempts: 3, backoffMs: [700, 1800] };

/**
 * Resolves every scene visual (each with its own resolver instance, so traces stay separate), checks where
 * each came from, and stores film-ready targets: framed for the film (framing.ts), held until the director
 * releases them, with the scene's own morph durations.
 */
export async function resolveSceneTargets(timeline: Timeline, createResolver: () => ResolverInstance, options: {
  signal?: AbortSignal; attempts?: number; backoffMs?: readonly number[]; wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onResolved?: (visual: ResolvedVisual) => void;
} = {}): Promise<{ targets: Map<string, MorphTarget>; visuals: ResolvedVisual[] }> {
  const attempts = options.attempts ?? preloadDefaults.attempts;
  const backoff = options.backoffMs ?? preloadDefaults.backoffMs;
  const wait = options.wait ?? delay;
  const signal = options.signal ?? new AbortController().signal;
  const targets = new Map<string, MorphTarget>();
  const keys = new Set<string>();
  const jobs = timeline.visuals.map(async visual => {
    const action = sceneAction(visual);
    const key = actionKey(action);
    if (keys.has(key)) throw new PromoError("script-invalid", `${visual.id}: the same visual appears twice`);
    keys.add(key);
    const started = Date.now();
    let failure = "unresolved";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      signal.throwIfAborted();
      const resolver = createResolver();
      try {
        const target = await resolver.resolve(action, signal);
        const trace = resolver.lastTrace;
        checkSource(visual.id, trace);
        targets.set(key, {
          ...frameTarget(visual.id, target),
          // The director releases every expression explicitly; the hold only guards against a lost cue.
          hold: visual.release - visual.formed + 1,
          transition: { form: visual.form, return: visual.return },
        });
        const resolved: ResolvedVisual = {
          id: visual.id, label: target.label, provider: trace?.provider ?? "unknown", source: trace?.source ?? "",
          kind: `${target.visual.kind}${target.visual.kind === "raster2d" ? `/${target.visual.style}` : ""}`, ms: Date.now() - started, attempts: attempt,
        };
        options.onResolved?.(resolved);
        return resolved;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof PromoError && error.code === "wrong-source") throw error;
        failure = resolver.lastTrace?.error ?? (error instanceof Error ? error.message : "unresolved");
        if (attempt < attempts) await wait(backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 1000, signal);
      }
    }
    throw new PromoError("target-unavailable", `${visual.id}: ${failure}`);
  });
  const visuals = await Promise.all(jobs);
  return { targets, visuals };
}

/** A film that silently showed a web logo or an approximate relief would misrepresent the product. */
function checkSource(id: VisualId, trace: ResolveTrace | null) {
  const expected = VISUAL_SOURCES[id];
  if (!expected) return;
  const provider = trace?.provider ?? "";
  if (!expected.provider.test(provider) || (expected.source !== undefined && trace?.source !== expected.source)) {
    throw new PromoError("wrong-source", `${id}: resolved by ${provider || "unknown"} ${trace?.source ?? ""}`.trim());
  }
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/** Prepared dialogue: decoded lines for the mix, and their envelopes for the body. */
export interface DialogueAssets {
  buffers: Map<LineId, AudioBuffer>;
  envelopes: Map<LineId, VoiceEnvelope>;
  durations: Partial<Record<LineId, number>>;
  /** Lines with no usable recording (not prepared, or recorded for different words). */
  missing: LineId[];
}

export interface DialogueManifest {
  version: 1;
  lines: Partial<Record<LineId, { file: string; speech: string; voice: string; duration: number; hash: string }>>;
}

export const DIALOGUE_BASE = "/promo/audio";

/**
 * Browser: loads the prepared dialogue (public/promo/audio, see `npm run promo:prepare`). A line whose
 * recording is missing, or says different words than the script, is reported missing — never replaced.
 */
export async function loadDialogue(sampleRate: number, signal?: AbortSignal, base = DIALOGUE_BASE): Promise<DialogueAssets> {
  const assets: DialogueAssets = { buffers: new Map(), envelopes: new Map(), durations: {}, missing: [] };
  let manifest: DialogueManifest | null = null;
  try {
    const response = await fetch(`${base}/manifest.json`, { signal, cache: "no-cache" });
    if (response.ok) manifest = await response.json() as DialogueManifest;
  } catch (error) { signal?.throwIfAborted(); void error; }
  const decoder = new OfflineAudioContext(1, 1, sampleRate);
  await Promise.all(LINE_IDS.map(async id => {
    const entry = manifest?.lines?.[id];
    if (!entry || entry.speech !== DIALOGUE[id].speech || !/^[a-z.]+\.wav$/.test(entry.file)) { assets.missing.push(id); return; }
    try {
      const response = await fetch(`${base}/${entry.file}`, { signal });
      if (!response.ok) throw new Error("missing");
      const buffer = await decoder.decodeAudioData(await response.arrayBuffer());
      assets.buffers.set(id, buffer);
      assets.durations[id] = buffer.duration;
      const sensitivity = DIALOGUE[id].speaker === "assistant" ? ASSISTANT_AUDIO_SENSITIVITY : 1;
      assets.envelopes.set(id, analyzeVoice(buffer.getChannelData(0), buffer.sampleRate, { sensitivity }));
    } catch (error) {
      signal?.throwIfAborted();
      void error;
      assets.missing.push(id);
    }
  }));
  assets.missing.sort((a, b) => LINE_IDS.indexOf(a) - LINE_IDS.indexOf(b));
  return assets;
}
