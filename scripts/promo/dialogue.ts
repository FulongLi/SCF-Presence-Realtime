import type { PcmAudio } from "../../src/promo/wav";

/**
 * Processing applied to every recorded dialogue line (npm run promo:prepare): trim the silence a speech
 * model leaves around a line, match its level to the other lines, and soften its edges.
 */

/** Bump when the processing changes, so every line is re-recorded. */
export const PROCESSING = 1;

export const levels = {
  /** Silence threshold for trimming (linear amplitude, about −46 dBFS). */
  silence: 0.005,
  /** Kept before the first and after the last audible sample. */
  preroll: 0.03, postroll: 0.09,
  /** Speech level target (RMS of the voiced part) and peak ceiling. */
  rms: 0.12, peak: 0.84,
  fade: 0.006,
};

/** Trim silence, match level, soften the edges. Mono in, mono out. */
export function processLine(audio: PcmAudio): PcmAudio {
  const samples = audio.channels[0];
  const rate = audio.sampleRate;
  let first = samples.findIndex(value => Math.abs(value) > levels.silence);
  let last = samples.length - 1;
  while (last > 0 && Math.abs(samples[last]) <= levels.silence) last--;
  if (first < 0) throw new Error("the recording is silent");
  first = Math.max(0, first - Math.round(levels.preroll * rate));
  last = Math.min(samples.length - 1, last + Math.round(levels.postroll * rate));
  const out = samples.slice(first, last + 1);
  let peak = 0;
  for (const value of out) peak = Math.max(peak, Math.abs(value));
  // The level of the voiced part only (pauses would drag the average down), relative to the line's own peak.
  const voiced = Math.max(levels.silence, peak * 0.08);
  let sum = 0, count = 0;
  for (const value of out) if (Math.abs(value) > voiced) { sum += value * value; count++; }
  const rms = Math.sqrt(sum / Math.max(1, count));
  const gain = Math.min(levels.rms / Math.max(1e-6, rms), levels.peak / Math.max(1e-6, peak));
  const fade = Math.round(levels.fade * rate);
  for (let i = 0; i < out.length; i++) {
    const edge = Math.min(1, i / fade, (out.length - 1 - i) / fade);
    out[i] *= gain * edge;
  }
  return { sampleRate: rate, channels: [out] };
}
