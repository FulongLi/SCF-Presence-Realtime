import { BIRTH } from "./birth";
import { seededRandom } from "./random";
import type { LineId, Speaker, VisualId } from "./script";
import type { Timeline } from "./timeline";

/**
 * The film's sound: original and procedural (no licensed music or samples), deterministic with the
 * timeline. `soundPlan()` turns the timeline into a list of sound events (pure, testable), and
 * `scheduleSoundtrack()` schedules that plan on any BaseAudioContext: a live AudioContext for playback (its
 * clock is the film's master clock) or an OfflineAudioContext for export, so both hear the same mix.
 *
 *   bed ─────── drone (open fifths on A) · air (filtered noise) · rumble ─┐
 *   fx ──────── grains · morph sweeps · tonal cues · pulses ─────────────┼─ duck ─┐
 *   reverb ◄─── sends (procedural impulse response) ─────────────────────┘        ├─ master ─ limiter ─ out
 *   dialogue ── recorded lines (high-passed) ─────────────────────────────────────┘
 *
 * Tonal language: every cue belongs to one A-major world. Early cues hover on open and suspended notes;
 * the Spirit Connect reveal is the first full resolution (A with its third), and the outro rests there.
 */
export const MIX = {
  sampleRate: 48_000,
  seed: 0x5cf50d,
  master: 1.2,
  dialogue: { user: 0.9, assistant: 1, highpass: 85, space: 0.06 },
  bed: { drone: 0.15, air: 0.024, rumble: 0.032 },
  fx: 0.6,
  reverb: { seconds: 3.6, decay: 2.6, level: 0.42 },
  /** Levels the bed and effects dip to while someone speaks. */
  duck: { bed: 0.5, fx: 0.7, attack: 0.06, release: 0.32 },
  /** A peak limiter for safety only: it should never be heard working. */
  limiter: { threshold: -2, ratio: 12, knee: 1, attack: 0.002, release: 0.15 },
};

type Layer = "drone" | "air" | "rumble";
export type Timbre = "bell" | "pad" | "pure";
export type SoundEvent =
  | { kind: "level"; layer: Layer; at: number; from: number; to: number; ramp: number }
  | { kind: "grain"; at: number; frequency: number; gain: number; pan: number; decay: number; noise: boolean }
  | { kind: "tone"; at: number; notes: readonly number[]; timbre: Timbre; gain: number; attack: number; decay: number; spread: number; send: number; stagger: number }
  | { kind: "pulse"; at: number; gain: number }
  | { kind: "sweep"; at: number; duration: number; from: number; to: number; gain: number; pan: number }
  | { kind: "voice"; at: number; line: LineId; speaker: Speaker }
  | { kind: "duck"; at: number; end: number }
  | { kind: "listen"; at: number; end: number };

const at = (event: SoundEvent) => event.at;
/** Note frequencies (Hz) of the film's one tonal world. */
const N = { A1: 55, E2: 82.41, A2: 110, Cs3: 138.59, E3: 164.81, A3: 220, B3: 246.94, Cs4: 277.18, E4: 329.63, Fs4: 369.99, A4: 440, B4: 493.88, Cs5: 554.37, E5: 659.25, A5: 880 };

/** Cues for each expression: related, restrained, never cartoonish. */
const CUES: Record<VisualId, { tones: Omit<Extract<SoundEvent, { kind: "tone" }>, "kind" | "at">[]; sweep: [number, number]; width: number }> = {
  // Seeing: a clear, open interval.
  tesla: { tones: [{ notes: [N.E4, N.B4], timbre: "bell", gain: 0.085, attack: 0.18, decay: 3.2, spread: 0.3, send: 0.5, stagger: 0.05 }], sweep: [650, 3600], width: 0.35 },
  // Scale: low, wide, slow, more space.
  terrain: {
    tones: [{ notes: [N.A2, N.E3, N.B3, N.Fs4], timbre: "pad", gain: 0.08, attack: 1.1, decay: 5, spread: 0.85, send: 0.8, stagger: 0.12 }],
    sweep: [420, 2600], width: 0.75,
  },
  // Warmth: a light rising arpeggio, soft attack (no UI blips).
  emoji: { tones: [{ notes: [N.Cs5, N.E5, N.A5], timbre: "bell", gain: 0.06, attack: 0.03, decay: 1.9, spread: 0.45, send: 0.45, stagger: 0.07 }], sweep: [900, 4200], width: 0.4 },
  // Everyday: one clean tone.
  clock: { tones: [{ notes: [N.A5], timbre: "pure", gain: 0.045, attack: 0.012, decay: 1.4, spread: 0, send: 0.35, stagger: 0 }], sweep: [800, 3800], width: 0.2 },
  // Identity: a suspended chord that the formed mark resolves (see soundPlan).
  logo: { tones: [{ notes: [N.A2, N.E3, N.B3, N.E4], timbre: "pad", gain: 0.07, attack: 1.3, decay: 3.4, spread: 0.6, send: 0.7, stagger: 0.1 }], sweep: [520, 3000], width: 0.5 },
};

/** The deterministic sound plan for a timeline. Times are film seconds; the list is sorted by time. */
export function soundPlan(timeline: Timeline, seed = MIX.seed): SoundEvent[] {
  const random = seededRandom(seed);
  const events: SoundEvent[] = [];
  const end = timeline.duration;
  const birthEnd = timeline.birth.end;
  const last = { drone: 0, air: 0, rumble: 0 };
  const level = (layer: Layer, time: number, to: number, ramp: number) => { events.push({ kind: "level", layer, at: time, from: last[layer], to, ramp }); last[layer] = to; };

  // Bed: near silence, then the atmosphere gathers with the particles, then it lives quietly under the film.
  level("air", 0.35, 0.3, 2.6);
  level("rumble", 0.5, 0.4, 3);
  level("drone", 1.2, 0.25, 3);
  level("air", 3.2, 1, 3.2);
  level("drone", 4.3, 0.75, 2.8);
  level("rumble", 4.3, 1, 2.8);
  level("drone", birthEnd, 1, 1.2);
  level("air", birthEnd + 0.5, 0.62, 3);
  const logo = timeline.visuals.find(v => v.id === "logo");
  if (logo) { level("air", logo.release, 0.85, 2.5); level("air", logo.sphere + 1, 0.55, 3); }
  const fadeStart = timeline.blackout.start - 0.4;
  for (const layer of ["drone", "air", "rumble"] as const) level(layer, fadeStart, 0, end - fadeStart - 0.05);

  // Grains: particulate glints and dust while the body is born (denser as particles accumulate), and a
  // flurry whenever the body transforms.
  const birthRate = (t: number) => {
    if (t < BIRTH.firstLaunch) return 0;
    const rise = Math.min(1, (t - BIRTH.firstLaunch) / (5.2 - BIRTH.firstLaunch));
    const fall = t > birthEnd - 1.2 ? Math.max(0, 1 - (t - (birthEnd - 1.2)) / 2.4) : 1;
    return (1.2 + 26 * rise * rise) * fall;
  };
  const grains = (from: number, to: number, rate: (t: number) => number, peak: number, loudness: number) => {
    for (let t = from; t < to;) {
      t += -Math.log(Math.max(1e-6, random())) / peak;
      if (t >= to) break;
      const accept = random() < rate(t) / peak;
      const noise = random() < 0.45;
      const frequency = noise ? 1800 * Math.pow(3.2, random()) : 2600 * Math.pow(2.8, random());
      const gain = loudness * (0.35 + 0.65 * random()) * (noise ? 1.6 : 1);
      const pan = (random() * 2 - 1) * 0.7, decay = 0.018 + random() * 0.07;
      if (accept) events.push({ kind: "grain", at: t, frequency, gain, pan, decay, noise });
    }
  };
  grains(0, birthEnd + 1.2, birthRate, 28, 0.05);
  for (const v of timeline.visuals) {
    const cue = CUES[v.id];
    grains(v.start, v.formed, () => 11, 11, 0.032);
    grains(v.release, v.sphere, () => 9, 9, 0.028);
    events.push({ kind: "sweep", at: v.start, duration: v.form, from: cue.sweep[0], to: cue.sweep[1], gain: 0.045, pan: 0 });
    events.push({ kind: "sweep", at: v.release, duration: v.return, from: cue.sweep[1] * 0.85, to: cue.sweep[0] * 0.9, gain: 0.032, pan: 0 });
    for (const tone of cue.tones) events.push({ kind: "tone", at: v.start + 0.12, ...tone });
  }
  if (logo) {
    // The reveal resolves: the suspended chord settles on A major as the mark completes, and the body
    // returns to itself on the same chord.
    events.push({ kind: "tone", at: logo.formed - 0.35, notes: [N.A2, N.E3, N.A3, N.Cs4, N.E4], timbre: "pad", gain: 0.085, attack: 0.9, decay: 5.2, spread: 0.6, send: 0.75, stagger: 0.08 });
    events.push({ kind: "tone", at: logo.sphere - 0.2, notes: [N.A1, N.E2, N.A2, N.Cs3, N.E3], timbre: "pad", gain: 0.075, attack: 1.8, decay: 6.5, spread: 0.7, send: 0.8, stagger: 0.14 });
  }
  // The completed body: a soft low pulse and an open chord, no boom.
  for (const pulse of timeline.pulses) events.push({ kind: "pulse", at: pulse.at, gain: 0.16 + pulse.strength * 0.24 });
  events.push({ kind: "tone", at: birthEnd - 0.3, notes: [N.A1, N.E2, N.A2, N.E3], timbre: "pad", gain: 0.06, attack: 1.5, decay: 5, spread: 0.6, send: 0.75, stagger: 0.1 });
  const title = timeline.titles.find(t => t.id === "title");
  if (title) events.push({ kind: "tone", at: title.start + 0.1, notes: [N.A4, N.E5], timbre: "bell", gain: 0.03, attack: 0.5, decay: 3.6, spread: 0.4, send: 0.7, stagger: 0.18 });

  // Dialogue: the recorded lines, with the bed ducked under them; listening opens the air a little.
  for (const line of timeline.lines) {
    events.push({ kind: "voice", at: line.start, line: line.id, speaker: line.speaker });
    events.push({ kind: "duck", at: Math.max(0, line.start - 0.12), end: Math.min(end, line.end + 0.1) });
    if (line.speaker === "user") events.push({ kind: "listen", at: line.start, end: line.end });
  }
  return events.filter(e => e.at >= 0 && e.at < end).sort((a, b) => at(a) - at(b));
}

/** Stereo white noise from a seed (procedural, identical on every render). */
function noiseBuffer(context: BaseAudioContext, seconds: number, seed: number) {
  const random = seededRandom(seed);
  const buffer = context.createBuffer(2, Math.round(seconds * context.sampleRate), context.sampleRate);
  for (let c = 0; c < 2; c++) { const data = buffer.getChannelData(c); for (let i = 0; i < data.length; i++) data[i] = random() * 2 - 1; }
  return buffer;
}

/** A soft, dark room: decaying stereo noise that loses its highs as it fades. */
function impulseResponse(context: BaseAudioContext, seconds: number, decay: number, seed: number) {
  const random = seededRandom(seed);
  const buffer = context.createBuffer(2, Math.round(seconds * context.sampleRate), context.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    let low = 0;
    for (let i = 0; i < data.length; i++) {
      const t = i / context.sampleRate;
      const damping = Math.min(0.94, 0.25 + t * 0.35);
      low = low * damping + (random() * 2 - 1) * (1 - damping);
      data[i] = low * Math.exp(-t * decay) * Math.min(1, t / 0.012);
    }
  }
  return buffer;
}

const PARTIALS: Record<Timbre, { ratio: number; gain: number; decay: number }[]> = {
  bell: [{ ratio: 1, gain: 1, decay: 1 }, { ratio: 2, gain: 0.26, decay: 0.55 }, { ratio: 3.01, gain: 0.08, decay: 0.3 }],
  pad: [{ ratio: 1, gain: 1, decay: 1 }, { ratio: 1.0023, gain: 0.7, decay: 1 }, { ratio: 2, gain: 0.18, decay: 0.8 }],
  pure: [{ ratio: 1, gain: 1, decay: 1 }, { ratio: 2, gain: 0.08, decay: 0.4 }],
};

export interface Soundtrack {
  /** The film output before the mute stage (for offline rendering it is the destination chain). */
  readonly output: GainNode;
  setMuted(muted: boolean): void;
  stop(): void;
}

/**
 * Schedules `plan` on `context` so that film time 0 is context time `start`. Everything is scheduled up
 * front; the context's own clock then plays it.
 */
export function scheduleSoundtrack(context: BaseAudioContext, plan: readonly SoundEvent[], voices: ReadonlyMap<LineId, AudioBuffer>,
  start: number, duration: number): Soundtrack {
  const T = (time: number) => start + time;
  const stopAt = T(duration + 0.5);
  const sources: AudioScheduledSourceNode[] = [];
  const track = <S extends AudioScheduledSourceNode>(node: S) => { sources.push(node); return node; };

  const output = context.createGain();
  output.gain.value = 1;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = MIX.limiter.threshold; limiter.ratio.value = MIX.limiter.ratio; limiter.knee.value = MIX.limiter.knee;
  limiter.attack.value = MIX.limiter.attack; limiter.release.value = MIX.limiter.release;
  const master = context.createGain();
  master.gain.value = MIX.master;
  master.connect(limiter).connect(output).connect(context.destination);

  const dialogue = context.createGain();
  dialogue.connect(master);
  const duckBed = context.createGain(), duckFx = context.createGain();
  duckBed.connect(master); duckFx.connect(master);
  const reverb = context.createConvolver();
  reverb.normalize = true;
  reverb.buffer = impulseResponse(context, MIX.reverb.seconds, MIX.reverb.decay, MIX.seed ^ 0x1f);
  const reverbReturn = context.createGain();
  reverbReturn.gain.value = MIX.reverb.level;
  reverb.connect(reverbReturn).connect(duckFx);
  const fx = context.createGain();
  fx.gain.value = MIX.fx;
  fx.connect(duckFx);
  const noise = noiseBuffer(context, 4, MIX.seed ^ 0x2a);

  // Bed layers.
  const layers: Record<Layer, GainNode> = { drone: context.createGain(), air: context.createGain(), rumble: context.createGain() };
  for (const layer of Object.values(layers)) { layer.gain.value = 0; layer.connect(duckBed); }
  const droneTone = context.createBiquadFilter();
  droneTone.type = "lowpass"; droneTone.frequency.value = 820; droneTone.Q.value = 0.4;
  const droneLevel = context.createGain();
  droneLevel.gain.value = MIX.bed.drone;
  droneTone.connect(droneLevel).connect(layers.drone);
  const droneSend = context.createGain();
  droneSend.gain.value = 0.25;
  droneLevel.connect(droneSend).connect(reverb);
  [[N.A1, 0.36, -0.35, 0.061], [N.E2, 0.36, 0.35, 0.047], [N.A2, 0.26, -0.1, 0.083], [N.E3, 0.09, 0.2, 0.071]].forEach(([frequency, gain, pan, rate], i) => {
    const oscillator = track(context.createOscillator());
    oscillator.type = i === 0 ? "sine" : "triangle";
    oscillator.frequency.value = frequency;
    const lfo = track(context.createOscillator()), depth = context.createGain();
    lfo.frequency.value = rate; depth.gain.value = 5;
    lfo.connect(depth).connect(oscillator.detune);
    const level = context.createGain(), panner = context.createStereoPanner();
    level.gain.value = gain; panner.pan.value = pan;
    oscillator.connect(level).connect(panner).connect(droneTone);
    oscillator.start(T(0)); lfo.start(T(0)); oscillator.stop(stopAt); lfo.stop(stopAt);
  });
  const air = track(context.createBufferSource());
  air.buffer = noise; air.loop = true;
  const airFilter = context.createBiquadFilter();
  airFilter.type = "bandpass"; airFilter.frequency.value = 3800; airFilter.Q.value = 0.55;
  const airLevel = context.createGain();
  airLevel.gain.value = MIX.bed.air;
  air.connect(airFilter).connect(airLevel).connect(layers.air);
  const airSweep = track(context.createOscillator()), airDepth = context.createGain();
  airSweep.frequency.value = 0.043; airDepth.gain.value = 900;
  airSweep.connect(airDepth).connect(airFilter.frequency);
  air.start(T(0)); airSweep.start(T(0)); air.stop(stopAt); airSweep.stop(stopAt);
  const rumble = track(context.createBufferSource());
  rumble.buffer = noise; rumble.loop = true; rumble.playbackRate.value = 0.5;
  const rumbleFilter = context.createBiquadFilter();
  rumbleFilter.type = "lowpass"; rumbleFilter.frequency.value = 140; rumbleFilter.Q.value = 0.3;
  const rumbleLevel = context.createGain();
  rumbleLevel.gain.value = MIX.bed.rumble;
  rumble.connect(rumbleFilter).connect(rumbleLevel).connect(layers.rumble);
  rumble.start(T(0), 1.3); rumble.stop(stopAt);

  const pan = (value: number) => { const node = context.createStereoPanner(); node.pan.value = Math.max(-1, Math.min(1, value)); return node; };
  for (const event of plan) {
    const time = T(event.at);
    switch (event.kind) {
      case "level": {
        const param = layers[event.layer].gain;
        param.setValueAtTime(event.from, time);
        param.linearRampToValueAtTime(event.to, time + Math.max(0.01, event.ramp));
        break;
      }
      case "duck": {
        duckBed.gain.setTargetAtTime(MIX.duck.bed, time, MIX.duck.attack);
        duckFx.gain.setTargetAtTime(MIX.duck.fx, time, MIX.duck.attack);
        duckBed.gain.setTargetAtTime(1, T(event.end), MIX.duck.release);
        duckFx.gain.setTargetAtTime(1, T(event.end), MIX.duck.release);
        break;
      }
      case "listen": {
        airFilter.Q.setTargetAtTime(0.9, time, 0.25);
        airFilter.Q.setTargetAtTime(0.55, T(event.end), 0.6);
        break;
      }
      case "grain": {
        const envelope = context.createGain();
        envelope.gain.setValueAtTime(0, time);
        envelope.gain.linearRampToValueAtTime(event.gain, time + 0.004);
        envelope.gain.exponentialRampToValueAtTime(0.0001, time + event.decay);
        let source: AudioScheduledSourceNode;
        if (event.noise) {
          const dust = context.createBufferSource();
          dust.buffer = noise;
          const band = context.createBiquadFilter();
          band.type = "bandpass"; band.frequency.value = event.frequency; band.Q.value = 7;
          dust.connect(band).connect(envelope);
          dust.start(time, (event.frequency * 7.31) % 3.5, event.decay + 0.02);
          source = dust;
        } else {
          const glint = context.createOscillator();
          glint.frequency.value = event.frequency;
          glint.connect(envelope);
          glint.start(time); glint.stop(time + event.decay + 0.02);
          source = glint;
        }
        track(source);
        const panner = pan(event.pan), send = context.createGain();
        send.gain.value = 0.5;
        envelope.connect(panner).connect(fx);
        panner.connect(send).connect(reverb);
        break;
      }
      case "sweep": {
        const source = track(context.createBufferSource());
        source.buffer = noise; source.loop = true;
        const band = context.createBiquadFilter();
        band.type = "bandpass"; band.Q.value = 1.3;
        band.frequency.setValueAtTime(event.from, time);
        band.frequency.exponentialRampToValueAtTime(event.to, time + event.duration);
        const envelope = context.createGain();
        envelope.gain.setValueAtTime(0, time);
        envelope.gain.linearRampToValueAtTime(event.gain, time + event.duration * 0.45);
        envelope.gain.linearRampToValueAtTime(0, time + event.duration);
        const send = context.createGain();
        send.gain.value = 0.6;
        const panner = pan(event.pan);
        source.connect(band).connect(envelope).connect(panner).connect(fx);
        panner.connect(send).connect(reverb);
        source.start(time, (event.at * 1.7) % 3); source.stop(time + event.duration + 0.05);
        break;
      }
      case "tone": {
        event.notes.forEach((frequency, n) => {
          const onset = time + n * event.stagger;
          const position = event.notes.length > 1 ? (n / (event.notes.length - 1) * 2 - 1) * event.spread : 0;
          const panner = pan(position), send = context.createGain();
          send.gain.value = event.send;
          panner.connect(fx); panner.connect(send).connect(reverb);
          for (const partial of PARTIALS[event.timbre]) {
            const oscillator = track(context.createOscillator());
            oscillator.frequency.value = frequency * partial.ratio;
            const envelope = context.createGain();
            const peak = event.gain * partial.gain / Math.sqrt(event.notes.length);
            const fall = event.decay * partial.decay;
            envelope.gain.setValueAtTime(0, onset);
            envelope.gain.linearRampToValueAtTime(peak, onset + event.attack);
            envelope.gain.setTargetAtTime(0, onset + event.attack, fall / 4.5);
            oscillator.connect(envelope).connect(panner);
            oscillator.start(onset); oscillator.stop(onset + event.attack + fall * 1.3 + 0.1);
          }
        });
        break;
      }
      case "pulse": {
        const body = track(context.createOscillator());
        body.frequency.setValueAtTime(62, time);
        body.frequency.exponentialRampToValueAtTime(49, time + 0.9);
        const envelope = context.createGain();
        envelope.gain.setValueAtTime(0, time);
        envelope.gain.linearRampToValueAtTime(event.gain, time + 0.07);
        envelope.gain.setTargetAtTime(0, time + 0.07, 0.42);
        body.connect(envelope).connect(fx);
        body.start(time); body.stop(time + 3);
        const breath = track(context.createBufferSource());
        breath.buffer = noise;
        const low = context.createBiquadFilter();
        low.type = "lowpass"; low.frequency.value = 320;
        const breathLevel = context.createGain();
        breathLevel.gain.setValueAtTime(0, time);
        breathLevel.gain.linearRampToValueAtTime(event.gain * 0.35, time + 0.12);
        breathLevel.gain.setTargetAtTime(0, time + 0.12, 0.3);
        breath.connect(low).connect(breathLevel).connect(fx);
        breathLevel.connect(reverb);
        breath.start(time, 0.5, 2.5);
        break;
      }
      case "voice": {
        const buffer = voices.get(event.line);
        if (!buffer) break;
        const source = track(context.createBufferSource());
        source.buffer = buffer;
        const clean = context.createBiquadFilter();
        clean.type = "highpass"; clean.frequency.value = MIX.dialogue.highpass; clean.Q.value = 0.6;
        const level = context.createGain();
        level.gain.value = MIX.dialogue[event.speaker];
        source.connect(clean).connect(level).connect(dialogue);
        if (event.speaker === "assistant") {
          const space = context.createGain();
          space.gain.value = MIX.dialogue.space;
          level.connect(space).connect(reverb);
        }
        source.start(time);
        break;
      }
    }
  }
  return {
    output,
    setMuted(muted) {
      const now = context.currentTime;
      output.gain.cancelScheduledValues(now);
      output.gain.setTargetAtTime(muted ? 0 : 1, now, 0.05);
    },
    stop() {
      for (const source of sources) { try { source.stop(); } catch { /* not started or already stopped */ } }
      output.disconnect();
    },
  };
}

/** Renders the whole mix offline (export): 48 kHz stereo, sample-identical on every run. */
export async function renderSoundtrack(timeline: Timeline, voices: ReadonlyMap<LineId, AudioBuffer>): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(2, Math.ceil(timeline.duration * MIX.sampleRate), MIX.sampleRate);
  scheduleSoundtrack(context, soundPlan(timeline), voices, 0, timeline.duration);
  return context.startRendering();
}
