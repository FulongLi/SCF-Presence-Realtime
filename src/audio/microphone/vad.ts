const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;

export const vadDefaults = {
  /** Absolute RMS below which nothing counts as speech, even in a silent room. */
  minThreshold: 0.008,
  /** Speech must exceed the adaptive noise floor by this ratio. */
  floorRatio: 2.8,
  /** Continuous voiced time before speech is accepted (rejects clicks and taps). */
  attack: 0.12,
  /** Silence before speech is considered finished (bridges syllables and short gaps). */
  hangover: 0.45,
  /** Release threshold relative to the onset threshold. */
  hysteresis: 0.7,
  /** The first moments after start calibrate the floor quickly. */
  calibration: 0.5,
  /** Uninterrupted "speech" this long is steady noise (a fan, traffic); recalibrate. */
  maxUtterance: 8,
};
export type VadConfig = typeof vadDefaults;

/**
 * Energy-based voice activity detection with an adaptive noise floor.
 * Deterministic, local and transcript-free: it only answers "is someone speaking, and how loudly".
 */
export class VoiceActivityDetector {
  voiced = false;
  /** Smoothed, floor-relative loudness in [0, 1]. */
  level = 0;
  /** Seconds of the current (or most recent) utterance. */
  utterance = 0;
  floor = 0.004;
  private above = 0;
  private below = 0;
  private elapsed = 0;
  private voicedEnergy = 0;
  constructor(private readonly config: VadConfig = vadDefaults) {}

  get threshold() {
    return Math.max(this.config.minThreshold, this.floor * this.config.floorRatio + 0.002);
  }

  sample(rms: number, elapsed: number) {
    const dt = Math.max(0, Math.min(0.1, finite(elapsed)));
    const energy = Math.max(0, finite(rms));
    if (!dt) return this;
    this.elapsed += dt;
    // The floor follows quiet rooms quickly and loud rooms slowly, so speech is not absorbed into it.
    const calibrating = this.elapsed < this.config.calibration;
    const floorRate = calibrating ? 5 : energy < this.floor ? 2.5 : this.voiced ? 0.01 : 0.12;
    this.floor += (energy - this.floor) * (1 - Math.exp(-floorRate * dt));
    this.floor = Math.min(Math.max(this.floor, 0.0005), 0.05);
    const onset = this.threshold;
    const release = onset * this.config.hysteresis;
    if (!this.voiced) {
      this.above = energy > onset && !calibrating ? this.above + dt : Math.max(0, this.above - dt * 2);
      if (this.above >= this.config.attack) {
        this.voiced = true; this.below = 0; this.utterance = this.above; this.voicedEnergy = energy;
      }
    } else {
      this.utterance += dt;
      this.voicedEnergy += (energy - this.voicedEnergy) * (1 - Math.exp(-dt * 0.5));
      this.below = energy < release ? this.below + dt : 0;
      if (this.below >= this.config.hangover) {
        this.voiced = false; this.above = 0;
      } else if (this.utterance > this.config.maxUtterance && this.below === 0) {
        // Speech has pauses; a sound this steady and long is the room, not the user.
        this.floor = Math.min(0.05, this.voicedEnergy * 0.9);
        this.voiced = false; this.above = 0; this.utterance = 0;
      }
    }
    const target = Math.pow(Math.min(1, Math.max(0, energy - this.floor) / 0.14), 0.7);
    this.level += (target - this.level) * (1 - Math.exp(-dt * (target > this.level ? 30 : 8)));
    return this;
  }

  reset() {
    this.voiced = false; this.level = 0; this.utterance = 0; this.above = 0; this.below = 0;
    this.elapsed = 0; this.voicedEnergy = 0;
  }
}
