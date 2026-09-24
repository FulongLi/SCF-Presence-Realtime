// Log-spaced regions give speech fundamentals and consonants their own movement.
export const SPECTRUM_EDGES = [60, 90, 135, 200, 290, 420, 600, 850, 1200, 1700, 2400, 3400, 4800, 6800, 9500, 13000, 18000] as const;
export const SPECTRUM_BANDS = SPECTRUM_EDGES.length - 1;

export class SpectrumEnvelope {
  readonly bands = new Float32Array(SPECTRUM_BANDS);
  private readonly ranges: [number, number][];
  constructor(sampleRate: number, fftSize: number) {
    this.ranges = SPECTRUM_EDGES.slice(0, -1).map((edge, i) => [
      Math.min(fftSize / 2, Math.ceil(edge * fftSize / sampleRate)),
      Math.min(fftSize / 2, Math.ceil(SPECTRUM_EDGES[i + 1] * fftSize / sampleRate)),
    ]);
  }
  sample(decibels: Float32Array, rms: number, elapsed: number, sensitivity = 1) {
    const dt = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.1, elapsed)) : 0;
    const gain = Number.isFinite(sensitivity) ? Math.max(0, Math.min(4, sensitivity)) : 1;
    const gate = Number.isFinite(rms) ? Math.max(0, Math.min(1, (rms - 0.003) / 0.012)) : 0;
    for (let band = 0; band < this.bands.length; band++) {
      const [start, end] = this.ranges[band];
      let peak = 0, power = 0, count = 0;
      for (let bin = start; bin < Math.min(end, decibels.length); bin++) {
        const value = Number.isFinite(decibels[bin]) ? Math.pow(10, Math.min(0, decibels[bin]) / 20) : 0;
        peak = Math.max(peak, value); power += value * value; count++;
      }
      const magnitude = peak * 0.7 + Math.sqrt(power / Math.max(1, count)) * 0.3;
      const target = Math.pow(Math.max(0, Math.min(1, (magnitude - 0.0008) * 12 * gain)), 0.65) * gate;
      const rate = target > this.bands[band] ? 45 : 5 + band * 0.35;
      this.bands[band] += (target - this.bands[band]) * (1 - Math.exp(-rate * dt));
    }
    return this.bands;
  }
}
