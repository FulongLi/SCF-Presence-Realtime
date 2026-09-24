export const qualityTiers = [
  { count: 6_000, pixelRatio: 1 },
  { count: 12_000, pixelRatio: 1.25 },
  { count: 20_000, pixelRatio: 1.5 },
  { count: 35_000, pixelRatio: 1.75 },
  { count: 50_000, pixelRatio: 2 },
] as const;

/** Starting tier and the ceiling the session may climb to, from coarse device hints. */
export function qualityRange(coarse: boolean, cores: number, memory = 8) {
  if (coarse) return { initial: 0, max: 1 };
  if (cores <= 4 || memory <= 4) return { initial: 0, max: 2 };
  if (cores <= 8) return { initial: 1, max: 3 };
  return { initial: 2, max: qualityTiers.length - 1 };
}

export const qualityTiming = {
  window: 4,
  /** Mean frame time above which a window is slow. */
  slow: 0.024,
  /** Mean frame time (vsync-bound at 60 Hz) below which a window is good. */
  good: 0.0175,
  /** Frames longer than this count as dropped. */
  dropped: 0.025,
  /** Sustained good time required before stepping up; much longer than the time to step down. */
  upgradeAfter: 20,
  /** A tier that proves slow this soon after an upgrade becomes the session ceiling. */
  probation: 30,
  cooldown: 6,
};

/**
 * Frame-time driven tier control with hysteresis: sustained slowness steps down quickly,
 * sustained smoothness steps up slowly, and a tier that fails after an upgrade is not retried.
 * rAF intervals cannot show headroom beyond the display rate, so "good" means consistently
 * at the refresh rate with almost no dropped frames.
 */
export class AdaptiveQuality {
  ceiling: number;
  private elapsed = 0;
  private frames = 0;
  private drops = 0;
  private cooldown = 5;
  private goodTime = 0;
  private clock = 0;
  private upgradedAt = -Infinity;
  constructor(public tier: number, max = qualityTiers.length - 1, private readonly timing = qualityTiming) {
    this.ceiling = Math.max(tier, Math.min(max, qualityTiers.length - 1));
  }

  sample(dt: number) {
    if (!(dt > 0)) return false;
    this.clock += Math.min(dt, 0.25);
    this.cooldown -= dt;
    // Isolated stalls (tab switches, GC, shader compilation) do not describe sustained load.
    if (this.cooldown > 0 || dt > 0.15) return false;
    const t = this.timing;
    this.elapsed += dt; this.frames++;
    if (dt > t.dropped) this.drops++;
    if (this.elapsed < t.window) return false;
    const mean = this.elapsed / this.frames, dropRate = this.drops / this.frames;
    const window = this.elapsed;
    this.elapsed = this.frames = this.drops = 0;
    const previous = this.tier;
    if (mean > t.slow && this.tier > 0) {
      if (this.clock - this.upgradedAt < t.probation) this.ceiling = this.tier - 1;
      this.tier--; this.goodTime = 0;
    } else if (mean <= t.good && dropRate < 0.02) {
      this.goodTime += window;
      if (this.goodTime >= t.upgradeAfter && this.tier < this.ceiling) {
        this.tier++; this.goodTime = 0; this.upgradedAt = this.clock;
      }
    } else {
      this.goodTime = 0;
    }
    if (previous !== this.tier) this.cooldown = t.cooldown;
    return previous !== this.tier;
  }

  /** Development override; the chosen tier also becomes the ceiling. */
  force(tier: number) {
    this.tier = this.ceiling = Math.max(0, Math.min(qualityTiers.length - 1, Math.round(tier)));
    this.goodTime = 0; this.cooldown = this.timing.cooldown;
  }
}
