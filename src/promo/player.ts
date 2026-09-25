import type { RuntimeHandle } from "../particle/ParticleRuntime";
import { qualityRange, qualityTiers } from "../particle/quality";
import { createBrowserResolver } from "../visual-resolver";
import { MIX, renderSoundtrack, scheduleSoundtrack, soundPlan, type Soundtrack } from "./audio";
import { createBirthPlan } from "./birth";
import { AudioFilmClock, PerformanceFilmClock, type FilmClock } from "./clock";
import { filmLook, PromoError, type FilmLook } from "./director";
import { loadDialogue, resolveSceneTargets, type DialogueAssets, type ResolvedVisual, type SceneTargets } from "./preload";
import type { LineId, TitleId } from "./script";
import { createPerformance, performanceInputs, type Performance } from "./session";
import { compileTimeline, frameCount, timelineProblems, type Timeline } from "./timeline";
import { encodeWav } from "./wav";

export type PlayerState = "preparing" | "ready" | "playing" | "paused" | "ended" | "rendering" | "failed";

/** The DOM the player writes each frame (the film's words and its final black). */
export interface FilmElements {
  canvas: HTMLElement;
  titles: Record<TitleId, HTMLElement>;
  subtitle: HTMLElement;
  blackout: HTMLElement;
}

export interface PlayerOptions {
  mode: "live" | "render";
  subtitles: boolean;
  /** Fixed particle tier; default: this device's ceiling in live mode, the top tier when rendering. */
  tier?: number;
  /** Canvas supersampling for capture (render mode). */
  pixelRatio?: number;
}

export interface PreparedReport {
  duration: number;
  fps: number;
  frames: number;
  tier: number;
  particles: number;
  visuals: ResolvedVisual[];
  missingDialogue: LineId[];
}

/**
 * Plays the film on the real particle runtime. Live: the audio context's clock is the master clock and the
 * runtime renders from the player's animation frame. Render: frames are stepped at exact multiples of
 * 1/fps by the export script, and the soundtrack is rendered offline — identical content, no wall clock.
 */
export class FilmPlayer {
  state: PlayerState = "preparing";
  problem: PromoError | null = null;
  report: PreparedReport | null = null;
  muted = false;
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private runtime: RuntimeHandle | null = null;
  private timeline: Timeline | null = null;
  private targets: SceneTargets | null = null;
  private dialogue: DialogueAssets | null = null;
  private performance: Performance | null = null;
  private look: FilmLook | null = null;
  private clock: FilmClock | null = null;
  private audio: AudioContext | null = null;
  private soundtrack: Soundtrack | null = null;
  private frame = 0;
  private last = 0;
  private nextIndex = 0;
  private subtitle = "";

  constructor(private readonly elements: FilmElements, private readonly options: PlayerOptions) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get duration() { return this.timeline?.duration ?? 0; }

  /** Builds the body, loads the dialogue and resolves every scene visual. The film may start only after. */
  async prepare() {
    const signal = this.lifetime.signal;
    try {
      const [{ createParticleRuntime }, dialogue] = await Promise.all([
        import("../particle/ParticleRuntime"),
        loadDialogue(MIX.sampleRate, signal),
      ]);
      const timeline = compileTimeline(dialogue.durations);
      const problems = timelineProblems(timeline);
      if (problems.length) throw new PromoError("timeline-invalid", problems.join("; "));
      this.timeline = timeline; this.dialogue = dialogue;
      this.look = filmLook(timeline, 0);
      const tier = this.options.tier ?? (this.options.mode === "render" ? qualityTiers.length - 1
        : qualityRange(matchMedia("(pointer: coarse)").matches, navigator.hardwareConcurrency || 4,
          (navigator as Navigator & { deviceMemory?: number }).deviceMemory).max);
      let runtimeError: string | null = null;
      const inputs = performanceInputs(() => this.performance);
      const [runtime, resolved] = await Promise.all([
        createParticleRuntime(this.elements.canvas, inputs, signal, code => { runtimeError = code; this.fail(new PromoError(code)); }, {
          tier, pixelRatio: this.options.pixelRatio, loop: "external", interactive: false, reducedMotion: false,
          stage: { pose: () => this.look!.camera },
          formation: { plan: createBirthPlan, time: () => this.look!.formation },
        }).catch((error: unknown) => { throw new PromoError(error instanceof Error ? error.message : "webgpu-failed"); }),
        resolveSceneTargets(timeline, () => createBrowserResolver(), { signal }),
      ]);
      if (!runtime || signal.aborted) return;
      if (runtimeError) throw new PromoError(runtimeError);
      this.runtime = runtime;
      this.targets = resolved.targets;
      runtime.prepare(resolved.targets.values());
      runtime.advance(0, 0);
      this.apply();
      const quality = runtime.quality();
      this.report = {
        duration: timeline.duration, fps: timeline.fps, frames: frameCount(timeline), tier: quality.tier, particles: quality.count,
        visuals: resolved.visuals, missingDialogue: dialogue.missing,
      };
      this.set("ready");
    } catch (error) {
      if (signal.aborted) return;
      this.fail(error instanceof PromoError ? error : new PromoError("prepare-failed", error instanceof Error ? error.message : String(error)));
    }
  }

  /** Starts (or restarts) the film. Call from a user gesture so sound may play. */
  play() {
    if (!this.ready()) return;
    const timeline = this.timeline!;
    this.stopPerformance();
    this.performance = createPerformance(timeline, this.targets!, this.dialogue!.envelopes, error => this.fail(error));
    this.clock = this.startSound(timeline);
    this.last = 0;
    this.set("playing");
    this.schedule();
  }

  pause() {
    if (this.state !== "playing") return;
    cancelAnimationFrame(this.frame);
    this.clock?.pause();
    this.set("paused");
  }

  resume() {
    if (this.state !== "paused") return;
    this.clock?.resume();
    this.last = this.clock?.now() ?? this.last;
    this.set("playing");
    this.schedule();
  }

  toggle() {
    if (this.state === "playing") this.pause();
    else if (this.state === "paused") this.resume();
    else if (this.state === "ready" || this.state === "ended") this.play();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.soundtrack?.setMuted(muted);
    this.emit();
  }

  setSubtitles(on: boolean) { this.options.subtitles = on; this.apply(); }
  get subtitles() { return this.options.subtitles; }

  // ── Export (render mode) ──────────────────────────────────────────────────────────────────────────

  /**
   * Renders frame `index` (film time index / fps). Frames must be rendered in order from 0: the body is a
   * simulation. With `present`, resolves once the frame is on screen for capture.
   */
  async renderFrame(index: number, present = true) {
    if (this.options.mode !== "render") throw new Error("not-render-mode");
    if (this.state === "ready") {
      this.performance = createPerformance(this.timeline!, this.targets!, this.dialogue!.envelopes, error => this.fail(error));
      this.set("rendering");
    }
    if (this.state !== "rendering") throw this.problem ?? new Error(`cannot render while ${this.state}`);
    if (index !== this.nextIndex) throw new Error(`frames must be rendered in order (expected ${this.nextIndex}, got ${index})`);
    const fps = this.timeline!.fps;
    const t = index / fps;
    await this.step(t, index === 0 ? 0 : 1 / fps);
    this.nextIndex = index + 1;
    if (this.problem) throw this.problem;
    if (present) {
      await this.runtime!.settle();
      await nextFrame(); await nextFrame();
    }
  }

  /** The whole soundtrack, rendered offline, as a 48 kHz 24-bit stereo WAV (base64). */
  async renderAudio(): Promise<string> {
    if (!this.timeline || !this.dialogue) throw new Error("not-prepared");
    const buffer = await renderSoundtrack(this.timeline, this.dialogue.buffers);
    const bytes = encodeWav({ sampleRate: buffer.sampleRate, channels: [buffer.getChannelData(0), buffer.getChannelData(1)] }, 24);
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  }

  /** Key moments for review stills: the birth, every expression fully formed, the titles. */
  moments(): { label: string; t: number }[] {
    const tl = this.timeline;
    if (!tl) return [];
    const at = (label: string, t: number) => ({ label, t: Math.max(0, Math.min(tl.duration - 1 / tl.fps, t)) });
    const moments = [at("birth-sparse", 1.6), at("birth-rising", 3.2), at("birth-skeleton", 4.4), at("birth-filling", 5.6), at("birth-nearly", 6.6), at("birth-formed", tl.birth.end + 0.3)];
    const question = tl.titles.find(t => t.id === "question");
    if (question) moments.push(at("question", question.start + question.fadeIn + 0.3));
    for (const v of tl.visuals) {
      moments.push(at(`${v.id}-forming`, v.start + v.form * 0.5));
      moments.push(at(`${v.id}-formed`, v.formed + 0.6));
      moments.push(at(`${v.id}-returning`, v.release + v.return * 0.5));
    }
    const caption = tl.titles.find(t => t.id === "caption");
    if (caption) moments.push(at("caption", caption.start + caption.fadeIn + 0.2));
    const maker = tl.titles.find(t => t.id === "maker");
    if (maker) moments.push(at("outro-titles", maker.start + maker.fadeIn + 0.5));
    moments.push(at("fading", tl.blackout.start + tl.blackout.duration * 0.5), at("end", tl.duration));
    const subtitle = tl.lines.find(l => l.id === "terrain.user");
    if (subtitle) moments.push(at("subtitle", subtitle.start + 0.8));
    return moments.sort((a, b) => a.t - b.t);
  }

  /** What the body is doing now (render reports and diagnostics). */
  inspect() {
    const performance = this.performance;
    return {
      t: this.look?.t ?? 0, state: this.state,
      phase: performance?.visual.phase ?? "sphere", level: performance?.visual.level ?? 0,
      target: performance?.visual.target?.label ?? null, mode: performance?.engine.signal.mode ?? "idle",
      cues: performance?.director.record ?? [],
    };
  }

  /** Development: the sound plan as data. */
  plan() { return this.timeline ? soundPlan(this.timeline) : []; }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.stopPerformance();
    this.lifetime.abort();
    if (this.audio) void this.audio.close().catch(() => {});
    this.listeners.clear();
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────

  private ready() {
    return Boolean(this.timeline && this.targets && this.dialogue && this.runtime) && this.state !== "failed" && this.state !== "preparing";
  }

  private startSound(timeline: Timeline): FilmClock {
    try {
      this.audio ??= new AudioContext({ latencyHint: "playback", sampleRate: MIX.sampleRate });
      void this.audio.resume().catch(() => {});
      const start = this.audio.currentTime + 0.25;
      this.soundtrack = scheduleSoundtrack(this.audio, soundPlan(timeline), this.dialogue!.buffers, start, timeline.duration);
      this.soundtrack.setMuted(this.muted);
      return new AudioFilmClock(this.audio, start);
    } catch {
      // No audio device or context: the film still plays, silently, on the performance clock.
      return new PerformanceFilmClock();
    }
  }

  private stopPerformance() {
    this.soundtrack?.stop(); this.soundtrack = null;
    this.performance?.dispose(); this.performance = null;
    this.clock = null;
  }

  private schedule() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => void this.tick());
  }

  private async tick() {
    if (this.state !== "playing" || !this.clock) return;
    const duration = this.timeline!.duration;
    const t = Math.min(this.clock.now(), duration);
    const dt = Math.max(0, t - this.last);
    this.last = t;
    await this.step(t, dt);
    if (this.state !== "playing") return;
    if (t >= duration) { this.set("ended"); return; }
    this.schedule();
  }

  private async step(t: number, dt: number) {
    const performance = this.performance!;
    await performance.director.update(t);
    this.look = filmLook(this.timeline!, t);
    this.runtime!.advance(dt, t);
    this.apply();
  }

  /** Writes the words and the black for the current look. */
  private apply() {
    const look = this.look;
    if (!look) return;
    const { titles, subtitle, blackout } = this.elements;
    for (const [id, element] of Object.entries(titles) as [TitleId, HTMLElement][]) {
      const title = look.titles[id] ?? { opacity: 0, reveal: 0 };
      element.style.setProperty("--o", title.opacity.toFixed(4));
      element.style.setProperty("--r", title.reveal.toFixed(4));
      element.style.visibility = title.opacity > 0.001 ? "visible" : "hidden";
    }
    const line = this.options.subtitles ? look.subtitle : null;
    const text = line?.text ?? "";
    if (text && text !== this.subtitle) { subtitle.textContent = text; subtitle.dataset.speaker = line!.speaker; this.subtitle = text; }
    subtitle.style.setProperty("--o", (line?.opacity ?? 0).toFixed(4));
    subtitle.style.visibility = line && line.opacity > 0.001 ? "visible" : "hidden";
    blackout.style.setProperty("--o", look.blackout.toFixed(4));
  }

  private fail(error: PromoError) {
    if (this.state === "failed") return;
    if (process.env.NODE_ENV === "development") console.error("[SCF promo]", error.code, error.detail);
    cancelAnimationFrame(this.frame);
    this.problem = error;
    this.clock?.pause();
    this.set("failed");
  }

  private set(state: PlayerState) { this.state = state; this.emit(); }
  private emit() { for (const listener of this.listeners) listener(); }
}

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
