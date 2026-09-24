const clamp01 = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

export const focusDefaults = {
  attack: 0.09,
  hold: 0.16,
  release: 0.75,
  /** Minimum spacing between impulses; later events are ignored, not queued. */
  cooldown: 1.4,
  /** Impulses closer together than this are progressively weaker. */
  fatigueWindow: 4,
  fatigue: 0.6,
  minimum: 0.2,
};
export type FocusConfig = typeof focusDefaults;

/**
 * Attack–hold–release envelope for "the presence noticed something".
 * Time is in seconds; the caller supplies a monotonic clock.
 */
export class FocusImpulse {
  private start = -Infinity;
  private strength = 0;
  private last = -Infinity;
  private streak = 0;
  constructor(private readonly config: FocusConfig = focusDefaults) {}

  trigger(strength: number, now: number) {
    const value = clamp01(strength);
    const c = this.config;
    if (value < c.minimum || now - this.last < c.cooldown) return false;
    this.streak = now - this.last < c.fatigueWindow ? this.streak + 1 : 0;
    const scaled = value * Math.pow(c.fatigue, this.streak);
    if (scaled < c.minimum * 0.5) return false;
    // A new impulse starts from the current value, so overlapping envelopes never jump.
    const current = this.sample(now);
    this.strength = Math.max(scaled, current);
    this.start = now - c.attack * (current / Math.max(this.strength, 1e-6));
    this.last = now;
    return true;
  }

  sample(now: number) {
    const c = this.config;
    const t = now - this.start;
    if (!(t >= 0)) return 0;
    if (t < c.attack) { const x = t / c.attack; return this.strength * x * x * (3 - 2 * x); }
    if (t < c.attack + c.hold) return this.strength;
    const r = (t - c.attack - c.hold) / c.release;
    if (r >= 1) return 0;
    const x = 1 - r;
    return this.strength * x * x * (3 - 2 * x);
  }

  reset() { this.start = this.last = -Infinity; this.strength = 0; this.streak = 0; }
}
