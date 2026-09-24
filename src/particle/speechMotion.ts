const bounded = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Audio dynamics, not emotion classification. All envelopes use seconds, not frames. */
export class SpeechMotion {
  readonly value = {
    body: 0, articulation: 0, accent: 0, follow: 0, phase: 0,
    directionX: 0.65, directionY: 0.4, directionZ: 0.65,
  };
  private fast = 0;
  private baseline = 0;
  private cooldown = 0;
  private gesture = 0;
  private x = 0.65;
  private y = 0.4;
  private z = 0.65;

  sample(amplitude: number, elapsed: number) {
    const dt = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.1, elapsed)) : 0;
    if (!dt) return this.value;
    const input = bounded(amplitude);
    const previous = this.fast;
    this.fast += (input - this.fast) * (1 - Math.exp(-dt * 28));
    const rise = Math.max(0, this.fast - previous) / dt;
    const contrast = Math.max(0, this.fast - this.baseline) / Math.max(0.08, this.baseline);
    this.baseline += (this.fast - this.baseline) * (1 - Math.exp(-dt * 1.6));
    this.cooldown -= dt;
    const v = this.value;
    v.accent *= Math.exp(-dt * 7);
    if (this.fast > 0.035 && rise > 0.55 && contrast > 0.35 && this.cooldown <= 0) {
      v.accent = bounded(0.25 + contrast * 0.32 + rise * 0.05);
      this.cooldown = 0.22;
      // A deterministic, non-repeating sequence of visible regions; no per-frame randomness.
      const angle = ++this.gesture * 2.399963;
      const x = Math.cos(angle), y = Math.sin(angle) * 0.75, z = 0.65;
      const length = Math.hypot(x, y, z);
      this.x = x / length; this.y = y / length; this.z = z / length;
    }
    v.body += (input - v.body) * (1 - Math.exp(-dt * (input > v.body ? 7 : 2.8)));
    const articulation = bounded(rise * 0.18);
    v.articulation += (articulation - v.articulation) * (1 - Math.exp(-dt * (articulation > v.articulation ? 18 : 5)));
    // The second region follows the accent with a softer, delayed response.
    v.follow += (v.accent - v.follow) * (1 - Math.exp(-dt * 5));
    const turn = 1 - Math.exp(-dt * 7);
    v.directionX += (this.x - v.directionX) * turn;
    v.directionY += (this.y - v.directionY) * turn;
    v.directionZ += (this.z - v.directionZ) * turn;
    v.phase += dt * (v.body * 1.2 + v.articulation * 0.65);
    return v;
  }
}
