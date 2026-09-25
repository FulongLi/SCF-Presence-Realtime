import { ASSISTANT_AUDIO_SENSITIVITY } from "../audio/assistant";
import { rms } from "../audio/analyser";
import { SPECTRUM_BANDS, SpectrumEnvelope } from "../audio/spectrum";

/**
 * The film's voices drive the body exactly as the live assistant track does, but deterministically: each
 * recorded line is analysed once, offline, into per-frame loudness and the same 16 spectrum bands the
 * product's AudioMeter produces (a Blackman-windowed FFT like the browser's AnalyserNode, the product's
 * SpectrumEnvelope and envelope follower). Playback and export then read the same frames.
 */
export interface VoiceEnvelope {
  fps: number;
  duration: number;
  amplitude: Float32Array;
  /** frames × SPECTRUM_BANDS */
  bands: Float32Array;
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = -2 * Math.PI / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(angle * k), wi = Math.sin(angle * k);
        const a = start + k, b = a + size / 2;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

export function analyzeVoice(samples: Float32Array, sampleRate: number, { fps = 60, sensitivity = ASSISTANT_AUDIO_SENSITIVITY } = {}): VoiceEnvelope {
  // The product's analyser uses 2048 samples at 48 kHz (~43 ms); keep that window at any sample rate.
  const size = 2 ** Math.round(Math.log2(sampleRate * 2048 / 48_000));
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / size) + 0.08 * Math.cos(4 * Math.PI * i / size);
  const spectrum = new SpectrumEnvelope(sampleRate, size);
  const duration = samples.length / sampleRate;
  // A short tail after the line lets the envelope release naturally.
  const frames = Math.ceil((duration + 0.35) * fps);
  const amplitude = new Float32Array(frames), bands = new Float32Array(frames * SPECTRUM_BANDS);
  const re = new Float64Array(size), im = new Float64Array(size), slice = new Float32Array(size);
  const decibels = new Float32Array(size / 2);
  let envelope = 0;
  const dt = 1 / fps;
  for (let f = 0; f < frames; f++) {
    const end = Math.round((f + 1) * sampleRate / fps);
    for (let i = 0; i < size; i++) {
      const at = end - size + i;
      slice[i] = at >= 0 && at < samples.length ? samples[at] : 0;
      re[i] = slice[i] * window[i]; im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < size / 2; k++) decibels[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) / size + 1e-12);
    const energy = rms(slice);
    spectrum.sample(decibels, energy, dt, sensitivity);
    bands.set(spectrum.bands, f * SPECTRUM_BANDS);
    const target = Math.min(1, Math.max(0, energy - 0.004) * 5 * sensitivity);
    envelope += (target - envelope) * (1 - Math.exp(-(target > envelope ? 35 : 10) * dt));
    amplitude[f] = envelope;
  }
  return { fps, duration, amplitude, bands };
}

const SILENT = new Float32Array(SPECTRUM_BANDS);
/** The envelope `seconds` into a line (silence outside it). */
export function envelopeAt(envelope: VoiceEnvelope, seconds: number): { amplitude: number; bands: Float32Array } {
  const frame = Math.floor(seconds * envelope.fps);
  if (!(frame >= 0 && frame < envelope.amplitude.length)) return { amplitude: 0, bands: SILENT };
  return { amplitude: envelope.amplitude[frame], bands: envelope.bands.subarray(frame * SPECTRUM_BANDS, (frame + 1) * SPECTRUM_BANDS) };
}
