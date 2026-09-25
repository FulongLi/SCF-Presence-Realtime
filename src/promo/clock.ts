/**
 * The film's master clock: monotonic seconds since the film started. During playback it is the audio
 * clock (what the listener is hearing now, including output latency), so picture and sound can never
 * drift apart; without audio it falls back to the performance clock. Export does not use a clock at all:
 * it steps frames at exact multiples of 1/fps.
 */
export interface FilmClock {
  now(): number;
  pause(): void;
  resume(): void;
}

export class AudioFilmClock implements FilmClock {
  private last = 0;
  private paused = false;
  constructor(private readonly context: AudioContext, private readonly start: number) {}

  now() {
    if (this.paused) return this.last;
    const { context } = this;
    let heard: number;
    const stamp = typeof context.getOutputTimestamp === "function" ? context.getOutputTimestamp() : null;
    if (stamp && typeof stamp.contextTime === "number" && stamp.performanceTime) {
      heard = stamp.contextTime + Math.max(0, performance.now() - stamp.performanceTime) / 1000;
    } else {
      heard = context.currentTime - (context.outputLatency || context.baseLatency || 0);
    }
    // Never backwards, and never ahead of what the context has actually rendered.
    this.last = Math.max(this.last, Math.min(heard, context.currentTime) - this.start);
    return this.last;
  }

  pause() { this.now(); this.paused = true; void this.context.suspend().catch(() => {}); }
  resume() { void this.context.resume().catch(() => {}); this.paused = false; }
}

export class PerformanceFilmClock implements FilmClock {
  private origin = performance.now();
  private frozen: number | null = null;
  now() { return this.frozen ?? (performance.now() - this.origin) / 1000; }
  pause() { this.frozen = this.now(); }
  resume() { if (this.frozen !== null) { this.origin = performance.now() - this.frozen * 1000; this.frozen = null; } }
}
