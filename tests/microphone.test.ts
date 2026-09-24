import test from "node:test";
import assert from "node:assert/strict";
import { VoiceActivityDetector } from "../src/audio/microphone/vad";
import { EmphasisDetector } from "../src/audio/microphone/emphasis";
import { rms } from "../src/audio/analyser";

const dt = 1 / 60;
function feed(vad: VoiceActivityDetector, energy: number, seconds: number) {
  for (let i = 0; i < Math.round(seconds / dt); i++) vad.sample(energy, dt);
  return vad;
}

test("VAD accepts sustained speech above the room floor and rejects clicks", () => {
  const vad = feed(new VoiceActivityDetector(), 0.002, 2);
  assert.equal(vad.voiced, false);
  feed(vad, 0.08, 0.05);
  assert.equal(vad.voiced, false, "a 50 ms click is not speech");
  feed(vad, 0.002, 0.3);
  feed(vad, 0.08, 0.3);
  assert.equal(vad.voiced, true);
  assert.ok(vad.level > 0.3);
});

test("VAD bridges syllable gaps and ends after the hangover", () => {
  const vad = feed(feed(new VoiceActivityDetector(), 0.002, 1), 0.06, 0.5);
  feed(vad, 0.002, 0.25);
  assert.equal(vad.voiced, true, "a short gap between words keeps listening");
  feed(vad, 0.06, 0.4);
  feed(vad, 0.002, 0.6);
  assert.equal(vad.voiced, false);
  assert.ok(vad.utterance > 1, "utterance length spans the whole phrase");
});

test("VAD calibrates to a steady noisy room instead of listening forever", () => {
  const vad = feed(new VoiceActivityDetector(), 0.03, 30);
  assert.equal(vad.voiced, false);
  assert.ok(vad.threshold > 0.06);
  feed(vad, 0.2, 0.3);
  assert.equal(vad.voiced, true, "speech above the noise still registers");
});

test("noise that starts after calibration is released after a bounded time", () => {
  const vad = feed(new VoiceActivityDetector(), 0.002, 2);
  feed(vad, 0.05, 1);
  assert.equal(vad.voiced, true);
  feed(vad, 0.05, 10);
  assert.equal(vad.voiced, false, "a fan switched on is not a speaker");
  feed(vad, 0.05, 5);
  assert.equal(vad.voiced, false);
});

test("VAD ignores non-finite input", () => {
  const vad = new VoiceActivityDetector();
  vad.sample(NaN, dt); vad.sample(Infinity, NaN); vad.sample(-1, dt);
  assert.equal(vad.voiced, false);
  assert.ok(Number.isFinite(vad.level) && Number.isFinite(vad.floor));
});

function emphasis(pattern: (t: number) => number, seconds: number, voiced = (t: number) => pattern(t) > 0.05) {
  const detector = new EmphasisDetector();
  const events: { t: number; strength: number }[] = [];
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    const t = i * dt;
    const strength = detector.sample(pattern(t), voiced(t), t, dt);
    if (strength) events.push({ t, strength });
  }
  return events;
}

test("steady speech produces no emphasis; a stressed peak followed by a pause does", () => {
  assert.deepEqual(emphasis(() => 0.3, 3, () => true), []);
  const events = emphasis(t => t < 1.5 ? 0.3 : t < 1.7 ? 0.7 : t < 1.9 ? 0.08 : 0.3, 3, () => true);
  assert.equal(events.length, 1);
  assert.ok(events[0].t > 1.5 && events[0].t < 2);
  assert.ok(events[0].strength > 0.5 && events[0].strength <= 1);
});

test("the start of speech is not mistaken for emphasis", () => {
  const events = emphasis(t => t < 0.5 ? 0 : 0.6, 1.5);
  assert.deepEqual(events, []);
});

test("rapid peaks are rate limited by the refractory period", () => {
  const events = emphasis(t => {
    if (t < 1) return 0.25;
    const phase = (t - 1) % 0.2;
    return phase < 0.08 ? 0.8 : 0.2;
  }, 3, () => true);
  assert.ok(events.length >= 1);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].t - events[i - 1].t >= 0.4 - 1e-9);
});

test("a long phrase ending produces a soft event", () => {
  const events = emphasis(t => t < 2 ? 0.3 : 0, 3);
  assert.equal(events.length, 1);
  assert.equal(events[0].strength, 0.4);
});

test("audio energy reflects the waveform, with silence at zero", () => {
  assert.equal(rms(new Float32Array(128)), 0);
  const wave = Float32Array.from({ length: 1024 }, (_, i) => 0.5 * Math.sin(i * Math.PI * 2 / 64));
  assert.ok(Math.abs(rms(wave) - Math.sqrt(0.125)) < 1e-6);
});
