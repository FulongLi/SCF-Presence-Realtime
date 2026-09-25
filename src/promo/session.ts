import type { MorphSource } from "../particle/ParticleRuntime";
import { PresenceEngine } from "../presence/PresenceEngine";
import type { PresenceSignalSource } from "../presence/signal";
import { VisualActionController } from "../visual-actions/controller";
import { ToolExecutor } from "../voice/tools/executor";
import { PromoDirector, type PromoError } from "./director";
import { cachedResolver, type SceneTargets } from "./preload";
import type { LineId } from "./script";
import type { Timeline } from "./timeline";
import type { VoiceEnvelope } from "./voiceAnalysis";

/** The fixed moment the film's clock belongs to (the clock scene shows 18:42 whatever the real time). */
export const FILM_MOMENT = { hours: 18, minutes: 42 };

/**
 * One performance of the film: a fresh PresenceEngine, VisualActionController and ToolExecutor — the
 * product's own classes — driven by a PromoDirector. Replay builds a new performance on the same prepared
 * targets and voices, so nothing from the previous run leaks into the next.
 */
export function createPerformance(timeline: Timeline, targets: SceneTargets, voices: ReadonlyMap<LineId, VoiceEnvelope>,
  onFailure?: (error: PromoError) => void) {
  const engine = new PresenceEngine();
  const visual = new VisualActionController(cachedResolver(targets), (error, action) => {
    if (process.env.NODE_ENV === "development") console.error("[SCF promo] a prepared visual was not available", action, error);
  });
  const executor = new ToolExecutor(visual, {
    budgetMs: 1500,
    now: () => { const date = new Date(2026, 0, 1, FILM_MOMENT.hours, FILM_MOMENT.minutes); return date; },
    timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const director = new PromoDirector(timeline, { runner: executor, body: engine, voices, onFailure });
  return {
    engine, visual, executor, director,
    dispose() { director.stop(); visual.cancel(); },
  };
}
export type Performance = ReturnType<typeof createPerformance>;

/**
 * The runtime's inputs, bound to whichever performance is current. Revisions stay monotonic across
 * performances so the runtime always uploads the new performance's first target.
 */
export function performanceInputs(current: () => Performance | null): { presence: PresenceSignalSource; morph: MorphSource } {
  let generation = 0, owner: Performance | null = null;
  return {
    presence: { sample: (dt, now) => (current()?.engine ?? idle).sample(dt, now) },
    morph: {
      sample: dt => current()?.visual.sample(dt) ?? 0,
      get revision() {
        const performance = current();
        if (performance !== owner) { owner = performance; generation++; }
        return generation * 1_000_000 + (performance?.visual.revision ?? 0);
      },
      get target() { return current()?.visual.target ?? null; },
    },
  };
}
const idle = new PresenceEngine();
