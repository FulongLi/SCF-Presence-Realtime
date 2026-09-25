import type { MicFrame } from "../audio/microphone/MicrophoneListener";
import type { StagePose } from "../particle/ParticleRuntime";
import type { ConversationHints, ConversationSource, MicInput } from "../presence/PresenceEngine";
import type { ToolRunner } from "../voice/tools/executor";
import { cameraPose } from "./camera";
import type { LineId, Speaker, TitleId } from "./script";
import { subtitleAt, type Timeline } from "./timeline";
import { clamp01, easeOut, smootherstep, spanOpacity } from "./transitions";
import { envelopeAt, type VoiceEnvelope } from "./voiceAnalysis";

/** The part of the product's PresenceEngine the director performs through. */
export interface DirectorBody {
  setConversation(source: ConversationSource | null): void;
  setMicrophone(input: MicInput | null): void;
  assistantAudio(amplitude: number, bands: ArrayLike<number>, now: number): void;
  triggerFocus(strength: number, now: number): boolean;
}

/** Everything that is not particles, for one frame: camera, formation clock, words and black. */
export interface FilmLook {
  t: number;
  formation: number;
  camera: StagePose;
  /** Per title: opacity, and reveal (0 → 1 while it first fades in; it stays 1 as it leaves). */
  titles: Record<TitleId, { opacity: number; reveal: number }>;
  subtitle: { text: string; speaker: Speaker; opacity: number } | null;
  blackout: number;
}

export class PromoError extends Error {
  constructor(readonly code: string, readonly detail = "") { super(code); this.name = "PromoError"; }
}

interface Cue { at: number; label: string; run: () => Promise<void> | void }
export interface CueRecord { at: number; label: string; outcome: string }

/**
 * The deterministic Promo Director. It owns nothing visual itself; it performs the film through the
 * product's own systems:
 *
 *   master timeline ─► real tool calls ─► ToolExecutor ─► VisualActionController ─► particle morph
 *                   ─► conversation hints and voice envelopes ─► PresenceEngine ─► listening / thinking / speaking
 *                   ─► FilmLook (camera, formation clock, titles, subtitles, blackout)
 *
 * `update(t)` fires every cue with a time in (previous t, t], exactly once and in order; time only moves
 * forward. It is a ConversationSource and MicInput for the engine, so the body's states come from the
 * same logic that serves live conversations.
 */
export class PromoDirector implements ConversationSource, MicInput {
  time = 0;
  failure: PromoError | null = null;
  readonly record: CueRecord[] = [];
  private readonly cues: Cue[] = [];
  private next = 0;
  private stopped = false;
  private started = false;
  private readonly silent = new Float32Array(16);
  private readonly mic: MicFrame = { voiced: false, level: 0, utterance: 0, emphasis: 0 };

  constructor(readonly timeline: Timeline, private readonly deps: {
    runner: ToolRunner;
    body: DirectorBody;
    /** Voice envelopes of the recorded lines (missing lines are silent). */
    voices: ReadonlyMap<LineId, VoiceEnvelope>;
    onFailure?: (error: PromoError) => void;
  }) {
    for (const visual of timeline.visuals) {
      this.cues.push({ at: visual.start, label: `${visual.tool} ${visual.id}`, run: () => this.call(visual.tool, visual.args, visual.id) });
      this.cues.push({ at: visual.release, label: `return_to_sphere ${visual.id}`, run: () => this.call("return_to_sphere", {}, visual.id) });
    }
    for (const pulse of timeline.pulses) {
      this.cues.push({ at: pulse.at, label: "pulse", run: () => { deps.body.triggerFocus(pulse.strength, pulse.at); } });
    }
    this.cues.sort((a, b) => a.at - b.at);
    deps.body.setConversation(this);
    deps.body.setMicrophone(this);
  }

  get ended() { return this.time >= this.timeline.duration; }
  get pending() { return this.cues.length - this.next; }

  /** Advances the film to time t (seconds), firing due cues. Resolves when their tool calls have settled. */
  async update(t: number): Promise<void> {
    if (this.stopped || !Number.isFinite(t)) return;
    if (this.started && t < this.time) return;
    this.started = true;
    this.time = Math.max(0, t);
    const due: (Promise<void> | void)[] = [];
    while (this.next < this.cues.length && this.cues[this.next].at <= this.time) {
      const cue = this.cues[this.next++];
      due.push(cue.run());
    }
    // The assistant's recorded voice drives speaking exactly as the live remote track would.
    const voice = this.voiceAt("assistant", this.time, 0.35);
    this.deps.body.assistantAudio(voice.amplitude, voice.bands, this.time);
    await Promise.all(due);
  }

  /** Conversation hints for the engine; `now` is film time (the runtime is driven with it). */
  hints(now: number): ConversationHints {
    const t = now;
    const userSpeaking = this.timeline.lines.some(line => line.speaker === "user" && t >= line.start && t < line.end);
    const awaitingResponse = this.timeline.thinking.some(span => t >= span.start && t < span.end);
    const toolActive = this.timeline.visuals.some(visual => t >= visual.start && t < visual.start + 0.12);
    return { live: true, userSpeaking, awaitingResponse, toolActive };
  }

  /** The user's recorded voice as the listening body's microphone. */
  read(): MicFrame {
    const line = this.timeline.lines.find(l => l.speaker === "user" && this.time >= l.start && this.time < l.end);
    const m = this.mic;
    m.emphasis = 0;
    if (!line) { m.voiced = false; m.level = 0; return m; }
    const envelope = this.deps.voices.get(line.id);
    m.voiced = true;
    m.utterance = this.time - line.start;
    m.level = envelope ? envelopeAt(envelope, this.time - line.start).amplitude : 0.3;
    return m;
  }

  look(t: number): FilmLook { return filmLook(this.timeline, t); }

  /** Ends this performance (pause-to-exit, replay): no further cues, and the engine is released. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.deps.body.setConversation(null);
    this.deps.body.setMicrophone(null);
  }

  private voiceAt(speaker: Speaker, t: number, tail: number) {
    for (const line of this.timeline.lines) {
      if (line.speaker !== speaker || t < line.start || t >= line.end + tail) continue;
      const envelope = this.deps.voices.get(line.id);
      if (envelope) return envelopeAt(envelope, t - line.start);
    }
    return { amplitude: 0, bands: this.silent };
  }

  private async call(name: string, args: Readonly<Record<string, string>>, id: string) {
    const execution = await this.deps.runner.execute(name, JSON.stringify(args));
    this.record.push({ at: this.time, label: `${name} ${id}`, outcome: execution.result.status });
    if (this.stopped || execution.result.ok) return;
    // Never substitute another visual: a scene that cannot be shown stops the film, loudly.
    this.failure ??= new PromoError("visual-failed", `${name} (${id}): ${execution.result.status}`);
    this.deps.onFailure?.(this.failure);
  }
}

/** The look of the frame at film time t. Pure: it depends only on the timeline. */
export function filmLook(timeline: Timeline, t: number): FilmLook {
  const titles = {} as FilmLook["titles"];
  for (const title of timeline.titles) titles[title.id] = { opacity: spanOpacity(title, t), reveal: easeOut((t - title.start) / title.fadeIn) };
  const subtitle = subtitleAt(timeline, t);
  return {
    t,
    formation: Math.max(0, t - timeline.birth.start),
    camera: cameraPose(timeline.camera.initial, timeline.camera.moves, t),
    titles,
    subtitle: subtitle ? { text: subtitle.line.text, speaker: subtitle.line.speaker, opacity: subtitle.opacity } : null,
    blackout: smootherstep(clamp01((t - timeline.blackout.start) / timeline.blackout.duration)),
  };
}
