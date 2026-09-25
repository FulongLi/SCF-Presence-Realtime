import test from "node:test";
import assert from "node:assert/strict";
import { soundPlan, type SoundEvent } from "../src/promo/audio";
import { compileTimeline } from "../src/promo/timeline";
import { analyzeVoice, envelopeAt } from "../src/promo/voiceAnalysis";
import { decodeWav, encodeWav } from "../src/promo/wav";
import { levels, processLine } from "../scripts/promo/dialogue";

test("the sound plan is deterministic, sorted and inside the film", () => {
  const timeline = compileTimeline();
  const plan = soundPlan(timeline);
  assert.deepEqual(plan, soundPlan(timeline), "same seed, same plan");
  assert.notDeepEqual(plan, soundPlan(timeline, 7), "the seed shapes the procedural texture");
  for (let i = 1; i < plan.length; i++) assert.ok(plan[i].at >= plan[i - 1].at);
  assert.ok(plan.every(event => event.at >= 0 && event.at < timeline.duration && Object.values(event).every(v => typeof v !== "number" || Number.isFinite(v))));
});

test("every line is voiced once, and the bed ducks around it", () => {
  const timeline = compileTimeline();
  const plan = soundPlan(timeline);
  const voices = plan.filter((e): e is Extract<SoundEvent, { kind: "voice" }> => e.kind === "voice");
  assert.deepEqual(voices.map(v => v.line), timeline.lines.map(l => l.id));
  const ducks = plan.filter((e): e is Extract<SoundEvent, { kind: "duck" }> => e.kind === "duck");
  for (const line of timeline.lines) {
    assert.ok(ducks.some(d => d.at <= line.start && d.end >= line.end), `${line.id} is ducked`);
  }
  assert.equal(plan.filter(e => e.kind === "listen").length, timeline.lines.filter(l => l.speaker === "user").length);
});

test("the soundtrack follows the picture: birth grains, a cue per expression, pulses and a resolving end", () => {
  const timeline = compileTimeline();
  const plan = soundPlan(timeline);
  const grains = plan.filter(e => e.kind === "grain");
  const early = grains.filter(g => g.at < 2).length, dense = grains.filter(g => g.at > 4 && g.at < 6).length;
  assert.ok(early < dense / 3, "grains accumulate with the particles");
  assert.equal(plan.filter(e => e.kind === "sweep").length, timeline.visuals.length * 2, "every morph and return has texture");
  for (const v of timeline.visuals) assert.ok(plan.some(e => e.kind === "tone" && Math.abs(e.at - (v.start + 0.12)) < 1e-9), `${v.id} cue`);
  assert.equal(plan.filter(e => e.kind === "pulse").length, timeline.pulses.length);
  // Bed levels per layer never overlap their ramps, and everything has faded out by the end.
  for (const layer of ["drone", "air", "rumble"] as const) {
    const levels = plan.filter((e): e is Extract<SoundEvent, { kind: "level" }> => e.kind === "level" && e.layer === layer);
    for (let i = 1; i < levels.length; i++) assert.ok(levels[i].at >= levels[i - 1].at + levels[i - 1].ramp - 1e-9, `${layer} ramps overlap`);
    const last = levels.at(-1)!;
    assert.equal(last.to, 0);
    assert.ok(last.at + last.ramp <= timeline.duration);
  }
});

test("WAV encoding round-trips 16- and 24-bit PCM", () => {
  const left = new Float32Array(480).map((_, i) => Math.sin(i / 10) * 0.5), right = left.map(v => -v);
  for (const bits of [16, 24] as const) {
    const decoded = decodeWav(encodeWav({ sampleRate: 48_000, channels: [left, right] }, bits));
    assert.equal(decoded.sampleRate, 48_000);
    assert.equal(decoded.channels.length, 2);
    const tolerance = bits === 16 ? 2 / 32768 : 2 / 8388608;
    for (let i = 0; i < left.length; i++) assert.ok(Math.abs(decoded.channels[0][i] - left[i]) <= tolerance && Math.abs(decoded.channels[1][i] - right[i]) <= tolerance);
  }
  assert.throws(() => decodeWav(new Uint8Array(12)), /wav-invalid/);
});

test("voice envelopes follow the recorded line and are silent outside it", () => {
  const rate = 24_000;
  const samples = new Float32Array(rate).map((_, i) => i > rate * 0.25 && i < rate * 0.75 ? Math.sin(i * 2 * Math.PI * 220 / rate) * 0.3 : 0);
  const envelope = analyzeVoice(samples, rate, { sensitivity: 1.4 });
  assert.equal(envelope.fps, 60);
  assert.ok(envelopeAt(envelope, 0.1).amplitude < 0.01);
  assert.ok(envelopeAt(envelope, 0.5).amplitude > 0.5);
  assert.ok(Math.max(...envelopeAt(envelope, 0.5).bands) > 0.1, "the spectrum bands respond");
  assert.equal(envelopeAt(envelope, 5).amplitude, 0);
  assert.equal(envelopeAt(envelope, -1).amplitude, 0);
  assert.deepEqual(analyzeVoice(samples, rate).amplitude, analyzeVoice(samples, rate).amplitude, "deterministic");
});

test("prepared dialogue is trimmed, level-matched and never clipped", () => {
  const rate = 24_000;
  const quiet = new Float32Array(rate * 2).map((_, i) => i > rate * 0.6 && i < rate * 1.2 ? Math.sin(i / 7) * 0.02 : 0);
  const line = processLine({ sampleRate: rate, channels: [quiet] });
  const out = line.channels[0];
  const duration = out.length / rate;
  assert.ok(duration > 0.6 && duration < 0.6 + levels.preroll + levels.postroll + 0.01, `trimmed to ${duration}`);
  let sum = 0, count = 0, peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (const v of out) if (Math.abs(v) > peak * 0.08) { sum += v * v; count++; }
  assert.ok(peak <= levels.peak + 1e-6);
  assert.ok(Math.abs(Math.sqrt(sum / count) - levels.rms) < 0.03);
  assert.throws(() => processLine({ sampleRate: rate, channels: [new Float32Array(100)] }), /silent/);
});
