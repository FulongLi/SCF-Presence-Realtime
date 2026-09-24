const clamp01 = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

export const emphasisDefaults = {
  /** Speech must have been running this long; the onset of speech is not emphasis. */
  settle: 0.25,
  /** Peak loudness relative to the running voiced baseline. */
  ratio: 1.5,
  /** Minimum absolute lift above the baseline, in VAD level units. */
  lift: 0.1,
  /** Rise within the recent window that marks a stressed syllable. */
  rise: 0.09,
  /** How long a candidate waits for a following pause before it is judged. */
  judge: 0.3,
  /** A strong peak fires even without a following pause. */
  strongRatio: 1.85,
  /** Minimum spacing between emitted events. */
  refractory: 0.4,
  /** Utterances at least this long produce a soft event when the phrase ends. */
  phrase: 1.2,
};
export type EmphasisConfig = typeof emphasisDefaults;

/**
 * Acoustic emphasis: stressed syllables, energy peaks followed by a short pause, and phrase endings.
 * Returns an event strength (0 when nothing happened). It carries no semantic meaning.
 */
export class EmphasisDetector {
  private baseline = 0;
  private previous = 0;
  private recentLow = 0;
  private voicedTime = 0;
  private cooldown = 0;
  private wasVoiced = false;
  private candidate: { age: number; peak: number; ratio: number; paused: boolean } | null = null;
  constructor(private readonly config: EmphasisConfig = emphasisDefaults) {}

  sample(level: number, voiced: boolean, utterance: number, elapsed: number) {
    const dt = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.1, elapsed)) : 0;
    const value = clamp01(level);
    if (!dt) return 0;
    const c = this.config;
    this.cooldown -= dt;
    let event = 0;
    if (voiced) {
      this.voicedTime += dt;
      // Low-water mark of the last ~150 ms: a rise from it marks a stressed syllable.
      this.recentLow = Math.min(value, this.recentLow + (value - this.recentLow) * (1 - Math.exp(-dt * 6.5)));
      if (this.voicedTime < c.settle) this.baseline += (value - this.baseline) * (1 - Math.exp(-dt * 8));
      const ratio = value / Math.max(0.05, this.baseline);
      if (this.voicedTime >= c.settle && !this.candidate && this.cooldown <= 0 && ratio >= c.ratio
        && value - this.baseline >= c.lift && value - this.recentLow >= c.rise && value >= this.previous) {
        this.candidate = { age: 0, peak: value, ratio, paused: false };
      }
      // The baseline follows the speaker's normal level, slowly enough that peaks stand out.
      this.baseline += (value - this.baseline) * (1 - Math.exp(-dt * 1.1));
    } else {
      this.recentLow = value;
    }
    const candidate = this.candidate;
    if (candidate) {
      candidate.age += dt;
      candidate.peak = Math.max(candidate.peak, value);
      if (value < candidate.peak * 0.45 || !voiced) candidate.paused = true;
      if (candidate.paused || candidate.age >= c.judge) {
        this.candidate = null;
        if (candidate.paused || candidate.ratio >= c.strongRatio) {
          event = clamp01(0.35 + (candidate.ratio - c.ratio) * 0.55 + (candidate.paused ? 0.2 : 0));
        }
      }
    }
    // Phrase ending: a sustained utterance that has just been released.
    if (!event && this.wasVoiced && !voiced && utterance >= c.phrase && this.cooldown <= 0) event = 0.4;
    if (!voiced) { this.voicedTime = 0; if (!this.candidate) this.baseline *= Math.exp(-dt * 0.3); }
    this.wasVoiced = voiced;
    this.previous = value;
    if (event) this.cooldown = c.refractory;
    return event;
  }

  reset() {
    this.baseline = this.previous = this.recentLow = this.voicedTime = this.cooldown = 0;
    this.wasVoiced = false; this.candidate = null;
  }
}
