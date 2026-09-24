import { SpectrumEnvelope } from "./spectrum";

export function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}
export class AudioMeter {
  readonly node: AnalyserNode;
  private readonly samples: Float32Array<ArrayBuffer>;
  private readonly frequencySamples: Float32Array<ArrayBuffer>;
  private readonly spectrum: SpectrumEnvelope;
  private envelope = 0;
  constructor(context: AudioContext) {
    this.node = context.createAnalyser();
    this.node.fftSize = 2048;
    this.node.smoothingTimeConstant = 0;
    this.samples = new Float32Array(this.node.fftSize);
    this.frequencySamples = new Float32Array(this.node.fftSize / 2);
    this.spectrum = new SpectrumEnvelope(context.sampleRate, this.node.fftSize);
  }
  get bands() { return this.spectrum.bands; }
  sample(dt: number, sensitivity = 1, readSpectrum = false) {
    this.node.getFloatTimeDomainData(this.samples);
    const energy = rms(this.samples);
    if (readSpectrum) {
      this.node.getFloatFrequencyData(this.frequencySamples);
      this.spectrum.sample(this.frequencySamples, energy, dt, sensitivity);
    }
    const target = Math.min(1, Math.max(0, energy - 0.004) * 5 * sensitivity);
    const rate = target > this.envelope ? 35 : 10;
    this.envelope += (target - this.envelope) * (1 - Math.exp(-rate * dt));
    return this.envelope;
  }
  disconnect() { this.node.disconnect(); }
}
